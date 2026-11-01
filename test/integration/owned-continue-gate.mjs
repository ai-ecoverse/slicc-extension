export function continueGate(send) {
  return async (target, method, params) => {
    const gate = globalThis.__continueGate;
    if (gate?.tabId === target.tabId) {
      if (method === 'Page.getFrameTree') {
        if (!gate.continued) {
          gate.trees += 1;
          throw new Error('renderer unavailable during request pause');
        }
        gate.afterTrees += 1;
      }
      if (method.startsWith('Fetch.')) gate.forwarded.push(method);
      if (method === 'Fetch.continueRequest' && params?.requestId === gate.requestId) {
        gate.continued = true;
      }
    }
    return send(target, method, params);
  };
}
