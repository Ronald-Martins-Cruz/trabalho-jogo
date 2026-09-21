import { CONTEUDO } from '../data/content.js';
import { obterPool } from './pool.js';

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

// Toda fonte de dano passa por aqui — inimigo encostando (fase 02), e depois
// modificador e chefe. Ninguem mexe em hp/invulneravel direto. Respeita os
// i-frames sozinho e devolve se o dano realmente foi aplicado.
//
// A morte NAO emite evento nem troca de tela daqui: quem observa `vivo` e o
// atualizarAvaliacao() de main.js, no mesmo quadro. Assim qualquer fonte de
// dano futura ganha o jubilamento de graca, sem player.js precisar importar
// state.js (o que fecharia um ciclo com a importacao de criarRastro).
export function receberDano(estado, dano) {
  const player = estado.player;
  if (!player.vivo || player.invulneravel > 0 || !(dano > 0)) return false;

  const aplicado = Math.min(player.hp, dano);
  player.hp -= aplicado;
  estado.run.avaliacao.danoTomado += aplicado;

  if (player.hp <= 0) {
    player.vivo = false;
    // Morto nao tem i-frames: atualizarPlayer() retorna cedo quando `vivo` e
    // falso, entao o contador ficaria congelado no valor cheio para sempre —
    // e o render deixaria o jogador piscando eternamente.
    player.invulneravel = 0;
    player.vx = 0;
    player.vy = 0;
  } else {
    player.invulneravel = CONTEUDO.jogador.iframesDuracao;
  }
  return true;
}

// Um orbe/item so e atraido quando esta dentro deste raio. A coleta em si
// acontece ao encostar (raio do jogador + raio do orbe), nao aqui.
export function dentroDoRaioDeColeta(player, x, y) {
  const raio = CONTEUDO.jogador.raioColeta;
  const dx = player.x - x;
  const dy = player.y - y;
  return dx * dx + dy * dy <= raio * raio;
}

// Cura: unica porta de subida de HP, como receberDano() e a unica de descida.
// A carta de consolo (cards.js) chama isto; fase 07 vai querer o mesmo para
// coringa e item de loja. Devolve quanto foi realmente curado.
export function curar(estado, quantidade) {
  const player = estado.player;
  if (!player.vivo || !(quantidade > 0)) return 0;
  const curado = Math.min(quantidade, player.hpMax - player.hp);
  player.hp += curado;
  return curado;
}

// Curva de XP. Tabela, nao formula (CONTEUDO.xp.porNivel): `nivel` e o nivel
// ATUAL e o retorno e quanto falta para o proximo. Fora da tabela o ultimo
// limiar repete, entao a funcao nunca devolve undefined nem 0 — um 0 aqui
// deixaria o laco de subir de nivel girando para sempre.
export function xpParaSubir(nivel) {
  const tabela = CONTEUDO.xp.porNivel;
  const i = Math.min(Math.max(Math.floor(nivel), 1), tabela.length) - 1;
  return tabela[i];
}

// ------------------------------------------------------------ orbes de xp

export function poolOrbes(estado) {
  return obterPool(estado, 'xpOrbs', fabricarOrbe).sincronizar();
}

function fabricarOrbe() {
  return { ativo: false, slot: -1, nasc: 0, x: 0, y: 0, vx: 0, vy: 0, valor: 0 };
}

// Chamado por enemies.js no instante da morte, com o `xp` do tipo de inimigo.
// O orbe nasce com um empurraozinho em direcao sorteada (todo sorteio passa
// pelo rng com semente) so para dois inimigos mortos juntos nao virarem um
// orbe so na tela.
export function soltarOrbeXp(estado, x, y, valor) {
  if (!(valor > 0)) return null;
  const cfg = CONTEUDO.xpOrbe;
  const orbe = poolOrbes(estado).obter();
  const angulo = estado.rng.float() * Math.PI * 2;
  // Grampeado na arena: inimigo morto do lado de fora (eles nascem fora da
  // borda) deixaria um orbe inalcancavel, e XP que nao da para pegar e pior
  // do que XP que nao existe.
  const margem = cfg.raio;
  orbe.x = Math.min(Math.max(x, margem), CONTEUDO.arena.largura - margem);
  orbe.y = Math.min(Math.max(y, margem), CONTEUDO.arena.altura - margem);
  orbe.vx = Math.cos(angulo) * cfg.impulso;
  orbe.vy = Math.sin(angulo) * cfg.impulso;
  orbe.valor = valor;
  return orbe;
}

// Orbes nao expiram: quem morreu longe fica esperando o jogador passar. O teto
// da pool (arena.limites.xpOrbs) e a unica rede — cheia, ela recicla o mais
// antigo, que e exatamente o orbe mais velho esquecido num canto.
export function atualizarOrbes(estado, dt) {
  const pool = poolOrbes(estado);
  const orbes = pool.ativos;
  if (orbes.length === 0) return;

  const player = estado.player;
  const cfg = CONTEUDO.xpOrbe;
  const raioIma = CONTEUDO.jogador.raioColeta;
  const alcanceColeta = player.raio + cfg.raio;
  const freio = Math.max(0, 1 - cfg.atrito * dt);

  // De tras para frente: liberar() e swap-remove.
  for (let i = orbes.length - 1; i >= 0; i -= 1) {
    const orbe = orbes[i];
    const dx = player.x - orbe.x;
    const dy = player.y - orbe.y;
    const distancia = Math.hypot(dx, dy);

    if (player.vivo && distancia <= raioIma) {
      // A aceleracao cresce conforme o orbe se aproxima: longe ele apenas
      // cede, perto ele gruda. E essa rampa, e nao a velocidade maxima, que
      // da a sensacao de aspirador.
      const proximidade = distancia > 0 ? 1 - distancia / raioIma : 1;
      const aceleracao =
        cfg.aceleracaoMinima + (cfg.aceleracaoMaxima - cfg.aceleracaoMinima) * proximidade;
      const inverso = distancia > 0 ? 1 / distancia : 0;
      orbe.vx += dx * inverso * aceleracao * dt;
      orbe.vy += dy * inverso * aceleracao * dt;
    } else {
      orbe.vx *= freio;
      orbe.vy *= freio;
    }

    const velocidade = Math.hypot(orbe.vx, orbe.vy);
    if (velocidade > cfg.velocidadeMaxima) {
      const fator = cfg.velocidadeMaxima / velocidade;
      orbe.vx *= fator;
      orbe.vy *= fator;
    }

    orbe.x += orbe.vx * dt;
    orbe.y += orbe.vy * dt;

    if (!player.vivo) continue;
    const fdx = player.x - orbe.x;
    const fdy = player.y - orbe.y;
    if (fdx * fdx + fdy * fdy <= alcanceColeta * alcanceColeta) {
      // So soma XP. Quem converte XP em nivel (e em carta) e cards.js, que
      // pode emitir evento — player.js nao importa state.js porque state.js
      // ja importa criarRastro daqui.
      player.xp += orbe.valor;
      pool.liberar(orbe);
    }
  }
}
