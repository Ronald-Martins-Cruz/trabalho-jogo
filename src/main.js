import { CONTEUDO } from '../data/content.js';
import { novoEstado, iniciarAvaliacao, irParaTela, emitir, TELAS } from './state.js';
import { desenhar } from './render.js';
import { criarUi } from './ui.js';
import { atualizarPlayer, atualizarOrbes } from './player.js';
import { atualizarInimigos } from './enemies.js';
import { atualizarArmas } from './weapons.js';
import { apontarCarta, atualizarCartas, escolherCarta, moverSelecaoCarta } from './cards.js';

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
      break;
    default:
      break;
  }
}

function atualizarAvaliacao(estado, dt) {
  const av = estado.run.avaliacao;
  atualizarPlayer(estado, dt);
  if (av.concluida) return;

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
  // Provisorio, igual ao fim por tempo: a fase 10 poe a tela de fim no lugar
  // do menu.
  if (!estado.player.vivo) {
    emitir(estado, 'jubilado', av.id);
    irParaTela(estado, TELAS.MENU);
    return;
  }

  if (av.restante <= 0) {
    av.concluida = true;
    emitir(estado, 'avaliacao-fim', av.id);
    // Provisorio: a fase 06 poe a tela de resultado no lugar do menu.
    irParaTela(estado, TELAS.MENU);
    return;
  }

  // Por ultimo, e so com a avaliacao ainda de pe: morte e fim do cronometro
  // ganham do nivel que subiu no mesmo quadro. Uma carta aberta por cima de
  // uma avaliacao ja encerrada travaria a tela.
  atualizarCartas(estado);
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
    jogar: () => iniciarAvaliacao(estado),
    continuar: () => irParaTela(estado, TELAS.AVALIACAO),
    menu: () => irParaTela(estado, TELAS.MENU),
  });
  // Mouse na carta: a UI nao mexe no estado nem na classe CSS, so avisa qual
  // indice foi apontado ou escolhido. Mesmo caminho do teclado, e por isso
  // apontar com o mouse e confirmar com Enter leva a carta certa.
  ui.ligarCartas(
    (indice) => escolherCarta(estado, indice),
    (indice) => apontarCarta(estado, indice)
  );

  const { passo, maxPassosPorFrame } = CONTEUDO.loop;
  let anterior = performance.now();
  let acumulador = 0;

  function frame(agora) {
    acumulador += (agora - anterior) / 1000;
    anterior = agora;

    let passos = 0;
    while (acumulador >= passo && passos < maxPassosPorFrame) {
      atualizar(estado, passo);
      acumulador -= passo;
      passos += 1;
    }
    // Sobrou tempo alem do teto? Descarta, senao o loop espirala tentando
    // alcancar o relogio (aba que voltou do background).
    if (acumulador > passo * maxPassosPorFrame) acumulador = 0;

    desenhar(estado, ctx);
    ui.sincronizar(estado);
    // Consumidor da fila: a fase 11 poe audio.js aqui, antes de esvaziar.
    estado.eventos.length = 0;

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
  return estado;
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
  });
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
