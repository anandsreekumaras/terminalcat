// Env loading and validation. Imported once from server.ts startup so any
// missing required var halts the process before we open a port.
//
// Order of precedence:
//   1. process.env as set by systemd / shell (always wins)
//   2. .env file in cwd, if present (loaded by us, never overrides)
//
// We don't depend on `dotenv`. The grammar we accept is intentionally tight:
// KEY=value, optional surrounding quotes, no variable expansion, no escapes.
// If you need more, you should be using a real secrets manager, not a file.

import * as fs from 'node:fs';
import * as path from 'node:path';

function loadEnvFile(filePath: string): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return; // missing .env is normal in production
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    let val = trimmed.slice(eq + 1).trim();
    // strip a single pair of surrounding quotes
    const m = val.match(/^"(.*)"$|^'(.*)'$/);
    if (m) val = m[1] ?? m[2] ?? '';
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile(path.resolve(process.cwd(), '.env'));

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(
      `refusing to start: env var ${name} is required.\n` +
      `Copy .env.example to .env and fill it in, or set ${name} via systemd.`,
    );
    process.exit(1);
  }
  return v;
}

// Public, frozen config. Anyone who imports this module triggers the env
// validation as a side effect — that's deliberate, it's the point.
export const config = Object.freeze({
  CF_ACCESS_TEAM_DOMAIN: need('CF_ACCESS_TEAM_DOMAIN'),
  CF_ACCESS_AUD: need('CF_ACCESS_AUD'),
});
