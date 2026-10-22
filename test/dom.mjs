// npm run dom — o jogo inteiro num navegador de mentira (test/dom-falso.mjs),
// pelo caminho do jogador: iniciar() com o index.html de verdade, teclado e
// clique entrando pelos escutadores, requestAnimationFrame rodando quadro a
// quadro, ui.js escrevendo no DOM e render.js desenhando num canvas que
// registra o que recebeu. E o que o smoke nao alcanca (pendencia 4).
//
// O que reprova:
//   - fiacao: id que ui.js procura e o index.html nao tem; excecao em
//     qualquer camada do quadro; console.error; loop que para de agendar;
//   - teclado: ESC, M, 1/2/3, setas, Enter, Espaco em TODA tela fazendo o
//     que a tela promete, e nenhuma tecla que role a pagina sem
//     preventDefault (pendencia da tarefa 4);
//   - foco: blur e troca de aba em toda tela (so a prova pausa; nenhuma
//     tecla fica presa; a aba que volta 30s depois nao pula o jogo);
//   - clique: clique duplo (rapido e lento, o 2o clique caindo na tela
//     nova) na compra, na venda, na carta, no "Seguir" e nos botoes que levam
//     ao menu; Enter com o foco num botao visivel (age o botao) ou escondido
//     (age a tela); os botoes da pausa nao agem por cima da carta e da loja;
//   - emoji: maquina sem fonte de emoji ganha forma colorida no lugar do
//     tofu, e uma leitura de canvas nao confiavel nao troca nada;
//   - 5 runs seguidas sem recarregar: escutadores, nos do DOM e pools nao
//     crescem (tarefa 3), e a 5a run de um navegador usado e IDENTICA, quadro
//     a quadro — estado, DOM visivel e desenho —, a uma run de um navegador
//     recem-aberto com a mesma semente (tarefa 5, reinicio limpo).
//
// Rodar com `npm run dom` (node --expose-gc: o heap depois de cada run entra
// na saida). --verboso imprime os numeros mesmo quando falha.

import { readFileSync } from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';
import { CONTEUDO } from '../data/content.js';
import { criarNavegador } from './dom-falso.mjs';
import { iniciar, menuLiberado } from '../src/main.js';
import { TELAS } from '../src/state.js';
import { criarUi } from '../src/ui.js';
import { CONTROLE_TOFU, efeitosDe, REFERENCIAS_TOFU } from '../src/render.js';
import { anuncioLiberado, colacaoLiberada, comecarAvaliacao, tccLiberado } from '../src/run.js';
import { cartaLiberada } from '../src/cards.js';
import { entradaLiberada, posicaoSeguir } from '../src/shop.js';
import { receberDano } from '../src/player.js';
import { aplicarDano, spawnInimigo } from '../src/enemies.js';
import { acharBanca } from '../src/boss.js';
import { novaInstancia } from '../src/jokers.js';
import { obterScratch } from '../src/pool.js';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const VERBOSO = process.argv.includes('--verboso');
const SEMENTE = 20261110;
// 20 fps: 3 ticks por quadro. Inteiro de proposito: o relogio de parede falso
// so soma inteiros, e dois navegadores com o mesmo historico de quadros rodam
// os mesmos ticks.
const QUADRO_MS = 50;
const inicio = Date.now();

const falhas = [];
const notas = [];

// O gc: o do --expose-gc (npm run dom) ou, sem ele, o que o v8 expoe.
function obterGc() {
  if (typeof globalThis.gc === 'function') return globalThis.gc;
  v8.setFlagsFromString('--expose_gc');
  return vm.runInNewContext('gc');
}
const gc = obterGc();

// Um WeakRef segura o alvo ate o fim da tarefa em que foi criado ou lido: o
// gc so ve o que ficou para tras depois de devolver o controle ao loop.
async function coletar() {
  for (let i = 0; i < 2; i += 1) {
    await new Promise((resolver) => setTimeout(resolver, 0));
    gc();
  }
}
function falhar(onde, msg) {
  falhas.push(`${onde}: ${msg}`);
}
function nota(msg) {
  notas.push(msg);
}

// -------------------------------------------------------------- utilidades

function abrir(opcoes = {}) {
  const nav = criarNavegador({ html: HTML, semente: SEMENTE, ...opcoes });
  nav.iniciar(iniciar);
  nav.ctx = nav.document.getElementById('palco').getContext('2d');
  return nav;
}

const $ = (nav, id) => nav.document.getElementById(id);
const visiveis = (lista) => lista.filter((no) => no.visivel);

// Os geradores andam um quadro por `yield`: o teste de reinicio roda dois
// navegadores lado a lado e compara depois de cada um.
function* quadros(nav, n = 1, ms = QUADRO_MS) {
  for (let i = 0; i < n; i += 1) {
    nav.quadro(ms);
    yield;
  }
}

function* ate(nav, cond, segundos, oque) {
  const limite = Math.ceil((segundos * 1000) / QUADRO_MS);
  for (let i = 0; i < limite && !cond(); i += 1) {
    nav.quadro(QUADRO_MS);
    yield;
  }
  if (!cond()) throw new Error(`${oque}: nao aconteceu em ${segundos}s (tela "${nav.estado.tela}")`);
}

function rodar(gerador) {
  for (const _ of gerador);
}

// O jogador anda pela arena com as teclas (keydown/keyup de verdade),
// trocando de direcao a cada `troca` segundos, e escolhe as cartas que
// aparecerem. Com `segurarHp`, o HP volta ao maximo a cada quadro.
const DIRECOES = ['KeyD', 'KeyS', 'KeyA', 'KeyW', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];

// O que as runs fizeram, para a linha final (e para provar que houve jogo).
const medido = { picoInimigos: 0, mortes: 0, picoFaiscas: 0 };

function* andar(nav, segundos, { segurarHp = true, cartas = 'teclado', troca = 0.8, contador = { cartas: 0 }, horda = false } = {}) {
  const e = nav.estado;
  let tecla = null;
  let proximaTroca = 0;
  let t = 0;
  let k = 0;
  while (t < segundos) {
    if (e.tela === TELAS.CARTA) {
      yield* escolherCarta(nav, cartas, contador);
      continue;
    }
    if (e.tela !== TELAS.AVALIACAO) return;
    if (t >= proximaTroca) {
      if (tecla) nav.tecla(tecla, { so: 'up' });
      tecla = DIRECOES[k % DIRECOES.length];
      k += 1;
      nav.tecla(tecla, { so: 'down' });
      proximaTroca = t + troca;
    }
    if (segurarHp && e.player.vivo) e.player.hp = e.player.hpMax;
    // Horda extra pela porta normal de spawn (respeita o teto), como o fuzz:
    // enche as pools e a de faiscas.
    if (horda) for (let i = 0; i < 6; i += 1) nav.com(() => spawnInimigo(e, CONTEUDO.inimigos[(k + i) % CONTEUDO.inimigos.length].id));
    nav.quadro(QUADRO_MS);
    medido.picoInimigos = Math.max(medido.picoInimigos, e.enemies.length);
    medido.picoFaiscas = Math.max(medido.picoFaiscas, efeitosDe(nav.ctx).particulas.ativos.length);
    t += QUADRO_MS / 1000;
    yield;
  }
  if (tecla) nav.tecla(tecla, { so: 'up' });
}

// Uma carta: espera o atraso de abertura e escolhe pelo modo pedido.
function* escolherCarta(nav, modo, contador) {
  const e = nav.estado;
  yield* ate(nav, () => cartaLiberada(e), 3, 'carta liberada');
  const n = contador.cartas;
  contador.cartas += 1;
  const versao = e.cartas.versao;
  const escolhidas = e.cartas.escolhidas;
  if (modo === 'mouse' || (modo === 'misto' && n % 2 === 1)) {
    const opcoes = visiveis($(nav, 'carta-opcoes').children);
    const alvo = opcoes[n % opcoes.length];
    nav.apontar(alvo);
    nav.clicar(alvo);
  } else if (modo === 'enter' || (modo === 'misto' && n % 4 === 2)) {
    nav.tecla('ArrowRight');
    nav.tecla('Enter');
  } else {
    nav.tecla(`Digit${1 + (n % CONTEUDO.cartas.quantidade)}`);
  }
  yield* quadros(nav, 1);
  if (e.cartas.escolhidas === escolhidas && e.cartas.versao === versao && e.tela === TELAS.CARTA) {
    throw new Error(`a carta (modo ${modo}) nao foi escolhida`);
  }
}

