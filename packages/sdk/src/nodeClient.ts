// HTTP client for one storage node (apps/node).

import type { Hex } from "viem";
import type { LeafProof } from "@bashard/core";

export class NodeHttpError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
    message: string,
  ) {
    super(`${endpoint}: ${status} ${message}`);
  }
}

export interface NodeHealth {
  operator: string;
  signer: string;
  name: string;
  epoch: number;
  shards: number;
  bytes: number;
  version: string;
}

async function check(endpoint: string, res: Response): Promise<Response> {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = body.error ?? msg;
    } catch {
      /* not json */
    }
    throw new NodeHttpError(endpoint, res.status, msg);
  }
  return res;
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

export class NodeClient {
  constructor(
    public readonly endpoint: string,
    private readonly timeoutMs = 30_000,
  ) {}

  private url(path: string): string {
    return `${this.endpoint.replace(/\/$/, "")}${path}`;
  }

  async health(): Promise<NodeHealth> {
    const t = withTimeout(5_000);
    try {
      const res = await check(this.endpoint, await fetch(this.url("/v1/health"), { signal: t.signal }));
      return (await res.json()) as NodeHealth;
    } finally {
      t.done();
    }
  }

  /** Upload one shard with all 20 shard roots, which the node checks against the on-chain track root. */
  async putShard(trackId: bigint, index: number, shard: Uint8Array, shardRoots: Hex[]): Promise<void> {
    const t = withTimeout(this.timeoutMs);
    try {
      await check(
        this.endpoint,
        await fetch(this.url(`/v1/tracks/${trackId}/shards/${index}`), {
          method: "PUT",
          headers: { "content-type": "application/octet-stream", "x-bashard-roots": shardRoots.join(",") },
          body: shard as unknown as BodyInit,
          signal: t.signal,
        }),
      );
    } finally {
      t.done();
    }
  }

  async getShard(trackId: bigint, index: number): Promise<{ shard: Uint8Array; proof: Hex[] }> {
    const t = withTimeout(this.timeoutMs);
    try {
      const res = await check(
        this.endpoint,
        await fetch(this.url(`/v1/tracks/${trackId}/shards/${index}`), { signal: t.signal }),
      );
      const proofHeader = res.headers.get("x-bashard-proof") ?? "";
      const proof = proofHeader ? (proofHeader.split(",") as Hex[]) : [];
      return { shard: new Uint8Array(await res.arrayBuffer()), proof };
    } finally {
      t.done();
    }
  }

  async getRoots(trackId: bigint): Promise<Hex[]> {
    const t = withTimeout(this.timeoutMs);
    try {
      const res = await check(this.endpoint, await fetch(this.url(`/v1/tracks/${trackId}/roots`), { signal: t.signal }));
      return ((await res.json()) as { roots: Hex[] }).roots;
    } finally {
      t.done();
    }
  }

  async requestCertify(trackId: bigint): Promise<Hex> {
    const t = withTimeout(this.timeoutMs);
    try {
      const res = await check(
        this.endpoint,
        await fetch(this.url(`/v1/tracks/${trackId}/certify`), { method: "POST", signal: t.signal }),
      );
      const body = (await res.json()) as { signature: Hex };
      return body.signature;
    } finally {
      t.done();
    }
  }

  /** Ask a committee peer to co-sign a slash; `proposerSignature` is our own vote on the same digest. */
  async slashVote(target: string, reason: number, proposerSignature: Hex): Promise<Hex> {
    const t = withTimeout(20_000);
    try {
      const res = await check(
        this.endpoint,
        await fetch(this.url(`/v1/slash-vote`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target, reason, signature: proposerSignature }),
          signal: t.signal,
        }),
      );
      return ((await res.json()) as { signature: Hex }).signature;
    } finally {
      t.done();
    }
  }

  async challenge(trackId: bigint, shardIndex: number, leafIndex: number): Promise<LeafProof> {
    const t = withTimeout(5_000);
    try {
      const res = await check(
        this.endpoint,
        await fetch(this.url(`/v1/tracks/${trackId}/challenge/${shardIndex}/${leafIndex}`), { signal: t.signal }),
      );
      return (await res.json()) as LeafProof;
    } finally {
      t.done();
    }
  }
}
