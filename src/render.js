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

  if (estado.tela === TELAS.AVALIACAO || estado.tela === TELAS.PAUSA) {
    desenharArena(ctx, largura, altura, v);
    desenharJogador(ctx, estado.player, v);
  }

  if (estado.tela === TELAS.PAUSA) {
    ctx.fillStyle = v.corSombraPausa;
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

function desenharJogador(ctx, player, v) {
  desenharEmoji(ctx, CONTEUDO.jogador.emoji, player.x, player.y, v.tamanhoEmojiJogador, v);
}

export function desenharEmoji(ctx, emoji, x, y, tamanho, v = CONTEUDO.visual) {
  ctx.font = `${tamanho}px ${v.fonteEmoji}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, x, y);
}
