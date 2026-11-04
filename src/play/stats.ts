/** Nearest-rank percentile statistics (shared by the dashboard and the Node benchmark). */
export function latencyStats(ms: number[]): { n: number; mean: number; p50: number; p95: number; p99: number; max: number } | null {
  if (!ms.length) return null;
  const s = [...ms].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1] };
}
