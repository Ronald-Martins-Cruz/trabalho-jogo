// npm run fotos — fotografa cada tela do jogo num Chrome local, sem janela.
//
// E o olho das fases visuais (v2, decisao 13): sobe o test/serve.mjs com o
// estado exposto (window.__estado), abre o Chrome sem janela com o protocolo
// de depuracao e fala com ele pelo WebSocket do proprio Node — zero
// dependencia. Leva o jogo a cada tela importando os modulos do jogo NA
// PAGINA e mexendo no estado (como o dom.mjs faz no node), e tira a foto em
// 1920x1080 e 1280x720. As fotos saem fora do repositorio (o check reprova
// .png aqui dentro).
//
//   npm run fotos                         todas as telas, nos dois tamanhos
//   npm run fotos -- --saida <pasta>      onde gravar (padrao: <temp>/semana-de-provas-fotos)
//   npm run fotos -- --so loja,clima      so as cenas cujo nome contem um dos trechos
//   CHROME=<caminho> npm run fotos        outro Chrome/Chromium
//   npm run fotos -- --perf               nao fotografa: mede o desenho (fase 16)
//
// O --perf e o metodo do handoff 12, refeito como codigo: o Chrome sem janela
// com o canvas em raster por CPU (sem GPU, que e o caso pessimista), 400
// inimigos misturados andando para o jogador. Duas medidas:
//   - so o desenho: `desenhar` num canvas fora da tela, quadro a quadro, com
//     getImageData de 1 pixel para forcar o raster, e a ablacao (so a arena;
//     + numeros; + 800 faiscas; tudo);
//   - o laco real: o jogo rodando, com a horda completada a 400 e 2 mortes e
//     2 golpes injetados por quadro; o intervalo entre quadros.
// Antes de medir, conta os Chrome sem janela que nao sao deste processo (um
// orfao deixa tudo mais lento — surpresa do handoff 12).
//
// Sem Chrome na maquina, avisa e sai com 0: nao pode reprovar quem nao tem
// navegador. Fecha o Chrome pelo protocolo (Browser.close) e confere que
// nenhum processo do perfil temporario ficou para tras (surpresa do handoff
// 12: Chrome orfao deixava a maquina e as medidas lentas).

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { servir } from './serve.mjs';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opcao = (nome, padrao) => {
  const i = args.indexOf(nome);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : padrao;
};
const SAIDA = resolve(opcao('--saida', join(tmpdir(), 'semana-de-provas-fotos')));
const SO = opcao('--so', '').split(',').map((s) => s.trim()).filter(Boolean);
const PERF = args.includes('--perf');
// O --perf: quadros medidos (depois do aquecimento) por linha da ablacao,
// rodadas de cada linha, e segundos do laco real.
const PERF_QUADROS = 150;
const PERF_AQUECIMENTO = 30;
const PERF_RODADAS = 2;
const PERF_LACO = 6;
const TAMANHOS = [[1920, 1080], [1280, 720]];
const ESPERA_CDP = 30000; // ms por comando do protocolo

// ------------------------------------------------------------- o Chrome

function acharChrome() {
  const candidatos = [];
  if (process.env.CHROME) candidatos.push(process.env.CHROME);
  const so = platform();
  if (so === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (base) candidatos.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (so === 'darwin') {
    candidatos.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    for (const dir of ['/usr/bin', '/usr/local/bin', '/snap/bin']) {
      for (const nome of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) candidatos.push(join(dir, nome));
    }
  }
  if (process.env.CHROME && !existsSync(process.env.CHROME)) console.warn(`fotos: CHROME=${process.env.CHROME} nao existe; procurando nos caminhos padrao`);
  return candidatos.find((c) => c && existsSync(c)) || null;
}

const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

// O Chrome escreve a porta do protocolo no perfil quando --remote-debugging-port=0.
async function portaDoChrome(perfil, processo) {
  const arquivo = join(perfil, 'DevToolsActivePort');
  for (let i = 0; i < 300; i += 1) {
    if (processo.exitCode !== null) throw new Error(`o Chrome saiu antes de abrir o protocolo (codigo ${processo.exitCode})`);
    if (existsSync(arquivo)) {
      const [porta, caminho] = readFileSync(arquivo, 'utf8').split(/\r?\n/);
      if (porta && caminho) return `ws://127.0.0.1:${porta}${caminho}`;
    }
    await dormir(50);
  }
  throw new Error('o Chrome nao abriu o protocolo de depuracao em 15s');
}

// Um cliente minimo do protocolo: comandos com id, eventos para ouvintes, e
// sessoes "flatten" (o sessionId vai na mensagem).
async function conectar(url) {
  const ws = new WebSocket(url);
  await new Promise((ok, erro) => {
    ws.onopen = ok;
    ws.onerror = () => erro(new Error(`nao conectou em ${url}`));
  });
  let id = 0;
  const pendentes = new Map();
  const ouvintes = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && pendentes.has(m.id)) {
      const p = pendentes.get(m.id);
      pendentes.delete(m.id);
      clearTimeout(p.relogio);
      if (m.error) p.erro(new Error(`${p.metodo}: ${m.error.message}`));
      else p.ok(m.result);
    } else if (m.method) {
      for (const f of ouvintes) f(m);
    }
  };
  ws.onclose = () => {
    for (const p of pendentes.values()) {
      clearTimeout(p.relogio);
      p.erro(new Error(`${p.metodo}: a conexao fechou`));
    }
    pendentes.clear();
  };
  const enviar = (metodo, params = {}, sessionId = undefined, espera = ESPERA_CDP) =>
    new Promise((ok, erro) => {
      id += 1;
      const relogio = setTimeout(() => {
        pendentes.delete(id);
        erro(new Error(`${metodo}: sem resposta em ${espera / 1000}s`));
      }, espera);
      pendentes.set(id, { ok, erro, metodo, relogio });
      ws.send(JSON.stringify(sessionId ? { id, method: metodo, params, sessionId } : { id, method: metodo, params }));
    });
  const esperarEvento = (metodo, sessionId, ms = ESPERA_CDP) =>
    new Promise((ok, erro) => {
      const f = (m) => {
        if (m.method !== metodo || (sessionId && m.sessionId !== sessionId)) return;
        ouvintes.delete(f);
        clearTimeout(relogio);
        ok(m.params);
      };
      const relogio = setTimeout(() => {
        ouvintes.delete(f);
        erro(new Error(`${metodo}: nao chegou em ${ms / 1000}s`));
      }, ms);
      ouvintes.add(f);
    });
  return { ws, enviar, esperarEvento, ouvir: (f) => ouvintes.add(f) };
}

