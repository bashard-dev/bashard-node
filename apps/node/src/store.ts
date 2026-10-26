// Local state of a storage node: shard files on disk plus a small SQLite
// catalogue of what the chain says (tracks, tapes, committees).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Address, Hex } from "viem";

export interface LocalTrack {
  id: bigint;
  tapeId: bigint;
  epoch: number;
  root: Hex;
  size: number;
  status: number; // TrackStatus
}

export class NodeStore {
  readonly db: DatabaseSync;
  private readonly shardDir: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.shardDir = join(dataDir, "shards");
    mkdirSync(this.shardDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "node.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tracks (
        id TEXT PRIMARY KEY, tape TEXT NOT NULL, epoch INTEGER NOT NULL,
        root TEXT NOT NULL, size INTEGER NOT NULL, status INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tapes (id TEXT PRIMARY KEY, expiry INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS committees (epoch INTEGER PRIMARY KEY, members TEXT NOT NULL, started_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS shards (track TEXT NOT NULL, idx INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (track, idx));
      CREATE TABLE IF NOT EXISTS roots (track TEXT PRIMARY KEY, roots TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS failures (
        epoch INTEGER NOT NULL, target TEXT NOT NULL, count INTEGER NOT NULL, proposed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (epoch, target)
      );
    `);
  }

  // ---------------------------------------------------------------- meta

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ---------------------------------------------------------------- catalogue

  upsertTrack(t: LocalTrack): void {
    this.db
      .prepare(
        `INSERT INTO tracks (id, tape, epoch, root, size, status) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
      )
      .run(t.id.toString(), t.tapeId.toString(), t.epoch, t.root, t.size, t.status);
  }

  setTrackStatus(id: bigint, status: number): void {
    this.db.prepare("UPDATE tracks SET status = ? WHERE id = ?").run(status, id.toString());
  }

  track(id: bigint): LocalTrack | undefined {
    const r = this.db.prepare("SELECT * FROM tracks WHERE id = ?").get(id.toString()) as Record<string, unknown> | undefined;
    return r ? rowToTrack(r) : undefined;
  }

  tracksWithStatus(status: number): LocalTrack[] {
    return (this.db.prepare("SELECT * FROM tracks WHERE status = ?").all(status) as Record<string, unknown>[]).map(rowToTrack);
  }

  setTapeExpiry(id: bigint, expiry: number): void {
    this.db.prepare("INSERT INTO tapes (id, expiry) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET expiry = excluded.expiry").run(id.toString(), expiry);
  }

  tapeExpiry(id: bigint): number | undefined {
    const r = this.db.prepare("SELECT expiry FROM tapes WHERE id = ?").get(id.toString()) as { expiry: number } | undefined;
    return r?.expiry;
  }

  setCommittee(epoch: number, members: Address[], startedAt: number): void {
    this.db
      .prepare("INSERT INTO committees (epoch, members, started_at) VALUES (?, ?, ?) ON CONFLICT(epoch) DO NOTHING")
      .run(epoch, JSON.stringify(members), startedAt);
  }

  committee(epoch: number): { members: Address[]; startedAt: number } | undefined {
    const r = this.db.prepare("SELECT members, started_at FROM committees WHERE epoch = ?").get(epoch) as
      | { members: string; started_at: number }
      | undefined;
    return r ? { members: JSON.parse(r.members), startedAt: r.started_at } : undefined;
  }

  latestEpoch(): number {
    const r = this.db.prepare("SELECT MAX(epoch) AS e FROM committees").get() as { e: number | null };
    return r.e ?? 0;
  }

  // ---------------------------------------------------------------- shards

  private shardPath(track: bigint, idx: number): string {
    return join(this.shardDir, track.toString(), `${idx}.bin`);
  }

  putShard(track: bigint, idx: number, data: Uint8Array): void {
    const dir = join(this.shardDir, track.toString());
    mkdirSync(dir, { recursive: true });
    const path = this.shardPath(track, idx);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
    this.db
      .prepare("INSERT INTO shards (track, idx, bytes) VALUES (?, ?, ?) ON CONFLICT(track, idx) DO UPDATE SET bytes = excluded.bytes")
      .run(track.toString(), idx, data.length);
  }

  hasShard(track: bigint, idx: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM shards WHERE track = ? AND idx = ?").get(track.toString(), idx);
  }

  getShard(track: bigint, idx: number): Uint8Array | undefined {
    if (!this.hasShard(track, idx)) return undefined;
    const path = this.shardPath(track, idx);
    if (!existsSync(path)) return undefined;
    return new Uint8Array(readFileSync(path));
  }

  shardsOf(track: bigint): number[] {
    return (this.db.prepare("SELECT idx FROM shards WHERE track = ? ORDER BY idx").all(track.toString()) as { idx: number }[]).map((r) => r.idx);
  }

  allShards(): { track: bigint; idx: number }[] {
    return (this.db.prepare("SELECT track, idx FROM shards").all() as { track: string; idx: number }[]).map((r) => ({
      track: BigInt(r.track),
      idx: r.idx,
    }));
  }

  deleteShard(track: bigint, idx: number): void {
    rmSync(this.shardPath(track, idx), { force: true });
    this.db.prepare("DELETE FROM shards WHERE track = ? AND idx = ?").run(track.toString(), idx);
  }

  deleteTrackData(track: bigint): void {
    rmSync(join(this.shardDir, track.toString()), { recursive: true, force: true });
    this.db.prepare("DELETE FROM shards WHERE track = ?").run(track.toString());
    this.db.prepare("DELETE FROM roots WHERE track = ?").run(track.toString());
  }

  usage(): { shards: number; bytes: number } {
    const r = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM shards").get() as { n: number; b: number };
    return { shards: Number(r.n), bytes: Number(r.b) };
  }

  setRoots(track: bigint, roots: Hex[]): void {
    this.db.prepare("INSERT INTO roots (track, roots) VALUES (?, ?) ON CONFLICT(track) DO NOTHING").run(track.toString(), roots.join(","));
  }

  roots(track: bigint): Hex[] | undefined {
    const r = this.db.prepare("SELECT roots FROM roots WHERE track = ?").get(track.toString()) as { roots: string } | undefined;
    return r ? (r.roots.split(",") as Hex[]) : undefined;
  }

  // ---------------------------------------------------------------- audits

  recordFailure(epoch: number, target: Address): number {
    this.db
      .prepare(
        `INSERT INTO failures (epoch, target, count) VALUES (?, ?, 1)
         ON CONFLICT(epoch, target) DO UPDATE SET count = count + 1`,
      )
      .run(epoch, target.toLowerCase());
    const r = this.db.prepare("SELECT count FROM failures WHERE epoch = ? AND target = ?").get(epoch, target.toLowerCase()) as { count: number };
    return Number(r.count);
  }

  markProposed(epoch: number, target: Address): boolean {
    const res = this.db
      .prepare("UPDATE failures SET proposed = 1 WHERE epoch = ? AND target = ? AND proposed = 0")
      .run(epoch, target.toLowerCase());
    return Number(res.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}

function rowToTrack(r: Record<string, unknown>): LocalTrack {
  return {
    id: BigInt(r.id as string),
    tapeId: BigInt(r.tape as string),
    epoch: Number(r.epoch),
    root: r.root as Hex,
    size: Number(r.size),
    status: Number(r.status),
  };
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
