import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  buildLeafProof,
  commit,
  decode,
  encode,
  holderIndex,
  leafCount,
  placement,
  quorum,
  repairShard,
  SHARDS_K,
  SHARDS_N,
  shardProof,
  verifyLeafProof,
  verifyShard,
} from "../src/index";

function pick<T>(arr: T[], count: number): number[] {
  const idx = arr.map((_, i) => i).sort(() => Math.random() - 0.5);
  return idx.slice(0, count);
}

test("encode produces N shards of equal length", () => {
  const data = randomBytes(10_000);
  const shards = encode(data);
  assert.equal(shards.length, SHARDS_N);
  for (const s of shards) assert.equal(s.length, Math.ceil(10_000 / SHARDS_K));
});

test("any K shards rebuild the object (many random subsets)", () => {
  for (const size of [1, 7, 1023, 4096, 77_777]) {
    const data = randomBytes(size);
    const shards = encode(data);
    for (let trial = 0; trial < 25; trial++) {
      const keep = new Set(pick(shards, SHARDS_K));
      const partial = shards.map((s, i) => (keep.has(i) ? s : null));
      assert.deepEqual(Buffer.from(decode(partial, size)), Buffer.from(data), `size ${size} trial ${trial}`);
    }
  }
});

test("only parity shards are enough", () => {
  const data = randomBytes(5000);
  const shards = encode(data);
  const partial = shards.map((s, i) => (i >= SHARDS_N - SHARDS_K ? s : null));
  assert.deepEqual(Buffer.from(decode(partial, 5000)), Buffer.from(data));
});

test("fewer than K shards fail", () => {
  const shards = encode(randomBytes(100));
  const partial = shards.map((s, i) => (i < SHARDS_K - 1 ? s : null));
  assert.throws(() => decode(partial, 100), /need 7 shards/);
});

test("repairShard rebuilds a lost shard bit for bit", () => {
  const shards = encode(randomBytes(9000));
  for (const lost of [0, 6, 7, 19]) {
    const keep = new Set(pick(shards.filter((_, i) => i !== lost), SHARDS_K).map((i) => (i >= lost ? i + 1 : i)));
    const partial = shards.map((s, i) => (keep.has(i) ? s : null));
    assert.deepEqual(Buffer.from(repairShard(partial, lost)), Buffer.from(shards[lost]));
  }
});

test("commitments verify shards and challenge leaves", () => {
  const shards = encode(randomBytes(50_000));
  const { root, shardRoots } = commit(shards);
  for (let i = 0; i < SHARDS_N; i++) {
    const path = shardProof(shardRoots, i);
    assert.ok(verifyShard(shards[i], i, path, root));
    const leaves = leafCount(shards[i].length);
    for (const leaf of [0, leaves - 1]) {
      const p = buildLeafProof(shards[i], i, leaf, path);
      assert.ok(verifyLeafProof(p, root));
    }
  }
  // tampering is caught
  const bad = Uint8Array.from(shards[3]);
  bad[0] ^= 1;
  assert.equal(verifyShard(bad, 3, shardProof(shardRoots, 3), root), false);
  const p = buildLeafProof(shards[2], 2, 0, shardProof(shardRoots, 2));
  assert.equal(verifyLeafProof({ ...p, shardIndex: 3 }, root), false);
  const flipped = ((parseInt(p.leaf.slice(2, 4), 16) ^ 0xff) & 0xff).toString(16).padStart(2, "0");
  assert.equal(verifyLeafProof({ ...p, leaf: `0x${flipped}${p.leaf.slice(4)}` as `0x${string}` }, root), false);
});

test("placement spreads 20 shards over a 20-node committee", () => {
  const committee = Array.from({ length: 20 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as `0x${string}`);
  const placed = placement(42n, committee);
  assert.equal(new Set(placed).size, 20);
  const small = committee.slice(0, 6);
  const counts = new Map<string, number>();
  for (const a of placement(42n, small)) counts.set(a, (counts.get(a) ?? 0) + 1);
  assert.equal(counts.size, 6);
  assert.ok(holderIndex(1n, 0, 6) >= 0);
});

test("quorum is ceil(2n/3)", () => {
  assert.equal(quorum(1), 1);
  assert.equal(quorum(3), 2);
  assert.equal(quorum(6), 4);
  assert.equal(quorum(20), 14);
});
