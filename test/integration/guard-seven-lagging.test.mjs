import { test } from 'node:test';
import { runGuard } from './guard/run.mjs';

test('guard vectors on seven, lagging', { timeout: 1500000 }, () => runGuard('seven', 'lagging'));
