// npm run sim — o simulador de balanceamento (fase 13).
//
// Joga N runs completas (padrao 100) pelas portas do jogo — anuncio,
// avaliacao, boletim, loja... TCC, colacao — com os bots de test/bots.mjs, e
// imprime um relatorio. Nenhum navegador: e a mesma simulacao que o smoke roda.
//
//   npm run sim                              100 runs, os 4 bots, marginal ligado
//   npm run sim -- --runs=30 --bots=passivo  so um bot
//   npm run sim -- --semente=777             outra familia de sementes
//   npm run sim -- --marginal=0              sem o experimento de coringas
//   npm run sim -- --salvar=antes.json       guarda as metricas-chave...
//   npm run sim -- --comparar=antes.json     ...e mostra antes/depois/delta
//   npm run sim -- --relatorio=sessao.md     + o relatorio de sessao dos humanos
//   npm run sim -- --detalhe=1               + uma linha por run (e --comparar completo)
//
// Opcoes: --runs --semente --bots --marginal --marginal-bot --workers --tcc-max
// --detalhe --salvar --comparar --relatorio (ver lerArgs).
//
// Sementes PAREADAS: a run i joga o bot i % B com a semente base + floor(i/B).
// Cada semente e jogada por todos os bots, entao a diferenca entre dois bots
// nao e sorte de semente. O jogo e deterministico; o relatorio sai identico
// para os mesmos argumentos e o mesmo content.js, em qualquer numero de
// workers — por isso dois relatorios se comparam com um diff de texto. O
// tempo de parede fica so na ultima linha.
//
// As runs rodam em paralelo (node:worker_threads, embutido no node: nao e
// dependencia). Cada worker importa o jogo do zero e devolve so numeros.

import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { CONTEUDO } from '../data/content.js';
import { irParaTela, novoEstado, TELAS } from '../src/state.js';
import { atualizar, sairDoResultado } from '../src/main.js';
import { comecarAvaliacao, comecarProxima, comecarTcc, iniciarRun, sairDaColacao } from '../src/run.js';
import { seguirDaLoja } from '../src/shop.js';
import { escolherCarta } from '../src/cards.js';
import { novaInstancia } from '../src/jokers.js';
import { criarRng } from '../src/rng.js';
import { configuracaoDoJogo, ESCOPOS, gerarRelatorio } from '../src/relatorio.js';
import { BOTS, BOTS_PADRAO } from './bots.mjs';

const PASSO = CONTEUDO.loop.passo;
const MARCOS = [15, 30, 60]; // s: o contrato pede o nivel medio nestes segundos
const CONCEITOS = CONTEUDO.nota.faixas.map((f) => f.conceito);
const ORDEM = CONTEUDO.periodos.flatMap((p, pi) => p.avaliacoes.map((av, ai) => ({ id: av.id, p: pi, a: ai })));
const ID_TCC = CONTEUDO.tcc.id;
const IDS = [...ORDEM.map((o) => o.id), ID_TCC];
const N_PERIODOS = CONTEUDO.periodos.length;
const ARMAS = CONTEUDO.armas.map((a) => a.id);
const CORINGAS = CONTEUDO.coringas.map((c) => c.id);
const MODIFICADORES = CONTEUDO.modificadores.map((m) => m.id);
// A semente do smoke: o sim parte da mesma familia por padrao.
const SEMENTE_PADRAO = 20261110;
// Deslocamento das sementes do experimento de coringas, para nao repetir as
// das runs.
const DESLOCAMENTO_MARGINAL = 100000;

// ===================================================================== jogo

function novoRegistro(id, p, a) {
  return {
    id, p, a,
    mods: [], mao: [],
    jubilado: false, timeout: false, tempo: 0,
    nota: 0, conceito: '', pk: 0, ph: 0, pi: 0,
    kills: 0, nasceram: 0, vivos: 0, hp: 0, ileso: false, nivel: 1, danoTomado: 0,
    niveis: MARCOS.map(() => null),
    creditos: 0, gasto: 0, saldo: 0, comprados: [],
    fatal: null, fontes: {}, armas: {}, equipadas: [],
    banca: 0, fase: 0,
  };
}

// Uma avaliacao (ou a defesa) do primeiro tick ate a tela de fim. O bot so
// move com a avaliacao rodando; com a carta aberta, ele escolhe, e o tick
// seguinte resolve a escolha (como o clique no navegador).
function jogarTrecho(estado, bot, mem, reg, tccMax) {
  const av = estado.run.avaliacao;
  let ticks = 0;
  let marco = 0;
  let ultimaFonte = null;
  let somaVivos = 0;
  let ticksVivos = 0;
  while (estado.tela === TELAS.AVALIACAO || estado.tela === TELAS.CARTA) {
    if (estado.tela === TELAS.CARTA) escolherCarta(estado, bot.carta(estado, mem));
    else bot.mover(estado, mem);
    atualizar(estado, PASSO);
    ticks += 1;
    if (estado.tela === TELAS.AVALIACAO) {
      somaVivos += estado.enemies.length;
      ticksVivos += 1;
    }
    for (const ev of estado.eventos) {
      if (ev.tipo === 'arma-acerto') {
        const d = ev.dados;
        const a = reg.armas[d.arma] || (reg.armas[d.arma] = [0, 0, 0]);
        a[0] += d.dano;
        a[1] += d.efetivo;
        if (d.matou) a[2] += 1;
      } else if (ev.tipo === 'inimigo-nasceu') {
        reg.nasceram += 1;
      } else if (ev.tipo === 'jogador-dano') {
        ultimaFonte = ev.dados.fonte;
        reg.fontes[ultimaFonte] = (reg.fontes[ultimaFonte] || 0) + ev.dados.dano;
      }
    }
    estado.eventos.length = 0;
    // 3600 passos de 1/60 somam 59,9999...s: sem a meia folga o marco de 60s
    // nunca valeria numa avaliacao de 60s.
    while (marco < MARCOS.length && av.decorrido >= MARCOS[marco] - PASSO / 2) {
      reg.niveis[marco] = estado.player.nivel;
      marco += 1;
    }
    // Pendencia 76: sem cronometro, a defesa pode nao acabar.
    if (av.banca && av.decorrido > tccMax) {
      reg.timeout = true;
      break;
    }
  }
  if (estado.tela === TELAS.JUBILADO) reg.fatal = ultimaFonte;
  // Inimigos vivos em media: a arena limpa e o que se ve quando o jogador domina.
  reg.vivos = ticksVivos > 0 ? somaVivos / ticksVivos : 0;
  reg.equipadas = estado.player.armas.map((a) => `${a.id}:${a.nivel}`);
  return ticks;
}

