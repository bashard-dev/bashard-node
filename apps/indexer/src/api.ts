// REST + Server-Sent Events API over the indexed data.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { isAddress, recoverMessageAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  holderIndex,
  SHARDS_N,
  stakingAbi,
  type AccountInfo,
  type ActivityEvent,
  type ChallengeReport,
  type EpochInfo,
  type EpochPhase,
  type NetworkStats,
  type NodeInfo,
  type SearchResult,
  type TapeInfo,
  type TrackInfo,
  type Deployment,
} from "@bashard/core";
import type { Ingestor } from "./ingest";

export interface ChainState {
  epoch: number;
  startedAt: number;
  duration: number;
  committeeSize: number;
  pricePerMBEpoch: bigint;
}

type Row = Record<string, unknown>;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function phaseOf(state: ChainState, now = Date.now() / 1000, syncGrace = 0.2): EpochPhase {
  const elapsed = now - state.startedAt;
  if (elapsed >= state.duration) return "Closing";
  if (elapsed < state.duration * syncGrace) return "Sync";
  return "Active";
}

function toNode(r: Row, committee: Set<string>, challenges: Map<string, { p: number; f: number }>): NodeInfo {
  const addr = r.address as string;
  const c = challenges.get(addr) ?? { p: 0, f: 0 };
  return {
    address: addr,
    signer: r.signer as string,
    name: r.name as string,
    endpoint: r.endpoint as string,
    commissionBps: Number(r.commission_bps),
    active: !!r.active,
    jailedUntil: Number(r.jailed_until),
    stake: r.stake as string,
    operatorRewards: r.operator_rewards as string,
    registeredEpoch: Number(r.registered_epoch),
    inCommittee: committee.has(addr),
    shardsHeld: Number(r.shards_held),
    challengesPassed: c.p,
    challengesFailed: c.f,
    slashes: Number(r.slashes),
    lastSeen: r.last_seen === null ? null : Number(r.last_seen),
  };
}

function toTape(r: Row): TapeInfo {
  return {
    id: Number(r.id),
    owner: r.owner as string,
    capacityMB: Number(r.capacity_mb),
    usedBytes: Number(r.used_bytes),
    startEpoch: Number(r.start_epoch),
    expiryEpoch: Number(r.expiry_epoch),
    trackCount: Number(r.track_count),
    createdAt: Number(r.created_at),
    tx: r.tx as string,
  };
}

function toTrack(r: Row): TrackInfo {
  return {
    id: Number(r.id),
    tapeId: Number(r.tape),
    owner: r.owner as string,
    key: r.key as string,
    contentType: r.content_type as string,
    size: Number(r.size),
    root: r.root as string,
    epoch: Number(r.epoch),
    status: r.status as TrackInfo["status"],
    signers: Number(r.signers),
    registeredAt: Number(r.registered_at),
    certifiedAt: r.certified_at === null ? null : Number(r.certified_at),
    registerTx: r.register_tx as string,
    certifyTx: (r.certify_tx as string | null) ?? null,
  };
}

function toEvent(r: Row): ActivityEvent {
  return {
    id: r.id as string,
    kind: r.kind as ActivityEvent["kind"],
    block: Number(r.block),
    tx: r.tx as string,
    time: Number(r.time),
    actor: (r.actor as string | null) ?? null,
    summary: r.summary as string,
    data: JSON.parse(r.data as string),
  };
}

