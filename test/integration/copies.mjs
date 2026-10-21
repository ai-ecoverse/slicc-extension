import { cp, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { cwd } from 'node:process';
import { pathToFileURL } from 'node:url';

const outputs = ['coverage', 'hotspots'];

async function remap(pairs, cache) {
  const swaps = pairs.flatMap(([from, to]) => [
    [pathToFileURL(`${to}${sep}`).href, pathToFileURL(`${from}${sep}`).href],
    [`"${relative(cwd(), to)}${sep}`, `"${relative(cwd(), from)}${sep}`],
  ]);
  for (const name of outputs) {
    const dir = join(cache, name);
    for (const file of await readdir(dir).catch(() => [])) {
      const path = join(dir, file);
      const text = await readFile(path, 'utf8').catch(() => '');
      const next = swaps.reduce((out, [was, is]) => out.replaceAll(was, is), text);
      if (next !== text) await writeFile(path, next);
    }
  }
}

export async function copies(
  dirs,
  { cache = join(cwd(), 'node_modules/.cache/slicc-harness') } = {}
) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'slicc-extension-copy-')));
  const pairs = [];
  try {
    for (const [index, dir] of dirs.entries()) {
      const from = await realpath(dir);
      const to = join(scratch, `${index}-${basename(from)}`);
      await cp(from, to, {
        recursive: true,
        filter: (path) => relative(from, path).split(sep)[0] !== '_metadata',
      });
      pairs.push([from, to]);
    }
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
  return {
    paths: pairs.map(([, to]) => to),
    async remove() {
      await remap(pairs, cache);
      await rm(scratch, { recursive: true, force: true });
    },
  };
}
