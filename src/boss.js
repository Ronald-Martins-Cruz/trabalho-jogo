import { CONTEUDO } from '../data/content.js';
import { emitir } from './state.js';
import { existeMovimento, poolInimigos, spawnInimigo, spawnTipo } from './enemies.js';
import { limitarNaArena, receberDano } from './player.js';
import { obterPool } from './pool.js';

// A Banca (design §10): o chefe do TCC.
//
// Ela HERDA TUDO DE INIMIGO. O corpo dela e um objeto da pool de inimigos
// (enemies.js, spawnTipo), com o tipo CONTEUDO.banca: anda pelo mesmo
// moverInimigos, encosta e machuca pelo mesmo colidirComJogador (fonte
// 'banca'), toma dano das armas pelo mesmo aplicarDano. O que mora aqui e so o
// que e genuinamente novo:
//   - a maquina de estados de fase e o temporizador de padroes (abaixo);
//   - os padroes, cada um com aviso (telegrafo) antes do golpe;
//   - as perguntas do leque, numa pool propria (estado.perguntas): sao os
//     unicos projeteis do jogo que acertam o JOGADOR.
// A barra de HP no topo e da ui.js; o desenho, da render.js. Os dois so leem
// estado.run.avaliacao.banca (o espelho escrito aqui).
//
// Maquina de estados (b.estado), um relogio so (b.relogio, segundos que
// faltam no estado; anda so dentro da avaliacao, com o dt dela — nunca com
// estado.tempo, que corre na pausa e na carta):
//
//   ENTRADA --entrada.duracao--> PERSEGUINDO --fase.intervalo-->
//   TELEGRAFO (parada, aviso na tela) --padrao.telegrafo--> EXECUTANDO
//   (o golpe; o leque pode ter varias salvas, a investida corre ate o fim da
//   faixa ou a parede) --> RECUPERANDO (parada) --padrao.recuperacao-->
//   PERSEGUINDO --> ... proximo padrao da `sequencia` da fase, em ciclo.
//
//   HP <= fases[f].ate * hpMax, em qualquer estado --> TRANSICAO (parada,
//   sem atacar, HP preso no limiar) --transicao.duracao--> PERSEGUINDO na
//   fase f+1. Nenhum golpe da fase anterior continua depois da virada.
//
//   O corpo sumiu da pool --> DERROTADA (bancaVencida, chamada por main.js
//   depois das armas). O corpo nunca sai da pool por outro caminho: ela e
//   grampeada na arena todo tick (o descarte de enemies.js nunca a alcanca) e
//   todo spawn que poderia enche-la respeita spawn.maxSimultaneos, longe do
//   teto da pool (a reciclagem do mais antigo nunca chega nela).
//
// Referencia ao corpo: SO pelo `nasc` (pendencias 13 e 67). A pool e LIFO e
// reaproveita o objeto da Banca morta no proximo spawn — um 📕 invocado no
// mesmo tick ganharia a referencia dela. O `nasc` e unico por obter(), entao
// acharBanca() nunca confunde os dois.

export const ESTADOS_BANCA = Object.freeze({
  ENTRADA: 'entrada',
  PERSEGUINDO: 'perseguindo',
  TELEGRAFO: 'telegrafo',
  EXECUTANDO: 'executando',
  RECUPERANDO: 'recuperando',
  TRANSICAO: 'transicao',
  DERROTADA: 'derrotada',
});
const E = ESTADOS_BANCA;

// O comportamento de movimento (enemies.js, MOVIMENTOS) que a investida usa.
const MOVIMENTO_INVESTIDA = 'rumo';