// Os processos cujo comando cita o perfil temporario (Chrome e os filhos dele)
// — ou, no --perf, todos os trechos pedidos (o executavel do Chrome e
// --headless: os Chrome sem janela que ja estavam vivos).
function processosDoPerfil(...trechos) {
  const alvos = trechos.map((t) => t.toLowerCase());
  const cita = (texto) => alvos.every((a) => texto.toLowerCase().includes(a));
  try {
    if (platform() === 'win32') {
      const json = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }
      );
      const lista = JSON.parse(json || '[]');
      return (Array.isArray(lista) ? lista : [lista]).filter((p) => cita(p.CommandLine)).map((p) => p.ProcessId);
    }
    const saida = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    return saida.split('\n').filter((l) => cita(l)).map((l) => Number(l.trim().split(/\s+/)[0]));
  } catch {
    return null; // nao deu para listar: avisado no fim
  }
}

function matar(pids) {
  for (const pid of pids) {
    try {
      if (platform() === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
    } catch {
      // ja tinha saido
    }
  }
}

// ---------------------------------------------------- dentro da pagina

// Roda na pagina (vai como texto): os modulos do jogo, o estado exposto e um
// "avancar" que simula segundos de jogo de uma vez, com um bot andando em
// circulo, HP segurado e a 1a carta escolhida — o mesmo do smoke.
async function ajudantesDaPagina() {
  const [run, state, main, cards, player, enemies, boss, content, render] = await Promise.all([
    import('/src/run.js'),
    import('/src/state.js'),
    import('/src/main.js'),
    import('/src/cards.js'),
    import('/src/player.js'),
    import('/src/enemies.js'),
    import('/src/boss.js'),
    import('/data/content.js'),
    import('/src/render.js'),
  ]);
  const e = window.__estado;
  const C = content.CONTEUDO;
  const T = state.TELAS;
  const passo = C.loop.passo;
  let volta = 0;
  const avancar = (segundos, { segurarHp = true, bot = true } = {}) => {
    const n = Math.round(segundos / passo);
    for (let i = 0; i < n; i += 1) {
      volta += 1;
      if (bot) {
        const a = (volta / 240) * 2 * Math.PI;
        e.input.eixoX = Math.cos(a);
        e.input.eixoY = Math.sin(a);
      }
      if (segurarHp) e.player.hp = e.player.hpMax;
      main.atualizar(e, passo);
      if (e.tela === T.CARTA) cards.escolherCarta(e, 0);
      e.eventos.length = 0;
    }
    e.input.eixoX = 0;
    e.input.eixoY = 0;
    // Sem carta subindo durante a espera ate a foto.
    e.player.xp = 0;
  };
  // Fecha a avaliacao corrente pelo cronometro, com os mortos pedidos.
  const fecharPeloTempo = (kills) => {
    const av = e.run.avaliacao;
    if (kills !== undefined) av.kills = kills;
    av.decorrido = av.duracao - passo / 2;
    main.atualizar(e, passo);
  };
  // Um golpe no jogador, como o de um inimigo (o evento e o que o desenho le).
  const golpe = (dano) => {
    player.receberDano(e, dano, true);
    state.emitir(e, 'jogador-dano', { fonte: 'fotos', dano, hp: e.player.hp, x: e.player.x, y: e.player.y });
  };
  // As cenas que continuam a anterior (carta, pausa, resultado, loja, a
  // virada da Banca) montam o que falta quando rodam sozinhas (--so).
  const garantirProva = () => {
    if (e.tela === T.AVALIACAO || e.tela === T.PAUSA || e.tela === T.CARTA) return;
    run.iniciarRun(e);
    run.comecarAvaliacao(e, 0, 0);
    avancar(20);
  };
  const garantirResultado = () => {
    if (e.tela === T.RESULTADO) return;
    garantirProva();
    if (e.tela === T.CARTA) cards.escolherCarta(e, 0);
    for (let i = 0; i < 10 && e.tela !== T.AVALIACAO; i += 1) main.atualizar(e, passo);
    if (e.tela === T.PAUSA) main.continuarDaPausa(e);
    fecharPeloTempo();
  };
  const garantirTcc = () => {
    if (e.tela === T.AVALIACAO && e.run.avaliacao.banca) return;
    run.iniciarRun(e);
    const ultimo = C.periodos.length - 1;
    run.comecarAvaliacao(e, ultimo, C.periodos[ultimo].avaliacoes.length - 1);
    run.avancarRun(e);
    run.comecarTcc(e);
    avancar(7);
  };
  // Fase 16: um quadrado do canvas, em px do canvas, no recorte de tela que o
  // protocolo fotografa ampliado (o detalhe das figurinhas).
  const recorteEm = (x, y, raio) => {
    const canvas = document.querySelector('canvas');
    const r = canvas.getBoundingClientRect();
    const k = r.width / canvas.width;
    return { x: r.left + (x - raio) * k, y: r.top + (y - raio) * k, width: 2 * raio * k, height: 2 * raio * k, scale: 2 };
  };
  // Um bando misturado em volta do jogador, parado onde foi posto: um de cada
  // tipo por volta do anel, e os filhotes de um 📱 morto.
  // O jogador no meio da arena, parado e sem ninguem em volta (o bot do
  // `avancar` o deixa em qualquer lugar).
  const centralizar = () => {
    enemies.limparInimigos(e);
    const p = e.player;
    const arena = e.run.avaliacao.arena;
    p.x = (arena.esquerda + arena.direita) / 2;
    p.y = (arena.topo + arena.base) / 2;
    p.vx = 0;
    p.vy = 0;
    p.invulneravel = 0;
  };
  const horda = (raio, porTipo) => {
    centralizar();
    const p = e.player;
    const tipos = C.inimigos;
    const n = tipos.length * porTipo;
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * 2 * Math.PI;
      const r = raio * (0.75 + 0.25 * ((i * 7) % 5) / 4);
      enemies.spawnTipo(e, tipos[i % tipos.length], p.x + Math.cos(a) * r, p.y + Math.sin(a) * r * 0.7);
    }
    const grupo = tipos.find((t) => t.divisao);
    const pai = enemies.spawnTipo(e, grupo, p.x + raio * 0.45, p.y - raio * 0.2);
    enemies.aplicarDano(e, pai, pai.hp);
    e.eventos.length = 0;
  };
  // Dois quadros do jogo de verdade: o desenho ve o que a cena montou (o
  // flash so acende num HP que ele ja tinha visto).
  const doisQuadros = () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  // Fase 17: `fn` a cada `cada` quadros do jogo de verdade, por `quadros`
  // quadros — durante a espera e a foto, que chega bem depois dela (o efeito
  // fica aceso na hora certa).
  // Para quando a cena seguinte comeca (window.__f.cena anda a cada preparar):
  // um laco nao vaza para a foto de outra cena.
  const repetir = (fn, cada, quadros = 180) => {
    let q = 0;
    const minha = window.__f.cena;
    const passo1 = () => {
      if (window.__f.cena !== minha) return;
      if (q % cada === 0) fn(q);
      q += 1;
      if (q < quadros) requestAnimationFrame(passo1);
    };
    passo1();
  };
  // Fase 17: so a arma `id`, no nivel maximo (a instancia de equiparArma); o
  // XP e o HP seguros durante a foto (sem carta de nivel nem jubilado).
  const soArma = (id) => {
    const dados = C.armas.find((a) => a.id === id);
    e.player.armas.length = 0;
    e.player.armas.push({ id, nivel: dados.niveis.length, cooldown: 0 });
    repetir(() => {
      e.player.xp = 0;
      e.player.hp = e.player.hpMax;
    }, 1);
    return e.player.armas[0];
  };
  // Fase 17: A Banca no aviso do `padrao` na fase `fase`, pela porta do jogo
  // (a sequencia aponta para ele e a perseguicao acaba no tick seguinte), com
  // os dois no meio da pagina e o aviso andado `fracao` do telegrafo.
  const avisoDaBanca = (fase, padrao, fracao) => {
    garantirTcc();
    const E = boss.ESTADOS_BANCA;
    const b = e.run.avaliacao.banca;
    const corpo = boss.acharBanca(e);
    const arena = e.run.avaliacao.arena;
    const meioX = (arena.esquerda + arena.direita) / 2;
    const meioY = (arena.topo + arena.base) / 2;
    corpo.x = meioX + 150;
    corpo.y = meioY - 20;
    e.player.x = meioX - 170;
    e.player.y = meioY + 60;
    b.fase = fase;
    b.estado = E.PERSEGUINDO;
    b.relogio = passo / 2;
    b.passo = C.banca.fases[fase].sequencia.indexOf(padrao);
    const tick = () => {
      e.player.hp = e.player.hpMax;
      main.atualizar(e, passo);
      if (e.tela === T.CARTA) cards.escolherCarta(e, 0);
      e.eventos.length = 0;
    };
    for (let i = 0; i < 240 && b.estado !== E.TELEGRAFO; i += 1) tick();
    const total = b.duracaoEstado;
    for (let t = 0; t < total * fracao; t += passo) tick();
    // O aviso parado em `fracao` ate a foto (ela chega depois da espera).
    const resta = b.relogio;
    repetir(() => {
      if (b.estado === E.TELEGRAFO) b.relogio = resta;
      e.player.hp = e.player.hpMax;
      e.player.xp = 0;
    }, 1);
  };
  window.__f = { cena: 0, run, state, main, cards, player, enemies, boss, render, C, T, e, passo, avancar, fecharPeloTempo, golpe, garantirProva, garantirResultado, garantirTcc, recorteEm, horda, centralizar, doisQuadros, soArma, repetir, avisoDaBanca };
  await document.fonts.ready;
  return true;
}