function copiarResultado(reg, estado) {
  const r = estado.run.resultado;
  reg.jubilado = !r.aprovado;
  reg.tempo = r.tempo;
  reg.nota = r.nota;
  reg.conceito = r.conceito;
  reg.pk = r.parcelas.kills;
  reg.ph = r.parcelas.hp;
  reg.pi = r.parcelas.ileso;
  reg.kills = r.kills;
  reg.hp = r.hpMax > 0 ? r.hp / r.hpMax : 0; // absoluto: hpFracao virou o HP preservado (pos-entrega)
  reg.ileso = r.ileso;
  reg.nivel = estado.player.nivel;
  reg.danoTomado = r.danoTomado;
  reg.creditos = r.creditos;
  reg.banca = r.bancaFracao;
}

// A run inteira. `estado` vem de fora so no modo --relatorio, que reusa um
// estado para a telemetria juntar as partidas numa sessao.
function jogarRun(job, estado = novoEstado(job.semente)) {
  const bot = BOTS[job.bot];
  const mem = bot.novaMemoria(job.semente);
  const saida = { bot: job.bot, semente: job.semente, avs: [], formou: false, media: 0, conceito: '', ticks: 0 };
  iniciarRun(estado);
  while (estado.tela === TELAS.ANUNCIO) {
    const prox = estado.run.proxima;
    const o = ORDEM.find((x) => x.p === prox.periodoIndex && x.a === prox.avaliacaoIndex);
    const reg = novoRegistro(o.id, o.p, o.a);
    reg.mods = prox.modificadores.slice();
    reg.mao = estado.run.coringas.map((c) => c.id);
    comecarProxima(estado);
    saida.ticks += jogarTrecho(estado, bot, mem, reg, job.tccMax);
    copiarResultado(reg, estado);
    saida.avs.push(reg);
    sairDoResultado(estado);
    if (estado.tela !== TELAS.LOJA) return saida; // jubilado: menu
    const compra = bot.comprar(estado, mem);
    reg.gasto = compra.gasto;
    reg.comprados = compra.comprados;
    reg.saldo = estado.run.creditos;
    seguirDaLoja(estado);
  }
  if (estado.tela !== TELAS.TCC) throw new Error(`run ${job.bot}/${job.semente}: depois da ultima loja a tela e "${estado.tela}"`);

  comecarTcc(estado);
  const reg = novoRegistro(ID_TCC, N_PERIODOS, 0);
  reg.mao = estado.run.coringas.map((c) => c.id);
  saida.ticks += jogarTrecho(estado, bot, mem, reg, job.tccMax);
  const av = estado.run.avaliacao;
  reg.fase = av.banca.fase;
  saida.avs.push(reg);
  if (reg.timeout) {
    reg.tempo = av.decorrido;
    reg.kills = av.kills;
    reg.hp = estado.player.hp / estado.player.hpMax;
    reg.nivel = estado.player.nivel;
    reg.banca = Math.max(0, av.banca.hp) / av.banca.hpMax;
    return saida;
  }
  copiarResultado(reg, estado);
  if (estado.tela === TELAS.COLACAO) {
    saida.formou = true;
    saida.media = estado.run.colacao.media;
    saida.conceito = estado.run.colacao.conceito;
    sairDaColacao(estado);
  } else {
    sairDoResultado(estado);
  }
  return saida;
}

// O experimento de coringas: uma avaliacao do 3º periodo, sem modificador,
// com uma mao de coringas forcada. So a mao muda entre as configuracoes.
function jogarIsolada(job) {
  const estado = novoEstado(job.semente);
  for (const id of job.coringas) estado.run.coringas.push(novaInstancia(id));
  comecarAvaliacao(estado, job.p, job.a, []);
  const bot = BOTS[job.bot];
  const reg = novoRegistro(job.id, job.p, job.a);
  jogarTrecho(estado, bot, bot.novaMemoria(job.semente), reg, job.tccMax);
  copiarResultado(reg, estado);
  let dano = 0;
  let efetivo = 0;
  for (const a of Object.values(reg.armas)) {
    dano += a[0];
    efetivo += a[1];
  }
  return { cfg: job.cfg, jubilado: reg.jubilado, tempo: reg.tempo, nota: reg.nota, kills: reg.kills, hp: reg.hp, dano, efetivo, nivel: reg.nivel, vivos: reg.vivos };
}

function executarJob(job) {
  const t0 = Date.now();
  const r = job.tipo === 'run' ? jogarRun(job) : jogarIsolada(job);
  r.ms = Date.now() - t0;
  return r;
}

// ================================================================ workers

function trabalhador() {
  // A telemetria so observa (o smoke prova: ligada ou desligada, a partida e
  // a mesma). Desligada, cada tick sai mais barato.
  CONTEUDO.debug.relatorio = false;
  parentPort.on('message', ({ i, job }) => {
    try {
      parentPort.postMessage({ i, r: executarJob(job) });
    } catch (e) {
      parentPort.postMessage({ i, erro: e && e.stack ? e.stack : String(e) });
    }
  });
}

function executarTodos(jobs, nWorkers) {
  if (jobs.length === 0) return Promise.resolve([]);
  if (nWorkers <= 1) {
    CONTEUDO.debug.relatorio = false;
    return Promise.resolve(jobs.map(executarJob));
  }
  return new Promise((resolve, reject) => {
    const resultados = new Array(jobs.length);
    let proximo = 0;
    let feitos = 0;
    const workers = [];
    const encerrar = () => {
      for (const w of workers) w.terminate();
    };
    const despachar = (w) => {
      if (proximo >= jobs.length) return;
      w.postMessage({ i: proximo, job: jobs[proximo] });
      proximo += 1;
    };
    for (let k = 0; k < Math.min(nWorkers, jobs.length); k += 1) {
      const w = new Worker(new URL(import.meta.url));
      workers.push(w);
      w.on('message', ({ i, r, erro }) => {
        if (erro) {
          encerrar();
          reject(new Error(`job ${i} (${JSON.stringify(jobs[i])}): ${erro}`));
          return;
        }
        resultados[i] = r;
        feitos += 1;
        if (feitos === jobs.length) {
          encerrar();
          resolve(resultados);
        } else {
          despachar(w);
        }
      });
      w.on('error', (e) => {
        encerrar();
        reject(e);
      });
      despachar(w);
    }
  });
}

// ============================================================ argumentos

