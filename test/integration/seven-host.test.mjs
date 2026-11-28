import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import { listen, trusted } from '../../extension/cdp.js';
import { protectedOrigins } from '../../extension/protected.mjs';
import { protectedRules } from '../../extension/protected-rules.js';
import { strictGuard } from '../../extension/shield.js';
import {
  excludesOf,
  initiatorExcludesOf,
  initiatorLabels,
  rulesOf,
  sevenOf,
  sixHostsOf,
} from '../../scripts/build-seven.mjs';

const id = 'akjjllgokmbgpbdbmafpiefnhidlmbgf';
const source = (name) => readFile(new URL(`../../extension/${name}`, import.meta.url), 'utf8');
const files = {
  main: [await source('seven-gate-main.js'), await source('page.js')],
  isolated: [await source('seven-gate.js'), await source('relay.js')],
};
const manifest = JSON.parse(await source('manifest.json'));
const rules = JSON.parse(await source('rules.json'));
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
const pilot = 'lease-pilot.sliccy.ai';
const seven = [
  'seven.sliccy.ai',
  'lease-pilot-x.sliccy.ai',
  'x-lease-pilot.sliccy.ai',
  `${label63}.sliccy.ai`,
  'a1-b2-c3.sliccy.ai',
  '7.sliccy.ai',
  'www.sliccy.ai',
];
const other = [
  pilot,
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
  'vault-x.sliccy.ai',
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

  test(`${name}: the lease-pilot host is not an ordinary seven host, on 443 too`, () => {
    const answers = [`https://${pilot}/`, `https://${pilot}:443/play`].map((url) => gate(doc(url)));
    assert.deepEqual(answers, [false, false]);
    assert.equal(gate(doc('https://seven.sliccy.ai/')), true, 'control: seven.sliccy.ai');
    assert.equal(gate(doc('https://www.sliccy.ai/')), true, 'control: www.sliccy.ai');
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

const bundled = await build({
  stdin: {
    contents: "export { isProtectedTab } from './six/extension/protected-origins.ts';\n",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { isProtectedTab } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

function events() {
  return { addListener() {}, removeListener() {} };
}

async function sevenAttach(url) {
  const attached = [];
  const tab = { id: 1, url, status: 'complete', windowId: 1 };
  const connection = listen(
    {
      name: 'slicc-fetch',
      sender: { id, url: 'https://seven.sliccy.ai/', origin: 'https://seven.sliccy.ai' },
      onDisconnect: events(),
      postMessage() {},
    },
    id,
    {
      tabs: {
        get: async () => tab,
        query: async () => [tab],
        onUpdated: events(),
        onCreated: events(),
        onRemoved: events(),
        onActivated: events(),
      },
      windows: { onRemoved: events() },
      webNavigation: {
        getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url, errorOccurred: false }],
        getFrame: async () => ({ url, errorOccurred: false }),
        onCreatedNavigationTarget: events(),
        onCommitted: events(),
        onCompleted: events(),
        onDOMContentLoaded: events(),
        onErrorOccurred: events(),
        onHistoryStateUpdated: events(),
        onReferenceFragmentUpdated: events(),
        onTabReplaced: events(),
      },
      debugger: {
        onEvent: events(),
        onDetach: events(),
        attach: async (target) => attached.push(target),
        detach: async () => {},
        sendCommand: async () => ({}),
      },
    }
  );
  try {
    await connection.attach({ targetId: '1', flatten: true });
    return { refused: null, attached: attached.length };
  } catch (error) {
    return { refused: String(error.message ?? error), attached: attached.length };
  } finally {
    connection.close();
  }
}

test('the lease-pilot origin stays protected on both transports', async () => {
  const guard = strictGuard(protectedOrigins(protectedRules), protectedRules);
  for (const url of [`https://${pilot}/`, `https://${pilot}:443/play`]) {
    assert.equal(guard.url(url), true, `guard.url ${url}`);
    assert.equal(guard.target({ url, type: 'page' }), true, `guard.target ${url}`);
    assert.deepEqual(await sevenAttach(url), {
      refused: "slicc: refused: target is on seven's origin",
      attached: 0,
    });
    const tab = { id: 1, url, status: 'complete', windowId: 1 };
    assert.equal(await isProtectedTab(tab, async () => tab), true, `isProtectedTab ${url}`);
  }
  const control = 'https://ordinary.test/';
  assert.equal(guard.url(control), false, 'control: guard.url');
  assert.equal((await sevenAttach(control)).attached, 1, 'control: seven attaches');
  const tab = { id: 1, url: control, status: 'complete', windowId: 1 };
  assert.equal(await isProtectedTab(tab, async () => tab), false, 'control: isProtectedTab');
});

test('the content scripts exclude the lease-pilot host', () => {
  for (const entry of manifest.content_scripts) {
    assert.ok(entry.exclude_matches.includes(`https://${pilot}/*`), entry.js.join(' '));
  }
});

function withLabels(excludedLabels) {
  return sevenOf({ ...catalog, seven: { ...catalog.seven, excludedLabels } });
}

test('the static rule excludes the allowlisted labels the catalog excludes as initiators', () => {
  assert.deepEqual(initiatorLabels, ['lease-pilot']);
  assert.ok(catalog.seven.excludedLabels.includes('lease-pilot'), 'the pinned catalog');
  assert.equal(rules.length, 3);
  assert.deepEqual(Object.keys(rules[1].condition), ['urlFilter', 'resourceTypes']);
  assert.deepEqual(rules[2], {
    id: 3,
    priority: 3,
    condition: {
      urlFilter: '|http://',
      requestDomains: ['sliccy.ai'],
      resourceTypes: ['main_frame', 'sub_frame', 'object'],
    },
    action: { type: 'upgradeScheme' },
  });
  assert.equal(rulesOf(rules, sevenOf(catalog))[2], rules[2]);
  assert.deepEqual(Object.keys(rules[0].condition), [
    'initiatorDomains',
    'excludedInitiatorDomains',
    'resourceTypes',
  ]);
  assert.deepEqual(rules[0].condition.excludedInitiatorDomains, [pilot]);
  assert.deepEqual(rulesOf(rules, sevenOf(catalog)), rules);
});

test('the initiator exclusion is the catalog labels intersected with the allowlist', () => {
  assert.deepEqual(initiatorExcludesOf(sevenOf(catalog)), [pilot]);
  assert.deepEqual(initiatorExcludesOf(withLabels(['vault', 'echo', 'lease-pilot'])), [pilot]);
  assert.deepEqual(initiatorExcludesOf(withLabels(['vault', 'get', 'mcpcat', 'echo'])), []);
  assert.deepEqual(initiatorExcludesOf(withLabels(['echo']), ['echo', 'lease-pilot']), [
    'echo.sliccy.ai',
  ]);
  assert.deepEqual(initiatorExcludesOf(withLabels(['lease-pilot-x', 'x-lease-pilot'])), []);
});

test('an empty initiator exclusion omits the key and keeps the action', () => {
  const bare = rulesOf(rules, withLabels(['vault', 'echo']));
  assert.deepEqual(Object.keys(bare[0].condition), ['initiatorDomains', 'resourceTypes']);
  assert.deepEqual(bare[0].action, rules[0].action);
  assert.equal(bare[0].id, rules[0].id);
  const again = rulesOf(bare, sevenOf(catalog));
  assert.equal(JSON.stringify(again), JSON.stringify(rules));
  assert.equal(JSON.stringify(rulesOf(again, sevenOf(catalog))), JSON.stringify(rules));
  const foreign = [{ ...rules[0], condition: { initiatorDomains: ['example.com'] } }];
  assert.deepEqual(rulesOf(foreign, sevenOf(catalog)), foreign);
});

test('the manifest excludes follow an injected catalog with the pilot label', () => {
  const sixHosts = sixHostsOf(manifest);
  const withPilot = excludesOf(withLabels(['echo', 'lease-pilot']), sixHosts);
  assert.deepEqual(withPilot.exclude_matches, [
    'https://sliccy.ai/*',
    'https://echo.sliccy.ai/*',
    `https://${pilot}/*`,
  ]);
  const without = excludesOf(withLabels(['echo']), sixHosts);
  assert.equal(without.exclude_matches.includes(`https://${pilot}/*`), false);
  assert.deepEqual(
    excludesOf(sevenOf(catalog), sixHosts).exclude_matches,
    manifest.content_scripts[0].exclude_matches
  );
});