// Uma prova: anda `segundos`, adianta o cronometro (o fuzz faz o mesmo: o
// tempo passou) e segue ate o boletim. Cartas no caminho sao escolhidas.
function* prova(nav, segundos, opcoes = {}) {
  const e = nav.estado;
  yield* andar(nav, segundos, opcoes);
  const av = e.run.avaliacao;
  if (e.tela === TELAS.AVALIACAO && !av.banca) av.decorrido = Math.max(av.decorrido, av.duracao - QUADRO_MS / 1000);
  for (let i = 0; i < 400 && e.tela !== TELAS.RESULTADO && e.tela !== TELAS.JUBILADO; i += 1) {
    if (e.tela === TELAS.CARTA) yield* escolherCarta(nav, opcoes.cartas || 'teclado', opcoes.contador || { cartas: 0 });
    else {
      if (opcoes.segurarHp !== false && e.player.vivo) e.player.hp = e.player.hpMax;
      yield* quadros(nav, 1);
    }
  }
  if (e.tela !== TELAS.RESULTADO && e.tela !== TELAS.JUBILADO) throw new Error(`a prova nao acabou (tela "${e.tela}")`);
  medido.mortes += e.run.resultado.kills;
}

function* comecar(nav, via) {
  const e = nav.estado;
  yield* ate(nav, () => anuncioLiberado(e), 2, 'anuncio liberado');
  if (via === 'clique') nav.clicar($(nav, 'botao-comecar'));
  else nav.tecla(via);
  yield* quadros(nav, 1);
  // Com o Caderno (nivelInicial), a carta abre no 1o tick.
  if (e.tela !== TELAS.AVALIACAO && e.tela !== TELAS.CARTA) throw new Error(`"Comecar" por ${via} levou a "${e.tela}"`);
}

function* jogar(nav, via) {
  const e = nav.estado;
  yield* ate(nav, () => menuLiberado(e), 2, 'menu liberado');
  if (via === 'clique') nav.clicar($(nav, 'botao-jogar'));
  else nav.tecla(via);
  yield* quadros(nav, 1);
  if (e.tela !== TELAS.ANUNCIO) throw new Error(`"Jogar" por ${via} levou a "${e.tela}"`);
}

// A loja: espera o atraso, compra (se der) e sai.
function* loja(nav, { compra = 'tecla', saida = 'clique', rerolar = false } = {}) {
  const e = nav.estado;
  yield* ate(nav, () => entradaLiberada(e), 2, 'loja liberada');
  if (rerolar) {
    nav.tecla('KeyR');
    yield* quadros(nav, 1);
  }
  const item = e.loja.itens[0];
  if (compra !== 'nada' && item.id && !item.vendido && e.run.creditos >= item.preco && e.run.coringas.length < CONTEUDO.loja.teto) {
    const antes = e.run.coringas.length;
    if (compra === 'tecla') nav.tecla('Digit1');
    else nav.clicar($(nav, 'loja-itens').children[0]);
    yield* quadros(nav, 1);
    if (e.run.coringas.length !== antes + 1) throw new Error(`a compra por ${compra} nao comprou (aviso "${e.loja.aviso}")`);
  }
  if (saida === 'clique') nav.clicar($(nav, 'botao-seguir'));
  else {
    // O mouse aponta, o Enter confirma: o destaque e o do cursor (pendencia 26).
    nav.apontar($(nav, 'botao-seguir'));
    if (e.loja.selecionada !== posicaoSeguir(e.loja)) throw new Error('apontar o "Seguir" nao moveu o cursor');
    nav.tecla('Enter');
  }
  yield* quadros(nav, 1);
  if (e.tela !== TELAS.ANUNCIO && e.tela !== TELAS.TCC) throw new Error(`"Seguir" por ${saida} levou a "${e.tela}"`);
}

function* morrer(nav) {
  const e = nav.estado;
  // O Atestado pode segurar o primeiro golpe fatal: bate ate cair.
  for (let i = 0; i < 5 && e.player.vivo; i += 1) receberDano(e, e.player.hpMax * 10, true);
  yield* ate(nav, () => e.tela === TELAS.JUBILADO, 2, 'jubilado');
}

function* pausarEDesistir(nav) {
  nav.tecla('Escape');
  yield* quadros(nav, 1);
  if (nav.estado.tela !== TELAS.PAUSA) throw new Error(`ESC na prova levou a "${nav.estado.tela}"`);
  nav.clicar($(nav, 'botao-menu'));
  yield* quadros(nav, 1);
  if (nav.estado.tela !== TELAS.MENU) throw new Error(`"Desistir" levou a "${nav.estado.tela}"`);
}

// A defesa: golpes grandes na Banca (o fuzz faz igual), HP segurado.
function* defesa(nav) {
  const e = nav.estado;
  for (let i = 0; i < 4000 && e.tela !== TELAS.COLACAO; i += 1) {
    if (e.tela === TELAS.CARTA) {
      yield* escolherCarta(nav, 'teclado', { cartas: i });
      continue;
    }
    if (e.player.vivo) e.player.hp = e.player.hpMax;
    if (i % 6 === 0) {
      const corpo = acharBanca(e);
      if (corpo) aplicarDano(e, corpo, corpo.hpMax * 0.12);
    }
    yield* quadros(nav, 1);
  }
  if (e.tela !== TELAS.COLACAO) throw new Error(`a defesa nao acabou (tela "${e.tela}")`);
}

// Leva um navegador novo a uma tela qualquer, ja liberada (atraso de
// abertura vencido). Pelas portas do jogo, menos os atalhos de teste: o
// cronometro adiantado, o XP dado, o dano e os creditos.
function* irPara(nav, tela) {
  const e = nav.estado;
  yield* quadros(nav, 2);
  if (tela === TELAS.MENU) return yield* ate(nav, () => menuLiberado(e), 2, 'menu liberado');
  yield* jogar(nav, 'clique');
  if (tela === TELAS.ANUNCIO) return yield* ate(nav, () => anuncioLiberado(e), 2, 'anuncio');
  if (tela === TELAS.TCC || tela === TELAS.COLACAO) {
    // A ultima Prova Final, comecada direto (atalho), e a loja depois dela.
    const p = CONTEUDO.periodos.length - 1;
    nav.com(() => comecarAvaliacao(e, p, CONTEUDO.periodos[p].avaliacoes.length - 1));
    yield* prova(nav, 0.3);
    nav.clicar($(nav, 'botao-resultado'));
    yield* quadros(nav, 1);
    yield* loja(nav, { compra: 'nada' });
    yield* ate(nav, () => tccLiberado(e), 2, 'tcc');
    if (tela === TELAS.TCC) return;
    nav.tecla('Enter');
    yield* quadros(nav, 1);
    yield* defesa(nav);
    return yield* ate(nav, () => colacaoLiberada(e), 2, 'colacao');
  }
  yield* comecar(nav, 'clique');
  if (tela === TELAS.AVALIACAO) return yield* quadros(nav, 10);
  if (tela === TELAS.PAUSA) {
    yield* quadros(nav, 10);
    nav.tecla('Escape');
    return yield* quadros(nav, 1);
  }
  if (tela === TELAS.CARTA) {
    e.player.xp = e.player.xpProximo;
    yield* ate(nav, () => e.tela === TELAS.CARTA, 2, 'carta');
    return yield* ate(nav, () => cartaLiberada(e), 2, 'carta liberada');
  }
  if (tela === TELAS.JUBILADO) {
    yield* quadros(nav, 10);
    return yield* morrer(nav);
  }
  yield* prova(nav, 0.5);
  if (tela === TELAS.RESULTADO) return;
  nav.tecla('Enter');
  yield* quadros(nav, 1);
  e.run.creditos = Math.max(e.run.creditos, 999);
  yield* ate(nav, () => entradaLiberada(e), 2, 'loja');
}