// Registro dos padroes — o mesmo "dado, nao classe" das armas e dos
// movimentos: content.js nomeia o padrao, aqui mora o que ele faz.
//   preparar(estado, b, corpo, params)  no inicio do aviso: fixa mira e pontos
//   executar(estado, b, corpo, params)  no fim do aviso: o golpe
//   continuar(estado, b, corpo, params, bateu) -> terminou?   a cada tick do
//                                       golpe (null = golpe instantaneo)
//   encerrar(b, corpo)                  devolve o corpo ao normal (fim, ou
//                                       transicao no meio do golpe)
const PADROES = {
  leque: { preparar: prepararLeque, executar: executarLeque, continuar: continuarLeque, encerrar: null },
  investida: { preparar: prepararInvestida, executar: executarInvestida, continuar: continuarInvestida, encerrar: encerrarInvestida },
  horda: { preparar: prepararHorda, executar: executarHorda, continuar: null, encerrar: null },
};

// Os nomes que existem, para a UI e o smoke nao repetirem a lista.
export const NOMES_PADROES = Object.freeze(Object.keys(PADROES));

// ------------------------------------------------------------------ estado

// O estado da Banca dentro da avaliacao do TCC (av.banca). Tudo numero,
// string ou booleano; os pontos da horda sao alocados aqui, uma vez, com o
// maior `quantidade` de content.js — o padrao so reescreve x/y.
export function novaBanca(cfg = CONTEUDO.banca) {
  let maxPontos = 0;
  for (const fase of cfg.fases) {
    for (const padrao of Object.values(fase.padroes)) {
      if (typeof padrao.quantidade === 'number' && padrao.quantidade > maxPontos) maxPontos = padrao.quantidade;
    }
  }
  const pontos = [];
  for (let i = 0; i < maxPontos; i += 1) pontos.push({ x: 0, y: 0 });
  return {
    nasc: 0, // `nasc` do corpo na pool de inimigos (0 = ainda nao nasceu)
    estado: E.ENTRADA,
    fase: 0, // indice em banca.fases
    padrao: '', // nome do padrao em aviso ou execucao ('' fora deles)
    passo: 0, // proximo indice da sequencia da fase (em ciclo)
    relogio: 0, // segundos que faltam no estado atual
    duracaoEstado: 0, // duracao total do estado atual: o render tira o progresso do aviso daqui
    mira: 0, // rad: direcao do leque e da investida, fixada no INICIO do aviso
    alcance: 0, // px: o comprimento real da investida (cortado na parede da arena)
    salvas: 0, // salvas de leque que ainda faltam sair
    pontos, // onde a horda vai nascer (o aviso mostra circulos ali)
    quantosPontos: 0,
    // Espelho do corpo, escrito a cada tick: a UI desenha a barra daqui e a
    // tela de jubilado diz quanto faltava.
    hp: 0,
    hpMax: 0,
    x: 0,
    y: 0,
  };
}

// Nasce o corpo no topo da arena e liga a maquina. Chamado por run.js
// (comecarTcc) depois de a avaliacao do TCC ja existir, com av.banca.
export function iniciarBanca(estado) {
  const av = estado.run.avaliacao;
  const cfg = CONTEUDO.banca;
  const b = av.banca;
  const arena = av.arena;
  const corpo = spawnTipo(estado, cfg, (arena.esquerda + arena.direita) / 2, arena.topo + cfg.raio + cfg.entrada.margem);
  b.nasc = corpo.nasc;
  b.fase = 0;
  b.passo = 0;
  mudarEstado(b, E.ENTRADA, cfg.entrada.duracao);
  corpo.velocidade = 0;
  espelhar(b, corpo);
  emitir(estado, 'banca-entrada', null);
  return corpo;
}

// O corpo da Banca na pool, ou null se ele nao esta mais la (morreu).
export function acharBanca(estado) {
  const b = estado.run.avaliacao.banca;
  if (!b || b.nasc === 0) return null;
  const inimigos = poolInimigos(estado).ativos;
  for (let i = 0; i < inimigos.length; i += 1) {
    if (inimigos[i].nasc === b.nasc) return inimigos[i];
  }
  return null;
}

// --------------------------------------------------------------- por tick

