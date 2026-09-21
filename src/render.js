import { CONTEUDO } from '../data/content.js';
import { TELAS } from './state.js';

// Le o estado e desenha. Nunca escreve no estado — se uma funcao daqui
// precisar mudar alguma coisa, ela esta no arquivo errado.

export function desenhar(estado, ctx) {
  const { largura, altura } = CONTEUDO.arena;
  const v = CONTEUDO.visual;

  ctx.fillStyle = v.corFundo;
  ctx.fillRect(0, 0, largura, altura);
  desenharGrade(ctx, largura, altura, v);

  // A carta congela a partida, entao a arena continua desenhada por baixo
  // dela — igual a pausa, so que mais escura.
  if (
    estado.tela === TELAS.AVALIACAO ||
    estado.tela === TELAS.PAUSA ||
    estado.tela === TELAS.CARTA
  ) {
    desenharArena(ctx, largura, altura, v);
    desenharOrbes(ctx, estado.xpOrbs, v);
    desenharInimigos(ctx, estado.enemies, v);
    desenharProjeteis(ctx, estado.projectiles, v);
    desenharJogador(ctx, estado.player, v);
  }

  if (estado.tela === TELAS.PAUSA) {
    ctx.fillStyle = v.corSombraPausa;
    ctx.fillRect(0, 0, largura, altura);
  } else if (estado.tela === TELAS.CARTA) {
    ctx.fillStyle = v.corSombraCarta;
    ctx.fillRect(0, 0, largura, altura);
  }
}

function desenharGrade(ctx, largura, altura, v) {
  ctx.strokeStyle = v.corGrade;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= largura; x += v.gradePasso) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, altura);
  }
  for (let y = 0; y <= altura; y += v.gradePasso) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(largura, y + 0.5);
  }
  ctx.stroke();
}

function desenharArena(ctx, largura, altura, v) {
  ctx.strokeStyle = v.corBorda;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, largura - 2, altura - 2);
}

// estado.enemies guarda so os inimigos ativos da pool — o que nao esta em uso
// nao aparece aqui, entao nao precisa de teste de `ativo` no desenho.
function desenharInimigos(ctx, inimigos, v) {
  for (let i = 0; i < inimigos.length; i += 1) {
    const e = inimigos[i];
    desenharEmoji(ctx, e.emoji, e.x, e.y, e.raio * v.emojiInimigoFator, v);
  }
}

// Desenhados depois dos inimigos e antes do jogador: o projetil precisa
// aparecer por cima de quem ele vai acertar para a leitura funcionar no meio
// do bando.
function desenharProjeteis(ctx, projeteis, v) {
  for (let i = 0; i < projeteis.length; i += 1) {
    const p = projeteis[i];
    desenharEmoji(ctx, p.emoji, p.x, p.y, p.raio * v.emojiProjetilFator, v);
  }
}

// Por baixo de todo mundo: orbe nenhum pode esconder um inimigo que vem
// chegando.
function desenharOrbes(ctx, orbes, v) {
  // Todo orbe tem o mesmo raio (CONTEUDO.xpOrbe.raio), so o valor muda — o
  // tamanho sai da conta uma vez, fora do laco.
  const tamanho = CONTEUDO.xpOrbe.raio * v.emojiOrbeFator;
  for (let i = 0; i < orbes.length; i += 1) {
    desenharEmoji(ctx, CONTEUDO.xpOrbe.emoji, orbes[i].x, orbes[i].y, tamanho, v);
  }
}

function desenharJogador(ctx, player, v) {
  desenharRastro(ctx, player, v);

  // Pisca-pisca durante os i-frames: alterna com base no proprio contador de
  // invulnerabilidade (que so anda durante a avaliacao), nunca em estado.tempo.
  const piscando =
    player.invulneravel > 0 && Math.floor(player.invulneravel / v.piscaIntervalo) % 2 === 1;
  if (piscando) return;

  desenharEmoji(ctx, CONTEUDO.jogador.emoji, player.x, player.y, v.tamanhoEmojiJogador, v);
}

// Rastro simples: pontos anteriores do buffer circular, mais opacos quanto
// mais recentes. r.indice aponta pro slot mais antigo (proximo a ser
// sobrescrito), entao percorrer a partir dele da a ordem antigo -> novo.
function desenharRastro(ctx, player, v) {
  const r = player.rastro;
  const n = r.pontos.length;
  const raioPonto = CONTEUDO.jogador.raio * v.rastroRaioFator;

  ctx.fillStyle = v.corRastro;
  for (let i = 0; i < n; i += 1) {
    const ponto = r.pontos[(r.indice + i) % n];
    if (!ponto.ativo) continue;
    ctx.globalAlpha = ((i + 1) / n) * v.rastroAlphaMax;
    ctx.beginPath();
    ctx.arc(ponto.x, ponto.y, raioPonto, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export function desenharEmoji(ctx, emoji, x, y, tamanho, v = CONTEUDO.visual) {
  ctx.font = `${tamanho}px ${v.fonteEmoji}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, x, y);
}
