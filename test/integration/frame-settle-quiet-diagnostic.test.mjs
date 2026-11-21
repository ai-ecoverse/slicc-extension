import { test } from 'node:test';
import { scenario } from './frame-settle-diag.mjs';

for (const host of ['seven.sliccy.ai', 'www.sliccy.ai']) {
  test(`frame settle quiet diagnostic ${host}`, { timeout: 900000 }, (t) =>
    scenario(t, host, 'quiet')
  );
}
