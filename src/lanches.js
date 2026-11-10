import { CONTEUDO } from '../data/content.js';
import { emitir } from './state.js';
import { obterPool } from './pool.js';
import { curar } from './player.js';
import { curaDeLanche } from './jokers.js';

// Os lanches da prova (pos-entrega). A vida nao enche mais entre avaliacoes:
// so lanche devolve HP. Na prova ele e pequeno de proposito, o biscoito de
// CONTEUDO.lanches.arena; quem cura de verdade e a cantina da loja (shop.js).
//
// O biscoito cai de uma morte: a cada `aCadaMortes` mortes, com pelo menos
// `intervaloMinimo` segundos desde o anterior e no maximo `maxPorAvaliacao`
// por avaliacao. Nao sorteia nada (conta mortes), entao nao gasta o rng: a
// partida com e sem biscoito so difere no HP do jogador. Fica parado onde
// caiu, some depois de `duracao` segundos e so e comido com HP faltando — com
// a vida cheia o jogador passa por cima e ele fica esperando.
//
// Simulacao pura, como player.js: nada aqui toca no DOM nem no canvas.

export function poolLanches(estado) {
  return obterPool(estado, 'lanches', fabricarLanche).sincronizar();
}

function fabricarLanche() {
  return { ativo: false, slot: -1, nasc: 0, x: 0, y: 0, vida: 0 };
}

// Chamado por enemies.js a cada morte, com a posicao do inimigo.
export function contarMorteParaLanche(estado, x, y) {
  const cfg = CONTEUDO.lanches.arena;
  const av = estado.run.avaliacao;
  av.mortesParaLanche += 1;
  if (av.lanchesSoltos >= cfg.maxPorAvaliacao) return null;
  if (av.mortesParaLanche < cfg.aCadaMortes) return null;
  if (av.lanchesSoltos > 0 && av.decorrido - av.lancheEm < cfg.intervaloMinimo) return null;
  av.mortesParaLanche = 0;
  av.lanchesSoltos += 1;
  av.lancheEm = av.decorrido;
  const lanche = poolLanches(estado).obter();
  // Grampeado na arena, como o orbe: inimigo morto fora da borda deixaria um
  // biscoito que ninguem alcanca.
  const arena = av.arena;
  const margem = cfg.raio;
  lanche.x = Math.min(Math.max(x, arena.esquerda + margem), arena.direita - margem);
  lanche.y = Math.min(Math.max(y, arena.topo + margem), arena.base - margem);
  lanche.vida = cfg.duracao;
  emitir(estado, 'lanche-solto', { x: lanche.x, y: lanche.y });
  return lanche;
}

// main.js, depois dos orbes. De tras para frente: liberar() e swap-remove.
export function atualizarLanches(estado, dt) {
  const pool = poolLanches(estado);
  const lista = pool.ativos;
  if (lista.length === 0) return;
  const player = estado.player;
  const alcance = player.raio + CONTEUDO.lanches.arena.raio;
  for (let i = lista.length - 1; i >= 0; i -= 1) {
    const lanche = lista[i];
    lanche.vida -= dt;
    if (lanche.vida <= 0) {
      pool.liberar(lanche);
      continue;
    }
    if (!player.vivo || player.hp >= player.hpMax) continue;
    const dx = player.x - lanche.x;
    const dy = player.y - lanche.y;
    if (dx * dx + dy * dy > alcance * alcance) continue;
    const curado = curar(estado, curaDeLanche(estado, CONTEUDO.lanches.arena.cura));
    emitir(estado, 'lanche-coletado', { cura: curado, x: lanche.x, y: lanche.y });
    pool.liberar(lanche);
  }
}
