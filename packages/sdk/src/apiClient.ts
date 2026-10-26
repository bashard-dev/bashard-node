// Typed client for the indexer API (apps/indexer).

import type {
  AccountInfo,
  ActivityEvent,
  EpochInfo,
  NetworkStats,
  NodeInfo,
  SearchResult,
  TapeInfo,
  TrackInfo,
} from "@bashard/core";

export class ApiClient {
  constructor(public readonly baseUrl: string) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  stats() {
    return this.get<NetworkStats>("/v1/stats");
  }
  nodes() {
    return this.get<NodeInfo[]>("/v1/nodes");
  }
  node(address: string) {
    return this.get<NodeInfo & { events: ActivityEvent[] }>(`/v1/nodes/${address}`);
  }
  epochs(limit = 20) {
    return this.get<EpochInfo[]>(`/v1/epochs?limit=${limit}`);
  }
  epoch(n: number) {
    return this.get<EpochInfo>(`/v1/epochs/${n}`);
  }
  tracks(params: { limit?: number; tape?: number; owner?: string } = {}) {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.tape) q.set("tape", String(params.tape));
    if (params.owner) q.set("owner", params.owner);
    return this.get<TrackInfo[]>(`/v1/tracks?${q}`);
  }
  track(id: number | bigint) {
    return this.get<TrackInfo & { placement: { shard: number; node: string; name: string }[] }>(`/v1/tracks/${id}`);
  }
  tapes(params: { owner?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (params.owner) q.set("owner", params.owner);
    if (params.limit) q.set("limit", String(params.limit));
    return this.get<TapeInfo[]>(`/v1/tapes?${q}`);
  }
  tape(id: number | bigint) {
    return this.get<TapeInfo>(`/v1/tapes/${id}`);
  }
  account(address: string) {
    return this.get<AccountInfo>(`/v1/accounts/${address}`);
  }
  events(params: { limit?: number; actor?: string; kind?: string } = {}) {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.actor) q.set("actor", params.actor);
    if (params.kind) q.set("kind", params.kind);
    return this.get<ActivityEvent[]>(`/v1/events?${q}`);
  }
  tx(hash: string) {
    return this.get<ActivityEvent[]>(`/v1/tx/${hash}`);
  }
  search(query: string) {
    return this.get<SearchResult[]>(`/v1/search?q=${encodeURIComponent(query)}`);
  }

  /** Live events over Server-Sent Events. Returns an unsubscribe function. */
  subscribe(onEvent: (e: ActivityEvent) => void): () => void {
    const es = new EventSource(`${this.baseUrl.replace(/\/$/, "")}/v1/stream`);
    es.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as ActivityEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => es.close();
  }
}
