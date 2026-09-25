import { CONTEUDO } from '../data/content.js';
import { novoEstado, irParaTela, emitir, TELAS } from './state.js';
import { desenhar } from './render.js';
import { criarUi } from './ui.js';
import { atualizarPlayer, atualizarOrbes } from './player.js';
import { atualizarInimigos } from './enemies.js';
import { atualizarArmas } from './weapons.js';
import { apontarCarta, atualizarCartas, escolherCarta, moverSelecaoCarta } from './cards.js';
import { fecharAvaliacao, iniciarRun, MOTIVO_JUBILADO, MOTIVO_TEMPO } from './run.js';
import { observarTick, registrarQuadro } from './telemetria.js';
import { gerarRelatorio } from './relatorio.js';

// Nada de document/window no topo deste modulo: e o que permite ao node
// importar `atualizar` e rodar a partida inteira sem navegador.

// ---------------------------------------------------------------- simulacao

export function atualizar(estado, dt) {
  estado.tempo += dt;

  switch (estado.tela) {
    case TELAS.AVALIACAO:
      atualizarAvaliacao(estado, dt);
      break;
    case TELAS.CARTA:
      // A simulacao inteira congela: so a escolha da carta anda. O cronometro
      // da avaliacao para junto, de proposito — a pausa e a recompensa.
      atualizarCartas(estado);
      break;
    case TELAS.MENU:
    case TELAS.PAUSA:
    case TELAS.RESULTADO:
    case TELAS.JUBILADO:
      // Nada roda: a partida inteira fica congelada por tras do overlay. Toda
      // tela nova entra aqui — o `default` congela igual, mas listar deixa
      // explicito que foi decisao, nao esquecimento.
      break;
    default:
      break;
  }

  // Por ultimo e em qualquer tela: o relatorio de balanceamento so observa o
  // que este tick ja fez (debug.relatorio; desligado, retorna na hora).
  observarTick(estado, dt);
}

function atualizarAvaliacao(estado, dt) {
  const av = estado.run.avaliacao;
  // O guard vem ANTES de tudo, inclusive do jogador. Enquanto atualizarPlayer
  // ficou acima dele (fases 01 a 05) isso era inofensivo, porque o tick que
  // encerrava a avaliacao tambem saia da tela; com a tela de resultado no
  // lugar do menu, um caminho que voltasse aqui com a avaliacao concluida
  // deixaria o jogador andando atras do overlay. Pendencia 9 do ESTADO.md.
  if (av.concluida) return;
  atualizarPlayer(estado, dt);

  av.decorrido += dt;
  av.restante = Math.max(0, av.duracao - av.decorrido);

  atualizarInimigos(estado, dt);
  // Depois dos inimigos: as armas miram e os projeteis colidem com as posicoes
  // ja integradas deste quadro, nao com as do quadro anterior.
  atualizarArmas(estado, dt);

  // Orbes por ultimo: os que nasceram das mortes deste quadro ja sao atraidos.
  // O evento sai daqui, e nao de dentro de player.js, porque player.js nao
  // pode importar state.js (state.js ja importa criarRastro de la).
  const xpAntes = estado.player.xp;
  atualizarOrbes(estado, dt);
  if (estado.player.xp > xpAntes) emitir(estado, 'xp-coletado', estado.player.xp - xpAntes);

  // Unico observador da morte do jogador: qualquer fonte de dano (inimigo
  // agora, modificador e chefe depois) so precisa zerar o hp via receberDano().
  if (!estado.player.vivo) {
    av.concluida = true;
    emitir(estado, 'jubilado', av.id);
    fecharAvaliacao(estado, MOTIVO_JUBILADO);
    irParaTela(estado, TELAS.JUBILADO);
    return;
  }

  if (av.restante <= 0) {
    av.concluida = true;
    emitir(estado, 'avaliacao-fim', av.id);
    fecharAvaliacao(estado, MOTIVO_TEMPO);
    irParaTela(estado, TELAS.RESULTADO);
    return;
  }

  // Por ultimo, e so com a avaliacao ainda de pe: morte e fim do cronometro
  // ganham do nivel que subiu no mesmo quadro. Uma carta aberta por cima de
  // uma avaliacao ja encerrada travaria a tela.
  atualizarCartas(estado);
}

// ------------------------------------------------------- relogio do quadro

// O acumulador de dt fixo, separado do navegador para poder ser testado. Um
// acumulador mal cuidado e o bug classico da pausa: a aba volta do background
// (ou o jogador fica 30s no ESC), o relogio de parede acumula tudo isso e o
// quadro seguinte roda 1800 passos de uma vez — o jogo "pula" e o jogador
// perde HP que nao viu chegar.
export function criarRelogio() {
  return { acumulador: 0, passos: 0, descartado: 0 };
}

