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
  const enviar = (metodo, params = {}, sessionId = undefined) =>
    new Promise((ok, erro) => {
      id += 1;
      const relogio = setTimeout(() => {
        pendentes.delete(id);
        erro(new Error(`${metodo}: sem resposta em ${ESPERA_CDP / 1000}s`));
      }, ESPERA_CDP);
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

// Os processos cujo comando cita o perfil temporario (Chrome e os filhos dele).
function processosDoPerfil(perfil) {
  const alvo = perfil.toLowerCase();
  try {
    if (platform() === 'win32') {
      const json = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }
      );
      const lista = JSON.parse(json || '[]');
      return (Array.isArray(lista) ? lista : [lista]).filter((p) => p.CommandLine.toLowerCase().includes(alvo)).map((p) => p.ProcessId);
    }
    const saida = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    return saida.split('\n').filter((l) => l.toLowerCase().includes(alvo)).map((l) => Number(l.trim().split(/\s+/)[0]));
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
  const [run, state, main, cards, player, enemies, boss, content] = await Promise.all([
    import('/src/run.js'),
    import('/src/state.js'),
    import('/src/main.js'),
    import('/src/cards.js'),
    import('/src/player.js'),
    import('/src/enemies.js'),
    import('/src/boss.js'),
    import('/data/content.js'),
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
  window.__f = { run, state, main, cards, player, enemies, boss, C, T, e, passo, avancar, fecharPeloTempo, golpe, garantirProva, garantirResultado, garantirTcc };
  await document.fonts.ready;
  return true;
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
    await avaliar(enviar, `(${cena.preparar})()`);
    await dormir(cena.espera);
    const tela = await enviar('Runtime.evaluate', { expression: 'window.__estado.tela', returnByValue: true });
    const { data } = await enviar('Page.captureScreenshot', { format: 'png' });
    const arquivo = join(SAIDA, `${String(cena.ordem).padStart(2, '0')}-${cena.nome}-${largura}x${altura}.png`);
    writeFileSync(arquivo, Buffer.from(data, 'base64'));
    feitas.push({ arquivo, tela: tela.result.value });
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
  const cenas = SO.length === 0 ? CENAS : CENAS.filter((c) => SO.some((s) => c.nome.includes(s)));
  const comMesa = SO.length === 0 || SO.some((s) => MESA.nome.includes(s));

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
    for (const tamanho of TAMANHOS) feitas.push(...(await fotografar(cdp, sessionId, servidor.url, tamanho, cenas)));
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
  console.log(`fotos: ${feitas.length} em ${SAIDA}`);
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
