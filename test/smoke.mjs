// npm run smoke — roda a partida headless com semente fixa e falha se o jogo
// quebrar. Nenhum navegador envolvido: a simulacao e feita so de objetos.
//
// Como estender quando sua fase acrescentar sistema novo:
//   1. adicione uma entrada em VERIFICACOES com { nome, rodar(estado, tick) }
//      devolvendo uma string de erro ou null;
//   2. se sua fase criar uma pool nova, registre o teto em
//      CONTEUDO.arena.limites — a verificacao de pool le de la sozinha;
//   3. some seus contadores em resumo() para eles aparecerem na linha final.

import { CONTEUDO } from '../data/content.js';
import { novoEstado, iniciarAvaliacao, TELAS } from '../src/state.js';
import { atualizar } from '../src/main.js';
import { aplicarDano, spawnInimigo, poolInimigos } from '../src/enemies.js';
import { criarPool } from '../src/pool.js';

const SEMENTE = 20261110;
const TICKS = 3600; // 60s simulados a 1/60
const PASSO = CONTEUDO.loop.passo;
const INTERVALO_VARREDURA = 60; // varredura profunda de NaN/Infinity a cada 1s
const VOLTA_TICKS = 600; // bot: ticks para uma volta completa (10s a 60 ticks/s)
const TICKS_AQUECIMENTO = 600; // 10s: depois disso nenhuma alocacao nova e aceita
const TICKS_POR_ABATE = 30; // o bot "mata" um inimigo a cada meio segundo
const MINIMO_INIMIGOS = 20; // pico abaixo disso significa spawn quebrado

// Teste de carga: `npm run smoke -- --carga` enche a arena ate o teto da pool
// e mantem o jogador de pe, para medir o custo de IA + separacao + colisao no
// pior caso. Fora desse modo a corrida e a de sempre.
const CARGA = process.argv.includes('--carga');
const ALVO_CARGA = CONTEUDO.arena.limites.enemies;
if (CARGA) CONTEUDO.spawn.maxSimultaneos = ALVO_CARGA;

const POOLS = Object.keys(CONTEUDO.arena.limites).filter((p) => p !== 'eventos');

const picos = {};
for (const pool of POOLS) picos[pool] = 0;
const contadores = { avaliacoesConcluidas: 0, eventos: 0, porTipo: {} };

// Pools: alocacao so na abertura. `criados` e o numero de vezes que a fabrica
// rodou — se crescer depois do aquecimento, alguem esta alocando dentro do
// update, que e a restricao 5 do CLAUDE.md e a causa n1 de travamento.
const criadosNoAquecimento = {};
let danoTotal = 0;
let danoAnterior = 0;

// Rastreio de movimento do jogador: a asserção de arena so prova que ele nao
// SAI dos limites, o que passa igual se ele nunca sair do lugar. Isto pega o
// caso em que atualizarPlayer() para de ser chamado (ex.: alguem reorganiza
// atualizarAvaliacao() numa fase futura e perde a linha no meio do caminho).
let distanciaPercorrida = 0;
let posAnteriorX = null;
let posAnteriorY = null;
let minX = Infinity;
let maxX = -Infinity;
let minY = Infinity;
let maxY = -Infinity;

// avaliacao.danoTomado zera a cada avaliacao nova; acumular so as diferencas
// positivas da o total da corrida inteira, atravessando os reinicios.
function registrarDano(estado) {
  const atual = estado.run.avaliacao.danoTomado;
  if (atual > danoAnterior) danoTotal += atual - danoAnterior;
  danoAnterior = atual;
}

function registrarMovimento(estado) {
  const p = estado.player;
  if (posAnteriorX !== null) {
    distanciaPercorrida += Math.hypot(p.x - posAnteriorX, p.y - posAnteriorY);
  }
  posAnteriorX = p.x;
  posAnteriorY = p.y;
  if (p.x < minX) minX = p.x;
  if (p.x > maxX) maxX = p.x;
  if (p.y < minY) minY = p.y;
  if (p.y > maxY) maxY = p.y;
}

