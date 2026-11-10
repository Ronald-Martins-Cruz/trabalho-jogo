// Os jogadores de mentira do simulador de balanceamento (test/sim.mjs, fase 13).
//
// Um estilo so mente sobre o balanceamento: o design §4 quer que quem caca e
// quem preserva HP cheguem a notas parecidas por caminhos diferentes, e so da
// para medir isso com os dois estilos jogando as mesmas sementes. Por isso tres
// bots, cada um com tres politicas declaradas — mover, escolher carta, comprar:
//
//   passivo    foge de tudo que chega perto, desvia de pergunta e de
//              investida, so busca orbe quando nao ha ninguem por perto.
//              Carta: cura com HP baixo, senao as armas de alcance (Cafe,
//              Marca-texto), que matam antes de o bando chegar. Loja:
//              sobrevivencia primeiro (Atestado, Energetico).
//   agressivo  vai ate o bando e fica a uma distancia de tiro dele, catando
//              orbe; so foge do contato direto. Carta: a arma que mais mata
//              (ordem medida no smoke, arsenal especializado), nunca a cura se
//              houver arma. Loja: dano primeiro (WhatsApp, Vespera).
//   aleatorio  anda em direcoes sorteadas sem olhar nada, escolhe carta e
//              compra ao acaso. E o piso da competencia: se ele se forma
//              com folga, o jogo esta facil demais.
//
// E um quarto, a regua das fases anteriores, tambem na mistura padrao:
//
//   desvio     copia fiel do botDesvio de test/smoke.mjs (sempre a 1a carta,
//              compra o mais caro que couber). E a regua com que as fases
//              06-10 mediram tudo, e a que reproduzia a partida do usuario no
//              checkpoint 1. Liga os numeros do sim aos dos handoffs, e e o
//              mais perto de um humano mediano: o passivo e o agressivo veem
//              tudo e sempre pegam o Cafe, o que um humano nao faz.
//
// Os numeros daqui sao do BOT, nao do jogo: raios de medo, pesos de cada
// impulso. Moram aqui, como RAIO_DESVIO mora no smoke. Nenhum bot le teclado
// nem toca em estado de jogo alem de estado.input, estado.cartas (pela porta
// escolherCarta, no sim) e a loja (pelas funcoes de shop.js).
//
// Nenhum bot usa estado.rng: o aleatorio tem o rng dele. Assim a decisao de
// um bot nunca muda o que o jogo sorteia por baixo — so o que o jogador faz.

import { CONTEUDO } from '../data/content.js';
import { criarRng } from '../src/rng.js';
import { ESTADOS_BANCA } from '../src/boss.js';
import { comprarItem, comprarLanche, valorDeVenda, venderCoringa, vidaNaLoja } from '../src/shop.js';

const IMPULSO_MINIMO = 0.05; // abaixo disto o bot solta o direcional em vez de tremer
const TIPO_CURA = 'cura';
const PADRAO_INVESTIDA = 'investida';

// ------------------------------------------------------------ campo de forcas
// Todo bot que olha o mundo soma impulsos num vetor e solta a direcao dele no
// direcional. `f` e reaproveitado (um por memoria de bot): nada aloca por tick.

function repelirInimigos(estado, f, raio, peso) {
  const p = estado.player;
  for (const e of estado.enemies) {
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) continue;
    // Superficie a superficie: o PDF (raio 24) e a Banca (26) assustam antes.
    const borda = Math.max(0, d - e.raio - p.raio);
    if (borda > raio) continue;
    const w = (raio - borda) / raio;
    f.x += (dx / d) * w * w * peso;
    f.y += (dy / d) * w * w * peso;
  }
}

