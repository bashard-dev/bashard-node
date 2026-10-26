// Background duties of a storage node:
//   keeper  — advances the epoch when it is over
//   sync    — fetches or rebuilds shards newly assigned to this node
//   gc      — drops shards that are deleted, expired or no longer ours
//   auditor — challenges other committee members and proposes slashes

import { recoverMessageAddress, type Address, type Hex } from "viem";
import {
  holderIndex,
  leafCount,
  quorum,
  repairShard,
  shardLength,
  shardRoot,
  shardsForMember,
  SHARDS_K,
  SHARDS_N,
  slashDigest,
  SlashReason,
  stakingAbi,
  TrackStatus,
  trackRoot,
  verifyLeafProof,
  type ChallengeReport,
} from "@bashard/core";
import { NodeClient } from "@bashard/sdk";
import type { ChainContext } from "./chain";
import type { LocalTrack } from "./store";

function randInt(n: number): number {
  return Math.floor(Math.random() * n);
}

export class Workers {
  private timers: NodeJS.Timeout[] = [];
  private busy = new Set<string>();
  private canAdvanceSince: number | null = null;

  constructor(private readonly ctx: ChainContext) {}

  start(): void {
    const { cfg } = this.ctx;
    if (cfg.keeper) this.every("keeper", 2_000, () => this.keeper());
    this.every("sync", cfg.syncIntervalMs, () => this.sync());
    this.every("gc", 15_000, () => this.gc());
    this.every("auditor", cfg.auditIntervalMs, () => this.audit());
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
  }

  private every(name: string, ms: number, fn: () => Promise<void>): void {
    const run = async () => {
      if (this.busy.has(name)) return;
      this.busy.add(name);
      try {
        await fn();
      } catch (err) {
        this.ctx.cfg.log(`${name}: ${(err as Error).message.split("\n")[0]}`);
      } finally {
        this.busy.delete(name);
      }
    };
    this.timers.push(setInterval(run, ms));
  }

  private async client(node: Address): Promise<NodeClient> {
    const rec = await this.ctx.sdk.node(node);
    return new NodeClient(rec.endpoint, 15_000);
  }

  private liveTracks(epoch: number): LocalTrack[] {
    return this.ctx.store.tracksWithStatus(TrackStatus.Certified).filter((t) => {
      const expiry = this.ctx.store.tapeExpiry(t.tapeId);
      return expiry === undefined || expiry > epoch;
    });
  }

  // ---------------------------------------------------------------- keeper

  private async keeper(): Promise<void> {
    const { sdk } = this.ctx;
    if (!(await sdk.canAdvance())) {
      this.canAdvanceSince = null;
      return;
    }
    const now = Date.now();
    this.canAdvanceSince ??= now;
    const { epoch } = await this.ctx.currentEpoch();
    const members = await this.ctx.committee(epoch);
    const me = this.ctx.memberIndex(members);
    // Members take turns by rank so only one transaction usually lands.
    const delay = members.length === 0 ? randInt(3_000) : me >= 0 ? me * 4_000 : 60_000;
    if (now - this.canAdvanceSince < delay) return;
    try {
      await sdk.advanceEpoch();
      this.ctx.cfg.log(`advanced epoch ${epoch} → ${epoch + 1}`);
    } catch (err) {
      if (!/epoch not over/.test((err as Error).message)) throw err;
    }
    this.canAdvanceSince = null;
  }

  // ---------------------------------------------------------------- sync and repair

  private async rootsFor(track: LocalTrack, sources: Address[]): Promise<Hex[] | undefined> {
    const local = this.ctx.store.roots(track.id);
    if (local) return local;
    for (const s of sources) {
      try {
        const roots = await (await this.client(s)).getRoots(track.id);
        if (roots.length === SHARDS_N && trackRoot(roots).toLowerCase() === track.root.toLowerCase()) {
          this.ctx.store.setRoots(track.id, roots);
          return roots;
        }
      } catch {
        /* next source */
      }
    }
    return undefined;
  }

  /** Every node that may hold shard i of a track: current, previous and registration committees. */
  private async holdersOf(track: LocalTrack, i: number, epoch: number): Promise<Address[]> {
    const out: Address[] = [];
    for (const e of [epoch, epoch - 1, track.epoch]) {
      if (e < 0) continue;
      const members = await this.ctx.committee(e);
      if (members.length === 0) continue;
      const h = members[holderIndex(track.id, i, members.length)];
      if (h.toLowerCase() !== this.ctx.address.toLowerCase() && !out.some((x) => x.toLowerCase() === h.toLowerCase())) out.push(h);
    }
    return out;
  }

