// A small streaming zip writer on node:zlib, no package. Entries go to a
// writable one at a time with a data descriptor, so nothing is held in memory
// beyond one stream chunk: a file is read, counted for its CRC, optionally
// deflated, and written straight out. Plain zip only (no zip64), so it refuses
// anything that would overflow 4 GiB or 65,535 entries.
import { createReadStream } from 'node:fs';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, crc32 } from 'node:zlib';
import { HttpError } from './errors.mjs';
import { zoneParts } from './dates.mjs';

const MAX = 0xffffffff;
const MAX_ENTRIES = 0xfffe;
const NAME = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\/\/)[^\\\0]+$/;

// MS-DOS stamp, read off the MINT_TZ clock rather than the server's own.
function dosTime(d) {
  const p = zoneParts(d);
  const time = (p.hour << 11) | (p.minute << 5) | (p.second >> 1);
  const date = (Math.max(0, p.year - 1980) << 9) | (p.month << 5) | p.day;
  return { time, date };
}

export function createZipWriter(out, { now = new Date() } = {}) {
  const { time, date } = dosTime(now);
  const central = [];
  const names = new Set();
  let offset = 0;
  let finished = false;

  const put = (chunk) => new Promise((resolve, reject) => {
    out.write(chunk, (err) => (err ? reject(err) : resolve()));
    offset += chunk.length;
    if (offset > MAX) reject(new HttpError(413, 'the pack is too large to zip'));
  });

  function claim(name) {
    if (finished) throw new Error('zip is already finished');
    if (typeof name !== 'string' || !name || name.length > 240 || !NAME.test(name) || names.has(name)) throw new Error(`bad or duplicate zip entry name: ${name}`);
    if (central.length >= MAX_ENTRIES) throw new HttpError(413, 'the pack has too many files');
    names.add(name);
    return Buffer.from(name, 'utf8');
  }

  function localHeader(nameBuf, method) {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0808, 6); // data descriptor follows, names are UTF-8
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt16LE(nameBuf.length, 26);
    return Buffer.concat([h, nameBuf]);
  }

  // source is a function returning the readable, so it opens only once its turn comes.
  async function addStream(name, source, { store = false } = {}) {
    const nameBuf = claim(name);
    const method = store ? 0 : 8;
    const start = offset;
    await put(localHeader(nameBuf, method));
    let crc = 0;
    let usize = 0;
    let csize = 0;
    const tap = new Transform({ transform(c, _e, cb) { crc = crc32(c, crc); usize += c.length; cb(null, c); } });
    const sink = new Writable({ write(c, _e, cb) { csize += c.length; put(c).then(() => cb(), cb); } });
    await pipeline(source(), tap, ...(store ? [] : [createDeflateRaw({ level: 6 })]), sink);
    if (usize > MAX || csize > MAX) throw new HttpError(413, 'a file in the pack is too large to zip');
    const d = Buffer.alloc(16);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(crc, 4);
    d.writeUInt32LE(csize, 8);
    d.writeUInt32LE(usize, 12);
    await put(d);
    central.push({ nameBuf, method, crc, csize, usize, start });
  }

  return {
    addBuffer: (name, buf, opts) => addStream(name, () => Readable.from([buf]), opts),
    addFile: (name, path, opts) => addStream(name, () => createReadStream(path), opts),
    async finish() {
      if (finished) throw new Error('zip is already finished');
      const cdStart = offset;
      for (const e of central) {
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50, 0);
        h.writeUInt16LE(0x031e, 4); // made by unix, spec 3.0
        h.writeUInt16LE(20, 6);
        h.writeUInt16LE(0x0808, 8);
        h.writeUInt16LE(e.method, 10);
        h.writeUInt16LE(time, 12);
        h.writeUInt16LE(date, 14);
        h.writeUInt32LE(e.crc, 16);
        h.writeUInt32LE(e.csize, 20);
        h.writeUInt32LE(e.usize, 24);
        h.writeUInt16LE(e.nameBuf.length, 28);
        h.writeUInt32LE((0o100644 << 16) >>> 0, 38);
        h.writeUInt32LE(e.start, 42);
        await put(Buffer.concat([h, e.nameBuf]));
      }
      const cdSize = offset - cdStart;
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(central.length, 8);
      eocd.writeUInt16LE(central.length, 10);
      eocd.writeUInt32LE(cdSize, 12);
      eocd.writeUInt32LE(cdStart, 16);
      await put(eocd);
      finished = true;
      return { entries: central.length, bytes: offset };
    },
  };
}
