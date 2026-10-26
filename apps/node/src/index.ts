import { parseEther } from "viem";
import { ChainContext, EventFollower } from "./chain";
import type { NodeConfig } from "./config";
import { createNodeServer } from "./http";
import { NodeStore } from "./store";
import { Workers } from "./workers";

export type { NodeConfig } from "./config";
export { configFromEnv } from "./config";

export interface RunningNode {
  ctx: ChainContext;
  stop: () => Promise<void>;
}

/** Register the operator on-chain if it is not yet a node. */
export async function ensureRegistered(ctx: ChainContext, selfStake: bigint, commissionBps = 1000): Promise<void> {
  const rec = await ctx.sdk.node(ctx.address, true);
  if (rec.signer !== "0x0000000000000000000000000000000000000000") {
    if (rec.endpoint !== ctx.cfg.publicUrl) ctx.cfg.log(`warning: on-chain endpoint ${rec.endpoint} differs from PUBLIC_URL`);
    return;
  }
  await ctx.sdk.registerNode({
    signer: ctx.signer.address,
    name: ctx.cfg.name,
    endpoint: ctx.cfg.publicUrl,
    commissionBps,
    selfStake,
  });
  ctx.cfg.log(`registered as ${ctx.address} with ${selfStake} wei self stake`);
}

export async function startNode(cfg: NodeConfig, opts: { registerStake?: bigint } = {}): Promise<RunningNode> {
  const store = new NodeStore(cfg.dataDir);
  const ctx = new ChainContext(cfg, store);
  if (opts.registerStake) await ensureRegistered(ctx, opts.registerStake);

  const follower = new EventFollower(ctx);
  await follower.poll();
  follower.start();

  const workers = new Workers(ctx);
  const server = createNodeServer(ctx, { slashVote: (t, r, s) => workers.slashVote(t, r, s) });
  await new Promise<void>((resolve) => server.listen(cfg.port, cfg.host, resolve));
  workers.start();
  cfg.log(`listening on ${cfg.publicUrl} (operator ${ctx.address}, signer ${ctx.signer.address})`);

  return {
    ctx,
    stop: async () => {
      workers.stop();
      follower.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      store.close();
    },
  };
}

export function stakeFromEnv(): bigint | undefined {
  const v = process.env.REGISTER_STAKE;
  return v ? parseEther(v) : undefined;
}
