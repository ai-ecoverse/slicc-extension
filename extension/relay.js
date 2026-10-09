function serve(page) {
  const open = new Map();
  let cdpPort;
  function cdpWorker() {
    if (cdpPort) return cdpPort;
    const worker = chrome.runtime.connect({ name: 'slicc-fetch' });
    cdpPort = worker;
    worker.onMessage.addListener((message) => page.postMessage({ cdp: message }));
    worker.onDisconnect.addListener(() => {
      if (cdpPort !== worker) return;
      cdpPort = undefined;
      page.postMessage({ cdp: { error: 'slicc-extension: relay disconnected' } });
    });
    return worker;
  }
  page.onmessage = ({ data }) => {
    const { id } = data;
    if (data.cdp) {
      try {
        cdpWorker().postMessage(data.cdp);
      } catch (error) {
        page.postMessage({ cdp: { id: data.cdp.id, error: String(error?.message ?? error) } });
      }
      return;
    }
    if (data.signIn) {
      chrome.runtime.sendMessage({ type: 'slicc-sign-in', options: data.signIn }).then(
        (answer) => page.postMessage({ id, ...answer }),
        (error) => page.postMessage({ id, error: String(error?.message ?? error) })
      );
      return;
    }
    if (data.read) {
      open.get(id)?.postMessage({ read: true });
      return;
    }
    if (data.abort) {
      open.get(id)?.disconnect();
      open.delete(id);
      return;
    }
    const worker = chrome.runtime.connect({ name: 'slicc-fetch' });
    open.set(id, worker);
    worker.onMessage.addListener((message) => {
      if (message.chunk) {
        const { buffer } = Uint8Array.fromBase64(message.chunk);
        page.postMessage({ id, chunk: buffer }, [buffer]);
        return;
      }
      page.postMessage({ id, ...message });
      if (message.end || message.error) {
        open.delete(id);
        worker.disconnect();
      }
    });
    worker.onDisconnect.addListener(() => {
      if (open.delete(id)) page.postMessage({ id, error: 'slicc-extension: relay disconnected' });
    });
    const body = data.body ? new Uint8Array(data.body).toBase64() : undefined;
    worker.postMessage({ url: data.url, method: data.method, headers: data.headers, body });
  };
}

addEventListener('message', function take(event) {
  if (event.source !== window || event.data?.type !== 'slicc-extension:port') return;
  if (!event.ports[0]) return;
  removeEventListener('message', take);
  serve(event.ports[0]);
});