// Chamado por main.js DEPOIS de atualizarInimigos (o corpo ja andou como
// inimigo neste tick) e ANTES das armas.
export function atualizarBanca(estado, dt) {
  const av = estado.run.avaliacao;
  const b = av.banca;
  if (!b || b.estado === E.DERROTADA) return;

  atualizarPerguntas(estado, dt);

  const corpo = acharBanca(estado);
  if (!corpo) return; // morreu nas armas do tick anterior: bancaVencida decide

  // Grampeada na arena: a investida perto da parede a levaria para fora, e
  // o descarte de enemies.js devolveria a pool uma Banca viva — a luta nunca
  // mais acabaria. `bateu` encerra a investida na parede.
  const antesX = corpo.x;
  const antesY = corpo.y;
  limitarNaArena(corpo, av.arena);
  const bateu = corpo.x !== antesX || corpo.y !== antesY;

  const cfg = CONTEUDO.banca;
  if (b.estado !== E.TRANSICAO && b.fase < cfg.fases.length - 1 && corpo.hp <= limiarDaFase(b, corpo)) {
    iniciarTransicao(estado, b, corpo);
  }

  b.relogio -= dt;
  switch (b.estado) {
    case E.ENTRADA:
      corpo.velocidade = 0;
      if (b.relogio <= 0) perseguir(estado, b, corpo);
      break;
    case E.PERSEGUINDO:
      corpo.velocidade = velocidadeDePerseguicao(av, b);
      if (b.relogio <= 0) iniciarPadrao(estado, b, corpo);
      break;
    case E.TELEGRAFO:
      corpo.velocidade = 0;
      if (b.relogio <= 0) executarPadrao(estado, b, corpo);
      break;
    case E.EXECUTANDO:
      if (continuarPadrao(estado, b, corpo, bateu)) recuperar(b, corpo);
      break;
    case E.RECUPERANDO:
      corpo.velocidade = 0;
      if (b.relogio <= 0) perseguir(estado, b, corpo);
      break;
    case E.TRANSICAO:
      corpo.velocidade = 0;
      protegerLimiar(b, corpo);
      if (b.relogio <= 0) {
        b.fase += 1;
        b.passo = 0;
        emitir(estado, 'banca-fase', { fase: b.fase });
        perseguir(estado, b, corpo);
      }
      break;
    default:
      break;
  }
  espelhar(b, corpo);
}

// Chamado por main.js DEPOIS das armas: atualiza o espelho e diz se a Banca
// caiu neste tick. Tambem e quem impede que a fase seguinte seja pulada: o HP
// nunca fica abaixo do limiar da fase atual enquanto a transicao nao terminou
// (a transicao comeca no tick seguinte, em atualizarBanca). Um tick so de
// armas nao tira metade do HP dela, entao o golpe que mataria direto da fase 1
// nao existe com os numeros de content.js.
export function bancaVencida(estado) {
  const b = estado.run.avaliacao.banca;
  if (!b) return false;
  if (b.estado === E.DERROTADA) return true;
  const corpo = acharBanca(estado);
  if (corpo) {
    protegerLimiar(b, corpo);
    espelhar(b, corpo);
    return false;
  }
  // Morte simultanea e jubilado (main.js): o jogador ja caiu neste tick, entao
  // a Banca nao e marcada derrotada nem emite 'banca-derrotada' — senao a fila
  // levaria vitoria e jubilacao juntas e o boletim contaria uma Banca vencida.
  // O espelho fica com o ultimo HP visto, que e o que a tela de jubilado mostra.
  if (!estado.player.vivo) return false;
  b.estado = E.DERROTADA;
  b.padrao = '';
  b.relogio = 0;
  b.hp = 0;
  emitir(estado, 'banca-derrotada', { fase: b.fase });
  return true;
}

// -------------------------------------------------------------- transicoes

function mudarEstado(b, estado, duracao) {
  b.estado = estado;
  b.relogio = duracao;
  b.duracaoEstado = duracao;
}

function limiarDaFase(b, corpo) {
  return CONTEUDO.banca.fases[b.fase].ate * corpo.hpMax;
}

function protegerLimiar(b, corpo) {
  if (b.fase >= CONTEUDO.banca.fases.length - 1) return;
  const limiar = limiarDaFase(b, corpo);
  if (corpo.hp < limiar) corpo.hp = limiar;
}

