import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { backend } from './cdp-675-extension-backend.mjs';

function event() {
  const handlers = new Set();
  return {
    addListener: (handler) => handlers.add(handler),
    emit: (value) => {
      for (const handler of handlers) handler(value);
    },
  };
}

export async function frameRelay(host = 'seven.sliccy.ai') {
  const fixture = await backend();
  const replies = [];
  const worker = {
    onMessage: event(),
    onDisconnect: event(),
    postMessage: (message) => fixture.connection.handle(message),
  };
  fixture.connection.port.postMessage = (message) => {
    replies.push(structuredClone(message));
    worker.onMessage.emit(structuredClone(message));
  };
  const origin = `https://${host}`;
  const seven = {
    domain: 'sliccy.ai',
    excludedLabels: ['vault'],
    excludedLabelPrefixes: [],
    version: '7.12.0',
  };
  let take;
  const relayWindow = {};
  const relay = vm.createContext({
    __sliccSeven: structuredClone(seven),
    location: { hostname: host },
    chrome: { runtime: { connect: () => worker } },
    window: relayWindow,
    addEventListener: (name, callback) => {
      if (name === 'message') take = callback;
    },
    removeEventListener() {},
    Uint8Array,
    btoa,
    atob,
  });
  const relayPath = new URL('../../../extension/relay.js', import.meta.url);
  vm.runInContext(await readFile(relayPath, 'utf8'), relay, { filename: fileURLToPath(relayPath) });
  let port;
  const page = vm.createContext({
    __sliccSeven: structuredClone(seven),
    location: { hostname: host, origin },
    MessageChannel: class {
      constructor() {
        this.port1 = port = {};
        this.port2 = {};
        this.port1.postMessage = (data) => this.port2.onmessage?.({ data: structuredClone(data) });
        this.port2.postMessage = (data) => this.port1.onmessage?.({ data: structuredClone(data) });
      }
    },
    postMessage: (data, target, ports) => take({ source: relayWindow, data, ports }),
  });
  const pagePath = new URL('../../../extension/page.js', import.meta.url);
  vm.runInContext(await readFile(pagePath, 'utf8'), page, { filename: fileURLToPath(pagePath) });
  return {
    fixture,
    page,
    worker,
    replies,
    deliver: (message) => port.onmessage({ data: structuredClone(message) }),
    close: fixture.close,
  };
}