const TODAS_AS_TELAS = Object.values(TELAS);

// A excecao de uma camada nao derruba o quadro (rodarQuadro relata no
// console e segue): para este teste, qualquer coisa no console reprova.
function semErros(nav, onde) {
  if (nav.erros.length > 0) {
    falhar(onde, `console.error: ${nav.erros.slice(0, 3).join(' | ')}`);
    nav.erros.length = 0;
  }
}

// ------------------------------------------------------------ 1. fiacao

function checarFiacao() {
  const onde = 'fiacao';
  // Todo id que ui.js procura existe no index.html (um id renomeado viraria
  // null, e ui.js pula no nulo em silencio: a tela ficaria parada).
  const nav0 = criarNavegador({ html: HTML });
  const el = nav0.com(() => criarUi(nav0.document).el);
  const faltando = Object.entries(el).filter(([, no]) => !no).map(([nome]) => nome);
  if (faltando.length > 0) falhar(onde, `ui.js procura e o index.html nao tem: ${faltando.join(', ')}`);
  const ids = nav0.document.querySelectorAll('[id]').map((n) => n.id);
  const repetidos = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (repetidos.length > 0) falhar(onde, `id repetido no index.html: ${repetidos.join(', ')}`);

  const nav = abrir();
  semErros(nav, onde);
  if (!nav.proximo) falhar(onde, 'iniciar() nao agendou o primeiro quadro');
  if (nav.estado.tela !== TELAS.MENU) falhar(onde, `o jogo abriu em "${nav.estado.tela}"`);
  const c = nav.document.getElementById('palco');
  if (c.width !== CONTEUDO.arena.largura || c.height !== CONTEUDO.arena.altura) {
    falhar(onde, `canvas ${c.width}x${c.height}, esperava ${CONTEUDO.arena.largura}x${CONTEUDO.arena.altura}`);
  }
  rodar(quadros(nav, 3));
  if (!$(nav, 'menu').visivel || $(nav, 'hud').visivel) falhar(onde, 'o menu nao e a unica camada na tela depois de abrir');
  if (nav.ctx.reg.ops === 0) falhar(onde, 'o quadro nao desenhou nada no canvas');
  if (nav.ctx.pilha() !== 0) falhar(onde, `o quadro terminou com ${nav.ctx.pilha()} save() sem restore()`);
  semErros(nav, onde);
  return nav.contar();
}

// ------------------------------------------------------- 2. teclado por tela

const TECLAS_TESTADAS = ['Escape', 'KeyM', 'Digit1', 'Digit2', 'Digit3', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'NumpadEnter', 'Space'];
const SEGUIR = new Set(['Enter', 'NumpadEnter', 'Space']);

// Para onde cada tecla leva cada tela (o que nao esta aqui: fica na mesma).
function telaEsperada(tela, code) {
  if (code === 'Escape') return tela === TELAS.AVALIACAO ? TELAS.PAUSA : tela === TELAS.PAUSA ? TELAS.AVALIACAO : tela;
  if (SEGUIR.has(code)) {
    const destino = {
      [TELAS.MENU]: TELAS.ANUNCIO,
      [TELAS.ANUNCIO]: TELAS.AVALIACAO,
      [TELAS.PAUSA]: TELAS.AVALIACAO,
      [TELAS.CARTA]: TELAS.AVALIACAO,
      [TELAS.RESULTADO]: TELAS.LOJA,
      [TELAS.JUBILADO]: TELAS.MENU,
      [TELAS.TCC]: TELAS.AVALIACAO,
      [TELAS.COLACAO]: TELAS.MENU,
    };
    return destino[tela] || tela;
  }
  if (/^Digit/.test(code) && tela === TELAS.CARTA) return TELAS.AVALIACAO;
  return tela;
}

function checarTeclado() {
  let combinacoes = 0;
  for (const tela of TODAS_AS_TELAS) {
    for (const code of TECLAS_TESTADAS) {
      const onde = `teclado: ${code} em "${tela}"`;
      const nav = abrir();
      const e = nav.estado;
      try {
        rodar(irPara(nav, tela));
      } catch (erro) {
        falhar(onde, `nao chegou a tela: ${erro.message}`);
        continue;
      }
      nav.erros.length = 0;
      combinacoes += 1;
      const antes = {
        mudo: nav.localStorage.getItem(CONTEUDO.audio.chaveMudo),
        textoMudo: $(nav, 'botao-mudo').textContent,
        escolhidas: e.cartas.escolhidas,
        selecionada: e.cartas.selecionada,
        coringas: e.run.coringas.length,
        cursor: `${e.loja.linha}:${e.loja.selecionada}`,
      };
      nav.rolagens.length = 0;
      const ev = nav.tecla(code);
      rodar(quadros(nav, 1));
      const esperada = telaEsperada(tela, code);
      if (e.tela !== esperada) falhar(onde, `foi a "${e.tela}", esperava "${esperada}"`);
      if (nav.rolagens.length > 0) falhar(onde, 'a tecla ficou sem preventDefault e rolaria a pagina');
      if (code === 'KeyM') {
        if (!ev.defaultPrevented) falhar(onde, 'M sem preventDefault');
        if (nav.localStorage.getItem(CONTEUDO.audio.chaveMudo) === antes.mudo) falhar(onde, 'M nao mudou o mudo gravado');
        if ($(nav, 'botao-mudo').textContent === antes.textoMudo) falhar(onde, 'M nao trocou o botao de som');
      }
      if (tela === TELAS.CARTA && (/^Digit/.test(code) || SEGUIR.has(code)) && e.cartas.escolhidas !== antes.escolhidas + 1) {
        falhar(onde, 'a carta nao foi escolhida');
      }
      if (tela === TELAS.CARTA && (code === 'ArrowLeft' || code === 'ArrowRight') && e.cartas.selecionada === antes.selecionada) {
        falhar(onde, 'a seta nao moveu o cursor da carta');
      }
      if (tela === TELAS.LOJA) {
        // 1-3 compram direto; Enter compra o que o cursor (item 0) aponta.
        const compra = /^Digit/.test(code) || SEGUIR.has(code);
        if (compra && e.run.coringas.length !== antes.coringas + 1) falhar(onde, `nao comprou (aviso "${e.loja.aviso}")`);
        if (!compra && e.run.coringas.length !== antes.coringas) falhar(onde, 'comprou sem tecla de compra');
        if (/^Arrow/.test(code) && `${e.loja.linha}:${e.loja.selecionada}` === antes.cursor && code !== 'ArrowUp' && code !== 'ArrowDown') {
          falhar(onde, 'a seta nao moveu o cursor da loja');
        }
      }
      semErros(nav, onde);
    }
  }
  return combinacoes;
}

// ------------------------------------------------- 3. foco e troca de aba

function checarFoco() {
  let casos = 0;
  for (const tela of TODAS_AS_TELAS) {
    for (const como of ['blur', 'aba']) {
      const onde = `${como} em "${tela}"`;
      const nav = abrir();
      const e = nav.estado;
      try {
        rodar(irPara(nav, tela));
      } catch (erro) {
        falhar(onde, `nao chegou a tela: ${erro.message}`);
        continue;
      }
      casos += 1;
      // Uma tecla de movimento apertada quando a janela perde o foco: o
      // keyup nunca chega.
      nav.tecla('ArrowLeft', { so: 'down' });
      if (como === 'blur') nav.perderFoco();
      else nav.esconderAba(true);
      const esperada = tela === TELAS.AVALIACAO ? TELAS.PAUSA : tela;
      if (e.tela !== esperada) falhar(onde, `foi a "${e.tela}", esperava "${esperada}"`);
      if (e.input.eixoX !== 0 || e.input.eixoY !== 0 || Object.values(e.input.teclas).some(Boolean)) {
        falhar(onde, `ficou tecla presa: eixo (${e.input.eixoX}, ${e.input.eixoY}), teclas ${JSON.stringify(e.input.teclas)}`);
      }
      // A aba volta 30s depois: um quadro so com 30s de parede.
      const decorrido = e.run.avaliacao.decorrido;
      const tempo = e.tempo;
      if (como === 'aba') nav.esconderAba(false);
      rodar(quadros(nav, 1, 30000));
      rodar(quadros(nav, 3));
      const maximo = (CONTEUDO.loop.maxPassosPorFrame + 3 * 3) * CONTEUDO.loop.passo + 1e-9;
      if (e.tempo - tempo > maximo) falhar(onde, `a volta da aba rodou ${(e.tempo - tempo).toFixed(2)}s de jogo de uma vez`);
      // Pausada (ou numa tela que ja congela o jogo), a prova nao anda.
      if (e.run.avaliacao.decorrido !== decorrido) {
        falhar(onde, `a prova andou ${(e.run.avaliacao.decorrido - decorrido).toFixed(2)}s com a janela sem foco`);
      }
      if (e.tela !== esperada) falhar(onde, `depois da volta, a tela virou "${e.tela}"`);
      semErros(nav, onde);
    }
  }
  return casos;
}

