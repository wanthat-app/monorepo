import { LandingSnapshot } from "@wanthat/contracts";

/**
 * The server-injected landing payload (`window.__WANTHAT_LANDING__`, ADR-0007): the landing
 * Lambda resolves the recommendation and embeds a `LandingSnapshot` into the shell, so the SPA
 * renders the identical card with zero extra round trips. Returns null when the snapshot is
 * absent, fails validation, or belongs to a different recommendation (stale shell via
 * client-side navigation) — the page then hard-reloads `/p/{id}` so the server injects a fresh
 * one (the server ALWAYS injects a snapshot, so the reload cannot loop).
 */
export function readLandingSnapshot(recommendationId: string): LandingSnapshot | null {
  const raw = (globalThis as { __WANTHAT_LANDING__?: unknown }).__WANTHAT_LANDING__;
  if (raw === undefined) return null;
  const parsed = LandingSnapshot.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.status === "ok" && parsed.data.landing.recommendationId !== recommendationId) {
    return null;
  }
  return parsed.data;
}
