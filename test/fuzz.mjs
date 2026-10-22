// npm run fuzz — fuzz da partida inteira (fase 14, tarefa 2).
//
// Centenas de runs com entrada e escolhas aleatorias, sementes variadas, pelas
// mesmas portas que o teclado, o mouse e o quadro do navegador usam: o quadro
// e rodarQuadro (main.js), com dt de parede sorteado (60 fps, 30, 144, aba
// escondida 30s, relogio torto), e entre um quadro e outro o "jogador" aperta
// o que quiser na tela em que estiver — inclusive o que nao faz sentido ali
// (ESC na carta, "Continuar" na loja, clique duplo, indice fora da faixa).
//
// Procura: excecao em qualquer camada do quadro, NaN/Infinity no estado,
// pool inconsistente ou alocando depois de aberta, inimigo vivo reciclado,
// evento perdido pela fila, estado impossivel por tela, texto da UI com NaN
// ou {chave} sem valor, save/restore desbalanceado no desenho.
//
//   npm run fuzz                         300 runs, semente 1
//   npm run fuzz -- --runs=50
//   npm run fuzz -- --semente=777         outra familia de sementes
//   npm run fuzz -- --ticks=30000         teto de ticks de simulacao por run
//   npm run fuzz -- --workers=1
//   npm run fuzz -- --so=12345            so a run desta semente (reproduzir uma falha)
//
// Cada run depende so da semente dela: o mesmo comando acha a mesma falha, com
// qualquer numero de workers. Nada aqui usa Math.random: o "jogador" tem um rng
// proprio, separado do do jogo.

import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { CONTEUDO } from '../data/content.js';
import { eventosDescartados, irParaTela, novoEstado, TELAS } from '../src/state.js';
import {
  alternarPausa,
  continuarDaPausa,
  criarRelogio,
  desistirDaPausa,
  gravarRecorde,
  jogarDoMenu,
  rodarQuadro,
  sairDoResultado,
} from '../src/main.js';
import {
  anunciarAvaliacao,
  anuncioLiberado,
  avancarRun,
  colacaoLiberada,
  comecarAvaliacao,
  comecarProxima,
  comecarTcc,
  iniciarRun,
  sairDaColacao,
  tccLiberado,
} from '../src/run.js';
import { acharBanca, ESTADOS_BANCA } from '../src/boss.js';
import { apontarCarta, cartaLiberada, escolherCarta, moverSelecaoCarta } from '../src/cards.js';
import {
  apontarLoja,
  comprarItem,
  confirmarLoja,
  entradaLiberada,
  moverSelecaoLoja,
  precoReroll,
  rerolar,
  seguirDaLoja,
  trocarLinhaLoja,
  venderCoringa,
} from '../src/shop.js';
import { aplicarDano, poolInimigos, spawnInimigo } from '../src/enemies.js';
import { novaInstancia } from '../src/jokers.js';
import { criarLimitador, planejarSons } from '../src/audio.js';
import { criarEfeitos, desenhar } from '../src/render.js';
import { criarRng } from '../src/rng.js';
import {
  chipDoCoringa,
  decomposicaoDaNota,
  dicaDaLoja,
  hudCobreAlguem,
  nomeDaAvaliacao,
  resumoDoJubilado,
  rotuloDoReroll,
  textoDoRecorde,
  textoDoTcc,
  textoOndeCaiu,
  textoQuantoFaltava,
  formatarTempo,
} from '../src/ui.js';

const PASSO = CONTEUDO.loop.passo;
const SEMENTE_PADRAO = 1;
const MISTURA_SEMENTE = 0x9e3779b9; // o rng do "jogador" nunca e o do jogo
const TELAS_VALIDAS = new Set(Object.values(TELAS));
const QUADROS_ENTRE_VARREDURAS = 40; // varredura profunda de NaN a cada ~40 quadros
const PROFUNDIDADE_VARREDURA = 9;

// ================================================================== a run

class FalhaDoFuzz extends Error {}

function exigir(condicao, mensagem) {
  if (!condicao) throw new FalhaDoFuzz(mensagem);
}

