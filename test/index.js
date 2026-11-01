// Node 22 resolves `node --test test/` to this file rather than globbing the
// folder, so load every suite from here. `node --test test/x.test.mjs` still
// runs one file on its own.
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
for (const f of readdirSync(__dirname).filter((n) => n.endsWith('.test.mjs')).sort()) {
  import(pathToFileURL(join(__dirname, f)).href);
}
