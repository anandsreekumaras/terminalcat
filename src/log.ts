// Structured logging via pino, with optional daily-rotating file output.
//
// Behaviour:
//   - Always logs human-readable lines to stderr (level >= info by default).
//   - If LOG_DIR env var is set, ALSO writes JSON-structured rolled
//     daily log files there (terminalcat-YYYY-MM-DD.log). Rolls on day
//     boundary, also when a single file passes 50 MB.
//
// Usage:
//   import { log } from './log';
//   log.info({ ip, email }, '[ws] open');
//   log.warn({ reason }, '[auth] http 401');
//
// Per-WS connection accounting (sessions opened, bytes up/down, duration)
// is computed at WS close time and logged as a single line — see server.ts.

import * as path from 'node:path';
import * as fs from 'node:fs';
import pino from 'pino';

const LOG_LEVEL = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
const LOG_DIR = process.env['LOG_DIR'];

// Build a multi-target transport. The pino docs recommend constructing
// targets dynamically when their presence depends on env. The console
// target uses pino-pretty if available; otherwise plain JSON.
const targets: pino.TransportTargetOptions[] = [
  // Console — always on. Use pino's default JSON to keep things simple
  // and parseable. Run through `pino-pretty` in a pipeline if you want
  // colour during dev (`pnpm dev | pnpm dlx pino-pretty`).
  {
    target: 'pino/file',
    level: LOG_LEVEL,
    options: { destination: 2 },  // stderr
  },
];

if (LOG_DIR) {
  // pino-roll handles the file rotation itself (no external logrotate).
  // We resolve the dir to ensure it's absolute, and let pino-roll mkdir
  // it on first write.
  const resolved = path.resolve(LOG_DIR);
  try { fs.mkdirSync(resolved, { recursive: true }); } catch { /* ignore */ }
  targets.push({
    target: 'pino-roll',
    level: LOG_LEVEL,
    options: {
      file: path.join(resolved, 'terminalcat.log'),
      // Roll on day boundary, also if a file exceeds 50 MB. Keep 14
      // generations — adjust for your disk budget.
      frequency: 'daily',
      size: '50m',
      mkdir: true,
      symlink: true,
      limit: { count: 14 },
    },
  });
}

export const log = pino({
  level: LOG_LEVEL,
  base: { app: 'terminalcat' },     // every line carries this label
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // Render levels as words ("info") instead of numbers (30) — easier
    // to scan in `tail -f`.
    level: (label) => ({ level: label }),
  },
}, pino.transport({ targets }));
