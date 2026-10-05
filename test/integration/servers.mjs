import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';

export function certificate(dir) {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=slicc-extension-test',
    '-keyout',
    key,
    '-out',
    cert,
  ]);
  return Promise.all([readFile(key), readFile(cert)]).then(([k, c]) => ({ key: k, cert: c }));
}

function listen(tls, handler) {
  const server = createServer(tls, handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      });
    });
  });
}

export async function pages(tls) {
  const html = await readFile(new URL('page/index.html', import.meta.url));
  return listen(tls, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
}

function collect(request) {
  return new Promise((resolve) => {
    const parts = [];
    request.on('data', (part) => parts.push(part));
    request.on('end', () => resolve(Buffer.concat(parts)));
  });
}

export async function upstream(tls) {
  const seen = [];
  const routes = {
    '/hello': (response) =>
      response
        .writeHead(200, { 'content-type': 'text/plain', 'x-upstream': 'exposed' })
        .end('hello from upstream'),
    '/jar': (response) =>
      response
        .writeHead(200, {
          'content-type': 'text/plain',
          'set-cookie': 'jar=secret; SameSite=None; Secure',
        })
        .end('stored'),
    '/bytes': (response) => {
      const bytes = Buffer.alloc(3 * 1024 * 1024);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes);
    },
    '/empty': (response) => response.writeHead(204).end(),
  };
  const server = await listen(tls, async (request, response) => {
    const { pathname } = new URL(request.url, 'https://upstream.test');
    const body = await collect(request);
    seen.push({ method: request.method, path: pathname, headers: request.headers });
    if (request.method === 'OPTIONS') {
      return response.writeHead(pathname.startsWith('/strict/') ? 405 : 204).end();
    }
    const route = routes[pathname];
    if (route) return route(response);
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        method: request.method,
        path: pathname,
        headers: request.headers,
        body: body.toString('base64'),
      })
    );
  });
  return { ...server, seen };
}
