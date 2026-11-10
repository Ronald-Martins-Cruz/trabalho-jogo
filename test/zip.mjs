// npm run zip — o zip da entrega (Teams), com um jogo que abre com dois cliques.
//
// O professor baixa o zip e da dois cliques no index.html. Por file:// o
// navegador nao carrega modulo de outro arquivo, entao ali so aparece o aviso
// (decisao 28 da v2). O zip leva por isso um jogar-sem-servidor.html: o
// index.html com o style.css e todos os modulos embutidos num unico
// <script type="module"> inline, que o Chrome e o Edge rodam por file:// (o
// que falha la e BUSCAR modulo, nao rodar). Ele so existe dentro do zip: o
// codigo-fonte do jogo nao muda e nao ganha passo de build.
//
//   npm run zip                          gera ../semana-de-provas.zip (fora do
//                                        repositorio: o check reprova .zip aqui)
//   npm run zip -- --saida <arquivo>     outro caminho (tambem fora do repositorio)
//   npm run zip -- --provar              gera, descompacta numa pasta limpa e prova
//                                        la: o check, o smoke e o dom da copia, e num
//                                        Chrome (e no Edge, se houver) o
//                                        jogar-sem-servidor.html por file://, o aviso
//                                        do index.html por file://, e o index.html
//                                        por dois servidores (o serve.mjs da copia e
//                                        um com o MIME e a subpasta do GitHub Pages)
//   npm run zip -- --provar --fotos <pasta>   onde gravar as fotos da prova
//
// Como os modulos viram um script so: cada modulo vira uma funcao geradora.
// Chama-la cria as funcoes declaradas nele (como o navegador faz ao ligar os
// modulos), e o primeiro passo devolve o "namespace" do modulo, com um getter
// por export que le a variavel viva. As importacoes viram variaveis locais
// religadas antes de cada modulo rodar e no fim; os modulos rodam na ordem em
// que o navegador os rodaria (busca em profundidade a partir do index.html,
// na ordem dos import). Assim cada modulo guarda o proprio escopo (ha nomes
// repetidos entre modulos), os imports circulares continuam valendo, e nada
// dentro do codigo de um modulo e reescrito, so as linhas de import e o
// `export` da frente das declaracoes.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opcao = (nome, padrao) => {
  const i = args.indexOf(nome);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : padrao;
};
const SAIDA = resolve(opcao('--saida', join(RAIZ, '..', 'semana-de-provas.zip')));
const PROVAR = args.includes('--provar');
const FOTOS = resolve(opcao('--fotos', join(tmpdir(), 'semana-de-provas-zip-fotos')));

export const ARQUIVO_SEM_SERVIDOR = 'jogar-sem-servidor.html';

// ------------------------------------------------------- o que vai no zip

// O repositorio, menos o que nao e do trabalho: o git, as configuracoes de
// editor e do agente, o todo.md do usuario (decisao do coordenador na fase
// 23) e lixo de sistema. Imagem so dos prints do README (check.mjs secao 5).
const PASTAS_FORA = new Set(['.git', 'node_modules', '.claude', '.vscode', '.idea']);
const ARQUIVOS_FORA = new Set(['todo.md']);
const LIXO = (nome) => nome === '.DS_Store' || nome === 'Thumbs.db' || nome.endsWith('.log') || nome.endsWith('.zip');
const IMAGENS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const PASTA_PRINTS = 'docs/prints/';

export function arquivosDoZip(raiz = RAIZ) {
  const achados = [];
  const pilha = [''];
  while (pilha.length > 0) {
    const rel = pilha.pop();
    for (const entrada of readdirSync(join(raiz, rel), { withFileTypes: true })) {
      const caminho = rel ? `${rel}/${entrada.name}` : entrada.name;
      if (entrada.isDirectory()) {
        if (!PASTAS_FORA.has(entrada.name)) pilha.push(caminho);
      } else if (!ARQUIVOS_FORA.has(caminho) && !LIXO(entrada.name)) {
        if (IMAGENS.has(extname(entrada.name).toLowerCase()) && !caminho.startsWith(PASTA_PRINTS)) {
          throw new Error(`zip: imagem fora de ${PASTA_PRINTS}: ${caminho} (o check reprova)`);
        }
        achados.push(caminho);
      }
    }
  }
  return achados.sort();
}

// ------------------------------------------- os modulos num script so

const NOME = '[A-Za-z_$][\\w$]*';
const IMPORT = /^[ \t]*import\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*(?:\r?\n)?/gm;
const EXPORT = new RegExp(`^export\\s+(?=(?:async\\s+)?function\\*?\\s+(${NOME})|(?:const|class)\\s+(${NOME}))`, 'gm');
const P = '__sdp_'; // prefixo dos nomes do embrulho (nenhum modulo do jogo usa)