  private async sync(): Promise<void> {
    const { epoch } = await this.ctx.currentEpoch();
    const members = await this.ctx.committee(epoch);
    const me = this.ctx.memberIndex(members);
    if (me < 0) return;
    let budget = 40;
    for (const track of this.liveTracks(epoch)) {
      const missing = shardsForMember(track.id, me, members.length).filter((i) => !this.ctx.store.hasShard(track.id, i));
      for (const i of missing) {
        if (budget-- <= 0) return;
        await this.fetchOrRepair(track, i, epoch);
      }
    }
  }

  private async fetchOrRepair(track: LocalTrack, i: number, epoch: number): Promise<void> {
    const allHolders = new Set<Address>();
    for (let j = 0; j < SHARDS_N; j++) for (const h of await this.holdersOf(track, j, epoch)) allHolders.add(h);
    const roots = await this.rootsFor(track, [...allHolders]);
    if (!roots) return;
    const len = shardLength(track.size);

    // 1) Copy it from whoever held it before.
    for (const h of await this.holdersOf(track, i, epoch)) {
      try {
        const { shard } = await (await this.client(h)).getShard(track.id, i);
        if (shard.length === len && shardRoot(shard).toLowerCase() === roots[i].toLowerCase()) {
          this.ctx.store.putShard(track.id, i, shard);
          this.ctx.cfg.log(`synced track ${track.id} shard ${i} from ${h.slice(0, 8)}`);
          return;
        }
      } catch {
        /* next */
      }
    }

    // 2) Rebuild it from any K other shards.
    const shards: (Uint8Array | null)[] = Array(SHARDS_N).fill(null);
    let have = 0;
    for (let j = 0; j < SHARDS_N && have < SHARDS_K; j++) {
      if (j === i) continue;
      const local = this.ctx.store.getShard(track.id, j);
      if (local) {
        shards[j] = local;
        have++;
        continue;
      }
      for (const h of await this.holdersOf(track, j, epoch)) {
        try {
          const { shard } = await (await this.client(h)).getShard(track.id, j);
          if (shard.length === len && shardRoot(shard).toLowerCase() === roots[j].toLowerCase()) {
            shards[j] = shard;
            have++;
            break;
          }
        } catch {
          /* next */
        }
      }
    }
    if (have < SHARDS_K) {
      this.ctx.cfg.log(`cannot repair track ${track.id} shard ${i}: only ${have} shards reachable`);
      return;
    }
    const rebuilt = repairShard(shards, i);
    if (shardRoot(rebuilt).toLowerCase() !== roots[i].toLowerCase()) throw new Error(`repair of ${track.id}/${i} produced a bad shard`);
    this.ctx.store.putShard(track.id, i, rebuilt);
    this.ctx.cfg.log(`repaired track ${track.id} shard ${i} from ${have} shards`);
  }

  // ---------------------------------------------------------------- garbage collection

  private async gc(): Promise<void> {
    const { store } = this.ctx;
    const { epoch } = await this.ctx.currentEpoch();
    const current = await this.ctx.committee(epoch);
    const previous = epoch > 0 ? await this.ctx.committee(epoch - 1) : [];
    for (const { track: id, idx } of store.allShards()) {
      const t = store.track(id);
      if (!t) continue;
      const expiry = store.tapeExpiry(t.tapeId);
      if (t.status === TrackStatus.Deleted || (expiry !== undefined && expiry <= epoch)) {
        store.deleteTrackData(id);
        continue;
      }
      if (t.epoch >= epoch - 1) continue; // keep while uploads/certification may still need it
      const mine = (members: Address[]) => {
        const me = this.ctx.memberIndex(members);
        return me >= 0 && members.length > 0 && holderIndex(id, idx, members.length) === me;
      };
      if (!mine(current) && !mine(previous)) store.deleteShard(id, idx);
    }
  }

  // ---------------------------------------------------------------- auditing

  /** Challenge `target` on shard i of `track`. True if it answered correctly in time. */
  private async challenge(target: Address, track: LocalTrack, i: number): Promise<{ passed: boolean; latencyMs: number }> {
    const leaves = leafCount(shardLength(track.size));
    const leaf = randInt(leaves);
    const start = Date.now();
    try {
      const proof = await (await this.client(target)).challenge(track.id, i, leaf);
      const latencyMs = Date.now() - start;
      const passed = proof.shardIndex === i && proof.leafIndex === leaf && verifyLeafProof(proof, track.root) && latencyMs < 5_000;
      return { passed, latencyMs };
    } catch {
      return { passed: false, latencyMs: Date.now() - start };
    }
  }

  private async inChallengeWindow(): Promise<{ epoch: number; members: Address[] } | null> {
    const { epoch, startedAt, duration } = await this.ctx.currentEpoch();
    const members = await this.ctx.committee(epoch);
    if (this.ctx.memberIndex(members) < 0 || members.length < 2) return null;
    const elapsed = (await this.ctx.chainNow()) - startedAt;
    if (elapsed < duration * this.ctx.cfg.syncGrace) return null; // shards are still moving
    return { epoch, members };
  }