// ------------------------------------------------------------- 4. cliques

function checarCliques() {
  // Clique duplo na compra: o 1o compra, o 2o (mesmo quadro, e no seguinte)
  // nao compra de novo nem cobra de novo.
  {
    const onde = 'clique duplo na compra';
    const nav = abrir();
    const e = nav.estado;
    rodar(irPara(nav, TELAS.LOJA));
    const botao = $(nav, 'loja-itens').children[0];
    const item = e.loja.itens[0];
    const creditos = e.run.creditos;
    const coringas = e.run.coringas.length;
    nav.clicar(botao, { detail: 1 });
    nav.clicar(botao, { detail: 2 });
    rodar(quadros(nav, 1));
    nav.clicar(botao, { detail: 1 });
    rodar(quadros(nav, 1));
    if (e.run.coringas.length !== coringas + 1) falhar(onde, `${e.run.coringas.length - coringas} coringa(s) comprado(s)`);
    if (e.run.creditos !== creditos - item.preco) falhar(onde, `cobrou ${creditos - e.run.creditos}, o preco e ${item.preco}`);
    if (!botao.classList.contains('vendido')) falhar(onde, 'o item comprado nao aparece como vendido');
    if ($(nav, 'loja-aviso').textContent !== CONTEUDO.textos.loja.avisos.vendido) {
      falhar(onde, `o clique no vendido nao avisou (aviso "${$(nav, 'loja-aviso').textContent}")`);
    }
    semErros(nav, onde);
  }
  // Clique na vitrine antes do atraso de abertura: nada.
  {
    const onde = 'clique na loja recem-aberta';
    const nav = abrir();
    const e = nav.estado;
    rodar(irPara(nav, TELAS.RESULTADO));
    e.run.creditos = 999;
    nav.clicar($(nav, 'botao-resultado'));
    rodar(quadros(nav, 1));
    const coringas = e.run.coringas.length;
    nav.clicar($(nav, 'loja-itens').children[0], { detail: 2 });
    nav.clicar($(nav, 'botao-seguir'), { detail: 2 });
    if (e.run.coringas.length !== coringas || e.tela !== TELAS.LOJA) falhar(onde, 'o clique duplo do boletim comprou ou saiu da loja');
    semErros(nav, onde);
  }
  // Clique duplo no "Seguir": a loja sai uma vez, e o 2o clique cai no
  // anuncio, que tem atraso proprio.
  {
    const onde = 'clique duplo no Seguir';
    const nav = abrir();
    const e = nav.estado;
    rodar(irPara(nav, TELAS.LOJA));
    nav.clicar($(nav, 'botao-seguir'), { detail: 1 });
    rodar(quadros(nav, 1));
    nav.clicar($(nav, 'botao-comecar'), { detail: 2 });
    rodar(quadros(nav, 1));
    if (e.tela !== TELAS.ANUNCIO) falhar(onde, `o 2o clique levou a "${e.tela}"`);
    semErros(nav, onde);
  }
  // Os botoes que levam ao menu: o 2o clique de um clique duplo cai no
  // "Jogar" (no Chrome, o "Desistir" fica exatamente por cima dele) e nao
  // pode comecar uma run que ninguem pediu.
  for (const [tela, botao] of [
    [TELAS.PAUSA, 'botao-menu'],
    [TELAS.JUBILADO, 'botao-jubilado'],
    [TELAS.COLACAO, 'botao-colacao'],
  ]) {
    const onde = `clique duplo em #${botao} (${tela})`;
    const nav = abrir();
    const e = nav.estado;
    rodar(irPara(nav, tela));
    nav.clicar($(nav, botao), { detail: 1 });
    rodar(quadros(nav, 1));
    if (e.tela !== TELAS.MENU) {
      falhar(onde, `o 1o clique levou a "${e.tela}"`);
      continue;
    }
    nav.clicar($(nav, 'botao-jogar'), { detail: 2 });
    rodar(quadros(nav, 1));
    if (e.tela !== TELAS.MENU) falhar(onde, `o 2o clique, no "Jogar", levou a "${e.tela}"`);
    // Vencido o atraso de abertura do menu, ainda vale o filtro do clique
    // duplo (o do Windows pode ir a 900ms); e um clique simples joga.
    rodar(ate(nav, () => menuLiberado(e), 2, 'menu liberado'));
    nav.clicar($(nav, 'botao-jogar'), { detail: 2 });
    rodar(quadros(nav, 1));
    if (e.tela !== TELAS.MENU) falhar(onde, `o 2o clique de um clique duplo no "Jogar", com o menu liberado, levou a "${e.tela}"`);
    nav.clicar($(nav, 'botao-jogar'), { detail: 1 });
    rodar(quadros(nav, 1));
    if (e.tela !== TELAS.ANUNCIO) falhar(onde, `um clique simples no "Jogar" depois levou a "${e.tela}"`);
    semErros(nav, onde);
  }
  // O teclado nas telas que levam ao menu: o 2o toque de Enter/Espaco (50ms
  // depois), Espaco martelado por meio segundo e a tecla segurada (keydown
  // repetido) param no menu — nao comecam uma run que ninguem pediu, de cujo
  // anuncio nao ha volta. Vencido o atraso, um toque novo joga.
  for (const tela of [TELAS.JUBILADO, TELAS.COLACAO]) {
    for (const code of ['Enter', 'Space']) {
      for (const jeito of ['toque duplo', 'martelando', 'segurando']) {
        const onde = `${jeito} ${code} em "${tela}"`;
        const nav = abrir();
        const e = nav.estado;
        rodar(irPara(nav, tela));
        if (jeito === 'segurando') {
          nav.tecla(code, { so: 'down' });
          rodar(quadros(nav, 1));
          for (let i = 0; i < 30; i += 1) {
            nav.tecla(code, { so: 'down', repeat: true });
            rodar(quadros(nav, 1));
          }
          nav.tecla(code, { so: 'up' });
        } else {
          const toques = jeito === 'toque duplo' ? 2 : 6;
          for (let i = 0; i < toques; i += 1) {
            nav.tecla(code);
            rodar(quadros(nav, jeito === 'toque duplo' ? 1 : 2));
          }
        }
        rodar(quadros(nav, 1));
        if (e.tela !== TELAS.MENU) {
          falhar(onde, `foi a "${e.tela}", esperava parar no menu`);
          continue;
        }
        rodar(ate(nav, () => menuLiberado(e), 2, 'menu liberado'));
        nav.tecla(code);
        rodar(quadros(nav, 1));
        if (e.tela !== TELAS.ANUNCIO) falhar(onde, `um toque novo, com o menu liberado, levou a "${e.tela}"`);
        semErros(nav, onde);
      }
    }
  }
  // Pausar por cima da carta e da loja: ESC nao faz nada, e os botoes da
  // pausa e do menu (escondidos; um clique atrasado ou um Enter num botao
  // que ficou com o foco) nao agem.
  for (const tela of [TELAS.CARTA, TELAS.LOJA]) {
    const onde = `pausa por cima da ${tela}`;
    const nav = abrir();
    const e = nav.estado;
    rodar(irPara(nav, tela));
    nav.tecla('Escape');
    rodar(quadros(nav, 1));
    for (const id of ['botao-continuar', 'botao-menu', 'botao-jogar']) {
      if ($(nav, id).visivel) falhar(onde, `#${id} esta visivel`);
      nav.clicar($(nav, id), { forcar: true });
      rodar(quadros(nav, 1));
    }
    nav.perderFoco();
    rodar(quadros(nav, 1));
    if (e.tela !== tela) falhar(onde, `a tela virou "${e.tela}"`);
    if (!$(nav, tela).visivel) falhar(onde, `a camada #${tela} sumiu`);
    semErros(nav, onde);
  }
  // Foco num botao: o clique solta o foco (o Enter/Espaco seguinte nao
  // clica de novo um botao que ja saiu da tela).
  {
    const onde = 'foco depois do clique';
    for (const [tela, id] of [
      [TELAS.MENU, 'botao-jogar'],
      [TELAS.PAUSA, 'botao-continuar'],
      [TELAS.PAUSA, 'botao-menu'],
      [TELAS.RESULTADO, 'botao-resultado'],
      [TELAS.JUBILADO, 'botao-jubilado'],
    ]) {
      const n = abrir();
      rodar(irPara(n, tela));
      n.clicar($(n, id));
      if (n.document.activeElement === $(n, id)) falhar(onde, `#${id} ficou com o foco depois do clique`);
      semErros(n, onde);
    }
  }
  // Enter com um botao VISIVEL em foco (o jogador chegou nele com Tab): age o
  // botao, como no navegador. Com um botao ESCONDIDO em foco (sobrou de uma
  // tela que sumiu), age a tela.
  {
    const onde = 'Enter com foco num botao';
    const nav = abrir();
    const e = nav.estado;
    rodar(irPara(nav, TELAS.PAUSA));
    nav.com(() => $(nav, 'botao-menu').focus());
    nav.tecla('Enter');
    rodar(quadros(nav, 1));
    if (e.tela !== TELAS.MENU) falhar(onde, `Enter com o foco no "Desistir" levou a "${e.tela}" (o botao em foco nao agiu)`);
    rodar(ate(nav, () => menuLiberado(e), 2, 'menu liberado'));
    nav.com(() => $(nav, 'botao-jubilado').focus()); // escondido: o foco que sobrou
    nav.tecla('Enter');
    rodar(quadros(nav, 1));
    if (e.tela !== TELAS.ANUNCIO) falhar(onde, `Enter no menu, com o foco num botao escondido, levou a "${e.tela}"`);
    semErros(nav, onde);
  }
  // Clique duplo LENTO (o Windows aceita ate 500ms entre os dois): o 2o
  // clique chega depois do atraso de abertura da tela nova. Quem decide e o
  // `detail` do clique.
  {
    const onde = 'clique duplo lento';
    const lento = 0.45; // s: mais que todo atrasoEntrada de 0,35s
    const nav = abrir();
    const e = nav.estado;
    rodar(irPara(nav, TELAS.RESULTADO));
    e.run.creditos = 999;
    e.run.coringas.push(novaInstancia(CONTEUDO.coringas[0].id));
    nav.clicar($(nav, 'botao-resultado'), { detail: 1 });
    rodar(quadros(nav, Math.ceil((lento * 1000) / QUADRO_MS)));
    // No Chrome a 1280x720, o "Continuar" do boletim fica em cima da fileira
    // de coringas da loja: o 2o clique venderia o 1o coringa.
    nav.clicar($(nav, 'loja-coringas').children[0], { detail: 2 });
    nav.clicar($(nav, 'loja-itens').children[0], { detail: 2 });
    if (e.run.coringas.length !== 1) falhar(onde, `o 2o clique do "Continuar" vendeu ou comprou as cegas (${e.run.coringas.length} coringas, eram 1)`);
    nav.clicar($(nav, 'botao-seguir'), { detail: 1 });
    rodar(quadros(nav, Math.ceil((lento * 1000) / QUADRO_MS)));
    nav.clicar($(nav, 'botao-comecar'), { detail: 2 });
    rodar(quadros(nav, 1));
    if (e.tela !== TELAS.ANUNCIO) falhar(onde, `o 2o clique do "Seguir" comecou a prova ("${e.tela}")`);
    nav.clicar($(nav, 'botao-comecar'), { detail: 1 });
    rodar(quadros(nav, 1));
    // Duas cartas na fila: o 2o clique (lento) cairia na 2a, as cegas.
    e.player.xp = e.player.xpProximo * 3;
    rodar(ate(nav, () => e.tela === TELAS.CARTA, 2, 'carta'));
    rodar(ate(nav, () => cartaLiberada(e), 2, 'carta liberada'));
    const escolhidas = e.cartas.escolhidas;
    const opcao = visiveis($(nav, 'carta-opcoes').children)[0];
    nav.clicar(opcao, { detail: 1 });
    rodar(quadros(nav, Math.ceil((lento * 1000) / QUADRO_MS)));
    if (e.tela === TELAS.CARTA) {
      nav.clicar(visiveis($(nav, 'carta-opcoes').children)[0], { detail: 2 });
      rodar(quadros(nav, 1));
      if (e.cartas.escolhidas !== escolhidas + 1) falhar(onde, `o 2o clique escolheu a 2a carta as cegas (${e.cartas.escolhidas - escolhidas} escolhidas)`);
    } else {
      falhar(onde, `a fila de cartas nao teve 2a carta (tela "${e.tela}")`);
    }
    semErros(nav, onde);
  }
  // Vender com clique duplo: o coringa seguinte escorrega para o slot vendido.
  {
    const onde = 'clique duplo na venda';
    const nav = abrir();
    const e = nav.estado;
    rodar(irPara(nav, TELAS.LOJA));
    nav.tecla('Digit1');
    nav.tecla('Digit2');
    rodar(quadros(nav, 1));
    if (e.run.coringas.length !== 2) falhar(onde, `a preparacao comprou ${e.run.coringas.length} coringas, esperava 2`);
    const slot = $(nav, 'loja-coringas').children[0];
    nav.clicar(slot, { detail: 1 });
    nav.clicar(slot, { detail: 2 });
    rodar(quadros(nav, 1));
    if (e.run.coringas.length !== 1) falhar(onde, `o clique duplo vendeu ${2 - e.run.coringas.length} coringa(s)`);
    semErros(nav, onde);
  }
}

