import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

let chrome;
let workerSession;
before(async () => {
  chrome = await launch();
});
after(async () => {
  if (workerSession) {
    await chrome.cdp.send('Target.detachFromTarget', { sessionId: workerSession }).catch(() => {});
  }
  await chrome?.close();
});

const entries = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
let serial = 0;

async function client(t, transport) {
  const page = await chrome.visit(t, entries[transport]);
  await page.evaluate(install, transport, extId);
  return page;
}

async function auditFixture(url) {
  if (!workerSession) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const worker = targetInfos.find(
      (info) =>
        info.type === 'service_worker' && info.url.startsWith(`chrome-extension://${extId}/`)
    );
    ({ sessionId: workerSession } = await chrome.cdp.send('Target.attachToTarget', {
      targetId: worker.targetId,
      flatten: true,
    }));
  }
  const expression = `(async () => {
    globalThis.auditBytes = btoa(String.fromCharCode(...new Uint8Array(await (await fetch(${JSON.stringify(url)})).arrayBuffer())));
    if (!globalThis.originalDebuggerCommand) {
      globalThis.originalDebuggerCommand = chrome.debugger.sendCommand.bind(chrome.debugger);
      chrome.debugger.sendCommand = (target, method, params) => method === 'Audits.getEncodedResponse'
        ? Promise.resolve({ body: globalThis.auditBytes, originalSize: atob(globalThis.auditBytes).length, encodedSize: atob(globalThis.auditBytes).length })
        : globalThis.originalDebuggerCommand(target, method, params);
    }
    return true;
  })()`;
  const answer = await chrome.cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    workerSession
  );
  assert.equal(answer.exceptionDetails, undefined);
  assert.equal(answer.result.value, true);
}

for (const transport of Object.keys(entries)) {
  for (const to of ['protected', 'ordinary']) {
    for (const carrier of ['bufferedData', 'Network.dataReceived', 'Audits.getEncodedResponse']) {
      test(`${transport}: ${carrier} ${to} binary marker`, async (t) => {
        const page = await client(t, transport);
        const n = `${++serial}${Date.now()}`;
        const url = `https://ordinary.test/binary-stream?to=${to}&n=${n}&buffered=${carrier === 'bufferedData' ? 1 : 0}`;
        if (carrier === 'Audits.getEncodedResponse') await auditFixture(url);
        const run = await page.evaluate(
          async ({ url, carrier }) => {
            const { targetId, sessionId } = await h.open('https://ordinary.test/doc');
            await h.cdp.send('Network.enable', {}, sessionId);
            const from = h.events.length;
            await h.cdp.send(
              'Runtime.evaluate',
              {
                expression: `globalThis.binaryDone = fetch(${JSON.stringify(url)}).then(r => r.arrayBuffer()).then(b => b.byteLength); 1`,
              },
              sessionId
            );
            const response = await h.until(() =>
              h.events
                .slice(from)
                .find(
                  (e) => e.method === 'Network.responseReceived' && e.params.response.url === url
                )
            );
            const requestId = response?.params.requestId;
            let answer;
            if (carrier !== 'Audits.getEncodedResponse') {
              answer = await h.attempt('Network.streamResourceContent', { requestId }, sessionId);
            }
            await h.evaluate(sessionId, 'binaryDone');
            const finished = await h.until(() =>
              h.events
                .slice(from)
                .find(
                  (e) => e.method === 'Network.loadingFinished' && e.params.requestId === requestId
                )
            );
            if (carrier === 'Audits.getEncodedResponse') {
              answer = await h.attempt(carrier, { requestId, encoding: 'jpeg' }, sessionId);
            }
            const chunks = h.events
              .slice(from)
              .filter(
                (e) =>
                  e.method === 'Network.dataReceived' &&
                  e.params.requestId === requestId &&
                  e.params.data
              );
            await h.close(targetId);
            return { answer, chunks, finished: !!finished };
          },
          { url, carrier }
        );
        assert.equal(run.finished, true);
        if (carrier === 'Network.dataReceived') {
          assert.equal(run.answer.error, undefined);
          const text = run.chunks.map((e) => atob(e.params.data)).join('');
          assert.equal(text.includes(`BINARY${n}`), to === 'ordinary');
          if (to === 'protected') assert.equal(run.chunks.length, 0);
        } else if (to === 'protected') {
          assert.match(run.answer.error ?? '', /^slicc: refused: an encoded payload/);
          assert.equal(run.answer.result, undefined);
        } else {
          assert.equal(run.answer.error, undefined);
          const data = run.answer.result[carrier === 'bufferedData' ? 'bufferedData' : 'body'];
          assert.equal(
            atob(data),
            `\xff\xfe\0start https://ordinary.test/landing?code=BINARY${n} end`
          );
        }
      });
    }
    for (const method of ['Network.webSocketFrameReceived', 'Network.webSocketFrameSent']) {
      test(`${transport}: ${method} ${to} binary marker`, async (t) => {
        const page = await client(t, transport);
        const n = `${++serial}${Date.now()}`;
        const host = to === 'protected' ? 'vault.sliccy.ai' : 'ordinary.test';
        const bytes = `\xff\xfe\0start https://${host}/landing?code=BINARY${n} end`;
        const run = await page.evaluate(
          async ({ bytes, method }) => {
            const { targetId, sessionId } = await h.open('https://ordinary.test/doc');
            await h.cdp.send('Network.enable', {}, sessionId);
            const from = h.events.length;
            const expression = `new Promise((resolve, reject) => {
            const ws = new WebSocket('wss://ordinary.test/binary-echo');
            ws.binaryType = 'arraybuffer';
            ws.onopen = () => ws.send(Uint8Array.from(${JSON.stringify([...bytes].map((c) => c.charCodeAt(0)))}));
            ws.onmessage = e => { resolve(e.data.byteLength); ws.close(); };
            ws.onerror = () => reject(new Error('binary echo failed'));
          })`;
            const size = await h.evaluate(sessionId, expression);
            await h.until(() =>
              h.events.slice(from).find((e) => e.method === 'Network.webSocketClosed')
            );
            const frames = h.events.slice(from).filter((e) => e.method === method);
            await h.close(targetId);
            return { size, frames };
          },
          { bytes, method }
        );
        assert.equal(run.size, bytes.length);
        if (to === 'protected') assert.deepEqual(run.frames, []);
        else {
          assert.equal(run.frames.length, 1);
          assert.equal(run.frames[0].params.response.opcode, 2);
          assert.equal(atob(run.frames[0].params.response.payloadData), bytes);
        }
      });
    }
  }
}