// Converte tempo de parede em passos de dt fixo, no maximo
// loop.maxPassosPorFrame por quadro. O que passar disso e DESCARTADO em vez de
// ficar na divida: recuperar o atraso e o que espirala.
export function avancarRelogio(relogio, dtReal) {
  const { passo, maxPassosPorFrame } = CONTEUDO.loop;
  if (Number.isFinite(dtReal) && dtReal > 0) relogio.acumulador += dtReal;

  let passos = 0;
  while (relogio.acumulador >= passo && passos < maxPassosPorFrame) {
    relogio.acumulador -= passo;
    passos += 1;
  }
  if (passos >= maxPassosPorFrame && relogio.acumulador > 0) {
    relogio.descartado += relogio.acumulador;
    relogio.acumulador = 0;
  }

  relogio.passos = passos;
  return passos;
}

// ------------------------------------------------------------------ browser

export function iniciar() {
  const canvas = document.getElementById('palco');
  const ctx = canvas.getContext('2d');
  canvas.width = CONTEUDO.arena.largura;
  canvas.height = CONTEUDO.arena.altura;

  const estado = novoEstado(Date.now() >>> 0);
  const ui = criarUi(document);

  ligarTeclado(estado);
  ui.ligarBotoes({
    jogar: () => iniciarRun(estado),
    continuar: () => irParaTela(estado, TELAS.AVALIACAO),
    menu: () => irParaTela(estado, TELAS.MENU),
    // Os dois botoes de fim de avaliacao chamam a MESMA funcao que o teclado:
    // quem decide para onde ir e a simulacao, nao o DOM. Fase 07: e aqui que
    // a loja entra no lugar do menu.
    resultado: () => sairDoResultado(estado),
    jubilado: () => sairDoResultado(estado),
  });
  // Mouse na carta: a UI nao mexe no estado nem na classe CSS, so avisa qual
  // indice foi apontado ou escolhido. Mesmo caminho do teclado, e por isso
  // apontar com o mouse e confirmar com Enter leva a carta certa.
  ui.ligarCartas(
    (indice) => escolherCarta(estado, indice),
    (indice) => apontarCarta(estado, indice)
  );
  // Botoes de relatorio (debug.relatorio): a UI pede um escopo, a montagem e
  // pura (relatorio.js) e baixar/copiar e com a UI.
  ui.ligarRelatorio((escopo) => arquivoDoRelatorio(estado, escopo));

  const passo = CONTEUDO.loop.passo;
  const relogio = criarRelogio();
  let anterior = performance.now();

  function frame(agora) {
    const dtReal = (agora - anterior) / 1000;
    const passos = avancarRelogio(relogio, dtReal);
    anterior = agora;
    for (let i = 0; i < passos; i += 1) atualizar(estado, passo);
    registrarQuadro(estado, dtReal, passos);

    desenhar(estado, ctx);
    ui.sincronizar(estado);
    // Consumidor da fila: a fase 11 poe audio.js aqui, antes de esvaziar.
    estado.eventos.length = 0;

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
  return estado;
}

// O relatorio pedido por um botao: texto pronto e nome de arquivo com a hora
// local, que so o navegador sabe — a simulacao nunca le relogio de parede.
function arquivoDoRelatorio(estado, escopo) {
  const agora = new Date();
  const relatorio = gerarRelatorio(estado, escopo, ambienteDoNavegador(agora));
  if (!relatorio) return null;
  const dois = (n) => String(n).padStart(2, '0');
  const carimbo =
    `${agora.getFullYear()}-${dois(agora.getMonth() + 1)}-${dois(agora.getDate())}` +
    `_${dois(agora.getHours())}h${dois(agora.getMinutes())}m${dois(agora.getSeconds())}s`;
  return { nome: `relatorio_${relatorio.nomeBase}_${carimbo}.md`, texto: relatorio.texto };
}

// Onde a partida rodou. Fps baixo muda a dificuldade sentida (o relogio
// descarta tempo em vez de acelerar), entao isso entra no relatorio.
function ambienteDoNavegador(agora) {
  const tela = window.screen || {};
  let fuso = '';
  try {
    fuso = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    fuso = '';
  }
  return {
    geradoEm: agora.toISOString(),
    geradoEmLocal: agora.toLocaleString('pt-BR'),
    fusoHorario: fuso,
    navegador: navigator.userAgent,
    idioma: navigator.language,
    tela: `${tela.width || 0}x${tela.height || 0}`,
    janela: `${window.innerWidth}x${window.innerHeight}`,
    pixelRatio: window.devicePixelRatio || 1,
  };
}

const MAPA_TECLAS = {
  KeyW: 'cima',
  ArrowUp: 'cima',
  KeyS: 'baixo',
  ArrowDown: 'baixo',
  KeyA: 'esquerda',
  ArrowLeft: 'esquerda',
  KeyD: 'direita',
  ArrowRight: 'direita',
};

function ligarTeclado(estado) {
  const aplicar = (code, apertada) => {
    const acao = MAPA_TECLAS[code];
    if (!acao) return false;
    estado.input.teclas[acao] = apertada;
    const t = estado.input.teclas;
    estado.input.eixoX = (t.direita ? 1 : 0) - (t.esquerda ? 1 : 0);
    estado.input.eixoY = (t.baixo ? 1 : 0) - (t.cima ? 1 : 0);
    return true;
  };

  window.addEventListener('keydown', (ev) => {
    // A carta come a tecla antes do movimento: as setas navegam entre as
    // opcoes em vez de empurrar um jogador que esta congelado de qualquer
    // jeito. O keyup segue chamando aplicar(), entao nenhuma tecla fica presa.
    if (estado.tela === TELAS.CARTA && !ev.repeat && teclaDaCarta(estado, ev.code)) {
      ev.preventDefault();
      return;
    }
    // Tela de fim de avaliacao: Enter e Espaco seguem adiante. Sem isto
    // o jogador precisaria achar o botao com o mouse (ou com Tab) para sair.
    if (!ev.repeat && TECLAS_SEGUIR.has(ev.code) && sairDoResultado(estado)) {
      ev.preventDefault();
      return;
    }
    if (aplicar(ev.code, true)) ev.preventDefault();
    // ev.repeat: segurar ESC repete o keydown ~30x/s e a pausa piscaria.
    if (ev.code === 'Escape' && !ev.repeat) alternarPausa(estado);
  });

  window.addEventListener('keyup', (ev) => {
    if (aplicar(ev.code, false)) ev.preventDefault();
  });

  // Aba escondida nao deixa tecla presa para sempre.
  window.addEventListener('blur', () => {
    estado.input.teclas = {};
    estado.input.eixoX = 0;
    estado.input.eixoY = 0;
    // E nao deixa o jogador morrer enquanto olha para outra janela: trocar de
    // aba no meio da apresentacao pausa a avaliacao, como o ESC.
    if (estado.tela === TELAS.AVALIACAO) irParaTela(estado, TELAS.PAUSA);
  });

  // Minimizar ou trocar de aba nem sempre dispara `blur` (depende do
  // navegador e de onde estava o foco). visibilitychange cobre o resto.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && estado.tela === TELAS.AVALIACAO) irParaTela(estado, TELAS.PAUSA);
  });
}