function espelhar(b, corpo) {
  b.hp = corpo.hp;
  b.hpMax = corpo.hpMax;
  b.x = corpo.x;
  b.y = corpo.y;
}

function velocidadeDePerseguicao(av, b) {
  const cfg = CONTEUDO.banca;
  return cfg.velocidade * cfg.fases[b.fase].velocidadeFator * av.regras.velocidadeInimigo;
}

function perseguir(estado, b, corpo) {
  restaurarCorpo(corpo);
  b.padrao = '';
  b.quantosPontos = 0;
  mudarEstado(b, E.PERSEGUINDO, CONTEUDO.banca.fases[b.fase].intervalo);
  corpo.velocidade = velocidadeDePerseguicao(estado.run.avaliacao, b);
}

// O que os padroes mudam no corpo volta ao do tipo.
function restaurarCorpo(corpo) {
  const cfg = CONTEUDO.banca;
  corpo.comportamento = cfg.comportamento;
  corpo.dano = cfg.dano;
  corpo.rumoX = 0;
  corpo.rumoY = 0;
}

function iniciarTransicao(estado, b, corpo) {
  const padrao = PADROES[b.padrao];
  if (padrao && padrao.encerrar && b.estado === E.EXECUTANDO) padrao.encerrar(b, corpo);
  restaurarCorpo(corpo);
  b.padrao = '';
  b.salvas = 0;
  b.quantosPontos = 0;
  corpo.velocidade = 0;
  protegerLimiar(b, corpo);
  mudarEstado(b, E.TRANSICAO, CONTEUDO.banca.transicao.duracao);
  emitir(estado, 'banca-transicao', { fase: b.fase + 1 });
}

function paramsDoPadrao(b) {
  return CONTEUDO.banca.fases[b.fase].padroes[b.padrao];
}

function iniciarPadrao(estado, b, corpo) {
  const fase = CONTEUDO.banca.fases[b.fase];
  const nome = fase.sequencia[b.passo % fase.sequencia.length];
  b.passo += 1;
  b.padrao = nome;
  const params = fase.padroes[nome];
  corpo.velocidade = 0;
  mudarEstado(b, E.TELEGRAFO, params.telegrafo);
  PADROES[nome].preparar(estado, b, corpo, params);
  emitir(estado, 'banca-telegrafo', { padrao: nome, fase: b.fase });
}

function executarPadrao(estado, b, corpo) {
  const params = paramsDoPadrao(b);
  mudarEstado(b, E.EXECUTANDO, 0);
  PADROES[b.padrao].executar(estado, b, corpo, params);
  emitir(estado, 'banca-padrao', { padrao: b.padrao, fase: b.fase });
}

function continuarPadrao(estado, b, corpo, bateu) {
  const padrao = PADROES[b.padrao];
  if (!padrao || !padrao.continuar) return true;
  return padrao.continuar(estado, b, corpo, paramsDoPadrao(b), bateu);
}

function recuperar(b, corpo) {
  const padrao = PADROES[b.padrao];
  const params = paramsDoPadrao(b);
  if (padrao && padrao.encerrar) padrao.encerrar(b, corpo);
  restaurarCorpo(corpo);
  corpo.velocidade = 0;
  b.quantosPontos = 0;
  mudarEstado(b, E.RECUPERANDO, params ? params.recuperacao : 0);
}

// ---------------------------------------------------------------- padroes

function mirarNoJogador(estado, corpo) {
  const p = estado.player;
  const dx = p.x - corpo.x;
  const dy = p.y - corpo.y;
  return dx === 0 && dy === 0 ? 0 : Math.atan2(dy, dx);
}

// ❓ Leque de perguntas: mira no jogador no INICIO do aviso e atira nas
// mesmas linhas que o aviso mostrou — quem saiu da linha durante o aviso nao
// e seguido.
function prepararLeque(estado, b, corpo, params) {
  b.mira = mirarNoJogador(estado, corpo);
  b.salvas = params.salvas;
}

function executarLeque(estado, b, corpo, params) {
  atirarLeque(estado, b, corpo, params);
  b.relogio = params.intervaloSalvas;
}