// Empurra para o lado de cada pergunta que vem na direcao do jogador.
function desviarPerguntas(estado, f, raio, peso) {
  const p = estado.player;
  for (const q of estado.perguntas) {
    const dx = p.x - q.x;
    const dy = p.y - q.y;
    const d = Math.hypot(dx, dy);
    const v = Math.hypot(q.vx, q.vy);
    if (d > raio || v < 1e-6) continue;
    const ux = q.vx / v;
    const uy = q.vy / v;
    const frente = dx * ux + dy * uy;
    if (frente <= 0) continue; // ja passou
    let px = dx - frente * ux;
    let py = dy - frente * uy;
    let pd = Math.hypot(px, py);
    const faixa = q.raio + p.raio + 14;
    if (pd > faixa) continue;
    if (pd < 1e-6) {
      px = -uy;
      py = ux;
      pd = 1;
    }
    const w = (1 - pd / faixa) * (1 - d / raio) + 0.25;
    f.x += (px / pd) * w * peso;
    f.y += (py / pd) * w * peso;
  }
}

// Sai do corredor da investida enquanto ela e avisada ou executada: o trecho
// reto, da Banca na mira, e o deslize ao longo da parede, que comeca na quina
// (fase 14, pendencia 75). Correndo o deslize, o trecho reto ja passou.
function desviarInvestida(estado, f, peso) {
  const b = estado.run.avaliacao.banca;
  if (!b || b.padrao !== PADRAO_INVESTIDA) return;
  if (b.estado !== ESTADOS_BANCA.TELEGRAFO && b.estado !== ESTADOS_BANCA.EXECUTANDO) return;
  const p = estado.player;
  const largura = CONTEUDO.banca.raio + p.raio + 24;
  if (b.perna !== 1) fugirDoCorredor(p, f, b.x, b.y, Math.cos(b.mira), Math.sin(b.mira), b.alcance, largura, peso);
  if (b.deslize > 0) fugirDoCorredor(p, f, b.quinaX, b.quinaY, b.deslizeX, b.deslizeY, b.deslize, largura, peso);
}

function fugirDoCorredor(p, f, x0, y0, ux, uy, comprimento, largura, peso) {
  const dx = p.x - x0;
  const dy = p.y - y0;
  const frente = dx * ux + dy * uy;
  if (frente < -largura || frente > comprimento + largura) return;
  let px = dx - frente * ux;
  let py = dy - frente * uy;
  let pd = Math.hypot(px, py);
  if (pd > largura) return;
  if (pd < 1e-6) {
    px = -uy;
    py = ux;
    pd = 1;
  }
  const w = 1 - pd / largura + 0.5;
  f.x += (px / pd) * w * peso;
  f.y += (py / pd) * w * peso;
}

function evitarParedes(estado, f, margem, peso) {
  const p = estado.player;
  const a = estado.run.avaliacao.arena;
  const esq = p.x - a.esquerda;
  const dir = a.direita - p.x;
  const topo = p.y - a.topo;
  const base = a.base - p.y;
  if (esq < margem) f.x += (1 - esq / margem) * peso;
  if (dir < margem) f.x -= (1 - dir / margem) * peso;
  if (topo < margem) f.y += (1 - topo / margem) * peso;
  if (base < margem) f.y -= (1 - base / margem) * peso;
}

function puxarCentro(estado, f, peso) {
  const p = estado.player;
  const a = estado.run.avaliacao.arena;
  f.x += (((a.esquerda + a.direita) / 2 - p.x) / (a.direita - a.esquerda)) * peso;
  f.y += (((a.topo + a.base) / 2 - p.y) / (a.base - a.topo)) * peso;
}

function inimigoMaisPerto(estado, raio) {
  const p = estado.player;
  let melhor = raio * raio;
  let achou = false;
  for (const e of estado.enemies) {
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < melhor) {
      melhor = d2;
      achou = true;
    }
  }
  return achou;
}

function buscarOrbe(estado, f, raio, peso) {
  const p = estado.player;
  let melhor = raio * raio;
  let ox = 0;
  let oy = 0;
  let achou = false;
  for (const o of estado.xpOrbs) {
    const dx = o.x - p.x;
    const dy = o.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < melhor) {
      melhor = d2;
      ox = dx;
      oy = dy;
      achou = true;
    }
  }
  if (!achou) return;
  const d = Math.sqrt(melhor);
  if (d < 1e-6) return;
  f.x += (ox / d) * peso;
  f.y += (oy / d) * peso;
}

