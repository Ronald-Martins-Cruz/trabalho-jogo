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
//   npm run fotos -- --perf --acelerado   idem, com o canvas na placa de video: so a
//                                         thread principal (sem getImageData)
//   npm run fotos -- --reduzido           as cenas com prefers-reduced-motion emulado,
//                                         fotografadas logo depois de preparar (fase 22)
//   npm run fotos -- --jogar              ~3 min jogados pelo TECLADO, sem mexer no
//                                         estado, com foto a cada troca de tela (fase 22)
//   npm run fotos -- --jogar --imortal --sem-xp --turbo 6 --segundos 480
//                                         a run inteira ate a colacao (checkpoint 6)
//   npm run fotos -- --hover              nao fotografa: o mouse entra e sai de cada peca
//                                         que reage a ele, em cada tela, e reprova se uma
//                                         animacao de entrada recomecar (o pisca); depois
//                                         para a 1 px da borda de baixo (reprova se o :hover
//                                         trocar mais de uma vez: a peca vibra) e clica a
//                                         1 px da de cima (reprova se o clique nao valer; no
//                                         post-it e no cartao, so conta: BORDA_RESIDUO)
//
// Fase 22: toda foto sai com a conferencia da tela ao lado (window.__f.conferir):
// o que sai da cena, o texto cortado pela caixa, o foco de teclado de cada
// botao, o HUD por cima da pausa e da carta, o tooltip por cima de tudo, o
// carimbo assentado e as animacoes ainda rodando. E a foto da mesa confere os
// objetos de mesa em varias proporcoes de janela.
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
const ACELERADO = args.includes('--acelerado');
const REDUZIDO = args.includes('--reduzido');
const JOGAR = args.includes('--jogar');
const HOVER = args.includes('--hover');
const JOGAR_SEGUNDOS = Number(opcao('--segundos', '180'));
// Checkpoint 6: a run inteira no Chrome em tempo de apresentacao. --imortal
// segura o HP (chega a colacao); --turbo N roda N passos da simulacao por
// quadro durante a prova (o resto do jogo, telas e teclas, anda como sempre).
const IMORTAL = args.includes('--imortal');
const TURBO = Math.max(1, Math.floor(Number(opcao('--turbo', '1'))) || 1);
// --sem-xp: o XP fica em zero (nenhuma carta de nivel). Com o turbo, as cartas
// viram quase toda a sessao e a run nao chega ao fim; elas ja aparecem sem isto.
const SEM_XP = args.includes('--sem-xp');
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
  // Fase 18: a Prova Final do 1o periodo com 3 coringas (o Atestado ja
  // gasto) e 2 modificadores, todos de content.js — o HUD cheio.
  const jokers = await import('/src/jokers.js');
  const hudCheio = (periodo = 0, avaliacao = 2) => {
    run.iniciarRun(e);
    for (const id of ['caderno', 'wifi', 'atestado']) e.run.coringas.push(jokers.novaInstancia(id));
    e.run.coringas[2].gasto = true;
    run.comecarAvaliacao(e, periodo, avaliacao, ['professorRigido', 'frequencia']);
    avancar(6);
    // A regua com XP no meio (o avancar zera o XP para nao subir carta).
    e.player.xp = Math.floor(e.player.xpProximo * 0.6);
  };
  // Fase 18: a borda de baixo da faixa de cima do HUD (regua, etiqueta, HP,
  // post-it, ata), pelas caixas visiveis na pagina, em px da tela e do canvas.
  const fundoDoHud = () => {
    const cena = document.querySelector('.cena').getBoundingClientRect();
    let fundo = cena.top;
    for (const no of document.querySelectorAll('.hud-regua *, .hud-topo *')) {
      const r = no.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) fundo = Math.max(fundo, r.bottom);
    }
    const px = fundo - cena.top;
    const canvas = document.querySelector('canvas');
    return { px, pct: (100 * px) / cena.height, canvas: (px * canvas.height) / cena.height, altura: cena.height };
  };
  // Fase 19: cada caixa cabe inteira na cena? (em da cena; "SAI" se nao)
  const cabe = (...seletores) => {
    const cena = document.querySelector('.cena').getBoundingClientRect();
    const em = parseFloat(getComputedStyle(document.querySelector('.cena')).fontSize);
    return seletores.map((s) => {
      const no = document.querySelector(s);
      if (!no) return `${s} nao existe`;
      const r = no.getBoundingClientRect();
      const dentro = r.left >= cena.left - 0.5 && r.top >= cena.top - 0.5 && r.right <= cena.right + 0.5 && r.bottom <= cena.bottom + 0.5;
      return `${s} ${(r.width / em).toFixed(1)}x${(r.height / em).toFixed(1)}em ${dentro ? 'dentro' : 'SAI da cena'}`;
    }).join(' · ');
  };
  // Fase 22: a conferencia de cada foto (o que a lista da fase pede ver).
  const visivel = (no) => {
    const r = no.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(no);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.01;
  };
  const nomeDe = (no) => (no.id ? `#${no.id}` : `${no.tagName.toLowerCase()}.${[...no.classList].join('.')}`);
  const conferir = async () => {
    const cena = document.querySelector('.cena').getBoundingClientRect();
    const raizes = [...document.querySelectorAll('.camada:not(.oculto)')].filter(visivel);
    const fora = [];
    const estouro = [];
    const reticencias = [];
    for (const raiz of raizes) {
      for (const no of raiz.querySelectorAll('*')) {
        if (no.closest('.relatorio-barra, svg') || !visivel(no)) continue;
        const texto = [...no.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const r = no.getBoundingClientRect();
        if ((texto || no.tagName === 'BUTTON') && (r.left < cena.left - 1 || r.top < cena.top - 1 || r.right > cena.right + 1 || r.bottom > cena.bottom + 1)) fora.push(nomeDe(no));
        const s = getComputedStyle(no);
        if (!texto || s.display === 'inline') continue;
        // Cortado: a caixa recorta (overflow) e o texto nao cabe nela. Com
        // overflow visivel, so o que vaza para o lado: a manuscrita passa da
        // altura da linha por natureza, e nada e cortado.
        const recorta = s.overflowX !== 'visible' || s.overflowY !== 'visible';
        const largo = no.scrollWidth > no.clientWidth + (recorta ? 1 : 2);
        // Com reticencias so a largura conta (a linha unica e de proposito).
        if (largo || (recorta && s.textOverflow !== 'ellipsis' && no.scrollHeight > no.clientHeight + 1)) {
          (s.textOverflow === 'ellipsis' ? reticencias : estouro).push(`${nomeDe(no)}${recorta ? '' : ' (vaza)'}`);
        }
      }
    }
    const rodando = document.getAnimations().filter((a) => a.playState === 'running');
    const animacoes = `animacoes rodando: ${rodando.length}${rodando.length ? ` (${[...new Set(rodando.map((a) => a.animationName || a.transitionProperty || '?'))].join(', ')})` : ''}`;
    const carimbos = [];
    for (const c of document.querySelectorAll('.camada:not(.oculto) .carimbo')) {
      if (!visivel(c)) continue;
      const s = getComputedStyle(c);
      carimbos.push(`carimbo ${nomeDe(c)}: escala ${s.scale}, opacidade ${s.opacity}, giro ${s.rotate}`);
    }
    // O foco de teclado: cada botao visivel focado como pelo Tab tem contorno
    // ou vira o cursor (na carta e na loja o foco escreve o cursor). O cursor
    // do estado volta ao que era depois.
    const guarda = [e.cartas && e.cartas.selecionada, e.loja && e.loja.linha, e.loja && e.loja.selecionada];
    const semFoco = [];
    let botoes = 0;
    for (const raiz of raizes) {
      for (const b of raiz.querySelectorAll('button')) {
        if (!visivel(b)) continue;
        botoes += 1;
        b.focus({ focusVisible: true });
        await doisQuadros();
        const s = getComputedStyle(b);
        if (!(s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) && !b.classList.contains('selecionada')) semFoco.push(nomeDe(b));
      }
    }
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    if (e.cartas) e.cartas.selecionada = guarda[0];
    if (e.loja) {
      e.loja.linha = guarda[1];
      e.loja.selecionada = guarda[2];
    }
    const partes = [`fora da cena: ${fora.length ? fora.join(' ') : '0'}`, `texto cortado: ${estouro.length ? estouro.join(' ') : '0'}`];
    if (reticencias.length) partes.push(`reticencias: ${reticencias.join(' ')}`);
    partes.push(`foco: ${botoes - semFoco.length}/${botoes}${semFoco.length ? ` (sem: ${semFoco.join(' ')})` : ''}`);
    // Quem fica por cima: o HUD sobre a pausa e a carta; o tooltip sobre tudo.
    const hud = document.getElementById('hud');
    const z = (no) => getComputedStyle(no).zIndex;
    if ((e.tela === T.PAUSA || e.tela === T.CARTA) && visivel(hud)) {
      const tela = document.getElementById(e.tela === T.PAUSA ? 'pausa' : 'carta');
      partes.push(`z-index hud ${z(hud)} / ${tela.id} ${z(tela)}`);
    }
    const dica = [...document.querySelectorAll('.hud-tooltip')].find(visivel);
    if (dica) {
      const r = dica.getBoundingClientRect();
      // O tooltip nao recebe o mouse (pointer-events: none): ligado so para
      // perguntar quem esta por cima naquele ponto.
      const antes = dica.style.pointerEvents;
      dica.style.pointerEvents = 'auto';
      const topo = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      dica.style.pointerEvents = antes;
      const dentro = r.left >= cena.left && r.right <= cena.right && r.top >= cena.top && r.bottom <= cena.bottom;
      partes.push(`tooltip por cima: ${topo && dica.contains(topo) ? 'sim' : `NAO (${topo ? nomeDe(topo) : '-'})`}, ${dentro ? 'dentro' : 'SAI'} da cena`);
    }
    const translucido = document.querySelector('#hud .translucido, #hud.translucido');
    if (translucido) partes.push(`hud esmaecido (${nomeDe(translucido)}, opacidade ${getComputedStyle(translucido).opacity})`);
    partes.push(...carimbos, animacoes);
    const fx = render.efeitosDe(document.querySelector('canvas').getContext('2d'));
    if (fx.movimento && fx.movimento.matches) partes.push(`canvas: movimento reduzido, tremor aplicado ${fx.tremorX},${fx.tremorY} (sorteado ${fx.tremor.toFixed(1)})`);
    return partes.join(' · ');
  };
  // Fase 22, consertos do checkpoint 6 (o pisca no hover): tudo o que comeca
  // ou e cancelado (animacao e transicao de CSS) e toda classe que muda,
  // enquanto o mouse entra e sai de cada peca que reage a ele.
  const registro = [];
  for (const tipo of ['animationstart', 'animationcancel', 'transitionrun', 'transitioncancel']) {
    document.addEventListener(tipo, (ev) => {
      const t = ev.target;
      if (!t || !t.tagName || t.closest('.relatorio-barra')) return;
      registro.push({ tipo, no: `${nomeDe(t)}${ev.pseudoElement || ''}`, nome: ev.animationName || ev.propertyName });
    }, true);
  }
  new MutationObserver((lista) => {
    for (const m of lista) {
      if (m.target.closest && m.target.closest('.relatorio-barra')) continue;
      registro.push({ tipo: 'classe', no: nomeDe(m.target), nome: `"${m.oldValue}" -> "${m.target.className}"` });
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  // As pecas que reagem ao mouse: todo botao das camadas a vista, as
  // figurinhas do HUD (o tooltip) e o botao do som.
  const alvosDoHover = () => {
    const nos = [];
    for (const raiz of document.querySelectorAll('.camada:not(.oculto)')) {
      if (!visivel(raiz)) continue;
      for (const b of raiz.querySelectorAll('button, .hud-chip')) if (visivel(b) && !b.closest('.relatorio-barra')) nos.push(b);
    }
    const mudo = document.getElementById('botao-mudo');
    if (mudo && visivel(mudo)) nos.push(mudo);
    const centro = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    // Um ponto da cena onde o mouse nao acende nada (sem peca nenhuma embaixo).
    const cena = document.querySelector('.cena').getBoundingClientRect();
    let neutro = null;
    for (const [fx, fy] of [[0.5, 0.04], [0.03, 0.5], [0.97, 0.5], [0.5, 0.97], [0.03, 0.03], [0.97, 0.97], [0.3, 0.3], [0.7, 0.7]]) {
      const x = cena.left + cena.width * fx;
      const y = cena.top + cena.height * fy;
      const embaixo = document.elementFromPoint(x, y);
      if (embaixo && !nos.some((n) => n.contains(embaixo))) {
        neutro = { x, y };
        break;
      }
    }
    // Os adesivos da barra de relatorio (debug.relatorio, a vista no jogo
    // entregue) so entram na conferencia da borda: o registro acima nao os ouve.
    const extras = [];
    for (const raiz of document.querySelectorAll('.camada:not(.oculto)')) {
      if (!visivel(raiz)) continue;
      for (const b of raiz.querySelectorAll('.relatorio-barra button')) if (visivel(b)) extras.push(b);
    }
    window.__f.alvos = [...nos, ...extras];
    const lista = (l) => l.map((n) => ({ nome: nomeDe(n), ...centro(n.getBoundingClientRect()) }));
    return { neutro, alvos: lista(nos), extras: lista(extras) };
  };
  // Rodada 2 dos consertos do checkpoint 6 (o bloqueio da revisao): o mouse
  // PARADO perto da borda de uma peca que levanta no :hover. Ela sobe, sai de
  // baixo do cursor, perde o :hover, desce, ganha de novo, sem parar: o Chrome
  // refaz o hit-test depois de cada layout, com o mouse parado. `borda` acha
  // pelo hit-test onde a peca acaba numa vertical (o que o mouse enxerga: o
  // giro e o que ela tiver por fora da caixa); `vigiar` conta, a cada quadro,
  // as trocas de :hover de uma peca; `armarClique` conta onde caem os cliques
  // e os engole (a peca nao age).
  const borda = (i, fx, lado) => {
    const no = window.__f.alvos[i];
    const r = no.getBoundingClientRect();
    const x = r.left + r.width * fx;
    const dentro = (y) => {
      const n = document.elementFromPoint(x, y);
      return !!n && no.contains(n);
    };
    if (lado === 'baixo') {
      for (let y = r.bottom + 30; y > r.top; y -= 0.25) if (dentro(y)) return { x, y };
    } else {
      for (let y = r.top - 30; y < r.bottom; y += 0.25) if (dentro(y)) return { x, y };
    }
    return null;
  };
  const vigia = { no: null, ultimo: null, trocas: 0 };
  const olhar = () => {
    if (vigia.no) {
      const h = vigia.no.matches(':hover');
      if (vigia.ultimo !== null && h !== vigia.ultimo) vigia.trocas += 1;
      vigia.ultimo = h;
    }
    requestAnimationFrame(olhar);
  };
  requestAnimationFrame(olhar);
  const vigiar = (i) => {
    const trocas = vigia.trocas;
    vigia.no = i === null ? null : window.__f.alvos[i];
    vigia.ultimo = vigia.no ? vigia.no.matches(':hover') : null;
    vigia.trocas = 0;
    return trocas;
  };
  const cliques = { no: null, dentro: 0, fora: 0 };
  window.addEventListener('click', (ev) => {
    if (!cliques.no) return;
    if (cliques.no.contains(ev.target)) cliques.dentro += 1;
    else cliques.fora += 1;
    ev.stopImmediatePropagation();
    ev.preventDefault();
  }, true);
  const armarClique = (i) => {
    const antes = { dentro: cliques.dentro, fora: cliques.fora };
    cliques.no = i === null ? null : window.__f.alvos[i];
    cliques.dentro = 0;
    cliques.fora = 0;
    if (i === null && document.activeElement && document.activeElement.blur) document.activeElement.blur();
    return antes;
  };
  window.__f = { cena: 0, run, state, main, cards, player, enemies, boss, render, C, T, e, passo, avancar, fecharPeloTempo, golpe, garantirProva, garantirResultado, garantirTcc, recorteEm, horda, centralizar, doisQuadros, soArma, repetir, avisoDaBanca, hudCheio, fundoDoHud, cabe, conferir, visivel, registro, alvosDoHover, borda, vigiar, armarClique, alvos: [], depois: null };
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
  // willReadFrequently poe o canvas na CPU: so no caso pessimista (op.forcar).
  const ctx = canvas.getContext('2d', { willReadFrequently: op.forcar });
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
        if (op.forcar) ctx.getImageData(0, 0, 1, 1);
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
  const op = { quadros: PERF_QUADROS, aquecimento: PERF_AQUECIMENTO, rodadas: PERF_RODADAS, laco: PERF_LACO, forcar: !ACELERADO };
  const r = await cdp.enviar('Runtime.evaluate', { expression: `(${medirNaPagina})(${JSON.stringify(op)})`, awaitPromise: true, returnByValue: true }, sessao, 600000);
  if (r.exceptionDetails) throw new Error(`na pagina: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`);
  return r.result.value;
}

function imprimirDesempenho(m) {
  const ms = (x) => x.toFixed(2);
  console.log(`desempenho (${m.agente}, ${ACELERADO ? 'canvas acelerado, so a thread principal' : 'raster por CPU'}, 400 inimigos misturados; ${PERF_QUADROS} quadros x ${PERF_RODADAS} rodadas por linha)`);
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
    medir: () => window.__f.cabe('.mural'),
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
  {
    // O fallback de emoji forcado (como a 14B): um fx novo no canvas do jogo,
    // com todos os emoji marcados como faltando — a forma colorida e cozida
    // com o mesmo contorno. A pagina recarrega no tamanho seguinte.
    nome: 'figurinhas-sem-emoji',
    espera: 150,
    preparar: () => {
      const { run, e, avancar, horda, render } = window.__f;
      const fx = render.efeitosDe(document.querySelector('canvas').getContext('2d'));
      const movimento = fx.movimento;
      Object.assign(fx, render.criarEfeitos(), { movimento });
      fx.emojiConferido = true;
      fx.emojiFaltando = new Set(render.emojisDoCanvas());
      // Fase 22: desfeito antes da cena seguinte (window.__f.depois). Antes, o
      // fallback valia ate a pagina recarregar, e as cenas 35 em diante saiam
      // com as figurinhas em circulos no canvas.
      window.__f.depois = () => Object.assign(fx, render.criarEfeitos(), { movimento });
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 0, []);
      avancar(2);
      horda(200, 3);
    },
    detalhe: () => window.__f.recorteEm(window.__f.e.player.x, window.__f.e.player.y, 150),
  },
  // Fase 18: o HUD de caderno. `apontar` devolve o ponto da tela onde o
  // mouse para antes da foto (o tooltip e :hover de CSS); `medir` devolve
  // uma linha que sai ao lado do caminho da foto.
  {
    nome: 'hud-cartela',
    espera: 300,
    preparar: () => {
      window.__f.hudCheio();
      window.__f.centralizar();
    },
  },
  {
    // O golpe: a barra ja caiu (140 ms) e o fantasma claro ainda nao saiu
    // do lugar (espera 300 ms para escorrer).
    nome: 'hud-golpe-fantasma',
    espera: 220,
    preparar: () => {
      const { e, T, hudCheio, centralizar, golpe } = window.__f;
      if (e.tela !== T.AVALIACAO || e.run.coringas.length !== 3) hudCheio();
      centralizar();
      e.player.hp = e.player.hpMax;
      golpe(30);
    },
    detalhe: () => {
      const r = document.querySelector('.hud-esquerda').getBoundingClientRect();
      return { x: r.left - 8, y: r.top - 8, width: r.width + 16, height: r.height + 16, scale: 2 };
    },
  },
  {
    nome: 'hud-pausa-tooltip',
    espera: 500,
    preparar: () => {
      const { e, T, main, hudCheio, centralizar } = window.__f;
      if (e.tela !== T.AVALIACAO || e.run.coringas.length !== 3) hudCheio();
      centralizar();
      main.alternarPausa(e);
    },
    apontar: () => {
      const r = document.querySelectorAll('#hud-coringas .hud-chip')[1].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
  },
  {
    nome: 'hud-cronometro-urgente',
    espera: 450,
    preparar: () => {
      const { e, C, main, passo, hudCheio, centralizar } = window.__f;
      hudCheio();
      centralizar();
      const av = e.run.avaliacao;
      av.decorrido = av.duracao - C.hud.timerUrgente + 2.5;
      main.atualizar(e, passo);
    },
  },
  {
    nome: 'hud-banca-fase-2',
    espera: 300,
    preparar: () => {
      const { e, boss, C, main, passo, garantirTcc, avancar } = window.__f;
      garantirTcc();
      const corpo = boss.acharBanca(e);
      corpo.hp = Math.min(corpo.hp, corpo.hpMax * (C.banca.fases[0].ate - 0.08));
      avancar(C.banca.transicao.duracao + 1.2);
      const arena = e.run.avaliacao.arena;
      e.player.x = (arena.esquerda + arena.direita) / 2 - 160;
      e.player.y = (arena.topo + arena.base) / 2 + 60;
      corpo.x = (arena.esquerda + arena.direita) / 2 + 120;
      corpo.y = (arena.topo + arena.base) / 2;
      e.player.xp = Math.floor(e.player.xpProximo * 0.35);
      main.atualizar(e, passo);
    },
    detalhe: () => {
      const r = document.querySelector('.hud-centro').getBoundingClientRect();
      return { x: r.left - 8, y: r.top - 8, width: r.width + 16, height: r.height + 16, scale: 2 };
    },
    medir: () => {
      const m = window.__f.fundoDoHud();
      return `HUD no TCC: ${m.px.toFixed(1)}px de ${m.altura.toFixed(0)}px = ${m.pct.toFixed(1)}% da cena (y=${m.canvas.toFixed(1)} no canvas)`;
    },
  },
  {
    nome: 'hud-translucido-banca',
    espera: 400,
    preparar: () => {
      const { e, boss, main, passo, garantirTcc } = window.__f;
      garantirTcc();
      const corpo = boss.acharBanca(e);
      const arena = e.run.avaliacao.arena;
      corpo.x = (arena.esquerda + arena.direita) / 2 + 40;
      corpo.y = arena.topo + 45;
      e.player.x = (arena.esquerda + arena.direita) / 2 - 200;
      e.player.y = (arena.topo + arena.base) / 2 + 80;
      main.atualizar(e, passo);
    },
    medir: () => `topo translucido: ${document.getElementById('hud').classList.contains('translucido')}`,
  },
  {
    // O nome com acento em maiuscula (Á) na etiqueta: a manuscrita tem
    // ascendente alta, e a linha unica corta o que passa dela.
    nome: 'hud-etiqueta-acento',
    espera: 300,
    preparar: () => {
      window.__f.hudCheio(1, 1);
      window.__f.centralizar();
    },
    detalhe: () => {
      const r = document.querySelector('.hud-esquerda').getBoundingClientRect();
      return { x: r.left - 8, y: r.top - 8, width: r.width + 16, height: r.height + 16, scale: 2 };
    },
  },
  {
    nome: 'hud-sala-lotada',
    espera: 300,
    preparar: () => {
      const { run, e, avancar, C, centralizar } = window.__f;
      const sala = C.modificadores.find((m) => m.fatores && m.fatores.arena < 1);
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 1, [sala.id]);
      avancar(4);
      centralizar();
    },
    medir: () => {
      const cena = document.querySelector('.cena').getBoundingClientRect();
      const hp = document.querySelector('.barra-hp').getBoundingClientRect();
      const k = document.querySelector('canvas').height / cena.height;
      const topo = window.__f.e.run.avaliacao.arena.topo;
      return `HP termina em y=${((hp.bottom - cena.top) * k).toFixed(1)} do canvas; a parede da Sala Lotada em y=${topo.toFixed(1)}`;
    },
  },
  // Fase 19: as telas como objetos da mesa. `medir` diz se a folha (ou a
  // capa, o post-it) cabe inteira na cena e o que a tela mostra.
  {
    nome: 'telas-menu-recorde',
    espera: 900,
    preparar: () => {
      const { e, state, T } = window.__f;
      e.recorde.formaturas = 2;
      e.recorde.melhorConceito = 'B';
      e.recorde.melhorMedia = 8.7;
      state.irParaTela(e, T.MENU);
    },
    medir: () => window.__f.cabe('.capa-etiqueta', '.menu-dica', '#menu-recorde', '#botao-jogar'),
  },
  {
    nome: 'telas-anuncio-novo-periodo-sem-modificador',
    espera: 900,
    preparar: () => {
      const { run, e } = window.__f;
      run.iniciarRun(e);
      run.anunciarAvaliacao(e, 0, 0);
    },
    medir: () => window.__f.cabe('#anuncio .folha'),
  },
  {
    nome: 'telas-anuncio-materia-longa',
    espera: 900,
    preparar: () => {
      const { run, e } = window.__f;
      run.iniciarRun(e);
      run.anunciarAvaliacao(e, 2, 1); // o nome de materia mais comprido, dois modificadores
    },
    medir: () => window.__f.cabe('#anuncio .folha'),
  },
  {
    nome: 'telas-resultado-conceito-a',
    espera: 1100,
    preparar: () => {
      const { run, e, avancar, fecharPeloTempo } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 1, 1);
      avancar(5);
      fecharPeloTempo(900);
    },
    medir: () => `${window.__f.cabe('#resultado .folha')}; ${document.getElementById('resultado-nota').textContent} ${document.getElementById('resultado-conceito').textContent}`,
  },
  {
    nome: 'telas-resultado-conceito-f',
    espera: 1100,
    preparar: () => {
      const { run, e, avancar, fecharPeloTempo } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 2, 1);
      avancar(5);
      e.player.hp = 3;
      fecharPeloTempo(0);
    },
    medir: () => `${window.__f.cabe('#resultado .folha')}; ${document.getElementById('resultado-nota').textContent} ${document.getElementById('resultado-conceito').textContent}`,
  },
  {
    nome: 'telas-jubilado-banca',
    espera: 1000,
    preparar: () => {
      const { e, boss, player, main, passo, garantirTcc } = window.__f;
      garantirTcc();
      const corpo = boss.acharBanca(e);
      corpo.hp = corpo.hpMax * 0.34;
      player.receberDano(e, e.player.hp + 1, true);
      main.atualizar(e, passo);
    },
    medir: () => `${window.__f.cabe('#jubilado .folha')}; ${document.getElementById('jubilado-faltava').textContent}`,
  },
  {
    nome: 'telas-jubilado-avaliacao',
    espera: 1000,
    preparar: () => {
      const { run, e, avancar, player, main, passo } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 2, 1);
      avancar(8);
      player.receberDano(e, e.player.hp + 1, true);
      main.atualizar(e, passo);
    },
    medir: () => `${window.__f.cabe('#jubilado .folha')}; ${document.getElementById('jubilado-faltava').textContent}`,
  },
  {
    nome: 'telas-pausa',
    espera: 600,
    preparar: () => {
      const { run, e, avancar, main } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 2, 0);
      avancar(6);
      main.alternarPausa(e);
    },
    medir: () => window.__f.cabe('.intervalo'),
  },
  // O foco de teclado (o contorno tracejado) na capa escura e no post-it.
  {
    nome: 'telas-foco-menu',
    espera: 900,
    preparar: async () => {
      const { e, state, T, doisQuadros } = window.__f;
      state.irParaTela(e, T.MENU);
      await doisQuadros();
      document.getElementById('botao-jogar').focus({ focusVisible: true });
    },
    medir: () => `foco em #${document.activeElement.id}, :focus-visible ${document.activeElement.matches(':focus-visible')}`,
  },
  {
    nome: 'telas-foco-pausa',
    espera: 600,
    preparar: async () => {
      const { run, e, avancar, main, doisQuadros } = window.__f;
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 1);
      avancar(4);
      main.alternarPausa(e);
      await doisQuadros();
      document.getElementById('botao-menu').focus({ focusVisible: true });
    },
    medir: () => `foco em #${document.activeElement.id}, :focus-visible ${document.activeElement.matches(':focus-visible')}`,
  },
  // Fase 20: as telas B. A loja com tudo o que ela mostra ao mesmo tempo: um
  // item vendido (o carimbo), um sem credito, a cartela com um coringa gasto
  // e o aviso; o cursor num slot (vender: a volta vermelha).
  {
    nome: 'telas-loja-vendido-aviso-gasto',
    espera: 1200,
    preparar: async () => {
      const { e, main, garantirResultado } = window.__f;
      const [shop, jokers] = await Promise.all([import('/src/shop.js'), import('/src/jokers.js')]);
      garantirResultado();
      main.sairDoResultado(e);
      for (const id of ['caderno', 'atestado']) if (!e.run.coringas.some((c) => c.id === id)) e.run.coringas.push(jokers.novaInstancia(id));
      e.run.coringas.find((c) => c.id === 'atestado').gasto = true;
      e.run.creditos = 999;
      shop.comprarItem(e, 0);
      shop.comprarItem(e, 0); // de novo: o aviso "ja foi comprado"
      const restantes = e.loja.itens.slice(1, e.loja.quantidade).filter((i) => i.id && !i.vendido).map((i) => i.preco);
      e.run.creditos = Math.min(...restantes);
      e.loja.linha = 1;
      e.loja.selecionada = 1;
    },
    medir: () => `${window.__f.cabe('.mural')}; aviso "${document.getElementById('loja-aviso').textContent}"; ${document.querySelectorAll('.loja-item.vendido').length} vendido(s), ${document.querySelectorAll('.loja-item.sem-credito').length} sem credito, ${document.querySelectorAll('.loja-slot.gasto').length} gasto(s)`,
  },
  {
    nome: 'telas-carta-cursor-na-terceira',
    espera: 900,
    preparar: () => {
      const { e, main, passo, garantirProva, T } = window.__f;
      garantirProva();
      if (e.tela !== T.CARTA) {
        e.player.xp = e.player.xpProximo;
        main.atualizar(e, passo);
      }
      e.cartas.selecionada = 2;
    },
    medir: () => `${window.__f.cabe('.carta-bilhete', '#carta-opcoes')}; ${document.querySelectorAll('.carta-opcao.carta-nova').length} nova(s)`,
  },
  {
    nome: 'telas-tcc',
    espera: 900,
    preparar: () => {
      const { run, e, C } = window.__f;
      run.iniciarRun(e);
      const ultimo = C.periodos.length - 1;
      run.comecarAvaliacao(e, ultimo, C.periodos[ultimo].avaliacoes.length - 1);
      run.avancarRun(e);
    },
    medir: () => window.__f.cabe('.convocacao'),
  },
  // A colacao sem recorde novo: o recorde guardado e melhor que esta run.
  {
    nome: 'telas-colacao-sem-recorde-novo',
    espera: 1100,
    preparar: () => {
      const { run, e, C, T, avancar, fecharPeloTempo, boss, enemies, main, passo } = window.__f;
      // A mesma run da cena `colacao` (9 boletins pela porta de sempre).
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
      e.run.colacao.novoRecorde = false;
      e.recorde.formaturas = 3;
      e.recorde.melhorConceito = 'A';
      e.recorde.melhorMedia = 9.8;
    },
    medir: () => `${window.__f.cabe('.diploma')}; recorde "${document.getElementById('colacao-recorde').textContent}"`,
  },
  // Fase 22: o que a lista da conferencia pede ver e nenhuma cena mostrava.
  // A loja com a cartela cheia: o aviso mais longo (pendencia 125) e o cursor
  // num slot de venda, com a volta vermelha longe do rotulo (pendencia 123).
  {
    nome: 'conferencia-loja-cheia-aviso-longo',
    espera: 1200,
    preparar: async () => {
      const { e, C, run, main, avancar, garantirResultado } = window.__f;
      const [shop, jokers] = await Promise.all([import('/src/shop.js'), import('/src/jokers.js')]);
      run.iniciarRun(e);
      run.comecarAvaliacao(e, 0, 0);
      avancar(3);
      garantirResultado();
      main.sairDoResultado(e);
      const teto = document.querySelectorAll('.loja-slot').length;
      for (const c of C.coringas) if (e.run.coringas.length < teto && !e.run.coringas.some((x) => x.id === c.id)) e.run.coringas.push(jokers.novaInstancia(c.id));
      e.run.creditos = 999;
      shop.comprarItem(e, Math.max(0, e.loja.itens.findIndex((x) => x.id && !x.vendido)));
      e.loja.linha = 1;
      e.loja.selecionada = 0;
    },
    medir: () => {
      const a = document.getElementById('loja-aviso');
      const faixa = document.createRange();
      faixa.selectNodeContents(a);
      const rotulo = document.querySelector('.loja-rotulo').getBoundingClientRect();
      const slot = document.querySelector('.loja-slot.selecionada');
      const folga = slot ? (slot.getBoundingClientRect().top - rotulo.bottom).toFixed(1) : '-';
      return `${window.__f.cabe('.mural')}; aviso "${a.textContent}" em ${faixa.getClientRects().length} linha(s); ${folga}px entre o rotulo e o slot apontado`;
    },
  },
  // O HUD com a avaliacao de nome mais comprido e o tooltip do coringa de
  // nome mais longo, na pausa (texto estourando; o tooltip por cima de tudo).
  {
    nome: 'conferencia-hud-nome-longo-tooltip',
    espera: 500,
    preparar: async () => {
      const { run, e, C, main, avancar, centralizar } = window.__f;
      const jokers = await import('/src/jokers.js');
      const longo = [...C.coringas].sort((a, b) => b.nome.length - a.nome.length)[0];
      let maior = [0, 0, -1];
      C.periodos.forEach((p, i) => p.avaliacoes.forEach((av, j) => {
        const n = `${av.materia || ''} · ${av.nome || ''}`.length;
        if (n > maior[2]) maior = [i, j, n];
      }));
      run.iniciarRun(e);
      for (const id of [longo.id, 'caderno', 'wifi']) if (!e.run.coringas.some((c) => c.id === id)) e.run.coringas.push(jokers.novaInstancia(id));
      run.comecarAvaliacao(e, maior[0], maior[1], ['professorRigido', 'frequencia']);
      avancar(6);
      centralizar();
      main.alternarPausa(e);
    },
    apontar: () => {
      const r = document.querySelectorAll('#hud-coringas .hud-chip')[0].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    medir: () => `etiqueta "${document.getElementById('avaliacao-nome').textContent}"`,
  },
  // O clique afunda (pendencia 124): o botao do mouse segurado no 2o post-it
  // ate a foto; solto depois dela, ele escolhe a carta.
  {
    nome: 'conferencia-carta-clique',
    espera: 900,
    conferir: false,
    preparar: () => {
      const { e, main, passo, garantirProva, T } = window.__f;
      garantirProva();
      if (e.tela === T.PAUSA) main.continuarDaPausa(e);
      if (e.tela !== T.CARTA) {
        e.player.xp = e.player.xpProximo;
        main.atualizar(e, passo);
      }
    },
    // Espera a carta assentar (o deslize de entrada) antes de mirar.
    apontar: async () => {
      await window.__f.doisQuadros();
      await new Promise((ok) => setTimeout(ok, 900));
      const r = document.querySelectorAll('#carta-opcoes .carta-opcao')[1].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.75 };
    },
    pressionar: true,
    medir: () => {
      const b = document.querySelectorAll('#carta-opcoes .carta-opcao')[1];
      return `2o post-it: selecionada ${b.classList.contains('selecionada')}, :active ${b.matches(':active')}, transform ${getComputedStyle(b).transform}`;
    },
  },
  // Checkpoint 6 (pendencia 126): o diploma mais cheio que o jogo monta. O
  // nome inteiro de cada materia (o que nao cabe quebra em duas linhas), os
  // coringas de nome mais comprido ate o teto e o recorde novo.
  {
    nome: 'conferencia-colacao-cheia',
    espera: 1100,
    preparar: async () => {
      const { run, e, C, T, avancar, fecharPeloTempo, boss, enemies, main, passo } = window.__f;
      const jokers = await import('/src/jokers.js');
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
      e.run.coringas.length = 0;
      for (const c of [...C.coringas].sort((a, b) => b.nome.length - a.nome.length).slice(0, C.loja.teto)) e.run.coringas.push(jokers.novaInstancia(c.id));
      e.run.colacao.novoRecorde = true;
    },
    medir: () => {
      const linhas = (no) => Math.round(no.getBoundingClientRect().height / parseFloat(getComputedStyle(no).lineHeight));
      const materias = [...document.querySelectorAll('.colacao-materia')].map((m) => `${m.textContent}${linhas(m) > 1 ? ` (${linhas(m)} linhas)` : ''}`);
      return `${window.__f.cabe('.diploma', '#botao-colacao')}; ${materias.join(', ')}; coringas em ${document.getElementById('colacao-coringas').getClientRects().length} linha(s)`;
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
    await avaliar(enviar, 'window.__f.cena += 1; if (window.__f.depois) { window.__f.depois(); window.__f.depois = null; }');
    await avaliar(enviar, `(${cena.preparar})()`);
    // Fase 18: o mouse parado num ponto (o :hover do CSS), e de volta ao
    // canto depois da foto, para nao acender nada na cena seguinte.
    if (cena.apontar) {
      const { x, y } = await avaliar(enviar, `(${cena.apontar})()`);
      await enviar('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      // Fase 22: o botao apertado e segurado ate a foto (o :active).
      if (cena.pressionar) await enviar('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      cena.ponto = { x, y };
    }
    // Movimento reduzido: a foto logo depois de preparar mostra se alguma
    // entrada ainda anda.
    await dormir(REDUZIDO ? Math.min(cena.espera, 80) : cena.espera);
    const tela = await enviar('Runtime.evaluate', { expression: 'window.__estado.tela', returnByValue: true });
    const { data } = await enviar('Page.captureScreenshot', { format: 'png' });
    const base = `${String(cena.ordem).padStart(2, '0')}-${cena.nome}-${largura}x${altura}${REDUZIDO ? '-reduzido' : ''}`;
    const arquivo = join(SAIDA, `${base}.png`);
    writeFileSync(arquivo, Buffer.from(data, 'base64'));
    const medida = cena.medir ? `; ${await avaliar(enviar, `(${cena.medir})()`)}` : '';
    if (cena.pressionar) await enviar('Input.dispatchMouseEvent', { type: 'mouseReleased', ...cena.ponto, button: 'left', clickCount: 1 });
    const conferencia = cena.conferir === false ? '' : `; ${await avaliar(enviar, 'window.__f.conferir()')}`;
    if (cena.apontar) await enviar('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    feitas.push({ arquivo, tela: `${tela.result.value}${medida}${conferencia}` });
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

// --------------------------------------------------------------- --hover

// Fase 22, consertos do checkpoint 6: o usuario viu "algumas coisas piscam,
// principalmente quando coloco o mouse sobre elas e depois retiro". Em cada
// tela, o mouse entra em cada peca que reage a ele (vindo de um ponto onde
// nada acende, em passos, como a mao), espera, e sai. O registro diz o que
// comecou, e reprova as duas formas de piscar: uma animacao de ENTRADA
// recomecando (a peca some e volta) e uma transicao em transform, rotate,
// scale ou translate. Esta foi a que o usuario viu: enquanto ela anda, o
// Chrome sobe para outra camada tudo o que e desenhado depois e pode encostar,
// e um papel girado numa camada propria e rasterizado de outro jeito (o
// post-it do menu, o HUD, as cartas vizinhas mudavam de cara no comeco e no
// fim de cada hover; ver o handoff dos consertos do checkpoint 6).
const CENAS_HOVER = ['menu', 'anuncio', 'carta', 'pausa', 'resultado', 'loja', 'jubilado', 'tcc', 'colacao', 'hud-cartela', 'hud-pausa-tooltip', 'telas-loja-vendido-aviso-gasto', 'conferencia-loja-cheia-aviso-longo'];
const ENTRADAS = ['entrar-tela', 'deslizar-carta', 'carimbar'];
const CAMADA = ['transform', 'rotate', 'scale', 'translate'];
const HOVER_PASSOS = 6;
const HOVER_ESPERA = 500;
// Rodada 2 do checkpoint 6: o mouse parado a 1 px da borda de baixo, no meio
// e perto do canto direito (o giro de -1 grau do adesivo levanta esse canto),
// por BORDA_PARADO ms; e o clique que comeca a 1 px da borda de cima (com a
// peca levantada pelo :hover ou pela selecao), nos dois cantos de cima, com o
// botao apertado por BORDA_APERTO ms (o :active desce a peca). Antes, a peca
// e apontada uma vez, direto (sem passar por outra): nas que acendem pelo
// estado (post-it, cartao, folheto, slot) ela fica a selecionada, e e assim
// que o mouse a encontra. Uma que nao estava selecionada sobe ao ser apontada
// pela borda e deixa o cursor embaixo dela UMA vez (duas trocas, e para): nao
// e o vibrar, e e o mesmo no HEAD.
// O clique na faixa de cima do post-it e do cartao (BORDA_RESIDUO) nao
// reprova: a fita, o selo e a escala descem mais do que a margem que da para
// pendurar neles sem desenhar nada (o ::before e o ::after ja sao a fita, o
// percevejo e a volta de caneta). A saida diz se valeu.
const BORDA_BAIXO = [0.5, 0.9];
const BORDA_CIMA = [0.1, 0.9];
const BORDA_PARADO = 1000;
const BORDA_APERTO = 200;
const BORDA_RESIDUO = '.carta-opcao';

async function conferirBorda(enviar, i, neutro, centro) {
  const mouse = (x, y, type = 'mouseMoved') => enviar('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  const partes = [];
  const falhas = [];
  await mouse(centro.x, centro.y);
  await dormir(200);
  const residuo = await avaliar(enviar, `window.__f.alvos[${i}].matches('${BORDA_RESIDUO}')`);
  for (const fx of BORDA_BAIXO) {
    await mouse(neutro.x, neutro.y);
    await dormir(250);
    const p = await avaliar(enviar, `window.__f.borda(${i}, ${fx}, 'baixo')`);
    if (!p) {
      partes.push(`baixo ${fx * 100}%: sem borda`);
      continue;
    }
    // De fora (logo abaixo) para 1 px dentro, e parado.
    await mouse(p.x, p.y + 12);
    await dormir(60);
    await avaliar(enviar, `window.__f.vigiar(${i})`);
    await mouse(p.x, p.y - 1);
    await dormir(BORDA_PARADO);
    const trocas = await avaliar(enviar, 'window.__f.vigiar(null)');
    partes.push(`baixo ${fx * 100}%: ${trocas} troca(s) de :hover`);
    if (trocas > 1) falhas.push(`o mouse parado a 1 px da borda de baixo (x ${fx * 100}%): o :hover trocou ${trocas} vezes em ${BORDA_PARADO} ms (a peca vibra sozinha)`);
  }
  for (const fx of BORDA_CIMA) {
    await mouse(neutro.x, neutro.y);
    await dormir(150);
    await mouse(centro.x, centro.y);
    await dormir(300);
    const p = await avaliar(enviar, `window.__f.borda(${i}, ${fx}, 'cima')`);
    if (!p) {
      partes.push(`cima ${fx * 100}%: sem borda`);
      continue;
    }
    await mouse(p.x, p.y + 1);
    await dormir(150);
    await avaliar(enviar, `window.__f.armarClique(${i})`);
    await mouse(p.x, p.y + 1, 'mousePressed');
    await dormir(BORDA_APERTO);
    await mouse(p.x, p.y + 1, 'mouseReleased');
    await dormir(60);
    const c = await avaliar(enviar, 'window.__f.armarClique(null)');
    partes.push(`clique cima ${fx * 100}%: ${c.dentro === 1 ? 'vale' : `NAO VALE (${c.dentro} na peca, ${c.fora} fora${residuo ? '; residuo conhecido' : ''})`}`);
    if (c.dentro !== 1 && !residuo) falhas.push(`o clique que comeca a 1 px da borda de cima (x ${fx * 100}%) nao vale: ${c.dentro} na peca, ${c.fora} fora (o :active desce a peca para longe do cursor)`);
  }
  return { resumo: partes.join(', '), falhas };
}

async function moverMouse(enviar, de, para) {
  for (let i = 1; i <= HOVER_PASSOS; i += 1) {
    const k = i / HOVER_PASSOS;
    await enviar('Input.dispatchMouseEvent', { type: 'mouseMoved', x: de.x + (para.x - de.x) * k, y: de.y + (para.y - de.y) * k });
    await dormir(16);
  }
}

async function conferirHover(cdp, sessao, url, tamanho, cenas) {
  const [largura, altura] = tamanho;
  const enviar = (metodo, params) => cdp.enviar(metodo, params, sessao);
  await enviar('Emulation.setDeviceMetricsOverride', { width: largura, height: altura, deviceScaleFactor: 1, mobile: false });
  const carregou = cdp.esperarEvento('Page.loadEventFired', sessao);
  await enviar('Page.navigate', { url });
  await carregou;
  for (let i = 0; i < 200; i += 1) {
    if (await avaliar(enviar, '!!window.__estado')) break;
    await dormir(50);
  }
  await avaliar(enviar, `(${ajudantesDaPagina})()`);
  const linhas = [];
  const falhas = [];
  for (const cena of cenas) {
    await avaliar(enviar, 'window.__f.cena += 1; if (window.__f.depois) { window.__f.depois(); window.__f.depois = null; }');
    await avaliar(enviar, `(${cena.preparar})()`);
    // Numa prova, o jogo anda durante o hover inteiro: HP e XP seguros (sem
    // carta subindo nem jubilado no meio).
    await avaliar(enviar, '(() => { const { e } = window.__f; window.__f.repetir(() => { e.player.hp = e.player.hpMax; e.player.xp = 0; }, 1, 1e9); })()');
    await dormir(cena.espera + 600);
    const { neutro, alvos, extras } = await avaliar(enviar, 'window.__f.alvosDoHover()');
    const tela = await avaliar(enviar, 'window.__estado.tela');
    if (!neutro) {
      falhas.push(`${cena.nome}: nenhum ponto neutro`);
      continue;
    }
    await enviar('Input.dispatchMouseEvent', { type: 'mouseMoved', x: neutro.x, y: neutro.y });
    for (const [i, alvo] of alvos.entries()) {
      await dormir(HOVER_ESPERA);
      await avaliar(enviar, 'window.__f.registro.length = 0');
      await moverMouse(enviar, neutro, alvo);
      await dormir(HOVER_ESPERA);
      const entrando = await avaliar(enviar, 'window.__f.registro.splice(0)');
      await moverMouse(enviar, alvo, neutro);
      await dormir(HOVER_ESPERA);
      const saindo = await avaliar(enviar, 'window.__f.registro.splice(0)');
      const resumo = (lista) => (lista.length ? [...new Set(lista.map((r) => `${r.tipo} ${r.no} ${r.nome}`))].join('; ') : 'nada');
      const entrada = [...entrando, ...saindo].filter((r) => (r.tipo === 'animationstart' && ENTRADAS.includes(r.nome)) || (r.tipo === 'transitionrun' && CAMADA.includes(r.nome)));
      if (entrada.length) falhas.push(`${cena.nome} ${largura}x${altura} ${alvo.nome}: ${resumo(entrada)}`);
      const b = await conferirBorda(enviar, i, neutro, alvo);
      for (const f of b.falhas) falhas.push(`${cena.nome} ${largura}x${altura} ${alvo.nome}: ${f}`);
      linhas.push({ arquivo: `hover ${cena.nome} ${largura}x${altura} ${alvo.nome}`, tela: `${tela}; entrando: ${resumo(entrando)} | saindo: ${resumo(saindo)} | borda: ${b.resumo}` });
      await enviar('Input.dispatchMouseEvent', { type: 'mouseMoved', x: neutro.x, y: neutro.y });
    }
    for (const [k, alvo] of extras.entries()) {
      const b = await conferirBorda(enviar, alvos.length + k, neutro, alvo);
      for (const f of b.falhas) falhas.push(`${cena.nome} ${largura}x${altura} ${alvo.nome} (relatorio): ${f}`);
      linhas.push({ arquivo: `borda ${cena.nome} ${largura}x${altura} ${alvo.nome} (relatorio)`, tela: `${tela}; borda: ${b.resumo}` });
      await enviar('Input.dispatchMouseEvent', { type: 'mouseMoved', x: neutro.x, y: neutro.y });
    }
  }
  await enviar('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  return { linhas, falhas };
}

// --------------------------------------------------------------- --jogar

// Fase 22: a run jogada pelo teclado, como o jogador faz, sem tocar no
// estado: Enter nas telas de seguir, WASD em circulo na prova, 1 na carta, a
// loja pelas setas, um ESC no meio de uma prova. Cada troca de tela tira duas
// fotos, na troca e 450 ms depois (a transicao de verdade e o repouso).
const TECLAS = { KeyM: [77, 'm'], Enter: [13, 'Enter'], Escape: [27, 'Escape'], ArrowRight: [39, 'ArrowRight'], ArrowLeft: [37, 'ArrowLeft'], ArrowUp: [38, 'ArrowUp'], Digit1: [49, '1'], KeyW: [87, 'w'], KeyA: [65, 'a'], KeyS: [83, 's'], KeyD: [68, 'd'] };

async function tecla(enviar, code, tipo) {
  const [codigo, key] = TECLAS[code];
  const texto = tipo === 'keyDown' && key.length === 1 ? { text: key } : {};
  await enviar('Input.dispatchKeyEvent', { type: tipo, code, key, windowsVirtualKeyCode: codigo, nativeVirtualKeyCode: codigo, ...texto });
}

async function tocarTecla(enviar, code) {
  await tecla(enviar, code, 'keyDown');
  await dormir(60);
  await tecla(enviar, code, 'keyUp');
}

async function jogarPeloTeclado(cdp, sessao, url) {
  const enviar = (metodo, params) => cdp.enviar(metodo, params, sessao);
  await enviar('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  const carregou = cdp.esperarEvento('Page.loadEventFired', sessao);
  await enviar('Page.navigate', { url });
  await carregou;
  for (let i = 0; i < 200; i += 1) {
    if (await avaliar(enviar, '!!window.__estado')) break;
    await dormir(50);
  }
  await avaliar(enviar, 'document.fonts.ready.then(() => true)');
  if (IMORTAL || SEM_XP || TURBO > 1) {
    await avaliar(enviar, `(async () => {
      const main = await import('/src/main.js');
      const { CONTEUDO } = await import('/data/content.js');
      const e = window.__estado;
      const quadro = () => {
        if (${IMORTAL}) e.player.hp = e.player.hpMax;
        if (${SEM_XP}) e.player.xp = 0;
        for (let i = 1; i < ${TURBO} && e.tela === 'avaliacao'; i += 1) {
          main.atualizar(e, CONTEUDO.loop.passo);
          if (${SEM_XP}) e.player.xp = 0;
        }
        requestAnimationFrame(quadro);
      };
      requestAnimationFrame(quadro);
      return true;
    })()`);
  }
  const feitas = [];
  const inicio = Date.now();
  const relogio = () => ((Date.now() - inicio) / 1000).toFixed(1);
  let n = 0;
  const foto = async (rotulo) => {
    n += 1;
    const { data } = await enviar('Page.captureScreenshot', { format: 'png' });
    const arquivo = join(SAIDA, `jogo-${String(n).padStart(3, '0')}-${rotulo}.png`);
    writeFileSync(arquivo, Buffer.from(data, 'base64'));
    feitas.push({ arquivo, tela: `${relogio()}s` });
  };
  const DIRECOES = ['KeyW', 'KeyD', 'KeyS', 'KeyA'];
  let anterior = null;
  let desde = Date.now();
  let acoes = 0;
  let andando = null;
  let pausou = false;
  let mudou = false;
  let ultimaDaProva = Date.now();
  const soltar = async () => {
    if (andando) await tecla(enviar, andando, 'keyUp');
    andando = null;
  };
  while (Date.now() - inicio < JOGAR_SEGUNDOS * 1000) {
    const tela = await avaliar(enviar, 'window.__estado.tela');
    if (tela !== anterior) {
      await soltar();
      await foto(`${tela}-entrando`);
      await dormir(450);
      await foto(tela);
      anterior = tela;
      desde = Date.now();
      acoes = 0;
      continue;
    }
    const ha = Date.now() - desde;
    const vez = ha > 1200 + 1500 * acoes;
    if (tela === 'avaliacao') {
      const d = DIRECOES[Math.floor(ha / 700) % DIRECOES.length];
      if (d !== andando) {
        await soltar();
        await tecla(enviar, d, 'keyDown');
        andando = d;
      }
      if (!mudou && ha > 5000) {
        // O mudo (M): liga e desliga, conferindo o botao e o que foi gravado.
        mudou = true;
        const ler = "import('/data/content.js').then(({ CONTEUDO }) => JSON.stringify({ classe: document.getElementById('botao-mudo').className, rotulo: document.getElementById('botao-mudo').getAttribute('aria-label'), gravado: localStorage.getItem(CONTEUDO.audio.chaveMudo) }))";
        await tocarTecla(enviar, 'KeyM');
        await dormir(150);
        const ligado = await avaliar(enviar, ler);
        await tocarTecla(enviar, 'KeyM');
        await dormir(150);
        const desligado = await avaliar(enviar, ler);
        feitas.push({ arquivo: 'mudo (M)', tela: `apertado: ${ligado} · de novo: ${desligado}` });
      } else if (!pausou && ha > 15000) {
        pausou = true;
        await soltar();
        await tocarTecla(enviar, 'Escape');
      } else if (Date.now() - ultimaDaProva > 30000) {
        ultimaDaProva = Date.now();
        await foto('avaliacao-jogando');
      }
    } else if (tela === 'pausa' && vez) {
      acoes += 1;
      await tocarTecla(enviar, 'Escape');
    } else if (tela === 'carta' && ha > 700 + 1500 * acoes) {
      acoes += 1;
      await tocarTecla(enviar, 'Digit1');
    } else if (tela === 'loja' && vez) {
      // 1 compra o 1o item (se der); depois as setas levam o cursor ate o
      // "Seguir" e o Enter segue.
      acoes += 1;
      if (acoes === 1) await tocarTecla(enviar, 'Digit1');
      else {
        // Ate o cursor estar no "Seguir" (o botao diz; o estado so e lido):
        // a vitrine tem tamanho variavel e o cursor da a volta.
        for (let i = 0; i < 14; i += 1) {
          const onde = await avaliar(enviar, "document.getElementById('botao-seguir').classList.contains('selecionada') ? 'seguir' : document.querySelector('.loja-slot.selecionada') ? 'slot' : 'vitrine'");
          if (onde === 'seguir') break;
          await tocarTecla(enviar, onde === 'slot' ? 'ArrowUp' : 'ArrowLeft');
        }
        await tocarTecla(enviar, 'Enter');
      }
    } else if (tela !== 'avaliacao' && tela !== 'pausa' && tela !== 'carta' && tela !== 'loja' && vez) {
      acoes += 1;
      await tocarTecla(enviar, 'Enter');
    }
    await dormir(100);
  }
  await soltar();
  const audio = await avaliar(enviar, 'JSON.stringify((window.__audios || []).map((c) => c.state))');
  const telas = await avaliar(enviar, 'window.__estado.tela');
  feitas.push({ arquivo: 'audio', tela: `AudioContext criados: ${audio} (o 1o nasce do 1o gesto); tela no fim: ${telas}` });
  return feitas;
}

// Fase 22: os objetos de mesa (fora da cena) nunca por cima dela, em varias
// proporcoes de janela. A pagina e a da foto da mesa (o menu).
const JANELAS = [[1920, 1080], [2079, 1080], [2100, 1080], [2200, 1080], [2560, 1080], [3440, 1440], [1366, 768], [1280, 1024], [800, 600], [1080, 1920]];

async function conferirMesas(cdp, sessao) {
  const enviar = (metodo, params) => cdp.enviar(metodo, params, sessao);
  const linhas = [];
  for (const [w, h] of JANELAS) {
    await enviar('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await dormir(250);
    const r = await avaliar(enviar, `(${() => {
      const c = document.querySelector('.cena').getBoundingClientRect();
      const objetos = [...document.querySelectorAll('.mesa-objeto')].filter((o) => getComputedStyle(o).display !== 'none' && o.getBoundingClientRect().width > 0);
      const caixa = (o) => o.getBoundingClientRect();
      const sobre = objetos.filter((o) => { const r = caixa(o); return r.right > c.left && r.left < c.right && r.bottom > c.top && r.top < c.bottom; });
      const fora = objetos.filter((o) => { const r = caixa(o); return r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight; });
      const folga = objetos.length ? Math.min(...objetos.map((o) => { const r = caixa(o); return r.right <= c.left ? c.left - r.right : r.left - c.right; })) : null;
      const caixas = objetos.map((o) => { const r = caixa(o); return `${o.className.split(' ')[1]} ${r.left.toFixed(0)}-${r.right.toFixed(0)}`; }).join(', ');
      return `${objetos.length} objeto(s) de mesa a vista, ${sobre.length} por cima da cena, ${fora.length} fora da janela${folga === null ? '' : `, folga minima ate a cena ${folga.toFixed(0)}px`} (cena ${c.left.toFixed(0)}-${c.right.toFixed(0)}${caixas ? `; ${caixas}` : ''})`;
    }})()`);
    linhas.push({ arquivo: `mesa ${w}x${h}`, tela: r });
    if (w === 2200) {
      const { data } = await enviar('Page.captureScreenshot', { format: 'png' });
      const arquivo = join(SAIDA, `${String(MESA.ordem).padStart(2, '0')}-mesa-limite-${w}x${h}.png`);
      writeFileSync(arquivo, Buffer.from(data, 'base64'));
      linhas.push({ arquivo, tela: 'menu, a janela mais estreita com os objetos a vista' });
    }
  }
  return linhas;
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
  const base = HOVER ? CENAS.filter((c) => CENAS_HOVER.includes(c.nome)) : CENAS;
  const cenas = PERF || JOGAR ? [] : SO.length === 0 ? base : base.filter((c) => SO.some((s) => c.nome.includes(s)));
  const comMesa = !PERF && !JOGAR && !HOVER && (SO.length === 0 || SO.some((s) => MESA.nome.includes(s)));
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
      ...(PERF && !ACELERADO ? ['--disable-gpu', '--disable-accelerated-2d-canvas'] : []),
      ...(PERF ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  const saiu = new Promise((ok) => chrome.once('exit', ok));
  const erros = [];
  const avisos = [];
  const feitas = [];
  const piscas = [];
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
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') avisos.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
      // O que o navegador mesmo escreve no console (rede, CSS, violacoes).
      if (m.method === 'Log.entryAdded' && (m.params.entry.level === 'error' || m.params.entry.level === 'warning')) avisos.push(`[${m.params.entry.source}] ${m.params.entry.text}${m.params.entry.url ? ` (${m.params.entry.url})` : ''}`);
    });
    await cdp.enviar('Page.enable', {}, sessionId);
    await cdp.enviar('Runtime.enable', {}, sessionId);
    await cdp.enviar('Log.enable', {}, sessionId);
    // Checkpoint 6: cada AudioContext que a pagina cria (o jogo so pode criar
    // depois de um gesto), para o --jogar dizer em que estado ficaram.
    await cdp.enviar('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const A = window.AudioContext; if (!A) return; window.__audios = []; window.AudioContext = class extends A { constructor(...a) { super(...a); window.__audios.push(this); } }; })()` }, sessionId);
    // A pagina "com foco": sem isto um blur do headless pausaria a prova.
    await cdp.enviar('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    // Fase 22: o prefers-reduced-motion emulado (vale para o CSS e para o
    // matchMedia que o render.js consulta).
    if (REDUZIDO) await cdp.enviar('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
    if (PERF) imprimirDesempenho(await medir(cdp, sessionId, servidor.url));
    else if (JOGAR) feitas.push(...(await jogarPeloTeclado(cdp, sessionId, servidor.url)));
    else if (HOVER) {
      for (const tamanho of TAMANHOS) {
        const { linhas, falhas } = await conferirHover(cdp, sessionId, servidor.url, tamanho, cenas);
        feitas.push(...linhas);
        piscas.push(...falhas);
      }
    }
    else for (const tamanho of TAMANHOS) feitas.push(...(await fotografar(cdp, sessionId, servidor.url, tamanho, cenas)));
    if (comMesa) {
      feitas.push(...(await fotografar(cdp, sessionId, servidor.url, MESA.tamanho, [MESA])));
      feitas.push(...(await conferirMesas(cdp, sessionId)));
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
  if (HOVER) {
    console.log(`fotos --hover: ${feitas.length} pecas apontadas e soltas`);
    if (piscas.length > 0) {
      console.error(`fotos --hover: ${piscas.length} falha(s) com o mouse (entrada recomecando, transicao de transform/rotate/scale/translate, peca vibrando com o mouse parado na borda ou clique na borda de cima que nao vale):`);
      for (const p of piscas) console.error(`  ${p}`);
      codigo = 1;
    }
  } else if (!PERF) console.log(`fotos: ${feitas.filter((f) => f.arquivo.endsWith('.png')).length} em ${SAIDA}`);
  if (orfaos === null) console.warn('fotos: nao deu para listar os processos e conferir orfaos');
  else console.log(`fotos: Chrome fechado pelo protocolo, ${orfaos.length} processo(s) orfao(s)`);
  if (avisos.length > 0) {
    console.warn(`fotos: ${avisos.length} aviso(s) no console da pagina:`);
    for (const a of [...new Set(avisos)]) console.warn(`  ${a}`);
  }
  if (erros.length > 0) {
    console.error(`fotos: ${erros.length} erro(s) no console da pagina:`);
    for (const e of [...new Set(erros)]) console.error(`  ${e}`);
    codigo = 1;
  }
  return codigo;
}

process.exitCode = await principal();
