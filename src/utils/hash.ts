/** 32-bit FNV-1a, hex. Deterministic content hashing for duplicate detection (not cryptographic). */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 64-bit-ish hash from two FNV passes — fewer collisions for large game collections. */
export function contentHash(s: string): string {
  return fnv1a(s) + fnv1a('moth:' + s.split('').reverse().join(''));
}

export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
