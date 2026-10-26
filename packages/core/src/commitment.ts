// How an object is committed on-chain.
//
//   shard  ──split into 1 KiB leaves──▶ shardRoot  (merkle over leaf hashes)
//   20 shardRoots ──────────────────▶ trackRoot  (merkle, stored on-chain)
//
// A challenge asks a node for one leaf of one shard; the answer carries the
// leaf plus both merkle paths, which anyone can check against trackRoot.

import { bytesToHex, type Hex } from "viem";
import { buildLevels, hashLeaf, merkleProof, merkleRoot, proofFromLevels, rootFromProof } from "./merkle";

export const LEAF_BYTES = 1024;

export function leafCount(shardLen: number): number {
  return Math.max(1, Math.ceil(shardLen / LEAF_BYTES));
}

export function leafAt(shard: Uint8Array, index: number): Uint8Array {
  return shard.subarray(index * LEAF_BYTES, Math.min((index + 1) * LEAF_BYTES, shard.length));
}

export function shardLeafHashes(shard: Uint8Array): Hex[] {
  const count = leafCount(shard.length);
  const out: Hex[] = new Array(count);
  for (let i = 0; i < count; i++) out[i] = hashLeaf(leafAt(shard, i));
  return out;
}

export function shardRoot(shard: Uint8Array): Hex {
  return merkleRoot(shardLeafHashes(shard));
}

export function trackRoot(shardRoots: Hex[]): Hex {
  return merkleRoot(shardRoots);
}

export interface Commitment {
  root: Hex;
  shardRoots: Hex[];
}

export function commit(shards: Uint8Array[]): Commitment {
  const shardRoots = shards.map(shardRoot);
  return { root: trackRoot(shardRoots), shardRoots };
}

/** Path from a shard root up to the track root. */
export function shardProof(shardRoots: Hex[], index: number): Hex[] {
  return merkleProof(shardRoots, index);
}

export function verifyShard(shard: Uint8Array, index: number, proof: Hex[], root: Hex): boolean {
  return rootFromProof(shardRoot(shard), index, proof).toLowerCase() === root.toLowerCase();
}

export interface LeafProof {
  shardIndex: number;
  leafIndex: number;
  leaf: Hex;          // the raw leaf bytes
  leafPath: Hex[];    // leaf → shard root
  shardPath: Hex[];   // shard root → track root
}

export function buildLeafProof(shard: Uint8Array, shardIndex: number, leafIndex: number, shardPath: Hex[]): LeafProof {
  const levels = buildLevels(shardLeafHashes(shard));
  const leaf = leafAt(shard, leafIndex);
  return {
    shardIndex,
    leafIndex,
    leaf: bytesToHex(leaf),
    leafPath: proofFromLevels(levels, leafIndex),
    shardPath,
  };
}

export function verifyLeafProof(p: LeafProof, root: Hex): boolean {
  const leafBytes = hexToBytesSafe(p.leaf);
  if (leafBytes.length === 0 || leafBytes.length > LEAF_BYTES) return false;
  const sRoot = rootFromProof(hashLeaf(leafBytes), p.leafIndex, p.leafPath);
  return rootFromProof(sRoot, p.shardIndex, p.shardPath).toLowerCase() === root.toLowerCase();
}

function hexToBytesSafe(hex: Hex): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) return new Uint8Array();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
