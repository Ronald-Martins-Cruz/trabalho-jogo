// npm run serve — servidor estatico so com node:http e node:fs.
// ES modules nao carregam por file://, entao abrir o index.html com dois
// cliques falha. Isto existe para o jogo rodar sem instalar nada.

import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const servidor = createServer(async (req, res) => {
  const pedido = decodeURIComponent((req.url || '/').split('?')[0]);
  const relativo = normalize(pedido === '/' ? 'index.html' : pedido.slice(1));
  if (relativo.startsWith('..')) {
    res.writeHead(403).end('403');
    return;
  }
  try {
    const corpo = await readFile(join(RAIZ, relativo));
    res.writeHead(200, {
      'content-type': TIPOS[extname(relativo).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(corpo);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
  }
});

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

let porta = PORTA;
while (porta < PORTA + 10 && (await ocupada(porta))) porta += 1;

servidor.on('error', (e) => {
  console.error(`nao foi possivel subir o servidor na porta ${porta}: ${e.message}`);
  process.exit(1);
});
servidor.listen(porta, () => {
  console.log(`Semana de Provas em http://localhost:${porta}  (ctrl+c para parar)`);
});
