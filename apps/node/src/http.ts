// Public HTTP API of a storage node.
//
//   GET  /v1/health
//   PUT  /v1/tracks/:id/shards/:i          body = shard bytes, header x-bashard-roots
//   GET  /v1/tracks/:id/shards/:i          → bytes, header x-bashard-proof
//   GET  /v1/tracks/:id/roots              → { roots }
//   POST /v1/tracks/:id/certify            → { signature }
//   GET  /v1/tracks/:id/challenge/:i/:leaf → LeafProof
//   POST /v1/slash-vote                    { target, reason } → { signature }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAddress, type Address, type Hex } from "viem";
import {
  buildLeafProof,
  certifyDigest,
  holderIndex,
  leafCount,
  shardLength,
  shardProof,
  shardRoot,
  shardsForMember,
  SHARDS_N,
  TrackStatus,
  trackRoot,
} from "@bashard/core";
import type { ChainContext } from "./chain";

export const VERSION = "0.1.0";
const MAX_SHARD_BYTES = 80 * 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface HttpHooks {
  slashVote: (target: Address, reason: number, proposerSignature: Hex) => Promise<Hex>;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const isBytes = body instanceof Uint8Array;
  res.writeHead(status, {
    "content-type": isBytes ? "application/octet-stream" : "application/json",
    ...headers,
  });
  res.end(isBytes ? body : JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > limit) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export function createNodeServer(ctx: ChainContext, hooks: HttpHooks): Server {
  const { store } = ctx;

  /** Fresh on-chain view of a track, mirrored into the store. */
  async function loadTrack(id: bigint) {
    const t = await ctx.sdk.getTrack(id);
    if (t.status === TrackStatus.None) throw new HttpError(404, "unknown track");
    if (t.status === TrackStatus.Deleted) throw new HttpError(410, "track deleted");
    store.upsertTrack({ id, tapeId: t.tapeId, epoch: t.epoch, root: t.root, size: Number(t.size), status: t.status });
    return t;
  }

  async function isHolder(id: bigint, idx: number, epochs: number[]): Promise<boolean> {
    for (const e of epochs) {
      const members = await ctx.committee(e);
      if (members.length === 0) continue;
      const me = ctx.memberIndex(members);
      if (me >= 0 && holderIndex(id, idx, members.length) === me) return true;
    }
    return false;
  }

  const routes: [string, RegExp, (m: RegExpMatchArray, req: IncomingMessage, res: ServerResponse) => Promise<void>][] = [
    [
      "GET",
      /^\/v1\/health$/,
      async (_m, _req, res) => {
        const usage = store.usage();
        send(res, 200, {
          operator: ctx.address,
          signer: ctx.signer.address,
          name: ctx.cfg.name,
          epoch: store.latestEpoch(),
          shards: usage.shards,
          bytes: usage.bytes,
          version: VERSION,
        });
      },
    ],
    [
      "PUT",
      /^\/v1\/tracks\/(\d+)\/shards\/(\d+)$/,
      async (m, req, res) => {
        const id = BigInt(m[1]);
        const idx = Number(m[2]);
        if (idx >= SHARDS_N) throw new HttpError(400, "bad shard index");
        const t = await loadTrack(id);
        const { epoch } = await ctx.currentEpoch();
        if (!(await isHolder(id, idx, [t.epoch, epoch]))) throw new HttpError(403, "shard not assigned to this node");

        const roots = (req.headers["x-bashard-roots"] as string | undefined)?.split(",") as Hex[] | undefined;
        if (!roots || roots.length !== SHARDS_N) throw new HttpError(400, "x-bashard-roots must list 20 shard roots");
        if (trackRoot(roots).toLowerCase() !== t.root.toLowerCase()) throw new HttpError(400, "shard roots do not match track root");

        const expected = shardLength(Number(t.size));
        const cap = ctx.cfg.maxStorageBytes;
        if (cap > 0 && !store.hasShard(id, idx) && store.usage().bytes + expected > cap) {
          throw new HttpError(507, "node storage is full");
        }
        const body = await readBody(req, MAX_SHARD_BYTES);
        if (body.length !== expected) throw new HttpError(400, "wrong shard length");
        if (shardRoot(body).toLowerCase() !== roots[idx].toLowerCase()) throw new HttpError(400, "shard does not match its root");

        store.setRoots(id, roots);
        store.putShard(id, idx, body);
        send(res, 200, { ok: true });
      },
    ],
    [
      "GET",
      /^\/v1\/tracks\/(\d+)\/shards\/(\d+)$/,
      async (m, _req, res) => {
        const id = BigInt(m[1]);
        const idx = Number(m[2]);
        const shard = store.getShard(id, idx);
        const roots = store.roots(id);
        if (!shard || !roots) throw new HttpError(404, "shard not held");
        send(res, 200, shard, { "x-bashard-proof": shardProof(roots, idx).join(",") });
      },
    ],
    [
      "GET",
      /^\/v1\/tracks\/(\d+)\/roots$/,
      async (m, _req, res) => {
        const roots = store.roots(BigInt(m[1]));
        if (!roots) throw new HttpError(404, "track not held");
        send(res, 200, { roots });
      },
    ],
    [
      "POST",
      /^\/v1\/tracks\/(\d+)\/certify$/,
      async (m, _req, res) => {
        const id = BigInt(m[1]);
        const t = await loadTrack(id);
        const members = await ctx.committee(t.epoch);
        const me = ctx.memberIndex(members);
        if (me < 0) throw new HttpError(403, "not in the track's committee");
        const mine = shardsForMember(id, me, members.length);
        const missing = mine.filter((i) => !store.hasShard(id, i));
        if (missing.length > 0) throw new HttpError(409, `missing shards ${missing.join(",")}`);
        const signature = await ctx.signDigest(certifyDigest(ctx.chainId, ctx.contract, id, t.root));
        send(res, 200, { signature, shards: mine });
      },
    ],
    [
      "GET",
      /^\/v1\/tracks\/(\d+)\/challenge\/(\d+)\/(\d+)$/,
      async (m, _req, res) => {
        const id = BigInt(m[1]);
        const idx = Number(m[2]);
        const leaf = Number(m[3]);
        const shard = store.getShard(id, idx);
        const roots = store.roots(id);
        if (!shard || !roots) throw new HttpError(404, "shard not held");
        if (leaf >= leafCount(shard.length)) throw new HttpError(400, "leaf out of range");
        send(res, 200, buildLeafProof(shard, idx, leaf, shardProof(roots, idx)));
      },
    ],
    [
      "POST",
      /^\/v1\/slash-vote$/,
      async (_m, req, res) => {
        const body = JSON.parse(Buffer.from(await readBody(req, 4096)).toString("utf8"));
        if (!isAddress(body.target)) throw new HttpError(400, "bad target");
        if (typeof body.signature !== "string") throw new HttpError(401, "proposer signature required");
        let signature: Hex;
        try {
          signature = await hooks.slashVote(body.target, Number(body.reason ?? 1), body.signature as Hex);
        } catch (err) {
          throw new HttpError(403, (err as Error).message);
        }
        send(res, 200, { signature });
      },
    ],
  ];

  return createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, PUT, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, x-bashard-roots");
    res.setHeader("access-control-expose-headers", "x-bashard-proof");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    try {
      for (const [method, re, handler] of routes) {
        if (req.method !== method) continue;
        const m = path.match(re);
        if (m) {
          await handler(m, req, res);
          return;
        }
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) ctx.cfg.log(`http ${req.method} ${path}: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) send(res, status, { error: (err as Error).message });
      else res.end();
    }
  });
}
