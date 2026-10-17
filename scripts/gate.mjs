import { spawn } from 'node:child_process';
import { isMain } from './is-main.mjs';

export function verdict(name, output) {
  const pass = new RegExp(`^${name}: PASS\\b`, 'm');
  return pass.test(output);
}

export function runGate(name, command, args) {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.on('error', (err) => done({ ok: false, reason: err.message }));
    child.on('close', (code, signal) => {
      if (code !== 0) return done({ ok: false, reason: `exited ${code ?? signal}` });
      if (!verdict(name, output))
        return done({ ok: false, reason: `printed no "${name}: PASS" line` });
      done({ ok: true });
    });
  });
}

if (isMain(import.meta.url)) {
  const [name, sep, command, ...args] = process.argv.slice(2);
  if (!name || sep !== '--' || !command) {
    process.stderr.write('usage: gate.mjs <name> -- <command> [args...]\n');
    process.exit(2);
  }
  const result = await runGate(name, command, args);
  if (!result.ok) {
    process.stderr.write(`GATE FAILED: ${name} ${result.reason}\n`);
    process.exit(1);
  }
}
