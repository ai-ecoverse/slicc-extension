import { test } from 'node:test';
import { repeatRows } from './guard/run.mjs';

test('guard rows on six-bridge, prompt, a', { timeout: 1500000 }, () =>
  repeatRows('six-bridge', 'prompt', 'six-bridge-prompt-a', 40, 900000)
);
