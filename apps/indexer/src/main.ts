#!/usr/bin/env -S npx tsx
// Run the indexer + API from environment variables.
import { readFileSync } from "node:fs";
import type { Deployment } from "@bashard/core";
import { startIndexer } from "./index";

const deployment = JSON.parse(
  readFileSync(process.env.DEPLOYMENT ?? "../../packages/contracts/deployments/localhost.json", "utf8"),
) as Deployment;

const indexer = await startIndexer({
  rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
  deployment,
  port: Number(process.env.PORT ?? 8600),
  host: process.env.HOST ?? "0.0.0.0",
  dbPath: process.env.DB_PATH ?? "./data/indexer.db",
  // -1 follows the chain's finalized block (BSC fast finality); a positive number waits that many blocks.
  confirmations: Number(process.env.CONFIRMATIONS ?? (deployment.chainId === 31337 ? 0 : -1)),
  pollMs: Number(process.env.POLL_MS ?? 1500),
  log: (m) => console.log(`[indexer] ${m}`),
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await indexer.stop();
    process.exit(0);
  });
}
