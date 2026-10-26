// Binary keccak256 merkle trees with domain separation (0x00 leaves, 0x01 nodes)
// so a leaf can never be passed off as an inner node.

import { concat, keccak256, type Hex, toHex } from "viem";

export const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;

export function hashLeaf(data: Uint8Array): Hex {
  return keccak256(concat([new Uint8Array([0]), data]));
}

export function hashNode(left: Hex, right: Hex): Hex {
  return keccak256(concat(["0x01", left, right]));
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** All levels of the tree, leaves first. Leaves are padded with ZERO_HASH to a power of two. */
export function buildLevels(leafHashes: Hex[]): Hex[][] {
  if (leafHashes.length === 0) return [[ZERO_HASH]];
  const width = nextPow2(leafHashes.length);
  let level = [...leafHashes, ...Array<Hex>(width - leafHashes.length).fill(ZERO_HASH)];
  const levels = [level];
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(hashNode(level[i], level[i + 1]));
    levels.push(next);
    level = next;
  }
  return levels;
}

export function merkleRoot(leafHashes: Hex[]): Hex {
  const levels = buildLevels(leafHashes);
  return levels[levels.length - 1][0];
}

export function merkleProof(leafHashes: Hex[], index: number): Hex[] {
  const levels = buildLevels(leafHashes);
  return proofFromLevels(levels, index);
}

export function proofFromLevels(levels: Hex[][], index: number): Hex[] {
  const proof: Hex[] = [];
  let i = index;
  for (let l = 0; l < levels.length - 1; l++) {
    proof.push(levels[l][i ^ 1]);
    i >>= 1;
  }
  return proof;
}

export function rootFromProof(leafHash: Hex, index: number, proof: Hex[]): Hex {
  let h = leafHash;
  let i = index;
  for (const sibling of proof) {
    h = i & 1 ? hashNode(sibling, h) : hashNode(h, sibling);
    i >>= 1;
  }
  return h;
}

export function verifyProof(leafHash: Hex, index: number, proof: Hex[], root: Hex): boolean {
  return rootFromProof(leafHash, index, proof).toLowerCase() === root.toLowerCase();
}

export { toHex };