function continuarLeque(estado, b, corpo, params) {
  if (b.salvas <= 0) return true;
  if (b.relogio <= 0) {
    atirarLeque(estado, b, corpo, params);
    b.relogio += params.intervaloSalvas;
  }
  return b.salvas <= 0;
}

// O angulo da pergunta `i` de `n` no leque: do primeiro ao ultimo cobre
// `abertura`, centrado na mira. render.js usa a mesma conta para o aviso.
export function anguloDoLeque(mira, i, n, abertura) {
  if (n <= 1) return mira;
  return mira - abertura / 2 + (abertura * i) / (n - 1);
}

function atirarLeque(estado, b, corpo, params) {
  const pool = poolPerguntas(estado);
  const cfg = CONTEUDO.banca.pergunta;
  for (let i = 0; i < params.projeteis; i += 1) {
    const angulo = anguloDoLeque(b.mira, i, params.projeteis, params.abertura);
    const dx = Math.cos(angulo);
    const dy = Math.sin(angulo);
    const q = pool.obter();
    q.x = corpo.x + dx * corpo.raio;
    q.y = corpo.y + dy * corpo.raio;
    q.vx = dx * params.velocidade;
    q.vy = dy * params.velocidade;
    q.raio = cfg.raio;
    q.dano = params.dano;
    q.vida = cfg.vidaMaxima;
  }
  b.salvas -= 1;
}

// Investida: para, mostra a faixa (da Banca ate onde ela vai parar), e corre
// em linha reta pelo comportamento de movimento 'rumo' — o mesmo
// moverInimigos de todo inimigo, so que sem perseguir. O comprimento sai
// cortado na parede ja no aviso, entao a faixa mostrada e exatamente o
// caminho.
function prepararInvestida(estado, b, corpo, params) {
  b.mira = mirarNoJogador(estado, corpo);
  b.alcance = alcanceAteAParede(corpo, Math.cos(b.mira), Math.sin(b.mira), params.distancia, estado.run.avaliacao.arena);
}

function executarInvestida(estado, b, corpo, params) {
  corpo.comportamento = MOVIMENTO_INVESTIDA;
  corpo.rumoX = Math.cos(b.mira);
  corpo.rumoY = Math.sin(b.mira);
  corpo.velocidade = params.velocidade * estado.run.avaliacao.regras.velocidadeInimigo;
  corpo.dano = params.dano;
  b.relogio = corpo.velocidade > 0 ? b.alcance / corpo.velocidade : 0;
}

function continuarInvestida(estado, b, corpo, params, bateu) {
  return bateu || b.relogio <= 0;
}

function encerrarInvestida(b, corpo) {
  corpo.velocidade = 0;
}

function alcanceAteAParede(corpo, dx, dy, maximo, arena) {
  const r = corpo.raio;
  let t = maximo;
  if (dx > 0) t = Math.min(t, (arena.direita - r - corpo.x) / dx);
  else if (dx < 0) t = Math.min(t, (arena.esquerda + r - corpo.x) / dx);
  if (dy > 0) t = Math.min(t, (arena.base - r - corpo.y) / dy);
  else if (dy < 0) t = Math.min(t, (arena.topo + r - corpo.y) / dy);
  return Math.max(0, t);
}

// Horda: circulos no chao em volta da Banca, e os inimigos nascem ali no fim
// do aviso (o tipo e o de content.js: 📕 na fase 1, 📱 na fase 2). Pelo
// spawnInimigo de sempre — o teto spawn.maxSimultaneos vale, e o que sobrar
// do teto simplesmente nao nasce.
function prepararHorda(estado, b, corpo, params) {
  const arena = estado.run.avaliacao.arena;
  const tipo = CONTEUDO.inimigos.find((t) => t.id === params.tipo);
  const margem = tipo ? tipo.raio : 0;
  const n = Math.min(params.quantidade, b.pontos.length);
  const base = estado.rng.float() * Math.PI * 2;
  for (let i = 0; i < n; i += 1) {
    const angulo = base + (Math.PI * 2 * i) / n;
    const ponto = b.pontos[i];
    ponto.x = Math.min(arena.direita - margem, Math.max(arena.esquerda + margem, corpo.x + Math.cos(angulo) * params.raio));
    ponto.y = Math.min(arena.base - margem, Math.max(arena.topo + margem, corpo.y + Math.sin(angulo) * params.raio));
  }
  b.quantosPontos = n;
}

