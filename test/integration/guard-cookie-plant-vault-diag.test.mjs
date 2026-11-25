import { test } from 'node:test';
import { runVaultDiag } from './guard/run.mjs';

const pairs = [
  ['seven', 'prompt'],
  ['seven', 'lagging'],
  ['six-bridge', 'prompt'],
  ['six-bridge', 'lagging'],
];

for (const [transport, variant] of pairs) {
  test(`diagnostic cookie-plant vault ${transport} ${variant}`, { timeout: 1500000 }, () =>
    runVaultDiag(transport, variant, 20)
  );
}