// Enter/Espaco seguem adiante na tela de resultado e na de jubilado. ESC NAO:
// quem aperta ESC para pausar no instante em que o cronometro zera fecharia o
// boletim sem ler. Na tela de fim o ESC cai em alternarPausa, que nao faz nada.
const TECLAS_SEGUIR = new Set(['Enter', 'NumpadEnter', 'Space']);

// A unica saida das duas telas de fim de avaliacao, usada pelo teclado e
// pelos dois botoes. Devolve false quando nao ha nada para fechar — e o que
// deixa o mesmo keydown cair para a pausa e para o movimento.
export function sairDoResultado(estado) {
  if (estado.tela !== TELAS.RESULTADO && estado.tela !== TELAS.JUBILADO) return false;
  // Fase 07: aprovado vai para a loja daqui; jubilado continua indo ao menu,
  // porque a run acabou.
  irParaTela(estado, TELAS.MENU);
  return true;
}

// Mouse pode falhar na apresentacao; teclado nao. 1/2/3 escolhe direto,
// setas movem o cursor e Enter confirma. O indice sai do proprio nome da tecla
// para acompanhar CONTEUDO.cartas.quantidade sem tabela para manter.
function teclaDaCarta(estado, code) {
  if (/^(Digit|Numpad)[1-9]$/.test(code)) {
    return escolherCarta(estado, Number(code.slice(-1)) - 1);
  }
  if (code === 'ArrowLeft' || code === 'KeyA') return moverSelecaoCarta(estado, -1);
  if (code === 'ArrowRight' || code === 'KeyD') return moverSelecaoCarta(estado, 1);
  if (code === 'Enter' || code === 'Space' || code === 'NumpadEnter') {
    return escolherCarta(estado, estado.cartas.selecionada);
  }
  return false;
}

export function alternarPausa(estado) {
  if (estado.tela === TELAS.AVALIACAO) irParaTela(estado, TELAS.PAUSA);
  else if (estado.tela === TELAS.PAUSA) irParaTela(estado, TELAS.AVALIACAO);
}
