import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudShardRepository, CloudLease, shardKey } from "./cloud-repository.mjs";
import { createCustodyServer } from "./protocol.mjs";
import { encode, shardRoot, trackRoot, verifyLeafProof, verifyShard } from "@bashard/core";

// Pure cloud/chain doubles. No wallet key, blockchain, mainnet write or demo server.
class MemoryBucket {
  constructor() { this.objects = new Map(); this.generation = 0; this.failWrites = false; }
  file(name) {
    const bucket = this;
    const file = {
      name, metadata: bucket.objects.get(name)?.meta,
      async getMetadata() {
        const value = bucket.objects.get(name);
        if (!value) throw Object.assign(new Error("not found"), { code: 404 });
        return [structuredClone(value.meta)];
      },
      async save(bytes, options) {
        if (bucket.failWrites) throw new Error("cloud unavailable");
        const old = bucket.objects.get(name);
        if (Number(options.preconditionOpts?.ifGenerationMatch) !== Number(old?.meta.generation || 0)) {
          throw Object.assign(new Error("generation conflict"), { code: 412 });
        }
        bucket.objects.set(name, { bytes: Buffer.from(bytes), meta: {
          ...options.metadata, size: String(bytes.length), generation: String(++bucket.generation),
        } });
      },
      async download() {
        const value = bucket.objects.get(name);
        if (!value) throw Object.assign(new Error("not found"), { code: 404 });
        return [Buffer.from(value.bytes)];
      },
      async delete(options = {}) {
        const old = bucket.objects.get(name);
        if (old && options.ifGenerationMatch && Number(options.ifGenerationMatch) !== Number(old.meta.generation)) {
          throw Object.assign(new Error("generation conflict"), { code: 412 });
        }
        bucket.objects.delete(name);
      },
    };
    return file;
  }
  async getFiles({ prefix }) { return [[...this.objects.keys()].filter(k => k.startsWith(prefix)).map(k => this.file(k))]; }
}
const operator = `0x${"11".repeat(20)}`;
const signerAddress = `0x${"22".repeat(20)}`;
const core = `0x${"33".repeat(20)}`;
const bytes = new TextEncoder().encode("Internal protocol unit-test bytes, not customer data.");
const shards = encode(bytes);
const roots = shards.map(shardRoot);
const root = trackRoot(roots);
async function fixture(t, bucket = new MemoryBucket()) {
  const repository = new CloudShardRepository(bucket, "unit/operator");
  const mutable = { active: true, deleted: false, expired: false, held: true, lease: true, signatures: 0 };
  const chain = {
    node: async () => ({ active: mutable.active, signer: signerAddress }),
    epoch: async () => ({ epoch: 1 }),
    track: async () => ({ root, status: mutable.deleted ? 3 : 1, tapeId: 1n, epoch: 1, size: bytes.length }),
    tape: async () => ({ expiryEpoch: mutable.expired ? 1 : 5 }),
    committee: async () => mutable.held ? [operator] : [],
  };
  const args = {
    chain, repository, operator, core, lease: { valid: () => mutable.lease },
    signer: { address: signerAddress, signDigest: async digest => { mutable.signatures++; return `unit:${digest}`; } },
  };
  const server = createCustodyServer(args);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const put = (index = 0, extra = {}) => fetch(`${url}/v1/tracks/1/shards/${index}`, {
    method: "PUT", body: shards[index], headers: { "x-bashard-roots": roots.join(",") }, ...extra,
  });
  return { bucket, repository, mutable, args, url, put };
}