// Vai ate o bando sem entrar nele: o centro de massa dos inimigos, pesado por
// proximidade (o bando do outro lado da arena conta pouco). Longe da
// `distancia`, puxa; perto demais, empurra.
function rondarBando(estado, f, distancia, escala, peso) {
  const p = estado.player;
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (const e of estado.enemies) {
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const d = Math.hypot(dx, dy) / escala;
    const w = 1 / (1 + d * d);
    sx += e.x * w;
    sy += e.y * w;
    sw += w;
  }
  if (sw <= 0) return;
  const dx = sx / sw - p.x;
  const dy = sy / sw - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return;
  const w = Math.max(-1, Math.min(1, (d - distancia) / distancia));
  f.x += (dx / d) * w * peso;
  f.y += (dy / d) * w * peso;
}

function soltarDirecao(estado, f) {
  const n = Math.hypot(f.x, f.y);
  estado.input.eixoX = n < IMPULSO_MINIMO ? 0 : f.x / n;
  estado.input.eixoY = n < IMPULSO_MINIMO ? 0 : f.y / n;
}

// ------------------------------------------------------------- cartas e loja

function indiceDe(lista, id) {
  const i = lista.indexOf(id);
  return i < 0 ? lista.length : i;
}

// A melhor carta por uma ordem de armas: a primeira arma da ordem que
// aparecer (nova ou +1 nivel). A cura so ganha quando `curaAbaixo` diz que o HP
// esta baixo, ou quando nao ha arma nenhuma na mesa.
function cartaPorOrdem(estado, ordem, curaAbaixo) {
  const opcoes = estado.cartas.opcoes;
  const p = estado.player;
  const hpBaixo = p.hpMax > 0 && p.hp / p.hpMax < curaAbaixo;
  let melhor = 0;
  let melhorNota = Infinity;
  for (let i = 0; i < opcoes.length; i += 1) {
    const o = opcoes[i];
    if (o.tipo === '') continue;
    let nota;
    if (o.tipo === TIPO_CURA) nota = hpBaixo ? -1 : ordem.length + 1;
    else nota = indiceDe(ordem, o.id);
    if (nota < melhorNota) {
      melhorNota = nota;
      melhor = i;
    }
  }
  return melhor;
}

// Pos-entrega: a vida nao enche mais entre avaliacoes, e o lanche da cantina
// e a unica cura da loja. Cada bot come ANTES de comprar item, um lanche atras
// do outro (cada um mais caro), enquanto o HP de agora (vidaNaLoja) estiver
// abaixo de `abaixo` do maximo e o credito der. Devolve o total pago.
export function comerSeFerido(estado, abaixo) {
  let pago = 0;
  for (let i = 0; i < 20; i += 1) {
    const vida = vidaNaLoja(estado);
    if (!(vida.hpMax > 0) || vida.hp / vida.hpMax >= abaixo) break;
    const preco = estado.loja.lanche.preco;
    if (!comprarLanche(estado)) break;
    pago += preco;
  }
  return pago;
}

// O que comerSeFerido pagou entra no gasto da visita (o sim soma a economia).
function comEGasta(estado, abaixo, compra) {
  const lanche = comerSeFerido(estado, abaixo);
  const r = compra();
  r.gasto += lanche;
  r.lanche = lanche > 0;
  return r;
}