function lerArgs(argv) {
  const cfg = {
    runs: 100,
    semente: SEMENTE_PADRAO,
    bots: BOTS_PADRAO.slice(),
    marginal: 6, // sementes por configuracao de mao (14 configuracoes)
    // O desvio e o mais perto de um humano mediano. O passivo e o agressivo
    // dominam o 3º periodo mesmo sem coringa (handoff 13), e ai a mao nao
    // muda nada que se veja.
    marginalBot: 'desvio',
    workers: Math.max(1, availableParallelism() - 1),
    tccMax: 300, // s de defesa antes de contar como luta que nao acaba (pendencia 76)
    detalhe: 0, // 1 = uma linha por run no fim (nota, conceito e kills de cada avaliacao)
    salvar: null,
    comparar: null,
    relatorio: null,
  };
  const inteiros = { runs: 'runs', semente: 'semente', marginal: 'marginal', workers: 'workers', 'tcc-max': 'tccMax', detalhe: 'detalhe' };
  const textos = { salvar: 'salvar', comparar: 'comparar', relatorio: 'relatorio', 'marginal-bot': 'marginalBot' };
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!m) throw new Error(`argumento "${arg}" nao reconhecido (use --nome=valor)`);
    const [, nome, valor] = m;
    if (nome in inteiros) {
      const n = Number(valor);
      if (!Number.isInteger(n) || n < 0) throw new Error(`--${nome} precisa de um inteiro >= 0, veio "${valor}"`);
      cfg[inteiros[nome]] = n;
    } else if (nome in textos) {
      cfg[textos[nome]] = valor;
    } else if (nome === 'bots') {
      cfg.bots = valor.split(',').map((b) => b.trim()).filter((b) => b !== '');
    } else {
      throw new Error(`opcao --${nome} nao existe`);
    }
  }
  for (const b of [...cfg.bots, cfg.marginalBot]) {
    if (!BOTS[b]) throw new Error(`bot "${b}" nao existe (ha: ${Object.keys(BOTS).join(', ')})`);
  }
  if (cfg.bots.length === 0) throw new Error('--bots ficou vazio');
  cfg.workers = Math.max(1, cfg.workers);
  return cfg;
}

// ================================================================== jobs

// As 14 maos do experimento: nenhuma, cada uma sozinha, todas, e todas menos
// uma (cada uma destas e uma mao de 5, o teto da loja).
function maosDoExperimento() {
  const maos = [{ nome: 'nenhum', coringas: [] }];
  for (const id of CORINGAS) maos.push({ nome: `so ${id}`, coringas: [id], so: id });
  maos.push({ nome: 'todos', coringas: CORINGAS.slice() });
  for (const id of CORINGAS) maos.push({ nome: `todos - ${id}`, coringas: CORINGAS.filter((c) => c !== id), sem: id });
  return maos;
}

function montarJobs(cfg) {
  const jobs = [];
  const B = cfg.bots.length;
  for (let i = 0; i < cfg.runs; i += 1) {
    jobs.push({ tipo: 'run', bot: cfg.bots[i % B], semente: cfg.semente + Math.floor(i / B), tccMax: cfg.tccMax });
  }
  const p3 = ORDEM.filter((o) => o.p === N_PERIODOS - 1);
  const maos = maosDoExperimento();
  if (cfg.marginal > 0) {
    maos.forEach((mao, c) => {
      for (let k = 0; k < cfg.marginal; k += 1) {
        const o = p3[k % p3.length];
        jobs.push({
          tipo: 'marginal', cfg: c, bot: cfg.marginalBot, coringas: mao.coringas,
          semente: cfg.semente + DESLOCAMENTO_MARGINAL + k, id: o.id, p: o.p, a: o.a, tccMax: cfg.tccMax,
        });
      }
    });
  }
  return { jobs, maos };
}

// ============================================================= estatistica

const media = (xs) => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
function mediana(xs) {
  if (xs.length === 0) return NaN;
  const o = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
}
const fx = (v, casas = 1) => (Number.isFinite(v) ? v.toFixed(casas) : '-');
const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '-');
const col = (t, n) => String(t).padEnd(n);
const dir = (t, n) => String(t).padStart(n);

// O periodo de um registro: 0..N-1, e N para o TCC.
const nomePeriodo = (p) => (p >= N_PERIODOS ? 'TCC' : `P${p + 1}`);

// ============================================================== relatorio