// ------------------------------------------------------------ 5. emoji

// Os emoji que o canvas desenha (o resto do jogo e texto do DOM).
function emojisDoCanvas() {
  const lista = [CONTEUDO.jogador.emoji, CONTEUDO.xpOrbe.emoji, CONTEUDO.banca.emoji, CONTEUDO.banca.pergunta.emoji];
  for (const a of CONTEUDO.armas) lista.push(a.emoji);
  for (const i of CONTEUDO.inimigos) lista.push(i.emoji);
  return [...new Set(lista)];
}

const TOFU = 0x5a5a5a5a;

function checarEmoji() {
  const faltam = [CONTEUDO.jogador.emoji, CONTEUDO.inimigos[0].emoji];
  const presentes = emojisDoCanvas().filter((x) => !faltam.includes(x));
  const cores = CONTEUDO.visual.emojiFallback.cores;
  const padrao = (texto) => {
    let h = 7;
    for (const ch of texto) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
    return h;
  };
  const casos = [
    // Maquina sem a fonte de dois emoji: o tofu deles e o mesmo das referencias.
    { nome: 'sem dois glifos', glifo: (t) => (faltam.includes(t) || REFERENCIAS_TOFU.includes(t) ? TOFU : padrao(t)), espera: faltam },
    // Leitura do canvas bloqueada/embaralhada por privacidade: tudo igual.
    { nome: 'leitura constante', glifo: () => TOFU, espera: [] },
    // Leitura em branco (nada desenhado em lugar nenhum).
    { nome: 'leitura vazia', glifo: () => null, espera: [] },
    // Fonte de emoji completa.
    { nome: 'tudo presente', glifo: (t) => (REFERENCIAS_TOFU.includes(t) ? TOFU : padrao(t)), espera: [] },
    // O controle desenha o mesmo que o tofu (fonte quebrada): nao confia.
    { nome: 'controle = tofu', glifo: (t) => (t === CONTROLE_TOFU || REFERENCIAS_TOFU.includes(t) || faltam.includes(t) ? TOFU : padrao(t)), espera: [] },
    // A fonte tem o codigo mas desenha nada (glifo vazio): tambem falta.
    { nome: 'glifo em branco', glifo: (t) => (faltam.includes(t) ? null : REFERENCIAS_TOFU.includes(t) ? TOFU : padrao(t)), espera: faltam },
  ];
  for (const caso of casos) {
    const onde = `emoji (${caso.nome})`;
    const nav = abrir({ glifo: caso.glifo });
    const e = nav.estado;
    rodar(irPara(nav, TELAS.AVALIACAO));
    // Um de cada inimigo na tela, longe do jogador.
    for (const tipo of CONTEUDO.inimigos) nav.com(() => spawnInimigo(e, tipo.id));
    for (const inimigo of e.enemies) {
      inimigo.x = 60 + (inimigo.slot % 10) * 80;
      inimigo.y = 60;
    }
    e.player.invulneravel = 0;
    nav.ctx.zerarResumo();
    nav.ctx.gravar = true;
    rodar(quadros(nav, 1));
    nav.ctx.gravar = false;
    const fx = efeitosDe(nav.ctx);
    const marcados = fx.emojiFaltando ? [...fx.emojiFaltando] : [];
    if (marcados.sort().join() !== [...caso.espera].sort().join()) {
      falhar(onde, `marcou como faltando [${marcados.join(' ')}], esperava [${caso.espera.join(' ')}]`);
    }
    // Fase 16: todo emoji de entidade e uma figurinha, cozida na folha (fora
    // da arvore) e copiada com drawImage — o quadro nao escreve emoji nenhum.
    const noQuadro = nav.ctx.reg.textos.filter((t) => emojisDoCanvas().includes(t.texto));
    if (noQuadro.length > 0) falhar(onde, `${noQuadro[0].texto} escrito com fillText no quadro, fora do cozimento`);
    if (!fx.folha.camada) {
      falhar(onde, 'o desenho nao criou a folha de figurinhas');
      semErros(nav, onde);
      continue;
    }
    const folha = fx.folha.camada.getContext('2d').reg;
    const silhueta = fx.folha.silhueta.getContext('2d').reg;
    const escritos = [...folha.textos, ...silhueta.textos];
    const cozidos = new Set(escritos.map((t) => t.texto));
    const naTela = 1 + CONTEUDO.inimigos.length;
    if (nav.ctx.reg.copias < naTela) falhar(onde, `${nav.ctx.reg.copias} copias no quadro para ${naTela} figurinhas na tela`);
    // O emoji que falta e cozido como a forma colorida do fallback (fase 14),
    // com o mesmo contorno: a forma esta na silhueta e na folha, e e uma
    // figurinha do cache como as outras.
    for (const x of caso.espera) {
      if (cozidos.has(x)) falhar(onde, `${x} foi cozido como texto (tofu na figurinha)`);
      const cor = cores[x] || CONTEUDO.visual.emojiFallback.corPadrao;
      if (!folha.formas.some((f) => f.cor === cor) || !silhueta.formas.some((f) => f.cor === cor)) falhar(onde, `nenhuma forma na cor de ${x} (${cor}) cozida na folha`);
      if (![...fx.figurinhas.keys()].some((k) => k.startsWith(`${x}|`))) falhar(onde, `${x} sem figurinha no cache (a forma tem que ganhar o contorno)`);
    }
    // A forma troca o fillStyle e o devolve: o emoji seguinte e cozido na cor
    // de sempre (opaca; um alfa nela apagaria o emoji colorido).
    const tortos = escritos.filter((t) => emojisDoCanvas().includes(t.texto) && t.cor !== CONTEUDO.visual.corEmoji);
    if (tortos.length > 0) falhar(onde, `${tortos[0].texto} cozido com fillStyle ${tortos[0].cor} (a cor da forma vazou)`);
    for (const x of caso.espera.length > 0 ? presentes : emojisDoCanvas()) {
      const naTelaAgora = x === CONTEUDO.jogador.emoji || CONTEUDO.inimigos.some((i) => i.emoji === x);
      if (naTelaAgora && !cozidos.has(x)) falhar(onde, `${x} (com fonte) nao foi cozido como texto`);
    }
    if (nav.ctx.pilha() !== 0) falhar(onde, `${nav.ctx.pilha()} save() sem restore()`);
    semErros(nav, onde);
  }
}