const VERIFICACOES = [
  {
    nome: 'escalares finitos',
    rodar(estado) {
      const av = estado.run.avaliacao;
      const suspeitos = [
        ['tempo', estado.tempo],
        ['player.x', estado.player.x],
        ['player.y', estado.player.y],
        ['player.hp', estado.player.hp],
        ['player.xp', estado.player.xp],
        ['avaliacao.restante', av.restante],
        ['avaliacao.decorrido', av.decorrido],
      ];
      for (const [nome, valor] of suspeitos) {
        if (!Number.isFinite(valor)) return `${nome} virou ${valor}`;
      }
      return null;
    },
  },
  {
    nome: 'pools dentro do teto',
    rodar(estado) {
      for (const pool of POOLS) {
        const tamanho = estado[pool].length;
        if (tamanho > picos[pool]) picos[pool] = tamanho;
        if (tamanho > CONTEUDO.arena.limites[pool]) {
          return `pool ${pool} com ${tamanho} itens, teto e ${CONTEUDO.arena.limites[pool]}`;
        }
      }
      if (estado.eventos.length > CONTEUDO.arena.limites.eventos) {
        return `fila de eventos com ${estado.eventos.length}, teto e ${CONTEUDO.arena.limites.eventos}`;
      }
      return null;
    },
  },
  {
    nome: 'tela valida',
    rodar(estado) {
      const validas = Object.values(TELAS);
      return validas.includes(estado.tela) ? null : `tela desconhecida "${estado.tela}"`;
    },
  },
  {
    nome: 'varredura profunda',
    rodar(estado, tick) {
      if (tick % INTERVALO_VARREDURA !== 0) return null;
      return procurarNumeroInvalido(estado, 'estado', new Set(), 0);
    },
  },
  {
    nome: 'inimigos sadios',
    rodar(estado) {
      const inimigos = estado.enemies;
      for (let i = 0; i < inimigos.length; i += 1) {
        const e = inimigos[i];
        if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) {
          return `inimigo ${i} (${e.tipo}) em posicao invalida (${e.x}, ${e.y})`;
        }
        if (!Number.isFinite(e.vx) || !Number.isFinite(e.vy)) {
          return `inimigo ${i} (${e.tipo}) com velocidade invalida (${e.vx}, ${e.vy})`;
        }
        if (!Number.isFinite(e.hp) || e.raio <= 0) {
          return `inimigo ${i} (${e.tipo}) com hp=${e.hp} raio=${e.raio}`;
        }
      }
      return null;
    },
  },
  {
    nome: 'pools sem alocar no loop',
    rodar(estado, tick) {
      const pools = estado.scratch && estado.scratch.pools;
      if (!pools) return null;
      for (const [chave, pool] of Object.entries(pools)) {
        if (tick <= TICKS_AQUECIMENTO) {
          criadosNoAquecimento[chave] = pool.criados;
        } else if (pool.criados > criadosNoAquecimento[chave]) {
          return (
            `pool ${chave} fabricou ${pool.criados - criadosNoAquecimento[chave]} objetos depois do ` +
            `aquecimento (${criadosNoAquecimento[chave]} -> ${pool.criados}) — alguem esta alocando dentro do update`
          );
        }
        if (tick % INTERVALO_VARREDURA === 0) {
          const problema = pool.verificar();
          if (problema) return `pool ${chave} inconsistente: ${problema}`;
        }
      }
      return null;
    },
  },
  {
    // Nao depende de semente, de balanceamento nem de o jogador morrer nesta
    // corrida: so proibe o estado impossivel. Continua valendo na fase 03,
    // quando as armas fizerem o jogador parar de morrer.
    nome: 'morte encerra a avaliacao',
    rodar(estado) {
      if (!estado.player.vivo && estado.tela === TELAS.AVALIACAO) {
        return 'jogador morto e a avaliacao continua: ninguem observa player.vivo';
      }
      return null;
    },
  },
  {
    nome: 'jogador dentro da arena',
    rodar(estado) {
      const { largura, altura } = CONTEUDO.arena;
      const p = estado.player;
      const r = p.raio;
      const FOLGA = 0.5; // acumulo de ponto flutuante no clamp da borda
      if (p.x < r - FOLGA || p.x > largura - r + FOLGA || p.y < r - FOLGA || p.y > altura - r + FOLGA) {
        return `jogador saiu da arena: (${p.x.toFixed(2)}, ${p.y.toFixed(2)}), raio=${r}, arena=${largura}x${altura}`;
      }
      return null;
    },
  },
];

// Bot minimo que move o jogador em circulo, escrevendo em estado.input como o
// teclado faria (eixoX/eixoY em [-1, 1]). player.js nunca le teclado direto —
// e exatamente essa porta que permite este bot substituir o navegador.
function botCircular(estado, tick) {
  const angulo = (tick / VOLTA_TICKS) * 2 * Math.PI;
  estado.input.eixoX = Math.cos(angulo);
  estado.input.eixoY = Math.sin(angulo);
}

// O bot ainda nao tem arma (fase 03), entao nada mataria inimigo e todo o
// caminho de morte — kills, evento e devolucao a pool — ficaria sem cobertura
// nenhuma. Isto usa a API publica aplicarDano() como uma arma usaria.
function botAbate(estado, tick) {
  if (tick % TICKS_POR_ABATE !== 0) return;
  const alvo = estado.enemies[0];
  if (alvo) aplicarDano(estado, alvo, alvo.hp);
}

