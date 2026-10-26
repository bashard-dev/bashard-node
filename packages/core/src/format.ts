import { formatUnits } from "viem";

export function formatBytes(n: number | bigint): string {
  let v = Number(n);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${units[u]}`;
}

export function formatToken(wei: bigint | string, digits = 2): string {
  const v = Number(formatUnits(BigInt(wei), 18));
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function shortHex(h: string, head = 6, tail = 4): string {
  if (!h) return "";
  return h.length <= head + tail + 2 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;
}

export function timeAgo(unixSeconds: number, now = Date.now() / 1000): string {
  const d = Math.max(0, Math.floor(now - unixSeconds));
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