// Compra pela ordem de preferencia do bot, enquanto couber no credito e no
// teto. Sem reroll e sem guardar dinheiro: politica simples e declarada, nao
// otima.
//
// Pos-entrega: com 15 itens, a mochila enche de barato no 1o periodo e, sem
// vender, o bot nunca chegava ao item que mais queria (o passivo comprava o
// Atestado em toda run na v2.0 e em nenhuma depois). Agora, cheio, ele troca:
// vende o pior da mochila (pela ordem dele) se a vitrine tem um melhor que o
// credito + a venda pagam. Uma troca por visita, como um humano cauteloso.
function comprarPorOrdem(estado, ordem) {
  const loja = estado.loja;
  const indices = [];
  for (let i = 0; i < loja.quantidade; i += 1) if (loja.itens[i].id !== '' && !loja.itens[i].vendido) indices.push(i);
  indices.sort((x, y) => indiceDe(ordem, loja.itens[x].id) - indiceDe(ordem, loja.itens[y].id));
  const r = comprarNaOrdem(estado, indices);
  trocarPeloMelhor(estado, ordem, indices, r);
  return r;
}

function trocarPeloMelhor(estado, ordem, indices, r) {
  const mao = estado.run.coringas;
  if (mao.length < CONTEUDO.loja.teto) return;
  let pior = -1;
  for (let k = 0; k < mao.length; k += 1) {
    if (pior < 0 || indiceDe(ordem, mao[k].id) > indiceDe(ordem, mao[pior].id)) pior = k;
  }
  const loja = estado.loja;
  for (const i of indices) {
    const item = loja.itens[i];
    if (item.vendido || indiceDe(ordem, item.id) >= indiceDe(ordem, mao[pior].id)) continue;
    if (estado.run.creditos + valorDeVenda(mao[pior].id) < item.preco) continue;
    const valor = valorDeVenda(mao[pior].id);
    // Vender a Carteirinha encarece a vitrine: o preco que vale e o de depois.
    const dadosPior = CONTEUDO.coringas.find((c) => c.id === mao[pior].id);
    const fator = dadosPior && dadosPior.params.atributo === 'precoLoja' ? 1 / dadosPior.params.fator : 1;
    if (estado.run.creditos + valor < item.preco * fator) continue;
    if (!venderCoringa(estado, pior)) return;
    const preco = item.preco;
    if (comprarItem(estado, i)) {
      r.comprados.push(item.id);
      r.gasto += preco - valor;
    }
    return;
  }
}

function comprarNaOrdem(estado, indices) {
  const loja = estado.loja;
  const comprados = [];
  let gasto = 0;
  for (const i of indices) {
    const item = loja.itens[i];
    if (item.preco > estado.run.creditos || estado.run.coringas.length >= CONTEUDO.loja.teto) continue;
    const id = item.id;
    const preco = item.preco;
    if (comprarItem(estado, i)) {
      comprados.push(id);
      gasto += preco;
    }
  }
  return { comprados, gasto };
}

// ---------------------------------------------------------------------- bots

// Quem foge quer matar de longe: as armas de alcance primeiro. A Caneta (orbita
// de 80-98px desde a fase 13) so acerta quem chega perto.
const ARMAS_PASSIVO = ['cafe', 'marcatexto', 'resumo', 'caneta'];
// A ordem do arsenal especializado do smoke (kills em 60s no nivel maximo,
// numeros da fase 13: Cafe 247, Resumo 239, Caneta 212, Marca-texto 114 — a
// mesma ordem de quando a politica foi escrita).
const ARMAS_AGRESSIVO = ['cafe', 'resumo', 'caneta', 'marcatexto'];
// Pos-entrega: os itens novos entram na ordem de cada estilo (o que nao esta
// na lista fica por ultimo, na ordem da vitrine).
const LOJA_PASSIVO = ['atestado', 'garrafa', 'bandejao', 'energetico', 'caderno', 'sono', 'wifi', 'lancheira', 'vespera', 'whatsapp'];
const LOJA_AGRESSIVO = ['whatsapp', 'cola', 'vespera', 'sono', 'caderno', 'energetico', 'wifi', 'atestado'];
// Os limiares de HP em que cada bot come na cantina.
const COME_PASSIVO = 0.9;
const COME_AGRESSIVO = 0.65;
const COME_ALEATORIO = 0.75;
export const COME_DESVIO = 0.7; // o mesmo do comprarOQueDer do smoke

