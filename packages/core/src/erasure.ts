// Systematic Reed–Solomon erasure code over GF(256) with a Cauchy parity matrix.
//
// An object of `size` bytes is cut into K data shards of equal length (zero
// padded) and N−K parity shards are derived from them. Any K of the N shards
// rebuild the object. The generator is [I_K ; C] where C is a Cauchy matrix,
// so every K×K sub-matrix is invertible.
//
// Tapedrive uses Clay codes for cheaper repair; plain RS is the MVP choice here:
// same storage overhead and recovery threshold, simpler to audit.

import { gfDiv, invertMatrix, mulAddInto } from "./gf256";

export const SHARDS_N = 20;
export const SHARDS_K = 7;

export function shardLength(size: number, k = SHARDS_K): number {
  return Math.max(1, Math.ceil(size / k));
}

/** Row `r` (0-based) of the N×K generator matrix. */
export function generatorRow(r: number, n = SHARDS_N, k = SHARDS_K): number[] {
  if (r < k) return Array.from({ length: k }, (_, j) => (j === r ? 1 : 0));
  // Cauchy: x_i = i (for parity rows i = r−k, offset by k), y_j = j; entries 1/(x_i ⊕ y_j)
  const x = r; // r ∈ [k, n) never collides with y ∈ [0, k)
  return Array.from({ length: k }, (_, j) => gfDiv(1, x ^ j));
}

export function encode(data: Uint8Array, n = SHARDS_N, k = SHARDS_K): Uint8Array[] {
  if (n > 255 || k < 1 || k >= n) throw new Error("bad code parameters");
  const len = shardLength(data.length, k);
  const shards: Uint8Array[] = [];
  for (let i = 0; i < k; i++) {
    const s = new Uint8Array(len);
    s.set(data.subarray(i * len, Math.min((i + 1) * len, data.length)));
    shards.push(s);
  }
  for (let r = k; r < n; r++) {
    const row = generatorRow(r, n, k);
    const p = new Uint8Array(len);
    for (let j = 0; j < k; j++) mulAddInto(p, shards[j], row[j]);
    shards.push(p);
  }
  return shards;
}

/**
 * Rebuild the original bytes from any K shards.
 * `shards[i]` is shard i or null/undefined when missing.
 */
export function decode(
  shards: (Uint8Array | null | undefined)[],
  size: number,
  n = SHARDS_N,
  k = SHARDS_K,
): Uint8Array {
  const data = reconstructData(shards, n, k);
  const len = data[0].length;
  const out = new Uint8Array(size);
  for (let i = 0; i < k; i++) {
    const start = i * len;
    if (start >= size) break;
    out.set(data[i].subarray(0, Math.min(len, size - start)), start);
  }
  return out;
}

/** Recover the K data shards. */
export function reconstructData(shards: (Uint8Array | null | undefined)[], n = SHARDS_N, k = SHARDS_K): Uint8Array[] {
  const have: number[] = [];
  for (let i = 0; i < n && have.length < k; i++) if (shards[i]) have.push(i);
  if (have.length < k) throw new Error(`need ${k} shards, have ${have.length}`);

  // Fast path: all data shards present.
  if (have.every((i, idx) => i === idx)) return have.map((i) => shards[i]!);

  const len = shards[have[0]]!.length;
  const sub = have.map((i) => generatorRow(i, n, k));
  const inv = invertMatrix(sub);
  const out: Uint8Array[] = [];
  for (let r = 0; r < k; r++) {
    const d = new Uint8Array(len);
    for (let j = 0; j < k; j++) mulAddInto(d, shards[have[j]]!, inv[r][j]);
    out.push(d);
  }
  return out;
}

/** Rebuild one specific shard (data or parity) from any K others. */
export function repairShard(
  shards: (Uint8Array | null | undefined)[],
  index: number,
  n = SHARDS_N,
  k = SHARDS_K,
): Uint8Array {
  const data = reconstructData(shards, n, k);
  if (index < k) return data[index];
  const row = generatorRow(index, n, k);
  const p = new Uint8Array(data[0].length);
  for (let j = 0; j < k; j++) mulAddInto(p, data[j], row[j]);
  return p;
}
