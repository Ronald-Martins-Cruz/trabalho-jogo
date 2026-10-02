// npm run smoke — roda a partida headless com semente fixa e falha se o jogo
// quebrar. Nenhum navegador envolvido: a simulacao e feita so de objetos.
//
// Como estender quando sua fase acrescentar sistema novo:
//   1. adicione uma entrada em VERIFICACOES com { nome, rodar(estado, tick) }
//      devolvendo uma string de erro ou null;
//   2. se sua fase criar uma pool nova, registre o teto em
//      CONTEUDO.arena.limites — a verificacao de pool le de la sozinha;
//   3. some seus contadores em resumo() para eles aparecerem na linha final.

import { CONTEUDO, validarConteudo } from '../data/content.js';
import {
  dadosDaAvaliacao,
  emitir,
  iniciarAvaliacao,
  irParaTela,
  novoEstado,
  TELAS,
} from '../src/state.js';
import { alternarPausa, atualizar, avancarRelogio, criarRelogio, sairDoResultado } from '../src/main.js';
import {
  anuncioLiberado,
  avancarRun,
  calcularNota,
  comecarAvaliacao,
  comecarProxima,
  creditosDaFaixa,
  faixaDaNota,
  FONTE_PERDA_HP,
  iniciarRun,
  MOTIVO_JUBILADO,
  MOTIVO_TEMPO,
  proximaAvaliacao,
  sairDoTcc,
  sortearModificadores,
} from '../src/run.js';
import {
  aoCalcularDano,
  ATRIBUTOS,
  coringasDesligados,
  HOOKS,
  modificarAtributo,
  novaInstancia,
  verificarCoringasDoConteudo,
} from '../src/jokers.js';
import {
  abrirLoja,
  apontarLoja,
  AVISOS,
  comprarItem,
  confirmarLoja,
  itensDaLoja,
  LINHA_CORINGAS,
  LINHA_VITRINE,
  moverSelecaoLoja,
  posicaoRerolar,
  posicaoSeguir,
  precoReroll,
  rerolar,
  rerolarTrazNovidade,
  rerollsGratisDaLoja,
  seguirDaLoja,
  entradaLiberada,
  trocarLinhaLoja,
  valorDeVenda,
  venderCoringa,
} from '../src/shop.js';
// ui.js nao toca no DOM no topo do modulo (criarUi recebe o `document`), entao
// os formatadores puros da tela de resultado podem ser testados aqui — e a
// primeira cobertura automatica que ui.js tem.
import {
  armasDoBoletim,
  decomposicaoDaNota,
  emojisDosCoringas,
  formatarNota,
  resumoDoJubilado,
  rotuloDoReroll,
} from '../src/ui.js';
import { readdirSync, readFileSync } from 'node:fs';
import {
  aplicarDano,
  atualizarInimigos,
  spawnInimigo,
  poolInimigos,
  limparInimigos,
  verificarInimigosDoConteudo,
} from '../src/enemies.js';
import {
  atualizarArmas,
  dadosDaArma,
  equiparArma,
  nivelDaArma,
  poolProjeteis,
  posicaoSatelite,
  subirNivelArma,
  verificarArmasDoConteudo,
} from '../src/weapons.js';
import { apontarCarta, cartaLiberada, escolherCarta, moverSelecaoCarta, verificarCartasDoConteudo } from '../src/cards.js';
import {
  atualizarOrbes,
  atualizarPlayer,
  poolOrbes,
  receberDano,
  soltarOrbeXp,
  xpParaSubir,
} from '../src/player.js';
import { criarPool } from '../src/pool.js';
import { FONTE_DESCONHECIDA, registrarQuadro, SITUACAO } from '../src/telemetria.js';
import { analisarAvaliacao, ESCOPOS, gerarRelatorio } from '../src/relatorio.js';

const SEMENTE = 20261110;
const TICKS = 3600; // 60s simulados a 1/60
const PASSO = CONTEUDO.loop.passo;
const INTERVALO_VARREDURA = 60; // varredura profunda de NaN/Infinity a cada 1s
const VOLTA_TICKS = 600; // bot: ticks para uma volta completa (10s a 60 ticks/s)
const TICKS_AQUECIMENTO = 600; // 10s: depois disso nenhuma alocacao nova e aceita
const MINIMO_INIMIGOS = 20; // pico abaixo disso significa spawn quebrado
const TICKS_ARMA = 1800; // 30s da corrida do bot parado (checarArmaSozinha)
const MINIMO_MORTOS_ARMA = 20; // abaixo disso a arma nao esta matando de verdade

// Progressao. O alvo do design §3 e nivel 5-6 em 60s; a faixa aceita e mais
// larga que o alvo de proposito — ela existe para pegar o sistema QUEBRADO
// (orbe que ninguem coleta trava no nivel 1; curva zerada dispara para 20),
// nao para congelar o balanceamento, que e da fase 13.
const TICKS_PROGRESSAO = 3600; // 60s: a janela de que o design fala
const NIVEL_MINIMO_60S = 4;
const NIVEL_MAXIMO_60S = 9;
const TICKS_CONGELADO = 30; // ticks com a carta aberta sem ninguem escolher

// Fim de avaliacao. A corrida dedicada roda uma avaliacao inteira sem segurar
// o HP do jogador — e a unica que produz uma nota honesta para imprimir.
const TICKS_AVALIACAO_COMPLETA = TICKS + 240;
const TEMPO_FORA = 30; // segundos de aba escondida/pausa longa no teste do relogio
const DANO_DO_CENARIO = 30; // arranhao no cenario de resultado: hp != hpMax e ileso = false
const CREDITOS_ANTERIORES = 7; // creditos ja na run antes do boletim: soma tem que somar
const KILLS_DO_CENARIO = 120; // mortos plantados no boletim do cenario de resultado
const EPSILON = 1e-9;

// As duas telas em que uma avaliacao termina. Antes desta fase as duas eram o
// menu, e todo o smoke procurava por TELAS.MENU.
function telaDeFim(estado) {
  return estado.tela === TELAS.RESULTADO || estado.tela === TELAS.JUBILADO;
}

// Para onde sairDoResultado leva: a loja (aprovado) ou o menu (jubilado).
// Antes da fase 07 as duas saidas eram o menu.
function foraDaAvaliacao(estado) {
  return estado.tela === TELAS.MENU || estado.tela === TELAS.LOJA;
}

// "Jogar" e depois "Começar" no anuncio da 1ª avaliacao (fase 08): desde que
// a run passa pelo anuncio, iniciarRun sozinho deixa a partida parada na tela
// de anuncio. A 1ª avaliacao nao sorteia modificador, entao nenhum rng e
// gasto no anuncio e a partida e a mesma de antes do anuncio existir.
function comecarRun(estado) {
  iniciarRun(estado);
  if (estado.tela !== TELAS.ANUNCIO) falhar(0, `iniciarRun foi a "${estado.tela}", esperava o anuncio`);
  if (!comecarProxima(estado)) falhar(0, 'comecarProxima recusou o anuncio da 1a avaliacao');
}

// Teste de carga: `npm run smoke -- --carga` enche a arena ate o teto da pool
// e mantem o jogador de pe, para medir o custo de IA + separacao + colisao no
// pior caso. Fora desse modo a corrida e a de sempre.
const CARGA = process.argv.includes('--carga');
const ALVO_CARGA = CONTEUDO.arena.limites.enemies;
if (CARGA) CONTEUDO.spawn.maxSimultaneos = ALVO_CARGA;

const POOLS = Object.keys(CONTEUDO.arena.limites).filter((p) => p !== 'eventos');

const picos = {};
for (const pool of POOLS) picos[pool] = 0;
const contadores = { avaliacoesConcluidas: 0, eventos: 0, cartas: 0, porTipo: {}, notas: [], conceitos: [] };

// Pools: alocacao so na abertura. `criados` e o numero de vezes que a fabrica
// rodou — se crescer depois do aquecimento, alguem esta alocando dentro do
// update, que e a restricao 5 do CLAUDE.md e a causa n1 de travamento.
const criadosNoAquecimento = {};
let danoTotal = 0;
let danoAnterior = 0;

// Rastreio de movimento do jogador: a asserção de arena so prova que ele nao
// SAI dos limites, o que passa igual se ele nunca sair do lugar. Isto pega o
// caso em que atualizarPlayer() para de ser chamado (ex.: alguem reorganiza
// atualizarAvaliacao() numa fase futura e perde a linha no meio do caminho).
let distanciaPercorrida = 0;
let posAnteriorX = null;
let posAnteriorY = null;
let minX = Infinity;
let maxX = -Infinity;
let minY = Infinity;
let maxY = -Infinity;

// avaliacao.danoTomado zera a cada avaliacao nova; acumular so as diferencas
// positivas da o total da corrida inteira, atravessando os reinicios.
function registrarDano(estado) {
  const atual = estado.run.avaliacao.danoTomado;
  if (atual > danoAnterior) danoTotal += atual - danoAnterior;
  danoAnterior = atual;
}

function registrarMovimento(estado) {
  const p = estado.player;
  if (posAnteriorX !== null) {
    distanciaPercorrida += Math.hypot(p.x - posAnteriorX, p.y - posAnteriorY);
  }
  posAnteriorX = p.x;
  posAnteriorY = p.y;
  if (p.x < minX) minX = p.x;
  if (p.x > maxX) maxX = p.x;
  if (p.y < minY) minY = p.y;
  if (p.y > maxY) maxY = p.y;
}

const VERIFICACOES = [
  {
    nome: 'escalares finitos',
    rodar(estado) {
      const av = estado.run.avaliacao;
      const suspeitos = [
        ['tempo', estado.tempo],
        ['player.x', estado.player.x],
        ['player.y', estado.player.y],
        ['player.hp', estado.player.hp],
        ['player.xp', estado.player.xp],
        ['avaliacao.restante', av.restante],
        ['avaliacao.decorrido', av.decorrido],
      ];
      for (const [nome, valor] of suspeitos) {
        if (!Number.isFinite(valor)) return `${nome} virou ${valor}`;
      }
      return null;
    },
  },
  {
    nome: 'pools dentro do teto',
    rodar(estado) {
      for (const pool of POOLS) {
        const tamanho = estado[pool].length;
        if (tamanho > picos[pool]) picos[pool] = tamanho;
        if (tamanho > CONTEUDO.arena.limites[pool]) {
          return `pool ${pool} com ${tamanho} itens, teto e ${CONTEUDO.arena.limites[pool]}`;
        }
      }
      if (estado.eventos.length > CONTEUDO.arena.limites.eventos) {
        return `fila de eventos com ${estado.eventos.length}, teto e ${CONTEUDO.arena.limites.eventos}`;
      }
      return null;
    },
  },
  {
    nome: 'tela valida',
    rodar(estado) {
      const validas = Object.values(TELAS);
      return validas.includes(estado.tela) ? null : `tela desconhecida "${estado.tela}"`;
    },
  },
  {
    nome: 'varredura profunda',
    rodar(estado, tick) {
      if (tick % INTERVALO_VARREDURA !== 0) return null;
      return procurarNumeroInvalido(estado, 'estado', new Set(), 0);
    },
  },
  {
    nome: 'inimigos sadios',
    rodar(estado) {
      const inimigos = estado.enemies;
      for (let i = 0; i < inimigos.length; i += 1) {
        const e = inimigos[i];
        if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) {
          return `inimigo ${i} (${e.tipo}) em posicao invalida (${e.x}, ${e.y})`;
        }
        if (!Number.isFinite(e.vx) || !Number.isFinite(e.vy)) {
          return `inimigo ${i} (${e.tipo}) com velocidade invalida (${e.vx}, ${e.vy})`;
        }
        if (!Number.isFinite(e.hp) || e.raio <= 0) {
          return `inimigo ${i} (${e.tipo}) com hp=${e.hp} raio=${e.raio}`;
        }
      }
      return null;
    },
  },
  {
    nome: 'projeteis sadios',
    rodar(estado) {
      const projeteis = estado.projectiles;
      for (let i = 0; i < projeteis.length; i += 1) {
        const p = projeteis[i];
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          return `projetil ${i} (${p.arma}) em posicao invalida (${p.x}, ${p.y})`;
        }
        if (!Number.isFinite(p.vx) || !Number.isFinite(p.vy)) {
          return `projetil ${i} (${p.arma}) com velocidade invalida (${p.vx}, ${p.vy})`;
        }
        if (!Number.isFinite(p.vida) || p.raio <= 0 || !Number.isFinite(p.dano)) {
          return `projetil ${i} (${p.arma}) com vida=${p.vida} raio=${p.raio} dano=${p.dano}`;
        }
        // Projetil parado e projetil que nunca sai da frente do jogador: ou a
        // mira devolveu (0,0) ou a velocidade do nivel nao chegou ate aqui.
        if (p.vx === 0 && p.vy === 0) return `projetil ${i} (${p.arma}) parado no lugar`;
      }
      return null;
    },
  },
  {
    nome: 'pools sem alocar no loop',
    rodar(estado, tick) {
      const pools = estado.scratch && estado.scratch.pools;
      if (!pools) return null;
      for (const [chave, pool] of Object.entries(pools)) {
        if (tick <= TICKS_AQUECIMENTO) {
          criadosNoAquecimento[chave] = pool.criados;
        } else if (pool.criados > criadosNoAquecimento[chave]) {
          return (
            `pool ${chave} fabricou ${pool.criados - criadosNoAquecimento[chave]} objetos depois do ` +
            `aquecimento (${criadosNoAquecimento[chave]} -> ${pool.criados}) — alguem esta alocando dentro do update`
          );
        }
        if (tick % INTERVALO_VARREDURA === 0) {
          const problema = pool.verificar();
          if (problema) return `pool ${chave} inconsistente: ${problema}`;
        }
      }
      return null;
    },
  },
  {
    // Nao depende de semente, de balanceamento nem de o jogador morrer nesta
    // corrida: so proibe o estado impossivel. Continua valendo na fase 03,
    // quando as armas fizerem o jogador parar de morrer.
    nome: 'morte encerra a avaliacao',
    rodar(estado) {
      if (!estado.player.vivo && estado.tela === TELAS.AVALIACAO) {
        return 'jogador morto e a avaliacao continua: ninguem observa player.vivo';
      }
      return null;
    },
  },
  {
    nome: 'jogador dentro da arena',
    rodar(estado) {
      const { largura, altura } = CONTEUDO.arena;
      const p = estado.player;
      const r = p.raio;
      const FOLGA = 0.5; // acumulo de ponto flutuante no clamp da borda
      if (p.x < r - FOLGA || p.x > largura - r + FOLGA || p.y < r - FOLGA || p.y > altura - r + FOLGA) {
        return `jogador saiu da arena: (${p.x.toFixed(2)}, ${p.y.toFixed(2)}), raio=${r}, arena=${largura}x${altura}`;
      }
      return null;
    },
  },
];

// Bot minimo que move o jogador em circulo, escrevendo em estado.input como o
// teclado faria (eixoX/eixoY em [-1, 1]). player.js nunca le teclado direto —
// e exatamente essa porta que permite este bot substituir o navegador.
function botCircular(estado, tick) {
  const angulo = (tick / VOLTA_TICKS) * 2 * Math.PI;
  estado.input.eixoX = Math.cos(angulo);
  estado.input.eixoY = Math.sin(angulo);
}

// No modo carga a arena fica cheia ate o teto da pool e o jogador nao morre —
// o que se quer medir e o custo por quadro de IA, separacao e colisao com a
// pool inteira viva, nao a sobrevivencia dele.
//
// Fase 09: preenche em RODIZIO pelos 4 tipos (tipoId explicito), nao pelo
// sorteio natural da composicao da avaliacao — a avaliacao default (p1-av1)
// e so Prazo de Entrega, e "400 inimigos misturados" (criterio de aceite)
// precisa dos 4 tipos de verdade, nao de sorte. O contador persiste entre
// quadros: como as armas matam alguns a cada tick, o rodizio continua de
// onde parou e a mistura fica presente na corrida inteira, nao so na
// abertura.
let proximoTipoCarga = 0;
function manterCarga(estado) {
  if (!CARGA || estado.tela !== TELAS.AVALIACAO) return;
  estado.player.hp = estado.player.hpMax; // toma dano (e conta), mas nao cai
  while (estado.enemies.length < ALVO_CARGA) {
    const tipo = CONTEUDO.inimigos[proximoTipoCarga % CONTEUDO.inimigos.length];
    proximoTipoCarga += 1;
    if (!spawnInimigo(estado, tipo.id)) break;
  }
}

function procurarNumeroInvalido(valor, caminho, vistos, profundidade) {
  if (profundidade > 8) return null;
  if (typeof valor === 'number') {
    return Number.isFinite(valor) ? null : `${caminho} = ${valor}`;
  }
  if (typeof valor !== 'object' || valor === null) return null;
  if (vistos.has(valor)) return null;
  vistos.add(valor);
  if (Array.isArray(valor)) {
    for (let i = 0; i < valor.length; i += 1) {
      const achado = procurarNumeroInvalido(valor[i], `${caminho}[${i}]`, vistos, profundidade + 1);
      if (achado) return achado;
    }
    return null;
  }
  for (const [chave, item] of Object.entries(valor)) {
    if (typeof item === 'function') continue;
    const achado = procurarNumeroInvalido(item, `${caminho}.${chave}`, vistos, profundidade + 1);
    if (achado) return achado;
  }
  return null;
}

function falhar(tick, mensagem) {
  console.error(`\nsmoke FALHOU no tick ${tick} (t=${(tick * PASSO).toFixed(2)}s):`);
  console.error(`  x ${mensagem}\n`);
  process.exit(1);
}

// A partida nunca enche a pool ate o teto (spawn.maxSimultaneos para antes),
// entao o caminho de "pool cheia: recicle o mais antigo" ficaria sem cobertura
// nenhuma — e e justamente ele que decide se o jogo aloca ou trava quando a
// arena lota. Pool de brinquedo, tres objetos, antes da corrida.
function checarReciclagemDaPool() {
  const pool = criarPool(3, () => ({ marca: 0 }));
  const primeiro = pool.obter();
  primeiro.marca = 1;
  pool.obter().marca = 2;
  pool.obter().marca = 3;
  const quarto = pool.obter(); // pool cheia: precisa reaproveitar o de marca 1

  if (pool.ativos.length !== 3) falhar(0, `pool cheia cresceu para ${pool.ativos.length} ativos (teto 3)`);
  if (pool.criados !== 3) falhar(0, `pool cheia fabricou objeto novo (criados=${pool.criados})`);
  if (quarto !== primeiro) falhar(0, 'pool cheia nao reciclou o objeto mais antigo');
  if (pool.reciclados !== 1) falhar(0, `esperava 1 reciclagem, veio ${pool.reciclados}`);
  const problema = pool.verificar();
  if (problema) falhar(0, `pool de brinquedo inconsistente: ${problema}`);

  pool.liberarTodos();
  if (pool.ativos.length !== 0 || pool.reserva.length !== 3) {
    falhar(0, `liberarTodos deixou ativos=${pool.ativos.length} reserva=${pool.reserva.length}`);
  }
}

// ------------------------------------------------------- fase 09: bestiario

// Inimigo e dado, como arma: a entrada de content.js so ganha movimento se
// `comportamento` apontar para uma funcao registrada em enemies.js. Mesmo
// papel de checarArmasDoConteudo, para o registro MOVIMENTOS.
function checarInimigosDoConteudo() {
  const problema = verificarInimigosDoConteudo();
  if (problema) falhar(0, problema);
}

// Tarefa 5 do contrato: cada tipo, sozinho, numa corrida curta — pega
// qualquer excecao de um comportamento novo (o 'errante' da Notificacao, o
// empurrao do PDF) antes de chegar na corrida principal, onde um tipo raro
// (peso baixo) poderia nao nascer nenhuma vez em 60s.
const TICKS_TIPO_ISOLADO = 300; // 5s bastam pra mover, separar e colidir umas poucas vezes
function checarTiposIsolados() {
  for (const tipo of CONTEUDO.inimigos) {
    const estado = novoEstado(SEMENTE + 500);
    iniciarAvaliacao(estado);
    for (let tick = 1; tick <= TICKS_TIPO_ISOLADO; tick += 1) {
      botCircular(estado, tick);
      for (let s = 0; s < 3; s += 1) spawnInimigo(estado, tipo.id);
      try {
        atualizarInimigos(estado, PASSO);
      } catch (e) {
        falhar(tick, `tipo isolado "${tipo.id}" quebrou atualizarInimigos: ${e && e.stack ? e.stack : e}`);
      }
      for (const inimigo of estado.enemies) {
        if (!Number.isFinite(inimigo.x) || !Number.isFinite(inimigo.y) || !Number.isFinite(inimigo.hp)) {
          falhar(tick, `tipo isolado "${tipo.id}": inimigo com numero invalido (x=${inimigo.x}, y=${inimigo.y}, hp=${inimigo.hp})`);
        }
      }
    }
    if (estado.enemies.length === 0) falhar(0, `tipo isolado "${tipo.id}": nenhum sobreviveu ${TICKS_TIPO_ISOLADO} ticks — spawnInimigo(estado, id) funciona?`);

    // Pendencia 49: TODA fonte de dano nova precisa emitir jogador-dano com
    // a origem certa — sem isso o relatorio mostraria "fonte desconhecida"
    // para os 3 tipos novos. Contato forcado (encostado no jogador), nao a
    // perseguicao natural: o PDF sozinho, vindo da borda, levaria bem mais
    // de 5s pra chegar, e o teste ficaria falso-negativo pra ele.
    const e2 = novoEstado(SEMENTE + 500);
    iniciarAvaliacao(e2);
    limparInimigos(e2);
    const encostado = spawnInimigo(e2, tipo.id);
    encostado.x = e2.player.x + e2.player.raio + encostado.raio - 1;
    encostado.y = e2.player.y;
    let fonteVista = null;
    for (let tick = 1; tick <= 90 && !fonteVista; tick += 1) {
      atualizarInimigos(e2, PASSO);
      for (const evento of e2.eventos) {
        if (evento.tipo === 'jogador-dano') fonteVista = evento.dados.fonte;
      }
      e2.eventos.length = 0;
    }
    if (fonteVista !== tipo.id) {
      falhar(
        0,
        `tipo "${tipo.id}": encostado no jogador, nenhum jogador-dano com fonte "${tipo.id}" saiu em 90 ticks ` +
          `(veio "${fonteVista}") — o relatorio mostraria fonte desconhecida para este tipo`
      );
    }
  }
}

// Tarefa 2 do contrato: o empurrao do PDF acontece FORA do passo normal de
// atualizarPlayer (colidirComJogador roda depois, dentro de
// atualizarInimigos), entao se ele nao grampear na arena sozinho, o jogador
// sai dela no MESMO tick — e nenhuma outra verificacao deste arquivo pegaria
// isso, porque a corrida principal (VERIFICACOES, "jogador dentro da arena")
// roda so em p1-av1, onde o PDF nem pode nascer. Jogador colado na quina,
// tipo empurrando na direcao da parede: o pior caso pro clamp.
function checarEmpurraoNaArena() {
  const tipo = CONTEUDO.inimigos.find((t) => t.empurraoContato > 0);
  if (!tipo) falhar(0, 'empurrao na arena: nenhum inimigo com empurraoContato — a tarefa 2 da fase 09 nao foi feita');

  const estado = novoEstado(SEMENTE + 507);
  iniciarAvaliacao(estado);
  limparInimigos(estado);
  const arena = estado.run.avaliacao.arena;
  const player = estado.player;
  player.x = arena.esquerda + player.raio;
  player.y = arena.topo + player.raio;

  const e = spawnInimigo(estado, tipo.id);
  // Encostado, do lado de DENTRO da arena: o vetor jogador-menos-inimigo
  // aponta para a quina, o pior caso pro clamp.
  e.x = player.x + player.raio + e.raio - 1;
  e.y = player.y + player.raio + e.raio - 1;

  for (let tick = 1; tick <= 90; tick += 1) {
    atualizarInimigos(estado, PASSO);
    const r = player.raio;
    const FOLGA = 0.5;
    if (
      player.x < arena.esquerda + r - FOLGA || player.x > arena.direita - r + FOLGA ||
      player.y < arena.topo + r - FOLGA || player.y > arena.base - r + FOLGA
    ) {
      falhar(
        tick,
        `empurrao na arena: o tipo "${tipo.id}" empurrou o jogador para (${player.x.toFixed(1)}, ${player.y.toFixed(1)}), ` +
          `fora dela — colidirComJogador precisa grampear na arena depois do empurrao`
      );
    }
  }
  return `${tipo.emoji} ${tipo.id} (empurraoContato=${tipo.empurraoContato}): encostado na quina, o jogador nao sai da arena em 90 ticks`;
}

// Correcao pos-revisao (item 3): checarEmpurraoNaArena() so prova que o
// empurrao nao joga o jogador pra fora da arena — trocar o empurrao inteiro
// por `+= 0` passa por ela sem ser notado, porque no centro aberto o jogador
// nunca chegaria perto da borda de qualquer jeito. Este teste mede a
// MAGNITUDE: no meio da arena (longe de qualquer parede, sem limitarNaArena
// entrar na conta), com o tipo PARADO (velocidade=0, so o empurrao move
// alguem) e dy=0 o tempo inteiro (a direcao do empurrao fica exatamente
// (1,0), sem mudar com a distancia), o deslocamento esperado a cada quadro
// de sobreposicao e EXATAMENTE empurraoContato x PASSO — soma-se isso pelos
// quadros que os corpos ficaram sobrepostos e compara-se com o deslocamento
// real do jogador.
function checarEmpurraoEmCampoAberto() {
  const tipo = CONTEUDO.inimigos.find((t) => t.empurraoContato > 0);
  if (!tipo) falhar(0, 'empurrao em campo aberto: nenhum inimigo com empurraoContato');

  const estado = novoEstado(SEMENTE + 510);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  const arena = estado.run.avaliacao.arena;
  const player = estado.player;
  player.x = (arena.esquerda + arena.direita) / 2;
  player.y = (arena.topo + arena.base) / 2;

  const e = spawnInimigo(estado, tipo.id);
  if (!e) falhar(0, 'empurrao em campo aberto: spawnInimigo devolveu null');
  const soma = e.raio + player.raio;
  e.velocidade = 0; // nao persegue: so o empurrao desloca alguem neste teste
  e.x = player.x - soma * 0.5; // 50% de sobreposicao, folga de sobra pra medir varios quadros
  e.y = player.y;

  const xInicial = player.x;
  const yInicial = player.y;
  let ticks = 0;
  const TETO_TICKS = 60; // 1s de sobra: a sobreposicao de 50% se desfaz bem antes
  while (player.x - e.x < soma && ticks < TETO_TICKS) {
    atualizarInimigos(estado, PASSO);
    ticks += 1;
  }

  if (ticks === 0) falhar(0, 'empurrao em campo aberto: os corpos ja nasceram sem se sobrepor — cenario mal montado');
  if (Math.abs(player.y - yInicial) > 1e-6) {
    falhar(0, `empurrao em campo aberto: o jogador se moveu ${(player.y - yInicial).toFixed(3)}px no eixo Y, esperava 0 (dy=0 o tempo inteiro)`);
  }
  const deslocamento = player.x - xInicial;
  const esperado = tipo.empurraoContato * ticks * PASSO;
  const FOLGA = 0.02; // 2%: so ponto flutuante, a fisica aqui e exata por construcao
  if (Math.abs(deslocamento - esperado) > Math.max(0.5, esperado * FOLGA)) {
    falhar(
      0,
      `empurrao em campo aberto: o tipo "${tipo.id}" deslocou o jogador ${deslocamento.toFixed(2)}px em ` +
        `${ticks} quadros sobrepostos, esperava ~${esperado.toFixed(2)}px (empurraoContato=${tipo.empurraoContato} x tempo) — ` +
        'a magnitude do empurrao nao bate com content.js'
    );
  }

  return `${tipo.emoji} ${tipo.id}: ${ticks} quadros sobrepostos deslocaram o jogador ${deslocamento.toFixed(2)}px (esperado ~${esperado.toFixed(2)}px)`;
}

// Tarefa 3 do contrato, a parte que mais importa: a divisao do 📱 Trabalho em
// Grupo (1) tem profundidade travada — o filhote NAO divide de novo — e
// (2) respeita spawn.maxSimultaneos mesmo com a pool no teto, sem travar em
// loop. As duas provas usam a porta de sempre (aplicarDano), nao um atalho.
function checarDivisaoTrabalhoEmGrupo() {
  const onde = 'divisao do Trabalho em Grupo';
  const tipo = CONTEUDO.inimigos.find((i) => i.divisao);
  if (!tipo) falhar(0, `${onde}: nenhum inimigo em content.js tem \`divisao\` — a tarefa 3 da fase 09 nao foi feita`);

  // 1) Profundidade: matar um pai (geracao 0) produz `filhos` filhotes
  //    geracao 1; matar um FILHOTE nao produz neto nenhum.
  const e = novoEstado(SEMENTE + 501);
  iniciarAvaliacao(e);
  limparInimigos(e);
  const pool = poolInimigos(e);

  const pai = spawnInimigo(e, tipo.id);
  if (!pai) falhar(0, `${onde}: spawnInimigo devolveu null montando o pai`);
  const antesDivisao = pool.ativos.length;
  aplicarDano(e, pai, pai.hpMax);
  const filhotes = pool.ativos.filter((x) => x.tipo === tipo.id && x.geracao === 1);
  if (filhotes.length !== tipo.divisao.filhos) {
    falhar(0, `${onde}: matar o pai deixou ${filhotes.length} filhotes geracao 1 na pool, esperava ${tipo.divisao.filhos}`);
  }
  if (pool.ativos.length !== antesDivisao - 1 + tipo.divisao.filhos) {
    falhar(0, `${onde}: a pool ficou com ${pool.ativos.length} ativos depois da divisao, esperava ${antesDivisao - 1 + tipo.divisao.filhos}`);
  }
  const problemaPool = pool.verificar();
  if (problemaPool) falhar(0, `${onde}: pool inconsistente depois da divisao normal: ${problemaPool}`);

  const antesNeto = pool.ativos.length;
  aplicarDano(e, filhotes[0], filhotes[0].hpMax);
  if (pool.ativos.length !== antesNeto - 1) {
    falhar(
      0,
      `${onde}: matar um filhote foi de ${antesNeto} para ${pool.ativos.length} ativos (esperava -1): ` +
        'ele dividiu de novo, geracaoMaxima nao esta travando a profundidade'
    );
  }

  // 2) Espaco PARCIAL: o teto trancado bem no que ja esta vivo (contando o
  //    pai que esta prestes a morrer) deixa exatamente 1 vaga livre quando
  //    ele morre — matar libera 1 slot antes de dividirSeAplicavel rodar,
  //    entao filhos=2 so cabe 1. Isto prova que o teto e respeitado PARA
  //    CADA filhote (nao so no primeiro), nao que a divisao vira 0.
  const e2 = novoEstado(SEMENTE + 502);
  iniciarAvaliacao(e2);
  limparInimigos(e2);
  const pool2 = poolInimigos(e2);
  const pai2 = spawnInimigo(e2, tipo.id);
  if (!pai2) falhar(0, `${onde}: spawnInimigo devolveu null montando o pai do cenario com espaco parcial`);
  const maxOriginal = CONTEUDO.spawn.maxSimultaneos;
  CONTEUDO.spawn.maxSimultaneos = pool2.ativos.length; // trava exatamente no que ja esta vivo
  try {
    const antes2 = pool2.ativos.length;
    aplicarDano(e2, pai2, pai2.hpMax);
    // O pai morreu (-1) e SO 1 filhote coube na vaga que abriu, mesmo
    // `divisao.filhos` pedindo mais — nunca pode passar do teto.
    const esperado2 = antes2 - 1 + Math.min(1, tipo.divisao.filhos);
    if (pool2.ativos.length !== esperado2 || pool2.ativos.length > CONTEUDO.spawn.maxSimultaneos) {
      falhar(
        0,
        `${onde}: com o teto travado em ${CONTEUDO.spawn.maxSimultaneos}, matar o pai foi de ${antes2} para ` +
          `${pool2.ativos.length} ativos (esperava ${esperado2}, nunca acima do teto) — a divisao ignorou maxSimultaneos`
      );
    }
    const problema2 = pool2.verificar();
    if (problema2) falhar(0, `${onde}: pool inconsistente depois da divisao com espaco parcial: ${problema2}`);
  } finally {
    CONTEUDO.spawn.maxSimultaneos = maxOriginal;
  }

  // 3) Espaco ZERO: o teto travado ABAIXO do que ja esta vivo (outros
  //    inimigos ocupando as vagas, nao o proprio pai) — mesmo depois de o
  //    pai morrer e liberar 1 slot, a pool continua no teto ou acima, e
  //    NENHUM filhote pode nascer. E o cenario real de "pool cheia": a
  //    prova de que a recursao de divisao nao estoura o teto quando ele
  //    esta genuinamente lotado por OUTRA coisa, nao pelo proprio pai.
  const e3 = novoEstado(SEMENTE + 505);
  iniciarAvaliacao(e3);
  limparInimigos(e3);
  const pool3 = poolInimigos(e3);
  const outroTipo = CONTEUDO.inimigos.find((t) => t.id !== tipo.id) || tipo;
  const ENCHIMENTO = 4;
  for (let i = 0; i < ENCHIMENTO; i += 1) spawnInimigo(e3, outroTipo.id);
  const pai3 = spawnInimigo(e3, tipo.id);
  if (!pai3) falhar(0, `${onde}: spawnInimigo devolveu null montando o pai do cenario sem espaco`);
  const maxOriginal3 = CONTEUDO.spawn.maxSimultaneos;
  CONTEUDO.spawn.maxSimultaneos = ENCHIMENTO; // so cabem os "outros"; nem o pai deveria caber de novo
  try {
    const antes3 = pool3.ativos.length; // ENCHIMENTO + 1 (o pai), acima do teto de proposito
    aplicarDano(e3, pai3, pai3.hpMax);
    if (pool3.ativos.length !== antes3 - 1) {
      falhar(
        0,
        `${onde}: com o teto (${CONTEUDO.spawn.maxSimultaneos}) abaixo do que ja estava vivo, matar o pai foi ` +
          `de ${antes3} para ${pool3.ativos.length} ativos (esperava ${antes3 - 1}, ou seja, ZERO filhotes)`
      );
    }
    if (pool3.ativos.length > CONTEUDO.spawn.maxSimultaneos + 1) {
      // +1 de folga: os "outros" ja estavam ali antes do teto encolher, o
      // que a divisao nao pode fazer e SOMAR gente nova em cima disso.
      falhar(0, `${onde}: a pool ficou com ${pool3.ativos.length} ativos, acima de qualquer leitura razoavel do teto — a divisao estourou`);
    }
    const problema3 = pool3.verificar();
    if (problema3) falhar(0, `${onde}: pool inconsistente depois da divisao sem espaco: ${problema3}`);
  } finally {
    CONTEUDO.spawn.maxSimultaneos = maxOriginal3;
  }

  return (
    `${tipo.emoji} ${tipo.nome}: filhos=${tipo.divisao.filhos} geracaoMaxima=${tipo.divisao.geracaoMaxima} — ` +
    'divide uma vez, o filhote nao divide de novo, e a pool travada no teto nao estoura nem trava em loop'
  );
}