function gerarTexto(cfg, runs, maos, marginais, metricas) {
  const L = [];
  const grupos = [...cfg.bots, 'todos'];
  const porBot = (b) => (b === 'todos' ? runs : runs.filter((r) => r.bot === b));
  const regs = (rs, id) => rs.flatMap((r) => r.avs.filter((a) => a.id === id));
  const W = 20; // largura de cada coluna de bot

  const config = configuracaoDoJogo();
  const contagem = cfg.bots.map((b) => `${b} ${porBot(b).length}`).join(', ');
  const ultimaSemente = cfg.semente + Math.max(0, Math.ceil(cfg.runs / cfg.bots.length) - 1);
  L.push(`== sim · Semana de Provas · configuracao ${config.hash} ==`);
  L.push(`runs ${cfg.runs} (${contagem}) · sementes ${cfg.semente}..${ultimaSemente}, pareadas entre os bots · teto da defesa ${cfg.tccMax}s`);
  for (const b of cfg.bots) L.push(`  ${col(b, 10)} ${BOTS[b].descricao}`);
  L.push('');

  // ---------------------------------------------------------------- 1
  L.push('1. ONDE O JOGO MATA — jubilados / chegaram (taxa)');
  L.push(`${col('avaliacao', 12)}${grupos.map((g) => col(g, W)).join('')}`);
  const linhaJub = (rotulo, fn) => L.push(`${col(rotulo, 12)}${grupos.map((g) => col(fn(porBot(g), g), W)).join('')}`);
  for (const id of IDS) {
    linhaJub(id, (rs, g) => {
      const rr = regs(rs, id);
      const j = rr.filter((a) => a.jubilado).length;
      const t = id === ID_TCC ? rr.filter((a) => a.timeout).length : 0;
      metricas[`jubilacao.${id}.${g}`] = rr.length > 0 ? j / rr.length : null;
      return `${j}/${rr.length} ${pct(rr.length > 0 ? j / rr.length : NaN)}${t > 0 ? ` +${t}to` : ''}`;
    });
  }
  L.push('por periodo (jubilados no periodo / entraram nele):');
  for (let p = 0; p <= N_PERIODOS; p += 1) {
    linhaJub(nomePeriodo(p), (rs, g) => {
      const entraram = rs.filter((r) => r.avs.some((a) => a.p === p));
      const j = entraram.filter((r) => r.avs.some((a) => a.p === p && a.jubilado)).length;
      const taxa = entraram.length > 0 ? j / entraram.length : NaN;
      metricas[`jubilacao.${nomePeriodo(p)}.${g}`] = Number.isFinite(taxa) ? taxa : null;
      return `${j}/${entraram.length} ${pct(taxa)}`;
    });
  }
  linhaJub('formaram', (rs, g) => {
    const f = rs.filter((r) => r.formou).length;
    metricas[`formaram.${g}`] = rs.length > 0 ? f / rs.length : null;
    return `${f}/${rs.length} ${pct(rs.length > 0 ? f / rs.length : NaN)}`;
  });
  // O risco "primeiros 15s indefesos" (design §15) medido pela morte.
  linhaJub(`jub. <${MARCOS[0]}s`, (rs, g) => {
    const avs = rs.flatMap((r) => r.avs);
    const cedo = avs.filter((a) => a.jubilado && a.tempo < MARCOS[0]).length;
    const jub = avs.filter((a) => a.jubilado).length;
    metricas[`jubilacaoCedo.${g}`] = cedo;
    return `${cedo} de ${jub}`;
  });
  L.push('("to" = defesa que passou do teto sem ninguem cair; conta como nao formado, nao como jubilado)');
  L.push('');

  // ---------------------------------------------------------------- 2
  L.push(`2. NIVEL MEDIO aos ${MARCOS.join('s / ')}s (so quem estava vivo naquele segundo)`);
  L.push(`${col('avaliacao', 12)}${grupos.map((g) => col(g, W)).join('')}`);
  for (const id of IDS) {
    const cel = grupos.map((g) => {
      const rr = regs(porBot(g), id);
      const vs = MARCOS.map((_, k) => media(rr.map((a) => a.niveis[k]).filter((v) => v !== null)));
      vs.forEach((v, k) => {
        metricas[`nivel${MARCOS[k]}.${id}.${g}`] = Number.isFinite(v) ? v : null;
      });
      return col(vs.map((v) => dir(fx(v), 4)).join(' '), W);
    });
    L.push(`${col(id, 12)}${cel.join('')}`);
  }
  const n15 = grupos.map((g) => {
    const v = media(porBot(g).flatMap((r) => r.avs).map((a) => a.niveis[0]).filter((x) => x !== null));
    metricas[`nivel15.media.${g}`] = Number.isFinite(v) ? v : null;
    return col(fx(v, 2), W);
  });
  L.push(`${col('media 15s', 12)}${n15.join('')}`);
  L.push('');

  // ---------------------------------------------------------------- 3
  L.push('3. NOTA E CONCEITO (avaliacoes com nota: aprovadas pelo cronometro)');
  L.push(`${col('bot', 12)}${dir('nota', 6)}${dir('kills', 7)}${dir('HP', 6)}${dir('p.kill', 8)}${dir('p.HP', 7)}${dir('ileso', 7)}   ${CONCEITOS.map((c) => dir(c, 5)).join('')}   ${dir('mortos/nascidos', 16)}${dir('vivos', 7)}`);
  for (const g of grupos) {
    const rr = porBot(g).flatMap((r) => r.avs).filter((a) => a.id !== ID_TCC && !a.jubilado);
    const nota = media(rr.map((a) => a.nota));
    metricas[`nota.media.${g}`] = Number.isFinite(nota) ? nota : null;
    // Quanto do que nasceu morreu: perto de 100%, matar mais nao depende de cacar.
    const razao = rr.reduce((s, a) => s + a.kills, 0) / Math.max(1, rr.reduce((s, a) => s + a.nasceram, 0));
    const ouNull = (v) => (rr.length > 0 && Number.isFinite(v) ? v : null);
    metricas[`mortosPorNascido.${g}`] = ouNull(razao);
    metricas[`hp.media.${g}`] = ouNull(media(rr.map((a) => a.hp)));
    metricas[`kills.media.${g}`] = ouNull(media(rr.map((a) => a.kills)));
    const dist = CONCEITOS.map((c) => {
      const f = rr.length > 0 ? rr.filter((a) => a.conceito === c).length / rr.length : NaN;
      metricas[`conceito.${c}.${g}`] = Number.isFinite(f) ? f : null;
      return dir(pct(f), 5);
    });
    L.push(
      `${col(g, 12)}${dir(fx(nota), 6)}${dir(fx(media(rr.map((a) => a.kills)), 0), 7)}${dir(pct(media(rr.map((a) => a.hp))), 6)}` +
        `${dir(fx(media(rr.map((a) => a.pk)), 2), 8)}${dir(fx(media(rr.map((a) => a.ph)), 2), 7)}${dir(pct(media(rr.map((a) => (a.ileso ? 1 : 0)))), 7)}` +
        `   ${dist.join('')}   ${dir(pct(razao), 16)}${dir(fx(media(rr.map((a) => a.vivos))), 7)}`
    );
  }
  L.push('por avaliacao: nota media, HP medio e conceitos (A/B/C/D/F)');
  L.push(`${col('avaliacao', 12)}${cfg.bots.map((g) => col(g, 30)).join('')}`);
  for (const id of IDS.filter((i) => i !== ID_TCC)) {
    const cel = cfg.bots.map((g) => {
      const rr = regs(porBot(g), id).filter((a) => !a.jubilado);
      const nota = media(rr.map((a) => a.nota));
      metricas[`nota.${id}.${g}`] = Number.isFinite(nota) ? nota : null;
      const dist = CONCEITOS.map((c) => rr.filter((a) => a.conceito === c).length).join('/');
      return col(`${dir(fx(nota), 4)} ${dir(pct(media(rr.map((a) => a.hp))), 4)} ${dist}`, 30);
    });
    L.push(`${col(id, 12)}${cel.join('')}`);
  }
  L.push('');

  // ---------------------------------------------------------------- 4
  L.push('4. ECONOMIA POR PERIODO (medias das runs que fecharam a loja do periodo)');
  L.push(`${col('bot', 12)}${col('periodo', 8)}${dir('ganhou', 7)}${dir('gastou', 7)}${dir('saldo', 7)}${dir('na mao', 8)}   compras no periodo (vezes)`);
  for (const g of grupos) {
    for (let p = 0; p < N_PERIODOS; p += 1) {
      const ultima = ORDEM.filter((o) => o.p === p).pop().id;
      const fecharam = porBot(g).filter((r) => r.avs.some((a) => a.id === ultima && !a.jubilado));
      const doPeriodo = fecharam.map((r) => r.avs.filter((a) => a.p === p));
      const ganhou = media(doPeriodo.map((as) => as.reduce((s, a) => s + a.creditos, 0)));
      const gastou = media(doPeriodo.map((as) => as.reduce((s, a) => s + a.gasto, 0)));
      const saldo = media(doPeriodo.map((as) => as[as.length - 1].saldo));
      const naMao = media(fecharam.map((r) => {
        const fim = r.avs.find((a) => a.id === ultima);
        return fim.mao.length + fim.comprados.length;
      }));
      metricas[`creditos.saldo.${nomePeriodo(p)}.${g}`] = Number.isFinite(saldo) ? saldo : null;
      metricas[`coringas.naMao.${nomePeriodo(p)}.${g}`] = Number.isFinite(naMao) ? naMao : null;
      const compras = {};
      for (const as of doPeriodo) for (const a of as) for (const id of a.comprados) compras[id] = (compras[id] || 0) + 1;
      const textoCompras = CORINGAS.filter((id) => compras[id]).map((id) => `${id} ${compras[id]}`).join(', ') || '-';
      L.push(
        `${col(p === 0 ? g : '', 12)}${col(`${nomePeriodo(p)} n=${fecharam.length}`, 8)}${dir(fx(ganhou, 0), 7)}${dir(fx(gastou, 0), 7)}` +
          `${dir(fx(saldo, 0), 7)}${dir(fx(naMao), 8)}   ${textoCompras}`
      );
    }
  }
  L.push('');

  // ---------------------------------------------------------------- 5
  L.push('5. A BANCA (defesa do TCC)');
  L.push(`${col('bot', 12)}${dir('chegaram', 9)}${dir('venceu', 8)}${dir('jubil.', 8)}${dir('teto', 6)}${dir('t.vitoria', 11)}${dir('Banca ao cair', 15)}${dir('fase 2', 8)}${dir('nivel', 7)}${dir('mao', 5)}   media geral · conceito geral`);
  for (const g of grupos) {
    const rr = regs(porBot(g), ID_TCC);
    const venceu = rr.filter((a) => !a.jubilado && !a.timeout);
    const jub = rr.filter((a) => a.jubilado);
    const taxa = rr.length > 0 ? venceu.length / rr.length : NaN;
    metricas[`banca.vitoria.${g}`] = Number.isFinite(taxa) ? taxa : null;
    metricas[`banca.tempo.${g}`] = venceu.length > 0 ? mediana(venceu.map((a) => a.tempo)) : null;
    const formados = porBot(g).filter((r) => r.formou);
    const geral = CONCEITOS.map((c) => formados.filter((r) => r.conceito === c).length).join('/');
    L.push(
      `${col(g, 12)}${dir(rr.length, 9)}${dir(`${venceu.length} ${pct(taxa)}`, 8)}${dir(jub.length, 8)}${dir(rr.filter((a) => a.timeout).length, 6)}` +
        `${dir(venceu.length > 0 ? `${fx(mediana(venceu.map((a) => a.tempo)), 0)}s med` : '-', 11)}` +
        `${dir(jub.length > 0 ? pct(media(jub.map((a) => a.banca))) : '-', 15)}${dir(pct(rr.length > 0 ? rr.filter((a) => a.fase > 0).length / rr.length : NaN), 8)}` +
        `${dir(fx(media(rr.map((a) => a.nivel))), 7)}${dir(fx(media(rr.map((a) => a.mao.length))), 5)}` +
        `   ${fx(media(formados.map((r) => r.media)))} · ${geral}`
    );
  }
  L.push('(t.vitoria: mediana; "Banca ao cair": HP medio dela quando o jogador caiu; conceito geral A/B/C/D/F dos formados)');
  // Parte 2: o que tira HP do jogador na defesa. Sem isto nao da para saber
  // se quem cai cai por contato (que um humano evita) ou por pergunta.
  const fontesTcc = [...new Set(runs.flatMap((r) => r.avs.filter((a) => a.id === ID_TCC).flatMap((a) => Object.keys(a.fontes))))].sort();
  L.push('dano que o jogador tomou na defesa, por fonte (media por luta, vencida ou nao) · total · por minuto de luta:');
  L.push(`${col('bot', 12)}${fontesTcc.map((f) => dir(f, 14)).join('')}${dir('total', 8)}${dir('/min', 7)}${dir('luta', 8)}`);
  for (const g of grupos) {
    const rr = regs(porBot(g), ID_TCC);
    if (rr.length === 0) continue;
    const tot = rr.map((a) => Object.values(a.fontes).reduce((s, v) => s + v, 0));
    const minutos = rr.reduce((s, a) => s + a.tempo, 0) / 60;
    const porMin = minutos > 0 ? tot.reduce((s, v) => s + v, 0) / minutos : NaN;
    metricas[`banca.danoPorMin.${g}`] = Number.isFinite(porMin) ? porMin : null;
    L.push(
      `${col(g, 12)}${fontesTcc.map((f) => dir(fx(media(rr.map((a) => a.fontes[f] || 0)), 0), 14)).join('')}` +
        `${dir(fx(media(tot), 0), 8)}${dir(fx(porMin, 1), 7)}${dir(`${fx(mediana(rr.map((a) => a.tempo)), 0)}s`, 8)}`
    );
  }
  L.push('');

  // ---------------------------------------------------------------- 6
  L.push('6. DANO POR ARMA (todos os bots da corrida) — % do dano efetivo do periodo · efetivo medio por avaliacao em que estava equipada · % das avaliacoes equipada');
  const todasAvs = runs.flatMap((r) => r.avs);
  L.push(`${col('arma', 12)}${Array.from({ length: N_PERIODOS + 1 }, (_, p) => col(nomePeriodo(p), 24)).join('')}`);
  for (const arma of ARMAS) {
    const cel = [];
    for (let p = 0; p <= N_PERIODOS; p += 1) {
      const doP = todasAvs.filter((a) => a.p === p);
      const total = doP.reduce((s, a) => s + Object.values(a.armas).reduce((t, v) => t + v[1], 0), 0);
      const daArma = doP.reduce((s, a) => s + (a.armas[arma] ? a.armas[arma][1] : 0), 0);
      const equipada = doP.filter((a) => a.equipadas.some((e) => e.startsWith(`${arma}:`)));
      const porAv = media(equipada.map((a) => (a.armas[arma] ? a.armas[arma][1] : 0)));
      metricas[`arma.participacao.${arma}.${nomePeriodo(p)}`] = total > 0 ? daArma / total : null;
      cel.push(col(`${dir(pct(total > 0 ? daArma / total : NaN), 4)} ${dir(fx(porAv, 0), 6)} ${dir(pct(doP.length > 0 ? equipada.length / doP.length : NaN), 4)}`, 24));
    }
    L.push(`${col(arma, 12)}${cel.join('')}`);
  }
  L.push('');

  // ---------------------------------------------------------------- 7
  L.push('7. MODIFICADORES (todas as avaliacoes que sortearam o modificador, todos os bots da corrida)');
  L.push(`${col('modificador', 18)}${dir('n', 5)}${dir('jubil.', 8)}${dir('nota', 6)}${dir('HP', 6)}${dir('kills', 7)}`);
  const comMod = todasAvs.filter((a) => a.id !== ID_TCC && a.mods.length > 0);
  const linhaMod = (rotulo, rr) => {
    const aprov = rr.filter((a) => !a.jubilado);
    L.push(
      `${col(rotulo, 18)}${dir(rr.length, 5)}${dir(pct(rr.length > 0 ? rr.filter((a) => a.jubilado).length / rr.length : NaN), 8)}` +
        `${dir(fx(media(aprov.map((a) => a.nota))), 6)}${dir(pct(media(aprov.map((a) => a.hp))), 6)}${dir(fx(media(aprov.map((a) => a.kills)), 0), 7)}`
    );
  };
  for (const id of MODIFICADORES) linhaMod(id, comMod.filter((a) => a.mods.includes(id)));
  linhaMod('(qualquer um)', comMod);
  L.push('');

  // ---------------------------------------------------------------- 8
  L.push('8. QUEM DA O GOLPE FATAL (jubilados, todos os bots da corrida)');
  const fatais = todasAvs.filter((a) => a.jubilado);
  const fontes = [...new Set(fatais.map((a) => a.fatal || '?'))].sort();
  L.push(`${col('fonte', 18)}${Array.from({ length: N_PERIODOS + 1 }, (_, p) => dir(nomePeriodo(p), 6)).join('')}`);
  for (const f of fontes) {
    L.push(`${col(f, 18)}${Array.from({ length: N_PERIODOS + 1 }, (_, p) => dir(fatais.filter((a) => a.p === p && (a.fatal || '?') === f).length, 6)).join('')}`);
  }
  if (fontes.length === 0) L.push('(ninguem foi jubilado)');
  L.push('');

  // ---------------------------------------------------------------- 9
  if (marginais.length > 0) {
    L.push(`9. CORINGAS — experimento controlado: bot ${cfg.marginalBot}, avaliacoes do ${N_PERIODOS}º periodo sem modificador, ${cfg.marginal} sementes por mao`);
    L.push('(nota: so aprovados; HP, kills, nivel e vivos: todos; dano/s e efet/s: dano nominal e o que tirou de HP, por segundo vivo)');
    L.push(`${col('mao', 22)}${dir('jubil.', 8)}${dir('nota', 6)}${dir('kills', 7)}${dir('HP', 6)}${dir('nivel', 7)}${dir('dano/s', 9)}${dir('efet/s', 9)}${dir('vivos', 7)}`);
    const resumo = maos.map((mao, c) => {
      const rr = marginais.filter((m) => m.cfg === c);
      const aprov = rr.filter((m) => !m.jubilado);
      const s = {
        jub: rr.length > 0 ? rr.filter((m) => m.jubilado).length / rr.length : NaN,
        nota: media(aprov.map((m) => m.nota)),
        kills: media(rr.map((m) => m.kills)),
        hp: media(rr.map((m) => m.hp)),
        nivel: media(rr.map((m) => m.nivel)),
        danoS: media(rr.map((m) => m.dano / Math.max(1, m.tempo))),
        efetS: media(rr.map((m) => m.efetivo / Math.max(1, m.tempo))),
        vivos: media(rr.map((m) => m.vivos)),
      };
      L.push(
        `${col(mao.nome, 22)}${dir(pct(s.jub), 8)}${dir(fx(s.nota), 6)}${dir(fx(s.kills, 0), 7)}${dir(pct(s.hp), 6)}${dir(fx(s.nivel), 7)}` +
          `${dir(fx(s.danoS, 0), 9)}${dir(fx(s.efetS, 0), 9)}${dir(fx(s.vivos), 7)}`
      );
      const chave = mao.nome.replace(/ - /g, '-sem-').replace(/ /g, '-');
      metricas[`marginal.${chave}.danoS`] = Number.isFinite(s.danoS) ? s.danoS : null;
      metricas[`marginal.${chave}.jub`] = Number.isFinite(s.jub) ? s.jub : null;
      metricas[`marginal.${chave}.vivos`] = Number.isFinite(s.vivos) ? s.vivos : null;
      metricas[`marginal.${chave}.hp`] = Number.isFinite(s.hp) ? s.hp : null;
      return s;
    });
    const nenhum = resumo[0];
    const todos = resumo[maos.findIndex((m) => m.nome === 'todos')];
    L.push('valor de cada coringa — sozinho (so X - nenhum) e marginal na mao cheia (todos - (todos sem X)):');
    L.push(`${col('coringa', 12)}${dir('Δdano/s so', 12)}${dir('Δdano/s marg', 14)}${dir('Δkills marg', 13)}${dir('ΔHP marg', 10)}${dir('Δjub marg', 11)}${dir('Δvivos marg', 13)}`);
    for (const id of CORINGAS) {
      const so = resumo[maos.findIndex((m) => m.so === id)];
      const sem = resumo[maos.findIndex((m) => m.sem === id)];
      const sinal = (v, casas = 0) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(casas)}` : '-');
      L.push(
        `${col(id, 12)}${dir(sinal(so.danoS - nenhum.danoS), 12)}${dir(sinal(todos.danoS - sem.danoS), 14)}${dir(sinal(todos.kills - sem.kills), 13)}` +
          `${dir(sinal((todos.hp - sem.hp) * 100), 10)}${dir(sinal((todos.jub - sem.jub) * 100), 11)}${dir(sinal(todos.vivos - sem.vivos, 1), 13)}`
      );
    }
    const maosDe5 = maos.map((m, c) => (m.sem ? resumo[c] : null)).filter(Boolean);
    const danoCom5 = media(maosDe5.map((s) => s.danoS));
    metricas['coringas.razaoDano5'] = Number.isFinite(danoCom5 / nenhum.danoS) ? danoCom5 / nenhum.danoS : null;
    L.push(`mao de 5 (media das 6 "todos - X") contra nenhum: dano/s x${fx(danoCom5 / nenhum.danoS, 2)}, kills ${fx(media(maosDe5.map((s) => s.kills)), 0)} vs ${fx(nenhum.kills, 0)}, ` +
      `HP ${pct(media(maosDe5.map((s) => s.hp)))} vs ${pct(nenhum.hp)}, jubilados ${pct(media(maosDe5.map((s) => s.jub)))} vs ${pct(nenhum.jub)}, ` +
      `inimigos vivos ${fx(media(maosDe5.map((s) => s.vivos)))} vs ${fx(nenhum.vivos)}`);
    metricas['coringas.vivos5'] = media(maosDe5.map((s) => s.vivos));
    metricas['coringas.vivos0'] = nenhum.vivos;
    L.push('');
  }

  // --------------------------------------------------------------- 10
  L.push('10. LEITURA DOS RISCOS DO CONTRATO (numeros acima, resumidos)');
  const m = metricas;
  const b1 = cfg.bots.includes('passivo') ? 'passivo' : cfg.bots[0];
  const b2 = cfg.bots.includes('agressivo') ? 'agressivo' : cfg.bots[cfg.bots.length - 1];
  const porGrupo = (chave, f) => grupos.map((g) => `${g} ${f(m[chave(g)])}`).join(' · ');
  if (m['coringas.razaoDano5'] !== undefined && m['coringas.razaoDano5'] !== null) {
    L.push(
      `- coringas (${cfg.marginalBot}, secao 9): mao de 5 no ${N_PERIODOS}º periodo = dano/s x${fx(m['coringas.razaoDano5'], 2)} o de sem nenhum; ` +
        `inimigos vivos ${fx(m['coringas.vivos5'])} vs ${fx(m['coringas.vivos0'])}`
    );
  }
  L.push(`- primeiros 15s: nivel medio aos 15s = ${porGrupo((g) => `nivel15.media.${g}`, (v) => fx(v, 2))}`);
  L.push(
    `- pesoKill x pesoHp: nota media ${b1} ${fx(m[`nota.media.${b1}`], 2)} x ${b2} ${fx(m[`nota.media.${b2}`], 2)} ` +
      `(diferenca ${fx((m[`nota.media.${b2}`] ?? NaN) - (m[`nota.media.${b1}`] ?? NaN), 2)}); ` +
      `mortos/nascidos = ${porGrupo((g) => `mortosPorNascido.${g}`, pct)}`
  );
  // A nota satura quando so os kills ja passam do teto (pendencias 39 e 62):
  // dali em diante HP nao muda nada, e o conceito sai A para quem sobreviveu.
  const depoisDaSegunda = new Set(ORDEM.slice(2).map((o) => o.id));
  const sat = grupos.map((g) => {
    const rr = porBot(g).flatMap((r) => r.avs).filter((a) => depoisDaSegunda.has(a.id) && !a.jubilado);
    const fa = rr.length > 0 ? rr.filter((a) => a.conceito === CONCEITOS[0]).length / rr.length : NaN;
    const fk = rr.length > 0 ? rr.filter((a) => a.kills * CONTEUDO.nota.pesoKill >= CONTEUDO.nota.maxima).length / rr.length : NaN;
    metricas[`saturacao.A.${g}`] = Number.isFinite(fa) ? fa : null;
    metricas[`saturacao.kills.${g}`] = Number.isFinite(fk) ? fk : null;
    return `${g} ${pct(fa)}/${pct(fk)}`;
  });
  L.push(`- nota da ${ORDEM[2].id} em diante (aprovados): conceito ${CONCEITOS[0]} / so os kills ja dao ${CONTEUDO.nota.maxima} = ${sat.join(' · ')}`);
  for (const g of grupos) {
    L.push(`- curva (${g}): jubilacao por periodo = ${Array.from({ length: N_PERIODOS + 1 }, (_, p) => `${nomePeriodo(p)} ${pct(m[`jubilacao.${nomePeriodo(p)}.${g}`])}`).join(' · ')}`);
  }
  L.push(`- A Banca: vitoria (de quem chegou) = ${porGrupo((g) => `banca.vitoria.${g}`, pct)}`);
  L.push(`- formados: ${porGrupo((g) => `formaram.${g}`, pct)}`);

  if (cfg.detalhe > 0) {
    L.push('');
    L.push('RUNS (nota+conceito/kills por avaliacao; JUB = jubilado aos Xs; TCC: ok/JUB/teto com o tempo da luta)');
    for (const r of runs) {
      const avs = r.avs.map((a) => {
        if (a.id === ID_TCC) return `TCC ${a.timeout ? 'teto' : a.jubilado ? 'JUB' : 'ok'} ${fx(a.tempo, 0)}s`;
        return a.jubilado ? `JUB${fx(a.tempo, 0)}s/${a.kills}` : `${fx(a.nota)}${a.conceito}/${a.kills}`;
      });
      L.push(`${col(r.bot, 10)} ${r.semente}  ${avs.join(' ')}${r.formou ? `  -> ${fx(r.media)} ${r.conceito}` : ''}`);
    }
  }
  return L;
}

// ======================================================== antes / depois

// As metricas de --salvar, lidas de volta por --comparar: uma linha por
// chave, antes, depois e a diferenca. So as chaves que mudaram aparecem (e as
// que existem so de um lado). Sem --detalhe, so o painel: as metricas dos
// riscos do contrato. Com --detalhe=1, todas (nivel e nota por avaliacao...).
const PAINEL = [
  /^jubilacao\.(P\d|TCC)\./, /^formaram\./, /^nota\.media\./, /^hp\.media\./, /^kills\.media\./,
  /^mortosPorNascido\./, /^conceito\.A\./, /^nivel15\.media\./, /^jubilacaoCedo\./, /^banca\./, /^coringas\./,
  // Parte 2: os riscos 3, 4 e 5 da fase (economia, armas, nota saturada).
  /^creditos\.saldo\./, /^arma\.participacao\./, /^saturacao\./,
];

// O que define a AMOSTRA de uma corrida. Duas corridas com valores diferentes
// aqui medem coisas diferentes, e o painel compararia ruido com efeito.
const AMOSTRA = [
  ['runs', (c) => c.runs],
  ['semente', (c) => c.semente],
  ['bots', (c) => c.bots.join(',')],
  ['marginal', (c) => c.marginal],
  ['marginal-bot', (c) => c.marginalBot],
  ['tcc-max', (c) => c.tccMax],
];

// As diferencas de amostra entre a corrida salva e a de agora, como texto
// ("runs 100 x 40"). Vazio quando batem.
function diferencasDeAmostra(antes, cfg) {
  let salvo;
  try {
    salvo = lerArgs((antes.args || []).filter((a) => !/^--(salvar|comparar|relatorio|detalhe|workers)=/.test(a)));
  } catch (e) {
    return [`nao deu para ler os argumentos salvos (${e.message})`];
  }
  return AMOSTRA.filter(([, ler]) => ler(salvo) !== ler(cfg)).map(([nome, ler]) => `${nome} ${ler(salvo)} x ${ler(cfg)}`);
}

function compararCom(arquivo, metricas, tudo, cfg) {
  const antes = JSON.parse(readFileSync(arquivo, 'utf8'));
  const L = [`== antes (${arquivo}, configuracao ${antes.configuracao}) x agora ==`];
  const diferencas = diferencasDeAmostra(antes, cfg);
  if (diferencas.length > 0) {
    L.push(
      `!! AVISO: as duas corridas NAO sao a mesma amostra (${diferencas.join('; ')}).`,
      '!! A diferenca abaixo mistura o efeito do content.js com a troca de sementes/bots: rode com os mesmos argumentos.'
    );
  }
  const chaves = [...new Set([...Object.keys(antes.metricas), ...Object.keys(metricas)])]
    .filter((k) => tudo || PAINEL.some((re) => re.test(k)))
    .sort();
  const larg = Math.max(...chaves.map((k) => k.length));
  let iguais = 0;
  for (const k of chaves) {
    const a = antes.metricas[k];
    const d = metricas[k];
    const num = (v) => (v === null || v === undefined ? '-' : Math.abs(v) < 1 && v !== 0 ? v.toFixed(3) : v.toFixed(2));
    const nenhum = (v) => v === null || v === undefined;
    if ((nenhum(a) && nenhum(d)) || (typeof a === 'number' && typeof d === 'number' && Math.abs(a - d) < 1e-9)) {
      iguais += 1;
      continue;
    }
    const delta = typeof a === 'number' && typeof d === 'number' ? `${d - a >= 0 ? '+' : ''}${(d - a).toFixed(3)}` : '';
    L.push(`${col(k, larg)}  ${dir(num(a), 8)} -> ${dir(num(d), 8)}  ${delta}`);
  }
  L.push(`(${iguais} metricas iguais omitidas${tudo ? '' : '; --detalhe=1 compara todas'})`);
  return L;
}

// ===================================================== relatorio de sessao

// Pendencia 51: o mesmo relatorio que os humanos exportam, com o mesmo hash
// de configuracao. A telemetria guarda ate relatorio.historicoPartidas
// partidas; aqui um estado so joga essa quantidade de runs do primeiro bot,
// em serie e com a telemetria ligada, cada run com a semente dela.
function relatorioDeSessao(cfg) {
  const original = CONTEUDO.debug.relatorio;
  CONTEUDO.debug.relatorio = true;
  try {
    const bot = cfg.bots[0];
    const n = Math.min(CONTEUDO.relatorio.historicoPartidas, Math.ceil(cfg.runs / cfg.bots.length));
    const estado = novoEstado(cfg.semente);
    // O estado e reaproveitado (a telemetria mora nele), entao a ordem dos
    // objetos nas pools difere da do lote: as partidas daqui sao do mesmo bot
    // e das mesmas sementes, mas nao ha garantia de sairem identicas as do lote.
    for (let k = 0; k < n; k += 1) {
      estado.rng = criarRng(cfg.semente + k);
      jogarRun({ tipo: 'run', bot, semente: cfg.semente + k, tccMax: cfg.tccMax }, estado);
      // A defesa que bateu no teto fica aberta: sai pelo menu, como quem
      // desiste pela pausa. Um tick no menu fecha a partida na telemetria.
      if (estado.tela !== TELAS.MENU) irParaTela(estado, TELAS.MENU);
      atualizar(estado, PASSO);
    }
    const rel = gerarRelatorio(estado, ESCOPOS.SESSAO);
    if (!rel) throw new Error('a telemetria nao gravou nenhuma partida');
    writeFileSync(cfg.relatorio, rel.texto);
    return `${cfg.relatorio}: ${n} runs do bot ${bot} (semente ${cfg.semente}..${cfg.semente + n - 1}), ${(rel.texto.length / 1024).toFixed(0)}KB`;
  } finally {
    CONTEUDO.debug.relatorio = original;
  }
}

// ================================================================= principal

async function principal() {
  let cfg;
  try {
    cfg = lerArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`sim: ${e.message}`);
    process.exit(2);
  }
  const comecou = Date.now();
  const { jobs, maos } = montarJobs(cfg);
  const resultados = await executarTodos(jobs, cfg.workers);
  const runs = resultados.filter((_, i) => jobs[i].tipo === 'run');
  const marginais = resultados.filter((_, i) => jobs[i].tipo === 'marginal');
  const metricas = {};
  const linhas = gerarTexto(cfg, runs, maos, marginais, metricas);
  console.log(linhas.join('\n'));

  if (cfg.comparar) {
    console.log('');
    console.log(compararCom(cfg.comparar, metricas, cfg.detalhe > 0, cfg).join('\n'));
  }
  if (cfg.salvar) {
    const config = configuracaoDoJogo();
    writeFileSync(cfg.salvar, `${JSON.stringify({ configuracao: config.hash, args: process.argv.slice(2), metricas }, null, 1)}\n`);
  }
  let extra = '';
  if (cfg.relatorio) extra = ` · relatorio de sessao: ${relatorioDeSessao(cfg)}`;
  const ticks = runs.reduce((s, r) => s + r.ticks, 0);
  const lenta = runs.reduce((a, r) => (!a || r.ms > a.ms ? r : a), null);
  console.log(
    `\n(${runs.length} runs + ${marginais.length} avaliacoes do experimento em ${((Date.now() - comecou) / 1000).toFixed(1)}s de parede,` +
      ` ${cfg.workers} worker(s), ${(ticks / 1e6).toFixed(2)}M ticks nas runs` +
      `${lenta ? `, a run mais lenta ${(lenta.ms / 1000).toFixed(1)}s (${lenta.bot} ${lenta.semente})` : ''}` +
      `${cfg.salvar ? ` · metricas em ${cfg.salvar}` : ''}${extra})`
  );
}

if (isMainThread) {
  principal().catch((e) => {
    console.error(`sim falhou: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  });
} else {
  trabalhador();
}
