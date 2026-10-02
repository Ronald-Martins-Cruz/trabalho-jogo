import { CONTEUDO } from '../data/content.js';
import { TELAS } from './state.js';
import { dadosDaArma, nivelDaArma, posicaoSatelite } from './weapons.js';
import { anguloDoLeque, ESTADOS_BANCA } from './boss.js';
import { preencher } from './ui.js';

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
    const banca = estado.run.avaliacao.banca;
    desenharArena(ctx, estado.run.avaliacao.arena, largura, altura, v);
    desenharOrbes(ctx, estado.xpOrbs, v);
    // O aviso da Banca e marca no chao: por baixo de todo mundo, menos dos
    // orbes (que ja sao chao tambem).
    if (banca) desenharAvisosDaBanca(ctx, banca, v);
    desenharInimigos(ctx, estado.enemies, v);
    if (banca) desenharBanca(ctx, banca, v);
    desenharProjeteis(ctx, estado.projectiles, v);
    desenharPerguntas(ctx, estado.perguntas, v);
    desenharJogador(ctx, estado.player, v);
    // Depois do jogador: caneta orbital, onda e feixe sao "efeitos da propria
    // arma", nao entidades da pool — fazem mais sentido desenhados por cima,
    // como um halo do jogador.
    desenharArmasEspeciais(ctx, estado.player, v);
    if (banca) desenharTransicaoDaBanca(ctx, banca, largura, altura, v);
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

// A arena da avaliacao (av.arena). Com a Sala Lotada ela e menor que o
// canvas: o lado de fora escurece e a borda marca a parede de verdade — sem
// isso o jogador bateria numa parede invisivel.
function desenharArena(ctx, arena, largura, altura, v) {
  const { esquerda, topo, direita, base } = arena;
  if (esquerda > 0 || topo > 0 || direita < largura || base < altura) {
    ctx.fillStyle = v.corForaArena;
    ctx.fillRect(0, 0, largura, topo);
    ctx.fillRect(0, base, largura, altura - base);
    ctx.fillRect(0, topo, esquerda, base - topo);
    ctx.fillRect(direita, topo, largura - direita, base - topo);
  }
  ctx.strokeStyle = v.corBorda;
  ctx.lineWidth = 2;
  ctx.strokeRect(esquerda + 1, topo + 1, direita - esquerda - 2, base - topo - 2);
}

// estado.enemies guarda so os inimigos ativos da pool — o que nao esta em uso
// nao aparece aqui, entao nao precisa de teste de `ativo` no desenho.
function desenharInimigos(ctx, inimigos, v) {
  for (let i = 0; i < inimigos.length; i += 1) {
    const e = inimigos[i];
    // O chefe tem desenho proprio (desenharBanca), por cima do bando.
    if (e.chefe) continue;
    desenharEmoji(ctx, e.emoji, e.x, e.y, e.raio * v.emojiInimigoFator, v);
  }
}

// ------------------------------------------------------------- A Banca

// Tudo aqui le o espelho em estado.run.avaliacao.banca (boss.js), escrito
// depois das armas a cada tick: e a posicao e o HP do fim do tick.

// A Banca: aura na cor da fase (a "mudanca de cor" da transicao) e o emoji
// maior que o corpo de colisao. Na transicao a aura pisca entre a cor da
// fase que acabou e a da que vem, no relogio da propria transicao — parado
// na pausa, como todo o resto.
function desenharBanca(ctx, b, v) {
  if (b.estado === ESTADOS_BANCA.DERROTADA) return;
  const vb = v.banca;
  let cor = vb.corAura[b.fase];
  if (b.estado === ESTADOS_BANCA.TRANSICAO) {
    const t = b.duracaoEstado - b.relogio;
    if (Math.sin(2 * Math.PI * vb.pulsoTransicao * t) > 0) cor = vb.corAura[b.fase + 1] || cor;
  }
  ctx.fillStyle = cor;
  ctx.beginPath();
  ctx.arc(b.x, b.y, vb.raioAura, 0, Math.PI * 2);
  ctx.fill();
  desenharEmoji(ctx, CONTEUDO.banca.emoji, b.x, b.y, vb.tamanhoEmoji, v);
}

