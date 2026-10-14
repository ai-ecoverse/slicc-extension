import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());
const extId = 'akjjllgokmbgpbdbmafpiefnhidlmbgf';
test('dbg autoattach', async (t) => {
  const page = await chrome.visit(t, 'https://seven.sliccy.ai/');
  const fn = `(async () => {
    const log = [];
    const tab = await chrome.tabs.create({ url: 'https://other.test/start', active: false });
    await new Promise((r) => setTimeout(r, 1500));
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    chrome.debugger.onEvent.addListener((src, method, params) => {
      if (method.startsWith('Target.') || method.startsWith('Fetch.') || method === 'Page.frameAttached' || method === 'Page.frameRequestedNavigation' || method === 'Page.frameStartedNavigating')
        log.push([src.sessionId ?? '-', method, JSON.stringify(params).slice(0, 300)]);
      if (method === 'Fetch.requestPaused') chrome.debugger.sendCommand(src, 'Fetch.continueRequest', { requestId: params.requestId }).catch((e) => log.push(['err', e.message]));
      if (method === 'Target.attachedToTarget') chrome.debugger.sendCommand({ tabId: tab.id, sessionId: params.sessionId }, 'Runtime.runIfWaitingForDebugger', {}).catch((e) => log.push(['errrun', e.message]));
    });
    try { await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }); } catch (e) { log.push(['fetch', e.message]); }
    try { await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable', {}); } catch (e) { log.push(['page', e.message]); }
    try { log.push(['aa', JSON.stringify(await chrome.debugger.sendCommand({ tabId: tab.id }, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }))]); } catch (e) { log.push(['autoattach', e.message]); }
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.evaluate', { expression: \`document.body.append(Object.assign(document.createElement('iframe'), { src: 'https://vault.sliccy.ai/inner' })); 1\` });
    await new Promise((r) => setTimeout(r, 3000));

    return JSON.stringify(log);
  })()`;
  const out = await page.evaluate(
    async (args) => {
      const cdp = globalThis.sliccExtension.cdp;
      const { targetId } = await cdp.send('Target.createTarget', {
        url: `chrome-extension://${args.extId}/secrets.html`,
      });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      for (let i = 0; i < 50; i++) {
        try {
          const r = await cdp.send(
            'Runtime.evaluate',
            { expression: args.fn, awaitPromise: true, returnByValue: true },
            sessionId
          );
          if (r.exceptionDetails) return 'EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 500);
          return r.result.value;
        } catch (e) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      return 'never';
    },
    { extId, fn }
  );
  console.log(out);
});
