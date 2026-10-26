import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,           -- block:logIndex, or c:<n> for challenge reports
      kind TEXT NOT NULL,
      block INTEGER NOT NULL,
      tx TEXT NOT NULL,
      time INTEGER NOT NULL,
      actor TEXT,
      summary TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_time ON events (time DESC);
    CREATE INDEX IF NOT EXISTS events_actor ON events (actor);
    CREATE INDEX IF NOT EXISTS events_tx ON events (tx);

    CREATE TABLE IF NOT EXISTS nodes (
      address TEXT PRIMARY KEY,
      signer TEXT NOT NULL,
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      commission_bps INTEGER NOT NULL,
      active INTEGER NOT NULL,
      jailed_until INTEGER NOT NULL,
      registered_epoch INTEGER NOT NULL,
      stake TEXT NOT NULL,
      total_shares TEXT NOT NULL DEFAULT '0',
      operator_rewards TEXT NOT NULL,
      slashes INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER,
      shards_held INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS epochs (
      epoch INTEGER PRIMARY KEY,
      started_at INTEGER NOT NULL,
      seed TEXT NOT NULL,
      committee TEXT NOT NULL,
      stakes TEXT NOT NULL,
      rewards_paid TEXT
    );

    CREATE TABLE IF NOT EXISTS tapes (
      id INTEGER PRIMARY KEY,
      owner TEXT NOT NULL,
      capacity_mb INTEGER NOT NULL,
      used_bytes INTEGER NOT NULL,
      start_epoch INTEGER NOT NULL,
      expiry_epoch INTEGER NOT NULL,
      track_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      tx TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tapes_owner ON tapes (owner);

    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY,
      tape INTEGER NOT NULL,
      owner TEXT NOT NULL,
      key TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      root TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      status TEXT NOT NULL,
      signers INTEGER NOT NULL DEFAULT 0,
      registered_at INTEGER NOT NULL,
      certified_at INTEGER,
      register_tx TEXT NOT NULL,
      certify_tx TEXT
    );
    CREATE INDEX IF NOT EXISTS tracks_tape ON tracks (tape);
    CREATE INDEX IF NOT EXISTS tracks_owner ON tracks (owner);
    CREATE INDEX IF NOT EXISTS tracks_root ON tracks (root);

    CREATE TABLE IF NOT EXISTS delegations (
      node TEXT NOT NULL,
      delegator TEXT NOT NULL,
      shares TEXT NOT NULL,
      principal TEXT NOT NULL,
      PRIMARY KEY (node, delegator)
    );
    CREATE INDEX IF NOT EXISTS delegations_delegator ON delegations (delegator);

    CREATE TABLE IF NOT EXISTS challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      epoch INTEGER NOT NULL,
      challenger TEXT NOT NULL,
      target TEXT NOT NULL,
      track INTEGER NOT NULL,
      shard INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      time INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS challenges_target ON challenges (target);
  `);
  return db;
}