function executarHorda(estado, b, corpo, params) {
  for (let i = 0; i < b.quantosPontos; i += 1) {
    const inimigo = spawnInimigo(estado, params.tipo);
    if (!inimigo) break;
    inimigo.x = b.pontos[i].x;
    inimigo.y = b.pontos[i].y;
  }
}

// ---------------------------------------------------------------- perguntas

export function poolPerguntas(estado) {
  return obterPool(estado, 'perguntas', fabricarPergunta).sincronizar();
}

function fabricarPergunta() {
  return { ativo: false, slot: -1, nasc: 0, x: 0, y: 0, vx: 0, vy: 0, raio: 1, dano: 0, vida: 0 };
}

// Voam em linha reta; a que encosta no jogador o machuca (pelos i-frames de
// sempre, receberDano) e some, acertando ou nao. A fonte do 'jogador-dano' e
// banca.pergunta.id — o relatorio a nomeia (pendencia 49).
function atualizarPerguntas(estado, dt) {
  const pool = poolPerguntas(estado);
  const lista = pool.ativos;
  if (lista.length === 0) return;
  const cfg = CONTEUDO.banca.pergunta;
  const arena = estado.run.avaliacao.arena;
  const margem = cfg.margemDescarte;
  const player = estado.player;

  // De tras para frente: liberar() e swap-remove.
  for (let i = lista.length - 1; i >= 0; i -= 1) {
    const q = lista[i];
    q.x += q.vx * dt;
    q.y += q.vy * dt;
    q.vida -= dt;
    if (
      q.vida <= 0 ||
      q.x < arena.esquerda - margem ||
      q.x > arena.direita + margem ||
      q.y < arena.topo - margem ||
      q.y > arena.base + margem
    ) {
      pool.liberar(q);
      continue;
    }
    if (!player.vivo) continue;
    const dx = player.x - q.x;
    const dy = player.y - q.y;
    const soma = q.raio + player.raio;
    if (dx * dx + dy * dy > soma * soma) continue;
    const hpAntes = player.hp;
    if (receberDano(estado, q.dano)) {
      emitir(estado, 'jogador-dano', { fonte: cfg.id, dano: hpAntes - player.hp, hp: player.hp, x: q.x, y: q.y });
    }
    pool.liberar(q);
  }
}

// ------------------------------------------------------------------ smoke

// Todo nome de padrao em content.js precisa existir em PADROES, e o
// comportamento da Banca e o da investida precisam existir em enemies.js.
// Mesmo papel de verificarArmasDoConteudo/verificarInimigosDoConteudo: um
// typo em content.js quebraria a luta no primeiro padrao, com stack cru.
export function verificarBancaDoConteudo(cfg = CONTEUDO.banca) {
  if (!existeMovimento(cfg.comportamento)) {
    return `banca.comportamento "${cfg.comportamento}" nao registrado em enemies.js`;
  }
  if (!existeMovimento(MOVIMENTO_INVESTIDA)) {
    return `o movimento "${MOVIMENTO_INVESTIDA}" da investida nao esta registrado em enemies.js`;
  }
  for (let f = 0; f < cfg.fases.length; f += 1) {
    const fase = cfg.fases[f];
    for (const nome of Object.keys(fase.padroes)) {
      if (!PADROES[nome]) return `banca.fases[${f}].padroes.${nome}: padrao nao registrado em boss.js (${NOMES_PADROES.join(', ')})`;
    }
    for (const nome of fase.sequencia) {
      if (!PADROES[nome]) return `banca.fases[${f}].sequencia: "${nome}" nao registrado em boss.js`;
    }
  }
  return null;
}
