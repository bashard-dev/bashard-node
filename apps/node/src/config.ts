import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import type { Deployment } from "@bashard/core";

export interface NodeConfig {
  name: string;
  rpcUrl: string;
  deployment: Deployment;
  /** Operator wallet: owns the stake, pays gas for keeper and slash txs. */
  operatorKey: Hex;
  /** Hot key that signs certificates, votes and reports. */
  signerKey: Hex;
  dataDir: string;
  port: number;
  host: string;
  publicUrl: string;
  indexerUrl?: string;
  /** Blocks to wait before trusting a log. -1 = follow the chain's "finalized" block (default off localnet). */
  confirmations: number;
  pollMs: number;
  auditIntervalMs: number;
  syncIntervalMs: number;
  /** Failed challenges against one node in one epoch before proposing a slash. */
  slashThreshold: number;
  /** Fraction of the epoch reserved for shard sync before challenges start. */
  syncGrace: number;
  keeper: boolean;
  /** Refuse new shards beyond this many bytes on disk (0 = no limit). */
  maxStorageBytes: number;
  log: (msg: string) => void;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing env ${name}`);
  return v;
}

export function configFromEnv(): NodeConfig {
  const deploymentPath = env("DEPLOYMENT", "../../packages/contracts/deployments/localhost.json");
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as Deployment;
  const port = Number(env("PORT", "7001"));
  const name = env("NODE_NAME", `node-${port}`);
  return {
    name,
    rpcUrl: env("RPC_URL", "http://127.0.0.1:8545"),
    deployment,
    operatorKey: env("OPERATOR_KEY") as Hex,
    signerKey: env("SIGNER_KEY") as Hex,
    dataDir: env("DATA_DIR", `./data/${name}`),
    port,
    host: env("HOST", "0.0.0.0"),
    publicUrl: env("PUBLIC_URL", `http://127.0.0.1:${port}`),
    indexerUrl: process.env.INDEXER_URL || undefined,
    confirmations: Number(env("CONFIRMATIONS", deployment.chainId === 31337 ? "0" : "-1")),
    pollMs: Number(env("POLL_MS", "1500")),
    auditIntervalMs: Number(env("AUDIT_INTERVAL_MS", "5000")),
    syncIntervalMs: Number(env("SYNC_INTERVAL_MS", "4000")),
    slashThreshold: Number(env("SLASH_THRESHOLD", "3")),
    syncGrace: Number(env("SYNC_GRACE", "0.2")),
    keeper: env("KEEPER", "0") === "1",
    maxStorageBytes: Math.floor(Number(env("MAX_STORAGE_GB", "0")) * 1024 ** 3),
    log: (msg) => console.log(`[${name}] ${msg}`),
  };
}
