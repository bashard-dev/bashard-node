// Arithmetic in GF(2^8) with the AES-free primitive polynomial x^8+x^4+x^3+x^2+1 (0x11d).

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("GF(256) division by zero");
  if (a === 0) return 0;
  return EXP[LOG[a] + 255 - LOG[b]];
}

export function gfInv(a: number): number {
  return gfDiv(1, a);
}

/** 256-entry table of c·x for every x, so a row multiply is one lookup per byte. */
const MUL_TABLES: Uint8Array[] = [];
export function mulTable(c: number): Uint8Array {
  let t = MUL_TABLES[c];
  if (!t) {
    t = new Uint8Array(256);
    for (let x = 0; x < 256; x++) t[x] = gfMul(c, x);
    MUL_TABLES[c] = t;
  }
  return t;
}

/** dst ^= c · src, byte by byte. */
export function mulAddInto(dst: Uint8Array, src: Uint8Array, c: number): void {
  if (c === 0) return;
  const len = Math.min(dst.length, src.length);
  if (c === 1) {
    for (let i = 0; i < len; i++) dst[i] ^= src[i];
    return;
  }
  const t = mulTable(c);
  for (let i = 0; i < len; i++) dst[i] ^= t[src[i]];
}

/** Invert a square matrix over GF(256) by Gauss–Jordan elimination. */
export function invertMatrix(m: number[][]): number[][] {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    while (pivot < n && a[pivot][col] === 0) pivot++;
    if (pivot === n) throw new Error("matrix is singular");
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const inv = gfInv(a[col][col]);
    for (let j = 0; j < 2 * n; j++) a[col][j] = gfMul(a[col][j], inv);
    for (let r = 0; r < n; r++) {
      if (r === col || a[r][col] === 0) continue;
      const f = a[r][col];
      for (let j = 0; j < 2 * n; j++) a[r][j] ^= gfMul(f, a[col][j]);
    }
  }
  return a.map((row) => row.slice(n));
}