// Tarefa 5, "uma [corrida] com todos misturados": uma avaliacao com
// composicaoSpawn 'todos' (2o periodo em diante), HP segurado, tempo
// suficiente para os 4 tipos nascerem de verdade pelo sorteio normal — nao
// so por spawnInimigo(estado, id) explicito. Serve tambem de medida para a
// pendencia 28 (pico de orbes de XP com a composicao nova: o Trabalho em
// Grupo dobra o numero de mortes por "inimigo" quando divide).
const TICKS_MISTURADO = 5400; // 90s: janela generosa pro sorteio pegar os 4 tipos e a rajada
function checarComposicaoMisturada() {
  const estado = novoEstado(SEMENTE + 503);
  comecarAvaliacao(estado, 1, 0); // p2-av1: composicaoSpawn 'todos' (handoff da fase 09)
  if (estado.run.avaliacao.composicaoSpawn !== 'todos') {
    falhar(0, `composicao misturada: p2-av1 tem composicaoSpawn "${estado.run.avaliacao.composicaoSpawn}", esperava "todos"`);
  }

  const porTipo = {};
  for (const tipo of CONTEUDO.inimigos) porTipo[tipo.id] = 0;
  let viuFilhote = false;
  let orbesPico = 0;

  for (let tick = 1; tick <= TICKS_MISTURADO; tick += 1) {
    botCircular(estado, tick);
    estado.player.hp = estado.player.hpMax; // mede composicao e orbes, nao sobrevivencia
    try {
      atualizar(estado, PASSO);
    } catch (e) {
      falhar(tick, `excecao na corrida com composicao misturada: ${e && e.stack ? e.stack : e}`);
    }
    if (estado.tela === TELAS.CARTA) escolherCarta(estado, 0);
    if (estado.xpOrbs.length > orbesPico) orbesPico = estado.xpOrbs.length;
    for (const evento of estado.eventos) {
      if (evento.tipo === 'inimigo-nasceu' && porTipo[evento.dados.tipo] !== undefined) {
        porTipo[evento.dados.tipo] += 1;
      }
    }
    estado.eventos.length = 0;
    if (!viuFilhote) {
      for (const inimigo of estado.enemies) {
        if (inimigo.geracao > 0) {
          viuFilhote = true;
          break;
        }
      }
    }
  }

  for (const tipo of CONTEUDO.inimigos) {
    if (porTipo[tipo.id] === 0) {
      falhar(
        TICKS_MISTURADO,
        `composicao misturada: ${tipo.emoji} ${tipo.id} nunca nasceu em ${(TICKS_MISTURADO * PASSO).toFixed(0)}s ` +
          "com composicaoSpawn 'todos' — peso 0 na composicao, ou o sorteio esta excluindo o tipo"
      );
    }
  }
  if (!viuFilhote) {
    falhar(TICKS_MISTURADO, "composicao misturada: nenhum filhote (geracao > 0) apareceu — a divisao natural nao rodou");
  }

  const pool = poolOrbes(estado);
  return { porTipo, orbesPico, capacidadeOrbes: pool.capacidade, reciclados: pool.reciclados };
}

// O maior `nasc` vivo de um tipo agora — usado por checarRajadaIsolada() para
// achar, depois de um tick com N nascimentos, EXATAMENTE quais objetos da
// pool sao os recem-nascidos (nasc > este valor capturado ANTES do tick), sem
// precisar mudar o payload do evento 'inimigo-nasceu' so para um teste.
function maiorNascDoTipo(estado, tipoId) {
  let maior = 0;
  for (const e of poolInimigos(estado).ativos) {
    if (e.tipo === tipoId && e.nasc > maior) maior = e.nasc;
  }
  return maior;
}

// Tarefa 1 do contrato, isolada de verdade: com a onda NORMAL desligada
// (porOnda=0 na curva inteira, temporariamente), o unico jeito de alguem
// nascer e o relogio proprio da rajada. Testar dentro da corrida normal
// (como uma 1ª versao deste teste fez) nao discrimina nada: com porOnda ate
// 8 e vários tipos concorrendo, o sorteio sozinho as vezes acerta 4
// Notificacoes na MESMA onda por pura sorte — visto acontecendo mesmo com a
// rajada mutada pra nascer 1 de cada vez. Isolar a onda normal e a unica
// forma barata de provar que e o RELOGIO da rajada, nao a sorte do sorteio.
//
// Correcao pos-revisao (item 5): "nascer no mesmo tick" nao prova que o grupo
// esta AGRUPADO NO ESPACO — antes desta correcao, cada spawnInimigo() dentro
// da rajada sorteava o lado da borda de nOvo, e uma rajada de 4 podia cair em
// 3 lados diferentes da arena (medido pelo revisor). Por isso, alem de contar
// "4 no mesmo tick", este teste acha os objetos recem-nascidos NAQUELE tick
// (via `nasc`, que so cresce) e mede a maior distancia entre pares — tem que
// caber no espalhamento configurado (rajada.espalhamento, content.js), nao no
// tamanho da arena inteira.
function checarRajadaIsolada() {
  const tipo = CONTEUDO.inimigos.find((t) => t.rajada);
  if (!tipo) falhar(0, 'rajada: nenhum inimigo com `rajada` em content.js — a tarefa 1 da fase 09 nao foi feita');

  const estado = novoEstado(SEMENTE + 508);
  comecarAvaliacao(estado, 1, 0); // p2-av1: composicaoSpawn 'todos', o tipo esta nela
  limparInimigos(estado);

  const curva = CONTEUDO.spawn.curvas[CONTEUDO.spawn.curvaPadrao];
  const porOndaOriginal = curva.map((p) => p.porOnda);
  for (const ponto of curva) ponto.porOnda = 0;

  let maiorNoMesmoTick = 0;
  let totalNascido = 0;
  let maiorDistanciaNoGrupo = -1;
  let tickDoGrupoMedido = -1;
  const ticksDeSobra = Math.ceil((tipo.rajada.intervalo + 2) * 60); // 1 rajada completa + folga
  try {
    for (let tick = 1; tick <= ticksDeSobra; tick += 1) {
      estado.player.hp = estado.player.hpMax;
      const nascAntes = maiorNascDoTipo(estado, tipo.id);
      atualizarInimigos(estado, PASSO);
      let nesteTick = 0;
      for (const evento of estado.eventos) {
        if (evento.tipo === 'inimigo-nasceu') {
          if (evento.dados.tipo !== tipo.id) {
            falhar(tick, `rajada: com a onda normal desligada, nasceu "${evento.dados.tipo}" — so a rajada podia nascer alguem`);
          }
          nesteTick += 1;
        }
      }
      estado.eventos.length = 0;
      if (nesteTick > maiorNoMesmoTick) maiorNoMesmoTick = nesteTick;
      totalNascido += nesteTick;

      if (nesteTick === tipo.rajada.tamanho && tickDoGrupoMedido === -1) {
        const membros = poolInimigos(estado).ativos.filter((e) => e.tipo === tipo.id && e.nasc > nascAntes);
        if (membros.length === tipo.rajada.tamanho) {
          let maxDist = 0;
          for (let a = 0; a < membros.length; a += 1) {
            for (let b = a + 1; b < membros.length; b += 1) {
              const d = Math.hypot(membros[a].x - membros[b].x, membros[a].y - membros[b].y);
              if (d > maxDist) maxDist = d;
            }
          }
          maiorDistanciaNoGrupo = maxDist;
          tickDoGrupoMedido = tick;
        }
      }
    }
  } finally {
    curva.forEach((ponto, i) => { ponto.porOnda = porOndaOriginal[i]; });
  }

  if (maiorNoMesmoTick !== tipo.rajada.tamanho) {
    falhar(
      0,
      `rajada: com a onda normal desligada, o maior numero de ${tipo.id} nascidos NO MESMO tick foi ` +
        `${maiorNoMesmoTick}, esperava exatamente ${tipo.rajada.tamanho} (rajada.tamanho)`
    );
  }
  if (totalNascido < tipo.rajada.tamanho) {
    falhar(0, `rajada: 0 nascimentos de ${tipo.id} com a onda normal desligada em ${(ticksDeSobra * PASSO).toFixed(1)}s — o relogio da rajada nao disparou`);
  }
  if (tickDoGrupoMedido === -1) {
    falhar(0, `rajada: nunca consegui isolar os ${tipo.rajada.tamanho} nascidos de um UNICO grupo pelo \`nasc\` — nao deu pra medir o agrupamento espacial`);
  }
  const espalhamento = tipo.rajada.espalhamento || 0;
  const limiteEspacial = 2 * espalhamento + 1; // +1px de folga de ponto flutuante
  if (maiorDistanciaNoGrupo > limiteEspacial) {
    falhar(
      0,
      `rajada: os ${tipo.rajada.tamanho} nascidos juntos (tick ${tickDoGrupoMedido}) ficaram a ate ` +
        `${maiorDistanciaNoGrupo.toFixed(1)}px um do outro, esperava no maximo ${limiteEspacial}px ` +
        `(2 x rajada.espalhamento=${espalhamento}) — o grupo nao esta agrupado na borda, cada um nasceu num lado`
    );
  }

  return (
    `${tipo.emoji} ${tipo.id}: com a onda normal desligada, a rajada sozinha nasceu ${maiorNoMesmoTick} de uma vez ` +
    `a cada ~${tipo.rajada.intervalo}s (tamanho=${tipo.rajada.tamanho}), ate ${maiorDistanciaNoGrupo.toFixed(1)}px ` +
    `de distancia entre pares do grupo (espalhamento=${espalhamento})`
  );
}

// Correcao pos-revisao (item 4): prova que `ruido.frequencia` e Hz DE
// VERDADE, nao so que existe. Jogador MUITO longe, na mesma linha horizontal
// (mesmo truque de checarSeparacaoEntreTamanhos): a perseguicao vira quase
// uma reta (angulo base ~0 o tempo inteiro, a curvatura de perseguir muda
// menos de um milesimo de grau em px de movimento), entao o angulo medido do
// vetor de movimento (atan2(e.vy, e.vx)) fica praticamente IGUAL ao desvio
// senoidal sozinho — sem outro inimigo por perto, calcularSeparacao() nao
// contribui nada a e.vx/e.vy. Mede-se o PERIODO desse desvio pelos
// cruzamentos de zero e compara-se com 1/frequencia (Hz -> segundos): falha
// com uma Notificacao "reta" (0 ou poucos cruzamentos: sem oscilacao pra
// medir) e falha se a frequencia voltar a ser lida como rad/s (o periodo sai
// ~6,3x maior que o esperado).
function checarRuidoNotificacao() {
  const tipo = CONTEUDO.inimigos.find((t) => t.ruido);
  if (!tipo) falhar(0, 'ruido da notificacao: nenhum inimigo com `ruido` em content.js — a tarefa 1 (ruido) da fase 09 nao foi feita');

  const estado = novoEstado(SEMENTE + 509);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  const e = spawnInimigo(estado, tipo.id);
  if (!e) falhar(0, 'ruido da notificacao: spawnInimigo devolveu null');

  const px = 480;
  const py = 270;
  e.x = px;
  e.y = py;
  estado.player.x = px + 200000;
  estado.player.y = py;

  const DURACAO = 6; // s — muitos periodos com o bug corrigido (~0,71s cada), poucos com rad/s (~4,49s)
  const TICKS_RUIDO = Math.round(DURACAO / PASSO);
  const cruzamentos = [];
  let anguloAnterior = null;
  let tAnterior = 0;

  for (let tick = 1; tick <= TICKS_RUIDO; tick += 1) {
    // atualizarInimigos() nao avanca av.decorrido sozinho (quem faz isso e
    // atualizarAvaliacao, nao chamada aqui) — sem isto `tempoDeVida`
    // (av.decorrido - e.nascidoEm) ficaria travado em 0 pra sempre e o
    // desvio senoidal nunca oscilaria (mesmo truque de passoOrbital()).
    estado.run.avaliacao.decorrido += PASSO;
    atualizarInimigos(estado, PASSO);
    const t = tick * PASSO;
    const angulo = Math.atan2(e.vy, e.vx);
    if (anguloAnterior !== null && anguloAnterior * angulo < 0) {
      // Interpolacao linear simples do instante exato do cruzamento de zero.
      const fracao = Math.abs(anguloAnterior) / (Math.abs(anguloAnterior) + Math.abs(angulo));
      cruzamentos.push(tAnterior + (t - tAnterior) * fracao);
    }
    anguloAnterior = angulo;
    tAnterior = t;
  }

  if (cruzamentos.length < 2) {
    falhar(
      0,
      `ruido da notificacao: o angulo de movimento cruzou zero ${cruzamentos.length}x em ${DURACAO}s — esperava ` +
        'uma oscilacao senoidal (tipo.ruido); o desvio parece reto (amplitude 0 ou nao aplicado)'
    );
  }

  const espacamentos = [];
  for (let i = 1; i < cruzamentos.length; i += 1) espacamentos.push(cruzamentos[i] - cruzamentos[i - 1]);
  const mediaEspacamento = espacamentos.reduce((a, b) => a + b, 0) / espacamentos.length;
  const periodoMedido = mediaEspacamento * 2; // dois cruzamentos de zero por periodo completo

  const periodoEsperado = 1 / tipo.ruido.frequencia; // Hz -> segundos
  const TOLERANCIA = 0.25; // 25%: dt discreto, e a perseguicao nao e EXATAMENTE constante
  if (Math.abs(periodoMedido - periodoEsperado) > periodoEsperado * TOLERANCIA) {
    falhar(
      0,
      `ruido da notificacao: periodo medido do desvio foi ${periodoMedido.toFixed(3)}s, esperava ` +
        `~${periodoEsperado.toFixed(3)}s (1/frequencia, ${tipo.ruido.frequencia}Hz) — a frequencia esta sendo ` +
        'lida como rad/s, nao Hz?'
    );
  }

  return `${tipo.emoji} ${tipo.id}: periodo medido do desvio ${periodoMedido.toFixed(3)}s (esperado ~${periodoEsperado.toFixed(3)}s a ${tipo.ruido.frequencia}Hz)`;
}

