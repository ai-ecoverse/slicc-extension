import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function bindingDiagnostic(paths) {
  const file = join(paths[0], 'cdp.js');
  const source = await readFile(file, 'utf8');
  const site = '    this.closed = false;';
  assert.ok(source.includes(site));
  const trace = String.raw`
    const log = (entry) => {
      const list = globalThis.__sliccBindingTrace ??= [];
      list.push({ at: Date.now(), ...entry });
      if (list.length > 2000) list.shift();
    };
    for (const phase of ['admit', 'prove', 'bind', 'returned', 'committed', 'checkHistory', 'errorDocument', 'send']) {
      const original = this[phase];
      this[phase] = async (...args) => {
        const tabId = args[0];
        const tab = this.tabState(tabId);
        const method = args.find((arg) => typeof arg === 'string' && /^(Page|Runtime|Fetch|Network|DOM)\./.test(arg));
        const params = phase === 'send' ? args[2] : undefined;
        const worlds = tab?.worlds?.visible() ?? [];
        const state = { mainFrameId: tab?.mainFrameId, worlds: worlds.map((ctx) => ({ id: ctx.id, uniqueId: ctx.uniqueId, origin: ctx.origin, auxData: ctx.auxData })), documents: [...(tab?.documents?.contexts ?? [])], failed: this.state.failed.get(tabId) };
        log({ phase, tabId, method, action: 'enter', uniqueContextId: params?.uniqueContextId, probe: params?.expression === '({})', state });
        try {
          const result = await original.apply(this, args);
          const frame = method === 'Page.getFrameTree' ? result?.frameTree?.frame : undefined;
          log({ phase, tabId, method, action: 'return', frame, context: result?.result?.objectId, exception: result?.exceptionDetails?.text });
          return result;
        } catch (error) {
          log({ phase, tabId, method, action: 'error', error: String(error?.message ?? error), state });
          throw error;
        }
      };
    }
`;
  await writeFile(file, source.replace(site, `${trace}\n${site}`));
}