export function createApi(opts: {
  db: DatabaseSync;
  ingestor: Ingestor;
  client: PublicClient;
  deployment: Deployment;
  state: () => ChainState;
  log: (m: string) => void;
}): Server {
  const { db, ingestor, client, deployment } = opts;
  const all = (sql: string, ...p: (string | number | null)[]) => db.prepare(sql).all(...p) as Row[];
  const one = (sql: string, ...p: (string | number | null)[]) => db.prepare(sql).get(...p) as Row | undefined;

  const committeeOf = (epoch: number): string[] => {
    const r = one("SELECT committee FROM epochs WHERE epoch = ?", epoch);
    return r ? (JSON.parse(r.committee as string) as string[]) : [];
  };

  const challengeCounts = (): Map<string, { p: number; f: number }> => {
    const m = new Map<string, { p: number; f: number }>();
    for (const r of all("SELECT target, SUM(passed) AS p, COUNT(*) - SUM(passed) AS f FROM challenges GROUP BY target")) {
      m.set(r.target as string, { p: Number(r.p), f: Number(r.f) });
    }
    return m;
  };

  const nodesList = (): NodeInfo[] => {
    const committee = new Set(committeeOf(opts.state().epoch));
    const counts = challengeCounts();
    return all("SELECT * FROM nodes")
      .map((r) => toNode(r, committee, counts))
      .sort((a, b) => (BigInt(b.stake) > BigInt(a.stake) ? 1 : BigInt(b.stake) < BigInt(a.stake) ? -1 : 0));
  };

  const epochInfo = (r: Row): EpochInfo => {
    const committee = JSON.parse(r.committee as string) as string[];
    const stakes = JSON.parse(r.stakes as string) as string[];
    const names = new Map(all("SELECT address, name FROM nodes").map((n) => [n.address as string, n.name as string]));
    const regs = one("SELECT COUNT(*) AS n FROM tracks WHERE epoch = ?", Number(r.epoch));
    return {
      epoch: Number(r.epoch),
      startedAt: Number(r.started_at),
      seed: r.seed as string,
      committee: committee.map((node, i) => ({ node, name: names.get(node) ?? node, stake: stakes[i] })),
      rewardsPaid: (r.rewards_paid as string | null) ?? null,
      tracksRegistered: Number(regs?.n ?? 0),
    };
  };

  const handlers: [string, RegExp, (m: RegExpMatchArray, q: URLSearchParams, req: IncomingMessage, res: ServerResponse) => Promise<unknown>][] = [
    [
      "GET",
      /^\/v1\/stats$/,
      async () => {
        const s = opts.state();
        const nodes = one("SELECT COUNT(*) AS n, SUM(active) AS a FROM nodes")!;
        const stake = all("SELECT stake FROM nodes").reduce((acc, r) => acc + BigInt(r.stake as string), 0n);
        const tracks = one("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM tracks WHERE status = 'certified'")!;
        const day = one("SELECT COUNT(*) AS n FROM tracks WHERE certified_at >= ?", Math.floor(Date.now() / 1000) - 86400)!;
        const tapes = one("SELECT COUNT(*) AS n FROM tapes")!;
        const ch = one("SELECT COALESCE(SUM(passed), 0) AS p, COUNT(*) AS n FROM challenges")!;
        const stats: NetworkStats = {
          chainId: deployment.chainId,
          epoch: s.epoch,
          phase: phaseOf(s, ingestor.headTime || Date.now() / 1000),
          epochStartedAt: s.startedAt,
          epochDuration: s.duration,
          committeeSize: committeeOf(s.epoch).length,
          nodes: Number(nodes.n),
          activeNodes: Number(nodes.a ?? 0),
          totalStake: stake.toString(),
          bytesStored: Number(tracks.b),
          tracks: Number(tracks.n),
          tracksCertified24h: Number(day.n),
          tapes: Number(tapes.n),
          challengesPassed: Number(ch.p),
          challengesFailed: Number(ch.n) - Number(ch.p),
          indexedBlock: ingestor.indexedBlock,
          headBlock: ingestor.headBlock,
          pricePerMBEpoch: s.pricePerMBEpoch.toString(),
        };
        return stats;
      },
    ],
    ["GET", /^\/v1\/nodes$/, async () => nodesList()],
    [
      "GET",
      /^\/v1\/nodes\/(0x[0-9a-fA-F]{40})$/,
      async (m) => {
        const addr = m[1].toLowerCase();
        const node = nodesList().find((n) => n.address === addr);
        if (!node) throw new ApiError(404, "unknown node");
        const events = all("SELECT * FROM events WHERE actor = ? ORDER BY time DESC, id DESC LIMIT 50", addr).map(toEvent);
        return { ...node, events };
      },
    ],
    [
      "GET",
      /^\/v1\/epochs$/,
      async (_m, q) => all("SELECT * FROM epochs ORDER BY epoch DESC LIMIT ?", Math.min(100, Number(q.get("limit") ?? 20))).map(epochInfo),
    ],
    [
      "GET",
      /^\/v1\/epochs\/(\d+)$/,
      async (m) => {
        const r = one("SELECT * FROM epochs WHERE epoch = ?", Number(m[1]));
        if (!r) throw new ApiError(404, "unknown epoch");
        return epochInfo(r);
      },
    ],
    [
      "GET",
      /^\/v1\/tracks$/,
      async (_m, q) => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (q.get("tape")) {
          where.push("tape = ?");
          params.push(Number(q.get("tape")));
        }
        if (q.get("owner")) {
          where.push("owner = ?");
          params.push(q.get("owner")!.toLowerCase());
        }
        if (q.get("live") === "1") where.push("status != 'deleted'");
        const limit = Math.min(200, Number(q.get("limit") ?? 25));
        const sql = `SELECT * FROM tracks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${limit}`;
        return all(sql, ...params).map(toTrack);
      },
    ],
    [
      "GET",
      /^\/v1\/tracks\/(\d+)$/,
      async (m) => {
        const r = one("SELECT * FROM tracks WHERE id = ?", Number(m[1]));
        if (!r) throw new ApiError(404, "unknown track");
        const track = toTrack(r);
        const committee = committeeOf(opts.state().epoch);
        const names = new Map(all("SELECT address, name FROM nodes").map((n) => [n.address as string, n.name as string]));
        const placement =
          committee.length === 0
            ? []
            : Array.from({ length: SHARDS_N }, (_, shard) => {
                const node = committee[holderIndex(BigInt(track.id), shard, committee.length)];
                return { shard, node, name: names.get(node) ?? node };
              });
        return { ...track, placement };
      },
    ],
    [
      "GET",
      /^\/v1\/tapes$/,
      async (_m, q) => {
        const limit = Math.min(200, Number(q.get("limit") ?? 25));
        if (q.get("owner")) return all(`SELECT * FROM tapes WHERE owner = ? ORDER BY id DESC LIMIT ${limit}`, q.get("owner")!.toLowerCase()).map(toTape);
        return all(`SELECT * FROM tapes ORDER BY id DESC LIMIT ${limit}`).map(toTape);
      },
    ],
    [
      "GET",
      /^\/v1\/tapes\/(\d+)$/,
      async (m) => {
        const r = one("SELECT * FROM tapes WHERE id = ?", Number(m[1]));
        if (!r) throw new ApiError(404, "unknown tape");
        return toTape(r);
      },
    ],
    [
      "GET",
      /^\/v1\/accounts\/(0x[0-9a-fA-F]{40})$/,
      async (m) => {
        const addr = m[1].toLowerCase();
        const tapes = all("SELECT * FROM tapes WHERE owner = ? ORDER BY id DESC", addr).map(toTape);
        const delegations = all(
          `SELECT d.*, n.name, n.stake, n.total_shares FROM delegations d JOIN nodes n ON n.address = d.node
           WHERE d.delegator = ? AND d.shares != '0'`,
          addr,
        ).map((r) => {
          const total = BigInt(r.total_shares as string);
          const value = total === 0n ? 0n : (BigInt(r.shares as string) * BigInt(r.stake as string)) / total;
          return {
            node: r.node as string,
            nodeName: r.name as string,
            shares: r.shares as string,
            value: value.toString(),
            principal: r.principal as string,
          };
        });
        const unbondings = await client.readContract({
          address: deployment.staking,
          abi: stakingAbi,
          functionName: "unbondingsOf",
          args: [addr as Address],
        });
        const objects = one("SELECT COUNT(*) AS n FROM tracks WHERE owner = ? AND status != 'deleted'", addr)!;
        const info: AccountInfo = {
          address: addr,
          tapes,
          delegations,
          unbondings: unbondings.map((u) => ({ amount: u.amount.toString(), releaseEpoch: u.releaseEpoch })),
          storageUsed: tapes.reduce((a, t) => a + t.usedBytes, 0),
          storageCapacityMB: tapes.filter((t) => t.expiryEpoch > opts.state().epoch).reduce((a, t) => a + t.capacityMB, 0),
          objects: Number(objects.n),
        };
        return info;
      },
    ],
    [
      "GET",
      /^\/v1\/events$/,
      async (_m, q) => {
        const limit = Math.min(200, Number(q.get("limit") ?? 30));
        const where: string[] = [];
        const params: string[] = [];
        if (q.get("actor")) {
          where.push("actor = ?");
          params.push(q.get("actor")!.toLowerCase());
        }
        if (q.get("kind")) {
          where.push("kind = ?");
          params.push(q.get("kind")!);
        }
        const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY time DESC, block DESC, id DESC LIMIT ${limit}`;
        return all(sql, ...params).map(toEvent);
      },
    ],
    [
      "GET",
      /^\/v1\/search$/,
      async (_m, q) => {
        const term = (q.get("q") ?? "").trim();
        const out: SearchResult[] = [];
        if (!term) return out;
        if (/^\d+$/.test(term)) {
          const n = Number(term);
          if (one("SELECT 1 FROM tracks WHERE id = ?", n)) out.push({ type: "track", id: term, label: `Track #${term}` });
          if (one("SELECT 1 FROM tapes WHERE id = ?", n)) out.push({ type: "tape", id: term, label: `Tape #${term}` });
          if (one("SELECT 1 FROM epochs WHERE epoch = ?", n)) out.push({ type: "epoch", id: term, label: `Epoch ${term}` });
        } else if (isAddress(term)) {
          const addr = term.toLowerCase();
          const node = one("SELECT name FROM nodes WHERE address = ? OR signer = ?", addr, addr);
          if (node) out.push({ type: "node", id: addr, label: `Node ${node.name}` });
          out.push({ type: "account", id: addr, label: `Account ${addr}` });
        } else if (/^0x[0-9a-fA-F]{64}$/.test(term)) {
          const h = term.toLowerCase();
          for (const r of all("SELECT id FROM tracks WHERE lower(root) = ?", h)) out.push({ type: "track", id: String(r.id), label: `Track #${r.id} (root)` });
          const ev = one("SELECT summary FROM events WHERE lower(tx) = ? LIMIT 1", h);
          if (ev) out.push({ type: "tx", id: h, label: ev.summary as string });
        } else {
          const like = `%${term}%`;
          for (const r of all("SELECT address, name FROM nodes WHERE name LIKE ? LIMIT 5", like)) {
            out.push({ type: "node", id: r.address as string, label: `Node ${r.name}` });
          }
          for (const r of all("SELECT id, key FROM tracks WHERE key LIKE ? AND status != 'deleted' ORDER BY id DESC LIMIT 10", like)) {
            out.push({ type: "track", id: String(r.id), label: `Track #${r.id} · ${r.key}` });
          }
        }
        return out;
      },
    ],
    [
      "GET",
      /^\/v1\/tx\/(0x[0-9a-fA-F]{64})$/,
      async (m) => all("SELECT * FROM events WHERE lower(tx) = ? ORDER BY id", m[1].toLowerCase()).map(toEvent),
    ],
    [
      "POST",
      /^\/v1\/reports\/challenge$/,
      async (_m, _q, req) => {
        const raw = await readJson(req);
        const { message, signature } = raw as { message: string; signature: Hex };
        if (typeof message !== "string" || typeof signature !== "string") throw new ApiError(400, "bad report");
        const report = JSON.parse(message) as Omit<ChallengeReport, "signature">;
        const node = one("SELECT signer FROM nodes WHERE address = ?", String(report.challenger).toLowerCase());
        if (!node) throw new ApiError(403, "unknown challenger");
        const recovered = await recoverMessageAddress({ message, signature });
        if (recovered.toLowerCase() !== (node.signer as string)) throw new ApiError(403, "bad signature");
        if (Math.abs(Date.now() / 1000 - report.time) > 120) throw new ApiError(400, "stale report");
        db.prepare(
          "INSERT INTO challenges (epoch, challenger, target, track, shard, passed, latency_ms, time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          report.epoch,
          report.challenger.toLowerCase(),
          report.target.toLowerCase(),
          Number(report.trackId),
          report.shardIndex,
          report.passed ? 1 : 0,
          report.latencyMs,
          report.time,
        );
        const names = new Map(all("SELECT address, name FROM nodes").map((n) => [n.address as string, n.name as string]));
        const ev: ActivityEvent = {
          id: `c:${report.time}:${report.challenger}:${report.trackId}:${report.shardIndex}`,
          kind: "Challenge",
          block: ingestor.headBlock,
          tx: "",
          time: report.time,
          actor: report.target.toLowerCase(),
          summary: `${names.get(report.target.toLowerCase()) ?? report.target} ${report.passed ? "passed" : "FAILED"} a challenge on track #${report.trackId} shard ${report.shardIndex} (${report.latencyMs} ms)`,
          data: { ...report },
        };
        if (!report.passed) {
          db.prepare("INSERT OR IGNORE INTO events (id, kind, block, tx, time, actor, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
            ev.id,
            ev.kind,
            ev.block,
            ev.tx,
            ev.time,
            ev.actor,
            ev.summary,
            JSON.stringify(ev.data),
          );
        }
        ingestor.emit(ev);
        return { ok: true };
      },
    ],
  ];

  return createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");

    if (req.method === "GET" && url.pathname === "/v1/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      const off = ingestor.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        off();
        clearInterval(ping);
      });
      return;
    }

    try {
      for (const [method, re, handler] of handlers) {
        if (req.method !== method) continue;
        const m = url.pathname.match(re);
        if (m) {
          const body = await handler(m, url.searchParams, req, res);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
          return;
        }
      }
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      if (status === 500) opts.log(`${req.method} ${url.pathname}: ${(err as Error).stack}`);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
    }
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16_384) throw new ApiError(413, "body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid json");
  }
}