test("cloud saves survive a new repository and contain no local filesystem state", async () => {
  const bucket = new MemoryBucket(), writer = new CloudShardRepository(bucket, "unit/operator");
  await writer.put(1, root, 0, shards[0], roots);
  const reader = new CloudShardRepository(bucket, "unit/operator");
  const saved = await reader.get(1, root, 0);
  assert.deepEqual(saved.bytes, shards[0]);
  assert.deepEqual(saved.roots, roots);
});
test("failed cloud write cannot acknowledge upload or issue a certificate", async t => {
  const f = await fixture(t); f.bucket.failWrites = true;
  assert.equal((await f.put()).status, 503);
  assert.equal((await fetch(`${f.url}/v1/tracks/1/certify`, { method: "POST" })).status, 409);
  assert.equal(f.mutable.signatures, 0);
});
test("upload acknowledgement follows cloud commit, not merely body receipt", async t => {
  const f = await fixture(t);
  let committed = false;
  const put = f.repository.put.bind(f.repository);
  f.repository.put = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 30));
    await put(...args); committed = true;
  };
  const result = await f.put();
  assert.equal(result.status, 200);
  assert.equal(committed, true);
  assert.equal((await f.repository.usage()).shards, 1);
});
test("all twenty shards are required; recovered cloud data can certify and answer proof challenges", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 20; i++) assert.equal((await f.put(i)).status, 200);
  // A restarted instance uses only the shared cloud objects.
  const recovered = await fixture(t, f.bucket);
  const certificate = await fetch(`${recovered.url}/v1/tracks/1/certify`, { method: "POST" });
  assert.equal(certificate.status, 200);
  assert.equal((await certificate.json()).shards.length, 20);
  const response = await fetch(`${recovered.url}/v1/tracks/1/shards/3`);
  const downloaded = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(downloaded, shards[3]);
  assert.ok(verifyShard(downloaded, 3, response.headers.get("x-bashard-proof").split(","), root));
  const proof = await (await fetch(`${recovered.url}/v1/tracks/1/challenge/3/0`)).json();
  assert.ok(verifyLeafProof(proof, root));
});
test("wrong shard roots, corrupt bytes and oversized bodies are rejected", async t => {
  const f = await fixture(t);
  assert.equal((await f.put(0, { headers: { "x-bashard-roots": Array(20).fill(`0x${"00".repeat(32)}`).join(",") } })).status, 400);
  assert.equal((await f.put(0, { body: Buffer.alloc(shards[0].length + 1) })).status, 413);
  assert.equal((await f.put(0, { body: Buffer.alloc(shards[0].length) })).status, 400);
});
test("corrupted committed objects cannot be read, acknowledged again or certified", async t => {
  const f = await fixture(t); assert.equal((await f.put()).status, 200);
  const object = [...f.bucket.objects.values()][0];
  object.bytes[0] ^= 255;
  assert.equal((await fetch(`${f.url}/v1/tracks/1/shards/0`)).status, 503);
  assert.equal((await f.put()).status, 503);
  assert.equal((await fetch(`${f.url}/v1/tracks/1/certify`, { method: "POST" })).status, 503);
  assert.equal(f.mutable.signatures, 0);
});
test("deleted or expired tracks are inaccessible; unassigned shards cannot be uploaded", async t => {
  const f = await fixture(t);
  f.mutable.deleted = true; assert.equal((await f.put()).status, 410);
  f.mutable.deleted = false; f.mutable.expired = true; assert.equal((await f.put()).status, 410);
  f.mutable.expired = false; f.mutable.held = false; assert.equal((await f.put()).status, 403);
});
test("unregistered operators and expired custody leases fail closed", async t => {
  const f = await fixture(t);
  f.mutable.active = false; assert.equal((await f.put()).status, 503);
  f.mutable.active = true; f.mutable.lease = false; assert.equal((await f.put()).status, 503);
});
test("bootstrap preflight is available before staking without enabling custody", async t => {
  const f = await fixture(t);
  f.mutable.active = false;
  const response = await fetch(`${f.url}/v1/bootstrap`);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.operator, operator);
  assert.equal(status.signer, signerAddress);
  assert.equal(status.core, core);
  assert.equal(status.chainId, 56);
  assert.equal(status.durableStorage, "app_storage");
  assert.equal(status.leaseValid, true);
  assert.equal(status.enrolled, false);
  assert.equal(status.bootstrapCheckOnly, true);
  assert.equal(status.unattendedTransactions, false);
  assert.equal(status.limitBytes, 20 * 1024 ** 3);
  assert.equal((await f.put()).status, 503);
  assert.equal((await fetch(`${f.url}/v1/tracks/1/certify`, { method: "POST" })).status, 503);
  assert.equal(f.mutable.signatures, 0);
});
test("bootstrap preflight fails closed if durable custody loses its lease", async t => {
  const f = await fixture(t);
  f.mutable.lease = false;
  assert.equal((await fetch(`${f.url}/v1/bootstrap`)).status, 503);
});
test("immutable cloud retries are idempotent and storage quota is enforced", async () => {
  const bucket = new MemoryBucket(), repo = new CloudShardRepository(bucket, "unit/operator", shards[0].length);
  await repo.put(1, root, 0, shards[0], roots);
  await repo.put(1, root, 0, shards[0], roots);
  assert.equal((await repo.usage()).shards, 1);
  await assert.rejects(repo.put(1, root, 1, shards[1], roots), /quota/);
});
test("generation leases exclude a second instance and permit safe handover", async () => {
  const bucket = new MemoryBucket(), first = new CloudLease(bucket, "unit/operator");
  await first.acquire();
  const second = new CloudLease(bucket, "unit/operator");
  await assert.rejects(second.acquire(), /Another custody/);
  await first.renew(); assert.ok(first.valid());
  await first.release(); await second.acquire(); assert.ok(second.valid()); await second.release();
});
test("shard paths reject traversal and out-of-range indices", () => {
  assert.throws(() => shardKey("../1", root, 0));
  assert.throws(() => shardKey(1, "../root", 0));
  assert.throws(() => shardKey(1, root, 20));
});
