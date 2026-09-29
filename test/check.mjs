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
  // /\r?\n/ e nao '\n': com core.autocrlf o checkout no Windows traz CRLF, o
  // `.` do regex de comentario abaixo nao casa o \r e um comentario que CITA
  // Math.random() virava violacao (rng.js:1 num clone limpo).
  const linhas = readFileSync(arquivo, 'utf8').split(/\r?\n/);

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

// ------------------------------------- 7. regras puras da nota (run.js)

// calcularNota e a unica conta do jogo que o jogador ve em numero na tela, e
// ela nao depende de simulacao nenhuma — entao mora aqui, junto do resto do
// que e verificavel sem rodar a partida. Os casos sao os de borda: ninguem
// morto, HP cheio, HP 1, ileso, e o grampo do teto.
if (erros.length === 0) {
  try {
    const { CONTEUDO } = await import(pathToFileURL(join(RAIZ, 'data', 'content.js')).href);
    const run = await import(pathToFileURL(join(RAIZ, 'src', 'run.js')).href);
    const pesos = CONTEUDO.nota;
    const casas = pesos.casasDecimais;
    const arredondar = (v) => Math.round(v * 10 ** casas) / 10 ** casas;
    const exigir = (condicao, mensagem) => {
      if (!condicao) erros.push(`run.js — ${mensagem}`);
    };
    const nota = (kills, hpRestante, hpMax, ileso) =>
      run.calcularNota({ kills, hpRestante, hpMax, ileso });

    const hpMax = CONTEUDO.jogador.hpMax;

    // Ninguem morto e HP cheio: so o peso de HP. E o jogador que passou a
    // avaliacao inteira fugindo — ele e aprovado, mas a nota tem que dizer
    // que ele nao fez nada.
    exigir(
      nota(0, hpMax, hpMax, false) === arredondar(pesos.pesoHp),
      `0 kills com HP cheio deu ${nota(0, hpMax, hpMax, false)}, esperava ${arredondar(pesos.pesoHp)} (so pesoHp)`
    );
    exigir(
      nota(0, hpMax, hpMax, true) === arredondar(pesos.pesoHp + pesos.bonusIleso),
      `0 kills, HP cheio e ileso deu ${nota(0, hpMax, hpMax, true)}, esperava pesoHp + bonusIleso`
    );
    // HP 1 depois de uma cacada: a parcela de HP e quase nada (4/100 some no
    // arredondamento de uma casa), mas sobreviver por um fio nao pode valer
    // MAIS que terminar inteiro, nem menos que os kills que ele fez.
    const killsDoFio = 100;
    const soKills = arredondar(killsDoFio * pesos.pesoKill);
    exigir(
      nota(killsDoFio, 1, hpMax, false) < nota(killsDoFio, hpMax, hpMax, false),
      `HP 1/${hpMax} com ${killsDoFio} kills deu ${nota(killsDoFio, 1, hpMax, false)}, ` +
        `nao menos que HP cheio (${nota(killsDoFio, hpMax, hpMax, false)})`
    );
    exigir(
      nota(killsDoFio, 1, hpMax, false) === arredondar(soKills + arredondar(pesos.pesoHp / hpMax)),
      `HP 1/${hpMax} com ${killsDoFio} kills deu ${nota(killsDoFio, 1, hpMax, false)}, ` +
        `esperava os kills (${soKills}) mais a parcela de HP arredondada`
    );
    exigir(nota(0, 0, hpMax, false) === 0, 'HP 0 e 0 kills tinha que dar nota 0');
    // Cada peso precisa MUDAR a nota. Sem estas duas, um `alvo.kills = 0` em
    // parcelasDaNota passaria: a nota e a decomposicao sairiam consistentes
    // entre si, so que erradas, e o smoke nao teria como saber.
    exigir(
      nota(100, hpMax, hpMax, false) > nota(0, hpMax, hpMax, false),
      'matar 100 inimigos nao mudou a nota: pesoKill nao entra na conta'
    );
    exigir(
      nota(0, hpMax, hpMax, false) > nota(0, 0, hpMax, false),
      'terminar com HP cheio nao vale mais que terminar com HP 0: pesoHp nao entra na conta'
    );
    exigir(
      nota(0, hpMax, hpMax, true) > nota(0, hpMax, hpMax, false),
      'terminar ileso nao vale mais que terminar arranhado: bonusIleso nao entra na conta'
    );
    // Monotonia: mais kill nunca pode dar nota menor.
    let anterior = -1;
    for (const kills of [0, 1, 10, 50, 100, 200, 500]) {
      const atual = nota(kills, hpMax, hpMax, false);
      exigir(atual >= anterior, `nota caiu de ${anterior} para ${atual} ao subir para ${kills} kills`);
      anterior = atual;
    }
    // Grampo do teto: nenhuma cacada rende mais que nota.maxima, senao a
    // decomposicao mostraria 14,2 numa escala de 10.
    exigir(
      nota(1e6, hpMax, hpMax, true) === pesos.maxima,
      `um milhao de kills deu ${nota(1e6, hpMax, hpMax, true)} e o teto e ${pesos.maxima}`
    );
    // A nota e a soma das parcelas que a tela mostra, ja arredondadas — senao
    // o boletim exibe "+5,5 · +3,7" e nota 9,3. Varre combinacoes o bastante
    // para pegar os meios-arredondamentos e o grampo do teto.
    for (const kills of [0, 1, 7, 50, 157, 173, 188, 400]) {
      for (const hp of [0, 1, 33, 62, 93, hpMax]) {
        for (const ileso of [false, true]) {
          const p = run.parcelasDaNota({ kills, hpRestante: hp, hpMax, ileso });
          const n = nota(kills, hp, hpMax, ileso);
          exigir(
            arredondar(p.kills + p.hp + p.ileso) === n,
            `${kills} kills, HP ${hp}/${hpMax}, ileso=${ileso}: parcelas ${p.kills}+${p.hp}+${p.ileso} ` +
              `nao somam a nota ${n}`
          );
          for (const chave of ['kills', 'hp', 'ileso']) {
            exigir(arredondar(p[chave]) === p[chave], `parcela ${chave}=${p[chave]} nao esta arredondada`);
          }
        }
      }
    }
    // Entrada podre nao pode virar NaN no estado: a tela mostraria "NaN" e a
    // varredura do smoke so pegaria isso na proxima avaliacao.
    exigir(Number.isFinite(nota(NaN, NaN, NaN, false)), 'calcularNota devolveu NaN para entrada invalida');
    // hpMax 0 nao pode virar "HP cheio": 10/0 e Infinity, e um grampo ingenuo
    // (Math.min(1, ...)) daria o peso de HP inteiro a um jogador sem HP nenhum.
    exigir(
      nota(0, 10, 0, false) === 0,
      `hpMax 0 rendeu ${nota(0, 10, 0, false)} pontos de HP — a divisao por zero virou HP cheio`
    );

    // Faixas: o minimo de cada faixa tem que cair NELA, e um passo abaixo do
    // minimo tem que cair na de baixo. E o teste que pega o `>` trocado por
    // `>=` na escolha da faixa.
    const passo = 1 / 10 ** casas;
    pesos.faixas.forEach((faixa, i) => {
      exigir(
        run.conceitoDaNota(faixa.minimo) === faixa.conceito,
        `nota ${faixa.minimo} devia ser conceito "${faixa.conceito}" e veio "${run.conceitoDaNota(faixa.minimo)}"`
      );
      const abaixo = arredondar(faixa.minimo - passo);
      if (i + 1 < pesos.faixas.length) {
        exigir(
          run.conceitoDaNota(abaixo) === pesos.faixas[i + 1].conceito,
          `nota ${abaixo} (um passo abaixo de ${faixa.conceito}) devia cair em ` +
            `"${pesos.faixas[i + 1].conceito}" e veio "${run.conceitoDaNota(abaixo)}"`
        );
      }
      exigir(
        run.creditosDaNota(faixa.minimo) === Math.round(pesos.creditosBase * faixa.creditosFator),
        `conceito ${faixa.conceito} pagou ${run.creditosDaNota(faixa.minimo)} creditos, ` +
          `esperava ${Math.round(pesos.creditosBase * faixa.creditosFator)}`
      );
    });
    // Nota acima do teto e nota negativa continuam tendo conceito: a faixa
    // nunca pode devolver undefined, senao a tela mostra "Conceito undefined".
    exigir(run.conceitoDaNota(pesos.maxima + 1) !== '', 'nota acima do teto ficou sem conceito');
    exigir(run.conceitoDaNota(-1) !== '', 'nota negativa ficou sem conceito');
  } catch (e) {
    erros.push(`src/run.js nao pode ser verificado: ${e.message}`);
  }
}

