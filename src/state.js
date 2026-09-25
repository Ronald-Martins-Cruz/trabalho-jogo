import { CONTEUDO } from '../data/content.js';
import { criarRng } from './rng.js';
import { criarRastro, xpParaSubir } from './player.js';
import { liberarPoolsDoEstado } from './pool.js';

// O estado do jogo inteiro em um objeto so, sem classes e sem singleton
// escondido. Quem precisa do estado o recebe como argumento. Todos os campos
// sao serializaveis (numeros, strings, arrays e objetos simples) — o rng
// guarda seu estado interno em rng.s, nao em closure.

export const TELAS = {
  MENU: 'menu',
  AVALIACAO: 'avaliacao',
  PAUSA: 'pausa',
  CARTA: 'carta',
  RESULTADO: 'resultado', // sobreviveu ao cronometro: nota, conceito, creditos
  JUBILADO: 'jubilado', // o HP zerou
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

    cartas: novasCartas(),

    run: novaRun(),

    // O que o relatorio de balanceamento le (debug.relatorio). Fica FORA de
    // `run` porque atravessa as partidas da sessao inteira, e nasce preguicoso
    // em src/telemetria.js no primeiro tick observado — criar aqui fecharia o
    // ciclo state.js <-> telemetria.js. Nenhum sistema do jogo le daqui.
    telemetria: null,
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
    xpProximo: xpParaSubir(1),
    invulneravel: 0, // segundos restantes de i-frames
    vivo: true,
    armas: [],
    // Buffer circular de tamanho fixo para o rastro visual — alocado aqui,
    // uma vez por avaliacao, nunca dentro do update (restricao 5).
    rastro: criarRastro(),
  };
}

// A tela de carta e o unico ponto em que a simulacao para esperando o jogador.
// `escolha` e a porta por onde a decisao entra, do mesmo jeito que `input`
// traz o teclado: o DOM escreve, o update le. Nada aqui e funcao nem
// referencia de no — o estado continua serializavel.
export function novasCartas() {
  const quantidade = CONTEUDO.cartas.quantidade;
  const opcoes = [];
  // Os slots sao fixos e sempre preenchidos (a carta de consolo completa o que
  // faltar), entao `opcoes.length` nunca muda e nenhum objeto nasce no update.
  for (let i = 0; i < quantidade; i += 1) opcoes.push(novaOpcao());
  return {
    fila: 0, // niveis ganhos e ainda nao gastos: dois de uma vez viram duas cartas
    opcoes,
    selecionada: 0, // cursor do teclado
    escolha: null, // indice escolhido; a simulacao consome e zera
    versao: 0, // muda a cada sorteio novo; e como a UI sabe que precisa redesenhar
    escolhidas: 0, // quantas cartas o jogador pegou nesta avaliacao
  };
}

function novaOpcao() {
  return {
    tipo: '',
    id: '',
    nome: '',
    descricao: '',
    emoji: '',
    nivelAtual: 0,
    nivelProximo: 0,
    valor: 0,
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
    resultado: novoResultado(),
  };
}

// O boletim da ultima avaliacao encerrada. Nasce com a run e e PREENCHIDO por
// fecharAvaliacao() (run.js), nunca substituido: a tela de resultado le daqui
// todo frame e nada e alocado no fim da avaliacao. Tudo numero, string ou
// booleano — o estado continua serializavel.
export function novoResultado() {
  return {
    id: '',
    nome: '',
    periodo: '',
    motivo: '', // 'tempo' (aprovado) ou 'jubilado'
    aprovado: false,
    kills: 0,
    danoTomado: 0,
    ileso: false,
    nivel: 1,
    hp: 0,
    hpMax: 0,
    hpFracao: 0,
    tempo: 0, // segundos sobrevividos
    duracao: 0,
    nota: 0,
    conceito: '',
    // De onde cada ponto da nota veio. E o que a tela decompoe para o jogador.
    parcelas: { kills: 0, hp: 0, ileso: 0 },
    creditos: 0, // ganhos nesta avaliacao
    creditosTotal: 0, // o que a run tem depois de somar
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
  estado.cartas = novasCartas();
  // Nunca esvazie essas colecoes na mao: elas sao as listas de ativos das
  // pools, e `length = 0` tira os objetos de `ativos` sem devolve-los a
  // `reserva`. Reatribuir (`estado.enemies = []`) e pior ainda — a pool
  // continuaria escrevendo no array antigo.
  liberarPoolsDoEstado(estado);
  irParaTela(estado, TELAS.AVALIACAO);
  emitir(estado, 'avaliacao-inicio', estado.run.avaliacao.id);
}
