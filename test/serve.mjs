// npm run serve — servidor estatico so com node:http e node:fs.
// ES modules nao carregam por file://, entao abrir o index.html com dois
// cliques falha. Isto existe para o jogo rodar sem instalar nada.
//
// Tambem e importado por test/fotos.mjs (servir), com `expor`: o index.html
// servido ganha `window.__estado = iniciar()` no lugar de `iniciar()`, para a
// ferramenta levar o jogo a cada tela mexendo no estado. O arquivo do jogo nao
// muda, e o jogador nunca recebe essa versao (decisao 14 da montagem da v2).
// Pela linha de comando: `node test/serve.mjs --expor`.

import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const PORTA = Number(process.env.PORTA || 8080);

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

// A unica chamada de iniciar() do index.html, dentro do <script type=module>.
const CHAMADA_INICIAR = /(<script type="module">[\s\S]*?)\biniciar\(\);([\s\S]*?<\/script>)/;

// O index.html com o estado exposto. Lanca se a chamada mudou de forma: uma
// ferramenta que fotografa o jogo sem conseguir mexer nele mentiria em silencio.
export function exporEstado(html) {
  if (!CHAMADA_INICIAR.test(html)) throw new Error('serve --expor: nao achei `iniciar();` no <script type="module"> do index.html');
  return html.replace(CHAMADA_INICIAR, '$1window.__estado = iniciar();$2');
}

function criarServidor({ expor }) {
  return createServer(async (req, res) => {
    const pedido = decodeURIComponent((req.url || '/').split('?')[0]);
    const relativo = normalize(pedido === '/' ? 'index.html' : pedido.slice(1));
    if (relativo.startsWith('..')) {
      res.writeHead(403).end('403');
      return;
    }
    try {
      let corpo = await readFile(join(RAIZ, relativo));
      if (expor && relativo === 'index.html') corpo = exporEstado(corpo.toString('utf8'));
      res.writeHead(200, {
        'content-type': TIPOS[extname(relativo).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(corpo);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
    }
  });
}

// 8080 e porta popular; no Windows outro servico pode responder nela mesmo
// quando o bind nao falha. Por isso a porta e sondada antes, e nao so no erro.
function ocupada(porta) {
  return new Promise((resolve) => {
    const soquete = createConnection({ port: porta, host: '127.0.0.1' });
    const fim = (resposta) => {
      soquete.destroy();
      resolve(resposta);
    };
    soquete.setTimeout(300);
    soquete.on('connect', () => fim(true));
    soquete.on('timeout', () => fim(false));
    soquete.on('error', () => fim(false));
  });
}

// Sobe o servidor e devolve { porta, url, fechar() }. `porta: 0` deixa o
// sistema escolher uma livre (o fotos.mjs); sem ela, a partir de 8080.
export async function servir({ porta = PORTA, expor = false, host = undefined } = {}) {
  let escolhida = porta;
  if (escolhida !== 0) while (escolhida < porta + 10 && (await ocupada(escolhida))) escolhida += 1;
  const servidor = criarServidor({ expor });
  await new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(escolhida, host, resolve);
  });
  const real = servidor.address().port;
  return {
    porta: real,
    url: `http://localhost:${real}/`,
    fechar: () => new Promise((resolve) => servidor.close(() => resolve())),
  };
}

// Pela linha de comando (npm run serve), e nao quando importado.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const expor = process.argv.includes('--expor');
  try {
    const { url } = await servir({ expor });
    console.log(`Semana de Provas em ${url}${expor ? '  (estado exposto em window.__estado)' : ''}  (ctrl+c para parar)`);
  } catch (e) {
    console.error(`nao foi possivel subir o servidor: ${e.message}`);
    process.exit(1);
  }
}