// Pendencia 17 do ESTADO.md: "separacao nao tem trilho automatico" — com
// raios diferentes (o PDF e grande), confere que ela continua empurrando
// tipos de tamanhos diferentes, do MESMO jeito que o handoff 02 mediu para
// um tipo so ("com separacao, distancia minima 17,9px; com forca=0, 0,0px").
// Cenario controlado (nao a corrida normal, que tem perseguicao e ruido
// demais para isolar so a separacao): PDF e o menor tipo nascem no MESMO
// ponto, o jogador tambem fica ali (perseguicao vira vetor zero, so a
// separacao move os dois), e mede a distancia final com e sem
// separacao.forca. Barata: ~90 ticks, 2 inimigos, sem loop O(n^2) nenhum.
function checarSeparacaoEntreTamanhos() {
  const onde = 'separacao entre tamanhos diferentes';
  let grande = CONTEUDO.inimigos[0];
  let pequeno = CONTEUDO.inimigos[0];
  for (const tipo of CONTEUDO.inimigos) {
    if (tipo.raio > grande.raio) grande = tipo;
    if (tipo.raio < pequeno.raio) pequeno = tipo;
  }
  if (grande.raio === pequeno.raio) falhar(0, `${onde}: todos os tipos tem o mesmo raio — nada pra testar aqui`);

  function medir(forcaLigada) {
    const estado = novoEstado(SEMENTE + 506);
    iniciarAvaliacao(estado);
    limparInimigos(estado);
    const a = spawnInimigo(estado, grande.id);
    const b = spawnInimigo(estado, pequeno.id);
    const px = 480;
    const py = 270;
    a.x = px; a.y = py;
    b.x = px; b.y = py;
    // Mesma velocidade nos dois: os TIPOS tem velocidades diferentes de
    // proposito (design §8), e isso sozinho ja separaria os dois com
    // forca=0 (cada um anda pro jogador no seu proprio ritmo) — o que
    // contaminaria exatamente a comparacao que este teste quer isolar.
    a.velocidade = 100;
    b.velocidade = 100;
    // E o mesmo comportamento de movimento: o tipo mais pequeno pode ser o
    // 🔔 'errante' (ruido senoidal), que por si so ja desviaria os dois sem
    // precisar de separacao nenhuma. So a direcao 'perseguir' — reta —
    // isola exatamente o que este teste quer medir.
    a.comportamento = 'perseguir';
    b.comportamento = 'perseguir';
    // O jogador fica LONGE, na mesma direcao pros dois: a perseguicao vira um
    // arrasto quase paralelo (o angulo ate um jogador a 5000px muda menos de
    // 1° entre dois pontos dezenas de px afastados) que translada os dois
    // juntos sem mexer na distancia RELATIVA entre eles — so a separacao faz
    // isso. Grudar o jogador em cima deles (dist=0) so funcionaria no
    // primeiro tick: a partir do segundo, ja separados, a perseguicao
    // puxaria os dois de volta um pro outro e mascararia a medida.
    estado.player.x = px - 5000;
    estado.player.y = py;
    const forcaOriginal = CONTEUDO.separacao.forca;
    CONTEUDO.separacao.forca = forcaLigada ? forcaOriginal : 0;
    try {
      for (let i = 0; i < 90; i += 1) atualizarInimigos(estado, PASSO); // 1,5s
    } finally {
      CONTEUDO.separacao.forca = forcaOriginal;
    }
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  const com = medir(true);
  const sem = medir(false);
  const minima = grande.raio + pequeno.raio + CONTEUDO.separacao.folga;

  if (sem > 1) falhar(0, `${onde}: SEM separacao os dois se afastaram ${sem.toFixed(1)}px — algo alem da separacao esta empurrando`);
  if (!(com > sem + 1)) {
    falhar(0, `${onde}: com separacao a distancia final foi ${com.toFixed(1)}px, sem foi ${sem.toFixed(1)}px — a separacao nao esta empurrando tipos de tamanhos diferentes`);
  }
  // Metade da distancia minima e uma barra baixa de proposito (a mola e
  // suave, 1,5s pode nao bastar pra abrir a folga inteira) — o que importa e
  // que ELA AGE, nao que resolva 100% no prazo.
  if (com < minima * 0.5) {
    falhar(0, `${onde}: com separacao ligada, ${grande.id} e ${pequeno.id} (raios ${grande.raio}/${pequeno.raio}) ficaram a so ${com.toFixed(1)}px (esperava pelo menos ${(minima * 0.5).toFixed(1)}px) — separacao fraca demais entre tamanhos`);
  }

  return `${grande.emoji}${grande.raio} x ${pequeno.emoji}${pequeno.raio}: com separacao ${com.toFixed(1)}px, sem separacao ${sem.toFixed(1)}px (minimo p/ encostar ${minima}px)`;
}

// Pendencia 32 do ESTADO.md: com um inimigo que so morre num contato so
// (o Prazo, antes desta fase), o anel de cooldown por inimigo do orbital
// (CONTEUDO.orbital.memoriaAlvos) nunca via muitos alvos DISTINTOS vivos ao
// mesmo tempo — o pico medido na fase 05 era 5 de 160 slots. O PDF (tanque,
// muito HP) e o primeiro inimigo que pode empilhar de verdade sob fogo
// continuo. Enche a arena de PDFs de verdade (nao sinteticos) com a Caneta
// Bic no nivel maximo e mede o pico real de entradas vivas no anel.
const TICKS_ORBITAL_PDF = 3600; // 60s
function medirPicoOrbitalComPdf() {
  const estado = novoEstado(SEMENTE + 504);
  iniciarAvaliacao(estado);
  limparInimigos(estado);
  const arma = equiparArma(estado, 'caneta');
  const dados = dadosDaArma('caneta');
  arma.nivel = dados.niveis.length;

  const maxOriginal = CONTEUDO.spawn.maxSimultaneos;
  CONTEUDO.spawn.maxSimultaneos = CONTEUDO.arena.limites.enemies; // nao deixa o teto de jogabilidade limitar a medida
  let pico = 0;
  try {
    for (let tick = 1; tick <= TICKS_ORBITAL_PDF; tick += 1) {
      botCircular(estado, tick);
      estado.player.hp = estado.player.hpMax;
      while (estado.enemies.length < CONTEUDO.arena.limites.enemies) {
        if (!spawnInimigo(estado, 'pdf')) break;
      }
      try {
        atualizar(estado, PASSO);
      } catch (e) {
        falhar(tick, `excecao medindo o pico orbital com PDF: ${e && e.stack ? e.stack : e}`);
      }
      if (estado.tela === TELAS.CARTA) escolherCarta(estado, 0);

      const golpes = arma.golpes;
      if (golpes) {
        const agora = estado.run.avaliacao.decorrido;
        let vivos = 0;
        for (const item of golpes.itens) if (item.expiraEm > agora) vivos += 1;
        if (vivos > pico) pico = vivos;
      }
    }
  } finally {
    CONTEUDO.spawn.maxSimultaneos = maxOriginal;
  }

  if (pico >= CONTEUDO.orbital.memoriaAlvos) {
    falhar(
      TICKS_ORBITAL_PDF,
      `pico orbital com PDF: ${pico} entradas vivas simultaneas >= memoriaAlvos (${CONTEUDO.orbital.memoriaAlvos}) — ` +
        'o anel de cooldown pode estourar em jogo real agora que existe inimigo tanque'
    );
  }
  return { pico, capacidade: CONTEUDO.orbital.memoriaAlvos };
}

// Arma e dado: a entrada de content.js so vira tiro se `comportamento` apontar
// para uma funcao registrada em weapons.js. Sem esta checagem, uma arma nova
// (fase 05) so explodiria no instante do primeiro disparo, dentro do update.
function checarArmasDoConteudo() {
  const problema = verificarArmasDoConteudo();
  if (problema) falhar(0, problema);
}

// Os numeros de cada nivel precisam sair de content.js e o nivel precisa ficar
// grampeado na faixa: nivel fora do array viraria `undefined` dentro do update
// e o projetil sairia com NaN em tudo.
function checarNiveisDaArma() {
  const estado = novoEstado(SEMENTE + 2);
  const id = CONTEUDO.arma.inicial;
  const dados = dadosDaArma(id);
  const arma = equiparArma(estado, id);

  if (!arma) falhar(0, `equiparArma("${id}") devolveu null: a arma inicial nao existe em content.js`);
  if (arma.nivel !== 1 || arma.cooldown !== 0) {
    falhar(0, `arma equipada veio com nivel=${arma.nivel} cooldown=${arma.cooldown}, esperava 1 e 0`);
  }
  if (estado.player.armas.length !== 1) falhar(0, 'equiparArma nao pos a instancia em player.armas');
  if (equiparArma(estado, id) !== arma) falhar(0, 'equiparArma duplicou uma arma que o jogador ja tinha');
  if (nivelDaArma(arma) !== dados.niveis[0]) falhar(0, 'nivel 1 nao esta lendo niveis[0] de content.js');

  let subidas = 0;
  while (subirNivelArma(estado, id)) {
    subidas += 1;
    if (subidas > 50) falhar(0, 'subirNivelArma nunca devolve false: o nivel maximo nao segura');
  }
  if (arma.nivel !== dados.niveis.length) {
    falhar(0, `arma parou no nivel ${arma.nivel}, content.js tem ${dados.niveis.length} niveis`);
  }
  if (nivelDaArma(arma) !== dados.niveis[dados.niveis.length - 1]) {
    falhar(0, 'nivel maximo nao esta lendo o ultimo objeto de niveis');
  }

  arma.nivel = dados.niveis.length + 99; // nivel impossivel, vindo de um bug futuro
  if (nivelDaArma(arma) !== dados.niveis[dados.niveis.length - 1]) {
    falhar(0, 'nivel fora da faixa nao foi grampeado: o update leria undefined');
  }
}

// Bot PARADO no centro, spawn ligado: e a corrida que prova que a arma mata
// sozinha. Na corrida principal o bot anda em circulo e foge, o que embaralha
// "a arma funciona" com "o jogador escapou".
//
// Teto de projeteis vivos calculado a partir dos proprios dados da arma
// (quantos cabem dentro de um tempo de voo): se algum projetil deixar de voltar
// a pool, o pico estoura este teto em poucos segundos. Sai de content.js de
// proposito — a fase 05 muda os numeros e a assercao se ajusta sozinha.
function tetoDeProjeteisVivos(nivel) {
  const voo = Math.min(CONTEUDO.projetil.vidaMaxima, nivel.alcance / nivel.velocidade);
  return (Math.ceil(voo / nivel.cadencia) + 1) * nivel.projeteis;
}

function checarArmaSozinha() {
  const estado = novoEstado(SEMENTE + 1);
  comecarAvaliacao(estado);

  let pico = 0;
  let mortos = 0;
  let disparos = 0;
  let acertos = 0;

  for (let tick = 1; tick <= TICKS_ARMA; tick += 1) {
    estado.input.eixoX = 0;
    estado.input.eixoY = 0;
    // O que se mede aqui e a arma, nao a sobrevivencia: o jogador toma dano
    // mas nao cai, senao a corrida terminaria no meio.
    estado.player.hp = estado.player.hpMax;
    try {
      atualizar(estado, PASSO);
    } catch (e) {
      falhar(tick, `excecao com o bot parado: ${e && e.stack ? e.stack : e}`);
    }
    // Parado no centro ele coleta muito XP e sobe de nivel rapido: sem
    // escolher a carta, esta corrida congelaria e mediria a arma por 3s.
    escolherCarta(estado, 0);

    if (estado.projectiles.length > pico) pico = estado.projectiles.length;
    // Filtrado pela arma inicial (Café): com 4 armas em content.js o bot
    // parado tambem sobe de nivel rapido e pode pegar outra arma na carta
    // (sempre aceita a opcao 0). 'arma-disparo'/'arma-acerto' carregam o id de
    // quem disparou/acertou — sem o filtro, um pulso do Resumo (que tambem
    // emite 'arma-disparo') infla `disparos` sem nascer projetil nenhum na
    // pool, e a conta contra pool.nascimentos abaixo quebra por um motivo que
    // nao tem nada a ver com o Café.
    for (const evento of estado.eventos) {
      if (evento.tipo === 'arma-disparo' && evento.dados.arma === CONTEUDO.arma.inicial) disparos += 1;
      if (evento.tipo === 'arma-acerto' && evento.dados.arma === CONTEUDO.arma.inicial) {
        acertos += 1;
        if (evento.dados.matou) mortos += 1;
      }
    }
    estado.eventos.length = 0;
  }

  const pool = poolProjeteis(estado);

  if (estado.player.armas.length === 0) {
    falhar(TICKS_ARMA, 'o jogador terminou a avaliacao sem arma nenhuma: atualizarArmas() roda no update?');
  }
  if (disparos === 0) falhar(TICKS_ARMA, 'a arma nao disparou nenhuma vez com o bot parado no centro');
  const teto = tetoDeProjeteisVivos(nivelDaArma(estado.player.armas[0]));

  if (acertos === 0) falhar(TICKS_ARMA, `${disparos} disparos e nenhum acerto: a colisao do projetil roda?`);
  if (mortos < MINIMO_MORTOS_ARMA) {
    falhar(TICKS_ARMA, `a arma matou ${mortos} inimigos em ${TICKS_ARMA} ticks (minimo ${MINIMO_MORTOS_ARMA})`);
  }
  if (pico > teto) {
    falhar(TICKS_ARMA, `pico de ${pico} projeteis vivos, teto calculado e ${teto}: algum projetil nao volta a pool`);
  }
  if (pool.nascimentos < disparos) {
    falhar(TICKS_ARMA, `${disparos} disparos mas so ${pool.nascimentos} projeteis nasceram da pool`);
  }
  if (pool.criados !== pool.capacidade) {
    falhar(TICKS_ARMA, `pool de projeteis fabricou ${pool.criados} objetos para capacidade ${pool.capacidade}`);
  }
  const problema = pool.verificar();
  if (problema) falhar(TICKS_ARMA, `pool de projeteis inconsistente: ${problema}`);

  // Drenagem: sem inimigo nenhum a arma nao tem alvo, entao so os projeteis em
  // voo continuam andando. Depois do tempo maximo de voo a pool tem que estar
  // vazia — se sobrar um, ele e imortal. Aqui se chama atualizarArmas direto,
  // sem atualizar(), justamente para que ninguem nasca durante a drenagem.
  limparInimigos(estado);
  const ticksDrenagem = Math.ceil(CONTEUDO.projetil.vidaMaxima / PASSO) + 60;
  for (let i = 0; i < ticksDrenagem; i += 1) atualizarArmas(estado, PASSO);
  if (estado.projectiles.length !== 0) {
    falhar(
      TICKS_ARMA + ticksDrenagem,
      `${estado.projectiles.length} projeteis continuam vivos ${ticksDrenagem} ticks depois do ultimo alvo`
    );
  }

  return { pico, mortos, disparos, acertos, teto };
}

// A armadilha desta fase. Um inimigo morto volta para a reserva da pool e o
// proximo spawn pode reaproveitar O MESMO objeto — outra vida no mesmo slot.
// Um projetil perfurante lembra quem ja atingiu para nao bater duas vezes no
// mesmo inimigo; se essa lembranca guardar so a referencia, o inimigo novo
// herda a imunidade do morto e fica intocavel para aquele projetil. O par
// (ref, nasc) e o que separa as duas vidas.
//
// O cenario e montado a mao porque so acontece na ordem exata: alvo morre,
// pool recicla o objeto, o mesmo projetil (ainda com perfuracao) alcanca o
// inimigo novo.
const DIST_ALVO = 60; // px do jogador ate o primeiro alvo
const DIST_RECICLADO = 200; // px do jogador ate o inimigo que reusa o objeto

function checarGuardaDeGeracao() {
  const estado = novoEstado(SEMENTE + 3);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  const player = estado.player;
  player.x = CONTEUDO.arena.largura / 2;
  player.y = CONTEUDO.arena.altura / 2;

  const arma = equiparArma(estado, CONTEUDO.arma.inicial);
  const dados = dadosDaArma(arma.id);
  // Precisa de um nivel de UM projetil so (senao o vizinho do leque acerta o
  // reciclado e o teste passa sem provar nada) e com perfuracao (senao o
  // projetil morre no primeiro alvo e nunca chega ao segundo).
  const indice = dados.niveis.findIndex((n) => n.projeteis === 1 && n.perfuracao >= 1);
  if (indice < 0) {
    falhar(0, 'nenhum nivel da arma inicial tem 1 projetil com perfuracao: aponte este teste para outra arma');
  }
  arma.nivel = indice + 1;
  const nivel = nivelDaArma(arma);
  if (nivel.alcance < DIST_RECICLADO + 40) {
    falhar(0, `alcance ${nivel.alcance} curto demais para o cenario (precisa de ${DIST_RECICLADO + 40})`);
  }

  const alvo = spawnInimigo(estado);
  if (!alvo) falhar(0, 'spawnInimigo devolveu null montando o cenario da guarda de geracao');
  alvo.x = player.x + DIST_ALVO;
  alvo.y = player.y;

  // So a primeira salva interessa: uma segunda acertaria o inimigo reciclado
  // sem memoria nenhuma e esconderia o bug.
  const passo = () => {
    atualizarArmas(estado, PASSO);
    arma.cooldown = 999;
  };

  let passos = 0;
  while (alvo.ativo && passos < 120) {
    passo();
    passos += 1;
  }
  if (alvo.ativo) falhar(0, `o projetil nao matou o alvo a ${DIST_ALVO}px em 120 ticks`);

  const reciclado = spawnInimigo(estado);
  if (reciclado !== alvo) {
    falhar(0, 'a pool nao reaproveitou o objeto do inimigo morto: este teste depende disso para ter sentido');
  }
  reciclado.x = player.x + DIST_RECICLADO;
  reciclado.y = player.y;
  const hpAntes = reciclado.hp;

  passos = 0;
  while (reciclado.ativo && reciclado.hp === hpAntes && passos < 120) {
    passo();
    passos += 1;
  }
  if (reciclado.ativo && reciclado.hp === hpAntes) {
    falhar(
      0,
      'o inimigo que reusou o objeto do morto nao levou dano nenhum: a memoria do projetil ' +
        'esta comparando so a referencia, sem o `nasc` — guarda de geracao quebrada'
    );
  }
}

// A outra metade da memoria de perfuracao. `checarGuardaDeGeracao()` prova que
// o `nasc` separa duas vidas no mesmo objeto, mas passa igual com a memoria
// inteira desligada — um projetil sem memoria nenhuma tambem acerta o inimigo
// reciclado. Aqui se prova que a memoria EXISTE, nas duas pontas:
//
//   1a salva  um projetil perfurante fica ~5 quadros dentro do raio de colisao
//             de um alvo parado. Sem `jaAtingiu`, ele rebate no mesmo inimigo a
//             cada quadro ate gastar a perfuracao: 2 acertos em vez de 1.
//   2a salva  o mesmo objeto da pool e reaproveitado. Sem `esquecerAtingidos`,
//             ele ainda lembra do alvo da salva anterior — que continua vivo,
//             com o mesmo `nasc` — e atravessa sem dano: 0 acertos em vez de 1.
//
// O alvo e imortal de proposito: o que se conta aqui e acerto, nao morte.
const DIST_IMORTAL = 120; // px do jogador ate o alvo parado
const HP_IMORTAL = 1e6; // hp alto o bastante para o alvo nunca sair da arena
const TICKS_SALVA = 240; // teto de ticks que uma salva tem para ir e voltar

function salvaUnica(estado, arma) {
  arma.cooldown = 0;
  let acertos = 0;
  let objeto = null;
  let passos = 0;
  do {
    atualizarArmas(estado, PASSO);
    arma.cooldown = 999; // trava a arma: uma salva por vez, sem reforco
    if (!objeto && estado.projectiles.length > 0) objeto = estado.projectiles[0];
    for (const evento of estado.eventos) if (evento.tipo === 'arma-acerto') acertos += 1;
    estado.eventos.length = 0;
    passos += 1;
  } while (estado.projectiles.length > 0 && passos < TICKS_SALVA);
  return { acertos, objeto };
}

function checarMemoriaDePerfuracao() {
  const estado = novoEstado(SEMENTE + 4);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  const player = estado.player;
  player.x = CONTEUDO.arena.largura / 2;
  player.y = CONTEUDO.arena.altura / 2;

  const arma = equiparArma(estado, CONTEUDO.arma.inicial);
  const dados = dadosDaArma(arma.id);
  const indice = dados.niveis.findIndex((n) => n.projeteis === 1 && n.perfuracao >= 1);
  if (indice < 0) {
    falhar(0, 'nenhum nivel da arma inicial tem 1 projetil com perfuracao: aponte este teste para outra arma');
  }
  arma.nivel = indice + 1;
  if (nivelDaArma(arma).alcance < DIST_IMORTAL + 40) {
    falhar(0, `alcance ${nivelDaArma(arma).alcance} curto demais para o alvo a ${DIST_IMORTAL}px`);
  }

  const alvo = spawnInimigo(estado);
  if (!alvo) falhar(0, 'spawnInimigo devolveu null montando o alvo imortal');
  alvo.x = player.x + DIST_IMORTAL;
  alvo.y = player.y;
  alvo.hpMax = HP_IMORTAL;
  alvo.hp = HP_IMORTAL;

  const primeira = salvaUnica(estado, arma);
  const segunda = salvaUnica(estado, arma);

  if (!primeira.objeto || !segunda.objeto) falhar(0, 'a arma nao disparou contra o alvo parado');
  if (primeira.objeto !== segunda.objeto) {
    falhar(0, 'a pool nao reaproveitou o mesmo projetil nas duas salvas: este teste depende disso');
  }
  if (primeira.acertos !== 1) {
    falhar(
      0,
      `a primeira salva acertou ${primeira.acertos}x o mesmo inimigo parado (esperava 1): ` +
        'o projetil perfurante esta rebatendo quadro a quadro — jaAtingiu() nao esta filtrando'
    );
  }
  if (segunda.acertos !== 1) {
    falhar(
      0,
      `a segunda salva acertou ${segunda.acertos}x o mesmo inimigo (esperava 1): ` +
        'o projetil reciclado ainda carrega a memoria da salva anterior — falta esquecerAtingidos() no disparo'
    );
  }
}

// ------------------------------------------------------- orbital (Caneta Bic)
//
// orbital guarda estado entre quadros (arma.golpes com o par ref+nasc, e
// arma.angulo) do mesmo jeito que o projetil perfurante guarda `atingidos` —
// a mesma armadilha da fase 03, so que aqui o "ja atingiu" tem que EXPIRAR
// sozinho (intervaloDano) em vez de durar o voo inteiro. As duas funcoes
// abaixo cobrem as duas pontas, no mesmo espirito de checarGuardaDeGeracao()
// e checarMemoriaDePerfuracao() para o projetil.
//
// Chama-se atualizarArmas() direto (sem atualizar()) para isolar a arma —
// mas isso pula atualizarAvaliacao(), que e quem avanca
// run.avaliacao.decorrido. orbital usa decorrido para o cooldown por inimigo,
// entao o teste precisa avancar esse relogio manualmente, senao o cooldown
// nunca expira (decorrido ficaria travado em 0 para sempre).
function passoOrbital(estado, dt) {
  estado.run.avaliacao.decorrido += dt;
  atualizarArmas(estado, dt);
}

function prepararCenarioOrbital(seedOffset) {
  const estado = novoEstado(seedOffset);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  const player = estado.player;
  player.x = CONTEUDO.arena.largura / 2;
  player.y = CONTEUDO.arena.altura / 2;

  const arma = equiparArma(estado, 'caneta');
  if (!arma) falhar(0, 'equiparArma("caneta") falhou montando o cenario orbital: a arma ainda existe em content.js?');
  const dados = dadosDaArma('caneta');
  // Precisa de 1 caneta so (senao a segunda passa em outro angulo e acerta o
  // alvo num instante diferente, embaralhando a contagem esperada) — mesmo
  // espirito do `findIndex` de checarGuardaDeGeracao() para o leque de
  // projeteis: procura o nivel certo em vez de supor que e sempre o 1.
  const indice = dados.niveis.findIndex((n) => n.quantidade === 1);
  if (indice < 0) {
    falhar(0, 'nenhum nivel da Caneta Bic tem 1 caneta orbitando: ajuste este teste para outro nivel/arma');
  }
  arma.nivel = indice + 1;
  const nivel = nivelDaArma(arma);
  return { estado, player, arma, dados, nivel };
}

// A mesma guarda de geracao dos projeteis (ref+nasc), aqui para o cooldown por
// inimigo do orbital: mata o alvo no primeiro passe (a caneta gira e da uma
// tacada rapida nele), deixa a pool reciclar o MESMO objeto para o proximo
// inimigo (LIFO) e reposiciona-o exatamente onde a caneta esta agora. Sem o
// `nasc`, o inimigo novo herdaria o cooldown do morto e sairia ileso.
function checarGuardaDeGeracaoOrbital() {
  const { estado, player, arma, nivel } = prepararCenarioOrbital(SEMENTE + 10);

  const alvo = spawnInimigo(estado);
  if (!alvo) falhar(0, 'spawnInimigo devolveu null montando o cenario orbital');
  alvo.x = player.x + nivel.raioOrbita;
  alvo.y = player.y;
  alvo.hpMax = 1;
  alvo.hp = 1; // um toque da caneta (dano bem maior que 1) mata na hora

  let passos = 0;
  while (alvo.ativo && passos < 60) {
    passoOrbital(estado, PASSO);
    passos += 1;
  }
  if (alvo.ativo) falhar(0, 'a caneta orbital nao matou o alvo no primeiro passe em 60 ticks (1s)');

  const reciclado = spawnInimigo(estado);
  if (reciclado !== alvo) {
    falhar(0, 'a pool nao reaproveitou o objeto do inimigo morto: este teste depende disso para ter sentido');
  }
  // A caneta nao para de girar so porque matou alguem: reposiciona no ponto
  // EXATO onde ela esta agora para o contato ser imediato no proximo quadro.
  const pos = posicaoSatelite(player, arma, nivel, 0);
  reciclado.x = pos.x;
  reciclado.y = pos.y;
  reciclado.hpMax = 1;
  reciclado.hp = 1;

  passos = 0;
  while (reciclado.ativo && passos < 10) {
    passoOrbital(estado, PASSO);
    passos += 1;
  }
  if (reciclado.ativo) {
    falhar(
      0,
      'o inimigo que reusou o objeto do morto nao levou dano nenhum da caneta orbital: a memoria de cooldown ' +
        'esta comparando so a referencia, sem o `nasc` — guarda de geracao quebrada'
    );
  }
}

// Correcao pos-revisao (item 2): pool.liberar() e LIFO (reserva.push no
// liberar, reserva.pop no obter seguinte) — como dividirSeAplicavel() chama
// pool.obter() logo DEPOIS de pool.liberar(pai) (enemies.js, aplicarDano), o
// PRIMEIRO filhote reaproveita o MESMO objeto do pai, so que com um `nasc`
// novo. Referencias externas ao pai sobrevivem a divisao (arma.golpes da
// Caneta, p.atingidos do perfurante) — este teste prova que elas NAO tratam
// o filhote como o mesmo alvo: se `emCooldown()` comparasse so a referencia
// (sem o `nasc`), o filhote nasceria imune ao proximo golpe da caneta so por
// ter herdado o objeto do pai, que ela acabara de atingir.
function checarFilhoteNaoHerdaImunidadeDeGolpe() {
  const tipoDivisao = CONTEUDO.inimigos.find((t) => t.divisao);
  if (!tipoDivisao) falhar(0, 'filhote e imunidade de golpe: nenhum inimigo com `divisao` em content.js');

  const { estado, player, arma, nivel } = prepararCenarioOrbital(SEMENTE + 511);

  const pai = spawnInimigo(estado, tipoDivisao.id);
  if (!pai) falhar(0, 'filhote e imunidade de golpe: spawnInimigo devolveu null montando o pai');
  const posPai = posicaoSatelite(player, arma, nivel, 0);
  pai.x = posPai.x;
  pai.y = posPai.y;
  pai.hpMax = nivel.dano * 1000; // sobrevive de proposito ao primeiro golpe
  pai.hp = pai.hpMax;

  // Um golpe da caneta: entra em arma.golpes (ref=pai, nasc=pai.nasc,
  // expiraEm no futuro) sem matar.
  let golpeouPai = false;
  for (let passos = 0; passos < 20 && !golpeouPai; passos += 1) {
    passoOrbital(estado, PASSO);
    for (const evento of estado.eventos) if (evento.tipo === 'arma-acerto') golpeouPai = true;
    estado.eventos.length = 0;
  }
  if (!golpeouPai || !(pai.hp < pai.hpMax)) {
    falhar(0, 'filhote e imunidade de golpe: a caneta nao acertou o pai em 20 ticks — cenario mal montado');
  }
  const nascDoPai = pai.nasc;

  // Mata o pai pela porta de sempre (aplicarDano), direto — nao precisa de
  // mais um golpe da caneta pra disparar a divisao.
  aplicarDano(estado, pai, pai.hp);

  const filhotes = poolInimigos(estado).ativos.filter((x) => x.tipo === tipoDivisao.id && x.geracao === 1);
  if (filhotes.length === 0) falhar(0, 'filhote e imunidade de golpe: matar o pai nao produziu filhote nenhum');
  const filhote = filhotes[0];
  if (filhote !== pai) {
    falhar(
      0,
      'filhote e imunidade de golpe: o primeiro filhote NAO reaproveitou o objeto do pai (a pool deixou de ser ' +
        'LIFO?) — este teste depende desse reaproveitamento pra provar o que se propoe'
    );
  }
  if (filhote.nasc === nascDoPai) {
    falhar(
      0,
      `filhote e imunidade de golpe: o filhote reaproveitou o objeto do pai com o MESMO nasc (${nascDoPai}) — ` +
        'pool.obter() nao renovou o `nasc`'
    );
  }

  // Reposiciona o filhote exatamente onde a caneta esta AGORA: se
  // emCooldown() comparasse so a referencia (sem o nasc), acharia a entrada
  // ANTIGA do pai (mesmo `ref`, expiraEm no futuro) e o filhote atravessaria
  // ileso.
  const posAgora = posicaoSatelite(player, arma, nivel, 0);
  filhote.x = posAgora.x;
  filhote.y = posAgora.y;
  filhote.hpMax = nivel.dano * 1000;
  filhote.hp = filhote.hpMax;

  let golpeouFilhote = false;
  for (let passos = 0; passos < 20 && !golpeouFilhote; passos += 1) {
    passoOrbital(estado, PASSO);
    for (const evento of estado.eventos) if (evento.tipo === 'arma-acerto') golpeouFilhote = true;
    estado.eventos.length = 0;
  }
  if (!golpeouFilhote || !(filhote.hp < filhote.hpMax)) {
    falhar(
      0,
      'filhote e imunidade de golpe: o filhote que reaproveitou o objeto do pai NAO foi atingido pela caneta em ' +
        '20 ticks — emCooldown() esta comparando so a referencia, sem o `nasc` (o filhote herdou a imunidade do pai)'
    );
  }

  return `${tipoDivisao.emoji} ${tipoDivisao.id}: o 1o filhote reusa o objeto do pai (nasc ${nascDoPai}→${filhote.nasc}) e ainda assim leva o proximo golpe da caneta`;
}

// O cooldown por inimigo em si: um alvo IMORTAL e parado no ponto de contato
// nunca pode ser atingido duas vezes com MENOS de nivel.intervaloDano de
// intervalo (a caneta fica varios quadros dentro do raio de colisao a cada
// passagem — sem o cooldown seria um acerto por quadro de contato), mas TEM
// que voltar a ser atingivel depois que o cooldown expira.
//
// Mede-se os TIMESTAMPS de cada acerto (em vez de contar "acertos por passe")
// de proposito: quanto o contato dura por passagem depende de
// raioColisao/velocidadeAngular/raioOrbita, e um numero fixo de "1 por passe"
// quebra sempre que a fase 13 (ou esta mesma fase, durante o balanceamento)
// mexer nesses numeros e o contato passar a durar mais que uma unica janela
// de cooldown — o que aconteceu de verdade ao tunar a Caneta Bic nesta fase.
// O invariante que realmente importa nao muda: nenhum par de acertos
// consecutivos pode ficar mais perto no tempo que intervaloDano.
function checarCooldownPorInimigoOrbital() {
  const { estado, player, dados, nivel } = prepararCenarioOrbital(SEMENTE + 11);

  const alvo = spawnInimigo(estado);
  if (!alvo) falhar(0, 'spawnInimigo devolveu null montando o alvo imortal do cenario orbital');
  alvo.x = player.x + nivel.raioOrbita;
  alvo.y = player.y;
  alvo.hpMax = 1e6;
  alvo.hp = 1e6;

  // Duas voltas completas de folga: tempo de sobra para o alvo ser atingido
  // de novo pelo menos uma vez depois do cooldown expirar.
  const periodoTicks = Math.ceil((Math.PI * 2) / nivel.velocidadeAngular / PASSO);
  const totalTicks = periodoTicks * 2 + 30;
  const timestamps = [];

  for (let i = 0; i < totalTicks; i += 1) {
    passoOrbital(estado, PASSO);
    for (const evento of estado.eventos) {
      if (evento.tipo === 'arma-acerto' && evento.dados.arma === dados.id) {
        timestamps.push(estado.run.avaliacao.decorrido);
      }
    }
    estado.eventos.length = 0;
  }

  if (timestamps.length < 2) {
    falhar(
      0,
      `a caneta acertou o alvo parado so ${timestamps.length}x em duas voltas completas (esperava 2+): ` +
        'o cooldown por inimigo nao esta liberando o alvo de novo depois de expirar'
    );
  }
  // Pequena folga de ponto flutuante: dt acumulado em soma nao bate exato com
  // o expiraEm calculado por multiplicacao.
  const FOLGA = 1e-9;
  for (let i = 1; i < timestamps.length; i += 1) {
    const intervalo = timestamps[i] - timestamps[i - 1];
    if (intervalo < nivel.intervaloDano - FOLGA) {
      falhar(
        0,
        `dois acertos na mesma caneta ficaram a ${intervalo.toFixed(4)}s um do outro, menos que ` +
          `nivel.intervaloDano (${nivel.intervaloDano}s): o cooldown por inimigo nao esta bloqueando — ` +
          'e o mesmo bug de "so lembra o slot mais antigo" que ja foi visto aqui'
      );
    }
  }
}

// checarCooldownPorInimigoOrbital() usa UM alvo so e nunca estoura o anel de
// memoria (CONTEUDO.orbital.memoriaAlvos) — o bug que ela cobre e de LOGICA
// (comparar so a referencia). Existe uma segunda forma do mesmo sintoma que
// so aparece com um ENXAME: se mais inimigos DISTINTOS forem atingidos
// dentro de uma janela de intervaloDano do que memoriaAlvos consegue
// lembrar ao mesmo tempo, o round-robin de lembrarGolpe() pode sobrescrever
// o slot de um inimigo cujo cooldown AINDA esta vivo — esse inimigo perde a
// protecao sem ter vencido o proprio intervaloDano. Usa o nivel MAXIMO da
// Caneta Bic (mais canetas girando, cooldown mais curto — o pior caso pra
// capacidade) e um numero de inimigos parados na propria orbita,
// deliberadamente maior que memoriaAlvos, pra tentar estourar o anel de
// verdade. Os eventos `arma-acerto` nao carregam qual inimigo foi atingido,
// mas os alvos sao IMORTAIS e PARADOS: casar pela posicao (x, y) exata do
// evento identifica o alvo sem ambiguidade.
function checarCooldownComEnxameOrbital() {
  const estado = novoEstado(SEMENTE + 13);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  const player = estado.player;
  player.x = CONTEUDO.arena.largura / 2;
  player.y = CONTEUDO.arena.altura / 2;

  const arma = equiparArma(estado, 'caneta');
  if (!arma) falhar(0, 'equiparArma("caneta") falhou montando o cenario de enxame orbital');
  const dados = dadosDaArma('caneta');
  arma.nivel = dados.niveis.length; // nivel maximo: mais canetas, intervaloDano mais curto
  const nivel = nivelDaArma(arma);

  // Acima de memoriaAlvos por uma MARGEM FIXA, nao um multiplo dela — um
  // multiplo (ex.: 3x) faria este teste nunca passar, nao importa quanto a
  // memoria cresca, porque o enxame cresceria junto. +8 basta pra forcar o
  // anel a reciclar slot (com N <= memoriaAlvos, todo inimigo acha sua
  // propria entrada de primeira e o codigo de reciclagem nunca roda — o
  // teste passaria sem testar nada). Visto falhando com o round-robin puro
  // (sem preferir slot vencido) e passando com o conserto — ver handoff.
  const N = CONTEUDO.orbital.memoriaAlvos + 8;
  const ultimoPorAlvo = new Map();
  for (let i = 0; i < N; i += 1) {
    const e = spawnInimigo(estado);
    if (!e) falhar(0, 'spawnInimigo devolveu null montando o enxame do cenario orbital');
    const angulo = (Math.PI * 2 * i) / N;
    e.x = player.x + Math.cos(angulo) * nivel.raioOrbita;
    e.y = player.y + Math.sin(angulo) * nivel.raioOrbita;
    e.hpMax = 1e6;
    e.hp = 1e6;
    ultimoPorAlvo.set(`${e.x.toFixed(3)},${e.y.toFixed(3)}`, null);
  }

  const DURACAO_TICKS = 600; // 10s, o mesmo tamanho de janela usado na medicao da revisao
  const FOLGA = 1e-9;
  let acertos = 0;
  for (let i = 0; i < DURACAO_TICKS; i += 1) {
    passoOrbital(estado, PASSO);
    const agora = estado.run.avaliacao.decorrido;
    for (const evento of estado.eventos) {
      if (evento.tipo !== 'arma-acerto' || evento.dados.arma !== dados.id) continue;
      acertos += 1;
      const chave = `${evento.dados.x.toFixed(3)},${evento.dados.y.toFixed(3)}`;
      const anterior = ultimoPorAlvo.get(chave);
      if (anterior !== null && anterior !== undefined && agora - anterior < nivel.intervaloDano - FOLGA) {
        falhar(
          0,
          `com ${N} inimigos na orbita (memoriaAlvos=${CONTEUDO.orbital.memoriaAlvos}), dois acertos no MESMO ` +
            `inimigo do enxame ficaram a ${(agora - anterior).toFixed(4)}s um do outro, menos que intervaloDano ` +
            `(${nivel.intervaloDano}s): o anel de cooldown estourou — outro inimigo tomou o slot antes de vencer`
        );
      }
      ultimoPorAlvo.set(chave, agora);
    }
    estado.eventos.length = 0;
  }
  if (acertos === 0) falhar(0, 'a caneta orbital nao acertou ninguem no cenario de enxame — o cenario nao vale nada');
}

// ------------------------------------------------------------- feixe (Marca-texto)
//
// feixe NAO guarda memoria de inimigo entre quadros — e uma forma geometrica
// recalculada do zero a cada quadro, sem projetil nem perfuracao — entao nao
// ha guarda de geracao para testar aqui (nada para confundir entre vidas
// diferentes do mesmo objeto reciclado). O que precisa de prova e o outro
// jeito de errar: dano por SEGUNDO escalado errado por dt viraria dano por
// QUADRO (60x mais forte a 60fps) ou dano fixo por acerto (dano NAO escalando
// com o tempo de contato).
function checarFeixeContinuo() {
  const estado = novoEstado(SEMENTE + 12);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  const player = estado.player;
  player.x = CONTEUDO.arena.largura / 2;
  player.y = CONTEUDO.arena.altura / 2;

  const arma = equiparArma(estado, 'marcatexto');
  if (!arma) falhar(0, 'equiparArma("marcatexto") falhou montando o cenario do feixe');
  const dados = dadosDaArma('marcatexto');
  const nivel = nivelDaArma(arma);

  // "Parado mantem a ultima direcao" so tem dente se a direcao guardada NAO
  // for a mesma que o valor padrao (0): usa-se movimento para BAIXO
  // (angulo = PI/2), nao para a direita, de proposito.
  player.vx = 0;
  player.vy = 100;
  atualizarArmas(estado, PASSO);
  if (Math.abs(arma.angulo - Math.PI / 2) > 1e-9) {
    falhar(0, `o feixe nao girou para a direcao do movimento: angulo=${arma.angulo}, esperava ${Math.PI / 2}`);
  }
  player.vx = 0;
  player.vy = 0; // "parado": velocidade exatamente zero, como aplicarAtrito() deixa

  const alvo = spawnInimigo(estado);
  if (!alvo) falhar(0, 'spawnInimigo devolveu null montando o alvo do feixe');
  alvo.x = player.x;
  alvo.y = player.y + nivel.alcance / 2; // no meio do feixe, na direcao guardada
  alvo.hpMax = 1e6;
  alvo.hp = 1e6;

  const TICKS_FEIXE = 120; // 2s
  let danoTotal = 0;
  for (let i = 0; i < TICKS_FEIXE; i += 1) {
    atualizarArmas(estado, PASSO);
    if (Math.abs(arma.angulo - Math.PI / 2) > 1e-9) {
      falhar(i, `o feixe mudou de direcao (angulo=${arma.angulo}) com o jogador parado: nao deveria`);
    }
    for (const evento of estado.eventos) {
      if (evento.tipo === 'arma-acerto' && evento.dados.arma === dados.id) danoTotal += evento.dados.dano;
    }
    estado.eventos.length = 0;
  }

  const esperado = nivel.dano * TICKS_FEIXE * PASSO;
  const erroRelativo = Math.abs(danoTotal - esperado) / esperado;
  if (erroRelativo > 1e-6) {
    falhar(
      TICKS_FEIXE,
      `o feixe aplicou ${danoTotal.toFixed(4)} de dano em ${(TICKS_FEIXE * PASSO).toFixed(2)}s, esperava ` +
        `${esperado.toFixed(4)} (nivel.dano x tempo): o dano por segundo nao esta escalado por dt corretamente`
    );
  }
}

// O ima dos orbes, que e a tarefa 1 do contrato e a metade do laco de
// dopamina. Sem esta checagem ele passa despercebido: com o ima desligado o
// jogador ainda coleta o que pisa em cima, e a corrida de 60s continua
// chegando num nivel plausivel — foi exatamente o que aconteceu quando a
// mutacao "ima desligado" deixou o smoke inteiro verde.
//
// Roda atualizarOrbes() direto, sem atualizar(), para que nenhum inimigo
// nasca, morra ou solte orbe no meio da medida.
function checarImaDeOrbes() {
  const estado = novoEstado(SEMENTE + 9);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  const player = estado.player;
  player.x = CONTEUDO.arena.largura / 2;
  player.y = CONTEUDO.arena.altura / 2;
  const raioIma = CONTEUDO.jogador.raioColeta;
  const pool = poolOrbes(estado);

  // 1. A rampa: dois orbes parados, um na beirada do ima e outro colado no
  // jogador. Um tick. O de perto tem que ganhar MAIS velocidade — e isso que
  // "aceleracao crescente conforme se aproximam" quer dizer. Aceleracao
  // constante deixaria os dois iguais.
  const parado = (distancia) => {
    const orbe = soltarOrbeXp(estado, player.x + distancia, player.y, 1);
    orbe.vx = 0;
    orbe.vy = 0;
    return orbe;
  };
  const longe = parado(raioIma * 0.95);
  const perto = parado(raioIma * 0.15);
  atualizarOrbes(estado, PASSO);
  const velLonge = Math.hypot(longe.vx, longe.vy);
  const velPerto = Math.hypot(perto.vx, perto.vy);
  if (!(velLonge > 0)) {
    falhar(0, `orbe dentro do ima (${(raioIma * 0.95).toFixed(0)}px) nao ganhou velocidade nenhuma: o ima nao puxa`);
  }
  if (!(velPerto > velLonge)) {
    falhar(
      0,
      `o orbe perto do jogador acelerou ${velPerto.toFixed(1)} px/s e o da beirada ${velLonge.toFixed(1)}: ` +
        'a aceleracao nao cresce com a proximidade, o orbe e rebocado em vez de aspirado'
    );
  }
  pool.liberarTodos();

  // 2. O raio significa alguma coisa: fora dele o orbe parado fica parado.
  // A conta e de deslocamento em qualquer direcao, nao so de aproximacao —
  // tirar o teste de distancia da uma `proximidade` negativa, que EMPURRA o
  // orbe para longe, e uma assercao de "nao se aproximou" passaria feliz.
  const fora = soltarOrbeXp(estado, player.x + raioIma * 1.35, player.y, 1);
  fora.vx = 0;
  fora.vy = 0;
  const foraX = fora.x;
  const foraY = fora.y;
  for (let i = 0; i < 60; i += 1) atualizarOrbes(estado, PASSO);
  const andou = Math.hypot(fora.x - foraX, fora.y - foraY);
  if (andou > 1) {
    falhar(
      0,
      `orbe parado a ${(raioIma * 1.35).toFixed(0)}px (fora do ima de ${raioIma}px) andou ${andou.toFixed(1)}px ` +
        'sozinho em 1s: o raio de coleta nao limita a atracao'
    );
  }
  pool.liberarTodos();

  // 3. Dentro do ima, com o jogador PARADO, o orbe chega. O teto de ticks sai
  // da propria aceleracao minima de content.js (t = sqrt(2d/a)), entao ele
  // acompanha o balanceamento em vez de virar constante no teste.
  const folga = 60;
  const teto = Math.ceil(Math.sqrt((2 * raioIma) / CONTEUDO.xpOrbe.aceleracaoMinima) / PASSO) + folga;
  const alvo = soltarOrbeXp(estado, player.x + raioIma * 0.9, player.y, 3);
  alvo.vx = 0;
  alvo.vy = 0;
  const xpAntes = player.xp;
  let ticks = 0;
  while (alvo.ativo && ticks < teto) {
    atualizarOrbes(estado, PASSO);
    ticks += 1;
  }
  if (alvo.ativo) {
    falhar(
      0,
      `o orbe a ${(raioIma * 0.9).toFixed(0)}px nao foi coletado em ${teto} ticks com o jogador parado: ` +
        'o ima atrai mas o orbe nao encosta, ou a coleta nao dispara'
    );
  }
  if (player.xp !== xpAntes + 3) {
    falhar(0, `o orbe valia 3 de XP e o jogador ganhou ${player.xp - xpAntes}`);
  }
  const problema = pool.verificar();
  if (problema) falhar(0, `pool de orbes inconsistente depois da coleta: ${problema}`);
}

// Carta e dado tambem: o `tipo` da carta de consolo em content.js precisa
// existir no registro de efeitos de cards.js. content.js nao pode importar
// cards.js (ciclo), entao a ligacao dado <-> codigo e verificada aqui, como ja
// acontece com o `comportamento` das armas.
function checarCartasDoConteudo() {
  const problema = verificarCartasDoConteudo();
  if (problema) falhar(0, problema);
}

// Tarefa 3 do contrato: dois niveis de uma vez viram DUAS cartas, uma depois
// da outra. Perder um nivel porque dois cairam no mesmo quadro e um bug que
// nao aparece na tela — a carta some e ninguem percebe que era para ter vindo
// outra. Tambem e aqui que se prova que a carta congela a simulacao.
// Cenario compartilhado por TODA tela que congela a partida (carta, resultado,
// jubilado, pausa). Inimigos vivos, parados e DENTRO do alcance da arma,
// montados a mao: com a arena vazia o teste de congelamento fica verde mesmo
// com atualizarInimigos ou atualizarArmas rodando por tras do overlay — nao ha
// o que se mexer. Estes tres sao a unica coisa que separa "a simulacao
// congelou" de "nao havia simulacao nenhuma para congelar". Fase 07: a loja
// congela igual e reusa isto.
function montarCenarioCongelavel(semente) {
  const estado = novoEstado(semente);
  comecarAvaliacao(estado);
  limparInimigos(estado);

  const player = estado.player;
  player.x = CONTEUDO.arena.largura / 2;
  player.y = CONTEUDO.arena.altura / 2;

  const alvos = [];
  for (let i = 0; i < 3; i += 1) {
    const inimigo = spawnInimigo(estado);
    if (!inimigo) falhar(0, 'spawnInimigo devolveu null montando o cenario de congelamento');
    inimigo.x = player.x + 90 + i * 25;
    inimigo.y = player.y + (i - 1) * 30;
    inimigo.vx = 0;
    inimigo.vy = 0;
    alvos.push(inimigo);
  }
  return { estado, player, alvos };
}

// Congela por TICKS_CONGELADO ticks com o jogador empurrando para a direita e
// confere que o mundo nao andou um milimetro. Cada sistema tem seu proprio
// sinal — jogador, cronometro, orbe, hp/xp, arma, projeteis, inimigos —
// porque quando uma linha sobra rodando e preciso saber QUAL.
//
// A ORDEM DAS ASSERCOES E PARTE DO TESTE (licao da fase 04): um sinal pode ter
// mais de uma causa, e quem chega primeiro leva a culpa. O orbe PARADO vem
// antes do teste de hp/xp porque coletar um orbe tambem mexe no xp; a CONTAGEM
// de orbes fica por ultimo, com texto neutro, porque ela sobe quando a arma
// mata um inimigo atras do overlay e acusar atualizarOrbes por isso mandaria o
// proximo agente ler o arquivo errado.
function exigirCongelado(estado, alvos, { quando, onde }) {
  const player = estado.player;
  const armaViva = player.armas[0];
  if (!armaViva) falhar(0, `o jogador chegou ${quando} sem arma nenhuma: o cenario de congelamento nao vale`);

  // Um orbe parado DENTRO do raio do ima, criado depois de a tela abrir: se
  // atualizarOrbes() continuar rodando, ele sai do lugar e e coletado. Sem
  // ele, a tela podia aspirar XP a noite inteira sem teste reclamar.
  const orbeParado = soltarOrbeXp(estado, player.x + CONTEUDO.jogador.raioColeta * 0.5, player.y, 1);
  if (!orbeParado) falhar(0, 'soltarOrbeXp devolveu null montando o cenario de congelamento');
  orbeParado.vx = 0;
  orbeParado.vy = 0;

  const antes = {
    x: player.x,
    y: player.y,
    hp: player.hp,
    xp: player.xp,
    decorrido: estado.run.avaliacao.decorrido,
    inimigos: estado.enemies.length,
    cooldown: armaViva.cooldown,
    projeteis: estado.projectiles.length,
    projetilX: estado.projectiles.length > 0 ? estado.projectiles[0].x : 0,
    orbes: estado.xpOrbs.length,
    orbeX: orbeParado.x,
    alvos: alvos.map((e) => ({ ativo: e.ativo, x: e.x, y: e.y, hp: e.hp })),
  };
  estado.input.eixoX = 1;
  for (let i = 0; i < TICKS_CONGELADO; i += 1) atualizar(estado, PASSO);
  estado.input.eixoX = 0;

  if (player.x !== antes.x || player.y !== antes.y) {
    falhar(0, `o jogador andou ${(player.x - antes.x).toFixed(2)}px ${quando}: a simulacao nao congelou`);
  }
  if (estado.run.avaliacao.decorrido !== antes.decorrido) {
    falhar(0, `o cronometro da avaliacao andou ${quando}`);
  }
  if (orbeParado.x !== antes.orbeX || !orbeParado.ativo) {
    falhar(
      0,
      `o orbe parado saiu ${(orbeParado.x - antes.orbeX).toFixed(2)}px${orbeParado.ativo ? '' : ' e foi coletado'} ` +
        `${quando}: atualizarOrbes() roda ${onde}?`
    );
  }
  if (player.hp !== antes.hp || player.xp !== antes.xp) {
    falhar(
      0,
      `o jogador perdeu hp (${antes.hp} -> ${player.hp}) ou ganhou xp (${antes.xp} -> ${player.xp}) ${quando}`
    );
  }
  if (armaViva.cooldown !== antes.cooldown) {
    falhar(
      0,
      `o cooldown da arma foi de ${antes.cooldown.toFixed(3)} para ${armaViva.cooldown.toFixed(3)} ${quando}: ` +
        `atualizarArmas() roda ${onde}?`
    );
  }
  if (
    estado.projectiles.length !== antes.projeteis ||
    (estado.projectiles.length > 0 && estado.projectiles[0].x !== antes.projetilX)
  ) {
    falhar(
      0,
      `os projeteis andaram (${antes.projeteis} -> ${estado.projectiles.length} vivos) ${quando}: ` +
        `atualizarArmas() roda ${onde}?`
    );
  }
  if (estado.enemies.length !== antes.inimigos) {
    falhar(
      0,
      `a arena tinha ${antes.inimigos} inimigos e ficou com ${estado.enemies.length} ${quando}: ` +
        `o spawn (ou a morte) continua rodando ${onde}`
    );
  }
  alvos.forEach((e, i) => {
    const antigo = antes.alvos[i];
    if (e.ativo !== antigo.ativo || e.x !== antigo.x || e.y !== antigo.y || e.hp !== antigo.hp) {
      falhar(
        0,
        `o inimigo ${i} andou ${Math.hypot(e.x - antigo.x, e.y - antigo.y).toFixed(2)}px e foi de ` +
          `${antigo.hp} para ${e.hp} de hp ${quando}: atualizarInimigos() roda ${onde}?`
      );
    }
  });
  // Rede final, de texto neutro: orbe a mais so aparece se alguem morreu atras
  // do overlay, e as verificacoes acima ja apontaram o culpado quando ele existe.
  if (estado.xpOrbs.length !== antes.orbes) {
    falhar(
      0,
      `a arena tinha ${antes.orbes} orbes e ficou com ${estado.xpOrbs.length} ${quando}: ` +
        'alguem matou inimigo atras da tela'
    );
  }
  return orbeParado;
}

function checarFilaDeCartas() {
  const { estado, player, alvos } = montarCenarioCongelavel(SEMENTE + 6);

  // XP de dois niveis de uma vez, exatamente como uma horda que morre junto.
  player.xp = xpParaSubir(1) + xpParaSubir(2);
  atualizar(estado, PASSO);

  if (estado.tela !== TELAS.CARTA) {
    falhar(0, `o jogador subiu de nivel e a tela continuou "${estado.tela}": a carta nao abriu`);
  }
  if (player.nivel !== 3) {
    falhar(
      0,
      `o jogador foi para o nivel ${player.nivel} com XP de dois niveis (esperava 3): ` +
        'o laco de subir de nivel e `if` em vez de `while`?'
    );
  }
  if (estado.cartas.fila !== 2) {
    falhar(0, `fila de cartas em ${estado.cartas.fila} depois de dois niveis (esperava 2)`);
  }
  if (estado.cartas.opcoes.length !== CONTEUDO.cartas.quantidade) {
    falhar(
      0,
      `a carta abriu com ${estado.cartas.opcoes.length} opcoes, content.js pede ${CONTEUDO.cartas.quantidade}`
    );
  }

  exigirCongelado(estado, alvos, { quando: 'com a carta aberta', onde: 'na tela de carta' });

  // Com 4 armas em content.js a opcao 0 nao e mais sempre "Cafe +1": pode ser
  // uma arma nova ou o nivel de qualquer uma das equipadas. Guarda-se o que a
  // opcao PROMETE antes de escolher, para depois conferir o efeito certo —
  // independente de qual carta o sorteio ofereceu (tarefa 5 do contrato desta
  // fase: o sorteio agora tem o que oferecer de verdade).
  const versaoPrimeira = estado.cartas.versao;
  const primeiraOpcao = { ...estado.cartas.opcoes[0] };
  if (!escolherCarta(estado, 0)) falhar(0, 'escolherCarta(0) recusou a primeira carta');
  atualizar(estado, PASSO);

  if (estado.tela !== TELAS.CARTA) {
    falhar(
      0,
      `depois da primeira escolha a tela virou "${estado.tela}": a segunda carta da fila foi comida, ` +
        'dois niveis juntos deram uma carta so'
    );
  }
  if (estado.cartas.versao === versaoPrimeira) {
    falhar(0, 'a segunda carta manteve a versao da primeira: a UI nao redesenharia as opcoes');
  }
  const segundaOpcao = { ...estado.cartas.opcoes[0] };
  if (!escolherCarta(estado, 0)) falhar(0, 'escolherCarta(0) recusou a segunda carta');

  // apontarCarta e o que o mouse (mouseenter) e o foco do DOM chamam — sem
  // trilho, ela podia ser esvaziada e o realce voltaria a nao seguir o mouse,
  // que foi o bloqueio da revisao. Aponta-se a ULTIMA opcao com a escolha ja
  // registrada: prova de uma vez que ela move o cursor, que apontar NAO mexe
  // na escolha pendente (a carta levada continua sendo a 0, verificado logo
  // abaixo) e deixa o cursor fora do zero para a carta seguinte, que e o que
  // da dente a assercao de reset.
  const ultimaOpcao = estado.cartas.opcoes.length - 1;
  if (!apontarCarta(estado, ultimaOpcao)) falhar(0, `apontarCarta(${ultimaOpcao}) recusou uma opcao valida`);
  if (estado.cartas.selecionada !== ultimaOpcao) {
    falhar(
      0,
      `apontarCarta(${ultimaOpcao}) devolveu true mas o cursor ficou em ${estado.cartas.selecionada}: ` +
        'apontar nao escreve em cartas.selecionada, e o mouse nao realca o que aponta'
    );
  }
  if (apontarCarta(estado, estado.cartas.opcoes.length)) {
    falhar(0, 'apontarCarta aceitou um indice fora da faixa: um clique atrasado escolheria carta inexistente');
  }
  if (estado.cartas.selecionada !== ultimaOpcao) {
    falhar(0, 'apontarCarta recusou o indice invalido mas mexeu no cursor assim mesmo');
  }

  atualizar(estado, PASSO);

  if (estado.tela !== TELAS.AVALIACAO) {
    falhar(0, `a fila esvaziou e a tela ficou em "${estado.tela}": a carta nao devolveu o jogo`);
  }
  if (estado.cartas.fila !== 0 || estado.cartas.escolhidas !== 2) {
    falhar(0, `fila=${estado.cartas.fila} escolhidas=${estado.cartas.escolhidas} depois das duas cartas`);
  }
  // As duas opcoes prometidas (guardadas ANTES de cada escolha) precisam ter
  // sido de fato aplicadas — arma-nova equipa, arma-nivel sobe o nivel certo.
  // Sem isso a arma ficaria parada e nada mais neste teste acusaria.
  for (const opcao of [primeiraOpcao, segundaOpcao]) {
    if (opcao.tipo === 'arma-nova') {
      if (!estado.player.armas.some((a) => a.id === opcao.id)) {
        falhar(0, `a carta de arma nova (${opcao.id}) nao equipou nada`);
      }
    } else if (opcao.tipo === 'arma-nivel') {
      const arma = estado.player.armas.find((a) => a.id === opcao.id);
      if (!arma || arma.nivel !== opcao.nivelProximo) {
        falhar(
          0,
          `a carta de nivel (${opcao.id} -> ${opcao.nivelProximo}) nao aplicou: ficou em ` +
            `${arma ? arma.nivel : '(sem arma)'}`
        );
      }
    }
    // Outros tipos (carta de consolo) tem teste dedicado em checarCartasNoMaximo().
  }

  // Navegacao por teclado, que e o plano B da apresentacao se o mouse falhar.
  // O cursor chegou aqui na ultima opcao, posto por apontarCarta la em cima:
  // sem isso a assercao de reset passaria de graca, porque a escolha anterior
  // teria deixado `selecionada` em 0 sozinha.
  if (estado.cartas.selecionada !== ultimaOpcao) {
    falhar(0, `o cursor apontado antes da escolha nao sobreviveu a ela (ficou em ${estado.cartas.selecionada})`);
  }
  player.xp = xpParaSubir(player.nivel);
  atualizar(estado, PASSO);
  if (estado.tela !== TELAS.CARTA) falhar(0, 'terceiro nivel nao abriu carta');
  if (estado.cartas.selecionada !== 0) {
    falhar(
      0,
      `a carta abriu com o cursor na opcao ${estado.cartas.selecionada}: abrirCarta() nao reseta a selecao ` +
        'e o Enter levaria a carta que o jogador apontou na carta ANTERIOR'
    );
  }
  moverSelecaoCarta(estado, -1);
  if (estado.cartas.selecionada !== estado.cartas.opcoes.length - 1) {
    falhar(0, `seta para tras deixou o cursor em ${estado.cartas.selecionada}: a navegacao nao da a volta`);
  }
  moverSelecaoCarta(estado, 1);
  if (estado.cartas.selecionada !== 0) falhar(0, 'seta para frente nao voltou o cursor ao inicio');
}

// Criterio de aceite: com todas as armas no nivel maximo a carta AINDA abre e
// AINDA e escolhivel. Sem a carta de consolo o jogo travaria numa tela de
// escolha sem escolha — e isso acontece no fim da avaliacao, que e o pior
// momento possivel.
function checarCartasNoMaximo() {
  const estado = novoEstado(SEMENTE + 7);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  for (const dados of CONTEUDO.armas) {
    equiparArma(estado, dados.id);
    let subidas = 0;
    while (subirNivelArma(estado, dados.id)) {
      subidas += 1;
      if (subidas > 50) falhar(0, 'subirNivelArma nunca devolve false montando o cenario de nivel maximo');
    }
  }

  const player = estado.player;
  player.hp = Math.max(1, player.hpMax - CONTEUDO.cartas.consolo.valor);
  player.xp = xpParaSubir(player.nivel);
  limparInimigos(estado);
  atualizar(estado, PASSO);

  if (estado.tela !== TELAS.CARTA) {
    falhar(0, 'com tudo no nivel maximo o nivel novo nao abriu carta nenhuma');
  }
  estado.cartas.opcoes.forEach((opcao, i) => {
    if (!opcao.tipo || !opcao.nome || !opcao.emoji) {
      falhar(0, `opcao ${i} veio vazia com tudo no maximo: falta a carta de consolo de content.js`);
    }
    if (opcao.tipo === 'arma-nivel') {
      falhar(0, `opcao ${i} oferece +1 nivel numa arma ja no maximo (${opcao.id})`);
    }
  });

  const hpAntes = player.hp;
  const ultima = estado.cartas.opcoes.length - 1;
  if (!escolherCarta(estado, ultima)) falhar(0, `escolherCarta(${ultima}) recusou a ultima opcao`);
  limparInimigos(estado);
  atualizar(estado, PASSO);

  if (estado.tela !== TELAS.AVALIACAO) {
    falhar(0, `a carta de consolo nao fechou a tela (ficou em "${estado.tela}")`);
  }
  if (player.hp <= hpAntes) {
    falhar(0, `a carta de consolo nao curou (hp ${hpAntes} -> ${player.hp}): o efeito "cura" foi aplicado?`);
  }
}

// O sorteio das cartas passa pelo rng com semente — se escapasse para
// Math.random(), nada aqui seria reproduzivel. Com uma arma so em content.js o
// sorteio e trivial, entao o cenario injeta armas de teste: e a unica cobertura
// que a carta "arma nova" tem hoje, e ela e metade da regra da tarefa 4.
const SEMENTES_SORTEIO = 12;

function opcoesDoPrimeiroNivel(semente) {
  const estado = novoEstado(semente);
  comecarAvaliacao(estado);
  limparInimigos(estado);
  estado.player.xp = xpParaSubir(1);
  atualizar(estado, PASSO);
  if (estado.tela !== TELAS.CARTA) falhar(0, 'o cenario de sorteio nao chegou na carta');
  return estado;
}

function checarSorteioDeCartas() {
  const originais = CONTEUDO.armas.slice();
  const base = CONTEUDO.armas[0];
  // Armas de teste: mesmos numeros do Café (o array de niveis e so leitura),
  // id e nome proprios. Somem no finally — a fase 03 aprendeu na marra que
  // restauracao de conteudo nao pode atravessar outra edicao.
  for (const sufixo of ['a', 'b', 'c']) {
    CONTEUDO.armas.push({ ...base, id: `teste-${sufixo}`, nome: `Teste ${sufixo}` });
  }

  try {
    const assinatura = (estado) => estado.cartas.opcoes.map((o) => `${o.tipo}:${o.id}`).join(' | ');
    const primeira = assinatura(opcoesDoPrimeiroNivel(SEMENTE + 8));
    const repetida = assinatura(opcoesDoPrimeiroNivel(SEMENTE + 8));
    if (primeira !== repetida) {
      falhar(0, `a mesma semente sorteou cartas diferentes: [${primeira}] contra [${repetida}]`);
    }

    const vistas = new Set();
    for (let i = 0; i < SEMENTES_SORTEIO; i += 1) {
      const estado = opcoesDoPrimeiroNivel(SEMENTE + 100 + i);
      vistas.add(assinatura(estado));

      const ids = new Set();
      for (const opcao of estado.cartas.opcoes) {
        if (opcao.tipo !== 'arma-nova' && opcao.tipo !== 'arma-nivel') continue;
        if (ids.has(opcao.id)) falhar(0, `a mesma arma (${opcao.id}) apareceu duas vezes na mesma carta`);
        ids.add(opcao.id);
        const dados = dadosDaArma(opcao.id);
        if (opcao.nivelProximo > dados.niveis.length) {
          falhar(0, `carta oferecendo nivel ${opcao.nivelProximo} de ${opcao.id}, o maximo e ${dados.niveis.length}`);
        }
      }
    }
    if (vistas.size < 2) {
      falhar(
        0,
        `${SEMENTES_SORTEIO} sementes diferentes sortearam sempre as mesmas cartas (${[...vistas][0]}): ` +
          'o sorteio nao esta passando pelo rng'
      );
    }

    // Escolher uma carta de arma nova precisa EQUIPAR a arma. Com uma arma so
    // em content.js este caminho nao roda em corrida nenhuma.
    let equipou = false;
    for (let i = 0; i < SEMENTES_SORTEIO && !equipou; i += 1) {
      const estado = opcoesDoPrimeiroNivel(SEMENTE + 200 + i);
      const indice = estado.cartas.opcoes.findIndex((o) => o.tipo === 'arma-nova');
      if (indice < 0) continue;
      const id = estado.cartas.opcoes[indice].id;
      const antes = estado.player.armas.length;
      escolherCarta(estado, indice);
      limparInimigos(estado);
      atualizar(estado, PASSO);
      if (estado.player.armas.length !== antes + 1 || !estado.player.armas.some((a) => a.id === id)) {
        falhar(
          0,
          `a carta de arma nova (${id}) nao equipou nada: player.armas ficou com ${estado.player.armas.length}`
        );
      }
      equipou = true;
    }
    if (!equipou) {
      falhar(0, 'nenhuma semente ofereceu arma nova com 3 armas de teste disponiveis: o sorteio ignora arma-nova?');
    }
  } finally {
    CONTEUDO.armas.length = 0;
    CONTEUDO.armas.push(...originais);
  }
}

// Tarefa 6 do contrato da fase 05: uma corrida de 60s por arma, cada uma
// equipada e levada ao nivel maximo ANTES do primeiro tick (comparacao justa
// entre armas no pico de poder, sem depender da sorte do sorteio de cartas
// pra saber quem cresce mais rapido). O bot roda em circulo, com HP sempre
// cheio — o que se mede e dano, nao sobrevivencia.
//
// O jogador so pode ter a arma especializada: qualquer 'arma-nova' que a
// carta ofereça e removida de estado.player.armas no mesmo tick, antes que
// ela consiga disparar. Sem isso, a carta ainda oferece as outras 3 armas de
// vez em quando (o bot aceita a opcao 0 cegamente, como em toda a corrida
// principal), e cada arma extra que entra MATA inimigos que a arma medida
// mataria — a medida de uma arma passa a depender de quais outras ela por
// acaso pegou. Foi visto acontecendo: bufar o Marca-texto derrubava a
// contagem da Caneta Bic e do Resumo sem tocar em nenhum numero deles.
const MINIMO_KILLS_ESPECIALIZADO = 15; // por arma, em 60s; abaixo disso ela nao esta matando de verdade
const FATOR_MINIMO_ENTRE_ARMAS = 0.4; // a pior nao pode ficar abaixo disto da melhor (criterio de aceite)

function checarArmasEspecializadas() {
  const resultados = [];

  CONTEUDO.armas.forEach((dados, indice) => {
    const estado = novoEstado(SEMENTE + 300 + indice);
    iniciarAvaliacao(estado);

    const arma = equiparArma(estado, dados.id);
    if (!arma) falhar(0, `equiparArma("${dados.id}") falhou montando a corrida especializada`);
    let subidas = 0;
    while (subirNivelArma(estado, dados.id)) {
      subidas += 1;
      if (subidas > 50) falhar(0, `subirNivelArma("${dados.id}") nunca devolve false: o nivel maximo nao segura`);
    }

    let kills = 0;
    let acertos = 0;
    let disparos = 0;
    for (let tick = 1; tick <= TICKS; tick += 1) {
      botCircular(estado, tick);
      estado.player.hp = estado.player.hpMax;
      try {
        atualizar(estado, PASSO);
      } catch (e) {
        falhar(tick, `excecao especializando "${dados.id}": ${e && e.stack ? e.stack : e}`);
      }
      if (estado.tela === TELAS.CARTA) escolherCarta(estado, 0);
      // Isolamento: nenhuma outra arma sobrevive ate o proximo tick.
      if (estado.player.armas.length > 1) {
        estado.player.armas = estado.player.armas.filter((a) => a.id === dados.id);
      }

      for (const evento of estado.eventos) {
        if (evento.tipo === 'arma-acerto' && evento.dados.arma === dados.id) {
          acertos += 1;
          if (evento.dados.matou) kills += 1;
        }
        if (evento.tipo === 'arma-disparo' && evento.dados.arma === dados.id) disparos += 1;
      }
      estado.eventos.length = 0;
    }

    // Teto de disparos dirigido por DADO, nao por lista de nomes de
    // comportamento: qualquer arma cujo nivel maximo tenha campo `cadencia`
    // e DISCRETA (o proprio comportamento decrementa arma.cooldown e so age
    // quando zera — ver o comentario de atualizarArma() em weapons.js). Ela
    // nao pode disparar mais que ceil(T/cadencia)+1 vezes em T segundos; mais
    // que isso e o portao de cadencia parou de bloquear (o bug generico que
    // a descentralizacao do portao na fase 05 poderia introduzir sem
    // ninguem perceber, porque o sintoma que aparece primeiro e sempre
    // indireto — "matou de mais" ou "ninguem tomou dano" — nunca aponta pro
    // `-= dt` que sumiu). orbital e feixe ficam de fora sozinhos: nenhum
    // nivel deles tem `cadencia` em content.js.
    //
    // Roda ANTES da checagem de MINIMO_KILLS_ESPECIALIZADO de proposito: com
    // o portao de cadencia quebrado, um disparo desenfreado tambem produz
    // kills de sobra, entao a checagem de minimo nunca falharia sozinha —
    // ordem errada deixaria essa asserção sem dente em varias das potencias
    // de dano varridas (visto perdendo pra min-kills so por ordem nas mais
    // baixas: /40 e /80 do dano do Resumo).
    const nivelMax = dados.niveis[dados.niveis.length - 1];
    if (typeof nivelMax.cadencia === 'number') {
      const duracao = TICKS * PASSO;
      const teto = Math.ceil(duracao / nivelMax.cadencia) + 1;
      if (disparos > teto) {
        falhar(
          TICKS,
          `arma "${dados.id}" disparou ${disparos}x em ${duracao.toFixed(1)}s, teto calculado pela cadencia ` +
            `(${nivelMax.cadencia}s) e ${teto}: o portao de cadencia (arma.cooldown) parou de bloquear?`
        );
      }
    }

    if (kills < MINIMO_KILLS_ESPECIALIZADO) {
      falhar(
        TICKS,
        `arma "${dados.id}" especializada matou so ${kills} em 60s (minimo ${MINIMO_KILLS_ESPECIALIZADO}): ` +
          'ela esta matando de verdade sozinha?'
      );
    }

    resultados.push({ id: dados.id, nome: dados.nome, kills, acertos, disparos });
  });

  const maior = resultados.reduce((m, r) => (r.kills > m.kills ? r : m), resultados[0]);
  for (const r of resultados) {
    if (r.kills < maior.kills * FATOR_MINIMO_ENTRE_ARMAS) {
      falhar(
        TICKS,
        `arma "${r.id}" matou ${r.kills}, menos que ${(FATOR_MINIMO_ENTRE_ARMAS * 100).toFixed(0)}% da melhor ` +
          `("${maior.id}", ${maior.kills}): ajuste os numeros dela em content.js`
      );
    }
  }

  return resultados;
}

// O numero que o contrato pede: o nivel que o bot atinge em 60s. O HP e
// segurado porque o que se mede aqui e a curva de XP, nao a sobrevivencia — o
// bot circular morre por volta dos 57s desde a fase 03 e a avaliacao
// reiniciaria no meio da medida.
function checarProgressao() {
  const estado = novoEstado(SEMENTE + 5);
  comecarAvaliacao(estado);

  let cartas = 0;
  let orbesPico = 0;
  let xpColetado = 0;
  let xpSoltado = 0;
  let mortos = 0;

  for (let tick = 1; tick <= TICKS_PROGRESSAO; tick += 1) {
    botCircular(estado, tick);
    estado.player.hp = estado.player.hpMax;
    try {
      atualizar(estado, PASSO);
    } catch (e) {
      falhar(tick, `excecao na corrida de progressao: ${e && e.stack ? e.stack : e}`);
    }
    if (estado.tela === TELAS.CARTA && escolherCarta(estado, 0)) cartas += 1;

    if (estado.xpOrbs.length > orbesPico) orbesPico = estado.xpOrbs.length;
    for (const evento of estado.eventos) {
      if (evento.tipo === 'xp-coletado') xpColetado += evento.dados;
      if (evento.tipo === 'inimigo-morto') {
        mortos += 1;
        xpSoltado += evento.dados.xp;
      }
    }
    estado.eventos.length = 0;
  }

  const nivel = estado.player.nivel;
  if (xpColetado <= 0) {
    falhar(TICKS_PROGRESSAO, `${mortos} inimigos morreram e nenhum XP foi coletado: o orbe e atraido e recolhido?`);
  }
  if (cartas === 0) falhar(TICKS_PROGRESSAO, 'o jogador nao subiu de nivel nenhuma vez em 60s');
  if (cartas !== estado.cartas.escolhidas) {
    falhar(TICKS_PROGRESSAO, `o bot escolheu ${cartas} cartas mas o estado contou ${estado.cartas.escolhidas}`);
  }
  if (estado.player.armas[0].nivel === 1) {
    falhar(TICKS_PROGRESSAO, `${cartas} cartas escolhidas e a arma continua no nivel 1: a escolha aplica o efeito?`);
  }
  if (nivel < NIVEL_MINIMO_60S || nivel > NIVEL_MAXIMO_60S) {
    falhar(
      TICKS_PROGRESSAO,
      `o bot chegou ao nivel ${nivel} em 60s, fora da faixa [${NIVEL_MINIMO_60S}, ${NIVEL_MAXIMO_60S}] — ` +
        'o design §3 pede nivel 5-6; ajuste CONTEUDO.xp.porNivel ou jogador.raioColeta'
    );
  }
  const pool = poolOrbes(estado);
  if (pool.criados !== pool.capacidade) {
    falhar(TICKS_PROGRESSAO, `pool de orbes fabricou ${pool.criados} objetos para capacidade ${pool.capacidade}`);
  }
  const problema = pool.verificar();
  if (problema) falhar(TICKS_PROGRESSAO, `pool de orbes inconsistente: ${problema}`);

  // Conservacao de XP. O bot circular coleta menos da metade do que derruba
  // (ele passa longe de quem morreu do outro lado da arena), e olhar so esse
  // numero nao distingue "orbe esperando no chao" de "orbe que sumiu sem ser
  // coletado nem liberado". Esta conta distingue: todo XP que saiu de um
  // inimigo ou esta no jogador ou esta num orbe vivo.
  let xpNoChao = 0;
  for (const orbe of estado.xpOrbs) xpNoChao += orbe.valor;
  if (pool.reciclados !== 0) {
    falhar(
      TICKS_PROGRESSAO,
      `a pool de orbes reciclou ${pool.reciclados} orbes vivos (teto ${pool.capacidade}) — ` +
        'XP sumindo por lotacao; suba arena.limites.xpOrbs ou faca o orbe expirar'
    );
  }
  if (xpColetado + xpNoChao !== xpSoltado) {
    falhar(
      TICKS_PROGRESSAO,
      `XP nao fecha: ${xpSoltado} soltos por ${mortos} mortes, ${xpColetado} coletados e ${xpNoChao} no chao ` +
        `(faltam ${xpSoltado - xpColetado - xpNoChao}) — orbe nascendo fora da pool ou liberado sem ser coletado`
    );
  }

  return { nivel, cartas, orbesPico, xpColetado, xpSoltado, xpNoChao, mortos };
}

// ----------------------------------------------- fim de avaliacao (fase 06)

// Leva o cenario ate o ultimo tick da avaliacao e deixa o cronometro zerar.
// Devolve o estado ja na tela de fim.
function correrAteOFim(contexto) {
  const { estado } = contexto;
  const av = estado.run.avaliacao;
  av.decorrido = av.duracao;
  atualizar(estado, PASSO);
  return contexto;
}

// Tarefas 1, 2, 3 e 4 do contrato, no caminho de aprovacao: o cronometro zera,
// a nota sai, o conceito e os creditos saem dela, e a partida congela por tras
// do overlay.
function checarTelaDeResultado() {
  const contexto = montarCenarioCongelavel(SEMENTE + 8);
  // Um arranhao antes do fim: com o jogador intacto, hp e hpMax sao o mesmo
  // numero e trocar um pelo outro no calculo da nota passaria despercebido.
  // De quebra, e este o caso comum — terminar ileso e raro.
  receberDano(contexto.estado, DANO_DO_CENARIO);
  // Creditos ja guardados de uma avaliacao anterior: com a run zerada,
  // somar e sobrescrever dao o mesmo numero e o teste nao distinguiria.
  contexto.estado.run.creditos = CREDITOS_ANTERIORES;
  // Mortos de uma avaliacao inteira, postos a mao: um boletim de 0 mortos e
  // degenerado — a parcela de kill fica em zero e qualquer erro nela some.
  contexto.estado.run.avaliacao.kills = KILLS_DO_CENARIO;
  correrAteOFim(contexto);
  const { estado, player, alvos } = contexto;
  const av = estado.run.avaliacao;
  const r = estado.run.resultado;

  if (estado.tela !== TELAS.RESULTADO) {
    falhar(0, `o cronometro zerou e a tela virou "${estado.tela}": sobreviver nao leva a tela de resultado`);
  }
  if (!av.concluida) falhar(0, 'a tela de resultado abriu com avaliacao.concluida em false');
  if (r.motivo !== MOTIVO_TEMPO || !r.aprovado) {
    falhar(0, `resultado de fim por tempo veio motivo="${r.motivo}" aprovado=${r.aprovado}`);
  }
  if (r.id !== av.id || r.kills !== av.kills) {
    falhar(0, `o boletim e de outra avaliacao: id="${r.id}" (${av.id}), kills=${r.kills} (${av.kills})`);
  }
  // A nota da tela precisa ser a que a funcao pura calcula com os MESMOS
  // campos que o boletim mostra. Sem isto, decompor 62% de HP e pagar por 100%
  // passaria despercebido.
  const notaEsperada = calcularNota({
    kills: r.kills,
    hpRestante: r.hp,
    hpMax: r.hpMax,
    ileso: r.ileso,
  });
  if (r.nota !== notaEsperada) {
    falhar(0, `nota do boletim ${r.nota} != calcularNota(${r.kills} kills, ${r.hp}/${r.hpMax} hp) = ${notaEsperada}`);
  }
  const faixa = faixaDaNota(r.nota);
  if (r.conceito !== faixa.conceito) {
    falhar(0, `nota ${r.nota} virou conceito "${r.conceito}" e a faixa diz "${faixa.conceito}"`);
  }
  if (r.creditos !== creditosDaFaixa(faixa)) {
    falhar(0, `conceito ${r.conceito} pagou ${r.creditos} creditos, a faixa manda ${creditosDaFaixa(faixa)}`);
  }
  if (r.creditos <= 0) falhar(0, 'uma avaliacao aprovada pagou 0 creditos: a loja da fase 07 nasceria sem nada');
  if (estado.run.creditos !== CREDITOS_ANTERIORES + r.creditos) {
    falhar(
      0,
      `a run tinha ${CREDITOS_ANTERIORES} creditos, a avaliacao pagou ${r.creditos} e o total ficou ` +
        `${estado.run.creditos}: o ganho nao esta sendo somado em run.creditos`
    );
  }
  if (estado.run.creditos !== r.creditosTotal) {
    falhar(0, `run.creditos=${estado.run.creditos} e o boletim diz creditosTotal=${r.creditosTotal}`);
  }
  // A decomposicao e o que ensina a jogar melhor; se ela sair sem o numero de
  // mortos, virou enfeite.
  const t = CONTEUDO.textos.resultado;
  const linha = decomposicaoDaNota(r);
  const pct = Math.round(r.hpFracao * 100);
  // A conta que a TELA mostra precisa fechar: soma-se o que esta escrito entre
  // parenteses, nao as parcelas do estado. Comparar os valores brutos deixava
  // passar "+5,5 · +3,7" com nota 9,3 — cada parcela arredondada sozinha e a
  // nota arredondada da soma bruta.
  const casas = CONTEUDO.nota.casasDecimais;
  const mostradas = [...linha.matchAll(/\(\+(-?\d+(?:,\d+)?)\)/g)].map((m) => Number(m[1].replace(',', '.')));
  if (mostradas.length !== 3) {
    falhar(0, `a decomposicao "${linha}" devia mostrar 3 parcelas "(+x)" e mostrou ${mostradas.length}`);
  }
  const somaMostrada = mostradas.reduce((acc, v) => acc + v, 0);
  const notaMostrada = Number(formatarNota(r.nota).replace(',', '.'));
  if (Math.round(somaMostrada * 10 ** casas) !== Math.round(notaMostrada * 10 ** casas)) {
    falhar(
      0,
      `a tela mostra "${linha}" (soma ${somaMostrada.toFixed(casas)}) e nota ${formatarNota(r.nota)}: ` +
        'a decomposicao mostra uma conta que nao fecha'
    );
  }
  if (!linha.includes(`${r.kills} ${t.mortos}`)) {
    falhar(0, `a decomposicao "${linha}" nao mostra os ${r.kills} mortos`);
  }
  if (!linha.includes(`${pct}% ${t.hp}`)) {
    falhar(0, `a decomposicao "${linha}" nao mostra os ${pct}% de HP restantes`);
  }
  if (!linha.includes(r.ileso ? t.ileso : t.feriu)) {
    falhar(0, `a decomposicao "${linha}" nao diz se o jogador terminou ileso`);
  }

  checarLinhaDeArmas(estado, 'tela de resultado');

  // Congelamento: e AQUI que a pendencia 9 do ESTADO.md aparece. Enquanto o
  // fim da avaliacao ia para o menu, atualizarPlayer acima do guard de
  // `concluida` era inalcancavel; com um overlay por cima da arena, o jogador
  // passaria a andar por tras dele.
  exigirCongelado(estado, alvos, {
    quando: 'com a tela de resultado aberta',
    onde: 'na tela de resultado',
  });

  // A saida: mesma funcao que o botao e o Enter chamam.
  if (!sairDoResultado(estado)) falhar(0, 'sairDoResultado() recusou a tela de resultado');
  // Fase 07: o aprovado vai para a loja (antes ia ao menu).
  if (estado.tela !== TELAS.LOJA) falhar(0, `sairDoResultado deixou a tela em "${estado.tela}", esperava a loja`);
  if (sairDoResultado(estado)) falhar(0, 'sairDoResultado() agiu fora das telas de fim — ESC deixaria de pausar');
  if (!player.vivo) falhar(0, 'o jogador terminou morto numa avaliacao que acabou por tempo');
}

// Linha de debug do boletim (ajuste pos-checkpoint 1): com
// CONTEUDO.debug.boletimArmas ligada ela mostra o nivel do jogador e cada arma
// com o nivel; desligada ela sai vazia, e vazia e o que a UI esconde. A chave
// e trocada no proprio CONTEUDO (e nao so passada como argumento) para provar
// que o valor padrao da funcao le a chave viva — e o que a fase 15 vai
// desligar.
function checarLinhaDeArmas(estado, onde) {
  // Duas armas em niveis diferentes: com uma so, trocar o nivel de uma pelo
  // de outra passaria despercebido.
  if (!equiparArma(estado, CONTEUDO.arma.inicial)) falhar(0, `${onde}: equiparArma da arma inicial falhou`);
  const outra = CONTEUDO.armas.find((a) => a.id !== CONTEUDO.arma.inicial);
  equiparArma(estado, outra.id);
  subirNivelArma(estado, outra.id);
  subirNivelArma(estado, outra.id);

  const r = estado.run.resultado;
  const t = CONTEUDO.textos.resultado;
  const original = CONTEUDO.debug.boletimArmas;
  try {
    CONTEUDO.debug.boletimArmas = true;
    const ligada = armasDoBoletim(r, estado.player.armas);
    if (!ligada.includes(`${t.nivelJogador} ${r.nivel}`)) {
      falhar(0, `${onde}: a linha de armas "${ligada}" nao mostra o nivel ${r.nivel} do jogador`);
    }
    for (const arma of estado.player.armas) {
      const dados = dadosDaArma(arma.id);
      const esperado = `${dados.nome} ${t.nivelArma}${arma.nivel}`;
      if (!ligada.includes(esperado)) falhar(0, `${onde}: a linha de armas "${ligada}" nao mostra "${esperado}"`);
    }
    CONTEUDO.debug.boletimArmas = false;
    const desligada = armasDoBoletim(r, estado.player.armas);
    if (desligada !== '') {
      falhar(0, `${onde}: com debug.boletimArmas desligada a linha de armas devia sair vazia e saiu "${desligada}"`);
    }
  } finally {
    CONTEUDO.debug.boletimArmas = original;
  }
}

// O outro caminho: HP a zero leva a uma tela DIFERENTE, sem nota e sem
// creditos. A run acabou; pagar o jubilamento seria pagar por perder.
function checarTelaDeJubilado() {
  const { estado, alvos } = montarCenarioCongelavel(SEMENTE + 9);
  const creditosAntes = estado.run.creditos;

  receberDano(estado, estado.player.hpMax * 2);
  if (estado.player.vivo) falhar(0, 'receberDano com o dobro do hpMax nao matou o jogador');
  atualizar(estado, PASSO);

  const r = estado.run.resultado;
  if (estado.tela !== TELAS.JUBILADO) {
    falhar(0, `o jogador morreu e a tela virou "${estado.tela}": morrer nao leva a tela de jubilado`);
  }
  if (r.motivo !== MOTIVO_JUBILADO || r.aprovado) {
    falhar(0, `resultado de morte veio motivo="${r.motivo}" aprovado=${r.aprovado}`);
  }
  if (r.nota !== 0 || r.conceito !== '' || r.creditos !== 0) {
    falhar(0, `jubilado saiu com nota ${r.nota}, conceito "${r.conceito}" e ${r.creditos} creditos`);
  }
  if (estado.run.creditos !== creditosAntes) {
    falhar(0, `jubilamento mexeu nos creditos da run (${creditosAntes} -> ${estado.run.creditos})`);
  }
  if (r.ileso) falhar(0, 'o boletim de um jubilado diz que ele terminou ileso');
  const resumo = resumoDoJubilado(r);
  if (!resumo.includes(String(r.kills))) falhar(0, `o resumo do jubilado "${resumo}" nao mostra os mortos`);
  checarLinhaDeArmas(estado, 'tela de jubilado');

  exigirCongelado(estado, alvos, {
    quando: 'com a tela de jubilado aberta',
    onde: 'na tela de jubilado',
  });
  if (!sairDoResultado(estado)) falhar(0, 'sairDoResultado() recusou a tela de jubilado');
  if (estado.tela !== TELAS.MENU) falhar(0, `sairDoResultado deixou a tela em "${estado.tela}" depois do jubilamento`);
}

// "Jogar" no menu comeca uma run NOVA. Sem isto os creditos de uma partida
// jubilada vazariam para a seguinte — e o bug nao aparece em teste nenhum que
// comece de novoEstado, porque ali a run ja nasce zerada. Chama o mesmo
// caminho que o botao usa (iniciarRun), depois de uma run que juntou
// creditos e foi jubilada.
function checarNovaRunZeraCreditos() {
  const { estado } = montarCenarioCongelavel(SEMENTE + 14);
  estado.run.creditos = CREDITOS_ANTERIORES;
  receberDano(estado, estado.player.hpMax * 2);
  atualizar(estado, PASSO);
  if (!estado.run.jubilado) falhar(0, 'o cenario de nova run nao chegou a jubilar o jogador');
  if (!sairDoResultado(estado)) falhar(0, 'sairDoResultado() recusou a tela de jubilado antes da nova run');

  iniciarRun(estado);
  if (estado.run.creditos !== 0) {
    falhar(0, `uma run nova comecou com ${estado.run.creditos} creditos: vazaram da partida anterior`);
  }
  if (estado.run.jubilado) falhar(0, 'uma run nova comecou marcada como jubilada');
  // Fase 08: a run nova abre no anuncio da 1a avaliacao, e o "Começar" poe
  // a avaliacao de pe.
  if (estado.tela !== TELAS.ANUNCIO) falhar(0, `iniciarRun deixou a tela em "${estado.tela}", esperava o anuncio`);
  if (!comecarProxima(estado) || estado.tela !== TELAS.AVALIACAO) falhar(0, `o anuncio da run nova levou a "${estado.tela}"`);
  if (!estado.player.vivo) falhar(0, 'iniciarRun comecou a avaliacao com o jogador morto');
}

// Tarefa 5: ESC congela de verdade, despausa sem "pular" e o cenario volta a
// andar depois — sem esta ultima parte, o teste de congelamento passaria com
// o jogo travado para sempre.
function checarPausa() {
  const { estado, player, alvos } = montarCenarioCongelavel(SEMENTE + 10);
  // Um tick de avaliacao de verdade antes de pausar: a arma inicial (equipada
  // por comecarAvaliacao) dispara e enche o cenario com cooldown e projeteis
  // para o congelamento ter o que medir.
  atualizar(estado, PASSO);

  alternarPausa(estado);
  if (estado.tela !== TELAS.PAUSA) falhar(0, `alternarPausa nao pausou (tela "${estado.tela}")`);
  exigirCongelado(estado, alvos, { quando: 'com o jogo pausado', onde: 'na pausa' });

  // Um quadro gigante — a aba que ficou 30s escondida, ou o ESC segurado —
  // nao pode virar 1800 passos de uma vez. O teto e loop.maxPassosPorFrame e
  // a divida restante e DESCARTADA: recuperar o atraso e o que espirala.
  const relogio = criarRelogio();
  const teto = CONTEUDO.loop.maxPassosPorFrame;
  if (avancarRelogio(relogio, PASSO) !== 1) falhar(0, 'um quadro de 1 passo nao rendeu 1 passo');
  const passos = avancarRelogio(relogio, TEMPO_FORA);
  if (passos !== teto) {
    falhar(0, `${TEMPO_FORA}s de aba escondida renderam ${passos} passos num quadro so (teto ${teto})`);
  }
  if (relogio.acumulador !== 0 || relogio.descartado <= 0) {
    falhar(
      0,
      `o acumulador ficou com ${relogio.acumulador.toFixed(3)}s de divida depois do quadro gigante: ` +
        'o proximo quadro adiantaria o jogo de novo'
    );
  }
  if (avancarRelogio(relogio, 0) !== 0) falhar(0, 'um quadro de 0s rendeu passo: o acumulador nao zerou');

  // O quadro real, como main.js o roda: pausado, a aba fica TEMPO_FORA
  // segundos escondida, o relogio rende o teto de passos e todos eles passam
  // por atualizar. Com a tela em pausa nenhum pode mexer no cronometro.
  const relogioDoJogo = criarRelogio();
  const decorridoPausado = estado.run.avaliacao.decorrido;
  const passosPausado = avancarRelogio(relogioDoJogo, TEMPO_FORA);
  for (let i = 0; i < passosPausado; i += 1) atualizar(estado, PASSO);
  if (estado.run.avaliacao.decorrido !== decorridoPausado) {
    falhar(
      0,
      `${passosPausado} passos de quadro pausado andaram o cronometro de ${decorridoPausado} para ` +
        `${estado.run.avaliacao.decorrido}`
    );
  }

  // Despausa e roda UM quadro normal. A divida do quadro gigante foi
  // descartada, entao ele rende exatamente 1 passo — se o acumulador
  // guardasse o tempo da pausa, a avaliacao pularia para a frente ao voltar.
  alternarPausa(estado);
  if (estado.tela !== TELAS.AVALIACAO) falhar(0, `alternarPausa nao despausou (tela "${estado.tela}")`);
  const antes = { x: player.x, decorrido: estado.run.avaliacao.decorrido };
  estado.input.eixoX = 1;
  const passosDepois = avancarRelogio(relogioDoJogo, PASSO);
  for (let i = 0; i < passosDepois; i += 1) atualizar(estado, PASSO);
  estado.input.eixoX = 0;

  if (passosDepois !== 1) {
    falhar(0, `o primeiro quadro de ${PASSO.toFixed(4)}s depois da pausa rendeu ${passosDepois} passos (esperava 1)`);
  }
  const avanco = estado.run.avaliacao.decorrido - antes.decorrido;
  if (avanco <= 0 || player.x === antes.x) {
    falhar(0, 'depois de despausar o jogo continuou congelado: alternarPausa so pausa');
  }
  if (avanco > PASSO + EPSILON) {
    falhar(0, `ao voltar da pausa a avaliacao adiantou ${avanco.toFixed(3)}s num quadro de ${PASSO.toFixed(4)}s`);
  }
}

// Tarefa 6: uma avaliacao INTEIRA, do inicio ao boletim, com o bot de verdade
// e sem segurar o HP dele — a corrida principal segura, e por isso a nota dela
// nao valeria nada. Corrida propria com semente propria, como a de progressao.
function checarAvaliacaoCompleta() {
  const estado = novoEstado(SEMENTE + 11);
  comecarAvaliacao(estado);

  let cartas = 0;
  let tick = 0;
  while (!telaDeFim(estado) && tick < TICKS_AVALIACAO_COMPLETA) {
    tick += 1;
    botCircular(estado, tick);
    try {
      atualizar(estado, PASSO);
    } catch (e) {
      falhar(tick, `excecao na avaliacao completa: ${e && e.stack ? e.stack : e}`);
    }
    if (estado.tela === TELAS.CARTA && escolherCarta(estado, 0)) cartas += 1;
    estado.eventos.length = 0;
  }

  const r = estado.run.resultado;
  if (!telaDeFim(estado)) {
    falhar(tick, `a avaliacao nao terminou em ${tick} ticks: o cronometro regressivo esta correndo?`);
  }
  if (estado.tela === TELAS.JUBILADO) {
    falhar(
      tick,
      `o bot foi jubilado aos ${r.tempo.toFixed(1)}s de ${r.duracao}s com ${r.kills} mortos — ` +
        'a avaliacao ficou insobrevivivel para quem so anda em circulo (balanceamento de inimigo/arma)'
    );
  }
  if (r.kills <= 0) falhar(tick, 'a avaliacao inteira terminou com 0 mortos');
  if (r.nota <= 0) falhar(tick, `a avaliacao terminou com nota ${r.nota}: os pesos de content.js estao zerados?`);
  if (!r.conceito) falhar(tick, `nota ${r.nota} nao caiu em faixa de conceito nenhuma`);
  if (r.tempo < r.duracao - PASSO) {
    falhar(tick, `o boletim diz ${r.tempo.toFixed(2)}s sobrevividos numa avaliacao de ${r.duracao}s`);
  }
  return {
    nota: r.nota,
    conceito: r.conceito,
    kills: r.kills,
    hpFracao: r.hpFracao,
    ileso: r.ileso,
    creditos: r.creditos,
    cartas,
    ticks: tick,
    decomposicao: decomposicaoDaNota(r),
  };
}

// Ajuste pos-checkpoint 1: o usuario tirou 9,3 (B) parado no canto, sem se
// mexer, e 10,0 jogando normal. Duas corridas proprias, avaliacao inteira e
// HP de verdade, com os dois extremos:
//   - botCanto: prensado no canto a partida toda (o que o usuario fez);
//   - botDesvio: foge de quem chega perto e volta para o meio. NAO e um
//     jogador bom: nao mira, nao busca orbe, nao escolhe carta. Na tabela de
//     antes do ajuste ele reproduzia a partida "jogando normal" do usuario
//     (10,0, ileso, ~210 mortos), e por isso e a regua de "quem se mexe".
// O botCircular nao serve de regua aqui: ele anda sem olhar e passa rente as
// paredes, onde os inimigos nascem — toma tanto dano quanto o canto.
const RAIO_DESVIO = 150; // px: inimigo mais longe que isso nao assusta o botDesvio
const PUXAO_CENTRO = 0.8; // peso da volta ao meio (sem isso ele foge ate a parede e se encurrala)
const IMPULSO_MINIMO = 0.05; // abaixo disso o botDesvio fica parado em vez de tremer

function botCanto(estado) {
  estado.input.eixoX = -1;
  estado.input.eixoY = -1;
}

function botDesvio(estado) {
  const p = estado.player;
  const { largura, altura } = CONTEUDO.arena;
  let fx = 0;
  let fy = 0;
  for (const e of estado.enemies) {
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > RAIO_DESVIO * RAIO_DESVIO || d2 < EPSILON) continue;
    const d = Math.sqrt(d2);
    const peso = (RAIO_DESVIO - d) / RAIO_DESVIO;
    fx += (dx / d) * peso * peso;
    fy += (dy / d) * peso * peso;
  }
  fx += ((largura / 2 - p.x) / largura) * PUXAO_CENTRO;
  fy += ((altura / 2 - p.y) / altura) * PUXAO_CENTRO;
  const n = Math.hypot(fx, fy);
  estado.input.eixoX = n < IMPULSO_MINIMO ? 0 : fx / n;
  estado.input.eixoY = n < IMPULSO_MINIMO ? 0 : fy / n;
}