// ------------------------------------------------------------ --perf

// Roda na pagina (vai como texto, com as opcoes no fim). So usa o que o
// render tem desde a fase 12 (criarEfeitos, desenhar): o mesmo script mede o
// HEAD de antes de uma fase, para comparar na mesma maquina.
async function medirNaPagina(op) {
  const [render, state, run, enemies, content] = await Promise.all([
    import('/src/render.js'),
    import('/src/state.js'),
    import('/src/run.js'),
    import('/src/enemies.js'),
    import('/data/content.js'),
  ]);
  const C = content.CONTEUDO;
  const passo = C.loop.passo;
  const total = C.arena.limites.enemies;
  // 400 inimigos misturados numa grade sobre a arena, cada um com a
  // velocidade de quem anda para o jogador (inclina e espelha como no jogo).
  const encher = (e, quantos) => {
    const a = e.run.avaliacao.arena;
    const colunas = 25;
    const linhas = Math.ceil(total / colunas);
    for (let i = e.enemies.length; i < quantos; i += 1) {
      const x = a.esquerda + 20 + (i % colunas) * ((a.direita - a.esquerda - 40) / (colunas - 1));
      const y = a.topo + 20 + (Math.floor(i / colunas) % linhas) * ((a.base - a.topo - 40) / (linhas - 1));
      const inimigo = enemies.spawnTipo(e, C.inimigos[i % C.inimigos.length], x, y);
      if (!inimigo) break;
      const dx = e.player.x - x;
      const dy = e.player.y - y;
      const d = Math.hypot(dx, dy) || 1;
      inimigo.vx = (dx / d) * inimigo.velocidade;
      inimigo.vy = (dy / d) * inimigo.velocidade;
    }
  };
  const montar = () => {
    const e = state.novoEstado(20261016);
    run.iniciarRun(e);
    run.comecarAvaliacao(e, 0, 0, []);
    enemies.limparInimigos(e);
    encher(e, total);
    e.eventos.length = 0;
    return e;
  };
  const estatistica = (t) => {
    const s = [...t].sort((a, b) => a - b);
    const media = s.reduce((x, y) => x + y, 0) / s.length;
    return { media, mediana: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1], n: s.length };
  };
  // Os golpes e as mortes de mentira: so eventos na fila, que o desenho le.
  const golpes = (e, q, n) => {
    for (let i = 0; i < n; i += 1) {
      const alvo = e.enemies[(q * 7 + i * 37) % e.enemies.length];
      state.emitir(e, 'arma-acerto', { x: alvo.x + ((i * 53) % 90), y: alvo.y, dano: 9 });
    }
  };
  const mortes = (e, q, n) => {
    for (let i = 0; i < n; i += 1) {
      const alvo = e.enemies[(q * 11 + i * 29) % e.enemies.length];
      state.emitir(e, 'inimigo-morto', { x: alvo.x, y: alvo.y, tipo: alvo.tipo });
    }
  };
  const linhas = [
    ['so a arena', () => {}],
    ['+ numeros', (e, q) => golpes(e, q, 10)],
    ['+ 800 faiscas', (e, q) => mortes(e, q, 25)],
    ['tudo', (e, q) => { golpes(e, q, 10); mortes(e, q, 25); }],
    // A primeira de novo, no fim: se o numero subiu, a medida derivou.
    ['so a arena (de novo)', () => {}],
  ];
  const canvas = document.createElement('canvas');
  canvas.width = C.arena.largura;
  canvas.height = C.arena.altura;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const desenho = [];
  // Um fx so, como o jogo (um por canvas): as camadas e a folha de
  // figurinhas nascem uma vez. Uma avaliacao nova a cada rodada zera os
  // efeitos (limparEfeitos), e o aquecimento cozinha o que faltar.
  const fx = render.criarEfeitos();
  for (const [nome, injetar] of linhas) {
    const rodadas = [];
    for (let r = 0; r < op.rodadas; r += 1) {
      const e = montar();
      const tempos = [];
      let faiscas = 0;
      for (let q = 0; q < op.aquecimento + op.quadros; q += 1) {
        e.tempo += passo;
        injetar(e, q);
        const t0 = performance.now();
        render.desenhar(e, ctx, fx);
        ctx.getImageData(0, 0, 1, 1);
        const t1 = performance.now();
        e.eventos.length = 0;
        if (q >= op.aquecimento) tempos.push(t1 - t0);
        // Devolve o controle ao navegador entre um quadro e outro, como o
        // jogo faz: num laco sincrono de milhares de quadros, o Chrome nao
        // limpa o que cada drawImage deixa, e todo desenho fica 3x mais lento
        // depois de ~1200 quadros (fase 16, medido) — artefato da medida.
        await new Promise((ok) => setTimeout(ok, 0));
        faiscas = Math.max(faiscas, fx.particulas.ativos.length);
      }
      rodadas.push({ ...estatistica(tempos), faiscas, numeros: fx.numeros.ativos.length, inimigos: e.enemies.length });
    }
    desenho.push({ nome, rodadas });
  }

  // O laco real: o jogo da pagina, com a horda injetada a cada quadro.
  const e = window.__estado;
  run.iniciarRun(e);
  run.comecarAvaliacao(e, 0, 0, []);
  enemies.limparInimigos(e);
  const intervalos = [];
  let mortos = 0;
  await new Promise((pronto) => {
    let anterior = null;
    let q = 0;
    const inicio = performance.now();
    const quadro = (agora) => {
      e.player.hp = e.player.hpMax;
      e.player.invulneravel = 1;
      encher(e, total);
      // 2 mortes e 2 golpes por quadro, pelas portas do jogo.
      for (let i = 0; i < 2; i += 1) {
        const alvo = e.enemies[(q * 13 + i * 101) % e.enemies.length];
        if (alvo && !alvo.chefe) {
          enemies.aplicarDano(e, alvo, alvo.hp + 1);
          mortos += 1;
        }
        const ferido = e.enemies[(q * 17 + i * 89 + 5) % e.enemies.length];
        if (ferido && !ferido.chefe) enemies.aplicarDano(e, ferido, 1);
      }
      q += 1;
      if (anterior !== null && agora - inicio > 1000) intervalos.push(agora - anterior);
      anterior = agora;
      if (agora - inicio < 1000 + op.laco * 1000) requestAnimationFrame(quadro);
      else pronto();
    };
    requestAnimationFrame(quadro);
  });
  const laco = estatistica(intervalos);
  laco.acima20 = intervalos.filter((x) => x > 20).length;
  laco.mortesPorSegundo = mortos / (op.laco + 1);
  return { desenho, laco, agente: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] || navigator.userAgent };
}

