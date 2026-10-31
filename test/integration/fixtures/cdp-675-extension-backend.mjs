import { listen } from '../../../extension/cdp.js';

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (...args) => Promise.all([...listeners].map((listener) => listener(...args))),
  };
}

export async function backend() {
  const calls = [];
  const messages = [];
  const ordinary = 'https://ordinary.test/';
  let frame = {
    id: 'root',
    loaderId: 'ordinary-document',
    url: ordinary,
    securityOrigin: 'https://ordinary.test',
  };
  let stall = false;
  let workerTab = { id: 11, url: ordinary, status: 'complete' };
  let stored = {};
  const api = {
    storage: {
      session: {
        get: async () => structuredClone(stored),
        set: async (value) => {
          stored = structuredClone(value);
        },
      },
    },
    alarms: { onAlarm: event(), create: async () => {}, clear: async () => {} },
    tabs: {
      get: async () => workerTab,
      query: async () => [],
      onUpdated: event(),
      onCreated: event(),
      onRemoved: event(),
      onActivated: event(),
    },
    windows: { onRemoved: event() },
    webNavigation: {
      getAllFrames: async () => [{ frameId: 0, documentId: frame.loaderId, url: frame.url }],
      onCreatedNavigationTarget: event(),
      onCommitted: event(),
    },
    debugger: {
      onEvent: event(),
      onDetach: event(),
      attach: async () => calls.push({ method: 'attach' }),
      detach: async () => calls.push({ method: 'detach' }),
      sendCommand: async (source, method, params) => {
        calls.push({ source, method, params });
        if (method === 'Runtime.enable') {
          await api.debugger.onEvent.emit({ tabId: 11 }, 'Runtime.executionContextCreated', {
            context: {
              id: 1,
              uniqueId: 'ordinary-context',
              origin: frame.securityOrigin,
              auxData: { isDefault: true, frameId: 'root' },
            },
          });
        }
        if (method === 'Page.getFrameTree') {
          if (stall) return new Promise(() => {});
          return { frameTree: { frame: { ...frame } } };
        }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 999 };
        if (method === 'Debugger.setInstrumentationBreakpoint')
          return { breakpointId: 'instrumentation' };
        if (method === 'Debugger.getScriptSource') return { scriptSource: 'ordinary source' };
        if (method === 'Debugger.evaluateOnCallFrame')
          return { result: { type: 'number', value: 42 } };
        return {};
      },
    },
  };
  const port = {
    name: 'slicc-fetch',
    sender: { id: '675', url: 'https://seven.sliccy.ai/' },
    onDisconnect: event(),
    postMessage: (message) => messages.push(message),
    disconnect: () => {},
  };
  const connection = listen(port, '675', api);
  connection.handle({
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '11', flatten: true },
  });
  await connection.settled();
  const attached = messages.find((message) => message.id === 1);
  if (!attached?.result?.sessionId) throw new Error('fake backend attachment failed');
  const sessionId = attached.result.sessionId;
  let id = 1;
  return {
    api,
    calls,
    messages,
    sessionId,
    connection,
    async command(method, params = {}) {
      const next = ++id;
      connection.handle({ id: next, method, params, sessionId });
      await connection.settled();
      return messages.find((message) => message.id === next);
    },
    emit: (method, params) => api.debugger.onEvent.emit({ tabId: 11 }, method, params),
    async lease() {
      await api.debugger.onEvent.emit({ tabId: 11 }, 'Runtime.executionContextCreated', {
        context: {
          id: 1,
          uniqueId: 'ordinary-context',
          origin: 'https://ordinary.test',
          auxData: { isDefault: true, frameId: 'root' },
        },
      });
      const reply = await this.command('Debugger.enable');
      if (reply.error) throw new Error(reply.error);
      const instrumented = await this.command('Debugger.setInstrumentationBreakpoint', {
        instrumentation: 'beforeScriptExecution',
      });
      if (instrumented.error) throw new Error(instrumented.error);
    },
    async commit() {
      frame = { ...frame, loaderId: 'next-document' };
      await this.emit('Page.frameNavigated', { frame });
    },
    errorPage() {
      frame = {
        id: 'root',
        loaderId: 'blocked-document',
        url: 'chrome-error://chromewebdata/',
        securityOrigin: '://',
        unreachableUrl: 'https://vault.sliccy.ai/private',
      };
      workerTab = { ...workerTab, url: frame.url };
    },
    stallRead() {
      stall = true;
    },
    close: () => connection.close(),
  };
}
