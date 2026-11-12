import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planZip, zipStream } from '../src/zip.js';
import { crc32Update } from '../public/assets/crc32.js';

const VERIFY = `
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
print(json.dumps({"bad": bad, "names": z.namelist(), "sizes": [i.file_size for i in z.infolist()]}))
`;

async function build(files, limit) {
  const entries = files.map((f, i) => ({ name: f.name, size: f.data.length, crc32: crc32(f.data), mtime: Date.UTC(2026, 10, 11, 3, 4, 6), i }));
  const plan = planZip(entries, limit);
  const stream = zipStream(plan, async (it) => new Blob([files[it.i].data]).stream());
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  assert.equal(buf.length, plan.total, 'Content-Length must equal real size');
  const dir = mkdtempSync(join(tmpdir(), 'zt-'));
  writeFileSync(join(dir, 'a.zip'), buf);
  return { out: JSON.parse(execFileSync('python3', ['-I', '-c', VERIFY, join(dir, 'a.zip')]).toString()), file: join(dir, 'a.zip'), plan };
}

const sample = () => [
  { name: 'readme.txt', data: Buffer.from('hello world\n') },
  { name: 'Folder/Sub folder/日本語 ファイル.bin', data: Buffer.from(Array.from({ length: 70000 }, (_, i) => (i * 31) & 255)) },
  { name: 'empty.dat', data: Buffer.alloc(0) },
];

test('normal zip passes python testzip and unzip -t', async () => {
  const { out, file, plan } = await build(sample());
  assert.equal(out.bad, null);
  assert.deepEqual(out.names, sample().map((f) => f.name));
  assert.equal(plan.zip64End, false);
  execFileSync('unzip', ['-tq', file]);
});

test('ZIP64 records (forced small limit) pass python testzip', async () => {
  const { out, plan } = await build(sample(), 100);
  assert.equal(plan.zip64End, true);
  assert.ok(plan.items.some((i) => i.big) && plan.items.some((i) => i.bigOff));
  assert.equal(out.bad, null);
  assert.deepEqual(out.sizes, [12, 70000, 0]);
});

test('size mismatch aborts the stream instead of writing a bad zip', async () => {
  const plan = planZip([{ name: 'a', size: 5, crc32: 0, mtime: 0 }]);
  const s = zipStream(plan, async () => new Blob([Buffer.from('abc')]).stream());
  await assert.rejects(new Response(s).arrayBuffer());
});

test('browser CRC-32 matches zlib, also when fed in parts', () => {
  const data = Buffer.from(Array.from({ length: 1_000_003 }, (_, i) => (i * 7919) & 255));
  let c = 0;
  for (let i = 0; i < data.length; i += 65_537) c = crc32Update(c, data.subarray(i, i + 65_537));
  assert.equal(c, crc32(data));
  assert.equal(crc32Update(0, new Uint8Array(0)), 0);
});