// ------------------------------------------- 6. cinco runs e reinicio limpo

// O que nao pode crescer de uma run para outra.
function contadores(nav) {
  const e = nav.estado;
  const pools = {};
  const scratch = obterScratch(e);
  for (const [nome, pool] of Object.entries(scratch.pools || {})) {
    pools[nome] = `${pool.criados}/${pool.capacidade}`;
    if (pool.verificar()) pools[nome] += ` (${pool.verificar()})`;
  }
  const fx = efeitosDe(nav.ctx);
  return {
    ...nav.contar(),
    pools: JSON.stringify(pools),
    efeitos: `${fx.particulas.criados}/${fx.particulas.capacidade} ${fx.numeros.criados}/${fx.numeros.capacidade} fontes ${fx.fontes.size} rajadas ${fx.rajadas.size} figurinhas ${fx.figurinhas.size}`,
    eventos: e.eventos.length,
    audio: nav.audio.contextos,
    pilha: nav.ctx.pilha(),
  };
}

// O estado sem o que atravessa runs de proposito (recorde, telemetria) e sem
// os contadores de geracao das pools (nasc: so identidade, cresce sempre). As
// teclas soltas (false) de uma run anterior sao o mesmo que nenhuma tecla.
function estadoComparavel(estado) {
  return JSON.stringify(estado, (k, v) => {
    if (k === 'telemetria' || k === 'recorde' || k === 'nasc') return undefined;
    if (k === 'teclas') return Object.keys(v).filter((t) => v[t]).sort();
    return v;
  });
}

// A barra de relatorio do menu so aparece depois de alguma partida jogada
// (debug.relatorio): e telemetria, atravessa runs de proposito.
const ignorarNoRetrato = (no) => no.hasAttribute('data-relatorio-menu');

function* primeiraRun(nav) {
  // Jogar e Comecar com o mouse e o teclado; cartas pelos numeros; a loja
  // com clique; a 2a prova termina jubilada.
  yield* jogar(nav, 'clique');
  yield* comecar(nav, 'Enter');
  yield* prova(nav, 15, { cartas: 'teclado' });
  nav.clicar($(nav, 'botao-resultado'));
  yield* quadros(nav, 1);
  nav.estado.run.creditos = Math.max(nav.estado.run.creditos, 300);
  yield* loja(nav, { compra: 'clique', saida: 'clique' });
  yield* comecar(nav, 'clique');
  yield* andar(nav, 3, { cartas: 'mouse' });
  yield* morrer(nav);
  yield* quadros(nav, 5);
  nav.clicar($(nav, 'botao-jubilado'));
  yield* quadros(nav, 1);
}

function* segundaRun(nav) {
  // Enter no menu, Espaco no anuncio, pausa, blur e troca de aba, Desistir.
  yield* jogar(nav, 'Enter');
  yield* comecar(nav, 'Space');
  yield* andar(nav, 3, { cartas: 'enter' });
  nav.tecla('Escape');
  yield* quadros(nav, 2);
  nav.perderFoco();
  yield* quadros(nav, 2);
  nav.tecla('Escape');
  yield* quadros(nav, 1);
  yield* andar(nav, 2, { cartas: 'misto' });
  nav.esconderAba(true);
  yield* quadros(nav, 2);
  nav.esconderAba(false);
  yield* quadros(nav, 1, 20000);
  nav.clicar($(nav, 'botao-continuar'));
  yield* quadros(nav, 1);
  yield* andar(nav, 2);
  yield* pausarEDesistir(nav);
}

