import { CONTEUDO } from '../data/content.js';

// Movimento, HP e coleta do jogador. Nunca le teclado nem DOM: a entrada ja
// chega pronta em estado.input (eixoX/eixoY), escrita por main.js/ui.js. Isso
// e o que deixa o smoke test (e o bot dele) controlar o jogador sem navegador.
//
// Nunca guarde a referencia de estado.player numa variavel de modulo:
// iniciarAvaliacao() troca o objeto inteiro a cada nova avaliacao. Toda
// funcao aqui recebe `estado` e le `estado.player` na hora.

export function atualizarPlayer(estado, dt) {
  const player = estado.player;
  if (!player.vivo) return;

  moverPlayer(player, estado.input, dt);
  limitarNaArena(player);
  atualizarInvulnerabilidade(player, dt);
  registrarRastro(player);
}

function moverPlayer(player, input, dt) {
  const cfg = CONTEUDO.jogador;
  let dirX = input.eixoX || 0;
  let dirY = input.eixoY || 0;

  // Normaliza a diagonal: sem isso, WASD nas duas teclas ao mesmo tempo anda
  // sqrt(2) mais rapido, que e o bug mais visivel que existe num survivor.
  const magnitude = Math.hypot(dirX, dirY);
  if (magnitude > 0) {
    dirX /= magnitude;
    dirY /= magnitude;
    player.vx += dirX * cfg.aceleracao * dt;
    player.vy += dirY * cfg.aceleracao * dt;
  } else {
    aplicarAtrito(player, cfg.atrito, dt);
  }

  const velocidadeAtual = Math.hypot(player.vx, player.vy);
  if (velocidadeAtual > cfg.velocidade) {
    const fator = cfg.velocidade / velocidadeAtual;
    player.vx *= fator;
    player.vy *= fator;
  }

  player.x += player.vx * dt;
  player.y += player.vy * dt;
}

function aplicarAtrito(player, atrito, dt) {
  const velocidadeAtual = Math.hypot(player.vx, player.vy);
  if (velocidadeAtual === 0) return;
  const reducao = Math.min(velocidadeAtual, atrito * dt);
  const fator = (velocidadeAtual - reducao) / velocidadeAtual;
  player.vx *= fator;
  player.vy *= fator;
}

// A arena e um retangulo com origem em (0,0); o jogador para na borda, nao
// atravessa. Largura/altura vem de content.js porque o modificador "Sala
// Lotada" (fase 08/09) vai encolhe-las durante a run.
function limitarNaArena(player) {
  const { largura, altura } = CONTEUDO.arena;
  const r = player.raio;

  if (player.x < r) {
    player.x = r;
    if (player.vx < 0) player.vx = 0;
  } else if (player.x > largura - r) {
    player.x = largura - r;
    if (player.vx > 0) player.vx = 0;
  }

  if (player.y < r) {
    player.y = r;
    if (player.vy < 0) player.vy = 0;
  } else if (player.y > altura - r) {
    player.y = altura - r;
    if (player.vy > 0) player.vy = 0;
  }
}

// invulneravel conta em segundos de jogo, decrescendo com o dt do proprio
// update da avaliacao — nunca compare contra estado.tempo, que tambem cresce
// durante a pausa e faria os i-frames vazarem enquanto o jogo esta parado.
function atualizarInvulnerabilidade(player, dt) {
  if (player.invulneravel > 0) {
    player.invulneravel = Math.max(0, player.invulneravel - dt);
  }
}

// Buffer circular de tamanho fixo, alocado uma vez em criarRastro() (chamado
// por novoPlayer(), nunca dentro do loop). Cada frame so sobrescreve x/y/ativo
// dos objetos ja existentes — zero `new` por tick, como a restricao 5 exige.
function registrarRastro(player) {
  const r = player.rastro;
  const ponto = r.pontos[r.indice];
  ponto.x = player.x;
  ponto.y = player.y;
  ponto.ativo = true;
  r.indice = (r.indice + 1) % r.pontos.length;
}

export function criarRastro() {
  const tamanho = CONTEUDO.jogador.rastroTamanho;
  const pontos = [];
  for (let i = 0; i < tamanho; i += 1) pontos.push({ x: 0, y: 0, ativo: false });
  return { pontos, indice: 0 };
}

// Contrato para a fase 02 (inimigos) e fases futuras que causam dano: nenhuma
// delas mexe em hp/invulneravel direto, todas chamam isto. Respeita i-frames
// sozinho e devolve se o dano realmente foi aplicado.
export function receberDano(estado, dano) {
  const player = estado.player;
  if (!player.vivo || player.invulneravel > 0) return false;

  player.hp = Math.max(0, player.hp - dano);
  player.invulneravel = CONTEUDO.jogador.iframesDuracao;
  if (player.hp <= 0) player.vivo = false;
  return true;
}

// Contrato para a fase 04 (xp/coleta): um orbe/item so e atraido/coletado
// quando esta dentro deste raio.
export function dentroDoRaioDeColeta(player, x, y) {
  const raio = CONTEUDO.jogador.raioColeta;
  const dx = player.x - x;
  const dy = player.y - y;
  return dx * dx + dy * dy <= raio * raio;
}