// No modo carga a arena fica cheia ate o teto da pool e o jogador nao morre —
// o que se quer medir e o custo por quadro de IA, separacao e colisao com a
// pool inteira viva, nao a sobrevivencia dele.
function manterCarga(estado) {
  if (!CARGA || estado.tela !== TELAS.AVALIACAO) return;
  estado.player.hp = estado.player.hpMax; // toma dano (e conta), mas nao cai
  while (estado.enemies.length < ALVO_CARGA && spawnInimigo(estado)) {
    /* enche ate o teto */
  }
}

function procurarNumeroInvalido(valor, caminho, vistos, profundidade) {
  if (profundidade > 8) return null;
  if (typeof valor === 'number') {
    return Number.isFinite(valor) ? null : `${caminho} = ${valor}`;
  }
  if (typeof valor !== 'object' || valor === null) return null;
  if (vistos.has(valor)) return null;
  vistos.add(valor);
  if (Array.isArray(valor)) {
    for (let i = 0; i < valor.length; i += 1) {
      const achado = procurarNumeroInvalido(valor[i], `${caminho}[${i}]`, vistos, profundidade + 1);
      if (achado) return achado;
    }
    return null;
  }
  for (const [chave, item] of Object.entries(valor)) {
    if (typeof item === 'function') continue;
    const achado = procurarNumeroInvalido(item, `${caminho}.${chave}`, vistos, profundidade + 1);
    if (achado) return achado;
  }
  return null;
}

function falhar(tick, mensagem) {
  console.error(`\nsmoke FALHOU no tick ${tick} (t=${(tick * PASSO).toFixed(2)}s):`);
  console.error(`  x ${mensagem}\n`);
  process.exit(1);
}

// A partida nunca enche a pool ate o teto (spawn.maxSimultaneos para antes),
// entao o caminho de "pool cheia: recicle o mais antigo" ficaria sem cobertura
// nenhuma — e e justamente ele que decide se o jogo aloca ou trava quando a
// arena lota. Pool de brinquedo, tres objetos, antes da corrida.
function checarReciclagemDaPool() {
  const pool = criarPool(3, () => ({ marca: 0 }));
  const primeiro = pool.obter();
  primeiro.marca = 1;
  pool.obter().marca = 2;
  pool.obter().marca = 3;
  const quarto = pool.obter(); // pool cheia: precisa reaproveitar o de marca 1

  if (pool.ativos.length !== 3) falhar(0, `pool cheia cresceu para ${pool.ativos.length} ativos (teto 3)`);
  if (pool.criados !== 3) falhar(0, `pool cheia fabricou objeto novo (criados=${pool.criados})`);
  if (quarto !== primeiro) falhar(0, 'pool cheia nao reciclou o objeto mais antigo');
  if (pool.reciclados !== 1) falhar(0, `esperava 1 reciclagem, veio ${pool.reciclados}`);
  const problema = pool.verificar();
  if (problema) falhar(0, `pool de brinquedo inconsistente: ${problema}`);

  pool.liberarTodos();
  if (pool.ativos.length !== 0 || pool.reserva.length !== 3) {
    falhar(0, `liberarTodos deixou ativos=${pool.ativos.length} reserva=${pool.reserva.length}`);
  }
}

// ------------------------------------------------------------------ corrida

checarReciclagemDaPool();

const estado = novoEstado(SEMENTE);
iniciarAvaliacao(estado);

function rodarTick(estado, tick, { reiniciarAvaliacao = true } = {}) {
  botCircular(estado, tick);
  manterCarga(estado);

  try {
    atualizar(estado, PASSO);
    botAbate(estado, tick);
  } catch (e) {
    falhar(tick, `excecao em atualizar(): ${e && e.stack ? e.stack : e}`);
  }

  registrarMovimento(estado);
  registrarDano(estado);

  for (const verificacao of VERIFICACOES) {
    let problema = null;
    try {
      problema = verificacao.rodar(estado, tick);
    } catch (e) {
      problema = `a propria verificacao explodiu: ${e && e.message ? e.message : e}`;
    }
    if (problema) falhar(tick, `[${verificacao.nome}] ${problema}`);
  }

  // Faz o papel do consumidor da fila (audio/juice no navegador).
  for (const evento of estado.eventos) {
    contadores.eventos += 1;
    contadores.porTipo[evento.tipo] = (contadores.porTipo[evento.tipo] || 0) + 1;
  }
  estado.eventos.length = 0;

  // A avaliacao acabou: comeca a proxima para que os ticks todos rodem dentro
  // da jogabilidade, nao parados no menu.
  if (estado.tela === TELAS.MENU) {
    contadores.avaliacoesConcluidas += 1;
    if (reiniciarAvaliacao) iniciarAvaliacao(estado);
  }
}

const comecou = Date.now();
for (let tick = 1; tick <= TICKS; tick += 1) rodarTick(estado, tick);