// O aviso de cada padrao (contrato da fase 10, tarefa 4): nasce fraco e
// fica forte ate o golpe sair. O desenho e o que o golpe vai fazer, com os
// mesmos numeros: as linhas do leque sao os angulos das perguntas
// (anguloDoLeque, de boss.js), a faixa da investida e o caminho cortado na
// parede (b.alcance), os circulos da horda sao onde cada inimigo nasce.
const AVISOS = {
  leque: avisoDoLeque,
  investida: avisoDaInvestida,
  horda: avisoDaHorda,
};

function desenharAvisosDaBanca(ctx, b, v) {
  const avisando = b.estado === ESTADOS_BANCA.TELEGRAFO;
  // O leque com mais de uma salva continua mostrando as linhas ate a ultima.
  const salvas = b.estado === ESTADOS_BANCA.EXECUTANDO && b.salvas > 0;
  if (!avisando && !salvas) return;
  const params = CONTEUDO.banca.fases[b.fase].padroes[b.padrao];
  const aviso = AVISOS[b.padrao];
  if (!params || !aviso) return;
  const vb = v.banca;
  const progresso = avisando && b.duracaoEstado > 0 ? Math.min(1, Math.max(0, 1 - b.relogio / b.duracaoEstado)) : 1;
  ctx.save();
  ctx.globalAlpha = vb.alphaTelegrafoMin + (vb.alphaTelegrafoMax - vb.alphaTelegrafoMin) * progresso;
  ctx.strokeStyle = vb.corTelegrafo;
  ctx.fillStyle = vb.corTelegrafo;
  aviso(ctx, b, params, progresso, v, avisando);
  ctx.restore();
}

function avisoDoLeque(ctx, b, params, progresso, v) {
  const vb = v.banca;
  const inicio = CONTEUDO.banca.raio;
  ctx.lineWidth = vb.larguraRaioLeque;
  ctx.beginPath();
  for (let i = 0; i < params.projeteis; i += 1) {
    const a = anguloDoLeque(b.mira, i, params.projeteis, params.abertura);
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    ctx.moveTo(b.x + dx * inicio, b.y + dy * inicio);
    ctx.lineTo(b.x + dx * vb.alcanceRaioLeque, b.y + dy * vb.alcanceRaioLeque);
  }
  ctx.stroke();
}

function avisoDaInvestida(ctx, b, params, progresso, v, avisando) {
  if (!avisando) return;
  const r = CONTEUDO.banca.raio;
  ctx.translate(b.x, b.y);
  ctx.rotate(b.mira);
  ctx.lineWidth = 2;
  ctx.strokeRect(0, -r, b.alcance + r, r * 2);
  // A faixa enche da Banca para a ponta: quando chega la, ela corre.
  ctx.globalAlpha *= 0.45;
  ctx.fillRect(0, -r, (b.alcance + r) * progresso, r * 2);
}