const passivo = {
  nome: 'passivo',
  descricao: 'foge de quem chega perto, desvia de pergunta e investida, orbe so sem ninguem perto; carta: cura <60% HP, senao Cafe>Marca-texto>Resumo>Caneta (alcance primeiro); loja: come <90% HP, depois Atestado>Garrafa>Bandejao>Energetico>Caderno>Sono>Wi-Fi>Lancheira>Vespera>WhatsApp',
  novaMemoria: () => ({ f: { x: 0, y: 0 } }),
  mover(estado, mem) {
    const f = mem.f;
    f.x = 0;
    f.y = 0;
    repelirInimigos(estado, f, 190, 1.4);
    desviarPerguntas(estado, f, 170, 2.2);
    desviarInvestida(estado, f, 2.6);
    evitarParedes(estado, f, 110, 1.2);
    puxarCentro(estado, f, 0.6);
    if (!inimigoMaisPerto(estado, 150)) buscarOrbe(estado, f, 220, 0.5);
    soltarDirecao(estado, f);
  },
  carta: (estado) => cartaPorOrdem(estado, ARMAS_PASSIVO, 0.6),
  comprar: (estado) => comEGasta(estado, COME_PASSIVO, () => comprarPorOrdem(estado, LOJA_PASSIVO)),
};

const agressivo = {
  nome: 'agressivo',
  descricao: 'ronda o bando a ~100px catando orbe, foge so do contato; carta: Cafe>Resumo>Caneta>Marca-texto, cura so sem arma na mesa; loja: come <65% HP, depois WhatsApp>Cola>Vespera>Sono>Caderno>Energetico>Wi-Fi>Atestado',
  novaMemoria: () => ({ f: { x: 0, y: 0 } }),
  mover(estado, mem) {
    const f = mem.f;
    f.x = 0;
    f.y = 0;
    rondarBando(estado, f, 100, 220, 1.0);
    repelirInimigos(estado, f, 60, 2.2);
    desviarPerguntas(estado, f, 150, 2.2);
    desviarInvestida(estado, f, 2.6);
    buscarOrbe(estado, f, 200, 0.7);
    evitarParedes(estado, f, 70, 1.0);
    puxarCentro(estado, f, 0.2);
    soltarDirecao(estado, f);
  },
  carta: (estado) => cartaPorOrdem(estado, ARMAS_AGRESSIVO, -1),
  comprar: (estado) => comEGasta(estado, COME_AGRESSIVO, () => comprarPorOrdem(estado, LOJA_AGRESSIVO)),
};

const ALEATORIO_TROCA_MIN = 0.3; // s ate sortear outra direcao
const ALEATORIO_TROCA_MAX = 1.5;
const ALEATORIO_PARADO = 0.15; // chance de ficar parado no proximo trecho
const ALEATORIO_PAREDE = 40; // px: rente a parede ele vira para dentro

