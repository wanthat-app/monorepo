/**
 * Per-user localStorage cache for Aurora-backed member data (spec 2026-07-21-cold-start-cache):
 * the last wallet response and the first page of the merged activity feed, shown — clearly
 * marked as "counting" — while Aurora cold-resumes. Keys carry the Cognito `sub` (ADR-0020),
 * so a shared device never shows another member's numbers; sign-out clears everything.
 * Storage can be absent or throwing (Safari private mode) — every access degrades to a miss.
 */
const PREFIX = "wanthat.cache.";
const VERSION = 1;

/** Older than this reads as a miss — a week-old balance presented as "counting" would mislead. */
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type CacheKind = "wallet" | "activity";

interface Envelope<T> {
  v: number;
  savedAt: number;
  data: T;
}

export function readCache<T>(kind: CacheKind, sub: string): T | null {
  try {
    const raw = localStorage.getItem(`${PREFIX}${kind}.${sub}`);
    if (!raw) return null;
    const env = JSON.parse(raw) as Envelope<T>;
    if (env.v !== VERSION || typeof env.savedAt !== "number") return null;
    if (Date.now() - env.savedAt > CACHE_TTL_MS) return null;
    return env.data ?? null;
  } catch {
    return null;
  }
}

export function writeCache<T>(kind: CacheKind, sub: string, data: T): void {
  try {
    const env: Envelope<T> = { v: VERSION, savedAt: Date.now(), data };
    localStorage.setItem(`${PREFIX}${kind}.${sub}`, JSON.stringify(env));
  } catch {
    // Storage unavailable — cold starts on this device just show skeletons.
  }
}

/** Remove every cached entry (all kinds, all subs) — called on sign-out. */
export function clearAllCaches(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}
