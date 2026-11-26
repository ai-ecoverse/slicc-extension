import { test } from 'node:test';
import { repeatRows } from './guard/run.mjs';

test('guard rows on six-bridge, prompt, b', { timeout: 1500000 }, () =>
  repeatRows('six-bridge', 'prompt', 'six-bridge-prompt-b', 40, 900000)
);