function avisoDaHorda(ctx, b, params, progresso) {
  const tipo = CONTEUDO.inimigos.find((t) => t.id === params.tipo);
  const raio = (tipo ? tipo.raio : CONTEUDO.banca.raio) * (1 + progresso);
  ctx.lineWidth = 2;
  for (let i = 0; i < b.quantosPontos; i += 1) {
    ctx.beginPath();
    ctx.arc(b.pontos[i].x, b.pontos[i].y, raio, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// As perguntas do leque: por cima dos inimigos, como os projeteis do jogador
// — e o que o jogador mais precisa enxergar.
function desenharPerguntas(ctx, perguntas, v) {
  const cfg = CONTEUDO.banca.pergunta;
  const tamanho = cfg.raio * v.banca.emojiPerguntaFator;
  for (let i = 0; i < perguntas.length; i += 1) {
    desenharEmoji(ctx, cfg.emoji, perguntas[i].x, perguntas[i].y, tamanho, v);
  }
}

// O texto da virada de fase, numa faixa escura no meio da tela, durante a
// pausa da transicao inteira (banca.transicao.duracao).
function desenharTransicaoDaBanca(ctx, b, largura, altura, v) {
  if (b.estado !== ESTADOS_BANCA.TRANSICAO) return;
  const proxima = CONTEUDO.banca.fases[b.fase + 1];
  if (!proxima) return;
  const vb = v.banca;
  const topo = altura * vb.faixaTextoY;
  const alto = altura * vb.faixaTextoAltura;
  ctx.fillStyle = vb.corSombraTexto;
  ctx.fillRect(0, topo, largura, alto);
  ctx.fillStyle = vb.corTexto;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = vb.fonteTexto;
  ctx.fillText(CONTEUDO.textos.banca.transicao, largura / 2, topo + alto * 0.4);
  ctx.font = vb.fonteSubtexto;
  ctx.fillText(preencher(CONTEUDO.textos.banca.fase, { n: b.fase + 2, nome: proxima.nome }), largura / 2, topo + alto * 0.75);
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

// orbital, ondaArea e feixe nao passam pela pool de projeteis (a orbita e o
// feixe seguem o jogador continuamente; discretizar isso em objetos pooled
// so pra desenhar seria mais estado pra sincronizar por nenhum ganho). O
// desenho le a mesma instancia de arma (estado.player.armas) e os mesmos
// numeros de content.js que weapons.js usa para a colisao, entao o que
// aparece na tela e sempre exatamente onde o dano acontece.
function desenharArmasEspeciais(ctx, player, v) {
  for (let i = 0; i < player.armas.length; i += 1) {
    const arma = player.armas[i];
    const dados = dadosDaArma(arma.id);
    if (!dados) continue;
    const nivel = nivelDaArma(arma);
    if (!nivel) continue;

    if (dados.comportamento === 'orbital') desenharOrbital(ctx, player, arma, dados, nivel, v);
    else if (dados.comportamento === 'ondaArea') desenharOnda(ctx, player, arma, nivel, v);
    else if (dados.comportamento === 'feixe') desenharFeixe(ctx, player, arma, nivel, v);
  }
}

function desenharOrbital(ctx, player, arma, dados, nivel, v) {
  const tamanho = nivel.raioColisao * v.emojiSateliteFator;
  for (let s = 0; s < nivel.quantidade; s += 1) {
    const pos = posicaoSatelite(player, arma, nivel, s);
    desenharEmoji(ctx, dados.emoji, pos.x, pos.y, tamanho, v);
  }
}

// O telegrafo cresce de 0 ate nivel.raio ao longo de CONTEUDO.ondaArea.
// duracaoAnimacao e desaparece (alpha cai) no mesmo ritmo — sem isso o dano
// da onda parece aleatorio (tarefa 2 do contrato da fase 05).
function desenharOnda(ctx, player, arma, nivel, v) {
  const duracao = CONTEUDO.ondaArea.duracaoAnimacao;
  const progresso = Math.min(1, (arma.animacao || 0) / duracao);
  if (progresso >= 1) return; // pulso anterior ja terminou de sumir
  ctx.strokeStyle = v.corOndaTelegrafo;
  ctx.globalAlpha = 1 - progresso;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(player.x, player.y, nivel.raio * progresso, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// Desenhado como uma faixa translucida (a "marcacao" do highlighter) do
// jogador ate o alcance, na direcao guardada em arma.angulo — a mesma
// direcao que weapons.js usa para a colisao.
function desenharFeixe(ctx, player, arma, nivel, v) {
  const angulo = arma.angulo || 0;
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(angulo);
  ctx.fillStyle = v.corFeixe;
  ctx.fillRect(0, -nivel.largura / 2, nivel.alcance, nivel.largura);
  ctx.restore();
}

export function desenharEmoji(ctx, emoji, x, y, tamanho, v = CONTEUDO.visual) {
  ctx.font = `${tamanho}px ${v.fonteEmoji}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, x, y);
}
