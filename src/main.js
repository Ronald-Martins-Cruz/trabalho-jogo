import { CONTEUDO } from '../data/content.js';
import { novoEstado, iniciarAvaliacao, irParaTela, emitir, TELAS } from './state.js';
import { desenhar } from './render.js';
import { criarUi } from './ui.js';
import { atualizarPlayer } from './player.js';
import { atualizarInimigos } from './enemies.js';
import { atualizarArmas } from './weapons.js';

// Nada de document/window no topo deste modulo: e o que permite ao node
// importar `atualizar` e rodar a partida inteira sem navegador.

// ---------------------------------------------------------------- simulacao

export function atualizar(estado, dt) {
  estado.tempo += dt;

  switch (estado.tela) {
    case TELAS.AVALIACAO:
      atualizarAvaliacao(estado, dt);
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
  }
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

export function alternarPausa(estado) {
  if (estado.tela === TELAS.AVALIACAO) irParaTela(estado, TELAS.PAUSA);
  else if (estado.tela === TELAS.PAUSA) irParaTela(estado, TELAS.AVALIACAO);
}
