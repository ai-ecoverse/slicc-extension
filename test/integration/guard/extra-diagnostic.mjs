import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function extraDiagnostic(paths) {
  const file = join(paths[0], 'six-sw.js');
  const source = await readFile(file, 'utf8');
  const trace = `
const sliccExtraEvent = TabShield.prototype.onEvent;
TabShield.prototype.onEvent = function(method, params) {
  const id = params?.requestId;
  const hop = this.hops.get(id);
  const headers = params?.headers ?? {};
  const location = headers.location ?? headers.Location;
  const match = hop && hop !== 'done' && hop.status === params?.statusCode && hop.location === location;
  const before = this.requests.get(id);
  const out = sliccExtraEvent.call(this, method, params);
  if (method === 'Network.responseReceivedExtraInfo' && [301, 302, 303, 307, 308].includes(params?.statusCode)) {
    const list = globalThis.__sliccExtraTrace ??= [];
    list.push({ at: Date.now(), id, status: params.statusCode, before, hop: hop === 'done' ? 'done' : hop?.status, match: Boolean(match), forwarded: out.length, after: this.requests.get(id) });
    if (list.length > 2000) list.shift();
  }
  return out;
};
`;
  await writeFile(file, `${source}\n${trace}`);
}
