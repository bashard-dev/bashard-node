// High-level Bashard client: storage, tapes and staking in one object.
// Works in the browser (MetaMask via viem custom transport) and in Node.

import {
  decodeEventLog,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import {
  bashardAbi,
  bashardTokenAbi,
  commit,
  decode,
  encode,
  holderIndex,
  quorum,
  SHARDS_K,
  SHARDS_N,
  shardsForMember,
  stakingAbi,
  TrackStatus,
  verifyShard,
  type Deployment,
} from "@bashard/core";
import { NodeClient } from "./nodeClient";

export type Stage = "encode" | "register" | "upload" | "certify" | "done";

export interface PutOptions {
  contentType?: string;
  onProgress?: (stage: Stage, detail: { done?: number; total?: number; message?: string }) => void;
}

export interface PutResult {
  trackId: bigint;
  root: Hex;
  size: number;
  signatures: number;
  registerTx: Hex;
  certifyTx: Hex;
}

export interface NodeRecord {
  address: Address;
  signer: Address;
  name: string;
  endpoint: string;
  commissionBps: number;
  active: boolean;
  jailedUntil: number;
  pooled: bigint;
  totalShares: bigint;
  operatorRewards: bigint;
}

export interface TrackRecord {
  tapeId: bigint;
  epoch: number;
  status: TrackStatus;
  size: bigint;
  root: Hex;
  keyHash: Hex;
}

export interface TapeRecord {
  owner: Address;
  startEpoch: number;
  expiryEpoch: number;
  capacityMB: bigint;
  usedBytes: bigint;
  trackCount: number;
}

type Wallet = WalletClient<Transport, Chain | undefined, Account>;

export interface BashardOptions {
  deployment: Deployment;
  publicClient: PublicClient;
  walletClient?: Wallet;
  /** Override node endpoints (e.g. when the browser reaches nodes through a proxy). */
  rewriteEndpoint?: (endpoint: string) => string;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export class Bashard {
  readonly deployment: Deployment;
  readonly publicClient: PublicClient;
  walletClient?: Wallet;
  private readonly rewrite: (e: string) => string;
  private nodeCache = new Map<string, NodeRecord>();

  constructor(opts: BashardOptions) {
    this.deployment = opts.deployment;
    this.publicClient = opts.publicClient;
    this.walletClient = opts.walletClient;
    this.rewrite = opts.rewriteEndpoint ?? ((e) => e);
  }

  get address(): Address | undefined {
    return this.walletClient?.account.address;
  }

  // ---------------------------------------------------------------- tx helpers

  private requireWallet(): Wallet {
    if (!this.walletClient) throw new Error("a wallet is required for this action");
    return this.walletClient;
  }

  private async write(address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
    const wallet = this.requireWallet();
    const { request } = await this.publicClient.simulateContract({
      address,
      abi,
      functionName,
      args,
      account: wallet.account,
    } as never);
    const hash = await wallet.writeContract(request as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return receipt;
  }

  private eventArgs<T>(receipt: TransactionReceipt, abi: Abi, eventName: string): T {
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
        if (ev.eventName === eventName) return ev.args as T;
      } catch {
        /* other contract's log */
      }
    }
    throw new Error(`${eventName} not found in ${receipt.transactionHash}`);
  }

  // ---------------------------------------------------------------- token

  async balance(owner: Address = this.requireWallet().account.address): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.deployment.token,
      abi: bashardTokenAbi,
      functionName: "balanceOf",
      args: [owner],
    });
  }

  async faucet(): Promise<TransactionReceipt> {
    return this.write(this.deployment.token, bashardTokenAbi, "faucet", []);
  }

  async ensureAllowance(spender: Address, amount: bigint): Promise<void> {
    const owner = this.requireWallet().account.address;
    const current = await this.publicClient.readContract({
      address: this.deployment.token,
      abi: bashardTokenAbi,
      functionName: "allowance",
      args: [owner, spender],
    });
    if (current < amount) await this.write(this.deployment.token, bashardTokenAbi, "approve", [spender, amount]);
  }

  // ---------------------------------------------------------------- chain reads

  async epochInfo() {
    const [epoch, startedAt, duration, seed, committeeLength] = await this.publicClient.readContract({
      address: this.deployment.bashard,
      abi: bashardAbi,
      functionName: "epochInfo",
    });
    return { epoch, startedAt: Number(startedAt), duration: Number(duration), seed, committeeLength: Number(committeeLength) };
  }

  async committee(epoch: number): Promise<{ members: Address[]; stakes: bigint[] }> {
    const [members, stakes] = await this.publicClient.readContract({
      address: this.deployment.bashard,
      abi: bashardAbi,
      functionName: "committee",
      args: [epoch],
    });
    return { members: [...members], stakes: [...stakes] };
  }

  async node(address: Address, fresh = false): Promise<NodeRecord> {
    const key = address.toLowerCase();
    if (!fresh && this.nodeCache.has(key)) return this.nodeCache.get(key)!;
    const n = await this.publicClient.readContract({
      address: this.deployment.staking,
      abi: stakingAbi,
      functionName: "getNode",
      args: [address],
    });
    const rec: NodeRecord = {
      address,
      signer: n.signer,
      name: n.name,
      endpoint: n.endpoint,
      commissionBps: n.commissionBps,
      active: n.active,
      jailedUntil: n.jailedUntil,
      pooled: n.pooled,
      totalShares: n.totalShares,
      operatorRewards: n.operatorRewards,
    };
    this.nodeCache.set(key, rec);
    return rec;
  }

  nodeClient(endpoint: string): NodeClient {
    return new NodeClient(this.rewrite(endpoint));
  }

  async getTrack(trackId: bigint): Promise<TrackRecord> {
    const t = await this.publicClient.readContract({
      address: this.deployment.bashard,
      abi: bashardAbi,
      functionName: "getTrack",
      args: [trackId],
    });
    return { tapeId: t.tapeId, epoch: t.epoch, status: t.status as TrackStatus, size: t.size, root: t.root, keyHash: t.keyHash };
  }

  async getTape(tapeId: bigint): Promise<TapeRecord> {
    const t = await this.publicClient.readContract({
      address: this.deployment.bashard,
      abi: bashardAbi,
      functionName: "getTape",
      args: [tapeId],
    });
    return {
      owner: t.owner,
      startEpoch: t.startEpoch,
      expiryEpoch: t.expiryEpoch,
      capacityMB: t.capacityMB,
      usedBytes: t.usedBytes,
      trackCount: t.trackCount,
    };
  }

  async trackIdByKey(tapeId: bigint, keyHash: Hex): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.deployment.bashard,
      abi: bashardAbi,
      functionName: "trackByKey",
      args: [tapeId, keyHash],
    });
  }

  async quote(capacityMB: bigint, epochs: number): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.deployment.bashard,
      abi: bashardAbi,
      functionName: "quote",
      args: [capacityMB, epochs],
    });
  }

  // ---------------------------------------------------------------- tapes

  async reserveTape(capacityMB: bigint, epochs: number): Promise<{ tapeId: bigint; cost: bigint; tx: Hex }> {
    const cost = await this.quote(capacityMB, epochs);
    await this.ensureAllowance(this.deployment.bashard, cost);
    const rc = await this.write(this.deployment.bashard, bashardAbi, "reserveTape", [capacityMB, epochs]);
    const ev = this.eventArgs<{ tapeId: bigint; cost: bigint }>(rc, bashardAbi, "TapeReserved");
    return { tapeId: ev.tapeId, cost: ev.cost, tx: rc.transactionHash };
  }

  async extendTape(tapeId: bigint, epochs: number): Promise<Hex> {
    const tape = await this.getTape(tapeId);
    const cost = await this.quote(tape.capacityMB, epochs);
    await this.ensureAllowance(this.deployment.bashard, cost);
    return (await this.write(this.deployment.bashard, bashardAbi, "extendTape", [tapeId, epochs])).transactionHash;
  }

  async expandTape(tapeId: bigint, extraMB: bigint): Promise<Hex> {
    const [tape, info] = await Promise.all([this.getTape(tapeId), this.epochInfo()]);
    const cost = await this.quote(extraMB, Math.max(0, tape.expiryEpoch - info.epoch));
    await this.ensureAllowance(this.deployment.bashard, cost);
    return (await this.write(this.deployment.bashard, bashardAbi, "expandTape", [tapeId, extraMB])).transactionHash;
  }

  // ---------------------------------------------------------------- objects

  /** Encode, register, upload to the committee and certify one object. */
  async put(tapeId: bigint, key: string, data: Uint8Array, opts: PutOptions = {}): Promise<PutResult> {
    const progress = opts.onProgress ?? (() => {});
    if (data.length === 0) throw new Error("cannot store an empty object");

    progress("encode", { message: `encoding ${data.length} bytes into ${SHARDS_N} shards` });
    const shards = encode(data);
    const { root, shardRoots } = commit(shards);

    progress("register", {});
    const rc = await this.write(this.deployment.bashard, bashardAbi, "registerTrack", [
      tapeId,
      key,
      opts.contentType ?? "application/octet-stream",
      BigInt(data.length),
      root,
    ]);
    const ev = this.eventArgs<{ trackId: bigint; epoch: number }>(rc, bashardAbi, "TrackRegistered");
    const trackId = ev.trackId;

    const { members } = await this.committee(ev.epoch);
    const need = quorum(members.length);
    const signatures: Hex[] = [];
    let uploaded = 0;
    progress("upload", { done: 0, total: SHARDS_N });

    await pool(members.map((m, i) => ({ m, i })), 8, async ({ m, i }) => {
      const mine = shardsForMember(trackId, i, members.length);
      if (mine.length === 0) return;
      try {
        const node = await this.node(m);
        const client = this.nodeClient(node.endpoint);
        for (const s of mine) {
          await client.putShard(trackId, s, shards[s], shardRoots);
          uploaded++;
          progress("upload", { done: uploaded, total: SHARDS_N });
        }
        signatures.push(await client.requestCertify(trackId));
      } catch (err) {
        progress("upload", { done: uploaded, total: SHARDS_N, message: `node ${m} failed: ${(err as Error).message}` });
      }
    });

    if (signatures.length < need) {
      throw new Error(`only ${signatures.length}/${members.length} nodes signed, need ${need}`);
    }
    progress("certify", { done: signatures.length, total: members.length });
    const crc = await this.write(this.deployment.bashard, bashardAbi, "certifyTrack", [trackId, signatures]);
    progress("done", {});
    return {
      trackId,
      root,
      size: data.length,
      signatures: signatures.length,
      registerTx: rc.transactionHash,
      certifyTx: crc.transactionHash,
    };
  }

  /** Fetch any K verified shards and rebuild the object. */
  async get(trackId: bigint, opts: { onShard?: (index: number, node: string) => void } = {}): Promise<Uint8Array> {
    const track = await this.getTrack(trackId);
    if (track.status !== TrackStatus.Certified && track.status !== TrackStatus.Registered) {
      throw new Error(`track ${trackId} is not available`);
    }
    const info = await this.epochInfo();
    const epochs = [...new Set([info.epoch, track.epoch])];
    const committees = await Promise.all(epochs.map((e) => this.committee(e)));

    const holders = (i: number): Address[] => {
      const out: Address[] = [];
      for (const c of committees) {
        if (c.members.length === 0) continue;
        const h = c.members[holderIndex(trackId, i, c.members.length)];
        if (!out.includes(h)) out.push(h);
      }
      return out;
    };

    const shards: (Uint8Array | null)[] = Array(SHARDS_N).fill(null);
    let found = 0;

    await new Promise<void>((resolve, reject) => {
      let pending = SHARDS_N;
      const finish = () => {
        if (--pending === 0) {
          if (found >= SHARDS_K) resolve();
          else reject(new Error(`only ${found} of ${SHARDS_K} required shards could be fetched`));
        }
      };
      for (let i = 0; i < SHARDS_N; i++) {
        (async () => {
          for (const h of holders(i)) {
            if (found >= SHARDS_K) return;
            try {
              const node = await this.node(h);
              const { shard, proof } = await this.nodeClient(node.endpoint).getShard(trackId, i);
              if (!verifyShard(shard, i, proof, track.root)) continue;
              if (found >= SHARDS_K) return;
              shards[i] = shard;
              found++;
              opts.onShard?.(i, node.name);
              if (found === SHARDS_K) resolve();
              return;
            } catch {
              /* try the next holder */
            }
          }
        })().finally(finish);
      }
    });

    return decode(shards, Number(track.size));
  }

  async deleteTrack(trackId: bigint): Promise<Hex> {
    return (await this.write(this.deployment.bashard, bashardAbi, "deleteTrack", [trackId])).transactionHash;
  }

  // ---------------------------------------------------------------- staking

  async delegate(node: Address, amount: bigint): Promise<Hex> {
    await this.ensureAllowance(this.deployment.staking, amount);
    return (await this.write(this.deployment.staking, stakingAbi, "delegate", [node, amount])).transactionHash;
  }

  async sharesOf(node: Address, delegator: Address = this.requireWallet().account.address): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.deployment.staking,
      abi: stakingAbi,
      functionName: "sharesOf",
      args: [node, delegator],
    });
  }

  async requestUnstake(node: Address, shares: bigint): Promise<Hex> {
    return (await this.write(this.deployment.staking, stakingAbi, "requestUnstake", [node, shares])).transactionHash;
  }

  async withdraw(): Promise<Hex> {
    return (await this.write(this.deployment.staking, stakingAbi, "withdraw", [])).transactionHash;
  }

  async claimCommission(): Promise<Hex> {
    return (await this.write(this.deployment.staking, stakingAbi, "claimCommission", [])).transactionHash;
  }

  async registerNode(args: {
    signer: Address;
    name: string;
    endpoint: string;
    commissionBps: number;
    selfStake: bigint;
  }): Promise<Hex> {
    await this.ensureAllowance(this.deployment.staking, args.selfStake);
    return (
      await this.write(this.deployment.staking, stakingAbi, "registerNode", [
        args.signer,
        args.name,
        args.endpoint,
        args.commissionBps,
        args.selfStake,
      ])
    ).transactionHash;
  }

  /** Submit committee votes against a member (see Bashard.slash). */
  async slash(node: Address, reason: number, signatures: Hex[]): Promise<Hex> {
    return (await this.write(this.deployment.bashard, bashardAbi, "slash", [node, reason, signatures])).transactionHash;
  }

  async canAdvance(): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.deployment.bashard,
      abi: bashardAbi,
      functionName: "canAdvance",
    });
  }

  async advanceEpoch(): Promise<Hex> {
    return (await this.write(this.deployment.bashard, bashardAbi, "advanceEpoch", [])).transactionHash;
  }
}
