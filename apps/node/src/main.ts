#!/usr/bin/env -S npx tsx
// Run one storage node from environment variables. See apps/node/README.md.
import { configFromEnv, stakeFromEnv, startNode } from "./index";

const cfg = configFromEnv();
const node = await startNode(cfg, { registerStake: stakeFromEnv() });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    cfg.log("shutting down");
    await node.stop();
    process.exit(0);
  });
}