function correrAvaliacaoCom(bot, semente, rotulo) {
  const estado = novoEstado(semente);
  comecarAvaliacao(estado);
  let tick = 0;
  let segundoNivel5 = null;
  while (!telaDeFim(estado) && tick < TICKS_AVALIACAO_COMPLETA) {
    tick += 1;
    bot(estado, tick);
    try {
      atualizar(estado, PASSO);
    } catch (e) {
      falhar(tick, `excecao na corrida ${rotulo}: ${e && e.stack ? e.stack : e}`);
    }
    if (estado.tela === TELAS.CARTA) escolherCarta(estado, 0);
    if (segundoNivel5 === null && estado.player.nivel >= NIVEL_DO_DESIGN) {
      segundoNivel5 = estado.run.avaliacao.decorrido;
    }
    estado.eventos.length = 0;
  }
  if (!telaDeFim(estado)) falhar(tick, `a corrida ${rotulo} nao terminou em ${tick} ticks`);
  const r = estado.run.resultado;
  return {
    jubilado: estado.tela === TELAS.JUBILADO,
    tempo: r.tempo,
    nota: r.nota,
    conceito: r.conceito,
    kills: r.kills,
    hpFracao: r.hpFracao,
    ileso: r.ileso,
    nivel: estado.player.nivel,
    segundoNivel5,
  };
}

