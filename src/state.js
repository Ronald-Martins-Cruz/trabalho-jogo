import { CONTEUDO } from '../data/content.js';
import { criarRng } from './rng.js';
import { criarRastro } from './player.js';

// O estado do jogo inteiro em um objeto so, sem classes e sem singleton
// escondido. Quem precisa do estado o recebe como argumento. Todos os campos
// sao serializaveis (numeros, strings, arrays e objetos simples) — o rng
// guarda seu estado interno em rng.s, nao em closure.

export const TELAS = {
  MENU: 'menu',
  AVALIACAO: 'avaliacao',
  PAUSA: 'pausa',
};

export function novoEstado(seed = 1) {
  const estado = {
    tela: TELAS.MENU,
    tempo: 0, // segundos simulados desde novoEstado(); so cresce
    rng: criarRng(seed),

    // Ponte entre o DOM e a simulacao: iniciar() escreve, atualizar() le.
    // Nenhuma funcao de update toca em document/window — le daqui.
    input: { eixoX: 0, eixoY: 0, teclas: {} },

    player: novoPlayer(),

    // Pools. Nascem vazias e ficam vazias ate a fase dona chegar; a forma do
    // estado nao pode mudar debaixo do smoke test.
    enemies: [],
    projectiles: [],
    xpOrbs: [],
    particles: [],

    // Fila de eventos consumida por audio.js e pelo render (juice). A fisica
    // so empilha, nunca chama audio direto.
    eventos: [],

    run: novaRun(),
  };
  return estado;
}

export function novoPlayer() {
  const cfg = CONTEUDO.jogador;
  return {
    x: CONTEUDO.arena.largura / 2,
    y: CONTEUDO.arena.altura / 2,
    vx: 0,
    vy: 0,
    hp: cfg.hpMax,
    hpMax: cfg.hpMax,
    raio: cfg.raio,
    velocidade: cfg.velocidade,
    nivel: 1,
    xp: 0,
    xpProximo: cfg.xpBase,
    invulneravel: 0, // segundos restantes de i-frames
    vivo: true,
    armas: [],
    // Buffer circular de tamanho fixo para o rastro visual — alocado aqui,
    // uma vez por avaliacao, nunca dentro do update (restricao 5).
    rastro: criarRastro(),
  };
}

export function novaRun() {
  return {
    periodoIndex: 0,
    avaliacaoIndex: 0,
    creditos: 0,
    coringas: [],
    nota: 0,
    conceito: null,
    jubilado: false,
    avaliacao: novaAvaliacao(0, 0),
  };
}

export function novaAvaliacao(periodoIndex, avaliacaoIndex) {
  const periodo = CONTEUDO.periodos[periodoIndex];
  const dados = periodo ? periodo.avaliacoes[avaliacaoIndex] : null;
  // Degradar em silencio aqui daria uma avaliacao de duracao 0: ela encerraria
  // no primeiro tick e a run viraria um moinho invisivel, com os testes verdes.
  if (!dados) {
    throw new Error(
      `novaAvaliacao: nao existe periodos[${periodoIndex}].avaliacoes[${avaliacaoIndex}] em content.js ` +
        `(${CONTEUDO.periodos.length} periodos). Cheque os limites antes de avancar a run.`
    );
  }
  const { duracao } = dados;
  return {
    id: dados.id,
    nome: dados.nome,
    periodo: periodo.nome,
    tipo: dados.tipo,
    duracao,
    restante: duracao,
    decorrido: 0,
    kills: 0,
    danoTomado: 0,
    concluida: false,
  };
}

// Unica porta de entrada da fila de eventos. Descarta o mais antigo ao bater
// no teto para que a fila nunca cresca sem limite se ninguem consumir.
export function emitir(estado, tipo, dados = null) {
  estado.eventos.push({ tipo, dados, t: estado.tempo });
  const teto = CONTEUDO.arena.limites.eventos;
  while (estado.eventos.length > teto) estado.eventos.shift();
}

export function irParaTela(estado, tela) {
  if (estado.tela === tela) return;
  estado.tela = tela;
  emitir(estado, 'tela', tela);
}

// Prepara uma avaliacao do zero: pools limpas, player inteiro, timer cheio.
// run.js assume esta funcao na fase 08, quando a run passa a ter progressao.
export function iniciarAvaliacao(estado, periodoIndex = 0, avaliacaoIndex = 0) {
  estado.run.periodoIndex = periodoIndex;
  estado.run.avaliacaoIndex = avaliacaoIndex;
  estado.run.avaliacao = novaAvaliacao(periodoIndex, avaliacaoIndex);
  estado.player = novoPlayer();
  estado.enemies.length = 0;
  estado.projectiles.length = 0;
  estado.xpOrbs.length = 0;
  estado.particles.length = 0;
  irParaTela(estado, TELAS.AVALIACAO);
  emitir(estado, 'avaliacao-inicio', estado.run.avaliacao.id);
}