function* runCompleta(nav) {
  // As 9 avaliacoes, as lojas (compra por tecla e clique, reroll, saida por
  // Enter e clique), o TCC e a colacao — com o recorde gravado.
  const e = nav.estado;
  yield* jogar(nav, 'clique');
  const contador = { cartas: 0 };
  for (let n = 0; e.tela === TELAS.ANUNCIO; n += 1) {
    yield* comecar(nav, n % 2 === 0 ? 'Enter' : 'clique');
    yield* prova(nav, 20, { cartas: 'misto', contador, horda: n % 3 === 2 });
    if (e.tela !== TELAS.RESULTADO) throw new Error(`a run completa caiu na avaliacao ${n + 1}`);
    nav.tecla(n % 2 === 0 ? 'Space' : 'Enter');
    yield* quadros(nav, 1);
    e.run.creditos += 150;
    yield* loja(nav, { compra: n % 2 === 0 ? 'tecla' : 'clique', saida: n % 3 === 0 ? 'enter' : 'clique', rerolar: n % 4 === 1 });
  }
  if (e.tela !== TELAS.TCC) throw new Error(`depois da ultima loja veio "${e.tela}"`);
  yield* ate(nav, () => tccLiberado(e), 2, 'tcc');
  nav.clicar($(nav, 'botao-tcc'));
  yield* quadros(nav, 1);
  yield* defesa(nav);
  yield* ate(nav, () => colacaoLiberada(e), 2, 'colacao');
  nav.tecla('Enter');
  yield* quadros(nav, 1);
  if (e.tela !== TELAS.MENU) throw new Error(`a colacao levou a "${e.tela}"`);
}

function* runDeUmaCarta(nav) {
  // Uma carta so (com o mouse) e Desistir: e a run que deixa a tela de
  // carta com o desenho da versao 1 — a primeira carta da run seguinte tem
  // versao 1 tambem.
  const e = nav.estado;
  yield* jogar(nav, 'clique');
  yield* comecar(nav, 'clique');
  e.player.xp = e.player.xpProximo;
  yield* ate(nav, () => e.tela === TELAS.CARTA, 2, 'carta');
  yield* escolherCarta(nav, 'mouse', { cartas: 1 });
  if (e.cartas.versao !== 1) throw new Error(`a run de uma carta terminou com cartas.versao ${e.cartas.versao}`);
  yield* quadros(nav, 3);
  yield* pausarEDesistir(nav);
}

// A run comparada: o mesmo roteiro num navegador usado e num recem-aberto.
function* runComparada(nav) {
  const e = nav.estado;
  yield* jogar(nav, 'clique');
  yield* comecar(nav, 'Enter');
  const contador = { cartas: 0 };
  // A primeira carta cedo (XP dado), depois as que vierem.
  e.player.xp = e.player.xpProximo;
  yield* prova(nav, 5, { cartas: 'misto', contador });
  nav.tecla('Enter');
  yield* quadros(nav, 1);
  e.run.creditos += 200;
  yield* loja(nav, { compra: 'clique', saida: 'enter', rerolar: true });
  yield* comecar(nav, 'Space');
  yield* andar(nav, 3, { cartas: 'teclado', contador });
}

async function jogarCincoRuns() {
  const usado = abrir();
  rodar(quadros(usado, 3));
  const retratos = [];
  const linhas = [];
  const heap = [];
  let daRun1 = null;
  const medir = async (rotulo) => {
    rodar(quadros(usado, 40)); // 2s no menu: as faiscas da run acabam
    // Depois do gc, o que sobra fora da arvore e o que alguem segura.
    await coletar();
    const c = { ...contadores(usado), ...usado.foraDaArvore() };
    retratos.push(c);
    const tel = usado.estado.telemetria ? JSON.stringify(usado.estado.telemetria).length : 0;
    heap.push(process.memoryUsage().heapUsed);
    linhas.push(`${rotulo}: nos ${c.nos} · escutadores ${c.ouvintesWindow}+${c.ouvintesDocument}+${c.ouvintesElementos} · fora da arvore ${c.vivos} vivos (${c.tags}), ${c.comEscutador} com escutador · pools ${c.pools} · efeitos ${c.efeitos} · telemetria ${(tel / 1024).toFixed(0)} KB`);
    if (usado.estado.tela !== TELAS.MENU) falhar('5 runs', `${rotulo} terminou em "${usado.estado.tela}", nao no menu`);
    if (c.comEscutador > 0) falhar('5 runs', `${rotulo}: ${c.comEscutador} elemento(s) fora da arvore, vivos e com ${c.escutadores} escutador(es) (${c.tags})`);
  };
  const runs = [
    ['run 1 (jubilado na 2a prova)', primeiraRun],
    ['run 2 (pausa, blur, aba, desistir)', segundaRun],
    ['run 3 (completa, colacao)', runCompleta],
    ['run 4 (uma carta e desistir)', runDeUmaCarta],
  ];
  for (const [rotulo, roteiro] of runs) {
    try {
      rodar(roteiro(usado));
    } catch (erro) {
      falhar('5 runs', `${rotulo}: ${erro.stack.split('\n').slice(0, 3).join(' / ')}`);
      return { linhas, heap };
    }
    semErros(usado, rotulo);
    await medir(rotulo);
    // O que era da run 1 tem que morrer: nenhum fechamento, cache ou
    // escutador pode segurar o estado de uma run que acabou.
    if (!daRun1) {
      const e = usado.estado;
      daRun1 = { run: new WeakRef(e.run), avaliacao: new WeakRef(e.run.avaliacao), jogador: new WeakRef(e.player), cartas: new WeakRef(e.cartas), loja: new WeakRef(e.loja) };
    }
  }
  if (usado.localStorage.getItem(CONTEUDO.recorde.chave) === null) falhar('5 runs', 'a run completa nao gravou o recorde');

  const quadro = compararComNavegadorNovo(usado);
  try {
    rodar(pausarEDesistir(usado));
  } catch (erro) {
    falhar('5 runs', `run 5: ${erro.message}`);
  }
  await medir('run 5 (comparada)');
  const vivos = Object.entries(daRun1).filter(([, ref]) => ref.deref() !== undefined).map(([nome]) => nome);
  if (vivos.length > 0) falhar('5 runs', `depois de 4 runs e do gc, ainda vivos da run 1: ${vivos.join(', ')} (alguem segura o estado de uma run que acabou)`);
  else nota('da run 1, depois de 4 runs e do gc: run, avaliacao, jogador, cartas e loja coletados (ninguem segura estado velho)');
  return { linhas, heap, retratos, usado, quadro };
}