const NIVEL_DO_DESIGN = 5; // design §3: nivel 5 antes do fim da primeira avaliacao
const PIOR_CONCEITO_DO_CANTO = 'D'; // "no maximo D": criterio do checkpoint humano 1

function descreverCorrida(c) {
  const fim = c.jubilado
    ? `JUBILADO aos ${c.tempo.toFixed(1)}s`
    : `NOTA ${formatarNota(c.nota)} ${c.conceito}${c.ileso ? ' ileso' : ''}`;
  const n5 = c.segundoNivel5 === null ? 'nunca' : `${c.segundoNivel5.toFixed(1)}s`;
  return `${fim} · ${c.kills} mortos · ${Math.round(c.hpFracao * 100)}% HP · nivel ${c.nivel} · nivel 5 em ${n5}`;
}

function checarCantoContraDesvio() {
  const canto = correrAvaliacaoCom(botCanto, SEMENTE + 12, 'do canto');
  const desvio = correrAvaliacaoCom(botDesvio, SEMENTE + 13, 'do desvio');

  // Parado no canto: jubilado, ou no maximo o conceito D.
  const faixas = CONTEUDO.nota.faixas;
  const indicePior = faixas.findIndex((f) => f.conceito === PIOR_CONCEITO_DO_CANTO);
  if (indicePior < 0) falhar(0, `o conceito "${PIOR_CONCEITO_DO_CANTO}" sumiu de CONTEUDO.nota.faixas`);
  if (!canto.jubilado && faixas.indexOf(faixaDaNota(canto.nota)) < indicePior) {
    falhar(
      0,
      `parado no canto o bot tirou ${formatarNota(canto.nota)} (${canto.conceito}), acima de ` +
        `${PIOR_CONCEITO_DO_CANTO}: ficar parado nao pode pagar (${descreverCorrida(canto)})`
    );
  }
  // Quem se mexe sobrevive, sobe ao nivel do design e tira mais que o canto.
  if (desvio.jubilado) {
    falhar(0, `o bot que desvia foi jubilado (${descreverCorrida(desvio)}): a avaliacao 1 ficou insobrevivivel`);
  }
  if (desvio.segundoNivel5 === null) {
    falhar(0, `o bot que desvia nao chegou ao nivel ${NIVEL_DO_DESIGN} em 60s (${descreverCorrida(desvio)})`);
  }
  if (!canto.jubilado && desvio.nota <= canto.nota) {
    falhar(
      0,
      `desviando o bot tirou ${formatarNota(desvio.nota)} e parado no canto ${formatarNota(canto.nota)}: ` +
        'se mexer tem que pagar mais que ficar parado'
    );
  }
  return { canto, desvio };
}

// ------------------------------------------ relatorio de partida (debug)

// Pedido do todo.md: um relatorio completo que o usuario exporta e manda a
// agentes de balanceamento. Eles vao ler os numeros como fato, entao as
// contas do relatorio precisam fechar com o boletim e com uma contagem feita
// por fora — e a telemetria nao pode mudar a partida que observa.
// Duas corridas do botCircular, escolhidas medindo: +23 aprova apanhando (11
// golpes) e +19 e jubilada por inimigo. Se o balanceamento mudar e elas
// pararem de levar golpe, a assercao de "houve dano" pede outra semente.
const SEMENTE_RELATORIO = SEMENTE + 23;
const SEMENTE_RELATORIO_JUBILADO = SEMENTE + 19;
const TICKS_NA_CARTA = 20; // o bot espera isto com a carta aberta: tempo de decisao > 0
const TIPOS_CONTADOS = ['arma-disparo', 'arma-acerto', 'inimigo-morto', 'inimigo-nasceu', 'jogador-dano', 'carta-aberta'];

// Uma avaliacao inteira com o botCircular e HP de verdade: ele anda rente as
// paredes e apanha, e sem golpe as contas de dano passariam em branco.
// `drenarACada` imita o navegador, que so esvazia a fila uma vez por QUADRO
// (ate loop.maxPassosPorFrame ticks). So com 1 a contagem por fora e
// confiavel: com mais, a fila pode estourar o teto e perder evento ja
// processado.
function correrComTelemetria(semente, { drenarACada = 1, ligada = true } = {}) {
  const original = CONTEUDO.debug.relatorio;
  CONTEUDO.debug.relatorio = ligada;
  try {
    const estado = novoEstado(semente);
    comecarRun(estado);
    const contagem = {};
    for (const tipo of TIPOS_CONTADOS) contagem[tipo] = 0;
    let tick = 0;
    let naCarta = 0;
    let escolhidas = 0;
    const comecou = Date.now();
    while (!telaDeFim(estado) && tick < TICKS_AVALIACAO_COMPLETA + 2000) {
      tick += 1;
      botCircular(estado, tick);
      try {
        atualizar(estado, PASSO);
      } catch (e) {
        falhar(tick, `excecao na corrida do relatorio: ${e && e.stack ? e.stack : e}`);
      }
      if (estado.tela === TELAS.CARTA) {
        naCarta += 1;
        // Opcoes diferentes a cada carta: sempre a primeira esconderia um
        // indice errado no registro da escolha.
        if (naCarta >= TICKS_NA_CARTA && escolherCarta(estado, escolhidas % CONTEUDO.cartas.quantidade)) {
          escolhidas += 1;
          naCarta = 0;
        }
      }
      if (tick % drenarACada === 0) {
        for (const evento of estado.eventos) if (evento.tipo in contagem) contagem[evento.tipo] += 1;
        estado.eventos.length = 0;
      }
    }
    if (!telaDeFim(estado)) falhar(tick, `a corrida do relatorio nao terminou em ${tick} ticks`);
    return { estado, contagem, tick, ms: Date.now() - comecou };
  } finally {
    CONTEUDO.debug.relatorio = original;
  }
}

// Toda conta do registro contra o boletim e contra a contagem por fora.
// Devolve o registro da avaliacao.
function conferirContasDoRelatorio(corrida, semente) {
  const { estado, contagem } = corrida;
  const tel = estado.telemetria;
  const onde = `relatorio (semente ${semente})`;
  if (!tel || tel.partidas.length !== 1) {
    falhar(0, `${onde}: esperava 1 partida gravada, veio ${tel ? tel.partidas.length : 'telemetria null'}`);
  }
  const partida = tel.partidas[0];
  if (partida.avaliacoes.length !== 1) falhar(0, `${onde}: esperava 1 avaliacao na partida, veio ${partida.avaliacoes.length}`);
  const reg = partida.avaliacoes[0];
  const r = estado.run.resultado;

  const jubilou = estado.tela === TELAS.JUBILADO;
  const esperada = jubilou ? SITUACAO.JUBILADO : SITUACAO.APROVADO;
  if (reg.situacao !== esperada) falhar(0, `${onde}: a tela e "${estado.tela}" e o registro diz "${reg.situacao}"`);
  // Aprovado nao encerra a partida (a loja da fase 07 vem depois); jubilado encerra na hora.
  const partidaEsperada = jubilou ? SITUACAO.JUBILADO : SITUACAO.EM_ANDAMENTO;
  if (partida.situacao !== partidaEsperada) {
    falhar(0, `${onde}: partida "${partida.situacao}" depois de uma avaliacao "${reg.situacao}" (esperava "${partidaEsperada}")`);
  }
  if (!reg.resultado || reg.resultado.kills !== r.kills || reg.resultado.nota !== r.nota) {
    falhar(0, `${onde}: a copia do boletim no registro nao bate com estado.run.resultado`);
  }

  // A contagem por fora precisa bater com o boletim, senao e o teste que esta errado.
  if (contagem['inimigo-morto'] !== r.kills) {
    falhar(0, `${onde}: o proprio teste contou ${contagem['inimigo-morto']} mortes e o boletim ${r.kills}`);
  }
  const soma = (lista, campo) => lista.reduce((s, x) => s + x[campo], 0);
  const contas = [
    ['mortos por tipo de inimigo', soma(reg.inimigos, 'mortos'), r.kills],
    ['mortes por arma', soma(reg.armas, 'mortes'), r.kills],
    ['disparos', soma(reg.armas, 'disparos'), contagem['arma-disparo']],
    ['acertos', soma(reg.armas, 'acertos'), contagem['arma-acerto']],
    ['nascimentos', soma(reg.inimigos, 'nascidos'), contagem['inimigo-nasceu']],
    ['golpes no jogador', reg.jogador.golpes, contagem['jogador-dano']],
    ['golpes listados', reg.golpes.length, contagem['jogador-dano']],
    ['cartas', reg.cartas.length, contagem['carta-aberta']],
    ['subidas de nivel', reg.niveis.length, estado.player.nivel - 1],
    ['cartas por nivel', reg.cartas.length, estado.player.nivel - 1],
    ['mortos nas amostras', soma(reg.amostras, 'mortos'), r.kills],
    ['nascidos nas amostras', soma(reg.amostras, 'nascidos'), contagem['inimigo-nasceu']],
    ['xp solto = coletado + no chao', reg.xp.solto, reg.xp.coletado + reg.xp.noChaoFim],
    ['nivel final', reg.final.nivel, estado.player.nivel],
  ];
  for (const [nome, obtido, esperado] of contas) {
    if (obtido !== esperado) falhar(0, `${onde}: ${nome} = ${obtido}, esperava ${esperado} — evento perdido ou contado duas vezes`);
  }
  const danos = [
    ['dano tomado', reg.jogador.danoTomado, r.danoTomado],
    ['soma dos golpes', soma(reg.golpes, 'dano'), r.danoTomado],
    ['soma das fontes', soma(reg.fontesDano, 'dano'), r.danoTomado],
    ['dano nas amostras', soma(reg.amostras, 'danoTomado'), r.danoTomado],
    ['tempo jogado', reg.tempoJogado, r.tempo],
  ];
  for (const [nome, obtido, esperado] of danos) {
    if (Math.abs(obtido - esperado) > 0.05) falhar(0, `${onde}: ${nome} = ${obtido}, o boletim diz ${esperado}`);
  }
  if (reg.fontesDano.some((f) => f.fonte === FONTE_DESCONHECIDA)) {
    falhar(0, `${onde}: golpe de fonte desconhecida numa partida em que so inimigo bate — o evento jogador-dano sumiu?`);
  }
  for (const i of reg.inimigos) {
    if (i.nascidos - i.mortos - i.vivosFim < 0) {
      falhar(0, `${onde}: ${i.id} com ${i.mortos} mortos + ${i.vivosFim} vivos passando de ${i.nascidos} nascidos`);
    }
  }
  for (const [k, carta] of reg.cartas.entries()) {
    if (carta.escolhida !== k % CONTEUDO.cartas.quantidade) {
      falhar(0, `${onde}: a carta ${k + 1} registrou a opcao ${carta.escolhida} e o bot escolheu ${k % CONTEUDO.cartas.quantidade}`);
    }
    if (carta.decisao < (TICKS_NA_CARTA - 1) * PASSO - EPSILON) {
      falhar(0, `${onde}: a carta ${k + 1} ficou ${TICKS_NA_CARTA} ticks aberta e registrou ${carta.decisao}s de decisao`);
    }
  }
  const amostrasEsperadas = Math.floor(reg.tempoJogado / CONTEUDO.relatorio.amostraSegundos + 1e-6);
  if (reg.amostras.length < amostrasEsperadas || reg.amostras.length > amostrasEsperadas + 1) {
    falhar(0, `${onde}: ${reg.amostras.length} amostras em ${reg.tempoJogado}s (esperava ${amostrasEsperadas} ou +1)`);
  }
  for (let i = 1; i < reg.amostras.length; i += 1) {
    if (!(reg.amostras[i].t > reg.amostras[i - 1].t)) falhar(0, `${onde}: amostra ${i} fora de ordem no tempo`);
  }
  const analise = analisarAvaliacao(reg);
  if (analise.kills !== r.kills || analise.killsBoletim !== r.kills) {
    falhar(0, `${onde}: a analise diz ${analise.kills} mortos e o boletim ${r.kills}`);
  }
  if (jubilou && (!reg.morte || !CONTEUDO.inimigos.some((i) => i.id === reg.morte.fonte))) {
    falhar(0, `${onde}: jubilado por inimigo e a morte registrou a fonte ${JSON.stringify(reg.morte && reg.morte.fonte)}`);
  }
  return reg;
}

function checarRelatorio() {
  const corrida = correrComTelemetria(SEMENTE_RELATORIO);
  const reg = conferirContasDoRelatorio(corrida, SEMENTE_RELATORIO);
  const jubilada = correrComTelemetria(SEMENTE_RELATORIO_JUBILADO);
  const regJubilado = conferirContasDoRelatorio(jubilada, SEMENTE_RELATORIO_JUBILADO);
  // Sem golpe nenhum as contas de dano e a atribuicao de fonte passam em branco.
  if (reg.jogador.golpes + regJubilado.jogador.golpes === 0) {
    falhar(0, `relatorio: as corridas das sementes ${SEMENTE_RELATORIO} e ${SEMENTE_RELATORIO_JUBILADO} nao levaram golpe — escolha sementes em que o botCircular apanha`);
  }
  const { estado } = corrida;
  const tel = estado.telemetria;
  const r = estado.run.resultado;
  const onde = `relatorio (semente ${SEMENTE_RELATORIO})`;

  // O cursor da fila: a mesma partida com a fila esvaziada so a cada quadro
  // de maxPassosPorFrame ticks, como no navegador, grava exatamente o mesmo.
  const porQuadro = correrComTelemetria(SEMENTE_RELATORIO, { drenarACada: CONTEUDO.loop.maxPassosPorFrame });
  if (JSON.stringify(porQuadro.estado.telemetria.partidas) !== JSON.stringify(tel.partidas)) {
    falhar(0, `${onde}: esvaziar a fila a cada ${CONTEUDO.loop.maxPassosPorFrame} ticks mudou a telemetria — o cursor de eventos perde ou repete evento`);
  }

  // So observa: desligada, nada e gravado e a partida e a MESMA, tick a tick.
  const desligada = correrComTelemetria(SEMENTE_RELATORIO, { ligada: false });
  if (desligada.estado.telemetria !== null) falhar(0, `${onde}: com debug.relatorio desligado a telemetria foi criada`);
  const assinatura = (c) =>
    JSON.stringify([c.tick, c.estado.tela, c.estado.run.resultado, c.estado.player.x, c.estado.player.y, c.estado.rng.s, c.estado.enemies.length]);
  if (assinatura(desligada) !== assinatura(corrida)) {
    falhar(0, `${onde}: ligar a telemetria mudou a partida (${assinatura(corrida)} contra ${assinatura(desligada)}) — ela escreve em algo que a simulacao le, ou sorteia`);
  }

  // Os tres escopos saem, com JSON valido e sem numero podre no texto.
  const tamanhos = {};
  for (const escopo of Object.values(ESCOPOS)) {
    const rel = gerarRelatorio(estado, escopo);
    if (!rel || typeof rel.texto !== 'string' || rel.texto.length === 0) falhar(0, `${onde}: gerarRelatorio("${escopo}") nao devolveu texto`);
    for (const podre of ['NaN', 'undefined', 'Infinity', '[object Object]']) {
      if (rel.texto.includes(podre)) {
        const i = rel.texto.indexOf(podre);
        falhar(0, `${onde}: o relatorio "${escopo}" tem "${podre}": ...${rel.texto.slice(Math.max(0, i - 80), i + 20)}...`);
      }
    }
    const bloco = rel.texto.match(/```json\n([\s\S]*)\n```\n$/);
    if (!bloco) falhar(0, `${onde}: o relatorio "${escopo}" nao termina com o bloco JSON`);
    let dados;
    try {
      dados = JSON.parse(bloco[1]);
    } catch (e) {
      falhar(0, `${onde}: o JSON do relatorio "${escopo}" nao e valido: ${e.message}`);
    }
    if (dados.escopo !== escopo) falhar(0, `${onde}: o JSON do relatorio "${escopo}" diz escopo "${dados.escopo}"`);
    const avJson = escopo === ESCOPOS.AVALIACAO ? dados.avaliacao : escopo === ESCOPOS.PARTIDA ? dados.partida.avaliacoes[0] : dados.partidas[0].avaliacoes[0];
    if (!avJson || avJson.analise.kills !== r.kills || avJson.amostras.linhas.length !== reg.amostras.length) {
      falhar(0, `${onde}: o JSON do relatorio "${escopo}" perdeu mortos ou amostras`);
    }
    if (avJson.amostras.linhas.some((linha) => linha.length !== avJson.amostras.colunas.length)) {
      falhar(0, `${onde}: no relatorio "${escopo}" uma linha de amostra tem numero de colunas diferente do cabecalho`);
    }
    // Avaliacao e partida tem a tabela de resumo por avaliacao; a sessao mostra
    // os mortos na tabela de partidas.
    const marca = escopo === ESCOPOS.SESSAO ? `| ${r.kills} |` : `| Mortos | ${r.kills} (`;
    if (!rel.texto.includes(marca)) falhar(0, `${onde}: o relatorio "${escopo}" nao mostra os ${r.kills} mortos ("${marca}")`);
    tamanhos[escopo] = rel.texto.length;
  }
  if (gerarRelatorio(novoEstado(SEMENTE_RELATORIO), ESCOPOS.PARTIDA) !== null) {
    falhar(0, `${onde}: um estado que nunca jogou gerou relatorio — devia devolver null`);
  }

  return { reg, regJubilado, tamanhos, msLigada: corrida.ms, msDesligada: desligada.ms };
}

// Os outros jeitos de uma avaliacao acabar: desistir pela pausa, morrer de
// fonte sem evento, ser atropelada por outra partida — e o teto do historico.
function checarRelatorioFinsAlternativos() {
  const original = CONTEUDO.debug.relatorio;
  CONTEUDO.debug.relatorio = true;
  try {
    const estado = novoEstado(SEMENTE + 16);
    comecarRun(estado);
    for (let i = 0; i < 120; i += 1) atualizar(estado, PASSO);

    // Quadros do navegador: so contam com a avaliacao rodando.
    registrarQuadro(estado, 0.05, 3);
    alternarPausa(estado);
    registrarQuadro(estado, 30, CONTEUDO.loop.maxPassosPorFrame);
    for (let i = 0; i < 10; i += 1) atualizar(estado, PASSO);
    // O botao "Desistir" da pausa faz exatamente isto (main.js).
    irParaTela(estado, TELAS.MENU);
    atualizar(estado, PASSO);

    const tel = estado.telemetria;
    const primeira = tel.partidas[0];
    const desistida = primeira.avaliacoes[0];
    if (desistida.situacao !== SITUACAO.DESISTIU || primeira.situacao !== SITUACAO.DESISTIU) {
      falhar(0, `relatorio: desistir pela pausa gravou avaliacao "${desistida.situacao}" e partida "${primeira.situacao}"`);
    }
    if (desistida.pausas !== 1 || Math.abs((desistida.telas.pausa || 0) - 10 * PASSO) > EPSILON) {
      falhar(0, `relatorio: 1 pausa de 10 ticks virou ${desistida.pausas} pausa(s) e ${desistida.telas.pausa}s`);
    }
    if (desistida.quadros.quadros !== 1 || desistida.quadros.lentos !== 1) {
      falhar(0, `relatorio: registrarQuadro contou ${desistida.quadros.quadros} quadro(s) (esperava so o de fora da pausa)`);
    }
    if (Math.abs(desistida.tempoJogado - 120 * PASSO) > 1e-6) {
      falhar(0, `relatorio: 120 ticks de avaliacao viraram ${desistida.tempoJogado}s jogados`);
    }

    // Golpe fatal sem evento jogador-dano: o dano entra como fonte
    // desconhecida em vez de sumir, e a partida fecha no mesmo tick.
    comecarRun(estado);
    atualizar(estado, PASSO);
    receberDano(estado, estado.player.hpMax * 2);
    atualizar(estado, PASSO);
    const segunda = tel.partidas[tel.partidas.length - 1];
    const morta = segunda.avaliacoes[0];
    if (morta.situacao !== SITUACAO.JUBILADO || segunda.situacao !== SITUACAO.JUBILADO) {
      falhar(0, `relatorio: jubilar gravou avaliacao "${morta.situacao}" e partida "${segunda.situacao}"`);
    }
    if (!morta.morte || morta.morte.fonte !== FONTE_DESCONHECIDA || morta.golpes.length !== 1) {
      falhar(0, `relatorio: o golpe fatal sem evento nao virou golpe de fonte desconhecida (${JSON.stringify(morta.morte)})`);
    }

    // Uma partida atropelada por outra sem passar pelo menu fica
    // "interrompida", e o historico guarda so as mais recentes.
    sairDoResultado(estado);
    const teto = CONTEUDO.relatorio.historicoPartidas;
    for (let i = 0; i < teto + 2; i += 1) {
      comecarRun(estado);
      atualizar(estado, PASSO);
    }
    const iniciadas = 2 + teto + 2;
    if (tel.partidas.length !== teto || tel.sessao.partidasDescartadas !== iniciadas - teto) {
      falhar(0, `relatorio: ${iniciadas} partidas com teto ${teto} deixaram ${tel.partidas.length} guardadas e ${tel.sessao.partidasDescartadas} descartadas`);
    }
    if (tel.partidas[teto - 2].situacao !== SITUACAO.INTERROMPIDA) {
      falhar(0, `relatorio: partida atropelada por outra ficou "${tel.partidas[teto - 2].situacao}"`);
    }
    for (const escopo of Object.values(ESCOPOS)) {
      const rel = gerarRelatorio(estado, escopo);
      if (!rel || rel.texto.includes('NaN') || rel.texto.includes('undefined')) {
        falhar(0, `relatorio: o escopo "${escopo}" quebrou com partidas desistidas, jubiladas e interrompidas`);
      }
    }
  } finally {
    CONTEUDO.debug.relatorio = original;
  }
}

