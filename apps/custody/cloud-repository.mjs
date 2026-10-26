import { createHash, randomUUID } from "node:crypto";
import { Storage } from "@google-cloud/storage";

export const storageClient = new Storage({ projectId: process.env.GOOGLE_CLOUD_PROJECT || undefined });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const rootPattern = /^0x[0-9a-fA-F]{64}$/;
export class StorageFault extends Error {
  constructor(message = "Durable storage is temporarily unavailable.") { super(message); }
}
export function cloudLocation(env = process.env) {
  const bucket = env.STORAGE_BUCKET;
  const base = env.STORAGE_PREFIX || "bashard-v1";
  if (!bucket || !base || base.includes("..") || base.startsWith("/")) throw new StorageFault("Private cloud storage is not configured.");
  return { bucket: storageClient.bucket(bucket), base };
}
export function shardKey(track, root, index) {
  if (!/^(0|[1-9]\d{0,77})$/.test(String(track)) || !rootPattern.test(root) || !Number.isInteger(index) || index < 0 || index >= 20) {
    throw new StorageFault("Invalid shard reference.");
  }
  return `tracks/${track}/${root.slice(2).toLowerCase()}/${index}.bin`;
}

/** Cloud objects, not deployment files, are the authoritative shard catalogue. */
export class CloudShardRepository {
  constructor(bucket, prefix, maxBytes = 20 * 1024 ** 3) {
    if (!prefix || prefix.includes("..") || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new StorageFault("Invalid storage configuration.");
    this.bucket = bucket; this.prefix = prefix.replace(/\/$/, ""); this.maxBytes = maxBytes;
    this.tail = Promise.resolve(); this.inventory = null;
  }
  file(track, root, index) { return this.bucket.file(`${this.prefix}/${shardKey(track, root, index)}`); }
  async records() {
    const [files] = await this.bucket.getFiles({ prefix: `${this.prefix}/tracks/` });
    return files.flatMap(file => {
      const key = file.name.slice(this.prefix.length + 1);
      const m = key.match(/^tracks\/(0|[1-9]\d{0,77})\/([a-f0-9]{64})\/(\d{1,2})\.bin$/);
      return m && Number(m[3]) < 20 ? [{ file, track: BigInt(m[1]), root: `0x${m[2]}`, index: Number(m[3]), bytes: Number(file.metadata?.size || 0) }] : [];
    });
  }
  async usage(fresh = false) {
    if (fresh || !this.inventory || Date.now() - this.inventory.at > 10000) {
      const records = await this.records();
      this.inventory = { at: Date.now(), shards: records.length, bytes: records.reduce((s, r) => s + r.bytes, 0) };
    }
    return { shards: this.inventory.shards, bytes: this.inventory.bytes, limitBytes: this.maxBytes };
  }
  async put(track, root, index, bytes, roots) {
    if (roots.length !== 20 || !roots.every(r => rootPattern.test(r))) throw new StorageFault("Invalid shard roots.");
    roots = roots.map(r => r.toLowerCase());
    const file = this.file(track, root, index);
    const metadata = { schema: "1", roots: roots.join(","), sha256: sha(bytes) };
    // Serialize quota checks and uploads; no acknowledgement precedes save().
    const operation = this.tail.catch(() => {}).then(async () => {
      try {
        const [existing] = await file.getMetadata();
        if (existing.metadata?.sha256 !== metadata.sha256 || existing.metadata?.roots !== metadata.roots) throw new StorageFault("Stored shard conflicts with this commitment.");
        // Download/verify an existing object as well: a retry is not permission
        // to trust potentially damaged bytes based only on its metadata.
        if (!(await this.get(track, root, index))) throw new StorageFault("Stored shard disappeared.");
        return;
      } catch (err) { if (Number(err.code) !== 404) throw err; }
      const usage = await this.usage(true);
      if (usage.bytes + bytes.length > this.maxBytes) throw new StorageFault("Node storage quota is full.");
      try {
        await file.save(Buffer.from(bytes), {
          resumable: false, validation: "crc32c", preconditionOpts: { ifGenerationMatch: 0 },
          metadata: { contentType: "application/octet-stream", cacheControl: "private, no-store", metadata },
        });
      } catch (err) {
        if (Number(err.code) === 412) {
          const saved = await this.get(track, root, index);
          if (!saved || sha(saved.bytes) !== metadata.sha256 || saved.roots.join(",") !== metadata.roots) throw new StorageFault("Concurrent shard conflict.");
        } else throw err;
      } finally { this.inventory = null; }
    });
    this.tail = operation;
    await operation;
  }
  async get(track, root, index) {
    const file = this.file(track, root, index);
    try {
      const [metadata] = await file.getMetadata();
      const [bytes] = await file.download({ validation: "crc32c" });
      const roots = String(metadata.metadata?.roots || "").split(",");
      if (roots.length !== 20 || !roots.every(r => rootPattern.test(r)) || sha(bytes) !== metadata.metadata?.sha256) {
        throw new StorageFault("Stored shard integrity check failed.");
      }
      return { bytes: new Uint8Array(bytes), roots };
    } catch (err) { if (Number(err.code) === 404) return null; throw err; }
  }
  async remove(record) {
    await record.file.delete({ ignoreNotFound: true });
    this.inventory = null;
  }
}

/** A generation-checked lease prevents preview/publish instances sharing custody. */
export class CloudLease {
  constructor(bucket, prefix, ttlMs = 90000) {
    this.file = bucket.file(`${prefix}/control/lease`); this.owner = randomUUID();
    this.ttlMs = ttlMs; this.expires = 0; this.generation = 0;
  }
  valid() { return Date.now() < this.expires; }
  async acquire() {
    let generation = 0;
    try {
      const [m] = await this.file.getMetadata();
      if (Number(m.metadata?.expires) > Date.now()) throw new StorageFault("Another custody instance holds the operator lease.");
      generation = m.generation;
    } catch (err) { if (Number(err.code) !== 404) throw err; }
    await this.write(generation);
  }
  async write(generation) {
    const expires = Date.now() + this.ttlMs;
    try {
      await this.file.save(Buffer.alloc(0), { resumable: false, preconditionOpts: { ifGenerationMatch: generation },
        metadata: { cacheControl: "private, no-store", metadata: { owner: this.owner, expires: String(expires) } } });
      const [m] = await this.file.getMetadata();
      if (m.metadata?.owner !== this.owner) throw new StorageFault();
      this.generation = m.generation; this.expires = expires;
    } catch { this.expires = 0; throw new StorageFault("Operator lease could not be confirmed."); }
  }
  async renew() { if (!this.valid()) throw new StorageFault("Operator lease expired."); await this.write(this.generation); }
  async release() {
    this.expires = 0;
    try { await this.file.delete({ ifGenerationMatch: this.generation, ignoreNotFound: true }); } catch { /* expiry is the fallback */ }
  }
}