// Le um modulo: o que ele importa (de onde, quais nomes), o que exporta, e o
// corpo sem as linhas de import e sem o `export` da frente. Qualquer forma que
// este embrulho nao trata (import com `as`, default, export de lista, `let`
// exportado, que precisaria de ligacao viva de verdade) reprova aqui, em vez
// de virar um jogo quebrado em silencio.
function lerModulo(rel, codigo) {
  const base = rel.includes('/') ? posix.dirname(rel) : '';
  const imports = [];
  let corpo = codigo.replace(IMPORT, (_, lista, de) => {
    const nomes = lista.split(',').map((n) => n.trim()).filter(Boolean);
    for (const n of nomes) if (!new RegExp(`^${NOME}$`).test(n)) throw new Error(`zip: ${rel}: import { ${n} } — forma que o embrulho nao trata`);
    if (!de.startsWith('.')) throw new Error(`zip: ${rel}: import de '${de}', que nao e um arquivo do projeto`);
    imports.push({ de: posix.normalize(posix.join(base, de)), nomes });
    return '';
  });
  if (/^\s*import\b/m.test(corpo) || /\bimport\s*\(/.test(corpo) || /\bimport\.meta\b/.test(corpo)) throw new Error(`zip: ${rel}: import de uma forma que o embrulho nao trata`);
  const exports = [];
  corpo = corpo.replace(EXPORT, (_, fn, decl) => {
    exports.push(fn || decl);
    return '';
  });
  if (/^\s*export\b/m.test(corpo)) throw new Error(`zip: ${rel}: export de uma forma que o embrulho nao trata (so function, const e class)`);
  if (corpo.includes(P)) throw new Error(`zip: ${rel}: usa o prefixo ${P}, reservado ao embrulho`);
  return { rel, imports, exports, corpo };
}

// A ordem em que o navegador roda os modulos: busca em profundidade a partir
// da entrada, na ordem dos import, e cada modulo depois das suas dependencias
// (um ciclo e cortado onde volta a um modulo que ja esta sendo visitado).
function ordemDosModulos(entrada, ler) {
  const modulos = new Map();
  const ordem = [];
  const visitar = (rel) => {
    if (modulos.has(rel)) return;
    const m = ler(rel);
    modulos.set(rel, m);
    for (const { de } of m.imports) visitar(de);
    ordem.push(m);
  };
  visitar(entrada);
  for (const m of ordem) {
    for (const { de, nomes } of m.imports) {
      const alvo = modulos.get(de);
      for (const n of nomes) if (!alvo.exports.includes(n)) throw new Error(`zip: ${m.rel} importa ${n} de ${de}, que nao o exporta`);
    }
  }
  return ordem;
}

export function scriptUnico(raiz = RAIZ, entrada = { rel: 'index.html', codigo: '' }, { expor = false } = {}) {
  const ler = (rel) => lerModulo(rel, rel === entrada.rel ? entrada.codigo : readFileSync(join(raiz, rel), 'utf8'));
  const ordem = ordemDosModulos(entrada.rel, ler);
  const partes = [
    '// Gerado por test/zip.mjs: os modulos do jogo num script so (veja o comeco',
    '// daquele arquivo). Nao edite: o codigo de verdade esta em src/ e data/.',
    `const ${P}ns = Object.create(null);`,
    `const ${P}religar = [];`,
    `const ${P}ler = (ns, nome) => { try { return ns[nome]; } catch { return undefined; } };`,
  ];
  ordem.forEach((m, i) => {
    partes.push('', `// ---------------------------------------------------------------- ${m.rel}`, `function* ${P}m${i}() {`);
    const locais = m.imports.flatMap((im) => im.nomes);
    if (locais.length > 0) {
      partes.push(`let ${locais.join(', ')};`);
      const ligacoes = m.imports.flatMap((im) => im.nomes.map((n) => `${n} = ${P}ler(${P}ns[${JSON.stringify(im.de)}], '${n}');`));
      partes.push(`${P}religar.push(() => { ${ligacoes.join(' ')} });`);
    }
    partes.push(`yield {${m.exports.map((n) => ` get ${n}() { return ${n}; }`).join(',')} };`);
    partes.push(m.corpo.replace(/\s+$/, ''), '}');
  });
  partes.push(
    '',
    '// Ligar (as funcoes de todos os modulos passam a existir), depois rodar cada',
    '// modulo na ordem, com as importacoes religadas antes de cada um e no fim.',
    `const ${P}modulos = [${ordem.map((_, i) => `${P}m${i}()`).join(', ')}];`,
    `const ${P}nomes = ${JSON.stringify(ordem.map((m) => m.rel))};`,
    `${P}modulos.forEach((g, i) => { ${P}ns[${P}nomes[i]] = g.next().value; });`,
    `for (const g of ${P}modulos) { for (const f of ${P}religar) f(); g.next(); }`,
    `for (const f of ${P}religar) f();`,
    // So na prova (--provar): os namespaces a vista, para comparar com os modulos.
    ...(expor ? [`globalThis.${P}ns = ${P}ns;`] : []),
    ''
  );
  return { js: partes.join('\n'), modulos: ordem.map((m) => m.rel) };
}

const LINK_CSS = /<link rel="stylesheet" href="style\.css">/;
const SCRIPT_MODULO = /<script type="module">([\s\S]*?)<\/script>/;
const AVISO = /[ \t]*<div id="aviso-sem-servidor"[^>]*>[\s\S]*?<\/div>\r?\n/;

// O index.html com o style.css num <style> e os modulos no script inline. O
// aviso de servidor sai: aqui ele nunca seria verdade.
export function htmlSemServidor(raiz = RAIZ, { expor = false } = {}) {
  const html = readFileSync(join(raiz, 'index.html'), 'utf8');
  const css = readFileSync(join(raiz, 'style.css'), 'utf8');
  const script = SCRIPT_MODULO.exec(html);
  if (!LINK_CSS.test(html)) throw new Error('zip: nao achei o <link> do style.css no index.html');
  if (!script) throw new Error('zip: nao achei o <script type="module"> do index.html');
  if (!AVISO.test(html)) throw new Error('zip: nao achei o <div id="aviso-sem-servidor"> do index.html');
  if ((html.match(/<script\b/g) || []).length !== 1) throw new Error('zip: o index.html tem mais de um <script>; o embrulho so conhece um');
  const { js, modulos } = scriptUnico(raiz, { rel: 'index.html', codigo: script[1] }, { expor });
  // Dentro de <script> e <style> o HTML so procura o fechamento (e `<!--`
  // muda a leitura do script): se aparecessem, o arquivo seria cortado.
  if (/<\/script|<!--/i.test(js)) throw new Error('zip: o codigo tem "</script" ou "<!--", que cortaria o script inline');
  if (/<\/style/i.test(css)) throw new Error('zip: o style.css tem "</style"');
  const cabeca = [
    '<!-- Gerado por test/zip.mjs (npm run zip) a partir do index.html, do style.css',
    `     e dos modulos de src/ e data/ (${modulos.length - 1} arquivos), so para o zip: abre com dois`,
    '     cliques, sem servidor. Nao edite: o jogo de verdade e o index.html. -->',
  ].join('\n');
  const saida = html
    .replace(/^<!DOCTYPE html>\r?\n/i, (d) => `${d}${cabeca}\n`)
    .replace(LINK_CSS, () => `<style>\n${css}\n</style>`)
    .replace(AVISO, '')
    .replace(SCRIPT_MODULO, () => `<script type="module">\n${js}</script>`);
  return { html: saida, js, modulos };
}

// O script inline tem que ser JS de modulo valido: o node confere a sintaxe
// (e um nome repetido no mesmo escopo e erro de sintaxe em modulo).
function conferirSintaxe(js) {
  const pasta = mkdtempSync(join(tmpdir(), 'semana-de-provas-zip-js-'));
  try {
    const arquivo = join(pasta, 'script.mjs');
    writeFileSync(arquivo, js);
    const r = spawnSync(process.execPath, ['--check', arquivo], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`zip: o script inline nao passa no node --check:\n${r.stderr}`);
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- o zip

const TABELA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = TABELA_CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dataDos(d) {
  const ano = Math.max(1980, d.getFullYear());
  return {
    hora: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    dia: ((ano - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Um zip comum: deflate (zlib do proprio node) quando encolhe, senao guardado;
// nomes em UTF-8 (bit 11). Sem pastas como entradas: o caminho basta.
export function montarZip(entradas) {
  const locais = [];
  const centrais = [];
  let deslocamento = 0;
  for (const { nome, dados, quando } of entradas) {
    const nomeBuf = Buffer.from(nome, 'utf8');
    const comprimido = deflateRawSync(dados, { level: 9 });
    const metodo = comprimido.length < dados.length ? 8 : 0;
    const corpo = metodo === 8 ? comprimido : dados;
    const crc = crc32(dados);
    const { hora, dia } = dataDos(quando);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(metodo, 8);
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(dia, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(corpo.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(nomeBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(metodo, 10);
    central.writeUInt16LE(hora, 12);
    central.writeUInt16LE(dia, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(corpo.length, 20);
    central.writeUInt32LE(dados.length, 24);
    central.writeUInt16LE(nomeBuf.length, 28);
    central.writeUInt32LE(deslocamento, 42);
    locais.push(local, nomeBuf, corpo);
    centrais.push(central, nomeBuf);
    deslocamento += local.length + nomeBuf.length + corpo.length;
  }
  const diretorio = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(entradas.length, 8);
  fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(deslocamento, 16);
  return Buffer.concat([...locais, diretorio, fim]);
}

// Le de volta (pelo diretorio central, como o Windows le) e confere o CRC de
// cada arquivo: o zip que sai daqui foi aberto ao menos uma vez.
export function lerZip(zip) {
  const fim = zip.length - 22;
  if (zip.readUInt32LE(fim) !== 0x06054b50) throw new Error('zip: sem o fim do diretorio central');
  const total = zip.readUInt16LE(fim + 10);
  let p = zip.readUInt32LE(fim + 16);
  const arquivos = [];
  for (let i = 0; i < total; i += 1) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error(`zip: entrada ${i} do diretorio central corrompida`);
    const metodo = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const tamanho = zip.readUInt32LE(p + 20);
    const nomeLen = zip.readUInt16LE(p + 28);
    const extra = zip.readUInt16LE(p + 30);
    const comentario = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const nome = zip.toString('utf8', p + 46, p + 46 + nomeLen);
    const inicio = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const bruto = zip.subarray(inicio, inicio + tamanho);
    const dados = metodo === 8 ? inflateRawSync(bruto) : Buffer.from(bruto);
    if (crc32(dados) !== crc) throw new Error(`zip: CRC errado em ${nome}`);
    arquivos.push({ nome, dados });
    p += 46 + nomeLen + extra + comentario;
  }
  return arquivos;
}

export function gerarZip(raiz = RAIZ) {
  const lista = arquivosDoZip(raiz);
  if (lista.includes(ARQUIVO_SEM_SERVIDOR)) throw new Error(`zip: ${ARQUIVO_SEM_SERVIDOR} existe no repositorio; ele so pode nascer aqui`);
  const { html, js, modulos } = htmlSemServidor(raiz);
  conferirSintaxe(js);
  const entradas = lista.map((nome) => ({ nome, dados: readFileSync(join(raiz, nome)), quando: statSync(join(raiz, nome)).mtime }));
  entradas.push({ nome: ARQUIVO_SEM_SERVIDOR, dados: Buffer.from(html, 'utf8'), quando: new Date() });
  entradas.sort((a, b) => a.nome.localeCompare(b.nome));
  const zip = montarZip(entradas);
  const lidos = lerZip(zip);
  if (lidos.length !== entradas.length || lidos.some((l, i) => l.nome !== entradas[i].nome || !l.dados.equals(entradas[i].dados))) {
    throw new Error('zip: o zip lido de volta nao bate com o que foi escrito');
  }
  return { zip, entradas, modulos, bytesHtml: Buffer.byteLength(html) };
}

// ------------------------------------------------------------ a prova

function descompactar(zip, pasta) {
  for (const { nome, dados } of lerZip(zip)) {
    const destino = join(pasta, ...nome.split('/'));
    if (relative(pasta, destino).startsWith('..')) throw new Error(`zip: caminho para fora da pasta: ${nome}`);
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, dados);
  }
}

function rodarNaCopia(pasta, script, extra = []) {
  const r = spawnSync(process.execPath, [...extra, join(pasta, 'test', script)], { cwd: pasta, encoding: 'utf8' });
  const ultima = (r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  return { ok: r.status === 0, linha: r.status === 0 ? ultima : `${ultima}\n${(r.stderr || '').trim().split('\n').slice(-6).join('\n')}` };
}

function acharNavegadores() {
  const achados = [];
  const tentar = (nome, caminhos) => {
    const c = caminhos.find((x) => x && existsSync(x));
    if (c) achados.push({ nome, caminho: c });
  };
  if (platform() === 'win32') {
    const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA];
    tentar('Chrome', [process.env.CHROME, ...bases.map((b) => b && join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'))]);
    tentar('Edge', bases.map((b) => b && join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe')));
  } else if (platform() === 'darwin') {
    tentar('Chrome', [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
    tentar('Edge', ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']);
  } else {
    tentar('Chrome', [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']);
    tentar('Edge', ['/usr/bin/microsoft-edge']);
  }
  return achados;
}

const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

// O mesmo cliente minimo do protocolo de depuracao do fotos.mjs.
async function abrirNavegador(caminho) {
  const perfil = mkdtempSync(join(tmpdir(), 'semana-de-provas-zip-perfil-'));
  const processo = spawn(caminho, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${perfil}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio',
    '--window-size=1920,1080', 'about:blank',
  ], { stdio: 'ignore' });
  const saiu = new Promise((ok) => processo.once('exit', ok));
  let url = null;
  for (let i = 0; i < 300 && !url; i += 1) {
    const arq = join(perfil, 'DevToolsActivePort');
    if (existsSync(arq)) {
      const [porta, caminhoWs] = readFileSync(arq, 'utf8').split(/\r?\n/);
      if (porta && caminhoWs) url = `ws://127.0.0.1:${porta}${caminhoWs}`;
    }
    if (!url) await dormir(50);
  }
  if (!url) throw new Error('o navegador nao abriu o protocolo de depuracao em 15s');
  const ws = new WebSocket(url);
  await new Promise((ok, erro) => { ws.onopen = ok; ws.onerror = () => erro(new Error(`nao conectou em ${url}`)); });
  let id = 0;
  const pendentes = new Map();
  const ouvintes = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && pendentes.has(m.id)) {
      const p = pendentes.get(m.id);
      pendentes.delete(m.id);
      if (m.error) p.erro(new Error(`${p.metodo}: ${m.error.message}`));
      else p.ok(m.result);
    } else if (m.method) for (const f of ouvintes) f(m);
  };
  const enviar = (metodo, params = {}, sessionId = undefined) => new Promise((ok, erro) => {
    id += 1;
    pendentes.set(id, { ok, erro, metodo });
    ws.send(JSON.stringify(sessionId ? { id, method: metodo, params, sessionId } : { id, method: metodo, params }));
  });
  const fechar = async () => {
    try { await Promise.race([enviar('Browser.close'), dormir(3000)]); } catch { /* ja fechou */ }
    await Promise.race([saiu, dormir(5000)]);
    if (processo.exitCode === null) processo.kill();
    for (let i = 0; i < 10; i += 1) {
      try { rmSync(perfil, { recursive: true, force: true }); break; } catch { await dormir(300); }
    }
  };
  return { enviar, ouvir: (f) => ouvintes.add(f), fechar };
}

const TECLAS = { Enter: [13, 'Enter'], Escape: [27, 'Escape'], KeyT: [84, 'T'], KeyW: [87, 'w'], KeyA: [65, 'a'], KeyS: [83, 's'], KeyD: [68, 'd'] };

// Uma aba nova, com o console escutado; `visita(url)` navega e devolve as
// ferramentas para conduzir o jogo pelo teclado.
async function abrirAba(nav) {
  const { targetId } = await nav.enviar('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await nav.enviar('Target.attachToTarget', { targetId, flatten: true });
  const enviar = (metodo, params) => nav.enviar(metodo, params, sessionId);
  const erros = [];
  nav.ouvir((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') erros.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') erros.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') erros.push(`[${m.params.entry.source}] ${m.params.entry.text}${m.params.entry.url ? ` (${m.params.entry.url})` : ''}`);
  });
  await enviar('Page.enable');
  await enviar('Runtime.enable');
  await enviar('Log.enable');
  await enviar('Emulation.setFocusEmulationEnabled', { enabled: true });
  await enviar('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  const avaliar = async (expressao) => {
    const r = await enviar('Runtime.evaluate', { expression: expressao, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`na pagina: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  // modificadores: 8 e o Shift (protocolo de depuracao).
  const tecla = async (code, tipo, modifiers = 0) => {
    const [codigo, key] = TECLAS[code];
    const texto = tipo === 'keyDown' && key.length === 1 ? { text: key } : {};
    await enviar('Input.dispatchKeyEvent', { type: tipo, code, key, modifiers, windowsVirtualKeyCode: codigo, nativeVirtualKeyCode: codigo, ...texto });
  };
  const tocar = async (code, modifiers = 0) => {
    await tecla(code, 'keyDown', modifiers);
    await dormir(60);
    await tecla(code, 'keyUp', modifiers);
  };
  const foto = async (arquivo) => {
    const { data } = await enviar('Page.captureScreenshot', { format: 'png' });
    writeFileSync(arquivo, Buffer.from(data, 'base64'));
    return arquivo;
  };
  const visita = async (url) => {
    const carregou = new Promise((ok) => {
      const f = (m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { ok(); } };
      nav.ouvir(f);
    });
    await enviar('Page.navigate', { url });
    await Promise.race([carregou, dormir(15000)]);
  };
  const fechar = () => nav.enviar('Target.closeTarget', { targetId });
  return { erros, avaliar, tecla, tocar, foto, visita, fechar };
}

// Que camada esta na tela (a primeira .camada visivel, sem o HUD) e se o HUD
// esta: e como a prova sabe onde o jogo esta sem mexer no estado.
const TELA_NA_PAGINA = `(() => {
  const ve = (e) => e && !e.classList.contains('oculto') && getComputedStyle(e).display !== 'none';
  const camadas = [...document.querySelectorAll('.camada')].filter((e) => e.id !== 'hud' && ve(e)).map((e) => e.id);
  return camadas.length > 0 ? camadas.join('+') : (ve(document.getElementById('hud')) ? 'avaliacao' : 'nenhuma');
})()`;

// O caminho do jogador pelo teclado: o menu com o estilo do caderno, Enter
// (o anuncio), Enter (a prova), alguns segundos andando, Esc (a pausa).
// Com `demo`, o atalho de demonstracao: Shift+T no menu leva a tela do TCC,
// e Enter a defesa.
async function jogarAteAPausa(aba, rotulo, { demo = false } = {}) {
  const passos = [];
  const tela = () => aba.avaliar(TELA_NA_PAGINA);
  const esperarTela = async (alvo, apertar, ms = 12000) => {
    const ate = Date.now() + ms;
    while (Date.now() < ate) {
      const t = await tela();
      if (t === alvo) return true;
      if (apertar && t !== 'avaliacao') await aba.tocar(...(Array.isArray(apertar) ? apertar : [apertar]));
      await dormir(apertar ? 450 : 100);
    }
    throw new Error(`${rotulo}: nao chegou em "${alvo}" (ficou em "${await tela()}")`);
  };
  await aba.avaliar('document.fonts.ready.then(() => true)');
  for (let i = 0; i < 100 && (await aba.avaliar('document.documentElement.classList.contains("carregando")')); i += 1) await dormir(50);
  const estilo = await aba.avaliar(`(() => {
    const raiz = getComputedStyle(document.documentElement);
    const titulo = getComputedStyle(document.querySelector('#menu .titulo'));
    return { carregando: document.documentElement.classList.contains('carregando'), papel: raiz.getPropertyValue('--papel').trim(),
      fundo: getComputedStyle(document.body).backgroundColor, fonte: titulo.fontFamily, visivel: getComputedStyle(document.body).visibility };
  })()`);
  if (estilo.carregando || !estilo.papel || estilo.visivel !== 'visible' || estilo.fundo === 'rgba(0, 0, 0, 0)') {
    throw new Error(`${rotulo}: o menu nao saiu com o estilo do caderno (${JSON.stringify(estilo)})`);
  }
  await esperarTela('menu');
  passos.push(await aba.foto(join(FOTOS, `${rotulo}-1-menu.png`)));
  await esperarTela(demo ? 'tcc' : 'anuncio', demo ? ['KeyT', 8] : 'Enter');
  await dormir(600);
  passos.push(await aba.foto(join(FOTOS, `${rotulo}-2-${demo ? 'tcc' : 'anuncio'}.png`)));
  await esperarTela('avaliacao', 'Enter');
  for (const code of ['KeyD', 'KeyS', 'KeyA', 'KeyW']) {
    await aba.tecla(code, 'keyDown');
    await dormir(900);
    await aba.tecla(code, 'keyUp');
    // Uma carta de nivel no meio do caminho: Enter escolhe e a prova segue.
    if ((await tela()) === 'carta') await esperarTela('avaliacao', 'Enter');
  }
  const desenhou = await aba.avaliar(`(() => {
    const c = document.getElementById('palco');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const cores = new Set();
    for (let i = 0; i < d.length; i += 4 * 997) cores.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return cores.size;
  })()`);
  if (desenhou < 8) throw new Error(`${rotulo}: o canvas da prova tem so ${desenhou} cores na amostra (nao desenhou?)`);
  passos.push(await aba.foto(join(FOTOS, `${rotulo}-3-prova.png`)));
  if ((await tela()) === 'carta') await esperarTela('avaliacao', 'Enter');
  await aba.tocar('Escape');
  await esperarTela('pausa');
  await dormir(400);
  passos.push(await aba.foto(join(FOTOS, `${rotulo}-4-pausa.png`)));
  return { passos, cores: desenhou };
}

// Roda na pagina (vai como texto), com `obter(rel)` devolvendo o namespace de
// um modulo: uma partida com bot andando em circulo e o HP segurado, como a
// do fotos.mjs, e a marca (tela e hash do estado inteiro) de cada trecho.
const SIMULACAO = `async (obter) => {
  const [state, run, main, cards, content] = await Promise.all(['src/state.js', 'src/run.js', 'src/main.js', 'src/cards.js', 'data/content.js'].map(obter));
  const C = content.CONTEUDO;
  const passo = C.loop.passo;
  const e = state.novoEstado(20261110);
  let volta = 0;
  const avancar = (segundos) => {
    for (let i = 0, n = Math.round(segundos / passo); i < n; i += 1) {
      volta += 1;
      const a = (volta / 240) * 2 * Math.PI;
      e.input.eixoX = Math.cos(a);
      e.input.eixoY = Math.sin(a);
      e.player.hp = e.player.hpMax;
      main.atualizar(e, passo);
      if (e.tela === state.TELAS.CARTA) cards.escolherCarta(e, 0);
      e.eventos.length = 0;
    }
  };
  const marca = () => {
    const s = JSON.stringify(e);
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return e.tela + ':' + (h >>> 0).toString(16);
  };
  const marcas = [];
  run.iniciarRun(e);
  run.comecarAvaliacao(e, 0, 0);
  avancar(65);
  marcas.push(marca());
  const ultimo = C.periodos.length - 1;
  run.iniciarRun(e);
  run.comecarAvaliacao(e, ultimo, C.periodos[ultimo].avaliacoes.length - 1);
  avancar(65);
  marcas.push(marca());
  run.avancarRun(e);
  run.comecarTcc(e);
  avancar(90);
  marcas.push(marca());
  return marcas;
}`;

// O aviso de servidor: quanto tempo a prova espera alem dos 3s do style.css.
const ESPERA_AVISO = 4500;
const AVISO_NA_PAGINA = `(() => {
  const a = document.getElementById('aviso-sem-servidor');
  if (!a) return { existe: false };
  const s = getComputedStyle(a);
  return { existe: true, visivel: s.display !== 'none' && s.visibility === 'visible', carregando: document.documentElement.classList.contains('carregando') };
})()`;

// Um servidor como o GitHub Pages: o site numa subpasta (o nome do
// repositorio), .js como application/javascript, 404 para o que nao existe,
// e so os arquivos que o workflow publica (lidos do `cp` do pages.yml).
function servidorComoPages(pasta, subpasta) {
  const cp = /cp -r ([^\n]+?) _site\//.exec(readFileSync(join(pasta, '.github', 'workflows', 'pages.yml'), 'utf8'));
  if (!cp) throw new Error('zip: nao achei o cp do site no .github/workflows/pages.yml');
  const publicados = cp[1].trim().split(/\s+/);
  const publicado = (rel) => publicados.some((p) => rel === p || rel.startsWith(`${p}/`));
  const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
  const servidor = createServer((req, res) => {
    const caminho = decodeURIComponent((req.url || '/').split('?')[0]);
    if (!caminho.startsWith(`/${subpasta}/`)) return res.writeHead(404).end('404');
    let rel = caminho.slice(subpasta.length + 2) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const arquivo = join(pasta, ...rel.split('/'));
    if (!publicado(rel) || relative(pasta, arquivo).startsWith('..') || !existsSync(arquivo) || statSync(arquivo).isDirectory()) return res.writeHead(404).end('404');
    res.writeHead(200, { 'content-type': tipos[extname(arquivo).toLowerCase()] || 'application/octet-stream' });
    return res.end(readFileSync(arquivo));
  });
  return new Promise((ok) => servidor.listen(0, '127.0.0.1', () => ok({
    publicados,
    url: `http://127.0.0.1:${servidor.address().port}/${subpasta}/`,
    fechar: () => new Promise((f) => servidor.close(f)),
  })));
}

async function provar(zip) {
  const linhas = [];
  let falhou = false;
  const ok = (texto) => linhas.push(`  ok   ${texto}`);
  const falha = (texto) => { falhou = true; linhas.push(`  FALHA ${texto}`); };
  const pasta = mkdtempSync(join(tmpdir(), 'semana-de-provas-zip-copia-'));
  mkdirSync(FOTOS, { recursive: true });
  descompactar(zip, pasta);
  linhas.push(`descompactado em ${pasta}`);
  const presentes = arquivosDoZip(pasta);
  for (const nome of ['index.html', ARQUIVO_SEM_SERVIDOR, 'README.md', 'LICENSE', 'style.css', 'src/main.js', 'data/content.js', 'package.json']) {
    if (presentes.includes(nome)) continue;
    falha(`falta ${nome} no zip`);
  }
  for (const nome of lerZip(zip).map((a) => a.nome)) {
    if (nome === 'todo.md' || /^(\.git|\.claude|node_modules)\//.test(nome)) falha(`${nome} nao devia estar no zip`);
  }
  // O check da copia le o jogar-sem-servidor.html junto com os outros .html
  // (secao 3: nenhum src/href/url para fora); o smoke e o dom provam que o
  // zip leva tudo o que o jogo precisa.
  for (const [script, extra] of [['check.mjs', []], ['smoke.mjs', []], ['dom.mjs', ['--expose-gc']]]) {
    const r = rodarNaCopia(pasta, script, extra);
    if (r.ok) ok(`${script} na copia: ${r.linha}`);
    else falha(`${script} na copia:\n${r.linha}`);
  }

  const navegadores = acharNavegadores();
  if (navegadores.length === 0) {
    falha('nenhum Chrome nem Edge nesta maquina: a prova no navegador nao rodou (defina CHROME=<caminho>)');
  }
  const { servir } = await import(pathToFileURL(join(pasta, 'test', 'serve.mjs')).href);
  const local = await servir({ porta: 0, host: '127.0.0.1' });
  const pages = await servidorComoPages(pasta, 'trabalho-jogo');
  linhas.push(`servidor como o Pages em ${pages.url}: so ${pages.publicados.join(', ')} (o cp do pages.yml), .js como application/javascript`);
  const semServidor = pathToFileURL(join(pasta, ARQUIVO_SEM_SERVIDOR)).href;
  const indexArquivo = pathToFileURL(join(pasta, 'index.html')).href;
  const exposto = join(pasta, 'jogar-sem-servidor-exposto.html');
  writeFileSync(exposto, htmlSemServidor(pasta, { expor: true }).html);
  try {
    for (const [n, { nome, caminho }] of navegadores.entries()) {
      const nav = await abrirNavegador(caminho);
      try {
        // A mesma partida, com a mesma semente, no script unico (por file://)
        // e nos modulos (pelo servidor): o embrulho nao muda um numero.
        if (n === 0) {
          const marcas = [];
          for (const [url, obter] of [[pathToFileURL(exposto).href, '(rel) => window.__sdp_ns[rel]'], [local.url, '(rel) => import(`./${rel}`)']]) {
            const aba = await abrirAba(nav);
            try {
              await aba.visita(url);
              marcas.push(await aba.avaliar(`(${SIMULACAO})(${obter})`));
            } finally {
              await aba.fechar().catch(() => {});
            }
          }
          const [unico, modulos] = marcas.map((m) => m.join(' · '));
          if (unico === modulos) ok(`${nome}: a mesma partida (1a avaliacao, ultima do 3o periodo, TCC) da o mesmo estado no script unico e nos modulos: ${unico}`);
          else falha(`${nome}: o script unico diverge dos modulos:\n      unico   ${unico}\n      modulos ${modulos}`);
        }
        const casos = [
          { rotulo: `${nome.toLowerCase()}-arquivo-sem-servidor`, url: semServidor, jogar: true, aviso: 'ausente' },
          { rotulo: `${nome.toLowerCase()}-arquivo-index`, url: indexArquivo, jogar: false, aviso: 'visivel' },
          { rotulo: `${nome.toLowerCase()}-serve-index`, url: local.url, jogar: true, aviso: 'escondido' },
          { rotulo: `${nome.toLowerCase()}-pages-index`, url: pages.url, jogar: true, aviso: 'escondido' },
          // O atalho de demonstracao (debug.atalhoDemo), do jeito que a apresentacao o usaria.
          { rotulo: `${nome.toLowerCase()}-arquivo-sem-servidor-atalho`, url: semServidor, jogar: true, aviso: 'ausente', demo: true },
        ];
        for (const caso of casos) {
          const aba = await abrirAba(nav);
          try {
            await aba.visita(caso.url);
            if (caso.jogar) {
              const { passos, cores } = await jogarAteAPausa(aba, caso.rotulo, { demo: caso.demo });
              await dormir(Math.max(0, ESPERA_AVISO - 4000));
              const aviso = await aba.avaliar(AVISO_NA_PAGINA);
              const avisoOk = caso.aviso === 'ausente' ? !aviso.existe : aviso.existe && !aviso.visivel;
              if (!avisoOk) throw new Error(`${caso.rotulo}: aviso de servidor ${JSON.stringify(aviso)}, esperava ${caso.aviso}`);
              if (aba.erros.length > 0) throw new Error(`${caso.rotulo}: ${aba.erros.length} erro(s) no console:\n      ${aba.erros.join('\n      ')}`);
              ok(`${nome}, ${caso.url}: menu com estilo → ${caso.demo ? 'Shift+T → TCC → defesa' : 'anuncio → prova'} (${cores} cores no canvas) → pausa, zero erro no console, aviso ${caso.aviso}; fotos ${passos.map((p) => relative(FOTOS, p)).join(', ')}`);
            } else {
              const cedo = await aba.avaliar(AVISO_NA_PAGINA);
              await dormir(ESPERA_AVISO);
              const aviso = await aba.avaliar(AVISO_NA_PAGINA);
              const foto = await aba.foto(join(FOTOS, `${caso.rotulo}-aviso.png`));
              if (cedo.visivel || !aviso.visivel || !aviso.carregando) throw new Error(`${caso.rotulo}: aviso logo ao abrir ${JSON.stringify(cedo)}, depois da espera ${JSON.stringify(aviso)}`);
              ok(`${nome}, ${caso.url}: os modulos nao carregam (${aba.erros.length} erro(s) do navegador, o esperado) e o aviso aparece depois da espera, nao antes; foto ${relative(FOTOS, foto)}`);
            }
          } catch (e) {
            falha(e.message);
          } finally {
            await aba.fechar().catch(() => {});
          }
        }
      } finally {
        await nav.fechar();
      }
    }
  } finally {
    await local.fechar();
    await pages.fechar();
  }
  linhas.push(`fotos em ${FOTOS}`);
  rmSync(pasta, { recursive: true, force: true });
  return { linhas, falhou };
}

// ------------------------------------------------------------ principal

async function principal() {
  const dentro = relative(RAIZ, SAIDA);
  if (!dentro.startsWith('..') && !isAbsolute(dentro)) {
    console.error(`zip: --saida ${SAIDA} esta dentro do repositorio (o check reprova .zip aqui). Use um caminho de fora.`);
    return 1;
  }
  const { zip, entradas, modulos, bytesHtml } = gerarZip();
  mkdirSync(dirname(SAIDA), { recursive: true });
  writeFileSync(SAIDA, zip);
  console.log(`zip ok — ${SAIDA}: ${entradas.length} arquivos, ${(zip.length / 1024).toFixed(0)} KB; ${ARQUIVO_SEM_SERVIDOR} com ${modulos.length - 1} modulos e o style.css (${(bytesHtml / 1024).toFixed(0)} KB)`);
  if (!PROVAR) return 0;
  const { linhas, falhou } = await provar(readFileSync(SAIDA));
  console.log(linhas.join('\n'));
  console.log(falhou ? 'zip --provar: FALHOU' : 'zip --provar ok');
  return falhou ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().then((codigo) => process.exit(codigo), (e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
