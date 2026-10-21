import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
  const sockets = new Set();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        upgrade(handler) {
          server.on('upgrade', (request, socket) => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            handler(request, socket);
          });
        },
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
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
        .end(`<!doctype html><title>callback</title><p>signed in at ${request.url}</p>`);
    }
    if (pathname === '/noise') {
      const size = Math.min(Number(searchParams.get('size') ?? '0'), 8 * 1024 * 1024);
      return response
        .writeHead(200, {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        })
        .end(randomBytes(size));
    }
    if (pathname === '/hop') {
      const mark = `S3CR3T${[...(searchParams.get('n') ?? '')].reverse().join('')}`;
      const base = {
        seven: 'https://seven.sliccy.ai/auth/callback',
        vault: 'https://vault.sliccy.ai/oauth/mcp-callback',
        ordinary: 'https://ordinary.test/landing',
      }[searchParams.get('to') ?? 'ordinary'];
      const to = {
        fragment: `${base}?nonce=n#access_token=${mark}&token_type=bearer`,
        query: `${base}?code=${mark}&state=${mark}`,
        path: `${base}/${mark}`,
      }[searchParams.get('form') ?? 'query'];
      const body = `<!doctype html><title>hop</title><p>${to}</p>`;
      const how = searchParams.get('how') ?? 'location';
      const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
      const relative = {
        scheme: to.replace(/^https:/, ''),
        backslash: `/\\${to.slice('https://'.length)}`,
        tab: `//${to.slice(8, 11)}\t${to.slice(11)}`,
        path: to.slice(new URL(to).origin.length),
      }[how];
      if (relative !== undefined) {
        return response.writeHead(302, { ...headers, location: relative }).end(body);
      }
      if (how === 'location')
        return response.writeHead(302, { ...headers, location: to }).end(body);
      if (how === 'link')
        return response.writeHead(200, { ...headers, link: `<${to}>; rel="next"` }).end(body);
      return response.writeHead(200, { ...headers, refresh: `0; url=${to}` }).end(body);
    }
    if (pathname === '/moved') {
      const n = searchParams.get('n') ?? '';
      const host = searchParams.get('to') === 'vault' ? 'vault.sliccy.ai' : 'other.test';
      return response
        .writeHead(301, {
          location: `https://${host}/bounce?n=${n}`,
          'set-cookie': `moved=S3CR3T${[...n].reverse().join('')}; Secure; SameSite=None; Path=/`,
          'cache-control': 'max-age=3600',
        })
        .end();
    }
    if (pathname === '/bounce') {
      const mark = `S3CR3T${[...(searchParams.get('n') ?? '')].reverse().join('')}`;
      return response
        .writeHead(302, {
          location: `https://ordinary.test/landing?code=${mark}`,
          'set-cookie': `bounce=${mark}; Secure; SameSite=None; Path=/`,
          'cache-control': 'no-store',
        })
        .end();
    }
    if (pathname === '/binary-stream') {
      const marker = binaryMarker(searchParams);
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.write(Buffer.from([0xff, 0xfe, 0]));
      const buffered = searchParams.get('buffered') === '1';
      const split = searchParams.get('split');
      if (split) {
        const at = marker.indexOf('://') + 5;
        const first = marker.subarray(0, at);
        const last = marker.subarray(at);
        if (split === 'buffered') response.write(first);
        else setTimeout(() => response.write(first), 500);
        setTimeout(() => response.end(last), 1000);
        return;
      }
      if (buffered) response.write(marker);
      setTimeout(() => response.end(buffered ? undefined : marker), 500);
      return;
    }
    if (pathname === '/payload') {
      const mark = `S3CR3T${[...(searchParams.get('n') ?? '')].reverse().join('')}`;
      const base = {
        seven: 'https://seven.sliccy.ai/auth/callback',
        vault: 'https://vault.sliccy.ai/oauth/mcp-callback',
        ordinary: 'https://ordinary.test/landing',
      }[searchParams.get('to') ?? 'ordinary'];
      const user = Number(searchParams.get('user') ?? 0);
      const shown = user ? base.replace('://', `://${'a'.repeat(user)}@`) : base;
      return response
        .writeHead(200, {
          'content-type': searchParams.get('type') ?? 'application/octet-stream',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        })
        .end(
          Buffer.concat([
            Buffer.from(searchParams.get('bin') ? [0xff, 0xfe, 0] : []),
            Buffer.from(`start ${shown}?code=${mark} end`),
          ])
        );
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
  server.upgrade(binaryEcho);
  return { ...server, seen };
}

function binaryMarker(params) {
  const host = params.get('to') === 'protected' ? 'vault.sliccy.ai' : 'ordinary.test';
  return Buffer.from(`start https://${host}/landing?code=BINARY${params.get('n')} end`);
}

function binaryEcho(request, socket) {
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !request.url.startsWith('/binary-echo')) {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0] & 15;
      const size = pending[1] & 127;
      if (size > 125 || !(pending[1] & 128)) {
        socket.destroy();
        return;
      }
      if (pending.length < size + 6) return;
      const body = Buffer.from(pending.subarray(6, size + 6));
      for (let at = 0; at < size; at++) body[at] ^= pending[2 + (at % 4)];
      pending = pending.subarray(size + 6);
      if (opcode === 8) {
        socket.end(Buffer.from([0x88, 0]));
        return;
      }
      socket.write(Buffer.concat([Buffer.from([0x82, body.length]), body]));
    }
  });
  socket.on('error', () => socket.destroy());
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
