// Streaming ZIP writer, "stored" method (no compression), ZIP64 when needed.
// CRC-32 values come from the browser at upload time, so the Worker only
// pipes bytes. Every size is known up front, so Content-Length is exact.

const U32 = 0xffffffff;
const enc = new TextEncoder();

function dosTime(ms) {
  const d = new Date(ms);
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = (Math.max(0, d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

class Buf {
  constructor(n) { this.u8 = new Uint8Array(n); this.v = new DataView(this.u8.buffer); this.o = 0; }
  u16(x) { this.v.setUint16(this.o, x, true); this.o += 2; return this; }
  u32(x) { this.v.setUint32(this.o, x >>> 0, true); this.o += 4; return this; }
  u64(x) { this.v.setBigUint64(this.o, BigInt(x), true); this.o += 8; return this; }
  bytes(b) { this.u8.set(b, this.o); this.o += b.length; return this; }
}

// entries: [{ name, size, crc32, mtime }]. limit lets tests force ZIP64.
export function planZip(entries, limit = U32) {
  let offset = 0;
  const items = entries.map((e) => {
    const name = enc.encode(e.name);
    const big = e.size >= limit;
    const localLen = 30 + name.length + (big ? 20 : 0);
    const item = { ...e, nameBytes: name, big, offset, localLen };
    offset += localLen + e.size;
    return item;
  });
  const cdStart = offset;
  let cdSize = 0;
  for (const it of items) {
    it.bigOff = it.offset >= limit;
    const extra = (it.big ? 16 : 0) + (it.bigOff ? 8 : 0);
    it.cdExtra = extra ? extra + 4 : 0;
    cdSize += 46 + it.nameBytes.length + it.cdExtra;
  }
  const zip64End = items.length >= 0xffff || cdStart >= limit || cdSize >= limit || items.some((i) => i.big || i.bigOff);
  const total = cdStart + cdSize + (zip64End ? 56 + 20 : 0) + 22;
  return { items, cdStart, cdSize, zip64End, total, limit };
}

export function localHeader(it) {
  const { time, date } = dosTime(it.mtime);
  const b = new Buf(it.localLen);
  b.u32(0x04034b50).u16(it.big ? 45 : 20).u16(0x0800).u16(0).u16(time).u16(date)
    .u32(it.crc32).u32(it.big ? U32 : it.size).u32(it.big ? U32 : it.size)
    .u16(it.nameBytes.length).u16(it.big ? 20 : 0).bytes(it.nameBytes);
  if (it.big) b.u16(0x0001).u16(16).u64(it.size).u64(it.size);
  return b.u8;
}

export function centralDirectory(plan) {
  const { items, cdStart, cdSize, zip64End } = plan;
  const b = new Buf(cdSize + (zip64End ? 76 : 0) + 22);
  for (const it of items) {
    const { time, date } = dosTime(it.mtime);
    const need = it.big || it.bigOff ? 45 : 20;
    b.u32(0x02014b50).u16(need).u16(need).u16(0x0800).u16(0).u16(time).u16(date)
      .u32(it.crc32).u32(it.big ? U32 : it.size).u32(it.big ? U32 : it.size)
      .u16(it.nameBytes.length).u16(it.cdExtra).u16(0).u16(0).u16(0).u32(0)
      .u32(it.bigOff ? U32 : it.offset).bytes(it.nameBytes);
    if (it.cdExtra) {
      b.u16(0x0001).u16(it.cdExtra - 4);
      if (it.big) b.u64(it.size).u64(it.size);
      if (it.bigOff) b.u64(it.offset);
    }
  }
  const n = items.length;
  if (zip64End) {
    const z64 = cdStart + cdSize;
    b.u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0).u64(n).u64(n).u64(cdSize).u64(cdStart);
    b.u32(0x07064b50).u32(0).u64(z64).u32(1);
    b.u32(0x06054b50).u16(0).u16(0).u16(0xffff).u16(0xffff).u32(U32).u32(U32).u16(0);
  } else {
    b.u32(0x06054b50).u16(0).u16(0).u16(n).u16(n).u32(cdSize).u32(cdStart).u16(0);
  }
  return b.u8;
}

// open(item) must resolve to a ReadableStream of exactly item.size bytes.
export function zipStream(plan, open, makeStream = () => new TransformStream()) {
  const { readable, writable } = makeStream();
  (async () => {
    const w = writable.getWriter();
    try {
      for (const it of plan.items) {
        await w.write(localHeader(it));
        const body = await open(it);
        const r = body.getReader();
        let seen = 0;
        for (;;) {
          const { done, value } = await r.read();
          if (done) break;
          seen += value.byteLength;
          await w.write(value);
        }
        if (seen !== it.size) throw new Error(`size mismatch for ${it.name}: ${seen} != ${it.size}`);
      }
      await w.write(centralDirectory(plan));
      await w.close();
    } catch (err) {
      await w.abort(err).catch(() => {});
    }
  })();
  return readable;
}