// A 5a run, lado a lado com um navegador novo: mesma semente de jogo, mesmo
// tempo, mesmo recorde, mesmo rng dos efeitos. Daqui para frente os dois tem
// que ser o MESMO jogo, quadro a quadro. Devolve quantos quadros comparou.
function compararComNavegadorNovo(usado) {
  const novo = abrir({ armazenamento: usado.localStorage.copia() });
  rodar(quadros(novo, 3));
  // Um quadro longo nos dois zera o acumulador do relogio (o excesso e
  // descartado): dai em diante os dois rodam os mesmos ticks por quadro.
  rodar(quadros(novo, 1, 10000));
  rodar(quadros(usado, 1, 10000));
  novo.estado.rng.s = usado.estado.rng.s;
  novo.estado.tempo = usado.estado.tempo;
  novo.estado.telaAbertaEm = usado.estado.telaAbertaEm;
  Object.assign(novo.estado.recorde, usado.estado.recorde);
  rodar(quadros(novo, 1));
  rodar(quadros(usado, 1));
  efeitosDe(novo.ctx).rng.s = efeitosDe(usado.ctx).rng.s;
  const roteiros = [runComparada(usado), runComparada(novo)];
  usado.ctx.gravar = true;
  novo.ctx.gravar = true;
  let quadro = 0;
  let divergiu = null;
  let comecou = false;
  try {
    for (;;) {
      usado.ctx.zerarResumo();
      novo.ctx.zerarResumo();
      const a = roteiros[0].next();
      const b = roteiros[1].next();
      if (a.done !== b.done) {
        divergiu = `um roteiro acabou antes do outro no quadro ${quadro}`;
        break;
      }
      if (a.done) break;
      quadro += 1;
      if (usado.estado.tela === TELAS.AVALIACAO) comecou = true;
      const ra = usado.retrato({ ignorar: ignorarNoRetrato });
      const rb = novo.retrato({ ignorar: ignorarNoRetrato });
      const i = ra.findIndex((linha, k) => linha !== rb[k]);
      if (i >= 0 || ra.length !== rb.length) {
        divergiu = `o DOM visivel diverge no quadro ${quadro} (tela "${usado.estado.tela}"): usado ${JSON.stringify(ra[i])} x novo ${JSON.stringify(rb[i])}`;
        break;
      }
      if (usado.ctx.resumo !== novo.ctx.resumo) {
        divergiu = `o desenho diverge no quadro ${quadro} (tela "${usado.estado.tela}", ${usado.ctx.reg.ops} x ${novo.ctx.reg.ops} chamadas)`;
        break;
      }
      // O estado inteiro desde o "Jogar": iniciarRun nasce a run, o jogador,
      // as cartas, a loja e as pools.
      const ja = estadoComparavel(usado.estado);
      const jb = estadoComparavel(novo.estado);
      if (ja !== jb) {
        let k = 0;
        while (k < ja.length && ja[k] === jb[k]) k += 1;
        divergiu = `o estado diverge no quadro ${quadro} (tela "${usado.estado.tela}"): usado …${ja.slice(Math.max(0, k - 80), k + 60)}… x novo …${jb.slice(Math.max(0, k - 80), k + 60)}…`;
        break;
      }
    }
  } catch (erro) {
    divergiu = `excecao no roteiro: ${erro.stack.split('\n').slice(0, 3).join(' / ')}`;
  }
  usado.ctx.gravar = false;
  novo.ctx.gravar = false;
  if (divergiu) falhar('reinicio limpo (5a run x navegador novo)', divergiu);
  else if (!comecou || quadro < 100) falhar('reinicio limpo', `a comparacao so cobriu ${quadro} quadros`);
  semErros(usado, 'run 5 (usado)');
  semErros(novo, 'run 5 (novo)');
  return quadro;
}

async function checarCincoRuns() {
  const saida = await jogarCincoRuns();
  if (!saida.retratos) return saida;
  const { retratos, usado, quadro } = saida;

  // Nada cresce de uma run para a outra. Os nos, os escutadores, a fila, o
  // audio e os elementos vivos fora da arvore (as camadas do chao e da
  // vinheta, depois do gc) sao fixos desde a run 1. As pools e os caches do desenho abrem
  // preguicosos (a das perguntas no 1o TCC; uma fonte por tamanho de emoji,
  // uma rajada por tipo de inimigo): fixos desde a run 3, a que passa por
  // tudo, e com teto.
  const FIXOS = ['nos', 'ouvintesWindow', 'ouvintesDocument', 'ouvintesElementos', 'eventos', 'audio', 'pilha', 'vivos', 'comEscutador', 'escutadores', 'tags'];
  const base = retratos[0];
  const completa = retratos[2];
  for (let i = 1; i < retratos.length; i += 1) {
    for (const campo of Object.keys(base)) {
      const referencia = FIXOS.includes(campo) || i < 2 ? base : completa;
      if (i >= 2 || FIXOS.includes(campo)) {
        if (retratos[i][campo] !== referencia[campo]) {
          falhar('5 runs', `"${campo}" mudou da run ${referencia === base ? 1 : 3} para a run ${i + 1}: ${referencia[campo]} -> ${retratos[i][campo]}`);
        }
      }
    }
  }
  const fx = efeitosDe(usado.ctx);
  // Uma rajada por tipo de inimigo, mais a da Banca e a do jogador (jubilado).
  if (fx.rajadas.size > CONTEUDO.inimigos.length + 2) falhar('5 runs', `${fx.rajadas.size} rajadas guardadas para ${CONTEUDO.inimigos.length} tipos`);
  for (const [nome, pool] of Object.entries(obterScratch(usado.estado).pools || {})) {
    if (pool.criados !== pool.capacidade || pool.verificar()) falhar('5 runs', `pool ${nome}: criados ${pool.criados} de ${pool.capacidade} (${pool.verificar() || 'ok'})`);
  }
  if (base.pilha !== 0) falhar('5 runs', `o desenho ficou com ${base.pilha} save() sem restore()`);
  if (base.audio !== 1) falhar('5 runs', `${base.audio} AudioContext criados (esperava 1, no primeiro gesto)`);
  if (usado.audio.vozes === 0) falhar('5 runs', 'nenhum som tocou em 5 runs');
  nota(`reinicio limpo: ${quadro} quadros identicos (estado, DOM e desenho) entre a 5a run e um navegador novo`);
  nota(`jogo nas 5 runs: ${medido.mortes} mortos em boletim, pico de ${medido.picoInimigos} inimigos e ${medido.picoFaiscas} faiscas`);
  nota(`audio: ${usado.audio.vozes} vozes, ${usado.audio.nos} nos em 5 runs; ${usado.document._criados} elementos criados pelo jogo em 5 runs (as camadas do chao a cada troca de periodo, o canvas do teste de emoji; o que nao esta na arvore e morre no gc)`);
  return saida;
}

// ------------------------------------------------------------------- main

const secoes = [];
function secao(nome, fn) {
  const t0 = Date.now();
  const antes = falhas.length;
  let saida;
  try {
    saida = fn();
  } catch (erro) {
    falhar(nome, `excecao: ${erro.stack.split('\n').slice(0, 4).join(' / ')}`);
  }
  secoes.push(`${nome}: ${falhas.length === antes ? 'ok' : `${falhas.length - antes} falha(s)`} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return saida;
}

async function secaoAssincrona(nome, fn) {
  const t0 = Date.now();
  const antes = falhas.length;
  let saida;
  try {
    saida = await fn();
  } catch (erro) {
    falhar(nome, `excecao: ${erro.stack.split('\n').slice(0, 4).join(' / ')}`);
  }
  secoes.push(`${nome}: ${falhas.length === antes ? 'ok' : `${falhas.length - antes} falha(s)`} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return saida;
}

const contagemInicial = secao('fiacao', checarFiacao);
const combinacoes = secao('teclado em toda tela', checarTeclado);
const casosFoco = secao('blur e troca de aba em toda tela', checarFoco);
secao('cliques', checarCliques);
secao('emoji sem fonte', checarEmoji);
const cinco = (await secaoAssincrona('5 runs seguidas e reinicio limpo', checarCincoRuns)) || { linhas: [], heap: [] };

console.log(`dom: ${secoes.join(' · ')}`);
if (VERBOSO || falhas.length === 0) {
  if (contagemInicial) {
    const c = contagemInicial;
    console.log(`  depois de iniciar(): ${c.nos} nos no DOM · escutadores: window ${c.ouvintesWindow}, document ${c.ouvintesDocument}, elementos ${c.ouvintesElementos}`);
  }
  console.log(`  teclado: ${combinacoes || 0} combinacoes tela x tecla · foco: ${casosFoco || 0} casos`);
  for (const linha of cinco.linhas) console.log(`  ${linha}`);
  if (cinco.heap.length > 0) console.log(`  heap depois de gc, por run: ${cinco.heap.map((b) => (b / 1048576).toFixed(1)).join(' · ')} MB`);
  for (const n of notas) console.log(`  ${n}`);
}
if (falhas.length > 0) {
  console.error(`\ndom FALHOU — ${falhas.length} problema(s):`);
  for (const f of falhas.slice(0, 40)) console.error(`  x ${f}`);
  if (falhas.length > 40) console.error(`  ... e mais ${falhas.length - 40}`);
  process.exit(1);
}
console.log(`dom ok em ${((Date.now() - inicio) / 1000).toFixed(1)}s`);
