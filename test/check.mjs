// npm run check — sintaxe de todo .js do projeto, regras estruturais do
// CLAUDE.md e integridade de data/content.js.
// Sai com codigo != 0 dizendo qual arquivo e qual linha falhou.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const PASTAS = ['src', 'data', 'test'];

// Quem pode falar com o navegador. Todo o resto e simulacao pura e precisa
// rodar no node — e essa regra que mantem o smoke test possivel.
const PODE_TOCAR_DOM = new Set(['src/main.js', 'src/ui.js', 'src/render.js', 'src/audio.js']);

const PADROES_DOM = [
  [/\bdocument\s*\./, 'document'],
  [/\bwindow\s*\./, 'window'],
  [/\brequestAnimationFrame\s*\(/, 'requestAnimationFrame'],
  [/\bperformance\s*\.\s*now/, 'performance.now'],
  [/\bgetContext\s*\(/, 'getContext'],
];

const EXTENSOES_BINARIAS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm',
  '.ttf', '.otf', '.woff', '.woff2', '.zip', '.pdf',
];

const erros = [];
const avisos = [];

function listarArquivos(dir, filtro) {
  const achados = [];
  const pilha = [dir];
  while (pilha.length > 0) {
    const atual = pilha.pop();
    let entradas;
    try {
      entradas = readdirSync(atual, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entrada of entradas) {
      const caminho = join(atual, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === '.git' || entrada.name === 'node_modules') continue;
        pilha.push(caminho);
      } else if (!filtro || filtro(caminho)) {
        achados.push(caminho);
      }
    }
  }
  return achados.sort();
}

const ehModulo = (caminho) => ['.js', '.mjs'].includes(extname(caminho));

// ------------------------------------------------------------- 1. sintaxe

const modulos = [];
for (const pasta of PASTAS) {
  const dir = join(RAIZ, pasta);
  try {
    statSync(dir);
  } catch {
    erros.push(`pasta ausente: ${pasta}/`);
    continue;
  }
  modulos.push(...listarArquivos(dir, ehModulo));
}

for (const arquivo of modulos) {
  const r = spawnSync(process.execPath, ['--check', arquivo], { encoding: 'utf8' });
  if (r.status !== 0) {
    const detalhe = (r.stderr || '').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('    at ')).slice(0, 6).join('\n    ');
    erros.push(`sintaxe em ${relative(RAIZ, arquivo)}:\n    ${detalhe}`);
  }
}

// -------------------------------------------- 2. regras estruturais duras

for (const arquivo of modulos) {
  const rel = relative(RAIZ, arquivo).split('\\').join('/');
  if (rel === 'test/check.mjs') continue; // o arquivo das regras cita as regras
  const linhas = readFileSync(arquivo, 'utf8').split('\n');

  linhas.forEach((linha, i) => {
    const n = i + 1;
    const semComentario = linha.replace(/\/\/.*$/, '');

    if (/\bMath\s*\.\s*random\s*\(/.test(semComentario)) {
      erros.push(`${rel}:${n}: Math.random() proibido — todo sorteio passa por src/rng.js`);
    }
    if (/\bfrom\s+['"]https?:/.test(semComentario) || /\bimport\s*\(\s*['"]https?:/.test(semComentario)) {
      erros.push(`${rel}:${n}: import de rede proibido — zero dependencias de runtime`);
    }
    if (rel.startsWith('src/') && !PODE_TOCAR_DOM.has(rel)) {
      for (const [padrao, nome] of PADROES_DOM) {
        if (padrao.test(semComentario)) {
          erros.push(`${rel}:${n}: ${nome} so pode aparecer em ${[...PODE_TOCAR_DOM].join(', ')}`);
        }
      }
    }
  });
}

// ------------------------------------- 3. html e css sem recurso de fora

// Webfont, CDN e @import externo sao o erro que so aparece na apresentacao,
// com a internet ruim ou offline. Nao adianta proibir so no .js: quebra-se
// isso no index.html e no style.css.
const MARCACAO_EXTERNA = [
  [/\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i, 'src/href apontando para fora do projeto'],
  [/\burl\s*\(\s*["']?\s*(?:https?:)?\/\//i, 'url() apontando para fora do projeto'],
  [/@import\s+["']\s*(?:https?:)?\/\//i, '@import de folha externa'],
];

const marcacoes = listarArquivos(RAIZ, (c) => ['.html', '.css'].includes(extname(c).toLowerCase()));
for (const arquivo of marcacoes) {
  const rel = relative(RAIZ, arquivo).split('\\').join('/');
  readFileSync(arquivo, 'utf8').split('\n').forEach((linha, i) => {
    for (const [padrao, nome] of MARCACAO_EXTERNA) {
      if (padrao.test(linha)) {
        erros.push(`${rel}:${i + 1}: ${nome} — zero asset externo, o jogo tem que abrir offline`);
      }
    }
  });
}

// ------------------------------------------------ 4. nenhuma dependencia

const CHAVES_DEPENDENCIA = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
try {
  const bruto = readFileSync(join(RAIZ, 'package.json'), 'utf8');
  const pacote = JSON.parse(bruto);
  const linhaDaChave = (chave) => {
    const pos = bruto.indexOf(`"${chave}"`);
    return pos < 0 ? 1 : bruto.slice(0, pos).split('\n').length;
  };
  for (const chave of CHAVES_DEPENDENCIA) {
    const nomes = Object.keys(pacote[chave] || {});
    if (nomes.length > 0) {
      erros.push(
        `package.json:${linhaDaChave(chave)}: ${chave} tem que ficar vazio (${nomes.join(', ')}) — o jogo roda sem npm install`
      );
    }
  }
  for (const chave of ['check', 'smoke', 'serve']) {
    if (!(pacote.scripts || {})[chave]) erros.push(`package.json: falta o script "${chave}"`);
  }
} catch (e) {
  erros.push(`package.json ilegivel: ${e.message}`);
}

// ------------------------------------------------ 5. nenhum asset binario

for (const arquivo of listarArquivos(RAIZ, (c) => EXTENSOES_BINARIAS.includes(extname(c).toLowerCase()))) {
  erros.push(`asset binario proibido no repositorio: ${relative(RAIZ, arquivo)}`);
}

// --------------------------------------------- 6. integridade do conteudo

if (erros.length === 0) {
  try {
    const mod = await import(pathToFileURL(join(RAIZ, 'data', 'content.js')).href);
    if (typeof mod.validarConteudo !== 'function') {
      erros.push('data/content.js: nao exporta validarConteudo()');
    } else {
      const resultado = mod.validarConteudo();
      erros.push(...(resultado.erros || []).map((e) => `content.js — ${e}`));
      avisos.push(...(resultado.avisos || []).map((a) => `content.js — ${a}`));
    }
  } catch (e) {
    erros.push(`data/content.js nao pode ser importado: ${e.message}`);
  }
}

// --------------------------------------------------------------- relatorio

for (const aviso of avisos) console.log(`  aviso: ${aviso}`);

if (erros.length > 0) {
  console.error(`\ncheck FALHOU — ${erros.length} problema(s):\n`);
  for (const erro of erros) console.error(`  x ${erro}`);
  console.error('');
  process.exit(1);
}

console.log(
  `check ok — ${modulos.length} modulos + ${marcacoes.length} html/css + package.json` +
    ' · sintaxe, regras estruturais, zero externo, content.js'
);
