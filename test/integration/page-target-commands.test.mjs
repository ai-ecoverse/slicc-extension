import { test } from 'node:test';
import { pageCommands } from './guard/run.mjs';

test('page-session target commands: a/b/c/d', { timeout: 120000 }, async () => {
  console.log(`page-session target commands: ${JSON.stringify(await pageCommands('six-bridge'))}`);
});