async function medir(cdp, sessao, url) {
  const enviar = (metodo, params) => cdp.enviar(metodo, params, sessao);
  await enviar('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  const carregou = cdp.esperarEvento('Page.loadEventFired', sessao);
  await enviar('Page.navigate', { url });
  await carregou;
  for (let i = 0; i < 200; i += 1) {
    const r = await enviar('Runtime.evaluate', { expression: '!!window.__estado', returnByValue: true });
    if (r.result.value === true) break;
    await dormir(50);
  }
  const op = { quadros: PERF_QUADROS, aquecimento: PERF_AQUECIMENTO, rodadas: PERF_RODADAS, laco: PERF_LACO };
  const r = await cdp.enviar('Runtime.evaluate', { expression: `(${medirNaPagina})(${JSON.stringify(op)})`, awaitPromise: true, returnByValue: true }, sessao, 600000);
  if (r.exceptionDetails) throw new Error(`na pagina: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`);
  return r.result.value;
}

function imprimirDesempenho(m) {
  const ms = (x) => x.toFixed(2);
  console.log(`desempenho (${m.agente}, raster por CPU, 400 inimigos misturados; ${PERF_QUADROS} quadros x ${PERF_RODADAS} rodadas por linha)`);
  console.log('');
  console.log('| o que e desenhado | media (ms) | mediana | p95 | max | faiscas | numeros |');
  console.log('|---|---|---|---|---|---|---|');
  for (const linha of m.desenho) {
    const r = linha.rodadas;
    const faixa = (k) => r.map((x) => ms(x[k])).join(' / ');
    console.log(`| ${linha.nome} | ${faixa('media')} | ${faixa('mediana')} | ${faixa('p95')} | ${faixa('max')} | ${r[0].faiscas} | ${r[0].numeros} |`);
  }
  const l = m.laco;
  console.log('');
  console.log(`laco real (${PERF_LACO}s, horda completada a 400, 2 mortes e 2 golpes por quadro, ~${l.mortesPorSegundo.toFixed(0)} mortes/s): ` +
    `media ${ms(l.media)} ms entre quadros · mediana ${ms(l.mediana)} · p95 ${ms(l.p95)} · ${l.acima20} de ${l.n} quadros acima de 20ms`);
}

// As cenas, na ordem (cada uma parte do que a anterior deixou, quando ajuda).
// `preparar` roda na pagina; `espera` e o tempo ate a foto (as entradas de
// CSS terminarem).
const CENAS = [
  { nome: 'menu', espera: 900, preparar: () => window.__f.state.irParaTela(window.__f.e, window.__f.T.MENU) },
  {
    nome: 'anuncio',
    espera: 600,
    preparar: () => {
      const { run, e } = window.__f;
      run.iniciarRun(e);
      run.anunciarAvaliacao(e, 0, 2); // a Prova Final do 1o periodo: dois modificadores
    },
  },
  {
    nome: 'avaliacao-20s-golpe',
    espera: 60,
    preparar: () => {
      const { run, e, avancar, golpe } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 0);
      avancar(20);
      golpe(14);
    },
  },
  {
    nome: 'carta',
    espera: 800,
    preparar: () => {
      const { e, main, passo, garantirProva } = window.__f;
      garantirProva();
      e.player.xp = e.player.xpProximo;
      main.atualizar(e, passo);
    },
  },
  {
    nome: 'pausa',
    espera: 500,
    preparar: () => {
      const { e, cards, main, T, passo, garantirProva } = window.__f;
      garantirProva();
      if (e.tela === T.CARTA) cards.escolherCarta(e, 0);
      for (let i = 0; i < 10 && e.tela !== T.AVALIACAO; i += 1) main.atualizar(e, passo);
      main.alternarPausa(e);
    },
  },
  {
    nome: 'resultado',
    espera: 1000,
    preparar: () => {
      window.__f.garantirResultado();
    },
  },
  {
    nome: 'loja',
    espera: 900,
    preparar: () => {
      window.__f.garantirResultado();
      window.__f.main.sairDoResultado(window.__f.e);
    },
  },
  {
    nome: 'clima-1-manha',
    espera: 300,
    preparar: () => {
      const { run, e, avancar } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 0, []);
      avancar(12);
    },
  },
  {
    nome: 'clima-2-tarde',
    espera: 300,
    preparar: () => {
      const { run, e, avancar } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 1, 0, []);
      avancar(12);
    },
  },
  {
    nome: 'clima-3-madrugada',
    espera: 300,
    preparar: () => {
      const { run, e, avancar } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 2, 0, []);
      avancar(12);
    },
  },
  {
    nome: 'sala-lotada',
    espera: 300,
    preparar: () => {
      const { run, e, avancar, C } = window.__f;
      const sala = C.modificadores.find((m) => m.fatores && m.fatores.arena < 1);
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 1, [sala.id]);
      avancar(10);
    },
  },
  {
    nome: 'jubilado',
    espera: 900,
    preparar: () => {
      const { run, e, avancar, player, main, passo } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 1, 1);
      avancar(8);
      player.receberDano(e, e.player.hp + 1, true);
      main.atualizar(e, passo);
    },
  },
  {
    nome: 'tcc',
    espera: 700,
    preparar: () => {
      const { run, e, C } = window.__f;
      run.iniciarRun(e);
      const ultimo = C.periodos.length - 1;
      run.comecarAvaliacao(e, ultimo, C.periodos[ultimo].avaliacoes.length - 1);
      run.avancarRun(e);
    },
  },
  {
    nome: 'clima-4-tcc-banca-fase-1',
    espera: 300,
    preparar: () => {
      window.__f.garantirTcc();
    },
  },
  {
    nome: 'banca-transicao',
    espera: 450,
    preparar: () => {
      const { e, boss, C, main, passo, garantirTcc } = window.__f;
      garantirTcc();
      const corpo = boss.acharBanca(e);
      corpo.hp = Math.min(corpo.hp, corpo.hpMax * (C.banca.fases[0].ate - 0.02));
      main.atualizar(e, passo);
    },
  },
  {
    nome: 'colacao',
    espera: 1100,
    preparar: () => {
      const { run, e, C, T, avancar, fecharPeloTempo, boss, enemies, main, passo } = window.__f;
      // Os 9 boletins pela porta de sempre (fecharAvaliacao), sem jogar 10 minutos.
      run.iniciarRun(e);
      let i = 0;
      for (let p = 0; p < C.periodos.length; p += 1) {
        for (let a = 0; a < C.periodos[p].avaliacoes.length; a += 1) {
          run.comecarAvaliacao(e, p, a);
          fecharPeloTempo(150 + 35 * i);
          e.eventos.length = 0;
          i += 1;
        }
      }
      run.avancarRun(e);
      run.comecarTcc(e);
      for (let t = 0; t < 120 && e.tela !== T.COLACAO; t += 1) {
        const corpo = boss.acharBanca(e);
        if (corpo) enemies.aplicarDano(e, corpo, corpo.hpMax / 4);
        avancar(1);
      }
      if (e.tela !== T.COLACAO) main.atualizar(e, passo);
    },
  },
  // Fase 16: as figurinhas. Cada uma tem tambem uma foto ampliada (`detalhe`,
  // o recorte calculado na hora da foto) com o contorno e as sombras.
  {
    nome: 'figurinhas-horda',
    espera: 120,
    preparar: () => {
      const { run, e, avancar, horda } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 1, 0, []);
      avancar(2);
      horda(230, 4);
    },
    detalhe: () => window.__f.recorteEm(window.__f.e.player.x, window.__f.e.player.y, 170),
  },
  {
    nome: 'figurinhas-andando-esquerda',
    espera: 450,
    preparar: () => {
      const { run, e, avancar, centralizar } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 0, []);
      avancar(2);
      // Sem bando no caminho: um golpe faria o jogador piscar na foto.
      centralizar();
      // Segurado durante a espera: o teclado nao mexe no eixo sem tecla.
      e.input.eixoX = -1;
    },
    detalhe: () => window.__f.recorteEm(window.__f.e.player.x, window.__f.e.player.y, 60),
  },
  {
    nome: 'figurinhas-andando-direita',
    espera: 450,
    preparar: () => {
      const { run, e, avancar, centralizar } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 0, []);
      avancar(2);
      centralizar();
      e.input.eixoX = 1;
    },
    detalhe: () => window.__f.recorteEm(window.__f.e.player.x, window.__f.e.player.y, 60),
  },
  {
    nome: 'figurinhas-golpe',
    espera: 120,
    preparar: async () => {
      const { run, e, avancar, horda, enemies, doisQuadros } = window.__f;
      const minha = window.__f.cena;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 0, []);
      avancar(2);
      horda(200, 3);
      await doisQuadros();
      // Metade do bando leva um golpe por quadro (sem morrer), durante a
      // espera e a foto: o flash e o pop ficam acesos, e a foto nao depende
      // de cair dentro dos 0,12s de um golpe so.
      let resta = 180; // 3s: a foto chega bem depois da espera
      const golpear = () => {
        if (window.__f.cena !== minha) return;
        e.enemies.forEach((inimigo, i) => {
          if (i % 2 === 0 && !inimigo.chefe) enemies.aplicarDano(e, inimigo, 0.01);
        });
        resta -= 1;
        if (resta > 0) requestAnimationFrame(golpear);
      };
      golpear();
    },
    detalhe: () => window.__f.recorteEm(window.__f.e.player.x, window.__f.e.player.y, 150),
  },
  {
    nome: 'figurinhas-banca-fase-2',
    espera: 250,
    preparar: () => {
      const { e, boss, C, main, passo, garantirTcc, avancar } = window.__f;
      garantirTcc();
      const corpo = boss.acharBanca(e);
      corpo.hp = Math.min(corpo.hp, corpo.hpMax * (C.banca.fases[0].ate - 0.02));
      avancar(C.banca.transicao.duracao + 1.2);
      // Os dois no meio da pagina (o bot do `avancar` leva para qualquer
      // canto, e no alto o HUD cobre A Banca); um tick copia o corpo no espelho.
      const arena = e.run.avaliacao.arena;
      const meioX = (arena.esquerda + arena.direita) / 2;
      const meioY = (arena.topo + arena.base) / 2;
      e.player.x = meioX - 160;
      e.player.y = meioY + 40;
      corpo.x = meioX + 120;
      corpo.y = meioY;
      main.atualizar(e, passo);
    },
    detalhe: () => {
      const b = window.__f.e.run.avaliacao.banca;
      return window.__f.recorteEm(b.x, b.y, 110);
    },
  },
  // Fase 17: as armas no nivel maximo, cada uma sozinha (o risco que ela
  // deixa), as mortes, o golpe no jogador, o aviso de spawn e A Banca com
  // cada aviso. As cenas de efeito curto o repetem durante a espera.
  {
    nome: 'arma-cafe',
    espera: 350,
    preparar: () => {
      const { run, e, avancar, horda, soArma } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 0, []);
      avancar(1);
      horda(260, 3);
      soArma('cafe');
      e.input.eixoX = 1; // andando: o rastro a lapis atras
    },
    detalhe: () => window.__f.recorteEm(window.__f.e.player.x, window.__f.e.player.y, 260),
  },
  {
    nome: 'arma-caneta',
    espera: 250,
    preparar: () => {
      const { run, e, avancar, horda, soArma } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 0, []);
      avancar(1);
      horda(240, 2);
      soArma('caneta');
      e.input.eixoX = 1;
    },
    detalhe: () => window.__f.recorteEm(window.__f.e.player.x, window.__f.e.player.y, 140),
  },
  {
    nome: 'arma-resumo',
    espera: 60,
    preparar: () => {
      const { run, e, avancar, horda, soArma, repetir } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 0, []);
      avancar(1);
      horda(230, 2);
      const arma = soArma('resumo');
      // Parado no meio de um pulso ate a foto, sem o seguinte.
      repetir(() => {
        arma.animacao = 0.16;
        arma.cooldown = 5;
      }, 1);
    },
    detalhe: () => window.__f.recorteEm(window.__f.e.player.x, window.__f.e.player.y, 200),
  },
  {
    nome: 'arma-marcatexto',
    espera: 200,
    preparar: () => {
      const { run, e, avancar, centralizar, soArma, enemies, C } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 0, []);
      avancar(1);
      centralizar();
      soArma('marcatexto');
      // Uns na frente do risco (a direita), para o marca-texto passar por cima.
      const p = e.player;
      for (let i = 0; i < 5; i += 1) enemies.spawnTipo(e, C.inimigos[i % C.inimigos.length], p.x + 90 + i * 40, p.y + (i % 2 ? 30 : -30));
      e.input.eixoX = 1;
    },
    detalhe: () => window.__f.recorteEm(window.__f.e.player.x + 120, window.__f.e.player.y, 170),
  },
  {
    nome: 'mortes-de-cada-tipo',
    espera: 220,
    preparar: () => {
      const { run, e, avancar, centralizar, enemies, state, C, repetir } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 0, []);
      avancar(1);
      centralizar();
      e.player.armas.length = 0;
      const p = e.player;
      // Uma de cada tipo em fila, e a derrota da Banca embaixo (confete so).
      repetir(() => {
        C.inimigos.forEach((tipo, i) => {
          // So o evento (sem orbe nem filhote por cima das faiscas).
          state.emitir(e, 'inimigo-morto', { tipo: tipo.id, x: p.x - 270 + i * 180, y: p.y - 110, xp: 0, vida: 1 });
        });
        state.emitir(e, 'inimigo-morto', { tipo: C.banca.id, x: p.x, y: p.y + 120, xp: 0, vida: 1 });
        e.player.hp = e.player.hpMax;
        e.player.xp = 0;
      }, 9);
    },
    detalhe: () => window.__f.recorteEm(window.__f.e.player.x, window.__f.e.player.y, 260),
  },
  {
    nome: 'golpe-no-jogador',
    espera: 140,
    preparar: () => {
      const { run, e, avancar, centralizar, golpe, repetir } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 0, []);
      avancar(1);
      centralizar();
      e.player.armas.length = 0;
      repetir(() => {
        e.player.hp = e.player.hpMax;
        golpe(9);
      }, 4);
    },
    detalhe: () => window.__f.recorteEm(window.__f.e.player.x, window.__f.e.player.y, 80),
  },
  {
    nome: 'aviso-de-spawn',
    espera: 250,
    preparar: () => {
      const { run, e, avancar, centralizar, enemies, C, repetir } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 0, []);
      avancar(1);
      centralizar();
      e.player.armas.length = 0;
      repetir(() => {
        for (let i = 0; i < 3; i += 1) enemies.spawnInimigo(e, C.inimigos[i].id);
      }, 12);
    },
    // A seta mais nova (o inimigo mais novo ainda fora da arena).
    detalhe: () => {
      const { e, render, C } = window.__f;
      const av = e.run.avaliacao;
      const ponto = { x: 0, y: 0 };
      const novos = e.enemies.filter((x) => !x.chefe && av.decorrido - x.nascidoEm < C.juice.avisoSpawn.duracao);
      const alvo = novos.find((x) => render.pontoDeEntrada(x.x, x.y, e.player.x, e.player.y, av.arena, ponto));
      return alvo ? window.__f.recorteEm(ponto.x, ponto.y, 70) : window.__f.recorteEm(e.player.x, e.player.y, 200);
    },
  },
  ...[
    [0, 'leque'],
    [0, 'horda'],
    [1, 'leque'],
    [1, 'investida'],
    [1, 'horda'],
  ].map(([fase, padrao]) => ({
    nome: `banca-fase-${fase + 1}-${padrao}`,
    espera: 60,
    preparar: new Function(`window.__f.avisoDaBanca(${fase}, '${padrao}', 0.55);`),
    detalhe: () => {
      const b = window.__f.e.run.avaliacao.banca;
      return window.__f.recorteEm(b.x, b.y, 230);
    },
  })),
  // Por ultimo: o fx forcado vale ate a pagina recarregar (o tamanho seguinte).
  {
    // O fallback de emoji forcado (como a 14B): um fx novo no canvas do jogo,
    // com todos os emoji marcados como faltando — a forma colorida e cozida
    // com o mesmo contorno. A pagina recarrega no tamanho seguinte.
    nome: 'figurinhas-sem-emoji',
    espera: 150,
    preparar: () => {
      const { run, e, avancar, horda, render } = window.__f;
      const fx = render.efeitosDe(document.querySelector('canvas').getContext('2d'));
      Object.assign(fx, render.criarEfeitos());
      fx.emojiConferido = true;
      fx.emojiFaltando = new Set(render.emojisDoCanvas());
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 0, []);
      avancar(2);
      horda(200, 3);
    },
    detalhe: () => window.__f.recorteEm(window.__f.e.player.x, window.__f.e.player.y, 150),
  },
];

