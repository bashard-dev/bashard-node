import { createServer } from "node:http";
import {
  trackRoot, shardRoot, shardLength, shardProof, buildLeafProof, leafCount,
  holderIndex, shardsForMember, certifyDigest, TrackStatus,
} from "@bashard/core";

class HttpFault extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
function send(res, status, data, headers = {}) {
  res.writeHead(status, { "content-type": data instanceof Uint8Array ? "application/octet-stream" : "application/json",
    "cache-control": "no-store", ...headers });
  res.end(data instanceof Uint8Array ? data : JSON.stringify(data));
}
async function body(req, limit) {
  if (Number(req.headers["content-length"] || 0) > limit) throw new HttpFault(413, "Shard exceeds upload limit.");
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpFault(413, "Shard exceeds upload limit.");
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** The original node wire protocol, with asynchronous cloud-before-ACK custody. */
export function createCustodyServer({ chain, repository, lease, operator, signer, core, log = () => {} }) {
  let active = 0;
  let tokens = 80, tokenTime = Date.now(), uploading = 0;
  const uploadWaiters = [];
  async function uploadSlot() {
    if (uploading < 2) uploading++;
    else await new Promise(resolve => uploadWaiters.push(resolve));
    return () => {
      if (uploadWaiters.length) uploadWaiters.shift()();
      else uploading--;
    };
  }
  async function enrolled() {
    const record = await chain.node(operator);
    if (!record.active || !same(record.signer, signer.address)) throw new HttpFault(503, "Operator registration or signing key is not ready.");
  }
  async function liveTrack(id) {
    const track = await chain.track(id);
    if (Number(track.status) === TrackStatus.None) throw new HttpFault(404, "Unknown track.");
    if (Number(track.status) === TrackStatus.Deleted) throw new HttpFault(410, "Track was deleted.");
    const [epoch, tape] = await Promise.all([chain.epoch(), chain.tape(track.tapeId)]);
    if (Number(tape.expiryEpoch) <= Number(epoch.epoch)) throw new HttpFault(410, "Tape has expired.");
    return { track, epoch };
  }
  async function stored(id, root, index) {
    const saved = await repository.get(id, root, index);
    if (!saved) throw new HttpFault(404, "Shard is not held.");
    if (!same(trackRoot(saved.roots), root) || !same(shardRoot(saved.bytes), saved.roots[index])) {
      throw new HttpFault(503, "Stored shard commitment verification failed.");
    }
    return saved;
  }
  const server = createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, PUT, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, x-bashard-roots");
    res.setHeader("access-control-expose-headers", "x-bashard-proof");
    res.setHeader("x-content-type-options", "nosniff");
    if (req.method === "OPTIONS") return send(res, 204, "");
    const now = Date.now();
    tokens = Math.min(80, tokens + (now - tokenTime) * 4 / 1000); tokenTime = now;
    if (tokens < 1) return send(res, 429, { error: "Node request limit reached. Retry shortly." }, { "retry-after": "1" });
    tokens--;
    if (active >= 24) return send(res, 503, { error: "Node is busy. Retry shortly." }, { "retry-after": "3" });
    active++;
    try {
      if (!lease.valid()) throw new HttpFault(503, "Durable custody lease is unavailable.");
      const path = new URL(req.url, "http://node").pathname;
      // Registration must not require spending stake before the public
      // custody process and its durable lease can be verified.
      if (req.method === "GET" && path === "/v1/bootstrap") {
        const [record, usage] = await Promise.all([chain.node(operator), repository.usage(true)]);
        return send(res, 200, {
          chainId: 56, core, operator, signer: signer.address, version: "0.1.0-cloud",
          durableStorage: "app_storage", leaseValid: lease.valid(), ...usage,
          enrolled: Boolean(record.active && same(record.signer, signer.address)),
          bootstrapCheckOnly: true, unattendedTransactions: false,
          checkedAtUTC: new Date().toISOString(),
        });
      }
      await enrolled();
      if (req.method === "GET" && path === "/v1/health") {
        const [epoch, usage] = await Promise.all([chain.epoch(), repository.usage()]);
        const members = await chain.committee(epoch.epoch);
        return send(res, 200, {
          operator, signer: signer.address, name: "bashard-bootstrap-1", epoch: Number(epoch.epoch),
          ...usage, version: "0.1.0-cloud", durableStorage: "app_storage",
          committeeMember: members.some(m => same(m, operator)), unattendedTransactions: false,
        });
      }
      if (req.method === "POST" && path === "/v1/slash-vote") {
        throw new HttpFault(503, "Automatic slash voting is not enabled for this bootstrap operator.");
      }
      const match = path.match(/^\/v1\/tracks\/(0|[1-9]\d{0,77})\/(shards\/(\d{1,2})|roots|certify|challenge\/(\d{1,2})\/(\d{1,10}))$/);
      if (!match) throw new HttpFault(404, "Not found.");
      const id = BigInt(match[1]), action = match[2];
      const { track, epoch } = await liveTrack(id);
      if (action.startsWith("shards/") && req.method === "PUT") {
        const index = Number(match[3]);
        if (index >= 20) throw new HttpFault(400, "Invalid shard index.");
        const groups = await Promise.all([chain.committee(track.epoch), chain.committee(epoch.epoch)]);
        if (!groups.some(m => m.length && m.some((who, i) => same(who, operator) && holderIndex(id, index, m.length) === i))) {
          throw new HttpFault(403, "Shard is not assigned to this operator.");
        }
        const roots = String(req.headers["x-bashard-roots"] || "").split(",");
        if (roots.length !== 20 || !roots.every(r => /^0x[0-9a-fA-F]{64}$/.test(r)) || !same(trackRoot(roots), track.root)) {
          throw new HttpFault(400, "Shard roots do not match the on-chain commitment.");
        }
        const expected = shardLength(Number(track.size));
        if (expected > 80 * 1024 * 1024) throw new HttpFault(413, "Shard exceeds upload limit.");
        // Queue streams before reading bodies; do not allocate twenty 80 MiB
        // buffers when the SDK uploads its twenty shards concurrently.
        const release = await uploadSlot();
        try {
          const bytes = await body(req, expected);
          if (bytes.length !== expected || !same(shardRoot(bytes), roots[index])) throw new HttpFault(400, "Shard integrity verification failed.");
          await repository.put(id, track.root, index, bytes, roots);
        } finally { release(); }
        if (!lease.valid()) throw new HttpFault(503, "Custody lease expired before acknowledgement.");
        return send(res, 200, { ok: true });
      }
      if (action.startsWith("shards/") && req.method === "GET") {
        const index = Number(match[3]);
        if (index >= 20) throw new HttpFault(400, "Invalid shard index.");
        const saved = await stored(id, track.root, index);
        return send(res, 200, saved.bytes, { "x-bashard-proof": shardProof(saved.roots, index).join(",") });
      }
      if (action === "roots" && req.method === "GET") {
        // Every committed shard carries the complete root set.
        for (let i = 0; i < 20; i++) {
          const saved = await repository.get(id, track.root, i);
          if (saved && same(trackRoot(saved.roots), track.root)) return send(res, 200, { roots: saved.roots });
        }
        throw new HttpFault(404, "Track is not held.");
      }
      if (action === "certify" && req.method === "POST") {
        const members = await chain.committee(track.epoch);
        const me = members.findIndex(m => same(m, operator));
        if (me < 0) throw new HttpFault(403, "Operator is not in this track's committee.");
        const mine = shardsForMember(id, me, members.length);
        // Do not certify local buffers, missing objects or corrupted cloud data.
        for (const index of mine) {
          try { await stored(id, track.root, index); }
          catch (err) { if (err instanceof HttpFault && err.status === 404) throw new HttpFault(409, "Assigned shards are missing."); throw err; }
        }
        if (!lease.valid()) throw new HttpFault(503, "Custody lease expired.");
        const signature = await signer.signDigest(certifyDigest(56, core, id, track.root));
        return send(res, 200, { signature, shards: mine });
      }
      if (action.startsWith("challenge/") && req.method === "GET") {
        const index = Number(match[4]), leaf = Number(match[5]);
        if (index >= 20) throw new HttpFault(400, "Invalid shard index.");
        const saved = await stored(id, track.root, index);
        if (leaf >= leafCount(saved.bytes.length)) throw new HttpFault(400, "Leaf is out of range.");
        return send(res, 200, buildLeafProof(saved.bytes, index, leaf, shardProof(saved.roots, index)));
      }
      throw new HttpFault(405, "Method not allowed.");
    } catch (err) {
      const status = err instanceof HttpFault ? err.status : 503;
      if (!(err instanceof HttpFault)) log("custody_request_failed", { category: "storage_or_chain" });
      if (!res.headersSent) send(res, status, { error: err instanceof HttpFault ? err.message : "Durable storage or chain access is temporarily unavailable." });
      else res.destroy();
    } finally { active--; }
  });
  server.requestTimeout = 60000; server.headersTimeout = 10000;
  return server;
}
