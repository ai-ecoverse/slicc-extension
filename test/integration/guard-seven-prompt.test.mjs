import { test } from 'node:test';
import { runGuard } from './guard/run.mjs';

test('guard vectors on seven, prompt', { timeout: 1500000 }, () => runGuard('seven', 'prompt'));
