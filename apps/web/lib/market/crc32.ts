const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Bytes(bytes: ArrayLike<number>): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** CRC-32 (IEEE) of a string's UTF-8 bytes as an unsigned 32-bit integer. The order-book checksum string is plain ASCII. */
export function crc32(text: string): number {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x80) return crc32Bytes(new TextEncoder().encode(text));
    bytes[i] = code;
  }
  return crc32Bytes(bytes);
}
