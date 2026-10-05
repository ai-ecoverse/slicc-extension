(() => {
  const { port1, port2 } = new MessageChannel();
  const open = new Map();
  const bodiless = new Set([101, 103, 204, 205, 304]);
  let next = 0;

  port1.onmessage = ({ data }) => open.get(data.id)?.(data);
  postMessage({ type: 'slicc-extension:port' }, location.origin, [port2]);

  function receive(id, signal, resolve, reject) {
    let controller;
    const stop = () => {
      if (open.delete(id)) port1.postMessage({ id, abort: true });
    };
    const body = new ReadableStream({
      start: (c) => {
        controller = c;
      },
      cancel: stop,
    });
    const abort = () => {
      stop();
      reject(signal.reason);
      controller.error(signal.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    open.set(id, (message) => {
      if (message.status !== undefined) {
        const { status, statusText, headers } = message;
        resolve(new Response(bodiless.has(status) ? null : body, { status, statusText, headers }));
      } else if (message.chunk) {
        controller.enqueue(new Uint8Array(message.chunk));
      } else {
        open.delete(id);
        signal?.removeEventListener('abort', abort);
        if (message.end) controller.close();
        else {
          const error = new TypeError(message.error);
          reject(error);
          controller.error(error);
        }
      }
    });
  }

  async function relayFetch(input, init = {}) {
    init.signal?.throwIfAborted();
    const url = new URL(input, location.href).href;
    const method = init.method ?? 'GET';
    const headers = [...new Headers(init.headers)];
    const body = init.body == null ? undefined : await new Response(init.body).arrayBuffer();
    const id = ++next;
    return new Promise((resolve, reject) => {
      receive(id, init.signal, resolve, reject);
      port1.postMessage({ id, url, method, headers, body }, body ? [body] : []);
    });
  }

  Object.defineProperty(globalThis, 'sliccExtension', {
    value: Object.freeze({ fetch: relayFetch }),
  });
})();
