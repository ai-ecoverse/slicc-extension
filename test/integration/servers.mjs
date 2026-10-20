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

const onePixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==',
  'base64'
);

export async function pages(tls) {
  const html = await readFile(new URL('page/index.html', import.meta.url));
  const probe = await readFile(new URL('page/probe.html', import.meta.url));
  const frames = await readFile(new URL('page/frames.html', import.meta.url));
  const seen = [];
  const server = await listen(tls, (request, response) => {
    const { pathname, searchParams } = new URL(request.url, 'https://vault.sliccy.ai');
    seen.push({
      host: (request.headers.host ?? '').split(':')[0],
      path: pathname,
      search: searchParams.toString(),
    });
    if (pathname === '/linked') {
      const n = searchParams.get('n') ?? '';
      const link = [
        `<https://upstream.test/handoff-${n}>; rel="https://www.sliccy.ai/rel/handoff"; title="handoff ${n}"`,
        `</catalog-${n}.json>; rel="ai-catalog"`,
      ].join(', ');
      return response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', link })
        .end(html);
    }
    if (pathname === '/.well-known/ai-catalog.json') {
      return response.writeHead(200, { 'content-type': 'application/json' }).end('{"apis":[]}');
    }
    if (pathname === '/llms.txt') {
      return response.writeHead(200, { 'content-type': 'text/plain' }).end('# llms');
    }
    if (/^\/(auth\/callback|oauth\/mcp-callback|landing)(\/|$)/.test(pathname)) {
      return response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<!doctype html><title>callback</title><p>signed in</p>');
    }
    if (pathname === '/signin') {
      const mark = `S3CR3T${[...(searchParams.get('n') ?? '')].reverse().join('')}`;
      const base = {
        seven: 'https://seven.sliccy.ai/auth/callback',
        vault: 'https://vault.sliccy.ai/oauth/mcp-callback',
        ordinary: 'https://ordinary.test/landing',
      }[searchParams.get('to') ?? 'ordinary'];
      const to = {
        fragment: `${base}?nonce=n#access_token=${mark}&token_type=bearer&expires_in=86399`,
        query: `${base}?code=${mark}&state=${mark}`,
        path: `${base}/${mark}`,
      }[searchParams.get('form') ?? 'query'];
      return response.writeHead(302, { location: to }).end();
    }
    if (pathname === '/redirect') {
      return response.writeHead(302, { location: searchParams.get('to') ?? '/' }).end();
    }
    if (pathname === '/frame') {
      const src = JSON.stringify(searchParams.get('src') ?? '/');
      const page = `<!doctype html><title>frame</title><iframe src=${src}></iframe>`;
      return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
    }
    const cors = {
      'access-control-allow-origin': request.headers.origin ?? '*',
      'access-control-allow-credentials': 'true',
    };
    if (pathname === '/data') {
      return response
        .writeHead(200, { 'content-type': 'text/plain', ...cors })
        .end(`real-${searchParams.get('n') ?? ''}`);
    }
    if (pathname === '/img') {
      return response.writeHead(200, { 'content-type': 'image/png', ...cors }).end(onePixel);
    }
    if (pathname === '/auth') {
      if (request.headers.authorization === `Basic ${btoa('u:p')}`) {
        return response.writeHead(200, { 'content-type': 'text/plain', ...cors }).end('authed');
      }
      return response
        .writeHead(401, {
          'www-authenticate': 'Basic realm="slicc"',
          'content-type': 'text/plain',
          ...cors,
        })
        .end('denied');
    }
    if (pathname === '/cookie') {
      return response
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': `${searchParams.get('name') ?? 'jar'}=secret; Secure; SameSite=None; Path=/`,
        })
        .end(html);
    }
    const named = { '/probe': probe, '/frames': frames };
    const body = named[pathname] ?? html;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  return { ...server, seen };
}

function collect(request) {
  return new Promise((resolve) => {
    const parts = [];
    request.on('data', (part) => parts.push(part));
    request.on('end', () => resolve(Buffer.concat(parts)));
  });
}

async function stream(response, progress) {
  const chunk = Buffer.alloc(64 * 1024, 7);
  response.writeHead(200, { 'content-type': 'application/octet-stream' });
  progress.sent = 0;
  progress.done = false;
  progress.closed = false;
  response.on('close', () => {
    progress.closed = true;
  });
  for (let i = 0; i < 8192 && !response.destroyed; i++) {
    progress.sent += chunk.length;
    if (!response.write(chunk)) await new Promise((resolve) => response.once('drain', resolve));
  }
  progress.done = !response.destroyed;
  response.end();
}

export async function upstream(tls) {
  const seen = [];
  const progress = {};
  const routes = {
    '/hello': (response) =>
      response
        .writeHead(200, { 'content-type': 'text/plain', 'x-upstream': 'exposed' })
        .end('hello from upstream'),
    '/vault-popup': (response) =>
      response
        .writeHead(200, { 'content-type': 'text/plain', 'x-upstream': 'exposed' })
        .end('hello from upstream'),
    '/vault-frame': (response) =>
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
    '/stream': (response) => stream(response, progress),
  };
  const server = await listen(tls, async (request, response) => {
    const { pathname, search } = new URL(request.url, 'https://upstream.test');
    const body = await collect(request);
    seen.push({ method: request.method, path: pathname, search, headers: request.headers });
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
  return { ...server, seen, progress };
}

export async function ims(tls) {
  const authorized = [];
  const server = await listen(tls, (request, response) => {
    const url = new URL(request.url, 'https://ims-na1.adobelogin.com');
    const query = Object.fromEntries(url.searchParams);
    authorized.push(query);
    const answer = {
      good: { access_token: 'dummy-ims-token', state: query.state },
      stranger: { access_token: 'dummy-ims-token', state: 'another-request' },
      denied: { error: 'access_denied', state: query.state },
      sibling: { access_token: 'dummy-ims-token', state: query.state },
    }[query.client_id];
    const to = query.client_id === 'sibling' ? `${query.redirect_uri}evil` : query.redirect_uri;
    response.writeHead(302, { location: `${to}#${new URLSearchParams(answer)}` }).end();
  });
  return { ...server, authorized };
}