// ------------------------------------------------------ coringas e loja (fase 07)

// Os coringas sao achados pelo EFEITO, nunca pelo id: renomear um coringa em
// content.js nao pode derrubar o teste que prova o efeito.
function coringaComEfeito(efeito) {
  const dados = CONTEUDO.coringas.find((c) => c.efeito === efeito);
  if (!dados) falhar(0, `nenhum coringa em content.js usa o efeito "${efeito}"`);
  return dados;
}

function checarCoringasDoConteudo() {
  const problemas = verificarCoringasDoConteudo();
  if (problemas.length > 0) falhar(0, `coringas de content.js: ${problemas.join(' | ')}`);
  if (HOOKS.length !== 6) falhar(0, `a lista fechada de hooks tem ${HOOKS.length} entradas, o contrato define 6`);
}

// Tarefa 2: o Atestado e o coringa que mais exercita o sistema — golpe fatal,
// memoria por run, e a loja que nao o vende de novo.
function checarAtestado() {
  const atestado = coringaComEfeito('sobreviverFatal');
  const estado = novoEstado(SEMENTE + 40);
  comecarRun(estado);
  estado.run.coringas.push(novaInstancia(atestado.id));
  const player = estado.player;
  const hpMax = player.hpMax;

  // Golpe fatal: segura com params.hp, conta o dano de verdade e da i-frames.
  if (!receberDano(estado, hpMax * 3)) falhar(0, 'Atestado: o golpe fatal nem foi aplicado');
  if (!player.vivo) falhar(0, 'Atestado: o jogador morreu com o Atestado na mao');
  if (player.hp !== atestado.params.hp) falhar(0, `Atestado: sobrou ${player.hp} de HP, esperava ${atestado.params.hp}`);
  if (Math.abs(estado.run.avaliacao.danoTomado - (hpMax - atestado.params.hp)) > EPSILON) {
    falhar(0, `Atestado: danoTomado ${estado.run.avaliacao.danoTomado}, esperava ${hpMax - atestado.params.hp}`);
  }
  if (!(player.invulneravel > 0)) falhar(0, 'Atestado: sobreviveu sem i-frames — o proximo inimigo mata no quadro seguinte');
  if (!estado.eventos.some((e) => e.tipo === 'coringa-ativado')) falhar(0, 'Atestado: nenhum evento coringa-ativado');
  if (!estado.run.coringasGastos.includes(atestado.id)) falhar(0, 'Atestado: nao entrou em run.coringasGastos');

  // Segundo golpe fatal, mesma avaliacao: morre.
  player.invulneravel = 0;
  receberDano(estado, hpMax * 3);
  if (player.vivo) falhar(0, 'Atestado: salvou duas vezes na mesma avaliacao');

  // 1x por RUN: a avaliacao seguinte da mesma run nao ganha outro.
  comecarAvaliacao(estado, 0, 1);
  receberDano(estado, estado.player.hpMax * 3);
  if (estado.player.vivo) falhar(0, 'Atestado: salvou de novo na avaliacao seguinte — era 1x por run');

  // A loja nao vende um Atestado gasto, nem depois de vendido o usado.
  estado.run.coringas.length = 0;
  estado.run.creditos = 1e6;
  estado.tela = TELAS.RESULTADO;
  estado.run.conceito = CONTEUDO.nota.faixas[0].conceito;
  abrirLoja(estado);
  for (let i = 0; i < 40; i += 1) {
    const ids = estado.loja.itens.slice(0, estado.loja.quantidade).map((it) => it.id);
    if (ids.includes(atestado.id)) falhar(0, 'Atestado: a loja ofereceu de novo um coringa 1x-por-run ja gasto');
    rerolar(estado);
  }

  // Run nova: o Atestado volta a valer.
  comecarRun(estado);
  estado.run.coringas.push(novaInstancia(atestado.id));
  receberDano(estado, estado.player.hpMax * 3);
  if (!estado.player.vivo) falhar(0, 'Atestado: uma run nova herdou o Atestado gasto da anterior');
}

// Os efeitos de regra, cada um no hook dele, sem rodar partida.
function checarEfeitosDosCoringas() {
  // Vespera: dano x fator so nos ultimos N segundos.
  const vespera = coringaComEfeito('danoNoFim');
  const estado = novoEstado(SEMENTE + 41);
  comecarRun(estado);
  estado.run.coringas.push(novaInstancia(vespera.id));
  const av = estado.run.avaliacao;
  av.restante = vespera.params.segundos + 1;
  if (aoCalcularDano(estado, 10) !== 10) falhar(0, 'Vespera: mudou o dano fora da janela final');
  av.restante = vespera.params.segundos;
  if (Math.abs(aoCalcularDano(estado, 10) - 10 * vespera.params.fator) > EPSILON) {
    falhar(0, `Vespera: dano ${aoCalcularDano(estado, 10)} na janela final, esperava ${10 * vespera.params.fator}`);
  }

  // Grupo de WhatsApp: soma por morte e zera na avaliacao seguinte.
  const grupo = coringaComEfeito('danoPorMorte');
  const e2 = novoEstado(SEMENTE + 42);
  iniciarRun(e2);
  const inst = novaInstancia(grupo.id);
  e2.run.coringas.push(inst);
  comecarAvaliacao(e2, 0, 0);
  limparInimigos(e2);
  const MORTES = 10;
  // Mata pela porta de sempre: aplicarDano (enemies.js) e quem chama o hook.
  for (let i = 0; i < MORTES; i += 1) {
    const alvo = spawnInimigo(e2);
    if (!alvo) falhar(0, 'Grupo de WhatsApp: spawnInimigo devolveu null');
    if (!aplicarDano(e2, alvo, alvo.hp)) falhar(0, 'Grupo de WhatsApp: o golpe do teste nao matou');
  }
  if (inst.contador !== MORTES) falhar(0, `Grupo de WhatsApp: contou ${inst.contador} mortes de ${MORTES}`);
  const esperado = 10 * (1 + grupo.params.porMorte * MORTES);
  if (Math.abs(aoCalcularDano(e2, 10) - esperado) > EPSILON) {
    falhar(0, `Grupo de WhatsApp: dano ${aoCalcularDano(e2, 10)} depois de ${MORTES} mortes, esperava ${esperado}`);
  }
  comecarAvaliacao(e2, 0, 1);
  if (inst.contador !== 0) falhar(0, 'Grupo de WhatsApp: o bonus atravessou para a avaliacao seguinte');

  // Caderno: a avaliacao abre com a carta do nivel seguinte no primeiro tick.
  const caderno = coringaComEfeito('nivelInicial');
  const e3 = novoEstado(SEMENTE + 43);
  iniciarRun(e3);
  e3.run.coringas.push(novaInstancia(caderno.id));
  comecarAvaliacao(e3, 0, 0);
  atualizar(e3, PASSO);
  if (e3.tela !== TELAS.CARTA || e3.player.nivel !== 1 + caderno.params.niveis) {
    falhar(0, `Caderno: primeiro tick em "${e3.tela}" no nivel ${e3.player.nivel}, esperava a carta no nivel ${1 + caderno.params.niveis}`);
  }

  // Atributos: Energetico e Wi-Fi mudam o player, e o player e o que o jogo le.
  const e4 = novoEstado(SEMENTE + 44);
  iniciarRun(e4);
  const deAtributo = CONTEUDO.coringas.filter((c) => c.efeito === 'atributo');
  for (const c of deAtributo) e4.run.coringas.push(novaInstancia(c.id));
  comecarAvaliacao(e4, 0, 0);
  for (const nome of ATRIBUTOS) {
    let esperadoAtr = CONTEUDO.jogador[nome];
    for (const c of deAtributo) if (c.params.atributo === nome) esperadoAtr *= c.params.fator;
    if (Math.abs(e4.player[nome] - esperadoAtr) > EPSILON) {
      falhar(0, `coringa de atributo: player.${nome} = ${e4.player[nome]}, esperava ${esperadoAtr}`);
    }
  }
  // Velocidade: anda mesmo mais rapido, nao so guarda o numero.
  e4.input.eixoX = 1;
  for (let i = 0; i < 120; i += 1) atualizarPlayer(e4, PASSO);
  const vel = Math.hypot(e4.player.vx, e4.player.vy);
  if (Math.abs(vel - e4.player.velocidade) > 1e-6) {
    falhar(0, `coringa de velocidade: o jogador anda a ${vel.toFixed(2)} px/s, o atributo diz ${e4.player.velocidade}`);
  }
}

// Criterio de aceite: um coringa NOVO entra so por content.js, usando um
// efeito que ja existe, sem tocar em jokers.js. Dois coringas de mentira sao
// postos no proprio CONTEUDO (e tirados no finally): um de XP (hook
// aoGanharXp, que nenhum coringa do MVP usa) e um de HP maximo.
function checarCoringaNovoSoPorConteudo() {
  const original = CONTEUDO.coringas.slice();
  const xp = { id: 'teste-xp', nome: 'Teste XP', emoji: '🧪', descricao: 'x', preco: 10, raridade: 'barato', efeito: 'multiplicarXp', params: { fator: 2 } };
  const hp = { id: 'teste-hp', nome: 'Teste HP', emoji: '🧪', descricao: 'x', preco: 10, raridade: 'barato', efeito: 'atributo', params: { atributo: 'hpMax', fator: 1.5 } };
  try {
    CONTEUDO.coringas.push(xp, hp);
    const problemas = verificarCoringasDoConteudo();
    if (problemas.length > 0) falhar(0, `coringa novo so por content.js foi recusado: ${problemas.join(' | ')}`);

    const estado = novoEstado(SEMENTE + 45);
    iniciarRun(estado);
    estado.run.coringas.push(novaInstancia(xp.id), novaInstancia(hp.id));
    comecarAvaliacao(estado, 0, 0);
    const hpEsperado = CONTEUDO.jogador.hpMax * hp.params.fator;
    if (estado.player.hpMax !== hpEsperado || estado.player.hp !== hpEsperado) {
      falhar(0, `coringa novo de hpMax: player ${estado.player.hp}/${estado.player.hpMax}, esperava ${hpEsperado} cheio`);
    }
    const VALOR = 3;
    const orbe = soltarOrbeXp(estado, estado.player.x, estado.player.y, VALOR);
    orbe.vx = 0;
    orbe.vy = 0;
    const xpAntes = estado.player.xp;
    atualizarOrbes(estado, PASSO);
    if (estado.player.xp - xpAntes !== VALOR * xp.params.fator) {
      falhar(0, `coringa novo de XP: o orbe de ${VALOR} rendeu ${estado.player.xp - xpAntes}, esperava ${VALOR * xp.params.fator}`);
    }

    checarCoringasNovosDaRevisao(xp);

    // E o id duplicado e recusado.
    CONTEUDO.coringas.push({ ...xp });
    if (verificarCoringasDoConteudo().length === 0) falhar(0, 'verificarCoringasDoConteudo aceitou id de coringa repetido');
    CONTEUDO.coringas.pop();
    // E um efeito que nao existe tambem.
    CONTEUDO.coringas.push({ ...xp, id: 'teste-typo', efeito: 'multiplicarXP' });
    if (verificarCoringasDoConteudo().length === 0) falhar(0, 'verificarCoringasDoConteudo aceitou efeito inexistente');
  } finally {
    CONTEUDO.coringas.length = 0;
    CONTEUDO.coringas.push(...original);
  }
}

// Revisao da fase 07. Chamada de dentro do try de checarCoringaNovoSoPorConteudo
// (o finally de la devolve CONTEUDO.coringas ao original). Mais coringas de
// mentira, cada um provando uma coisa so por content.js:
//   - dois do efeito nivelInicial SOMAM (o segundo achava a barra do primeiro
//     ja cheia e dava 0 de XP);
//   - hpMax com fator quebrado sai inteiro;
//   - 'itensLoja' e 'opcoesCarta' sao consultados no ponto de uso (Monitoria
//     e Xerox da expansao entram por eles).
function checarCoringasNovosDaRevisao(modelo) {
  const falso = (id, efeito, params) => ({ ...modelo, id, efeito, params });
  const apostila = falso('teste-apostila', 'nivelInicial', { niveis: 1 });
  const hpQuebrado = falso('teste-hp-quebrado', 'atributo', { atributo: 'hpMax', fator: 1.15 });
  const menosItens = falso('teste-itens-loja', 'atributo', { atributo: 'itensLoja', fator: 0.5 });
  const menosCartas = falso('teste-opcoes-carta', 'atributo', { atributo: 'opcoesCarta', fator: 0.5 });
  CONTEUDO.coringas.push(apostila, hpQuebrado, menosItens, menosCartas);
  const problemas = verificarCoringasDoConteudo();
  if (problemas.length > 0) falhar(0, `coringas de teste da revisao recusados: ${problemas.join(' | ')}`);

  // Caderno + outro nivelInicial: o primeiro tick sobe os niveis dos dois.
  const caderno = coringaComEfeito('nivelInicial');
  const e1 = novoEstado(SEMENTE + 51);
  iniciarRun(e1);
  e1.run.coringas.push(novaInstancia(caderno.id), novaInstancia(apostila.id));
  comecarAvaliacao(e1, 0, 0);
  atualizar(e1, PASSO);
  const niveis = caderno.params.niveis + apostila.params.niveis;
  if (e1.player.nivel !== 1 + niveis || e1.cartas.fila !== niveis) {
    falhar(0, `dois coringas nivelInicial: nivel ${e1.player.nivel} com ${e1.cartas.fila} carta(s) na fila, esperava nivel ${1 + niveis} com ${niveis}`);
  }

  // hpMax x1,15 = 114,99999999999999 sem arredondar.
  const e2 = novoEstado(SEMENTE + 52);
  iniciarRun(e2);
  e2.run.coringas.push(novaInstancia(hpQuebrado.id));
  comecarAvaliacao(e2, 0, 0);
  const hpEsperado = Math.round(CONTEUDO.jogador.hpMax * hpQuebrado.params.fator);
  if (e2.player.hpMax !== hpEsperado || e2.player.hp !== hpEsperado) {
    falhar(0, `hpMax com fator quebrado: player ${e2.player.hp}/${e2.player.hpMax}, esperava ${hpEsperado} inteiro e cheio`);
  }

  // Itens da loja: a vitrine pergunta o numero ao coringa na abertura.
  const e3 = novoEstado(SEMENTE + 53);
  iniciarRun(e3);
  e3.run.coringas.push(novaInstancia(menosItens.id));
  e3.run.conceito = CONTEUDO.nota.faixas[0].conceito;
  e3.tela = TELAS.RESULTADO;
  abrirLoja(e3);
  const itensEsperados = Math.min(e3.loja.itens.length, Math.round(itensDaLoja(e3.run.conceito) * menosItens.params.fator));
  if (e3.loja.quantidade !== itensEsperados) {
    falhar(0, `coringa de itensLoja: a loja abriu ${e3.loja.quantidade} itens, esperava ${itensEsperados}`);
  }

  // Opcoes da carta: o sorteio pergunta o numero ao coringa; o resto dos
  // slots fica vazio (tipo ''), que e o que ui.js esconde.
  const e4 = novoEstado(SEMENTE + 54);
  iniciarRun(e4);
  e4.run.coringas.push(novaInstancia(menosCartas.id));
  comecarAvaliacao(e4, 0, 0);
  e4.player.xp = e4.player.xpProximo;
  atualizar(e4, PASSO);
  if (e4.tela !== TELAS.CARTA) falhar(0, `coringa de opcoesCarta: a carta nao abriu (tela "${e4.tela}")`);
  const slots = e4.cartas.opcoes.length;
  const opcoesEsperadas = Math.max(1, Math.min(slots, Math.round(CONTEUDO.cartas.quantidade * menosCartas.params.fator)));
  const cheias = e4.cartas.opcoes.filter((o) => o.tipo !== '').length;
  if (cheias !== opcoesEsperadas) falhar(0, `coringa de opcoesCarta: a carta mostrou ${cheias} de ${slots} opcoes, esperava ${opcoesEsperadas}`);
}

// Leva uma avaliacao ate o boletim aprovado e entra na loja pela porta de
// sempre (sairDoResultado).
function lojaAberta(semente, creditos) {
  const contexto = montarCenarioCongelavel(semente);
  correrAteOFim(contexto);
  const { estado } = contexto;
  if (estado.tela !== TELAS.RESULTADO) falhar(0, `cenario da loja terminou em "${estado.tela}"`);
  estado.run.creditos = creditos;
  if (!sairDoResultado(estado)) falhar(0, 'sairDoResultado recusou o boletim do cenario da loja');
  if (estado.tela !== TELAS.LOJA) falhar(0, `o aprovado foi para "${estado.tela}", nao para a loja`);
  return estado;
}

function idsNaVitrine(estado) {
  return estado.loja.itens.slice(0, estado.loja.quantidade).map((it) => it.id);
}

// Tarefas 3 e 4: comprar, vender, rerolar, seguir, teto de 5, e o cursor que
// mouse e teclado dividem.
function checarLoja() {
  const cfg = CONTEUDO.loja;
  // Itens por conceito: 4 com B ou A, 3 no resto (design §5).
  for (const faixa of CONTEUDO.nota.faixas) {
    const esperado = faixa.conceito === 'A' || faixa.conceito === 'B' ? 4 : 3;
    if (itensDaLoja(faixa.conceito) !== esperado) {
      falhar(0, `loja: conceito ${faixa.conceito} mostra ${itensDaLoja(faixa.conceito)} itens, o design pede ${esperado}`);
    }
  }

  const estado = lojaAberta(SEMENTE + 46, 0);
  const loja = estado.loja;
  if (loja.quantidade !== itensDaLoja(estado.run.conceito)) {
    falhar(0, `loja: conceito ${estado.run.conceito} abriu ${loja.quantidade} itens, esperava ${itensDaLoja(estado.run.conceito)}`);
  }
  const ids = idsNaVitrine(estado);
  if (ids.some((id) => id === '') || new Set(ids).size !== ids.length) falhar(0, `loja: vitrine com vazio ou repetido (${ids.join(', ')})`);

  // Atraso de abertura (teclado E mouse): o Enter repetido ou o clique duplo
  // do boletim nao compra.
  if (entradaLiberada(estado)) falhar(0, 'loja: teclado/mouse ja compram no mesmo instante em que a loja abre');
  for (let i = 0; i < Math.ceil(cfg.atrasoEntrada / PASSO) + 1; i += 1) atualizar(estado, PASSO);
  if (!entradaLiberada(estado)) falhar(0, `loja: teclado/mouse continuam travados ${cfg.atrasoEntrada}s depois de abrir`);
  if (estado.tela !== TELAS.LOJA) falhar(0, `loja: a tela saiu sozinha para "${estado.tela}"`);

  // Sem credito: recusa, avisa, nao mexe em nada.
  if (comprarItem(estado, 0)) falhar(0, 'loja: comprou sem credito');
  if (loja.aviso !== AVISOS.SEM_CREDITOS || estado.run.coringas.length !== 0) falhar(0, 'loja: a recusa por credito nao avisou ou comprou assim mesmo');
  if (rerolar(estado)) falhar(0, 'loja: rerolou sem credito');

  estado.run.creditos = 10000;
  // Mouse aponta o item 2, Enter compra o item 2 (pendencia 26): o cursor e
  // um so, e e o estado.
  const alvo = loja.itens[2].id;
  if (!apontarLoja(estado, LINHA_VITRINE, 2)) falhar(0, 'loja: apontarLoja recusou o item 2');
  const antes = estado.run.creditos;
  if (!confirmarLoja(estado)) falhar(0, 'loja: Enter no item apontado nao comprou');
  if (estado.run.coringas.length !== 1 || estado.run.coringas[0].id !== alvo) {
    falhar(0, `loja: apontou "${alvo}" e comprou "${estado.run.coringas[0] && estado.run.coringas[0].id}"`);
  }
  if (antes - estado.run.creditos !== loja.itens[2].preco) falhar(0, 'loja: a compra nao cobrou o preco');
  if (comprarItem(estado, 2) || loja.aviso !== AVISOS.VENDIDO) falhar(0, 'loja: vendeu o mesmo item duas vezes');

  // Reroll: cobra o preco, o preco sobe, e nao oferece o que o jogador tem.
  const preco1 = precoReroll(loja);
  if (preco1 !== cfg.rerollBase) falhar(0, `loja: primeiro reroll custa ${preco1}, esperava ${cfg.rerollBase}`);
  const c0 = estado.run.creditos;
  if (!apontarLoja(estado, LINHA_VITRINE, posicaoRerolar(loja)) || !confirmarLoja(estado)) falhar(0, 'loja: Enter no rerolar nao rerolou');
  if (c0 - estado.run.creditos !== preco1) falhar(0, 'loja: o reroll nao cobrou');
  if (precoReroll(loja) !== cfg.rerollBase + cfg.rerollIncremento) falhar(0, 'loja: o preco do reroll nao subiu');
  for (let i = 0; i < 30; i += 1) {
    if (idsNaVitrine(estado).includes(alvo)) falhar(0, 'loja: o reroll ofereceu um coringa que o jogador ja tem');
    rerolar(estado);
  }

  // Teto: enche ate loja.teto comprando de verdade.
  let tentativas = 0;
  while (estado.run.coringas.length < cfg.teto && tentativas < 200) {
    tentativas += 1;
    const i = loja.itens.findIndex((it, k) => k < loja.quantidade && it.id !== '' && !it.vendido);
    if (i < 0 || !comprarItem(estado, i)) rerolar(estado);
  }
  if (estado.run.coringas.length !== cfg.teto) falhar(0, `loja: nao deu para chegar a ${cfg.teto} coringas`);
  rerolar(estado);
  const livre = loja.itens.findIndex((it, k) => k < loja.quantidade && it.id !== '' && !it.vendido);
  if (livre >= 0) {
    if (comprarItem(estado, livre)) falhar(0, `loja: comprou o ${cfg.teto + 1}º coringa — o teto nao segura`);
    if (loja.aviso !== AVISOS.CHEIO) falhar(0, 'loja: a recusa do teto nao avisou');
  }
  if (estado.run.coringas.length !== cfg.teto) falhar(0, 'loja: o teto foi furado');

  // Vender pelo cursor: linha de baixo, Enter.
  if (!trocarLinhaLoja(estado) || loja.linha !== LINHA_CORINGAS) falhar(0, 'loja: nao deu para descer aos coringas do jogador');
  moverSelecaoLoja(estado, 1);
  const vendido = estado.run.coringas[loja.selecionada].id;
  const c1 = estado.run.creditos;
  if (!confirmarLoja(estado)) falhar(0, 'loja: Enter no coringa do jogador nao vendeu');
  const devolvido = estado.run.creditos - c1;
  const dados = CONTEUDO.coringas.find((c) => c.id === vendido);
  if (devolvido !== Math.floor(dados.preco * cfg.fracaoVenda) || devolvido !== valorDeVenda(vendido)) {
    falhar(0, `loja: vender "${vendido}" devolveu ${devolvido}, esperava ${Math.floor(dados.preco * cfg.fracaoVenda)}`);
  }
  if (estado.run.coringas.some((c) => c.id === vendido)) falhar(0, 'loja: o coringa vendido continua na run');
  if (livre >= 0 && !comprarItem(estado, livre)) falhar(0, 'loja: depois de vender, o teto ainda nao deixou comprar');
  // Vender tudo devolve o cursor para a vitrine.
  apontarLoja(estado, LINHA_CORINGAS, 0);
  while (estado.run.coringas.length > 0) venderCoringa(estado, 0);
  if (loja.linha !== LINHA_VITRINE) falhar(0, 'loja: sem coringa nenhum o cursor ficou numa linha vazia');
  if (trocarLinhaLoja(estado)) falhar(0, 'loja: o cursor desceu para uma linha de coringas vazia');

  // Seguir: a proxima avaliacao, com os coringas da run agindo nela.
  const energetico = coringaComEfeito('atributo');
  estado.run.coringas.push(novaInstancia(energetico.id));
  const indiceAntes = estado.run.avaliacaoIndex;
  if (!apontarLoja(estado, LINHA_VITRINE, posicaoSeguir(loja)) || !confirmarLoja(estado)) falhar(0, 'loja: Enter no seguir nao saiu da loja');
  // Fase 08: o seguir anuncia a proxima; o "Começar" do anuncio a poe de pe.
  if (estado.tela !== TELAS.ANUNCIO) falhar(0, `loja: seguir levou a "${estado.tela}", esperava o anuncio`);
  if (estado.run.proxima.avaliacaoIndex !== indiceAntes + 1) falhar(0, 'loja: seguir nao anunciou a avaliacao seguinte');
  // O que se prova aqui e a ligacao loja -> avaliacao seguinte. O sorteio
  // desta semente pode trazer a Prova sem Consulta, que desliga o coringa de
  // proposito (e tem teste proprio): o anuncio vai sem modificador.
  estado.run.proxima.modificadores.length = 0;
  if (!comecarProxima(estado) || estado.tela !== TELAS.AVALIACAO) falhar(0, `loja: o anuncio levou a "${estado.tela}"`);
  if (estado.run.avaliacaoIndex !== indiceAntes + 1) falhar(0, 'loja: seguir nao avancou para a avaliacao seguinte');
  const atr = energetico.params.atributo;
  if (Math.abs(estado.player[atr] - CONTEUDO.jogador[atr] * energetico.params.fator) > EPSILON) {
    falhar(0, `loja: a avaliacao seguinte comecou sem o coringa comprado (player.${atr} = ${estado.player[atr]})`);
  }
  if (seguirDaLoja(estado) || comprarItem(estado, 0) || rerolar(estado)) falhar(0, 'loja: acao da loja funcionou fora da loja');

  // Fim da lista de avaliacoes: o seguir vai ao TCC (fase 08; provisorio ate
  // a fase 10), e dali ao menu.
  const ultimoP = CONTEUDO.periodos.length - 1;
  const ultimoA = CONTEUDO.periodos[ultimoP].avaliacoes.length - 1;
  if (proximaAvaliacao(ultimoP, ultimoA) !== null) falhar(0, 'proximaAvaliacao: existe avaliacao depois da ultima');
  const virada = proximaAvaliacao(0, CONTEUDO.periodos[0].avaliacoes.length - 1);
  if (!virada || virada.periodoIndex !== 1 || virada.avaliacaoIndex !== 0) falhar(0, 'proximaAvaliacao: nao virou o periodo');
  comecarAvaliacao(estado, ultimoP, ultimoA);
  if (avancarRun(estado) || estado.tela !== TELAS.TCC) falhar(0, `avancarRun depois da ultima avaliacao foi a "${estado.tela}"`);
  if (!sairDoTcc(estado) || estado.tela !== TELAS.MENU) falhar(0, `a saida do TCC foi a "${estado.tela}"`);
  if (sairDoTcc(estado)) falhar(0, 'sairDoTcc agiu fora da tela do TCC');
}

// Reroll gratis do conceito A (design §4) e a recusa de um reroll que nao
// traria nada novo. Separado de checarLoja porque precisa escolher o conceito,
// e aquele cenario sai do boletim real da semente.
function checarRerollGratisESemNovidade() {
  const cfg = CONTEUDO.loja;
  const faixas = CONTEUDO.nota.faixas;
  const comGratis = faixas.find((f) => f.rerollsGratis > 0);
  const semGratis = faixas.find((f) => f.rerollsGratis === 0);
  if (!comGratis) falhar(0, 'loja: nenhum conceito da reroll gratis — o design §4 da 1 ao A');
  if (rerollsGratisDaLoja('A') !== 1) falhar(0, `loja: o A da ${rerollsGratisDaLoja('A')} rerolls gratis, o design §4 pede 1`);

  const abrir = (semente, faixa, creditos) => {
    const estado = novoEstado(semente);
    iniciarRun(estado);
    estado.tela = TELAS.RESULTADO;
    estado.run.conceito = faixa.conceito;
    estado.run.creditos = creditos;
    abrirLoja(estado);
    return estado;
  };

  // Com o gratis: sem credito nenhum, o reroll sai; depois o pago comeca do
  // preco base (o gratis nao encarece o seguinte).
  const e1 = abrir(SEMENTE + 48, comGratis, 0);
  if (e1.loja.gratis !== comGratis.rerollsGratis) falhar(0, `loja: conceito ${comGratis.conceito} abriu com ${e1.loja.gratis} rerolls gratis`);
  if (precoReroll(e1.loja) !== 0) falhar(0, 'loja: o reroll gratis tem preco');
  if (rotuloDoReroll(precoReroll(e1.loja)).indexOf(CONTEUDO.textos.loja.gratis) < 0) falhar(0, 'loja: o botao nao diz que o reroll e gratis');
  for (let i = 0; i < comGratis.rerollsGratis; i += 1) {
    if (!rerolar(e1)) falhar(0, 'loja: o reroll gratis foi recusado por falta de credito');
  }
  if (e1.run.creditos !== 0) falhar(0, 'loja: o reroll gratis cobrou');
  if (precoReroll(e1.loja) !== cfg.rerollBase) falhar(0, `loja: depois do gratis o reroll custa ${precoReroll(e1.loja)}, esperava ${cfg.rerollBase}`);
  if (rotuloDoReroll(cfg.rerollBase).indexOf(String(cfg.rerollBase)) < 0) falhar(0, 'loja: o botao de reroll nao mostra o preco');
  if (rerolar(e1) || e1.loja.aviso !== AVISOS.SEM_CREDITOS) falhar(0, 'loja: acabou o gratis e o reroll saiu sem credito');

  // Sem o gratis: o primeiro reroll ja e pago.
  if (semGratis) {
    const e2 = abrir(SEMENTE + 49, semGratis, 0);
    if (e2.loja.gratis !== 0 || precoReroll(e2.loja) !== cfg.rerollBase) falhar(0, `loja: conceito ${semGratis.conceito} ganhou reroll gratis`);
  }

  // Sem novidade: o jogador tem tudo o que nao esta na vitrine. Rerrolar so
  // embaralharia a ordem — recusa e nao cobra.
  const e3 = abrir(SEMENTE + 50, semGratis || comGratis, 1000);
  const vitrine = idsNaVitrine(e3);
  for (const c of CONTEUDO.coringas) if (!vitrine.includes(c.id)) e3.run.coringas.push(novaInstancia(c.id));
  if (rerolarTrazNovidade(e3)) falhar(0, 'loja: rerolarTrazNovidade viu novidade com a vitrine mostrando tudo o que sobra');
  const antes = e3.run.creditos;
  if (rerolar(e3) || e3.loja.aviso !== AVISOS.SEM_NOVIDADE) falhar(0, 'loja: rerrolou sem nada novo para sortear');
  if (e3.run.creditos !== antes) falhar(0, 'loja: a recusa por falta de novidade cobrou');
  // Vendeu um que nao esta a venda: volta a haver o que sortear.
  e3.run.coringas.pop();
  if (!rerolarTrazNovidade(e3) || !rerolar(e3)) falhar(0, 'loja: com um coringa livre fora da vitrine o reroll continuou recusado');

  // Fora da loja nada esta liberado, nem depois do atraso.
  e3.tela = TELAS.MENU;
  if (entradaLiberada(e3)) falhar(0, 'loja: entradaLiberada fora da tela da loja');
}

// Tarefa 5, nos numeros: um coringa caro custa mais que uma avaliacao boa
// rende. "Boa" e o desvio (a regua de quem joga bem) — o boletim real dele.
function checarGuardarDinheiro(desvio) {
  const creditos = creditosDaFaixa(faixaDaNota(desvio.nota));
  const caros = CONTEUDO.coringas.filter((c) => c.raridade === 'caro');
  if (caros.length === 0) falhar(0, 'nenhum coringa caro: guardar dinheiro nunca e necessario');
  for (const c of caros) {
    if (c.preco <= creditos) {
      falhar(0, `"${c.id}" custa ${c.preco} e uma avaliacao boa (desvio, ${desvio.conceito}) rende ${creditos}: nao ha motivo para guardar`);
    }
  }
  return { creditos, caros: caros.map((c) => `${c.emoji}${c.preco}`).join(' ') };
}

// Tarefa 6: uma avaliacao inteira com os 6 coringas forcados (acima do teto,
// de proposito) contra a mesma semente sem nenhum. Nada pode quebrar e o dano
// causado tem que subir. E a rede de seguranca da fase 13.
//
// O dano comparado e o NOMINAL (o que os golpes levam depois dos hooks), nao
// o efetivo: na avaliacao 1 o bot ja mata quase tudo o que nasce, entao o
// efetivo e limitado pelo HP somado do que nasceu e mal se mexe (+2% medido)
// — um aoCalcularDano desligado passaria despercebido por ele.
function correrComCoringas(forcar) {
  const estado = novoEstado(SEMENTE + 47);
  comecarRun(estado);
  if (forcar) {
    for (const c of CONTEUDO.coringas) estado.run.coringas.push(novaInstancia(c.id));
    comecarAvaliacao(estado, 0, 0);
  }
  let dano = 0;
  let efetivo = 0;
  let tick = 0;
  while (!telaDeFim(estado) && tick < TICKS_AVALIACAO_COMPLETA) {
    tick += 1;
    botDesvio(estado);
    try {
      atualizar(estado, PASSO);
    } catch (e) {
      falhar(tick, `excecao na avaliacao com ${forcar ? '6' : '0'} coringas: ${e && e.stack ? e.stack : e}`);
    }
    for (const ev of estado.eventos) {
      if (ev.tipo !== 'arma-acerto') continue;
      dano += ev.dados.dano;
      efetivo += ev.dados.efetivo;
    }
    estado.eventos.length = 0;
    if (estado.tela === TELAS.CARTA) escolherCarta(estado, 0);
    if (tick % INTERVALO_VARREDURA === 0) {
      const ruim = procurarNumeroInvalido(estado, 'estado', new Set(), 0);
      if (ruim) falhar(tick, `numero invalido com ${forcar ? '6' : '0'} coringas: ${ruim}`);
    }
  }
  if (!telaDeFim(estado)) falhar(tick, 'a avaliacao com coringas nao terminou');
  const r = estado.run.resultado;
  const grupo = estado.run.coringas.find((c) => CONTEUDO.coringas.find((d) => d.id === c.id).efeito === 'danoPorMorte');
  return { dano, efetivo, kills: r.kills, nota: r.nota, conceito: r.conceito, jubilado: estado.tela === TELAS.JUBILADO, hp: r.hpFracao, nivel: estado.player.nivel, grupo, estado };
}

