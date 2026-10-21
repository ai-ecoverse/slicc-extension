import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const transports = ['seven', 'six-bridge'];
const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const DISCOVERY = [
  'Target.targetCreated',
  'Target.targetInfoChanged',
  'Target.targetDestroyed',
  'Target.targetCrashed',
];
let serial = 0;

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const own = targetInfos.find((info) => info.type === 'page' && info.url === entry[transport]);
  assert.ok(own, 'the client page is a target');
  await chrome.cdp.send('Target.activateTarget', { targetId: own.targetId });
  return page;
}

for (const transport of transports) {
  test(`${transport}: with the client's protected page active, a tab it creates opens, navigates, evaluates and snapshots like any ordinary tab`, async (t) => {
    const page = await client(t, transport);
    const n = `agent${++serial}${Date.now()}`;
    const run = await page.evaluate(async (n) => {
      const out = {};
      const start = h.events.length;
      const created = await h.attempt('Target.createTarget', { url: 'about:blank' });
      out.created = created;
      const targetId = created.result?.targetId;
      const info = await h.attempt('Target.getTargetInfo', { targetId });
      out.info = info.result?.targetInfo;
      const attached = await h.attempt('Target.attachToTarget', { targetId, flatten: true });
      out.attached = attached;
      const s = attached.result?.sessionId;
      out.enable = await h.attempt('Page.enable', {}, s);
      const url = `https://ordinary.test/doc?n=${n}`;
      out.navigate = await h.attempt('Page.navigate', { url }, s);
      out.href = await h.until(async () => {
        const href = await h.evaluate(s, 'document.readyState === "complete" ? location.href : ""');
        return href === url ? href : undefined;
      });
      out.evaluate = await h.attempt(
        'Runtime.evaluate',
        { expression: 'document.title + "|" + location.host', returnByValue: true },
        s
      );
      out.snapshot = await h.attempt('Page.captureSnapshot', {}, s);
      out.screenshot = await h.attempt('Page.captureScreenshot', { format: 'png' }, s);
      out.detached = h.detached(s);
      out.close = await h.attempt('Target.closeTarget', { targetId });
      out.events = h.events.slice(start).map((e) => e.method);
      return out;
    }, n);
    const brief = (value) => JSON.stringify(value)?.slice(0, 300);
    assert.ok(run.created.result?.targetId, brief(run.created));
    assert.equal(run.info?.openerId, undefined, `no opener: ${brief(run.info)}`);
    assert.ok(run.attached.result?.sessionId, `attach: ${brief(run.attached)}`);
    assert.ok(!run.navigate.error, `navigate: ${brief(run.navigate)}`);
    assert.equal(run.href, `https://ordinary.test/doc?n=${n}`);
    assert.equal(run.evaluate.result?.result?.value?.split('|')[1], 'ordinary.test');
    assert.match(run.snapshot.result?.data ?? '', /ordinary\.test/, brief(run.snapshot));
    assert.ok((run.screenshot.result?.data ?? '').length > 100, brief(run.screenshot));
    assert.equal(run.detached, false, 'the session stays attached');
    assert.equal(run.close.result?.success, true, brief(run.close));
  });

  test(`${transport}: target discovery ${transport === 'seven' ? 'reports created, changed and destroyed tabs' : 'is refused and no discovery event ever reaches the client'}`, async (t) => {
    const page = await client(t, transport);
    const n = `discover${++serial}${Date.now()}`;
    const run = await page.evaluate(async (n) => {
      const start = h.events.length;
      const discover = await h.attempt('Target.setDiscoverTargets', { discover: true });
      const created = await h.attempt('Target.createTarget', { url: 'about:blank' });
      const targetId = created.result?.targetId;
      const { sessionId: s } = await h.cdp.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      await h.land(s, `https://ordinary.test/doc?n=${n}`);
      await h.evaluate(s, 'location.hash = "moved"; document.title = "renamed"; 1');
      await h.sleep(500);
      await h.close(targetId);
      await h.sleep(500);
      await h.attempt('Target.setDiscoverTargets', { discover: false });
      return {
        discover,
        targetId,
        events: h.events.slice(start).map((e) => ({
          method: e.method,
          id: e.params?.targetInfo?.targetId ?? e.params?.targetId,
        })),
      };
    }, n);
    t.diagnostic(JSON.stringify(run.events.map((e) => e.method)));
    const discovery = run.events.filter((e) => DISCOVERY.includes(e.method));
    if (transport === 'seven') {
      assert.ok(!run.discover.error, JSON.stringify(run.discover));
      const mine = discovery.filter((e) => e.id === run.targetId).map((e) => e.method);
      for (const method of DISCOVERY.slice(0, 3)) {
        assert.ok(mine.includes(method), `${method} reaches the client: ${mine}`);
      }
      return;
    }
    assert.match(run.discover.error ?? '', /^slicc: refused: /, JSON.stringify(run.discover));
    assert.deepEqual(discovery, [], 'no discovery event reaches a six-bridge client');
  });
}
