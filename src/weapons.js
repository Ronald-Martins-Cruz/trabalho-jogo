import { CONTEUDO } from '../data/content.js';
import { emitir } from './state.js';
import { obterPool } from './pool.js';
import { aplicarDano, poolInimigos } from './enemies.js';

// Armas e projeteis. A regra desta fase: **arma e dado, nao classe**. Cada
// entrada de CONTEUDO.armas aponta um `comportamento` para uma das funcoes
// registradas em COMPORTAMENTOS aqui embaixo, e leva TODOS os seus numeros num
// array `niveis`. Nenhuma arma especifica esta codificada neste arquivo — a
// fase 05 acrescenta Caneta Bic, Resumo e Marca-texto so escrevendo em
// content.js (se o comportamento ja existir) ou registrando uma funcao nova.
//
// O cooldown mora na instancia, dentro do estado (`estado.player.armas`), e
// nunca numa variavel de modulo: iniciarAvaliacao() troca o player inteiro, e
// um cooldown de modulo sobreviveria a troca e ficaria mentindo.

// Registro de comportamentos. Assinatura de todos:
//   (estado, arma, dados, nivel) -> boolean   true = disparou, consome cadencia
// `arma` e a instancia no estado, `dados` e a entrada de content.js e `nivel` e
// o objeto de numeros do nivel atual.
// A fase 05 acrescenta aqui: orbital, ondaArea, feixe.
const COMPORTAMENTOS = {
  projetilMirado,
};

// ------------------------------------------------------------------ armas

export function atualizarArmas(estado, dt) {
  garantirArmaInicial(estado);

  const player = estado.player;
  if (player.vivo) {
    for (let i = 0; i < player.armas.length; i += 1) {
      atualizarArma(estado, player.armas[i], dt);
    }
  }
  atualizarProjeteis(estado, dt);
}

function atualizarArma(estado, arma, dt) {
  const dados = dadosDaArma(arma.id);
  if (!dados) return;
  const nivel = nivelDaArma(arma);
  if (!nivel) return;

  arma.cooldown -= dt;
  if (arma.cooldown > 0) return;

  const comportamento = COMPORTAMENTOS[dados.comportamento];
  if (!comportamento) {
    throw new Error(
      `arma "${dados.id}": comportamento "${dados.comportamento}" nao existe em weapons.js ` +
        `(registrados: ${Object.keys(COMPORTAMENTOS).join(', ')})`
    );
  }

  if (comportamento(estado, arma, dados, nivel)) {
    // Soma em vez de atribuir: preserva a fracao de segundo que passou do
    // cooldown e mantem a cadencia estavel mesmo com dt fixo.
    arma.cooldown += nivel.cadencia;
  } else {
    // Sem alvo: nao acumula divida de cooldown, senao a arma dispararia uma
    // rajada no instante em que o primeiro inimigo aparecesse.
    arma.cooldown = 0;
  }
}

// O jogador comeca toda avaliacao com a arma inicial. Fica aqui, e nao em
// iniciarAvaliacao(), porque state.js importar weapons.js fecharia um ciclo
// (weapons.js -> state.js, por causa de emitir). A fase 08, dona da run, deve
// mover isto para a montagem da avaliacao junto com os coringas.
function garantirArmaInicial(estado) {
  if (estado.player.armas.length > 0) return;
  equiparArma(estado, CONTEUDO.arma.inicial);
}

export function equiparArma(estado, id) {
  const dados = dadosDaArma(id);
  if (!dados) return null;
  const existente = acharInstancia(estado, id);
  if (existente) return existente;
  const arma = { id: dados.id, nivel: 1, cooldown: 0 };
  estado.player.armas.push(arma);
  emitir(estado, 'arma-equipada', { arma: dados.id, nivel: 1 });
  return arma;
}

// Fase 04 (carta de nivel) chama isto. Devolve false quando a arma ja esta no
// nivel maximo — quem oferece a carta usa isso para nao oferecer o que nao sobe.
export function subirNivelArma(estado, id) {
  const arma = acharInstancia(estado, id);
  if (!arma) return false;
  const dados = dadosDaArma(id);
  if (!dados || arma.nivel >= dados.niveis.length) return false;
  arma.nivel += 1;
  emitir(estado, 'arma-nivel', { arma: id, nivel: arma.nivel });
  return true;
}

