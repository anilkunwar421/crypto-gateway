// Monero's "Cryptonote-base58" — NOT the same as Bitcoin / Solana base58.
//
// Standard base58 encodes the whole byte string as one big-endian integer,
// which makes the output length sublinear-but-data-dependent. Monero
// addresses are fixed-length, so they use a *block-wise* variant: split the
// input into 8-byte blocks, encode each as exactly 11 base58 chars (or fewer
// when the final block is shorter), zero-padded on the left.
//
// Block sizes: 1 byte → 2 chars, 2 → 3, 3 → 5, 4 → 6, 5 → 7, 6 → 9, 7 → 10,
// 8 → 11. The decode side rejects any block that produces a value too large
// for its input size (catches truncated / pasted addresses).
//
// The Monero alphabet is the same as Bitcoin's. Reference: Cryptonote spec
// `common/base58.h` in the monero/monero repo.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_BYTES = new TextEncoder().encode(ALPHABET);

// Reverse map: char-code → digit (or 0xff for "not in alphabet").
const REVERSE_MAP = new Uint8Array(128).fill(0xff);
for (let i = 0; i < ALPHABET.length; i += 1) {
  REVERSE_MAP[ALPHABET.charCodeAt(i)] = i;
}

const FULL_BLOCK_SIZE = 8;
const FULL_ENCODED_BLOCK_SIZE = 11;

// Char-count ↔ byte-count for a single block. Index = number of base58 chars
// in the block; value = decoded byte count. -1 = invalid char count.
const ENCODED_BLOCK_SIZES_BY_BYTE_COUNT: readonly number[] = [
  0, 2, 3, 5, 6, 7, 9, 10, 11
];
const BYTE_COUNTS_BY_BLOCK_LEN: readonly number[] = [
  0, -1, 1, 2, -1, 3, 4, 5, -1, 6, 7, 8
];

const UINT64_MAX = 0xffffffffffffffffn;

export function moneroBase58Encode(bytes: Uint8Array): string {
  const out: string[] = [];
  const fullBlockCount = Math.floor(bytes.length / FULL_BLOCK_SIZE);
  const lastBlockSize = bytes.length % FULL_BLOCK_SIZE;
  for (let i = 0; i < fullBlockCount; i += 1) {
    out.push(encodeBlock(bytes.subarray(i * FULL_BLOCK_SIZE, (i + 1) * FULL_BLOCK_SIZE)));
  }
  if (lastBlockSize > 0) {
    out.push(encodeBlock(bytes.subarray(fullBlockCount * FULL_BLOCK_SIZE)));
  }
  return out.join("");
}

export function moneroBase58Decode(s: string): Uint8Array {
  const fullBlockCount = Math.floor(s.length / FULL_ENCODED_BLOCK_SIZE);
  const lastEncodedBlockSize = s.length % FULL_ENCODED_BLOCK_SIZE;
  const lastBlockBytes = lastEncodedBlockSize === 0 ? 0 : BYTE_COUNTS_BY_BLOCK_LEN[lastEncodedBlockSize];
  if (lastBlockBytes === undefined || lastBlockBytes < 0) {
    throw new Error(`moneroBase58Decode: invalid trailing block length ${lastEncodedBlockSize}`);
  }
  const out = new Uint8Array(fullBlockCount * FULL_BLOCK_SIZE + lastBlockBytes);
  for (let i = 0; i < fullBlockCount; i += 1) {
    decodeBlock(
      s.slice(i * FULL_ENCODED_BLOCK_SIZE, (i + 1) * FULL_ENCODED_BLOCK_SIZE),
      out,
      i * FULL_BLOCK_SIZE,
      FULL_BLOCK_SIZE
    );
  }
  if (lastEncodedBlockSize > 0) {
    decodeBlock(
      s.slice(fullBlockCount * FULL_ENCODED_BLOCK_SIZE),
      out,
      fullBlockCount * FULL_BLOCK_SIZE,
      lastBlockBytes
    );
  }
  return out;
}

function encodeBlock(block: Uint8Array): string {
  if (block.length < 1 || block.length > FULL_BLOCK_SIZE) {
    throw new Error(`encodeBlock: invalid block size ${block.length}`);
  }
  let num = 0n;
  for (const b of block) {
    num = (num << 8n) | BigInt(b);
  }
  const encodedBlockSize = ENCODED_BLOCK_SIZES_BY_BYTE_COUNT[block.length]!;
  const out = new Uint8Array(encodedBlockSize);
  // Fill from the right (least significant base58 digit first).
  let i = encodedBlockSize - 1;
  while (num > 0n && i >= 0) {
    const digit = Number(num % 58n);
    out[i] = ALPHABET_BYTES[digit]!;
    num = num / 58n;
    i -= 1;
  }
  // Zero-padding (= alphabet[0] = '1') on the left for the leading positions.
  while (i >= 0) {
    out[i] = ALPHABET_BYTES[0]!;
    i -= 1;
  }
  return new TextDecoder().decode(out);
}

function decodeBlock(
  blockStr: string,
  out: Uint8Array,
  outOffset: number,
  byteCount: number
): void {
  if (byteCount < 1 || byteCount > FULL_BLOCK_SIZE) {
    throw new Error(`decodeBlock: invalid byteCount ${byteCount}`);
  }
  let num = 0n;
  let order = 1n;
  for (let i = blockStr.length - 1; i >= 0; i -= 1) {
    const c = blockStr.charCodeAt(i);
    const digit = c < 128 ? REVERSE_MAP[c] : 0xff;
    if (digit === undefined || digit === 0xff) {
      throw new Error(`moneroBase58Decode: invalid character '${blockStr[i]}'`);
    }
    const inc = order * BigInt(digit);
    num += inc;
    if (num > UINT64_MAX) {
      throw new Error("moneroBase58Decode: block overflow");
    }
    order *= 58n;
  }
  // Reject blocks whose value doesn't fit in the declared byteCount —
  // catches a truncated or padded address paste.
  const maxForByteCount = byteCount < 8 ? (1n << BigInt(byteCount * 8)) : UINT64_MAX + 1n;
  if (byteCount < 8 && num >= maxForByteCount) {
    throw new Error(`moneroBase58Decode: block value exceeds ${byteCount}-byte capacity`);
  }
  // Write big-endian into out[outOffset..outOffset+byteCount].
  for (let i = byteCount - 1; i >= 0; i -= 1) {
    out[outOffset + i] = Number(num & 0xffn);
    num >>= 8n;
  }
}
