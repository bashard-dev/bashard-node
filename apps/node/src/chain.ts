// Chain access for a node: clients, cached committees and the event follower
// that mirrors tracks, tapes and epochs into the local catalogue.

import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { bashardAbi, chainById, TrackStatus } from "@bashard/core";
import { Bashard } from "@bashard/sdk";
import type { NodeConfig } from "./config";
import type { NodeStore } from "./store";

export class ChainContext {
  readonly publicClient: PublicClient;
  readonly operator: PrivateKeyAccount;
  readonly signer: PrivateKeyAccount;
  readonly sdk: Bashard;

  constructor(
    readonly cfg: NodeConfig,
    readonly store: NodeStore,
  ) {
    const chain = chainById(cfg.deployment.chainId);
    const transport = http(cfg.rpcUrl);
    this.publicClient = createPublicClient({ chain, transport, pollingInterval: 500 }) as PublicClient;
    this.operator = privateKeyToAccount(cfg.operatorKey);
    this.signer = privateKeyToAccount(cfg.signerKey);
    const walletClient = createWalletClient({ chain, transport, account: this.operator });
    this.sdk = new Bashard({ deployment: cfg.deployment, publicClient: this.publicClient, walletClient });
  }

  get address(): Address {
    return this.operator.address;
  }

  get contract(): Address {
    return this.cfg.deployment.bashard;
  }

  get chainId(): number {
    return this.cfg.deployment.chainId;
  }

  async signDigest(digest: Hex): Promise<Hex> {
    return this.signer.signMessage({ message: { raw: digest } });
  }

  /** Committee of an epoch, from the local cache or the chain. */
  async committee(epoch: number): Promise<Address[]> {
    const cached = this.store.committee(epoch);
    if (cached) return cached.members;
    const { members } = await this.sdk.committee(epoch);
    if (members.length > 0) this.store.setCommittee(epoch, members, 0);
    return members;
  }

  async currentEpoch(): Promise<{ epoch: number; startedAt: number; duration: number }> {
    const info = await this.sdk.epochInfo();
    return { epoch: info.epoch, startedAt: info.startedAt, duration: info.duration };
  }

  /** Timestamp of the latest block: the clock epochs are measured with. */
  async chainNow(): Promise<number> {
    const block = await this.publicClient.getBlock({ blockTag: "latest" });
    return Number(block.timestamp);
  }

  memberIndex(members: Address[], who: Address = this.address): number {
    return members.findIndex((m) => m.toLowerCase() === who.toLowerCase());
  }
}

/** Poll contract logs and mirror them into the local store. */
export class EventFollower {
  private timer?: NodeJS.Timeout;
  private running = false;
  onTrackDeleted?: (id: bigint) => void;

  constructor(private readonly ctx: ChainContext) {}

  start(): void {
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.poll();
      } catch (err) {
        this.ctx.cfg.log(`event follower: ${(err as Error).message}`);
      } finally {
        this.running = false;
      }
    };
    void tick();
    this.timer = setInterval(tick, this.ctx.cfg.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async poll(): Promise<void> {
    const { store, publicClient, cfg } = this.ctx;
    // On BSC, fast finality makes "finalized" a reorg-safe head within a few blocks.
    const safe = cfg.confirmations < 0
      ? Number((await publicClient.getBlock({ blockTag: "finalized" })).number)
      : Number(await publicClient.getBlockNumber()) - cfg.confirmations;
    let from = Number(store.getMeta("lastBlock") ?? cfg.deployment.deployBlock - 1) + 1;
    while (from <= safe) {
      const to = Math.min(safe, from + 1999);
      const logs = await publicClient.getContractEvents({
        address: this.ctx.contract,
        abi: bashardAbi,
        fromBlock: BigInt(from),
        toBlock: BigInt(to),
      });
      for (const log of logs) this.apply(log as unknown as { eventName: string; args: Record<string, unknown> });
      store.setMeta("lastBlock", String(to));
      from = to + 1;
    }
  }

  private apply(log: { eventName: string; args: Record<string, unknown> }): void {
    const { store } = this.ctx;
    const a = log.args;
    switch (log.eventName) {
      case "EpochAdvanced":
        store.setCommittee(Number(a.epoch), a.committee as Address[], Number(a.startedAt));
        break;
      case "TapeReserved":
        store.setTapeExpiry(a.tapeId as bigint, Number(a.expiryEpoch));
        break;
      case "TapeExtended":
        store.setTapeExpiry(a.tapeId as bigint, Number(a.expiryEpoch));
        break;
      case "TrackRegistered":
        store.upsertTrack({
          id: a.trackId as bigint,
          tapeId: a.tapeId as bigint,
          epoch: Number(a.epoch),
          root: a.root as Hex,
          size: Number(a.size),
          status: TrackStatus.Registered,
        });
        break;
      case "TrackCertified":
        store.setTrackStatus(a.trackId as bigint, TrackStatus.Certified);
        break;
      case "TrackDeleted":
        store.setTrackStatus(a.trackId as bigint, TrackStatus.Deleted);
        store.deleteTrackData(a.trackId as bigint);
        this.onTrackDeleted?.(a.trackId as bigint);
        break;
    }
  }
}