  private async audit(): Promise<void> {
    const win = await this.inChallengeWindow();
    if (!win) return;
    const { epoch, members } = win;
    const tracks = this.liveTracks(epoch);
    if (tracks.length === 0) return;
    const track = tracks[randInt(tracks.length)];
    const i = randInt(SHARDS_N);
    const target = members[holderIndex(track.id, i, members.length)];
    if (target.toLowerCase() === this.ctx.address.toLowerCase()) return;

    const { passed, latencyMs } = await this.challenge(target, track, i);
    void this.report({ epoch, target, trackId: track.id.toString(), shardIndex: i, passed, latencyMs });
    if (passed) return;

    const count = this.ctx.store.recordFailure(epoch, target);
    this.ctx.cfg.log(`challenge failed: ${target.slice(0, 10)} track ${track.id} shard ${i} (${count} this epoch)`);
    if (count >= this.ctx.cfg.slashThreshold && this.ctx.store.markProposed(epoch, target)) {
      await this.proposeSlash(target, epoch, members);
    }
  }

  private async proposeSlash(target: Address, epoch: number, members: Address[]): Promise<void> {
    const reason = SlashReason.FailedChallenges;
    const digest = slashDigest(this.ctx.chainId, this.ctx.contract, target, epoch, reason);
    const mine = await this.ctx.signDigest(digest);
    const signatures: Hex[] = [mine];
    const voters = members.filter(
      (m) => m.toLowerCase() !== target.toLowerCase() && m.toLowerCase() !== this.ctx.address.toLowerCase(),
    );
    await Promise.all(
      voters.map(async (v) => {
        try {
          signatures.push(await (await this.client(v)).slashVote(target, reason, mine));
        } catch {
          /* voter declined or offline */
        }
      }),
    );
    const need = quorum(members.length - 1);
    this.ctx.cfg.log(`slash proposal against ${target.slice(0, 10)}: ${signatures.length}/${members.length - 1} votes, need ${need}`);
    if (signatures.length < need) return;
    try {
      await this.ctx.sdk.slash(target, reason, signatures);
      this.ctx.cfg.log(`slashed ${target}`);
    } catch (err) {
      if (!/already slashed/.test((err as Error).message)) throw err;
    }
  }

  /** Called when a peer asks us to co-sign a slash: re-check the target ourselves. */
  async slashVote(target: Address, reason: number, proposerSignature: Hex): Promise<Hex> {
    const { epoch } = await this.ctx.currentEpoch();
    const members = await this.ctx.committee(epoch);
    // Only a fellow committee member, who has already signed the same slash, may ask.
    const digest = slashDigest(this.ctx.chainId, this.ctx.contract, target, epoch, reason);
    const signer = await recoverMessageAddress({ message: { raw: digest }, signature: proposerSignature });
    const proposer = await this.ctx.publicClient.readContract({
      address: this.ctx.cfg.deployment.staking,
      abi: stakingAbi,
      functionName: "operatorOfSigner",
      args: [signer],
    });
    if (!members.some((m) => m.toLowerCase() === proposer.toLowerCase()) || proposer.toLowerCase() === target.toLowerCase()) {
      throw new Error("proposer is not a committee member");
    }
    if (!members.some((m) => m.toLowerCase() === target.toLowerCase())) throw new Error("target not in committee");
    if (target.toLowerCase() === this.ctx.address.toLowerCase()) throw new Error("cannot vote on self");

    const candidates: { track: LocalTrack; i: number }[] = [];
    for (const track of this.liveTracks(epoch)) {
      for (let i = 0; i < SHARDS_N; i++) {
        if (members[holderIndex(track.id, i, members.length)].toLowerCase() === target.toLowerCase()) candidates.push({ track, i });
      }
    }
    if (candidates.length === 0) throw new Error("target holds nothing we can check");
    let failed = 0;
    const rounds = Math.min(3, candidates.length);
    for (let r = 0; r < rounds; r++) {
      const c = candidates[randInt(candidates.length)];
      if (!(await this.challenge(target, c.track, c.i)).passed) failed++;
    }
    if (failed < Math.ceil(rounds / 2)) throw new Error(`target passed ${rounds - failed}/${rounds} checks`);
    return this.ctx.signDigest(slashDigest(this.ctx.chainId, this.ctx.contract, target, epoch, reason));
  }

  private async report(r: Omit<ChallengeReport, "challenger" | "signature" | "time">): Promise<void> {
    const url = this.ctx.cfg.indexerUrl;
    if (!url) return;
    const body = { ...r, challenger: this.ctx.address, time: Math.floor(Date.now() / 1000) };
    const message = JSON.stringify(body);
    const signature = await this.ctx.signer.signMessage({ message });
    try {
      await fetch(`${url.replace(/\/$/, "")}/v1/reports/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ report: body, message, signature }),
      });
    } catch {
      /* indexer offline: reports are best effort */
    }
  }
}