// Um contexto 2D de mentira: so o que render.js chama, mais a pilha de
// save/restore (o desenho tem que devolver o contexto como achou).
function ctxFalso() {
  const ctx = {
    pilha: 0,
    restoreSemSave: 0,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    font: '',
    save() { ctx.pilha += 1; },
    restore() {
      if (ctx.pilha === 0) ctx.restoreSemSave += 1;
      else ctx.pilha -= 1;
    },
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  // `clip`: fase 15 (o lado de fora da Sala Lotada). `setLineDash`: fase 17
  // (a orbita da caneta e os avisos da Banca).
  for (const nome of ['setTransform', 'translate', 'rotate', 'beginPath', 'moveTo', 'lineTo', 'arc', 'rect', 'clip', 'setLineDash', 'fill', 'stroke',
    'strokeRect', 'strokeText', 'fillRect', 'fillText', 'drawImage']) {
    ctx[nome] = () => {};
  }
  return ctx;
}

// O localStorage de mentira do recorde: as vezes cheio (setItem lanca), como
// o navegador com a cota estourada.
function armazenamento(rng) {
  const dados = new Map();
  const cheio = rng.chance(0.3);
  return {
    getItem: (k) => (dados.has(k) ? dados.get(k) : null),
    setItem: (k, v) => {
      if (cheio) throw new Error('QuotaExceededError');
      dados.set(k, String(v));
    },
  };
}

function procurarNumeroInvalido(valor, caminho, vistos, profundidade) {
  if (profundidade > PROFUNDIDADE_VARREDURA) return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? null : `${caminho} = ${valor}`;
  if (typeof valor !== 'object' || valor === null || vistos.has(valor)) return null;
  vistos.add(valor);
  if (Array.isArray(valor)) {
    for (let i = 0; i < valor.length; i += 1) {
      const achado = procurarNumeroInvalido(valor[i], `${caminho}[${i}]`, vistos, profundidade + 1);
      if (achado) return achado;
    }
    return null;
  }
  for (const [chave, item] of Object.entries(valor)) {
    const achado = procurarNumeroInvalido(item, `${caminho}.${chave}`, vistos, profundidade + 1);
    if (achado) return achado;
  }
  return null;
}

// Os textos que a UI monta a partir do estado, por tela (ui.js, funcoes
// puras): nenhum pode sair com NaN, undefined, Infinity ou {chave} sem valor.
function textosDaTela(estado) {
  const r = estado.run.resultado;
  const av = estado.run.avaliacao;
  const textos = [nomeDaAvaliacao(av), formatarTempo(av.banca ? av.decorrido : av.restante)];
  switch (estado.tela) {
    case TELAS.RESULTADO:
      textos.push(decomposicaoDaNota(r), nomeDaAvaliacao(r));
      break;
    case TELAS.JUBILADO:
      textos.push(resumoDoJubilado(r), textoOndeCaiu(r), textoQuantoFaltava(r));
      break;
    case TELAS.LOJA:
      textos.push(dicaDaLoja(estado.loja.quantidade), rotuloDoReroll(precoReroll(estado.loja)));
      break;
    case TELAS.COLACAO:
      textos.push(textoDoTcc(estado.run.colacao), textoDoRecorde(estado.recorde, estado.run.colacao.novoRecorde));
      break;
    default:
      break;
  }
  const chip = { emoji: '', nome: '', descricao: '', gasto: false };
  for (const inst of estado.run.coringas) if (chipDoCoringa(inst, chip)) textos.push(chip.nome);
  hudCobreAlguem(estado);
  for (const t of textos) {
    exigir(typeof t === 'string' && !/NaN|undefined|Infinity|\{\w+\}/.test(t), `ui: o texto "${t}" na tela "${estado.tela}"`);
  }
}

// O estado impossivel, tela a tela, e o que vale em qualquer tela.
function conferirEstado(estado, ctx) {
  const tela = estado.tela;
  exigir(TELAS_VALIDAS.has(tela), `tela desconhecida "${tela}"`);
  const av = estado.run.avaliacao;
  const p = estado.player;
  for (const [nome, v] of [['tempo', estado.tempo], ['player.x', p.x], ['player.y', p.y], ['player.hp', p.hp], ['player.xp', p.xp],
    ['avaliacao.decorrido', av.decorrido], ['avaliacao.restante', av.restante], ['run.creditos', estado.run.creditos]]) {
    exigir(Number.isFinite(v), `${nome} virou ${v}`);
  }
  const { largura, altura } = CONTEUDO.arena;
  exigir(p.x >= p.raio - 0.5 && p.x <= largura - p.raio + 0.5 && p.y >= p.raio - 0.5 && p.y <= altura - p.raio + 0.5, `jogador fora da arena (${p.x}, ${p.y})`);
  exigir(Number.isInteger(estado.run.creditos) && estado.run.creditos >= 0, `creditos ${estado.run.creditos}`);
  exigir(estado.run.coringas.length <= CONTEUDO.loja.teto, `${estado.run.coringas.length} coringas na mao (teto ${CONTEUDO.loja.teto})`);
  exigir(new Set(estado.run.coringas.map((c) => c.id)).size === estado.run.coringas.length, 'coringa repetido na mao');
  switch (tela) {
    case TELAS.AVALIACAO:
      exigir(p.vivo && !av.concluida, `avaliacao rodando com o jogador ${p.vivo ? 'vivo' : 'morto'} e concluida=${av.concluida}`);
      break;
    case TELAS.PAUSA:
      exigir(!av.concluida, 'pausa por cima de uma avaliacao encerrada');
      break;
    case TELAS.CARTA:
      exigir(!av.concluida && estado.cartas.fila >= 1, `carta aberta com a avaliacao encerrada=${av.concluida} e fila ${estado.cartas.fila}`);
      exigir(estado.cartas.opcoes.some((o) => o.tipo !== ''), 'carta sem nenhuma opcao');
      break;
    case TELAS.RESULTADO:
      exigir(av.concluida && estado.run.resultado.aprovado, 'boletim de aprovado sem a avaliacao encerrada ou sem aprovacao');
      break;
    case TELAS.JUBILADO:
      exigir(av.concluida && !p.vivo && !estado.run.resultado.aprovado, 'tela de jubilado com o jogador vivo ou aprovado');
      break;
    case TELAS.COLACAO:
      exigir(estado.run.colacao.feita && av.banca && av.banca.estado === ESTADOS_BANCA.DERROTADA, 'colacao sem a Banca derrotada');
      break;
    case TELAS.LOJA: {
      const loja = estado.loja;
      exigir(loja.quantidade >= 0 && loja.quantidade <= loja.itens.length, `loja com ${loja.quantidade} itens`);
      break;
    }
    default:
      break;
  }
  // Pools: abertas cheias, nunca alocam depois (restricao 5), e nenhum
  // inimigo vivo e reciclado (o teto de spawn fica abaixo da capacidade).
  const pools = estado.scratch && estado.scratch.pools;
  if (pools) {
    for (const [chave, pool] of Object.entries(pools)) {
      const erro = pool.verificar();
      exigir(!erro, `pool ${chave} inconsistente: ${erro}`);
      exigir(pool.criados === pool.capacidade, `pool ${chave} fabricou ${pool.criados} objetos para ${pool.capacidade} de capacidade`);
    }
    if (pools.enemies) exigir(pools.enemies.reciclados === 0, `${pools.enemies.reciclados} inimigo(s) vivo(s) reciclado(s) pela pool cheia`);
    if (pools.perguntas) exigir(pools.perguntas.reciclados === 0, `${pools.perguntas.reciclados} pergunta(s) da Banca reciclada(s)`);
  }
  exigir(eventosDescartados(estado) === 0, `a fila de eventos estourou: ${eventosDescartados(estado)} descartados`);
  if (ctx) exigir(ctx.pilha === 0 && ctx.restoreSemSave === 0, `desenho desbalanceado: ${ctx.pilha} save sem restore, ${ctx.restoreSemSave} restore sem save`);
}

// ------------------------------------------------------------ o "jogador"

const TECLAS_DE_EIXO = [-1, 0, 1];

// Uma direcao nova: de teclado (-1/0/1 em cada eixo) ou de bot (unitaria).
function novaDirecao(rng, estado) {
  if (rng.chance(0.15)) {
    estado.input.eixoX = 0;
    estado.input.eixoY = 0;
  } else if (rng.chance(0.6)) {
    estado.input.eixoX = rng.pick(TECLAS_DE_EIXO);
    estado.input.eixoY = rng.pick(TECLAS_DE_EIXO);
  } else {
    const a = rng.range(0, Math.PI * 2);
    estado.input.eixoX = Math.cos(a);
    estado.input.eixoY = Math.sin(a);
  }
}

// O dt de parede de um quadro: monitor de 60, 30 ou 144 Hz com tremida, a aba
// que volta depois de 30s, e de vez em quando um relogio torto (0, negativo,
// NaN) — avancarRelogio tem que aguentar tudo.
function dtDeParede(rng) {
  const x = rng.float();
  if (x < 0.6) return PASSO * rng.range(0.7, 1.4);
  if (x < 0.75) return PASSO * 2 * rng.range(0.9, 1.1);
  if (x < 0.88) return (1 / 144) * rng.range(0.8, 1.2);
  if (x < 0.95) return PASSO * rng.range(3, 8);
  if (x < 0.98) return rng.range(1, 30);
  return rng.pick([0, -PASSO, NaN, Infinity]);
}

// O que o jogador faz entre dois quadros, na tela em que estiver. Inclui o
// que nao faz sentido ali (as portas tem que recusar): a carta e a loja so
// sao destravadas pelo atraso de abertura na maior parte das vezes, mas nao
// sempre — o smoke e os bots chamam as acoes direto.
function agir(estado, rng, run) {
  const tela = estado.tela;
  // Botoes e teclas na tela errada, de vez em quando, em qualquer tela.
  if (rng.chance(0.01)) {
    const acao = rng.int(0, 8);
    if (acao === 0) continuarDaPausa(estado);
    else if (acao === 1 && tela !== TELAS.MENU) jogarDoMenu(estado);
    else if (acao === 2 && tela !== TELAS.PAUSA) desistirDaPausa(estado);
    else if (acao === 3) sairDoResultado(estado) && run.contar('resultado');
    else if (acao === 4) comprarItem(estado, rng.int(-1, 5));
    else if (acao === 5) escolherCarta(estado, rng.int(-1, 4));
    else if (acao === 6) seguirDaLoja(estado);
    else if (acao === 7 && tela !== TELAS.ANUNCIO) comecarProxima(estado);
    else if (acao === 8 && tela !== TELAS.TCC) comecarTcc(estado);
  }
  switch (tela) {
    case TELAS.AVALIACAO: {
      if (rng.chance(0.04)) novaDirecao(rng, estado);
      if (rng.chance(0.004)) alternarPausa(estado);
      if (rng.chance(0.002)) {
        // window 'blur' (main.js): solta as teclas e pausa.
        estado.input.teclas = {};
        estado.input.eixoX = 0;
        estado.input.eixoY = 0;
        irParaTela(estado, TELAS.PAUSA);
      }
      const av = estado.run.avaliacao;
      // Adiantar o cronometro: o tempo passou (menos inimigo nasceu do que
      // nasceria, o que e um estado valido). E o que leva as runs ate o TCC.
      if (run.acelerar && !av.banca && av.decorrido < av.duracao - 3 && rng.chance(0.01)) av.decorrido = av.duracao - rng.range(0, 3);
      // A defesa: golpes grandes na Banca (como armas fortes), para passar
      // pelas fases e acabar.
      if (av.banca && run.acelerar && rng.chance(0.03)) {
        const corpo = acharBanca(estado);
        if (corpo) aplicarDano(estado, corpo, corpo.hpMax * rng.range(0.01, 0.15));
      }
      // Horda extra pela porta normal de spawn (respeita o teto).
      if (run.pressao && rng.chance(0.05)) {
        const tipo = rng.pick(CONTEUDO.inimigos);
        for (let i = rng.int(1, 12); i > 0; i -= 1) spawnInimigo(estado, tipo.id);
      }
      if (run.imortal) estado.player.hp = estado.player.hpMax;
      break;
    }
    case TELAS.PAUSA:
      if (rng.chance(0.08)) (rng.chance(0.5) ? alternarPausa(estado) : continuarDaPausa(estado));
      else if (rng.chance(0.002)) desistirDaPausa(estado);
      break;
    case TELAS.CARTA: {
      const x = rng.float();
      if (x < 0.15) moverSelecaoCarta(estado, rng.pick([-1, 1]));
      else if (x < 0.25) apontarCarta(estado, rng.int(-1, 4));
      else if (x < 0.27) alternarPausa(estado);
      else if (x < 0.6 && (cartaLiberada(estado) || rng.chance(0.3))) {
        const i = rng.chance(0.85) ? rng.int(0, CONTEUDO.cartas.quantidade - 1) : rng.int(-1, 5);
        escolherCarta(estado, i);
        if (rng.chance(0.2)) escolherCarta(estado, i); // clique duplo
      }
      break;
    }
    case TELAS.RESULTADO:
    case TELAS.JUBILADO:
      if (rng.chance(0.15)) {
        const tela0 = tela;
        sairDoResultado(estado);
        if (rng.chance(0.2)) sairDoResultado(estado); // Enter duplo
        run.contar(tela0 === TELAS.RESULTADO ? 'aprovado' : 'jubilado');
      }
      break;
    case TELAS.LOJA: {
      const liberada = entradaLiberada(estado) || rng.chance(0.2);
      const x = rng.float();
      if (x < 0.15) moverSelecaoLoja(estado, rng.pick([-1, 1]));
      else if (x < 0.22) trocarLinhaLoja(estado);
      else if (x < 0.3) apontarLoja(estado, rng.int(0, 1), rng.int(-1, 6));
      else if (x < 0.3 + 0.01) alternarPausa(estado);
      else if (liberada && x < 0.5) {
        const i = rng.int(-1, estado.loja.itens.length);
        comprarItem(estado, i);
        if (rng.chance(0.2)) comprarItem(estado, i); // clique duplo na compra
      } else if (liberada && x < 0.56) venderCoringa(estado, rng.int(-1, CONTEUDO.loja.teto));
      else if (liberada && x < 0.62) rerolar(estado);
      else if (liberada && x < 0.68) confirmarLoja(estado);
      else if (liberada && x < 0.74) seguirDaLoja(estado);
      break;
    }
    case TELAS.ANUNCIO:
      if ((anuncioLiberado(estado) || rng.chance(0.1)) && rng.chance(0.3)) comecarProxima(estado);
      break;
    case TELAS.TCC:
      if ((tccLiberado(estado) || rng.chance(0.1)) && rng.chance(0.3)) {
        if (comecarTcc(estado)) run.contar('tcc');
      }
      break;
    case TELAS.COLACAO:
      if ((colacaoLiberada(estado) || rng.chance(0.1)) && rng.chance(0.3)) {
        if (sairDaColacao(estado)) run.contar('colacao');
      }
      break;
    case TELAS.MENU:
      if (run.recomecar && rng.chance(0.3)) {
        if (jogarDoMenu(estado)) run.contar('run');
      }
      break;
    default:
      break;
  }
}

// Como a run comeca: pelo menu, saltando para uma avaliacao qualquer da run
// com coringas e creditos sorteados, ou direto na defesa.
function montarInicio(estado, rng, run) {
  const modo = run.modo;
  if (modo === 'menu') {
    jogarDoMenu(estado);
    run.contar('run');
    return;
  }
  iniciarRun(estado);
  run.contar('run');
  const ids = CONTEUDO.coringas.map((c) => c.id);
  for (let i = rng.int(0, CONTEUDO.loja.teto); i > 0 && ids.length > 0; i -= 1) {
    const k = rng.int(0, ids.length - 1);
    estado.run.coringas.push(novaInstancia(ids[k]));
    ids.splice(k, 1);
  }
  estado.run.creditos = rng.int(0, 600);
  if (modo === 'salto') {
    const p = rng.int(0, CONTEUDO.periodos.length - 1);
    anunciarAvaliacao(estado, p, rng.int(0, CONTEUDO.periodos[p].avaliacoes.length - 1));
  } else {
    const p = CONTEUDO.periodos.length - 1;
    comecarAvaliacao(estado, p, CONTEUDO.periodos[p].avaliacoes.length - 1);
    avancarRun(estado);
  }
}

function jogarRun(semente, tetoTicks) {
  const rng = criarRng((semente ^ MISTURA_SEMENTE) >>> 0);
  const modo = rng.pick(['menu', 'menu', 'salto', 'salto', 'tcc']);
  const run = {
    modo,
    imortal: rng.chance(0.5),
    acelerar: rng.chance(0.7),
    pressao: rng.chance(0.25),
    desenhando: rng.chance(0.3),
    recomecar: rng.chance(0.6),
    telemetria: rng.chance(0.5),
    contagem: {},
    contar(chave) {
      run.contagem[chave] = (run.contagem[chave] || 0) + 1;
    },
  };
  const original = CONTEUDO.debug.relatorio;
  CONTEUDO.debug.relatorio = run.telemetria;
  const estado = novoEstado(semente);
  const relogio = criarRelogio();
  const ctx = run.desenhando ? ctxFalso() : null;
  const fx = run.desenhando ? criarEfeitos() : null;
  const limitador = criarLimitador();
  const disco = armazenamento(rng);
  const falhas = [];
  let relogioAudio = 0;
  const flags = ['imortal', 'acelerar', 'pressao', 'desenhando', 'telemetria'].filter((f) => run[f]);
  const saida = {
    semente, modo, flags: `${modo}${flags.length > 0 ? `+${flags.join('+')}` : ''}`,
    ticks: 0, quadros: 0, telas: {}, contagem: run.contagem, picoEventos: 0, picoInimigos: 0, erro: null,
  };
  const camadas = {
    desenhar: (e) => {
      if (ctx) desenhar(e, ctx, fx);
    },
    sincronizar: (e) => textosDaTela(e),
    // A fila do quadro inteiro (ate loop.maxPassosPorFrame ticks) e medida
    // quando o audio a consome, como no navegador.
    tocar: (eventos) => {
      if (eventos.length > saida.picoEventos) saida.picoEventos = eventos.length;
      relogioAudio += PASSO;
      planejarSons(eventos, limitador, relogioAudio);
    },
    gravarRecorde: (recorde) => gravarRecorde(recorde, disco),
    aoFalhar: (nome, erro) => falhas.push(`camada "${nome}": ${erro && erro.stack ? erro.stack : erro}`),
    falhas: {},
  };
  try {
    montarInicio(estado, rng, run);
    novaDirecao(rng, estado);
    let quadro = 0;
    while (saida.ticks < tetoTicks) {
      quadro += 1;
      agir(estado, rng, run);
      if (estado.tela === TELAS.MENU && !run.recomecar) break;
      const passos = rodarQuadro(estado, relogio, dtDeParede(rng), camadas);
      saida.ticks += passos;
      saida.telas[estado.tela] = (saida.telas[estado.tela] || 0) + 1;
      if (estado.enemies.length > saida.picoInimigos) saida.picoInimigos = estado.enemies.length;
      if (falhas.length > 0) throw new FalhaDoFuzz(falhas[0]);
      conferirEstado(estado, ctx);
      if (quadro % QUADROS_ENTRE_VARREDURAS === 0) {
        const ruim = procurarNumeroInvalido(estado, 'estado', new Set(), 0);
        exigir(!ruim, `numero invalido: ${ruim}`);
      }
      if (estado.tela === TELAS.MENU && run.contagem.run >= 4) run.recomecar = false;
    }
    saida.quadros = quadro;
  } catch (erro) {
    saida.erro = {
      mensagem: erro instanceof FalhaDoFuzz ? erro.message : `excecao: ${erro && erro.stack ? erro.stack : erro}`,
      tela: estado.tela,
      tick: saida.ticks,
      run: { modo, imortal: run.imortal, acelerar: run.acelerar, pressao: run.pressao, desenhando: run.desenhando, telemetria: run.telemetria },
    };
  } finally {
    CONTEUDO.debug.relatorio = original;
  }
  return saida;
}

// ================================================================ workers

function trabalhador() {
  parentPort.on('message', ({ i, semente, ticks }) => {
    parentPort.postMessage({ i, r: jogarRun(semente, ticks) });
  });
}

function executarTodos(sementes, ticks, nWorkers) {
  if (nWorkers <= 1 || sementes.length <= 1) return Promise.resolve(sementes.map((s) => jogarRun(s, ticks)));
  return new Promise((resolve, reject) => {
    const resultados = new Array(sementes.length);
    let proximo = 0;
    let feitos = 0;
    const workers = [];
    const despachar = (w) => {
      if (proximo >= sementes.length) return;
      w.postMessage({ i: proximo, semente: sementes[proximo], ticks });
      proximo += 1;
    };
    for (let k = 0; k < Math.min(nWorkers, sementes.length); k += 1) {
      const w = new Worker(new URL(import.meta.url));
      workers.push(w);
      w.on('message', ({ i, r }) => {
        resultados[i] = r;
        feitos += 1;
        if (feitos === sementes.length) {
          for (const x of workers) x.terminate();
          resolve(resultados);
        } else {
          despachar(w);
        }
      });
      w.on('error', (e) => {
        for (const x of workers) x.terminate();
        reject(e);
      });
      despachar(w);
    }
  });
}

function lerArgs(argv) {
  const cfg = { runs: 300, semente: SEMENTE_PADRAO, ticks: 30000, workers: Math.max(1, availableParallelism() - 1), so: null };
  for (const arg of argv) {
    const m = /^--([a-z]+)=(-?\d+)$/.exec(arg);
    if (!m || !(m[1] in cfg)) throw new Error(`argumento "${arg}" nao reconhecido (--runs, --semente, --ticks, --workers, --so; todos inteiros)`);
    cfg[m[1]] = Number(m[2]);
  }
  return cfg;
}

async function principal() {
  const cfg = lerArgs(process.argv.slice(2));
  const sementes = cfg.so !== null ? [cfg.so] : Array.from({ length: cfg.runs }, (_, i) => (cfg.semente + i * 7919) >>> 0);
  const t0 = Date.now();
  const resultados = await executarTodos(sementes, cfg.ticks, cfg.workers);
  const segundos = (Date.now() - t0) / 1000;

  const falhas = resultados.filter((r) => r.erro);
  const soma = (f) => resultados.reduce((s, r) => s + f(r), 0);
  const telas = {};
  for (const r of resultados) for (const [t, n] of Object.entries(r.telas)) telas[t] = (telas[t] || 0) + n;
  const contagem = {};
  for (const r of resultados) for (const [c, n] of Object.entries(r.contagem)) contagem[c] = (contagem[c] || 0) + n;
  const modos = {};
  for (const r of resultados) modos[r.modo] = (modos[r.modo] || 0) + 1;
  const ticks = soma((r) => r.ticks);
  const maisEventos = resultados.reduce((m, r) => (r.picoEventos > m.picoEventos ? r : m), resultados[0]);

  const linhas = [
    `${resultados.length} runs (${Object.entries(modos).map(([m, n]) => `${m} ${n}`).join(', ')}), ${(ticks / 1e6).toFixed(2)}M ticks ` +
      `(${(ticks * PASSO / 3600).toFixed(1)}h de jogo) em ${soma((r) => r.quadros)} quadros, ${segundos.toFixed(1)}s de parede, ${cfg.workers} worker(s)`,
    `  quadros por tela: ${Object.entries(telas).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(' · ')}`,
    `  passagens: ${Object.entries(contagem).map(([c, n]) => `${c} ${n}`).join(' · ')}`,
    `  pico de eventos num quadro: ${maisEventos.picoEventos} (teto ${CONTEUDO.arena.limites.eventos}; semente ${maisEventos.semente}, ${maisEventos.flags}) · ` +
      `pico de inimigos: ${Math.max(...resultados.map((r) => r.picoInimigos))} (spawn.maxSimultaneos ${CONTEUDO.spawn.maxSimultaneos}, pool ${CONTEUDO.arena.limites.enemies})`,
  ];
  if (falhas.length === 0) {
    console.log(`fuzz ok — ${linhas.join('\n')}`);
    return;
  }
  console.error(`\nfuzz FALHOU — ${falhas.length} de ${resultados.length} runs:\n`);
  for (const f of falhas.slice(0, 10)) {
    console.error(`  x semente ${f.semente} (${JSON.stringify(f.erro.run)}), tela "${f.erro.tela}", tick ${f.erro.tick}:`);
    console.error(`    ${f.erro.mensagem.split('\n').slice(0, 8).join('\n    ')}`);
    console.error(`    reproduzir: npm run fuzz -- --so=${f.semente} --ticks=${cfg.ticks} --workers=1\n`);
  }
  console.error(linhas.join('\n'));
  process.exit(1);
}

if (isMainThread) {
  principal().catch((e) => {
    console.error(`fuzz: ${e && e.stack ? e.stack : e}`);
    process.exit(2);
  });
} else {
  trabalhador();
}