export function dadosDaArma(id) {
  const armas = CONTEUDO.armas;
  for (let i = 0; i < armas.length; i += 1) if (armas[i].id === id) return armas[i];
  return null;
}

// Os numeros do nivel atual de uma instancia. Grampeado nas duas pontas para
// que um nivel fora da faixa nunca vire `undefined` dentro do update.
export function nivelDaArma(arma) {
  const dados = dadosDaArma(arma.id);
  if (!dados || dados.niveis.length === 0) return null;
  const i = Math.min(Math.max(arma.nivel, 1), dados.niveis.length) - 1;
  return dados.niveis[i];
}

function acharInstancia(estado, id) {
  const armas = estado.player.armas;
  for (let i = 0; i < armas.length; i += 1) if (armas[i].id === id) return armas[i];
  return null;
}

// Para o smoke: toda arma de content.js precisa apontar para um comportamento
// que exista aqui. Sem isto, uma arma nova da fase 05 so quebraria no instante
// do primeiro disparo, dentro do update.
export function verificarArmasDoConteudo() {
  for (const arma of CONTEUDO.armas) {
    if (!COMPORTAMENTOS[arma.comportamento]) {
      return `arma "${arma.id}": comportamento "${arma.comportamento}" nao registrado em weapons.js ` +
        `(registrados: ${Object.keys(COMPORTAMENTOS).join(', ')})`;
    }
  }
  if (!dadosDaArma(CONTEUDO.arma.inicial)) {
    return `arma.inicial "${CONTEUDO.arma.inicial}" nao existe em CONTEUDO.armas`;
  }
  return null;
}

// --------------------------------------------------------- comportamentos

// ☕ Café e qualquer arma que atire no inimigo mais proximo. O projetil sai
// reto, na direcao em que o alvo estava no instante do disparo: nao e
// teleguiado de proposito — errar quem desviou e a contrapartida da cadencia
// alta. Com projeteis > 1 o disparo vira um leque de `dispersao` radianos.
function projetilMirado(estado, arma, dados, nivel) {
  const player = estado.player;
  const alvo = inimigoMaisProximo(estado, player.x, player.y, nivel.alcance);
  if (!alvo) return false;

  const angulo = Math.atan2(alvo.y - player.y, alvo.x - player.x);
  const quantidade = Math.max(1, nivel.projeteis);
  const passo = quantidade > 1 ? nivel.dispersao / (quantidade - 1) : 0;
  const inicio = quantidade > 1 ? angulo - nivel.dispersao / 2 : angulo;

  for (let i = 0; i < quantidade; i += 1) {
    const a = inicio + passo * i;
    dispararProjetil(estado, dados, nivel, player.x, player.y, Math.cos(a), Math.sin(a));
  }
  emitir(estado, 'arma-disparo', { arma: dados.id, x: player.x, y: player.y, angulo });
  return true;
}

// Varredura linear sobre os inimigos ativos. So roda quando uma arma dispara
// (~2,5x por segundo no Café nivel 1), nao por quadro — medido no handoff da
// fase 03: com 400 inimigos a corrida de carga nao se mexeu. Se a fase 05
// colocar quatro armas de cadencia alta, meca de novo antes de trocar isto por
// uma grade.
function inimigoMaisProximo(estado, x, y, alcance) {
  const inimigos = poolInimigos(estado).ativos;
  let melhor = null;
  let melhorDist = alcance * alcance;
  for (let i = 0; i < inimigos.length; i += 1) {
    const e = inimigos[i];
    const dx = e.x - x;
    const dy = e.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= melhorDist) {
      melhorDist = d2;
      melhor = e;
    }
  }
  return melhor;
}

// -------------------------------------------------------------- projeteis

export function poolProjeteis(estado) {
  return obterPool(estado, 'projectiles', fabricarProjetil).sincronizar();
}

