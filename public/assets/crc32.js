// CRC-32 (IEEE), slicing-by-8 for speed. Used for the zip download.
const T = new Uint32Array(8 * 256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  T[i] = c >>> 0;
}
for (let i = 0; i < 256; i++) for (let s = 1; s < 8; s++) T[s * 256 + i] = (T[(s - 1) * 256 + i] >>> 8) ^ T[T[(s - 1) * 256 + i] & 0xff];

export function crc32Update(crc, u8) {
  let c = ~crc >>> 0;
  let i = 0;
  const n = u8.length;
  for (; i + 8 <= n; i += 8) {
    c ^= u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24);
    c = T[7 * 256 + (c & 0xff)] ^ T[6 * 256 + ((c >>> 8) & 0xff)] ^ T[5 * 256 + ((c >>> 16) & 0xff)] ^ T[4 * 256 + (c >>> 24)]
      ^ T[3 * 256 + u8[i + 4]] ^ T[2 * 256 + u8[i + 5]] ^ T[256 + u8[i + 6]] ^ T[u8[i + 7]];
  }
  for (; i < n; i++) c = T[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