const aleatorio = {
  nome: 'aleatorio',
  descricao: 'direcao sorteada a cada 0,3-1,5s (15% parado), vira para dentro rente a parede, nao olha nada; carta e loja ao acaso',
  novaMemoria: (semente) => ({ rng: criarRng((semente ^ 0x5eed5eed) >>> 0), ax: 0, ay: 0, relogio: 0 }),
  mover(estado, mem) {
    mem.relogio -= CONTEUDO.loop.passo;
    if (mem.relogio <= 0) {
      mem.relogio = mem.rng.range(ALEATORIO_TROCA_MIN, ALEATORIO_TROCA_MAX);
      if (mem.rng.chance(ALEATORIO_PARADO)) {
        mem.ax = 0;
        mem.ay = 0;
      } else {
        const ang = mem.rng.range(0, Math.PI * 2);
        mem.ax = Math.cos(ang);
        mem.ay = Math.sin(ang);
      }
    }
    const p = estado.player;
    const a = estado.run.avaliacao.arena;
    if (p.x - a.esquerda < ALEATORIO_PAREDE) mem.ax = Math.abs(mem.ax);
    if (a.direita - p.x < ALEATORIO_PAREDE) mem.ax = -Math.abs(mem.ax);
    if (p.y - a.topo < ALEATORIO_PAREDE) mem.ay = Math.abs(mem.ay);
    if (a.base - p.y < ALEATORIO_PAREDE) mem.ay = -Math.abs(mem.ay);
    estado.input.eixoX = mem.ax;
    estado.input.eixoY = mem.ay;
  },
  carta(estado, mem) {
    return mem.rng.int(0, estado.cartas.opcoes.length - 1);
  },
  comprar(estado, mem) {
    const loja = estado.loja;
    const indices = [];
    for (let i = 0; i < loja.quantidade; i += 1) if (loja.itens[i].id !== '') indices.push(i);
    for (let i = indices.length - 1; i > 0; i -= 1) {
      const j = mem.rng.int(0, i);
      const t = indices[i];
      indices[i] = indices[j];
      indices[j] = t;
    }
    return comEGasta(estado, COME_ALEATORIO, () => comprarNaOrdem(estado, indices));
  },
};

// test/smoke.mjs botDesvio, linha por linha (RAIO_DESVIO 150, PUXAO_CENTRO
// 0.8, centro do canvas), e comprarOQueDer. Se o smoke mudar o bot, mude aqui.
const desvio = {
  nome: 'desvio',
  descricao: 'botDesvio do smoke (foge num raio de 150px, volta ao meio), sempre a 1a carta, come <70% HP e compra o mais caro que couber',
  novaMemoria: () => ({}),
  mover(estado) {
    const p = estado.player;
    const { largura, altura } = CONTEUDO.arena;
    const raio = 150;
    let fx = 0;
    let fy = 0;
    for (const e of estado.enemies) {
      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > raio * raio || d2 < 1e-9) continue;
      const d = Math.sqrt(d2);
      const peso = (raio - d) / raio;
      fx += (dx / d) * peso * peso;
      fy += (dy / d) * peso * peso;
    }
    fx += ((largura / 2 - p.x) / largura) * 0.8;
    fy += ((altura / 2 - p.y) / altura) * 0.8;
    const n = Math.hypot(fx, fy);
    estado.input.eixoX = n < IMPULSO_MINIMO ? 0 : fx / n;
    estado.input.eixoY = n < IMPULSO_MINIMO ? 0 : fy / n;
  },
  carta: () => 0,
  comprar(estado) {
    const loja = estado.loja;
    const indices = [];
    for (let i = 0; i < loja.quantidade; i += 1) if (loja.itens[i].id !== '') indices.push(i);
    indices.sort((x, y) => loja.itens[y].preco - loja.itens[x].preco);
    return comEGasta(estado, COME_DESVIO, () => comprarNaOrdem(estado, indices));
  },
};

// test/smoke.mjs botCanto (pendencias 40 e 44): prensado no canto de cima a
// esquerda a run inteira, com as cartas e a loja do desvio. Fora da mistura
// padrao; e o "ficar parado nao pode pagar" do checkpoint 1 em muitas sementes.
const canto = {
  nome: 'canto',
  descricao: 'botCanto do smoke (parado no canto de cima a esquerda), sempre a 1a carta, compra o mais caro que couber',
  novaMemoria: () => ({}),
  mover(estado) {
    estado.input.eixoX = -1;
    estado.input.eixoY = -1;
  },
  carta: desvio.carta,
  comprar: desvio.comprar,
};

export const BOTS = { passivo, agressivo, aleatorio, desvio, canto };
// A mistura padrao do sim: os tres estilos do contrato da fase 13 e a regua
// antiga (desvio), que liga o sim aos numeros dos handoffs 06-10.
export const BOTS_PADRAO = ['passivo', 'agressivo', 'aleatorio', 'desvio'];
