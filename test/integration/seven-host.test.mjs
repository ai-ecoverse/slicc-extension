import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import vm from 'node:vm';
import { trusted } from '../../extension/cdp.js';
import { sevenOf } from '../../scripts/build-seven.mjs';

const id = 'akjjllgokmbgpbdbmafpiefnhidlmbgf';
const source = (name) => readFile(new URL(`../../extension/${name}`, import.meta.url), 'utf8');
const files = {
  main: [await source('seven-gate-main.js'), await source('page.js')],
  isolated: [await source('seven-gate.js'), await source('relay.js')],
};
const manifest = JSON.parse(await source('manifest.json'));
const catalog = JSON.parse(
  await readFile(
    new URL('../../node_modules/@ai-ecoverse/slicc-browsers/catalog.json', import.meta.url)
  )
);
const ports = [];

after(() => {
  for (const port of ports) port.close();
});

class Channel extends MessageChannel {
  constructor() {
    super();
    ports.push(this.port1, this.port2);
  }
}

function run(world, { url, location, window }) {
  const listened = [];
  const sandbox = {
    location: { hostname: new URL(url).hostname, origin: location },
    origin: window,
    MessageChannel: Channel,
    postMessage() {},
    addEventListener: (type) => listened.push(type),
    removeEventListener() {},
    Map,
    Set,
    Promise,
    Object,
    Error,
    URL,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  let thrown = false;
  try {
    for (const code of files[world]) vm.runInContext(code, sandbox);
  } catch (error) {
    assert.equal(error, 0);
    thrown = true;
  }
  assert.equal('__sliccSeven' in sandbox, false);
  return { sandbox, thrown, listened };
}

function page(doc) {
  return 'sliccExtension' in run('main', doc).sandbox;
}

function relay(doc) {
  const { thrown, listened } = run('isolated', doc);
  assert.equal(thrown, listened.length === 0, 'relay listens only when it does not throw 0');
  return !thrown;
}

function sender({ url, location, window }) {
  return trusted({ id, url, origin: location === 'null' ? location : window }, id);
}

const gates = { page, relay, sender };

function doc(url, window = new URL(url).origin, location = new URL(url).origin) {
  return { url, location, window };
}

const label63 = `a${'b'.repeat(61)}c`;
const seven = [
  'seven.sliccy.ai',
  'lease-pilot.sliccy.ai',
  `${label63}.sliccy.ai`,
  'a1-b2-c3.sliccy.ai',
  '7.sliccy.ai',
  'www.sliccy.ai',
];
const other = [
  'x.vault.sliccy.ai',
  'a.lease-pilot.sliccy.ai',
  'a.b.lease-pilot.sliccy.ai',
  'a.b.c.sliccy.ai',
  'x.www.sliccy.ai',
  '-seven.sliccy.ai',
  'seven-.sliccy.ai',
  `${label63}d.sliccy.ai`,
  'sliccy.ai',
  'notsliccy.ai',
  'sliccy.ai.example',
  'seven.sliccy.ai.',
  'vault.sliccy.ai',
  'vault-preview.sliccy.ai',
  'vault-next.sliccy.ai',
  'get.sliccy.ai',
  'mcpcat.sliccy.ai',
  'echo.sliccy.ai',
];
const http = [
  'http://seven.sliccy.ai/',
  'http://seven.sliccy.ai:80/',
  'http://seven.sliccy.ai:8080/',
  'http://seven.sliccy.ai:8443/',
  'http://www.sliccy.ai/',
  'http://lease-pilot.sliccy.ai/',
  'http://seven.lease-pilot.sliccy.ai/',
  'http://vault.lease-pilot.sliccy.ai/',
  'http://x.vault.sliccy.ai/',
  'http://vault.sliccy.ai/',
  'http://echo.sliccy.ai/',
  'http://vault-x.sliccy.ai/',
  'http://sliccy.ai/',
];
const mismatched = {
  'https document with window origin null': doc('https://seven.sliccy.ai/', 'null'),
  'https document with location origin null': doc(
    'https://seven.sliccy.ai/',
    'https://seven.sliccy.ai',
    'null'
  ),
  'https document with an http window origin': doc(
    'https://seven.sliccy.ai/',
    'http://seven.sliccy.ai'
  ),
  'https document with the window origin of another label': doc(
    'https://seven.sliccy.ai/',
    'https://other.sliccy.ai'
  ),
  'https document on another port': doc('https://seven.sliccy.ai:8443/'),
  'http document with window origin null': doc('http://seven.sliccy.ai/', 'null'),
  'http document with an https window origin': doc(
    'http://seven.sliccy.ai/',
    'https://seven.sliccy.ai'
  ),
  'blob document of the seven origin': doc('blob:https://seven.sliccy.ai/8d2f'),
  'about:blank': doc('about:blank', 'null', 'null'),
};

for (const [name, gate] of Object.entries(gates)) {
  test(`${name}: single-label seven hosts and the six host pass`, () => {
    assert.deepEqual(
      seven.filter((host) => !gate(doc(`https://${host}/play`))),
      []
    );
  });

  test(`${name}: dotted, malformed, excluded and foreign hosts fail`, () => {
    assert.deepEqual(
      other.filter((host) => gate(doc(`https://${host}/play`))),
      []
    );
  });

  test(`${name}: http documents fail`, () => {
    assert.deepEqual(
      http.filter((url) => gate(doc(url))),
      []
    );
  });

  test(`${name}: documents whose origins disagree fail`, () => {
    assert.deepEqual(
      Object.keys(mismatched).filter((row) => gate(mismatched[row])),
      []
    );
  });
}

test('the content scripts match only https and load a generated gate first', () => {
  assert.equal(manifest.content_scripts.length, 2);
  for (const entry of manifest.content_scripts) {
    assert.deepEqual(
      [...entry.matches, ...entry.exclude_matches].filter((p) => !p.startsWith('https://')),
      []
    );
    assert.match(entry.js[0], /^seven-gate(-main)?\.js$/);
  }
});

test('the build refuses a host pattern that is missing, invalid or not one capture group', () => {
  const pattern = catalog.seven.originHostPattern;
  assert.equal(sevenOf(catalog).originHostPattern, pattern);
  for (const bad of [undefined, 7, '(', '^[a-z]+\\.sliccy\\.ai$', '^(a)(b)\\.sliccy\\.ai$']) {
    const broken = { ...catalog, seven: { ...catalog.seven, originHostPattern: bad } };
    assert.throws(() => sevenOf(broken), /unexpected seven\.originHostPattern/, String(bad));
  }
});
