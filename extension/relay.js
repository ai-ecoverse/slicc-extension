function serve(page) {
  const open = new Map();
  page.onmessage = ({ data }) => {
    const { id } = data;
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