// O caminho de fim por tempo precisa rodar em toda corrida. Duas coisas
// atrapalham: dt fixo acumula erro de ponto flutuante (3600 * 1/60 da
// 59,9999...s, entao uma avaliacao de 60s nao fecha dentro do laco) e, desde
// a fase 02, o jogador morre antes dos 60s e a avaliacao seguinte comeca
// desalinhada. Adianta-se o cronometro para o ultimo segundo e segura-se o hp
// para que o encerramento seja o do timer, nao o de jubilamento.
const TOLERANCIA_FIM = 120;
if (estado.tela === TELAS.MENU) iniciarAvaliacao(estado);
estado.run.avaliacao.decorrido = estado.run.avaliacao.duracao - 1;
let extras = 0;
while (estado.tela !== TELAS.MENU && extras < TOLERANCIA_FIM) {
  extras += 1;
  estado.player.hp = estado.player.hpMax;
  rodarTick(estado, TICKS + extras, { reiniciarAvaliacao: false });
}
if (estado.tela !== TELAS.MENU) {
  falhar(TICKS + extras, `a avaliacao nao encerrou ${TOLERANCIA_FIM} ticks depois da duracao`);
}
if (!contadores.porTipo['avaliacao-fim']) {
  falhar(TICKS + extras, 'nenhum evento avaliacao-fim na corrida: o fim por tempo nao rodou');
}

// O bot circular gira devagar (uma volta a cada 10s) contra um jogador que
// acelera rapido (~0,14s ate a velocidade maxima) — em 60s+ isso soma muitos
// milhares de px e varre boa parte da arena nos dois eixos. Estes minimos
// ficam bem abaixo do que qualquer movimento real produz; so pegam o jogador
// parado (distancia e amplitude ficariam em 0).
const DISTANCIA_MINIMA = 2000;
const AMPLITUDE_MINIMA = 200;
const amplitudeX = maxX - minX;
const amplitudeY = maxY - minY;
if (distanciaPercorrida < DISTANCIA_MINIMA || amplitudeX < AMPLITUDE_MINIMA || amplitudeY < AMPLITUDE_MINIMA) {
  falhar(
    TICKS + extras,
    `jogador praticamente parado: distancia=${distanciaPercorrida.toFixed(1)}px (minimo ${DISTANCIA_MINIMA}), ` +
      `amplitude=${amplitudeX.toFixed(1)}x${amplitudeY.toFixed(1)}px (minimo ${AMPLITUDE_MINIMA} por eixo) — ` +
      'atualizarPlayer() esta sendo chamado dentro de atualizarAvaliacao()?'
  );
}

// Inimigos: as tres asserções da fase 02 que so valem no fim da corrida. Sem
// elas as verificacoes por tick passariam iguais com o spawn desligado — uma
// arena vazia nao tem inimigo com NaN nem pool crescendo.
if (picos.enemies < MINIMO_INIMIGOS) {
  falhar(TICKS + extras, `pico de inimigos foi ${picos.enemies} (minimo ${MINIMO_INIMIGOS}): o spawn rodou?`);
}
if (danoTotal <= 0) {
  falhar(TICKS + extras, 'o jogador nao tomou dano nenhum: inimigos perseguem e colidem?');
}
if (!contadores.porTipo['inimigo-morto']) {
  falhar(TICKS + extras, 'nenhum inimigo morreu: aplicarDano() nao devolveu ninguem a pool');
}
const poolFinal = poolInimigos(estado);
if (poolFinal.criados !== poolFinal.capacidade) {
  falhar(
    TICKS + extras,
    `pool de inimigos fabricou ${poolFinal.criados} objetos para uma capacidade de ${poolFinal.capacidade}`
  );
}

const segundos = (Date.now() - comecou) / 1000;
const picosTexto = POOLS.map((p) => `${p}=${picos[p]}`).join(' ');
console.log(
  `smoke ok${CARGA ? ' (carga)' : ''} — ${TICKS}+${extras} ticks (${((TICKS + extras) * PASSO).toFixed(1)}s simulados` +
    ` em ${segundos.toFixed(2)}s) · avaliacoes=${contadores.avaliacoesConcluidas}` +
    ` · eventos=${contadores.eventos} · hp=${estado.player.hp}/${estado.player.hpMax}` +
    ` · nivel=${estado.player.nivel} · distancia=${distanciaPercorrida.toFixed(0)}px` +
    ` · amplitude=${amplitudeX.toFixed(0)}x${amplitudeY.toFixed(0)}px` +
    ` · dano=${danoTotal} · jubilado=${contadores.porTipo.jubilado || 0}` +
    ` · mortos=${contadores.porTipo['inimigo-morto'] || 0}` +
    ` · pool inimigos: criados=${poolFinal.criados} reciclados=${poolFinal.reciclados}` +
    ` ressinc=${poolFinal.ressincronizacoes} · picos: ${picosTexto}`
);
