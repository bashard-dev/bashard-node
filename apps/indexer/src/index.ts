import { createPublicClient, http, type PublicClient } from "viem";
import { bashardAbi, chainById, type Deployment } from "@bashard/core";
import { createApi, type ChainState } from "./api";
import { openDb } from "./db";
import { Ingestor } from "./ingest";

export interface IndexerConfig {
  rpcUrl: string;
  deployment: Deployment;
  port: number;
  host: string;
  dbPath: string;
  confirmations: number;
  pollMs: number;
  log: (m: string) => void;
}

export async function startIndexer(cfg: IndexerConfig): Promise<{ stop: () => Promise<void> }> {
  const db = openDb(cfg.dbPath);
  const client = createPublicClient({ chain: chainById(cfg.deployment.chainId), transport: http(cfg.rpcUrl) }) as PublicClient;
  const ingestor = new Ingestor(db, client, cfg.deployment, cfg.confirmations, cfg.log);

  let state: ChainState = { epoch: 0, startedAt: 0, duration: cfg.deployment.epochSeconds, committeeSize: 0, pricePerMBEpoch: 0n };
  const refreshState = async () => {
    const [info, price] = await Promise.all([
      client.readContract({ address: cfg.deployment.bashard, abi: bashardAbi, functionName: "epochInfo" }),
      client.readContract({ address: cfg.deployment.bashard, abi: bashardAbi, functionName: "pricePerMBEpoch" }),
    ]);
    state = {
      epoch: info[0],
      startedAt: Number(info[1]),
      duration: Number(info[2]),
      committeeSize: Number(info[4]),
      pricePerMBEpoch: price,
    };
  };

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await ingestor.poll();
      await refreshState();
    } catch (err) {
      cfg.log(`poll: ${(err as Error).message.split("\n")[0]}`);
    } finally {
      busy = false;
    }
  };
  await tick();
  const pollTimer = setInterval(tick, cfg.pollMs);

  // Node liveness: ask every registered endpoint for its health.
  const probe = async () => {
    const nodes = db.prepare("SELECT address, endpoint FROM nodes").all() as { address: string; endpoint: string }[];
    await Promise.all(
      nodes.map(async (n) => {
        try {
          const ctrl = AbortSignal.timeout(4000);
          const res = await fetch(`${n.endpoint.replace(/\/$/, "")}/v1/health`, { signal: ctrl });
          if (!res.ok) return;
          const h = (await res.json()) as { shards: number };
          db.prepare("UPDATE nodes SET last_seen = ?, shards_held = ? WHERE address = ?").run(Math.floor(Date.now() / 1000), h.shards, n.address);
        } catch {
          /* offline */
        }
      }),
    );
  };
  void probe();
  const probeTimer = setInterval(probe, 10_000);

  const server = createApi({ db, ingestor, client, deployment: cfg.deployment, state: () => state, log: cfg.log });
  await new Promise<void>((resolve) => server.listen(cfg.port, cfg.host, resolve));
  cfg.log(`API listening on http://${cfg.host}:${cfg.port}`);

  return {
    stop: async () => {
      clearInterval(pollTimer);
      clearInterval(probeTimer);
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}
