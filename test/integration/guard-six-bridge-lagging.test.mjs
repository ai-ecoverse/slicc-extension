import { test } from 'node:test';
import { runGuard } from './guard/run.mjs';

test('guard vectors on six-bridge, lagging', { timeout: 1500000 }, () =>
  runGuard('six-bridge', 'lagging')
);