// ------------------------------------------ 8. coringas ligados a codigo

// Todo coringa de content.js aponta para um efeito que existe em jokers.js,
// com os params que o efeito pede, e todo efeito so implementa hooks da lista
// fechada. content.js nao pode importar jokers.js (ciclo), entao a ligacao e
// conferida aqui. O id repetido tambem cai aqui, alem do validador geral.
if (erros.length === 0) {
  try {
    const jokers = await import(pathToFileURL(join(RAIZ, 'src', 'jokers.js')).href);
    erros.push(...jokers.verificarCoringasDoConteudo().map((e) => `jokers.js — ${e}`));
  } catch (e) {
    erros.push(`src/jokers.js nao pode ser verificado: ${e.message}`);
  }
}

// ----------------------------------------- 9. hooks so dentro de jokers.js

// A regra da fase 07: nenhum `if (temCoringa('x'))` fora de jokers.js. Id de
// coringa especifico escrito num .js de src/ que nao seja jokers.js e logica
// de coringa vazando — o comportamento tem que sair do `efeito` em content.js.
if (erros.length === 0) {
  try {
    const { CONTEUDO } = await import(pathToFileURL(join(RAIZ, 'data', 'content.js')).href);
    const ids = CONTEUDO.coringas.map((c) => c.id);
    for (const arquivo of modulos) {
      const rel = relative(RAIZ, arquivo).split('\\').join('/');
      if (!rel.startsWith('src/') || rel === 'src/jokers.js') continue;
      readFileSync(arquivo, 'utf8').split(/\r?\n/).forEach((linha, i) => {
        const semComentario = linha.replace(/\/\/.*$/, '');
        for (const id of ids) {
          if (new RegExp(`['"\`]${id}['"\`]`).test(semComentario)) {
            erros.push(`${rel}:${i + 1}: id de coringa "${id}" fora de jokers.js — use um efeito em content.js`);
          }
        }
      });
    }
  } catch (e) {
    erros.push(`nao deu para varrer os ids de coringa: ${e.message}`);
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
    ' · sintaxe, regras estruturais, zero externo, content.js, nota, coringas'
);
