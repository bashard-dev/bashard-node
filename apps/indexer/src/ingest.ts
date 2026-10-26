// Follows Bashard and Staking logs, writes them into SQLite and fans new
// activity out to live subscribers.

import type { DatabaseSync } from "node:sqlite";
import type { Address, Hex, PublicClient } from "viem";
import {
  bashardAbi,
  formatBytes,
  formatToken,
  shortHex,
  stakingAbi,
  type ActivityEvent,
  type Deployment,
  type EventKind,
} from "@bashard/core";

type Log = {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
};

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export class Ingestor {
  private listeners = new Set<(e: ActivityEvent) => void>();
  private blockTimes = new Map<bigint, number>();
  headBlock = 0;
  headTime = 0;
  indexedBlock = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly client: PublicClient,
    private readonly deployment: Deployment,
    private readonly confirmations: number,
    private readonly log: (m: string) => void,
  ) {
    const m = db.prepare("SELECT value FROM meta WHERE key = 'lastBlock'").get() as { value: string } | undefined;
    this.indexedBlock = m ? Number(m.value) : deployment.deployBlock - 1;
  }

  subscribe(fn: (e: ActivityEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: ActivityEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  async poll(): Promise<void> {
    const head = await this.client.getBlock({ blockTag: "latest" });
    this.headBlock = Number(head.number);
    this.headTime = Number(head.timestamp);
    const safe =
      this.confirmations < 0
        ? Number((await this.client.getBlock({ blockTag: "finalized" })).number)
        : this.headBlock - this.confirmations;
    let from = this.indexedBlock + 1;
    while (from <= safe) {
      const to = Math.min(safe, from + 1999);
      const range = { fromBlock: BigInt(from), toBlock: BigInt(to) };
      const [a, b] = await Promise.all([
        this.client.getContractEvents({ address: this.deployment.bashard, abi: bashardAbi, ...range }),
        this.client.getContractEvents({ address: this.deployment.staking, abi: stakingAbi, ...range }),
      ]);
      const logs = ([...a, ...b] as unknown as Log[]).sort((x, y) =>
        x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : Number(x.blockNumber - y.blockNumber),
      );
      const touched = { nodes: new Set<Address>(), tapes: new Set<bigint>(), delegations: new Set<string>() };
      const fresh: ActivityEvent[] = [];
      for (const log of logs) {
        const time = await this.blockTime(log.blockNumber);
        const ev = this.apply(log, time, touched);
        if (ev) fresh.push(ev);
      }
      await this.refresh(touched);
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('lastBlock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(to));
      this.indexedBlock = to;
      for (const e of fresh) this.emit(e);
      from = to + 1;
    }
  }

  private async blockTime(n: bigint): Promise<number> {
    let t = this.blockTimes.get(n);
    if (t === undefined) {
      t = Number((await this.client.getBlock({ blockNumber: n })).timestamp);
      this.blockTimes.set(n, t);
      if (this.blockTimes.size > 5000) this.blockTimes.clear();
    }
    return t;
  }

  private tapeOwner(tapeId: bigint): string {
    const r = this.db.prepare("SELECT owner FROM tapes WHERE id = ?").get(Number(tapeId)) as { owner: string } | undefined;
    return r?.owner ?? "";
  }

  private nodeName(addr: string): string {
    const r = this.db.prepare("SELECT name FROM nodes WHERE address = ?").get(addr.toLowerCase()) as { name: string } | undefined;
    return r?.name ?? shortHex(addr);
  }

  private apply(
    log: Log,
    time: number,
    touched: { nodes: Set<Address>; tapes: Set<bigint>; delegations: Set<string> },
  ): ActivityEvent | null {
    const a = log.args;
    const db = this.db;
    let actor: string | null = null;
    let summary = "";
    const kind = log.eventName as EventKind;

    switch (log.eventName) {
      case "EpochAdvanced": {
        const committee = (a.committee as string[]).map((x) => x.toLowerCase());
        db.prepare(
          "INSERT OR REPLACE INTO epochs (epoch, started_at, seed, committee, stakes, rewards_paid) VALUES (?, ?, ?, ?, ?, NULL)",
        ).run(Number(a.epoch), Number(a.startedAt), a.seed as string, JSON.stringify(committee), json(a.stakes));
        summary = `Epoch ${a.epoch} started with ${committee.length} nodes`;
        break;
      }
      case "RewardsPaid":
        db.prepare("UPDATE epochs SET rewards_paid = ? WHERE epoch = ?").run(String(a.total), Number(a.epoch));
        summary = `Epoch ${a.epoch} paid ${formatToken(a.total as bigint)} BSHD to its committee`;
        break;
      case "TapeReserved":
        db.prepare(
          `INSERT OR REPLACE INTO tapes (id, owner, capacity_mb, used_bytes, start_epoch, expiry_epoch, track_count, created_at, tx)
           VALUES (?, ?, ?, 0, ?, ?, 0, ?, ?)`,
        ).run(
          Number(a.tapeId),
          (a.owner as string).toLowerCase(),
          Number(a.capacityMB),
          Number(a.startEpoch),
          Number(a.expiryEpoch),
          time,
          log.transactionHash,
        );
        actor = (a.owner as string).toLowerCase();
        summary = `Tape #${a.tapeId} reserved · ${a.capacityMB} MB until epoch ${a.expiryEpoch}`;
        break;
      case "TapeExtended":
        touched.tapes.add(a.tapeId as bigint);
        actor = this.tapeOwner(a.tapeId as bigint);
        summary = `Tape #${a.tapeId} extended to epoch ${a.expiryEpoch}`;
        break;
      case "TapeExpanded":
        touched.tapes.add(a.tapeId as bigint);
        actor = this.tapeOwner(a.tapeId as bigint);
        summary = `Tape #${a.tapeId} expanded to ${a.capacityMB} MB`;
        break;
      case "TapeTransferred":
        touched.tapes.add(a.tapeId as bigint);
        actor = (a.to as string).toLowerCase();
        summary = `Tape #${a.tapeId} transferred to ${shortHex(a.to as string)}`;
        break;
      case "TrackRegistered": {
        const owner = this.tapeOwner(a.tapeId as bigint);
        db.prepare(
          `INSERT OR REPLACE INTO tracks (id, tape, owner, key, content_type, size, root, epoch, status, signers, registered_at, register_tx)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'registered', 0, ?, ?)`,
        ).run(
          Number(a.trackId),
          Number(a.tapeId),
          owner,
          a.key as string,
          a.contentType as string,
          Number(a.size),
          a.root as string,
          Number(a.epoch),
          time,
          log.transactionHash,
        );
        touched.tapes.add(a.tapeId as bigint);
        actor = owner;
        summary = `Track #${a.trackId} registered · ${a.key} · ${formatBytes(a.size as bigint)}`;
        break;
      }
      case "TrackCertified":
        db.prepare("UPDATE tracks SET status = 'certified', signers = ?, certified_at = ?, certify_tx = ? WHERE id = ?").run(
          Number(a.signers),
          time,
          log.transactionHash,
          Number(a.trackId),
        );
        actor = this.tapeOwner(a.tapeId as bigint);
        summary = `Track #${a.trackId} certified by ${a.signers} nodes`;
        break;
      case "TrackDeleted":
        db.prepare("UPDATE tracks SET status = 'deleted' WHERE id = ?").run(Number(a.trackId));
        touched.tapes.add(a.tapeId as bigint);
        actor = this.tapeOwner(a.tapeId as bigint);
        summary = `Track #${a.trackId} deleted`;
        break;
      case "NodeSlashed":
        db.prepare("UPDATE nodes SET slashes = slashes + 1 WHERE address = ?").run((a.node as string).toLowerCase());
        touched.nodes.add(a.node as Address);
        actor = (a.node as string).toLowerCase();
        summary = `${this.nodeName(a.node as string)} slashed ${formatToken(a.amount as bigint)} BSHD (${a.votes} votes)`;
        break;
      case "NodeRegistered":
        touched.nodes.add(a.operator as Address);
        touched.delegations.add(`${a.operator}:${a.operator}`);
        actor = (a.operator as string).toLowerCase();
        summary = `Node ${a.name} joined`;
        break;
      case "NodeUpdated":
        touched.nodes.add(a.operator as Address);
        actor = (a.operator as string).toLowerCase();
        summary = `Node ${a.name} updated`;
        break;
      case "NodeActiveChanged":
        touched.nodes.add(a.operator as Address);
        actor = (a.operator as string).toLowerCase();
        summary = `${this.nodeName(a.operator as string)} ${a.active ? "is accepting shards" : "is leaving"}`;
        break;
      case "Delegated":
        touched.nodes.add(a.node as Address);
        touched.delegations.add(`${a.node}:${a.delegator}`);
        actor = (a.delegator as string).toLowerCase();
        summary = `${formatToken(a.amount as bigint)} BSHD staked to ${this.nodeName(a.node as string)}`;
        break;
      case "UnstakeRequested":
        touched.nodes.add(a.node as Address);
        touched.delegations.add(`${a.node}:${a.delegator}`);
        actor = (a.delegator as string).toLowerCase();
        summary = `${formatToken(a.amount as bigint)} BSHD unstaking from ${this.nodeName(a.node as string)}`;
        break;
      case "Withdrawn":
        actor = (a.delegator as string).toLowerCase();
        summary = `${formatToken(a.amount as bigint)} BSHD withdrawn`;
        break;
      case "RewardDistributed":
        touched.nodes.add(a.node as Address);
        actor = (a.node as string).toLowerCase();
        summary = `${this.nodeName(a.node as string)} earned ${formatToken(a.amount as bigint)} BSHD`;
        break;
      case "CommissionClaimed":
        touched.nodes.add(a.node as Address);
        actor = (a.node as string).toLowerCase();
        summary = `${this.nodeName(a.node as string)} claimed ${formatToken(a.amount as bigint)} BSHD commission`;
        break;
      case "Slashed":
        touched.nodes.add(a.node as Address);
        return null; // NodeSlashed from the core carries the story
      default:
        return null;
    }

    const ev: ActivityEvent = {
      id: `${log.blockNumber}:${log.logIndex}`,
      kind,
      block: Number(log.blockNumber),
      tx: log.transactionHash,
      time,
      actor,
      summary,
      data: JSON.parse(json(a)),
    };
    db.prepare(
      "INSERT OR IGNORE INTO events (id, kind, block, tx, time, actor, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(ev.id, ev.kind, ev.block, ev.tx, ev.time, ev.actor, ev.summary, json(ev.data));
    return ev;
  }

  private async refresh(touched: { nodes: Set<Address>; tapes: Set<bigint>; delegations: Set<string> }): Promise<void> {
    const { db, client, deployment } = this;
    for (const addr of touched.nodes) {
      const n = await client.readContract({ address: deployment.staking, abi: stakingAbi, functionName: "getNode", args: [addr] });
      db.prepare(
        `INSERT INTO nodes (address, signer, name, endpoint, commission_bps, active, jailed_until, registered_epoch, stake, total_shares, operator_rewards)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET signer = excluded.signer, name = excluded.name, endpoint = excluded.endpoint,
           commission_bps = excluded.commission_bps, active = excluded.active, jailed_until = excluded.jailed_until,
           stake = excluded.stake, total_shares = excluded.total_shares, operator_rewards = excluded.operator_rewards`,
      ).run(
        addr.toLowerCase(),
        n.signer.toLowerCase(),
        n.name,
        n.endpoint,
        n.commissionBps,
        n.active ? 1 : 0,
        n.jailedUntil,
        n.registeredEpoch,
        n.pooled.toString(),
        n.totalShares.toString(),
        n.operatorRewards.toString(),
      );
    }
    for (const id of touched.tapes) {
      const t = await client.readContract({ address: deployment.bashard, abi: bashardAbi, functionName: "getTape", args: [id] });
      db.prepare("UPDATE tapes SET owner = ?, capacity_mb = ?, used_bytes = ?, expiry_epoch = ?, track_count = ? WHERE id = ?").run(
        t.owner.toLowerCase(),
        Number(t.capacityMB),
        Number(t.usedBytes),
        t.expiryEpoch,
        t.trackCount,
        Number(id),
      );
    }
    for (const key of touched.delegations) {
      const [node, delegator] = key.split(":") as [Address, Address];
      const [shares, principal] = await Promise.all([
        client.readContract({ address: deployment.staking, abi: stakingAbi, functionName: "sharesOf", args: [node, delegator] }),
        client.readContract({ address: deployment.staking, abi: stakingAbi, functionName: "principalOf", args: [node, delegator] }),
      ]);
      db.prepare(
        `INSERT INTO delegations (node, delegator, shares, principal) VALUES (?, ?, ?, ?)
         ON CONFLICT(node, delegator) DO UPDATE SET shares = excluded.shares, principal = excluded.principal`,
      ).run(node.toLowerCase(), delegator.toLowerCase(), shares.toString(), principal.toString());
    }
  }
}
