import { test } from 'node:test';
import { repeatRows } from './guard/run.mjs';

test('guard rows on six-bridge, lagging, b', { timeout: 1500000 }, () =>
  repeatRows('six-bridge', 'lagging', 'six-bridge-lagging-b', 40, 900000)
);