function checarSeisCoringas() {
  const sem = correrComCoringas(false);
  const com = correrComCoringas(true);
  if (com.jubilado) falhar(0, 'com os 6 coringas o bot que desvia foi jubilado');
  if (!(com.dano > sem.dano)) {
    falhar(0, `dano com os 6 coringas (${com.dano.toFixed(0)}) nao passou do dano sem nenhum (${sem.dano.toFixed(0)})`);
  }
  if (com.grupo && com.grupo.contador !== com.kills) {
    falhar(0, `Grupo de WhatsApp contou ${com.grupo.contador} mortes e o boletim tem ${com.kills}`);
  }
  return { sem, com };
}

function descreverComCoringas(c) {
  const fim = c.jubilado ? 'JUBILADO' : `NOTA ${formatarNota(c.nota)} ${c.conceito}`;
  return `dano ${c.dano.toFixed(0)} (efetivo ${c.efetivo.toFixed(0)}) · ${c.kills} mortos · ${fim} · ${Math.round(c.hp * 100)}% HP · nivel ${c.nivel}`;
}

// ------------------------------------------------ fase 08: modificadores

// Os 6 do design §9. Estao aqui so para o smoke exigir que nenhum suma de
// content.js: os testes abaixo percorrem CONTEUDO.modificadores e provam cada
// um pelo que ele MEXE (as regras), nao pelo nome — um modificador novo feito
// so de dado ganha teste sem ninguem escrever teste.
const MODIFICADORES_DO_DESIGN = ['aula7h', 'salaLotada', 'semConsulta', 'professorRigido', 'sexta18h', 'frequencia'];
const TICKS_ATE_VELOCIDADE = 60; // 1s de input constante: o jogador ja bateu na velocidade maxima
const TICKS_NA_ARENA_PEQUENA = 600; // 10s de partida de verdade na arena encolhida
const SPAWNS_NA_BORDA = 40;
const DIST_INIMIGO_MEDIDO = 400; // px entre o jogador e o inimigo cuja passada e medida
const TICKS_PASSADA = 10;
const PERDAS_CONTADAS = 3; // perdas de HP contadas no teste da regra perdaHp
const SEGUNDOS_NASCIMENTO = 20; // janela em que se contam nascimentos por dificuldade

// Uma avaliacao da 1ª posicao (dificuldade 1) com os modificadores e coringas
// pedidos, pela porta de sempre, e sem inimigo nenhum na arena.
function avaliacaoCom(semente, mods, coringas = [], p = 0, a = 0) {
  const estado = novoEstado(semente);
  iniciarRun(estado);
  for (const id of coringas) estado.run.coringas.push(novaInstancia(id));
  comecarAvaliacao(estado, p, a, mods);
  limparInimigos(estado);
  return estado;
}

// A conta das regras, refeita aqui por fora: regras neutras, x dificuldade da
// avaliacao, x fatores, + somas. Se regrasDaAvaliacao (state.js) errar a
// combinacao, o teste de cada regra usaria o numero errado sem perceber.
function regrasEsperadas(dados, ids) {
  const r = { ...CONTEUDO.regras };
  r.dificuldade *= dados.dificuldade;
  for (const id of ids) {
    const mod = CONTEUDO.modificadores.find((m) => m.id === id);
    for (const [k, v] of Object.entries(mod.fatores || {})) r[k] *= v;
    for (const [k, v] of Object.entries(mod.somas || {})) r[k] += v;
  }
  return r;
}

function conferirRegras(estado, dados, ids, onde) {
  const esperado = regrasEsperadas(dados, ids);
  const regras = estado.run.avaliacao.regras;
  for (const k of Object.keys(esperado)) {
    if (Math.abs(regras[k] - esperado[k]) > 1e-9) falhar(0, `${onde}: regra ${k} = ${regras[k]}, esperava ${esperado[k]}`);
  }
}

function velocidadeMedida(estado, decorrido) {
  const av = estado.run.avaliacao;
  const p = estado.player;
  av.decorrido = decorrido;
  p.x = (av.arena.esquerda + av.arena.direita) / 2;
  p.y = (av.arena.topo + av.arena.base) / 2;
  p.vx = 0;
  p.vy = 0;
  estado.input.eixoX = 1;
  estado.input.eixoY = 0;
  for (let i = 0; i < TICKS_ATE_VELOCIDADE; i += 1) atualizarPlayer(estado, PASSO);
  estado.input.eixoX = 0;
  return Math.hypot(p.vx, p.vy);
}

// velocidadeInicial / recuperacaoVelocidade (🌅 Aula das 7h): o jogador ANDA
// mais devagar no comeco e volta ao normal em linha reta.
function provarVelocidadeInicial(mod) {
  const onde = `${mod.emoji} ${mod.id}`;
  const e = avaliacaoCom(SEMENTE + 70, [mod.id]);
  const r = e.run.avaliacao.regras;
  const base = e.player.velocidade;
  const v0 = velocidadeMedida(e, 0);
  if (Math.abs(v0 - base * r.velocidadeInicial) > 1e-6) {
    falhar(0, `${onde}: no segundo 0 o jogador anda a ${v0.toFixed(2)} px/s, esperava ${(base * r.velocidadeInicial).toFixed(2)}`);
  }
  if (r.velocidadeInicial !== 1 && Math.abs(v0 - base) < 1e-6) falhar(0, `${onde}: a velocidade do comeco nao mudou`);
  const neutro = avaliacaoCom(SEMENTE + 70, []);
  const vNeutro = velocidadeMedida(neutro, 0);
  if (Math.abs(vNeutro - base) > 1e-6) falhar(0, `${onde}: SEM o modificador o jogador anda a ${vNeutro.toFixed(2)}, esperava ${base}`);
  let texto = `${v0.toFixed(0)} px/s no 0s`;
  if (r.recuperacaoVelocidade > 0) {
    const meio = velocidadeMedida(e, r.recuperacaoVelocidade / 2);
    const esperadoMeio = base * (r.velocidadeInicial + (1 - r.velocidadeInicial) * 0.5);
    if (Math.abs(meio - esperadoMeio) > 1e-6) {
      falhar(0, `${onde}: na metade da recuperacao anda a ${meio.toFixed(2)}, esperava ${esperadoMeio.toFixed(2)}`);
    }
    const fim = velocidadeMedida(e, r.recuperacaoVelocidade);
    if (Math.abs(fim - base) > 1e-6) falhar(0, `${onde}: depois de ${r.recuperacaoVelocidade}s anda a ${fim.toFixed(2)}, esperava ${base}`);
    texto += `, ${meio.toFixed(0)} no ${r.recuperacaoVelocidade / 2}s, ${fim.toFixed(0)} no ${r.recuperacaoVelocidade}s (sem ele: ${vNeutro.toFixed(0)})`;
  }
  return texto;
}

// arena (🪑 Sala Lotada): a parede muda de lugar para o jogador, para os
// inimigos que nascem, para o orbe que cai, e a partida roda nela.
function provarArena(mod) {
  const onde = `${mod.emoji} ${mod.id}`;
  const e = avaliacaoCom(SEMENTE + 71, [mod.id]);
  const av = e.run.avaliacao;
  const f = av.regras.arena;
  const { largura, altura, margemSpawn } = CONTEUDO.arena;
  const a = av.arena;
  const w = a.direita - a.esquerda;
  const h = a.base - a.topo;
  if (Math.abs(w - largura * f) > 1e-6 || Math.abs(h - altura * f) > 1e-6) {
    falhar(0, `${onde}: arena ${w}x${h}, esperava ${largura * f}x${altura * f}`);
  }
  if (Math.abs(a.esquerda - (largura - a.direita)) > 1e-6 || Math.abs(a.topo - (altura - a.base)) > 1e-6) {
    falhar(0, `${onde}: a arena encolhida nao esta centrada`);
  }
  const p = e.player;
  if (Math.abs(p.x - (a.esquerda + a.direita) / 2) > 1e-6 || Math.abs(p.y - (a.topo + a.base) / 2) > 1e-6) {
    falhar(0, `${onde}: o jogador nao nasceu no centro da arena`);
  }
  // Andando para o canto de cima, a esquerda, ate parar.
  e.input.eixoX = -1;
  e.input.eixoY = -1;
  for (let i = 0; i < 5 * TICKS_ATE_VELOCIDADE; i += 1) atualizarPlayer(e, PASSO);
  e.input.eixoX = 0;
  e.input.eixoY = 0;
  if (Math.abs(p.x - (a.esquerda + p.raio)) > 1e-6 || Math.abs(p.y - (a.topo + p.raio)) > 1e-6) {
    falhar(0, `${onde}: o jogador parou em (${p.x.toFixed(1)}, ${p.y.toFixed(1)}), a parede e (${a.esquerda + p.raio}, ${a.topo + p.raio})`);
  }
  // Inimigos nascem a margem de sempre da parede NOVA, nao da do canvas.
  for (let i = 0; i < SPAWNS_NA_BORDA; i += 1) {
    const inimigo = spawnInimigo(e);
    const fora = margemSpawn + inimigo.raio;
    const dentroDaFaixa =
      inimigo.x >= a.esquerda - fora - 1e-6 && inimigo.x <= a.direita + fora + 1e-6 &&
      inimigo.y >= a.topo - fora - 1e-6 && inimigo.y <= a.base + fora + 1e-6;
    const naBorda =
      Math.abs(inimigo.x - (a.esquerda - fora)) < 1e-6 || Math.abs(inimigo.x - (a.direita + fora)) < 1e-6 ||
      Math.abs(inimigo.y - (a.topo - fora)) < 1e-6 || Math.abs(inimigo.y - (a.base + fora)) < 1e-6;
    if (!dentroDaFaixa || !naBorda) {
      falhar(0, `${onde}: inimigo nasceu em (${inimigo.x.toFixed(1)}, ${inimigo.y.toFixed(1)}), fora da faixa de ${fora}px em volta da arena`);
    }
  }
  limparInimigos(e);
  // Orbe de um inimigo morto fora da arena cai dentro dela (senao seria XP inalcancavel).
  soltarOrbeXp(e, 0, 0, 1);
  const orbe = e.xpOrbs[e.xpOrbs.length - 1];
  if (orbe.x < a.esquerda || orbe.x > a.direita || orbe.y < a.topo || orbe.y > a.base) {
    falhar(0, `${onde}: o orbe solto em (0,0) ficou em (${orbe.x.toFixed(1)}, ${orbe.y.toFixed(1)}), fora da arena`);
  }
  // 10s de partida de verdade na arena pequena (pendencia 15: a grade de
  // separacao e do canvas inteiro e continua certa, por clamp).
  const e2 = avaliacaoCom(SEMENTE + 72, [mod.id]);
  let naArena = 0;
  for (let tick = 1; tick <= TICKS_NA_ARENA_PEQUENA; tick += 1) {
    botDesvio(e2);
    atualizar(e2, PASSO);
    if (e2.tela === TELAS.CARTA) escolherCarta(e2, 0);
    e2.eventos.length = 0;
    if (tick % INTERVALO_VARREDURA === 0) {
      const ruim = procurarNumeroInvalido(e2, 'estado', new Set(), 0);
      if (ruim) falhar(tick, `${onde}: numero invalido na arena encolhida: ${ruim}`);
    }
    const pl = e2.player;
    if (pl.x < a.esquerda + pl.raio - 1e-6 || pl.x > a.direita - pl.raio + 1e-6 || pl.y < a.topo + pl.raio - 1e-6 || pl.y > a.base - pl.raio + 1e-6) {
      falhar(tick, `${onde}: o jogador saiu da arena encolhida (${pl.x.toFixed(1)}, ${pl.y.toFixed(1)})`);
    }
  }
  for (const inimigo of e2.enemies) {
    if (inimigo.x >= a.esquerda && inimigo.x <= a.direita && inimigo.y >= a.topo && inimigo.y <= a.base) naArena += 1;
  }
  if (e2.tela !== TELAS.AVALIACAO && e2.tela !== TELAS.CARTA) falhar(0, `${onde}: 10s na arena pequena acabaram em "${e2.tela}"`);
  if (naArena === 0) falhar(0, `${onde}: depois de 10s nenhum inimigo entrou na arena encolhida`);
  return `arena ${w.toFixed(0)}x${h.toFixed(0)} de ${largura}x${altura}; parede, nascimento e orbe nela; ${naArena} inimigos dentro aos 10s`;
}

// coringas (🚫 Prova sem Consulta): a mao inteira para de agir durante a
// prova — atributo, dano e o Atestado — e volta depois dela, na loja.
function provarCoringas(mod) {
  const onde = `${mod.emoji} ${mod.id}`;
  const energetico = CONTEUDO.coringas.find((c) => c.efeito === 'atributo' && c.params.atributo === 'velocidade');
  if (!energetico) falhar(0, `${onde}: nenhum coringa de velocidade para testar`);
  const vespera = coringaComEfeito('danoNoFim');
  const atestado = coringaComEfeito('sobreviverFatal');
  const mao = [energetico.id, vespera.id, atestado.id];
  const com = avaliacaoCom(SEMENTE + 73, [], mao);
  const sem = avaliacaoCom(SEMENTE + 73, [mod.id], mao);
  const desligados = !(sem.run.avaliacao.regras.coringas > 0);
  const base = CONTEUDO.jogador.velocidade;
  const esperadoComMao = base * energetico.params.fator;

  if (Math.abs(com.player.velocidade - esperadoComMao) > 1e-9) falhar(0, `${onde}: a referencia (sem o modificador) nao aplicou o Energetico`);
  const velSem = sem.player.velocidade;
  if (Math.abs(velSem - (desligados ? base : esperadoComMao)) > 1e-9) {
    falhar(0, `${onde}: velocidade ${velSem} com o Energetico na mao, esperava ${desligados ? base : esperadoComMao}`);
  }
  com.run.avaliacao.restante = vespera.params.segundos;
  sem.run.avaliacao.restante = vespera.params.segundos;
  const danoCom = aoCalcularDano(com, 10);
  const danoSem = aoCalcularDano(sem, 10);
  if (Math.abs(danoCom - 10 * vespera.params.fator) > 1e-9) falhar(0, `${onde}: a referencia nao aplicou a Vespera`);
  if (Math.abs(danoSem - (desligados ? 10 : 10 * vespera.params.fator)) > 1e-9) {
    falhar(0, `${onde}: dano ${danoSem} com a Vespera na janela final, esperava ${desligados ? 10 : 10 * vespera.params.fator}`);
  }
  receberDano(com, com.player.hpMax * 3);
  receberDano(sem, sem.player.hpMax * 3);
  if (!com.player.vivo) falhar(0, `${onde}: a referencia nao foi salva pelo Atestado`);
  if (sem.player.vivo === desligados) {
    falhar(0, `${onde}: o Atestado ${sem.player.vivo ? 'salvou' : 'nao salvou'} com os coringas ${desligados ? 'desligados' : 'ligados'}`);
  }
  // Continuam na run e voltam a valer quando a prova acaba (a loja pergunta
  // itensLoja com a avaliacao ja concluida).
  if (sem.run.coringas.length !== mao.length) falhar(0, `${onde}: os coringas sairam da run`);
  // O HUD esmaece a mao perguntando a jokers.js, com a mesma semantica dos hooks.
  if (coringasDesligados(sem) !== desligados) falhar(0, `${onde}: o HUD ${desligados ? 'nao ' : ''}esmaeceria os coringas durante a prova`);
  if (coringasDesligados(com)) falhar(0, `${onde}: o HUD esmaeceria os coringas sem o modificador`);
  sem.run.avaliacao.concluida = true;
  const depois = modificarAtributo(sem, 'velocidade', base);
  if (Math.abs(depois - esperadoComMao) > 1e-9) falhar(0, `${onde}: depois da prova os coringas nao voltaram (velocidade ${depois})`);
  if (coringasDesligados(sem)) falhar(0, `${onde}: o HUD continuaria esmaecendo os coringas depois da prova`);
  return `com ${emojisDosCoringas(sem.run.coringas)} na mao: velocidade ${velSem.toFixed(1)} (normal ${esperadoComMao.toFixed(1)}), ` +
    `dano ${danoSem} (normal ${danoCom}), Atestado ${sem.player.vivo ? 'salvou' : 'nao salvou'}; na loja voltam`;
}

// hpInimigo (👨‍🏫 Professor Rigido): todo tipo nasce com mais HP, e o golpe
// que mata o inimigo normal deixa este de pe.
function provarHpInimigo(mod) {
  const onde = `${mod.emoji} ${mod.id}`;
  const e = avaliacaoCom(SEMENTE + 74, [mod.id]);
  const neutro = avaliacaoCom(SEMENTE + 74, []);
  const f = e.run.avaliacao.regras.hpInimigo;
  for (const tipo of CONTEUDO.inimigos) {
    const i = spawnInimigo(e, tipo.id);
    const n = spawnInimigo(neutro, tipo.id);
    if (Math.abs(i.hpMax - tipo.hp * f) > 1e-9 || i.hp !== i.hpMax) {
      falhar(0, `${onde}: ${tipo.id} nasceu com ${i.hp}/${i.hpMax} de HP, esperava ${tipo.hp * f}`);
    }
    const morreu = aplicarDano(e, i, tipo.hp);
    if (!aplicarDano(neutro, n, tipo.hp)) falhar(0, `${onde}: a referencia nao morreu com ${tipo.hp} de dano`);
    if (morreu !== !(f > 1)) falhar(0, `${onde}: ${tipo.id} ${morreu ? 'morreu' : 'sobreviveu'} a um golpe de ${tipo.hp} com HP x${f}`);
  }
  return `HP ${CONTEUDO.inimigos.map((t) => `${t.emoji}${t.hp}→${+(t.hp * f).toFixed(1)}`).join(' ')}; o golpe que mata o normal nao mata este`;
}

function passadaDoInimigo(mods) {
  const e = avaliacaoCom(SEMENTE + 75, mods);
  const tipo = CONTEUDO.inimigos[0];
  const i = spawnInimigo(e, tipo.id);
  i.x = e.player.x + DIST_INIMIGO_MEDIDO;
  i.y = e.player.y;
  const x0 = i.x;
  for (let t = 0; t < TICKS_PASSADA; t += 1) atualizarInimigos(e, PASSO);
  return { estado: e, tipo, andou: x0 - i.x };
}

// velocidadeInimigo (🕕 Sexta as 18h): todo tipo nasce mais rapido, e o
// inimigo CHEGA mais rapido, nao so guarda o numero.
function provarVelocidadeInimigo(mod) {
  const onde = `${mod.emoji} ${mod.id}`;
  const com = passadaDoInimigo([mod.id]);
  const sem = passadaDoInimigo([]);
  const f = com.estado.run.avaliacao.regras.velocidadeInimigo;
  for (const tipo of CONTEUDO.inimigos) {
    const i = spawnInimigo(com.estado, tipo.id);
    if (Math.abs(i.velocidade - tipo.velocidade * f) > 1e-9) {
      falhar(0, `${onde}: ${tipo.id} nasceu a ${i.velocidade} px/s, esperava ${tipo.velocidade * f}`);
    }
  }
  if (!(sem.andou > 0) || Math.abs(com.andou / sem.andou - f) > 1e-6) {
    falhar(0, `${onde}: em ${TICKS_PASSADA} ticks o inimigo andou ${com.andou.toFixed(2)}px contra ${sem.andou.toFixed(2)} sem o modificador (esperava x${f})`);
  }
  return `velocidade ${CONTEUDO.inimigos.map((t) => `${t.emoji}${t.velocidade}→${+(t.velocidade * f).toFixed(1)}`).join(' ')}; ` +
    `${com.tipo.emoji} anda ${com.andou.toFixed(1)}px em ${TICKS_PASSADA} ticks (sem: ${sem.andou.toFixed(1)})`;
}

// Roda a avaliacao sem inimigo nenhum ate `segundos`, contando os golpes por
// fonte. O que tirar HP aqui so pode ser regra.
function correrSemInimigos(estado, segundos, contagem) {
  const av = estado.run.avaliacao;
  let tick = 0;
  while (av.decorrido < segundos && (estado.tela === TELAS.AVALIACAO || estado.tela === TELAS.CARTA)) {
    tick += 1;
    atualizar(estado, PASSO);
    limparInimigos(estado);
    if (estado.tela === TELAS.CARTA) escolherCarta(estado, 0);
    for (const ev of estado.eventos) {
      if (ev.tipo === 'jogador-dano') contagem[ev.dados.fonte] = (contagem[ev.dados.fonte] || 0) + 1;
    }
    estado.eventos.length = 0;
    if (estado.player.invulneravel > 0) falhar(tick, 'a perda de HP por regra deu i-frames ao jogador');
  }
}

// perdaHp / intervaloPerdaHp (📉 Controle de Frequencia): o HP cai sozinho,
// no ritmo prometido, atravessa i-frames, sai no relatorio com a fonte certa
// (pendencia 49) e mata.
function provarPerdaHp(mod) {
  const onde = `${mod.emoji} ${mod.id}`;
  const original = CONTEUDO.debug.relatorio;
  CONTEUDO.debug.relatorio = true;
  try {
    const e = avaliacaoCom(SEMENTE + 76, [mod.id]);
    const av = e.run.avaliacao;
    const r = av.regras;
    const n = Math.max(1, Math.min(PERDAS_CONTADAS, Math.floor((av.duracao - 1) / r.intervaloPerdaHp)));
    const hp0 = e.player.hp;
    const contagem = {};
    correrSemInimigos(e, r.intervaloPerdaHp * n + 0.5, contagem);
    const perdido = hp0 - e.player.hp;
    if ((contagem[FONTE_PERDA_HP] || 0) !== n || Math.abs(perdido - n * r.perdaHp) > 1e-9) {
      falhar(0, `${onde}: em ${(r.intervaloPerdaHp * n + 0.5).toFixed(1)}s perdeu ${perdido} de HP em ${contagem[FONTE_PERDA_HP] || 0} golpes, esperava ${n * r.perdaHp} em ${n}`);
    }
    const outras = Object.keys(contagem).filter((f) => f !== FONTE_PERDA_HP);
    if (outras.length > 0) falhar(0, `${onde}: golpes de outra fonte sem inimigo na arena: ${outras.join(', ')}`);

    // Atravessa i-frames: a proxima perda cai mesmo com o jogador intocavel.
    const antes = e.player.hp;
    e.player.invulneravel = r.intervaloPerdaHp * 2;
    av.relogioPerdaHp = r.intervaloPerdaHp - PASSO / 2;
    atualizar(e, PASSO);
    if (Math.abs(antes - e.player.hp - r.perdaHp) > 1e-9) falhar(0, `${onde}: a perda de HP parou nos i-frames`);
    e.player.invulneravel = 0;

    // Mata, e o jubilamento sai no relatorio com a fonte da regra.
    e.player.hp = r.perdaHp;
    av.relogioPerdaHp = r.intervaloPerdaHp - PASSO / 2;
    atualizar(e, PASSO);
    if (e.tela !== TELAS.JUBILADO) falhar(0, `${onde}: a perda de HP zerou o jogador e a tela ficou "${e.tela}"`);
    const partida = e.telemetria.partidas[e.telemetria.partidas.length - 1];
    const reg = partida.avaliacoes[partida.avaliacoes.length - 1];
    if (!reg.morte || reg.morte.fonte !== FONTE_PERDA_HP) {
      falhar(0, `${onde}: o relatorio registrou a morte por "${reg.morte && reg.morte.fonte}", esperava "${FONTE_PERDA_HP}"`);
    }
    if (reg.fontesDano.some((f) => f.fonte === FONTE_DESCONHECIDA)) falhar(0, `${onde}: o relatorio tem dano de fonte desconhecida`);

    // Sem o modificador, o mesmo tempo sem inimigo nao tira HP nenhum.
    const neutro = avaliacaoCom(SEMENTE + 76, []);
    const contagemNeutra = {};
    correrSemInimigos(neutro, r.intervaloPerdaHp * n + 0.5, contagemNeutra);
    if (neutro.player.hp !== neutro.player.hpMax) falhar(0, `${onde}: SEM o modificador o jogador perdeu HP sem inimigo nenhum`);
    return `-${n * r.perdaHp} HP em ${(r.intervaloPerdaHp * n + 0.5).toFixed(1)}s sem inimigo (sem ele: 0), atravessa i-frames, mata, fonte "${FONTE_PERDA_HP}" no relatorio`;
  } finally {
    CONTEUDO.debug.relatorio = original;
  }
}

function nascimentosEm(p, a, mods, semente) {
  const e = avaliacaoCom(semente, mods, [], p, a);
  let nascidos = 0;
  while (e.run.avaliacao.decorrido < SEGUNDOS_NASCIMENTO && e.tela === TELAS.AVALIACAO) {
    e.player.hp = e.player.hpMax;
    atualizar(e, PASSO);
    for (const ev of e.eventos) if (ev.tipo === 'inimigo-nasceu') nascidos += 1;
    e.eventos.length = 0;
    limparInimigos(e);
    if (e.tela === TELAS.CARTA) escolherCarta(e, 0);
  }
  return nascidos;
}

// dificuldade: nenhum dos 6 mexe nela (quem mexe e a propria avaliacao, em
// periodos), mas um modificador de dado que mexesse ganharia este teste.
function provarDificuldade(mod) {
  const onde = `${mod.emoji} ${mod.id}`;
  const f = regrasEsperadas(dadosDaAvaliacao(0, 0), [mod.id]).dificuldade;
  const com = nascimentosEm(0, 0, [mod.id], SEMENTE + 77);
  const sem = nascimentosEm(0, 0, [], SEMENTE + 77);
  if (f > 1 && !(com > sem)) falhar(0, `${onde}: dificuldade x${f} e nasceram ${com} contra ${sem}`);
  if (f < 1 && !(com < sem)) falhar(0, `${onde}: dificuldade x${f} e nasceram ${com} contra ${sem}`);
  return `${com} nascimentos em ${SEGUNDOS_NASCIMENTO}s (sem: ${sem})`;
}

// Toda regra de content.js tem prova. Regra nova sem entrada aqui derruba o
// smoke: um modificador que a usasse passaria sem teste.
const PROVA_DA_REGRA = {
  velocidadeInicial: provarVelocidadeInicial,
  recuperacaoVelocidade: provarVelocidadeInicial,
  arena: provarArena,
  coringas: provarCoringas,
  hpInimigo: provarHpInimigo,
  velocidadeInimigo: provarVelocidadeInimigo,
  perdaHp: provarPerdaHp,
  intervaloPerdaHp: provarPerdaHp,
  dificuldade: provarDificuldade,
};

function provarModificador(mod) {
  const regras = [...Object.keys(mod.fatores || {}), ...Object.keys(mod.somas || {})];
  const provas = [];
  for (const regra of regras) {
    const prova = PROVA_DA_REGRA[regra];
    if (!prova) falhar(0, `modificador ${mod.id}: a regra "${regra}" nao tem prova no smoke (PROVA_DA_REGRA)`);
    if (!provas.includes(prova)) provas.push(prova);
  }
  const e = avaliacaoCom(SEMENTE + 69, [mod.id]);
  conferirRegras(e, dadosDaAvaliacao(0, 0), [mod.id], `${mod.emoji} ${mod.id}`);
  if (e.run.avaliacao.modificadores.join() !== mod.id) falhar(0, `${mod.id}: a avaliacao nao guardou o modificador`);
  return provas.map((prova) => prova(mod)).join(' · ');
}

// Tarefa 3 e criterio de aceite: cada modificador, forcado, altera o que
// promete — medido no comportamento, contra a mesma semente sem ele.
function checarModificadores() {
  const ids = CONTEUDO.modificadores.map((m) => m.id);
  for (const id of MODIFICADORES_DO_DESIGN) if (!ids.includes(id)) falhar(0, `o modificador "${id}" do design §9 sumiu de content.js`);
  for (const regra of Object.keys(CONTEUDO.regras)) {
    if (!PROVA_DA_REGRA[regra]) falhar(0, `a regra "${regra}" de content.js nao tem prova no smoke (PROVA_DA_REGRA)`);
  }
  const linhas = CONTEUDO.modificadores.map((mod) => `${mod.emoji} ${mod.nome}: ${provarModificador(mod)}`);

  // Dois juntos combinam: fatores multiplicam, somas somam.
  const dois = ids.slice(0, 2);
  conferirRegras(avaliacaoCom(SEMENTE + 69, dois), dadosDaAvaliacao(0, 0), dois, `combinacao ${dois.join('+')}`);

  // Modificador novo so por content.js: um de mentira que so mexe em regras
  // que ja existem age sem uma linha de codigo; um com a regra digitada errado
  // e recusado pelo validador.
  const original = CONTEUDO.modificadores.slice();
  try {
    const novo = { id: 'teste-mod', nome: 'Teste', emoji: '🧪', descricao: 'x', fatores: { hpInimigo: 2, velocidadeInimigo: 0.5 } };
    CONTEUDO.modificadores.push(novo);
    const { erros } = validarConteudo();
    if (erros.length > 0) falhar(0, `modificador novo de mentira recusado pelo validador: ${erros.join(' | ')}`);
    provarModificador(novo);
    CONTEUDO.modificadores.pop();
    CONTEUDO.modificadores.push({ ...novo, fatores: { hpInimgo: 2 } });
    const errosTypo = validarConteudo().erros;
    if (!errosTypo.some((m) => m.includes('hpInimgo'))) falhar(0, 'o validador aceitou um modificador com a regra "hpInimgo" (erro de digitacao)');
  } finally {
    CONTEUDO.modificadores.length = 0;
    for (const m of original) CONTEUDO.modificadores.push(m);
  }
  return linhas;
}

// O sorteio do anuncio: N distintos, nenhum da avaliacao anterior, e 0 nao
// gasta rng (a 1ª avaliacao da run joga com a semente de antes do sorteio).
function checarSorteioDeModificadores() {
  const estado = novoEstado(SEMENTE + 81);
  const rng = estado.rng;
  const ids = CONTEUDO.modificadores.map((m) => m.id);
  const vistos = new Set();
  let anteriores = [];
  const destino = [];
  for (let i = 0; i < 600; i += 1) {
    const quantos = 1 + (i % 2);
    sortearModificadores(rng, quantos, anteriores, destino);
    if (destino.length !== quantos) falhar(0, `sorteio: pediu ${quantos} modificadores e veio ${destino.length}`);
    if (new Set(destino).size !== destino.length) falhar(0, `sorteio: repetiu modificador na mesma avaliacao (${destino.join(', ')})`);
    for (const id of destino) {
      if (anteriores.includes(id)) falhar(0, `sorteio: "${id}" caiu em duas avaliacoes seguidas`);
      if (!ids.includes(id)) falhar(0, `sorteio: "${id}" nao existe em content.js`);
      vistos.add(id);
    }
    anteriores = destino.slice();
  }
  if (vistos.size !== ids.length) falhar(0, `sorteio: em 600 sorteios so ${vistos.size} de ${ids.length} modificadores apareceram`);
  const s = JSON.stringify(rng);
  sortearModificadores(rng, 0, anteriores, destino);
  if (destino.length !== 0 || JSON.stringify(rng) !== s) falhar(0, 'sorteio: pedir 0 modificadores gastou rng ou devolveu algum');
}

// Tarefa 4 e pendencia 53: o anuncio e a carta tem atraso de abertura, e o
// anuncio e uma tela parada (a avaliacao so nasce no "Comecar").
function ticksAteLiberar(estado, liberado) {
  let t = 0;
  while (!liberado(estado) && t < 1000) {
    atualizar(estado, PASSO);
    t += 1;
  }
  return t;
}