// Uma foto so na tela larga: a mesa em volta da cena e os objetos dela.
const MESA = { nome: 'mesa', tamanho: [2560, 1080], espera: 900, preparar: () => window.__f.state.irParaTela(window.__f.e, window.__f.T.MENU) };
CENAS.forEach((cena, i) => {
  cena.ordem = i + 1;
});
MESA.ordem = CENAS.length + 1;

// --------------------------------------------------------------- roteiro

async function fotografar(cdp, sessao, url, tamanho, cenas) {
  const [largura, altura] = tamanho;
  const enviar = (metodo, params) => cdp.enviar(metodo, params, sessao);
  await enviar('Emulation.setDeviceMetricsOverride', { width: largura, height: altura, deviceScaleFactor: 1, mobile: false });
  const carregou = cdp.esperarEvento('Page.loadEventFired', sessao);
  await enviar('Page.navigate', { url });
  await carregou;
  let pronto = false;
  for (let i = 0; i < 200 && !pronto; i += 1) {
    const r = await enviar('Runtime.evaluate', { expression: '!!window.__estado', returnByValue: true });
    pronto = r.result.value === true;
    if (!pronto) await dormir(50);
  }
  if (!pronto) throw new Error('a pagina nao expos window.__estado (o serve --expor falhou?)');
  await avaliar(enviar, `(${ajudantesDaPagina})()`);
  const feitas = [];
  for (const cena of cenas) {
    await avaliar(enviar, 'window.__f.cena += 1');
    await avaliar(enviar, `(${cena.preparar})()`);
    await dormir(cena.espera);
    const tela = await enviar('Runtime.evaluate', { expression: 'window.__estado.tela', returnByValue: true });
    const { data } = await enviar('Page.captureScreenshot', { format: 'png' });
    const base = `${String(cena.ordem).padStart(2, '0')}-${cena.nome}-${largura}x${altura}`;
    const arquivo = join(SAIDA, `${base}.png`);
    writeFileSync(arquivo, Buffer.from(data, 'base64'));
    feitas.push({ arquivo, tela: tela.result.value });
    if (cena.detalhe) {
      const clip = await avaliar(enviar, `(${cena.detalhe})()`);
      const ampliada = await enviar('Page.captureScreenshot', { format: 'png', clip });
      const detalhe = join(SAIDA, `${base}-detalhe.png`);
      writeFileSync(detalhe, Buffer.from(ampliada.data, 'base64'));
      feitas.push({ arquivo: detalhe, tela: `${tela.result.value}, ampliada ${clip.scale}x` });
    }
  }
  return feitas;
}

