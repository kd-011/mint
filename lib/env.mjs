// Mint's .env: KEY=value lines, read once at start. A variable already set in
// the environment wins over the file.
import { readFileSync, existsSync } from 'node:fs';

export function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