function checarAnuncioECarta() {
  const e = novoEstado(SEMENTE + 80);
  iniciarRun(e);
  const dados = dadosDaAvaliacao(0, 0);
  if (e.tela !== TELAS.ANUNCIO) falhar(0, `iniciarRun foi a "${e.tela}", esperava o anuncio`);
  if (e.run.proxima.periodoIndex !== 0 || e.run.proxima.avaliacaoIndex !== 0) falhar(0, 'o anuncio da run nova nao e o da 1a avaliacao');
  if (e.run.proxima.modificadores.length !== dados.modificadores) falhar(0, 'o anuncio da 1a avaliacao sorteou modificadores de mais ou de menos');
  if (anuncioLiberado(e)) falhar(0, 'anuncio: o "Comecar" ja vale no instante em que a tela abre');
  const esperadoAnuncio = Math.ceil(CONTEUDO.anuncio.atrasoEntrada / PASSO - 1e-9);
  // Com o direcional pressionado: se a simulacao rodasse no anuncio, o
  // cronometro andaria e o jogador sairia do lugar ja no 1o tick (os inimigos
  // so nasceriam depois do 1o intervalo de spawn, tarde demais para o teste).
  const antes = { x: e.player.x, y: e.player.y, decorrido: e.run.avaliacao.decorrido };
  e.input.eixoX = 1;
  const tAnuncio = ticksAteLiberar(e, anuncioLiberado);
  e.input.eixoX = 0;
  if (Math.abs(tAnuncio - esperadoAnuncio) > 1) falhar(0, `anuncio: liberou em ${tAnuncio} ticks, esperava ~${esperadoAnuncio}`);
  if (e.tela !== TELAS.ANUNCIO) falhar(0, `anuncio: a tela virou "${e.tela}" sozinha`);
  if (e.run.avaliacao.decorrido !== antes.decorrido) {
    falhar(0, `anuncio: o cronometro andou por tras da tela (${antes.decorrido} -> ${e.run.avaliacao.decorrido}s em ${tAnuncio} ticks)`);
  }
  if (e.player.x !== antes.x || e.player.y !== antes.y) {
    falhar(0, `anuncio: o jogador andou por tras da tela (${antes.x},${antes.y} -> ${e.player.x},${e.player.y})`);
  }
  if (e.enemies.length > 0) falhar(0, 'anuncio: nasceram inimigos por tras da tela de anuncio');
  if (!comecarProxima(e) || e.tela !== TELAS.AVALIACAO) falhar(0, `anuncio: o "Comecar" levou a "${e.tela}"`);
  if (comecarProxima(e)) falhar(0, 'anuncio: comecarProxima agiu fora da tela de anuncio');
  const armas = e.player.armas;
  if (armas.length !== 1 || armas[0].id !== CONTEUDO.arma.inicial || armas[0].nivel !== 1) {
    falhar(0, `a avaliacao comecou com as armas [${armas.map((x) => `${x.id}:${x.nivel}`).join(', ')}], esperava so a inicial no nivel 1`);
  }
  // A arma inicial nao volta sozinha (pendencia 21): sem arma, sem arma.
  armas.length = 0;
  atualizar(e, PASSO);
  if (e.player.armas.length !== 0) falhar(0, 'a arma inicial foi reequipada no meio da avaliacao (garantirArmaInicial por tick)');

  // Carta: duas de uma vez na fila, cada uma com o seu atraso.
  limparInimigos(e);
  e.player.xp = xpParaSubir(1) + xpParaSubir(2);
  atualizar(e, PASSO);
  if (e.tela !== TELAS.CARTA || e.cartas.fila < 1) falhar(0, `carta: dois niveis de XP e a tela ficou "${e.tela}" com fila ${e.cartas.fila}`);
  if (cartaLiberada(e)) falhar(0, 'carta: a escolha ja vale no tick em que a carta abre');
  const esperadoCarta = Math.ceil(CONTEUDO.cartas.atrasoEntrada / PASSO - 1e-9);
  const tCarta = ticksAteLiberar(e, cartaLiberada);
  if (Math.abs(tCarta - esperadoCarta) > 1) falhar(0, `carta: liberou em ${tCarta} ticks, esperava ~${esperadoCarta}`);
  escolherCarta(e, 0);
  atualizar(e, PASSO);
  if (e.tela !== TELAS.CARTA) falhar(0, 'carta: a segunda carta da fila nao abriu');
  if (cartaLiberada(e)) falhar(0, 'carta: a segunda carta da fila abriu ja liberada — o Enter da primeira escolheria a segunda');
}

// Criterio de aceite: nenhuma logica especial de "prova final" (nem de um
// modificador especifico) em src/. Nenhum .js de logica pode ter como string
// o id ou o tipo de uma avaliacao, nem o id de um modificador.
function checarProvaFinalSoDado() {
  const proibidos = new Set();
  for (const periodo of CONTEUDO.periodos) {
    for (const av of periodo.avaliacoes) {
      proibidos.add(av.id);
      proibidos.add(av.tipo);
    }
  }
  for (const mod of CONTEUDO.modificadores) proibidos.add(mod.id);
  const pasta = new URL('../src/', import.meta.url);
  for (const nome of readdirSync(pasta)) {
    if (!nome.endsWith('.js')) continue;
    const texto = readFileSync(new URL(nome, pasta), 'utf8');
    for (const m of texto.matchAll(/(['"])([^'"\\\n]*)\1/g)) {
      if (proibidos.has(m[2])) {
        falhar(0, `src/${nome} tem a string "${m[2]}" — logica especial de avaliacao ou modificador; isso mora em content.js`);
      }
    }
  }
}

// ------------------------------------------------------ fase 08: a run

// Compra o que der: o mais caro que couber primeiro, ate acabar o credito ou
// a vaga. Sem reroll e sem venda — e um jogador simples, nao um otimo.
function comprarOQueDer(estado) {
  const loja = estado.loja;
  const ordem = [];
  for (let i = 0; i < loja.quantidade; i += 1) if (loja.itens[i].id !== '') ordem.push(i);
  ordem.sort((x, y) => loja.itens[y].preco - loja.itens[x].preco);
  const comprados = [];
  let gasto = 0;
  for (const i of ordem) {
    const item = loja.itens[i];
    if (item.preco > estado.run.creditos || estado.run.coringas.length >= CONTEUDO.loja.teto) continue;
    const preco = item.preco;
    if (comprarItem(estado, i)) {
      comprados.push(item.id);
      gasto += preco;
    }
  }
  return { comprados, gasto };
}

// Tarefa 6 e criterio de aceite: a run INTEIRA pelas portas do jogo — menu,
// anuncio, avaliacao, boletim, loja, anuncio... TCC, menu — com o botDesvio.
// Corre de dois jeitos, com a mesma semente:
//   - `estrutural` (HP segurado e telemetria ligada): TEM que chegar ao TCC.
//     Prova a maquina de estados, o sorteio sem repeticao, a virada de
//     periodo e a telemetria (pendencia 50: uma run = UMA partida com as 9
//     avaliacoes dentro).
//   - de balanceamento (HP de verdade): a tabela da fase 13. Nao exige
//     sobreviver — jogo dificil demais para o bot nao e jogo quebrado —, a
//     tabela mostra onde e como a run acabou.
// Devolve as linhas da tabela.
function correrRunInteira(semente, { estrutural }) {
  const original = CONTEUDO.debug.relatorio;
  CONTEUDO.debug.relatorio = estrutural;
  try {
    const estado = novoEstado(semente);
    const ordem = CONTEUDO.periodos.flatMap((p, pi) => p.avaliacoes.map((av, ai) => ({ pi, ai, id: av.id })));
    const linhas = [];
    let anteriores = [];
    let tick = 0;
    const comecou = Date.now();
    iniciarRun(estado);

    for (let n = 0; n < ordem.length; n += 1) {
      const alvo = ordem[n];
      const onde = `run inteira, avaliacao ${n + 1} (${alvo.id})`;
      const prox = estado.run.proxima;
      const dados = dadosDaAvaliacao(alvo.pi, alvo.ai);
      if (estado.tela !== TELAS.ANUNCIO) falhar(tick, `${onde}: esperava o anuncio e a tela e "${estado.tela}"`);
      if (prox.periodoIndex !== alvo.pi || prox.avaliacaoIndex !== alvo.ai) {
        falhar(tick, `${onde}: o anuncio e o de periodos[${prox.periodoIndex}].avaliacoes[${prox.avaliacaoIndex}]`);
      }
      if (prox.modificadores.length !== dados.modificadores) {
        falhar(tick, `${onde}: o anuncio sorteou ${prox.modificadores.length} modificadores, o dado pede ${dados.modificadores}`);
      }
      for (const id of prox.modificadores) {
        if (anteriores.includes(id)) falhar(tick, `${onde}: "${id}" repetiu da avaliacao anterior`);
      }
      const mods = prox.modificadores.slice();
      // O Enter duplo que saiu da loja nao comeca a prova: o anuncio espera.
      tick += ticksAteLiberar(estado, anuncioLiberado);
      if (!comecarProxima(estado)) falhar(tick, `${onde}: o "Comecar" do anuncio foi recusado`);
      const av = estado.run.avaliacao;
      if (av.id !== alvo.id || av.modificadores.join() !== mods.join()) {
        falhar(tick, `${onde}: comecou "${av.id}" com [${av.modificadores}], o anuncio dizia "${alvo.id}" com [${mods}]`);
      }
      conferirRegras(estado, dados, mods, onde);
      if (estado.player.armas.length !== 1 || estado.player.armas[0].id !== CONTEUDO.arma.inicial) {
        falhar(tick, `${onde}: a avaliacao nao comecou com a arma inicial`);
      }
      const naMao = estado.run.coringas.map((c) => c.id);
      const creditosAntes = estado.run.creditos;

      while (!telaDeFim(estado)) {
        tick += 1;
        botDesvio(estado);
        if (estrutural) estado.player.hp = estado.player.hpMax;
        try {
          atualizar(estado, PASSO);
        } catch (err) {
          falhar(tick, `${onde}: excecao: ${err && err.stack ? err.stack : err}`);
        }
        if (estado.tela === TELAS.CARTA) escolherCarta(estado, 0);
        estado.eventos.length = 0;
        if (tick % INTERVALO_VARREDURA === 0) {
          const ruim = procurarNumeroInvalido(estado, 'estado', new Set(), 0);
          if (ruim) falhar(tick, `${onde}: numero invalido: ${ruim}`);
        }
        if (av.decorrido > av.duracao + 5) falhar(tick, `${onde}: a avaliacao passou do cronometro sem terminar`);
      }

      const r = estado.run.resultado;
      const linha = {
        n: n + 1,
        id: av.id,
        materia: av.materia,
        duracao: av.duracao,
        dificuldade: av.regras.dificuldade,
        mods,
        aprovado: r.aprovado,
        tempo: r.tempo,
        nota: r.nota,
        conceito: r.conceito,
        kills: r.kills,
        hp: r.hpFracao,
        nivel: estado.player.nivel,
        ganhos: r.creditos,
        gasto: 0,
        saldo: estado.run.creditos,
        naMao,
        comprados: [],
      };
      linhas.push(linha);
      if (estado.tela === TELAS.JUBILADO) {
        if (estrutural) falhar(tick, `${onde}: jubilado com o HP segurado`);
        if (!sairDoResultado(estado) || estado.tela !== TELAS.MENU) falhar(tick, `${onde}: o jubilado levou a "${estado.tela}"`);
        return { linhas, ticks: tick, ms: Date.now() - comecou, semente, jubilado: true };
      }
      if (estado.run.creditos !== creditosAntes + r.creditos) falhar(tick, `${onde}: os creditos nao somaram o boletim`);
      if (!sairDoResultado(estado) || estado.tela !== TELAS.LOJA) falhar(tick, `${onde}: o boletim aprovado levou a "${estado.tela}"`);
      const compra = comprarOQueDer(estado);
      linha.gasto = compra.gasto;
      linha.comprados = compra.comprados;
      linha.saldo = estado.run.creditos;
      if (linha.saldo !== creditosAntes + r.creditos - compra.gasto) falhar(tick, `${onde}: a loja cobrou diferente do preco`);
      if (!seguirDaLoja(estado)) falhar(tick, `${onde}: o "Seguir" da loja foi recusado`);
      anteriores = mods;
    }

    if (estado.tela !== TELAS.TCC) falhar(tick, `depois da loja da ultima avaliacao a tela e "${estado.tela}", esperava o TCC`);
    // Um tick parado no TCC e outro no menu: a telemetria fecha a partida ao ver o menu.
    atualizar(estado, PASSO);
    if (!sairDoTcc(estado) || estado.tela !== TELAS.MENU) falhar(tick, `a saida do TCC foi a "${estado.tela}"`);
    atualizar(estado, PASSO);
    const resumo = { linhas, ticks: tick, ms: Date.now() - comecou, semente, jubilado: false };
    if (!estrutural) return resumo;

    const tel = estado.telemetria;
    if (tel.partidas.length !== 1) falhar(tick, `a run inteira virou ${tel.partidas.length} partidas no relatorio, esperava 1`);
    const partida = tel.partidas[0];
    if (partida.avaliacoes.length !== ordem.length) {
      falhar(tick, `a partida do relatorio tem ${partida.avaliacoes.length} avaliacoes, esperava ${ordem.length}`);
    }
    partida.avaliacoes.forEach((reg, i) => {
      if (reg.id !== ordem[i].id || reg.situacao !== SITUACAO.APROVADO) {
        falhar(tick, `relatorio: a ${i + 1}a avaliacao e "${reg.id}" (${reg.situacao}), esperava "${ordem[i].id}" aprovada`);
      }
      if (reg.modificadores.join() !== linhas[i].mods.join()) falhar(tick, `relatorio: "${reg.id}" registrou os modificadores errados`);
      if (reg.fontesDano.some((f) => f.fonte === FONTE_DESCONHECIDA)) falhar(tick, `relatorio: "${reg.id}" tem dano de fonte desconhecida`);
    });
    if (partida.situacao !== SITUACAO.ENCERRADA) falhar(tick, `relatorio: a run terminada no TCC ficou "${partida.situacao}"`);
    if (partida.creditos !== linhas[linhas.length - 1].saldo) falhar(tick, 'relatorio: os creditos da partida nao batem com o saldo final');
    return resumo;
  } finally {
    CONTEUDO.debug.relatorio = original;
  }
}

// Jubilado no meio da run: menu, partida fechada como jubilada no relatorio, e
// o "Jogar" seguinte comeca do zero (sem save).
function checarJubiladoNoMeioDaRun() {
  const original = CONTEUDO.debug.relatorio;
  CONTEUDO.debug.relatorio = true;
  try {
    const e = novoEstado(SEMENTE + 82);
    comecarRun(e);
    atualizar(e, PASSO);
    e.run.avaliacao.decorrido = e.run.avaliacao.duracao - PASSO / 2;
    atualizar(e, PASSO);
    if (e.tela !== TELAS.RESULTADO) falhar(0, `jubilado no meio: a 1a avaliacao terminou em "${e.tela}"`);
    sairDoResultado(e);
    e.run.coringas.push(novaInstancia(CONTEUDO.coringas[0].id));
    seguirDaLoja(e);
    ticksAteLiberar(e, anuncioLiberado);
    comecarProxima(e);
    if (e.run.avaliacaoIndex !== 1 || e.tela !== TELAS.AVALIACAO) falhar(0, 'jubilado no meio: nao chegou a 2a avaliacao');
    atualizar(e, PASSO);
    const hpAntes = e.player.hp;
    receberDano(e, e.player.hpMax * 3);
    emitir(e, 'jogador-dano', { fonte: CONTEUDO.inimigos[0].id, dano: hpAntes - e.player.hp, hp: e.player.hp, x: e.player.x, y: e.player.y });
    atualizar(e, PASSO);
    if (e.tela !== TELAS.JUBILADO) falhar(0, `jubilado no meio: o golpe fatal levou a "${e.tela}"`);
    if (!sairDoResultado(e) || e.tela !== TELAS.MENU) falhar(0, `jubilado no meio: o boletim levou a "${e.tela}", esperava o menu`);
    atualizar(e, PASSO);
    const partida = e.telemetria.partidas[e.telemetria.partidas.length - 1];
    if (partida.avaliacoes.length !== 2 || partida.situacao !== SITUACAO.JUBILADO) {
      falhar(0, `jubilado no meio: o relatorio tem ${partida.avaliacoes.length} avaliacoes e situacao "${partida.situacao}"`);
    }
    iniciarRun(e);
    const run = e.run;
    if (run.creditos !== 0 || run.coringas.length !== 0 || run.proxima.periodoIndex !== 0 || run.proxima.avaliacaoIndex !== 0) {
      falhar(0, 'jubilado no meio: o "Jogar" seguinte herdou creditos, coringas ou a posicao da run anterior');
    }
  } finally {
    CONTEUDO.debug.relatorio = original;
  }
}

// A tabela da run: o instrumento de balanceamento da fase 13. Colunas de
// largura fixa; os emojis ficam so no fim da linha, onde nao desalinham nada.
function tabelaDaRun(linhas) {
  const col = (texto, largura, direita = false) => (direita ? String(texto).padStart(largura) : String(texto).padEnd(largura));
  const cab =
    `${col('#', 2)} ${col('avaliacao', 36)} ${col('seg', 3, true)} ${col('dif', 4, true)} ${col('modificadores', 28)} ` +
    `${col('nota', 7, true)} ${col('', 1)} ${col('kills', 5, true)} ${col('HP', 4, true)} ${col('niv', 3, true)} ` +
    `${col('+cred', 5, true)} ${col('-loja', 5, true)} ${col('saldo', 5, true)}  coringas na prova (+ comprados na loja depois)`;
  const saida = [cab, '-'.repeat(cab.length + 4)];
  for (const l of linhas) {
    const nota = l.aprovado ? formatarNota(l.nota) : `JUB ${l.tempo.toFixed(0)}s`;
    const mao = l.naMao.length > 0 ? emojisDosCoringas(l.naMao.map((id) => ({ id }))) : '-';
    const compra = l.comprados.length > 0 ? `  (+ ${emojisDosCoringas(l.comprados.map((id) => ({ id })))})` : '';
    saida.push(
      `${col(l.n, 2)} ${col(`${l.id} ${l.materia}`, 36)} ${col(l.duracao, 3, true)} ${col(l.dificuldade.toFixed(2), 4, true)} ` +
        `${col(l.mods.length > 0 ? l.mods.join('+') : '-', 28)} ${col(nota, 7, true)} ${col(l.conceito || '-', 1)} ` +
        `${col(l.kills, 5, true)} ${col(`${Math.round(l.hp * 100)}%`, 4, true)} ${col(l.nivel, 3, true)} ` +
        `${col(`+${l.ganhos}`, 5, true)} ${col(`-${l.gasto}`, 5, true)} ${col(l.saldo, 5, true)}  ${mao}${compra}`
    );
  }
  return saida;
}

// ------------------------------------------------------------------ corrida

checarReciclagemDaPool();
// Antes de qualquer coisa que dispare ou se mova: um `comportamento`
// digitado errado (arma ou inimigo) mata o update com stack trace cru, e a
// mensagem limpa daqui e que diz o que aconteceu.
checarInimigosDoConteudo();
checarArmasDoConteudo();
checarNiveisDaArma();
checarGuardaDeGeracao();
checarMemoriaDePerfuracao();
checarGuardaDeGeracaoOrbital();
const filhoteSemImunidade = checarFilhoteNaoHerdaImunidadeDeGolpe();
checarCooldownPorInimigoOrbital();
checarCooldownComEnxameOrbital();
checarFeixeContinuo();
checarCartasDoConteudo();
checarImaDeOrbes();
checarFilaDeCartas();
checarCartasNoMaximo();
checarSorteioDeCartas();
checarTelaDeResultado();
checarTelaDeJubilado();
checarNovaRunZeraCreditos();
checarPausa();
checarCoringasDoConteudo();
checarAtestado();
checarEfeitosDosCoringas();
checarCoringaNovoSoPorConteudo();
checarLoja();
checarRerollGratisESemNovidade();
checarSorteioDeModificadores();
checarAnuncioECarta();
checarProvaFinalSoDado();
checarJubiladoNoMeioDaRun();
checarTiposIsolados();
const empurraoNaArena = checarEmpurraoNaArena();
const empurraoCampoAberto = checarEmpurraoEmCampoAberto();
const divisao = checarDivisaoTrabalhoEmGrupo();
const separacaoTamanhos = checarSeparacaoEntreTamanhos();
const rajada = checarRajadaIsolada();
const ruidoNotificacao = checarRuidoNotificacao();
const composicaoMisturada = checarComposicaoMisturada();
const picoOrbitalPdf = medirPicoOrbitalComPdf();
const modificadores = checarModificadores();
// A semente da run da tabela: escolhida medindo, porque sorteia os 6
// modificadores ao longo da run (SEMENTE+60 nao sorteia a Prova sem Consulta).
const SEMENTE_RUN = SEMENTE + 61;
const runEstrutural = correrRunInteira(SEMENTE_RUN, { estrutural: true });
const runInteira = correrRunInteira(SEMENTE_RUN, { estrutural: false });
const coringas = checarSeisCoringas();
const corridaArma = checarArmaSozinha();
const especializacao = checarArmasEspecializadas();
const progressao = checarProgressao();
const boletim = checarAvaliacaoCompleta();
const estilos = checarCantoContraDesvio();
const economia = checarGuardarDinheiro(estilos.desvio);
const relatorio = checarRelatorio();
checarRelatorioFinsAlternativos();

const estado = novoEstado(SEMENTE);
comecarAvaliacao(estado);

function rodarTick(estado, tick, { reiniciarAvaliacao = true } = {}) {
  botCircular(estado, tick);
  manterCarga(estado);

  try {
    atualizar(estado, PASSO);
  } catch (e) {
    falhar(tick, `excecao em atualizar(): ${e && e.stack ? e.stack : e}`);
  }

  // O bot sempre pega a primeira carta. Sem isso a simulacao congela na tela
  // de carta e a corrida inteira para no primeiro nivel — que e exatamente o
  // que aconteceu quando esta fase ligou a pausa antes de ensinar o bot.
  if (estado.tela === TELAS.CARTA && escolherCarta(estado, 0)) contadores.cartas += 1;

  registrarMovimento(estado);
  registrarDano(estado);

  for (const verificacao of VERIFICACOES) {
    let problema = null;
    try {
      problema = verificacao.rodar(estado, tick);
    } catch (e) {
      problema = `a propria verificacao explodiu: ${e && e.message ? e.message : e}`;
    }
    if (problema) falhar(tick, `[${verificacao.nome}] ${problema}`);
  }

  // Faz o papel do consumidor da fila (audio/juice no navegador).
  for (const evento of estado.eventos) {
    contadores.eventos += 1;
    contadores.porTipo[evento.tipo] = (contadores.porTipo[evento.tipo] || 0) + 1;
  }
  estado.eventos.length = 0;

  // A avaliacao acabou numa das duas telas de fim: fecha o boletim pela mesma
  // porta que o botao e o Enter usam e comeca a proxima, para que os ticks
  // todos rodem dentro da jogabilidade e nao parados numa tela.
  if (telaDeFim(estado)) {
    contadores.avaliacoesConcluidas += 1;
    contadores.notas.push(estado.run.resultado.nota);
    contadores.conceitos.push(estado.run.resultado.conceito || '-');
    if (!sairDoResultado(estado)) falhar(tick, 'sairDoResultado() nao fechou a tela de fim de avaliacao');
    // Aprovado cai na loja, jubilado no menu (fase 07).
    if (!foraDaAvaliacao(estado)) falhar(tick, `depois da tela de fim a tela ficou "${estado.tela}"`);
    if (reiniciarAvaliacao) comecarAvaliacao(estado);
  }
}

const comecou = Date.now();
for (let tick = 1; tick <= TICKS; tick += 1) rodarTick(estado, tick);

// O caminho de fim por tempo precisa rodar em toda corrida. Duas coisas
// atrapalham: dt fixo acumula erro de ponto flutuante (3600 * 1/60 da
// 59,9999...s, entao uma avaliacao de 60s nao fecha dentro do laco) e, desde
// a fase 02, o jogador morre antes dos 60s e a avaliacao seguinte comeca
// desalinhada. Adianta-se o cronometro para o ultimo segundo e segura-se o hp
// para que o encerramento seja o do timer, nao o de jubilamento.
const TOLERANCIA_FIM = 120;
if (foraDaAvaliacao(estado)) comecarAvaliacao(estado);
estado.run.avaliacao.decorrido = estado.run.avaliacao.duracao - 1;
let extras = 0;
// rodarTick ja sai da tela de fim assim que ela aparece (aprovado vai para a
// LOJA, jubilado para o MENU), entao o alvo aqui e qualquer um dos dois
// (foraDaAvaliacao): e ele que prova que o ciclo inteiro fechou.
while (!foraDaAvaliacao(estado) && extras < TOLERANCIA_FIM) {
  extras += 1;
  estado.player.hp = estado.player.hpMax;
  rodarTick(estado, TICKS + extras, { reiniciarAvaliacao: false });
}
if (!foraDaAvaliacao(estado)) {
  falhar(TICKS + extras, `a avaliacao nao encerrou ${TOLERANCIA_FIM} ticks depois da duracao`);
}
if (!contadores.porTipo['avaliacao-fim']) {
  falhar(TICKS + extras, 'nenhum evento avaliacao-fim na corrida: o fim por tempo nao rodou');
}
// O evento que a fase 11 vai ouvir para a fanfarra de aprovacao. Ele sai de
// fecharAvaliacao(), entao sem ele nao houve boletim nenhum nesta corrida.
if (!contadores.porTipo['resultado']) {
  falhar(TICKS + extras, 'nenhum evento resultado na corrida: fecharAvaliacao() foi chamado?');
}
if (contadores.notas.length !== contadores.avaliacoesConcluidas) {
  falhar(
    TICKS + extras,
    `${contadores.avaliacoesConcluidas} avaliacoes encerradas e ${contadores.notas.length} notas registradas`
  );
}

// O bot circular gira devagar (uma volta a cada 10s) contra um jogador que
// acelera rapido (~0,14s ate a velocidade maxima) — em 60s+ isso soma muitos
// milhares de px e varre boa parte da arena nos dois eixos. Estes minimos
// ficam bem abaixo do que qualquer movimento real produz; so pegam o jogador
// parado (distancia e amplitude ficariam em 0).
const DISTANCIA_MINIMA = 2000;
const AMPLITUDE_MINIMA = 200;
const amplitudeX = maxX - minX;
const amplitudeY = maxY - minY;
if (distanciaPercorrida < DISTANCIA_MINIMA || amplitudeX < AMPLITUDE_MINIMA || amplitudeY < AMPLITUDE_MINIMA) {
  falhar(
    TICKS + extras,
    `jogador praticamente parado: distancia=${distanciaPercorrida.toFixed(1)}px (minimo ${DISTANCIA_MINIMA}), ` +
      `amplitude=${amplitudeX.toFixed(1)}x${amplitudeY.toFixed(1)}px (minimo ${AMPLITUDE_MINIMA} por eixo) — ` +
      'atualizarPlayer() esta sendo chamado dentro de atualizarAvaliacao()?'
  );
}

// Inimigos: as tres asserções da fase 02 que so valem no fim da corrida. Sem
// elas as verificacoes por tick passariam iguais com o spawn desligado — uma
// arena vazia nao tem inimigo com NaN nem pool crescendo.
if (picos.enemies < MINIMO_INIMIGOS) {
  falhar(TICKS + extras, `pico de inimigos foi ${picos.enemies} (minimo ${MINIMO_INIMIGOS}): o spawn rodou?`);
}
if (danoTotal <= 0) {
  falhar(TICKS + extras, 'o jogador nao tomou dano nenhum: inimigos perseguem e colidem?');
}
if (!contadores.porTipo['inimigo-morto']) {
  falhar(TICKS + extras, 'nenhum inimigo morreu: as armas atiraram e aplicarDano() devolveu alguem a pool?');
}
// Desde a fase 03 nada mais mata inimigo no smoke — quem abatia era um bot de
// mentira, removido junto com esta fase. Se as armas pararem de ser chamadas em
// atualizarAvaliacao(), estas duas assercoes caem juntas.
if (picos.projectiles === 0) {
  falhar(TICKS + extras, 'nenhum projetil foi disparado na corrida: atualizarArmas() roda dentro do update?');
}
const poolFinal = poolInimigos(estado);
if (poolFinal.criados !== poolFinal.capacidade) {
  falhar(
    TICKS + extras,
    `pool de inimigos fabricou ${poolFinal.criados} objetos para uma capacidade de ${poolFinal.capacidade}`
  );
}

const segundos = (Date.now() - comecou) / 1000;
const picosTexto = POOLS.map((p) => `${p}=${picos[p]}`).join(' ');
const poolProjetil = poolProjeteis(estado);
console.log(
  `smoke ok${CARGA ? ' (carga)' : ''} — ${TICKS}+${extras} ticks (${((TICKS + extras) * PASSO).toFixed(1)}s simulados` +
    ` em ${segundos.toFixed(2)}s) · avaliacoes=${contadores.avaliacoesConcluidas}` +
    ` · eventos=${contadores.eventos} · hp=${estado.player.hp}/${estado.player.hpMax}` +
    ` · nivel=${estado.player.nivel} · distancia=${distanciaPercorrida.toFixed(0)}px` +
    ` · amplitude=${amplitudeX.toFixed(0)}x${amplitudeY.toFixed(0)}px` +
    ` · dano=${danoTotal} · jubilado=${contadores.porTipo.jubilado || 0}` +
    ` · mortos=${contadores.porTipo['inimigo-morto'] || 0}` +
    ` · disparos=${contadores.porTipo['arma-disparo'] || 0}` +
    ` acertos=${contadores.porTipo['arma-acerto'] || 0}` +
    ` · pool inimigos: criados=${poolFinal.criados} reciclados=${poolFinal.reciclados}` +
    ` ressinc=${poolFinal.ressincronizacoes}` +
    ` · pool projeteis: criados=${poolProjetil.criados} nascimentos=${poolProjetil.nascimentos}` +
    ` reciclados=${poolProjetil.reciclados}` +
    ` · bot parado: mortos=${corridaArma.mortos} disparos=${corridaArma.disparos}` +
    ` pico=${corridaArma.pico}/${corridaArma.teto}` +
    ` · picos: ${picosTexto}` +
    // O numero de balanceamento que as fases seguintes herdam: nivel atingido
    // em 60s de avaliacao, com o bot pegando sempre a primeira carta.
    // Corrida propria, com semente propria (SEMENTE+5) e HP segurado: por isso
    // esta linha nao muda entre `smoke` e `smoke:carga` — o modo de carga so
    // mexe em spawn.maxSimultaneos, que a curva de spawn nem alcanca em 60s.
    `\n  progressao em 60s (corrida dedicada, semente fixa): NIVEL ${progressao.nivel}` +
    ` · cartas=${progressao.cartas} · xp ${progressao.xpColetado} coletado` +
    ` + ${progressao.xpNoChao} no chao = ${progressao.xpSoltado} solto por ${progressao.mortos} mortes` +
    ` · pico de orbes no chao=${progressao.orbesPico}` +
    // O boletim que o contrato da fase 06 pede impresso. Corrida dedicada
    // (SEMENTE+11), avaliacao inteira, bot circular pegando sempre a primeira
    // carta e SEM segurar o HP — a corrida principal segura, e a nota dela
    // nao valeria nada.
    `\n  boletim em 60s (corrida dedicada, semente fixa): NOTA ${formatarNota(boletim.nota)}` +
    ` · CONCEITO ${boletim.conceito} · ${boletim.creditos} creditos` +
    ` · ${boletim.decomposicao}` +
    // Ajuste pos-checkpoint 1: os dois extremos de estilo, cada um com a
    // sua semente (SEMENTE+12 canto, SEMENTE+13 desvio) e HP de verdade.
    `
  parado no canto (SEMENTE+12): ${descreverCorrida(estilos.canto)}` +
    `
  desviando (SEMENTE+13): ${descreverCorrida(estilos.desvio)}` +
    `\n  6 coringas (desvio, SEMENTE+47): SEM ${descreverComCoringas(coringas.sem)}` +
    `\n                                 COM ${descreverComCoringas(coringas.com)}` +
    `\n  economia: o desvio rende ${economia.creditos} creditos por avaliacao; os caros custam ${economia.caros}` +
    `\n  cartas na corrida principal=${contadores.cartas}` +
    ` · notas da corrida principal=${contadores.notas.map((n) => formatarNota(n)).join('/')}` +
    ` (${contadores.conceitos.join('/')})` +
    // Insumo do balanceamento da fase 13 (tarefa 6 do contrato): cada arma
    // sozinha, no nivel maximo, 60s, corrida propria (SEMENTE+300+indice).
    `\n  arsenal especializado (60s cada, nivel maximo, corridas proprias): ` +
    especializacao.map((r) => `${r.nome}=${r.kills}kills/${r.acertos}acertos`).join(' · ') +
    // O relatorio de balanceamento (debug.relatorio): as contas fecharam com o
    // boletim, e ligar ou desligar nao mudou a partida.
    `\n  relatorio (circular, SEMENTE+23 e +19): ${relatorio.reg.situacao} com ${relatorio.reg.golpes.length} golpes` +
    ` e ${relatorio.regJubilado.situacao} com ${relatorio.regJubilado.golpes.length}` +
    ` · ${relatorio.reg.amostras.length} amostras · ${relatorio.reg.cartas.length} cartas` +
    ` · texto ${Object.entries(relatorio.tamanhos).map(([e, n]) => `${e}=${(n / 1024).toFixed(0)}KB`).join(' ')}` +
    ` · corrida ${relatorio.msLigada}ms ligada / ${relatorio.msDesligada}ms desligada` +
    // Fase 09: o bestiario completo.
    `\n  divisao (Trabalho em Grupo): ${divisao}` +
    `\n  filhote sem imunidade de golpe: ${filhoteSemImunidade}` +
    `\n  empurrao do PDF (arena): ${empurraoNaArena}` +
    `\n  empurrao do PDF (campo aberto): ${empurraoCampoAberto}` +
    `\n  separacao entre tamanhos (pendencia 17): ${separacaoTamanhos}` +
    `\n  rajada (Notificação): ${rajada}` +
    `\n  ruido (Notificação): ${ruidoNotificacao}` +
    `\n  composicao misturada (p2-av1, 'todos', 90s, HP segurado): nasceram ` +
    Object.entries(composicaoMisturada.porTipo).map(([id, n]) => `${id}=${n}`).join(' ') +
    ` · pico de orbes=${composicaoMisturada.orbesPico}/${composicaoMisturada.capacidadeOrbes}` +
    ` reciclados=${composicaoMisturada.reciclados} (pendencia 28)` +
    `\n  pico orbital com PDF real (Caneta nivel maximo, arena cheia de PDF, 60s): ` +
    `${picoOrbitalPdf.pico} entradas vivas simultaneas de ${picoOrbitalPdf.capacidade} slots (pendencia 32)` +
    // Fase 08: cada modificador forcado contra a mesma semente sem ele, e a
    // run inteira — a tabela que a fase 13 le para balancear.
    `\n  modificadores (cada um forcado, contra a mesma semente sem ele):` +
    modificadores.map((l) => `\n    ${l}`).join('') +
    `\n  run inteira, estrutural (HP segurado, relatorio ligado): ${runEstrutural.linhas.length} avaliacoes + ` +
    `${runEstrutural.linhas.length} lojas ate o TCC em ${(runEstrutural.ms / 1000).toFixed(2)}s · 1 partida no relatorio` +
    `\n  run inteira, balanceamento (botDesvio, HP de verdade, 1a carta, compra o mais caro que couber; SEMENTE+${SEMENTE_RUN - SEMENTE}, ` +
    `${runInteira.ticks} ticks em ${(runInteira.ms / 1000).toFixed(2)}s): ` +
    (runInteira.jubilado ? `JUBILADO na ${runInteira.linhas.length}a avaliacao` : 'chegou ao TCC') +
    tabelaDaRun(runInteira.linhas).map((l) => `\n    ${l}`).join('')
);