async function avaliar(enviar, expressao) {
  const r = await enviar('Runtime.evaluate', { expression: expressao, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`na pagina: ${(d.exception && d.exception.description) || d.text}`);
  }
  return r.result.value;
}

async function principal() {
  const caminho = acharChrome();
  if (!caminho) {
    console.log('fotos: Chrome nao encontrado (defina CHROME=<caminho do executavel>). Nada fotografado.');
    return 0;
  }
  const dentro = relative(RAIZ, SAIDA);
  if (!dentro.startsWith('..') && !isAbsolute(dentro)) {
    console.error(`fotos: --saida ${SAIDA} esta dentro do repositorio (o check reprova .png aqui). Use uma pasta de fora.`);
    return 1;
  }
  mkdirSync(SAIDA, { recursive: true });
  const cenas = PERF ? [] : SO.length === 0 ? CENAS : CENAS.filter((c) => SO.some((s) => c.nome.includes(s)));
  const comMesa = !PERF && (SO.length === 0 || SO.some((s) => MESA.nome.includes(s)));
  if (PERF) {
    // Chrome sem janela de outra execucao deixa a maquina lenta: o numero nao
    // valeria. So avisa (pode ser de outro programa); quem mede decide.
    const antes = processosDoPerfil(caminho, '--headless');
    if (antes === null) console.warn('fotos --perf: nao deu para listar os processos; confira Chrome orfao a mao');
    else if (antes.length > 0) console.warn(`fotos --perf: ${antes.length} processo(s) de Chrome sem janela ja vivos (${antes.join(', ')}): feche-os antes de confiar no numero`);
    else console.log('fotos --perf: nenhum Chrome sem janela vivo antes de medir');
  }

  const servidor = await servir({ porta: 0, expor: true, host: '127.0.0.1' });
  const perfil = mkdtempSync(join(tmpdir(), 'semana-de-provas-chrome-'));
  const chrome = spawn(
    caminho,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${perfil}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--mute-audio',
      '--window-size=1920,1080',
      // --perf: o canvas em raster por CPU (o caso pessimista, o do handoff
      // 12) e os quadros sem trava de 60 Hz (o intervalo e o custo).
      ...(PERF ? ['--disable-gpu', '--disable-accelerated-2d-canvas', '--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  const saiu = new Promise((ok) => chrome.once('exit', ok));
  const erros = [];
  const feitas = [];
  let cdp = null;
  let codigo = 0;
  try {
    cdp = await conectar(await portaDoChrome(perfil, chrome));
    const { targetId } = await cdp.enviar('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.enviar('Target.attachToTarget', { targetId, flatten: true });
    cdp.ouvir((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') erros.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') erros.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    });
    await cdp.enviar('Page.enable', {}, sessionId);
    await cdp.enviar('Runtime.enable', {}, sessionId);
    // A pagina "com foco": sem isto um blur do headless pausaria a prova.
    await cdp.enviar('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    if (PERF) imprimirDesempenho(await medir(cdp, sessionId, servidor.url));
    else for (const tamanho of TAMANHOS) feitas.push(...(await fotografar(cdp, sessionId, servidor.url, tamanho, cenas)));
    if (comMesa) {
      const [foto] = await fotografar(cdp, sessionId, servidor.url, MESA.tamanho, [MESA]);
      feitas.push(foto);
    }
  } catch (e) {
    console.error(`fotos: ${e.message}`);
    codigo = 1;
  } finally {
    if (cdp) {
      try {
        await cdp.enviar('Browser.close');
      } catch {
        // o Chrome pode fechar a conexao antes de responder
      }
    }
    const fechou = await Promise.race([saiu.then(() => true), dormir(10000).then(() => false)]);
    if (!fechou) chrome.kill();
    await servidor.fechar();
  }

  // Processo orfao: nenhum processo do perfil temporario pode sobrar.
  await dormir(300);
  let orfaos = processosDoPerfil(perfil);
  if (orfaos && orfaos.length > 0) {
    console.error(`fotos: ${orfaos.length} processo(s) do Chrome ficaram vivos depois do Browser.close (${orfaos.join(', ')}); encerrando`);
    matar(orfaos);
    await dormir(500);
    orfaos = processosDoPerfil(perfil);
    codigo = 1;
  }
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(perfil, { recursive: true, force: true });
      break;
    } catch {
      await dormir(300);
    }
  }

  for (const f of feitas) console.log(`${f.arquivo}  (${f.tela})`);
  if (!PERF) console.log(`fotos: ${feitas.length} em ${SAIDA}`);
  if (orfaos === null) console.warn('fotos: nao deu para listar os processos e conferir orfaos');
  else console.log(`fotos: Chrome fechado pelo protocolo, ${orfaos.length} processo(s) orfao(s)`);
  if (erros.length > 0) {
    console.error(`fotos: ${erros.length} erro(s) no console da pagina:`);
    for (const e of [...new Set(erros)]) console.error(`  ${e}`);
    codigo = 1;
  }
  return codigo;
}

process.exitCode = await principal();
