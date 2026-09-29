import { CONTEUDO } from '../data/content.js';
import { obterPool } from './pool.js';
import { aoGanharXp, aoReceberDanoFatal } from './jokers.js';

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

  const av = estado.run.avaliacao;
  moverPlayer(player, estado.input, dt, fatorDeVelocidade(av.regras, av.decorrido));
  limitarNaArena(player, av.arena);
  atualizarInvulnerabilidade(player, dt);
  registrarRastro(player);
}

// A regra velocidadeInicial (Aula das 7h): a velocidade maxima comeca
// multiplicada por ela e volta a x1 em linha reta em recuperacaoVelocidade
// segundos. Sem modificador, 1 do primeiro ao ultimo segundo.
export function fatorDeVelocidade(regras, decorrido) {
  const inicial = regras.velocidadeInicial;
  if (inicial === 1) return 1;
  const duracao = regras.recuperacaoVelocidade;
  if (!(duracao > 0)) return inicial;
  const k = Math.min(1, Math.max(0, decorrido / duracao));
  return inicial + (1 - inicial) * k;
}

function moverPlayer(player, input, dt, fatorVelocidade) {
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

  // player.velocidade, e nao cfg.velocidade: e o atributo ja modificado
  // pelos coringas (jokers.js, modificarAtributo). O fator e o da regra da
  // avaliacao (fatorDeVelocidade).
  const maxima = player.velocidade * fatorVelocidade;
  const velocidadeAtual = Math.hypot(player.vx, player.vy);
  if (velocidadeAtual > maxima) {
    const fator = maxima / velocidadeAtual;
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

// A arena e o retangulo da avaliacao (av.arena, centrado no canvas); o
// jogador para na borda, nao atravessa. Com a regra `arena` < 1 (Sala Lotada)
// ele encolhe em volta do centro.
function limitarNaArena(player, arena) {
  const r = player.raio;

  if (player.x < arena.esquerda + r) {
    player.x = arena.esquerda + r;
    if (player.vx < 0) player.vx = 0;
  } else if (player.x > arena.direita - r) {
    player.x = arena.direita - r;
    if (player.vx > 0) player.vx = 0;
  }

  if (player.y < arena.topo + r) {
    player.y = arena.topo + r;
    if (player.vy < 0) player.vy = 0;
  } else if (player.y > arena.base - r) {
    player.y = arena.base - r;
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

// Toda fonte de dano passa por aqui — inimigo encostando (fase 02), a regra
// perdaHp (fase 08) e depois o chefe. Ninguem mexe em hp/invulneravel direto.
// Respeita os i-frames sozinho e devolve se o dano realmente foi aplicado.
// `semIframes`: dano que nao para nos i-frames e nao os liga (a perda de HP
// por tempo). Quem chamar emite o proprio 'jogador-dano' com a fonte.
//
// A morte NAO emite evento nem troca de tela daqui: quem observa `vivo` e o
// atualizarAvaliacao() de main.js, no mesmo quadro. Assim qualquer fonte de
// dano futura ganha o jubilamento de graca, sem player.js precisar importar
// state.js (o que fecharia um ciclo com a importacao de criarRastro).
export function receberDano(estado, dano, semIframes = false) {
  const player = estado.player;
  if (!player.vivo || !(dano > 0)) return false;
  if (player.invulneravel > 0 && !semIframes) return false;

  let aplicado = Math.min(player.hp, dano);
  // Golpe fatal: um coringa (Atestado) pode segurar o jogador com algum HP.
  // O hook devolve o HP que sobra, ou 0 se ninguem salvou.
  if (aplicado >= player.hp) {
    const hpSalvo = aoReceberDanoFatal(estado, dano);
    if (hpSalvo > 0) aplicado = Math.max(0, player.hp - hpSalvo);
  }
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
  } else if (!semIframes) {
    player.invulneravel = CONTEUDO.jogador.iframesDuracao;
  }
  return true;
}

// Um orbe/item so e atraido quando esta dentro deste raio. A coleta em si
// acontece ao encostar (raio do jogador + raio do orbe), nao aqui.
export function dentroDoRaioDeColeta(player, x, y) {
  const raio = player.raioColeta;
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
  // A arena da avaliacao, e nao o canvas: com a Sala Lotada o orbe no canvas
  // fora da arena tambem seria inalcancavel.
  const margem = cfg.raio;
  const arena = estado.run.avaliacao.arena;
  orbe.x = Math.min(Math.max(x, arena.esquerda + margem), arena.direita - margem);
  orbe.y = Math.min(Math.max(y, arena.topo + margem), arena.base - margem);
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
  const raioIma = player.raioColeta; // atributo modificavel por coringa (Wi-Fi)
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
      player.xp += aoGanharXp(estado, orbe.valor);
      pool.liberar(orbe);
    }
  }
}