// Forma unica de projetil, com todos os campos criados aqui e numero finito em
// cada um. `atingidos` e um anel de tamanho fixo alocado na abertura da pool —
// nenhum array nasce dentro do update (restricao 5).
function fabricarProjetil() {
  const atingidos = [];
  for (let i = 0; i < CONTEUDO.projetil.memoriaAtingidos; i += 1) {
    atingidos.push({ ref: null, nasc: -1 });
  }
  return {
    ativo: false,
    slot: -1,
    nasc: 0,
    arma: '',
    emoji: '',
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    dano: 0,
    raio: 1,
    vida: 0,
    perfuracao: 0,
    atingidos,
    memoriaIndice: 0,
  };
}

function dispararProjetil(estado, dados, nivel, x, y, dirX, dirY) {
  const p = poolProjeteis(estado).obter();
  p.arma = dados.id;
  p.emoji = dados.emoji;
  p.x = x;
  p.y = y;
  p.vx = dirX * nivel.velocidade;
  p.vy = dirY * nivel.velocidade;
  p.dano = nivel.dano;
  p.raio = nivel.raio;
  p.perfuracao = nivel.perfuracao;
  // O alcance e distancia, nao tempo: dividir pela velocidade da os segundos
  // de voo. O teto existe para que um alcance enorme nao deixe projetil vivo
  // para sempre girando a conta de colisao.
  p.vida = Math.min(CONTEUDO.projetil.vidaMaxima, nivel.alcance / nivel.velocidade);
  esquecerAtingidos(p);
  return p;
}

function atualizarProjeteis(estado, dt) {
  const pool = poolProjeteis(estado);
  const projeteis = pool.ativos;
  if (projeteis.length === 0) return;

  const { largura, altura } = CONTEUDO.arena;
  const margem = CONTEUDO.projetil.margemDescarte;

  // De tras para frente: liberar() e swap-remove, e nesta ordem o elemento que
  // vem para o buraco ja foi visitado.
  for (let i = projeteis.length - 1; i >= 0; i -= 1) {
    const p = projeteis[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vida -= dt;

    if (
      p.vida <= 0 ||
      p.x < -margem ||
      p.x > largura + margem ||
      p.y < -margem ||
      p.y > altura + margem
    ) {
      pool.liberar(p);
      continue;
    }

    if (colidirProjetil(estado, p)) pool.liberar(p);
  }
}

// Devolve true quando o projetil se esgotou e precisa voltar a pool.
function colidirProjetil(estado, p) {
  const inimigos = poolInimigos(estado).ativos;
  // De tras para frente porque aplicarDano() pode liberar o inimigo morto, e
  // liberar() troca o ultimo elemento para o buraco.
  for (let i = inimigos.length - 1; i >= 0; i -= 1) {
    const e = inimigos[i];
    const soma = p.raio + e.raio;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    if (dx * dx + dy * dy > soma * soma) continue;
    if (jaAtingiu(p, e)) continue;

    lembrarAtingido(p, e);
    const x = e.x;
    const y = e.y;
    const matou = aplicarDano(estado, e, p.dano);
    emitir(estado, 'arma-acerto', { arma: p.arma, x, y, dano: p.dano, matou });

    if (p.perfuracao <= 0) return true;
    p.perfuracao -= 1;
  }
  return false;
}

// Guarda de geracao. Um inimigo liberado volta para a reserva da pool e pode
// reaparecer como OUTRO inimigo no mesmo objeto; comparar so a referencia faria
// o projetil perfurante confundir o novo inimigo com o que ja atingiu — e o
// novo ficaria imune a ele. `nasc` muda a cada nascimento, entao o par
// (ref, nasc) e a unica identidade que atravessa quadros com seguranca.
function jaAtingiu(p, e) {
  const memoria = p.atingidos;
  for (let i = 0; i < memoria.length; i += 1) {
    if (memoria[i].ref === e && memoria[i].nasc === e.nasc) return true;
  }
  return false;
}

function lembrarAtingido(p, e) {
  const slot = p.atingidos[p.memoriaIndice];
  slot.ref = e;
  slot.nasc = e.nasc;
  p.memoriaIndice = (p.memoriaIndice + 1) % p.atingidos.length;
}

function esquecerAtingidos(p) {
  for (let i = 0; i < p.atingidos.length; i += 1) {
    p.atingidos[i].ref = null;
    p.atingidos[i].nasc = -1;
  }
  p.memoriaIndice = 0;
}
