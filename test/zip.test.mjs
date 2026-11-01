// The zero-dependency zip writer: real zips, checked by the system unzip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZipWriter } from '../lib/zip.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'mint-zip-'));

async function zipTo(path, fn) {
  const out = createWriteStream(path);
  const z = createZipWriter(out);
  await fn(z);
  const r = await z.finish();
  out.end();
  await once(out, 'close');
  return r;
}

test('stored and deflated entries unzip byte for byte and pass unzip -t', async () => {
  const dir = tmp();
  const file = join(dir, 'a.zip');
  const big = Buffer.from('mint '.repeat(200000)); // compresses well
  const noise = randomBytes(300000); // does not
  writeFileSync(join(dir, 'noise.bin'), noise);
  const r = await zipTo(file, async (z) => {
    await z.addBuffer('hello.txt', Buffer.from('héllo wörld\n'));
    await z.addBuffer('big/big.txt', big);
    await z.addBuffer('empty.txt', Buffer.alloc(0));
    await z.addFile('receipts/noise.bin', join(dir, 'noise.bin'), { store: true });
  });
  assert.equal(r.entries, 4);
  assert.match(execFileSync('unzip', ['-t', file]).toString(), /No errors detected/);
  const ex = join(dir, 'x');
  execFileSync('unzip', ['-q', file, '-d', ex]);
  assert.equal(readFileSync(join(ex, 'hello.txt'), 'utf8'), 'héllo wörld\n');
  assert.ok(readFileSync(join(ex, 'big/big.txt')).equals(big));
  assert.equal(statSync(join(ex, 'empty.txt')).size, 0);
  assert.ok(readFileSync(join(ex, 'receipts/noise.bin')).equals(noise));
  // the deflated entry really is smaller, the stored one is not
  const list = execFileSync('unzip', ['-v', file]).toString();
  assert.match(list, /Defl:N/);
  assert.match(list, /Stored/);
  assert.ok(statSync(file).size < big.length / 4 + noise.length + 2000);
});

test('entry modes are readable (not 000) after extraction', async () => {
  const dir = tmp();
  const file = join(dir, 'm.zip');
  await zipTo(file, (z) => z.addBuffer('a.txt', Buffer.from('x')));
  execFileSync('unzip', ['-q', file, '-d', join(dir, 'x')]);
  assert.ok((statSync(join(dir, 'x/a.txt')).mode & 0o400) !== 0);
});

test('unsafe or duplicate names are refused', async () => {
  const dir = tmp();
  const out = createWriteStream(join(dir, 'n.zip'));
  const z = createZipWriter(out);
  await z.addBuffer('ok.txt', Buffer.from('1'));
  for (const bad of ['../evil.txt', '/abs.txt', 'a/../b.txt', 'back\\slash.txt', '', 'ok.txt']) {
    await assert.rejects(() => z.addBuffer(bad, Buffer.from('x')), /name/i, bad);
  }
  out.destroy();
});

test('a missing source file rejects instead of writing a broken zip entry', async () => {
  const dir = tmp();
  await assert.rejects(() => zipTo(join(dir, 'e.zip'), (z) => z.addFile('x.bin', join(dir, 'nope.bin'), { store: true })), /ENOENT/);
});

test('many entries keep a valid central directory', async () => {
  const dir = tmp();
  const file = join(dir, 'many.zip');
  await zipTo(file, async (z) => { for (let i = 0; i < 500; i++) await z.addBuffer(`d/${i}.txt`, Buffer.from(`row ${i}\n`)); });
  assert.match(execFileSync('unzip', ['-t', file]).toString(), /No errors detected/);
  execFileSync('unzip', ['-q', file, '-d', join(dir, 'x')]);
  assert.equal(readdirSync(join(dir, 'x/d')).length, 500);
});
