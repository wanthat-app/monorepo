import { convertMinor } from "@wanthat/domain";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import { getOrMintGuestId, resolveRedirect } from "../../lib/landing-api";
import { formatMoneyMinor } from "../../lib/money";
import { Button, Screen, Spinner } from "../../ui/components";
import {
  hasStoredSession,
  loginWithPasskey,
  passkeyLoginAvailable,
  passkeysSupported,
  rememberedPhone,
  useSession,
} from "../../user";
import { readLandingSnapshot } from "./snapshot";

/**
 * Referral landing (ADR-0007/0006) — the dynamic, SPA-rendered `/p/{id}` page. The landing SERVICE
 * server-renders only the OG tags + a content snapshot for bots; this page is what humans get.
 *
 * Design rule: CONTENT FIRST — the product card renders immediately and unconditionally; auth is a
 * small module under it and never gates rendering. The module walks the same states as /auth:
 *  - logged in (stored session) → "signing you in…" while rehydrating → auto-redirect to the store;
 *  - logged out + returning device (remembered phone, ADR-0006) → the Face ID prompt is ARMED and
 *    fires when the document gains focus (iOS Safari rejects an unfocused get(); worst case it pops
 *    on the first tap) — the CTAs stay visible underneath; on success → auto-redirect;
 *  - logged out / unknown device → Sign up / Log in (→ /auth?ref, which redirects to the store after
 *    auth) + a direct guest link.
 * The whole path is backend-free (ADR-0006): Cognito challenge + token mint, done — no Aurora, no
 * app API. The product is REAL: hydrated from the server-injected `window.__WANTHAT_LANDING__`
 * snapshot (`LandingSnapshot`), and the store redirect is the REAL attributed resolve
 * (ADR-0008): members enter a countdown interstitial (admin-tunable `landing.countdownSeconds`)
 * whose URL carries `ref` + `c`; the guest CTA is the ADR-0008 consent gate — clicking it mints
 * the localStorage `guestId` and resolves with `ref` + `g`.
 */
const MERCHANT_NAMES: Record<string, string> = { aliexpress: "AliExpress" };

export function SharedProductPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const [searchParams] = useSearchParams();
  // A member is recognised by the session status (a valid Cognito refresh) — the profile comes free
  // with it (ID-token claims), so no backend is touched either way (ADR-0006).
  const { status, loading, accessToken } = useSession();
  // True from the moment the biometric succeeds until the Cognito round-trip lands — the module
  // shows "signing you in…" instead of looking hung.
  const [verifying, setVerifying] = useState(false);
  // A passkey login that just completed on this page (session persisted, redirect firing).
  const [authed, setAuthed] = useState(false);
  const armed = useRef(false);
  // On-device diagnosis of the auto-prompt gates (`?debug=1` renders it): phones have no console, so
  // when the Face ID sheet doesn't appear this names WHICH gate suppressed it or what the ceremony threw.
  const debug = searchParams.get("debug") !== null;
  const [diag, setDiag] = useState<string[]>([]);
  const note = (line: string) => {
    console.log(`[landing-auth] ${line}`);
    setDiag((d) => [...d, line]);
  };

  // The server-injected landing payload. Absent (client-side navigation / stale shell) → one
  // hard reload of /p/{id}: the landing Lambda ALWAYS injects a snapshot, so this cannot loop.
  const snapshot = readLandingSnapshot(id);
  const ok = snapshot?.status === "ok";
  const reloaded = useRef(false);
  useEffect(() => {
    if (!snapshot && !reloaded.current) {
      reloaded.current = true;
      window.location.reload();
    }
  }, [snapshot]);

  // A recognised (valid refresh) or just-authenticated member enters the redirect interstitial:
  // resolve once (Bearer → ref + c), count down, navigate. `authRequired` means the session went
  // stale on the server's view — fall back to the signed-out CTAs. Never from a dead link.
  const signedIn = status === "signedIn" || authed;
  const [storeUrl, setStoreUrl] = useState<string | null>(null);
  const [resolveState, setResolveState] = useState<"idle" | "pending" | "failed" | "authRequired">(
    "idle",
  );
  const [countdown, setCountdown] = useState<number | null>(null);
  const memberFlow = signedIn && ok && resolveState !== "authRequired";

  useEffect(() => {
    if (!memberFlow || resolveState !== "idle") return;
    setResolveState("pending");
    void resolveRedirect(id, { token: accessToken() ?? undefined })
      .then((r) => {
        if (r.outcome === "redirect") setStoreUrl(r.url);
        else setResolveState("authRequired");
      })
      .catch(() => setResolveState("failed"));
  }, [memberFlow, resolveState, id, accessToken]);

  // Admin-tunable countdown (snapshot.countdownSeconds): starts when the member flow begins…
  useEffect(() => {
    if (!memberFlow || snapshot?.status !== "ok" || countdown !== null) return;
    setCountdown(snapshot.countdownSeconds);
  }, [memberFlow, snapshot, countdown]);
  // …ticks once a second…
  useEffect(() => {
    if (countdown === null || countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((c) => (c === null ? c : c - 1)), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);
  // …and navigates once BOTH the countdown elapsed and the attributed URL arrived.
  useEffect(() => {
    if (memberFlow && countdown === 0 && storeUrl) window.location.assign(storeUrl);
  }, [memberFlow, countdown, storeUrl]);

  // Guest: the CTA click IS the consent (ADR-0008) — only then mint/reuse the localStorage id.
  const [guestState, setGuestState] = useState<"idle" | "pending" | "failed">("idle");
  const guestGo = () => {
    setGuestState("pending");
    void resolveRedirect(id, { guestId: getOrMintGuestId() })
      .then((r) => {
        if (r.outcome === "redirect") window.location.assign(r.url);
        else setGuestState("failed");
      })
      .catch(() => setGuestState("failed"));
  };

  // Arm the automatic passkey prompt when there is no session: only on a returning device — a
  // remembered phone exists (Cognito's WEB_AUTHN challenge is username-gated; userless login is
  // waived, ADR-0006). The module waits for document focus internally, so rendering is never
  // blocked on it.
  useEffect(() => {
    if (armed.current) return;
    armed.current = true;
    if (hasStoredSession()) {
      note("gate: stored session → rehydrating, no prompt");
      return; // the session effect above redirects once the refresh lands
    }
    if (!passkeysSupported()) {
      note("gate: webauthn unsupported → no prompt");
      return;
    }
    if (!rememberedPhone()) {
      note("gate: no remembered phone → no prompt (ADR-0006: userless login waived)");
      return;
    }
    note("auto-prompt: checking passkey availability (Cognito AvailableChallenges)");
    void (async () => {
      try {
        // Server truth: the account must actually have a passkey (a local flag can drift —
        // it did; see the AuthPage gate for the same check).
        if (!(await passkeyLoginAvailable())) {
          note("gate: account has no passkey → no prompt");
          return;
        }
        note("auto-prompt: armed — fires on document focus");
        await loginWithPasskey({
          onCredential: () => {
            note("biometric ok → verifying");
            setVerifying(true);
          },
        });
        setAuthed(true); // → signedIn → the redirect effect above
      } catch (err) {
        note(
          `auto-prompt failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
        );
        setVerifying(false); // the CTAs are already on screen — nothing else to do
      }
    })();
    // note/setDiag are stable enough for this once-guarded effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Snapshot missing → the reload effect above is firing; render nothing for the split second.
  if (!snapshot) return null;

  if (snapshot.status === "notFound") {
    return (
      <Screen>
        <div className="mx-auto flex w-full max-w-[440px] flex-col gap-4 text-center">
          <div className="font-display text-[22px] font-bold tracking-[-0.03em]">wanthat</div>
          <h1 className="font-display text-[19px] font-semibold tracking-[-0.02em]">
            {t("shared.notFoundTitle")}
          </h1>
          <p className="text-[13.5px] text-muted">{t("shared.notFoundBody")}</p>
        </div>
      </Screen>
    );
  }

  const { landing, displayFx } = snapshot;
  // Display conversion — same convention as CreateLinkPage: the price converts at the pure rate
  // (information), cashback carries the FX margin (what a withdrawal would actually yield).
  const display = (
    money: { amountMinor: bigint; currency: string } | null,
    cashback: boolean,
  ): string | null => {
    if (!money) return null;
    if (displayFx && money.currency === displayFx.rate.base) {
      const minor = convertMinor(
        money.amountMinor,
        displayFx.rate.rate,
        cashback ? displayFx.commissionBps : 0,
      );
      return formatMoneyMinor(minor.toString(), displayFx.rate.quote);
    }
    return formatMoneyMinor(money.amountMinor.toString(), money.currency);
  };
  const priceDisplay = display(landing.product.price, false);
  const cashbackDisplay = display(landing.estimate.consumer.estimated, true);
  const merchant = MERCHANT_NAMES[landing.product.storeId] ?? landing.product.storeId;
  const attribution = landing.referrerFirstName
    ? t("shared.recommendsThis", { name: landing.referrerFirstName })
    : t("shared.sentYouLink");

  // The auth module under the product card: progress while a session is being established; the
  // redirect interstitial for a member (countdown + explicit continue, per the design handoff);
  // CTAs otherwise. The product content above is NEVER gated by any of this.
  const authModule =
    loading || verifying ? (
      <div className="flex items-center justify-center gap-2 py-2 text-[13.5px] text-muted">
        <Spinner />
        <span>{t("shared.signingIn")}</span>
      </div>
    ) : memberFlow ? (
      <div className="flex flex-col gap-2">
        <p className="text-center text-[13.5px] text-muted">
          {t("shared.redirectingStore", { merchant })}
        </p>
        {cashbackDisplay && (
          <p className="text-center text-[12.5px] font-semibold text-accent">
            {t("shared.earnOnThis", { amount: cashbackDisplay })}
          </p>
        )}
        {resolveState === "failed" ? (
          <Button onClick={() => setResolveState("idle")}>{t("shared.retry")}</Button>
        ) : (
          <Button disabled={!storeUrl} onClick={() => storeUrl && window.location.assign(storeUrl)}>
            {t("shared.continueToStore", { merchant })}
            {countdown !== null && countdown > 0 ? ` · ${countdown}` : ""}
          </Button>
        )}
      </div>
    ) : (
      <>
        <Button onClick={() => window.location.assign(`/auth?intent=signup&ref=${id}`)}>
          {t("shared.signupCta")}
        </Button>
        <Button variant="ghost" onClick={() => window.location.assign(`/auth?ref=${id}`)}>
          {t("shared.loginCta")}
        </Button>
        <p className="text-center text-[12px] text-muted">{t("shared.signupTrust")}</p>
      </>
    );

  return (
    <Screen>
      <div className="mx-auto flex w-full max-w-[440px] flex-col gap-4">
        <div className="text-center font-display text-[22px] font-bold tracking-[-0.03em]">
          wanthat
        </div>
        <div className="overflow-hidden rounded-[20px] border border-line bg-surface">
          {landing.product.imageUrl && (
            <img
              src={landing.product.imageUrl}
              alt={landing.product.title}
              className="aspect-[16/10] w-full bg-accent-soft object-cover"
            />
          )}
          <div className="flex flex-col gap-3 p-[18px]">
            <p className="text-[13px] text-muted">{attribution}</p>
            <h1 className="font-display text-[19px] font-semibold tracking-[-0.02em]">
              {landing.product.title}
            </h1>
            {priceDisplay && (
              <div className="flex items-baseline gap-2">
                <b className="text-[20px] tabular-nums" dir="ltr">
                  {priceDisplay}
                </b>
                <span className="text-[13px] text-muted">
                  {t("shared.onMerchant", { merchant })}
                </span>
              </div>
            )}
            {cashbackDisplay && (
              <div className="flex items-center justify-between rounded-[14px] border border-[#d2e3d9] bg-accent-soft px-3.5 py-3">
                <span className="text-[12.5px] font-semibold text-accent">
                  {t("shared.earnLabel")}
                </span>
                <span className="text-[22px] font-bold tabular-nums text-accent" dir="ltr">
                  {cashbackDisplay}
                </span>
              </div>
            )}
            {landing.review && <p className="text-[13.5px]">"{landing.review.text}"</p>}
            <p className="text-[13.5px] text-muted">{t("shared.pitch")}</p>
            {authModule}
          </div>
        </div>
        {!memberFlow && !loading && !verifying && (
          <div className="mt-2 flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={guestGo}
              disabled={guestState === "pending"}
              className="text-center text-[13px] text-muted hover:text-ink"
            >
              {guestState === "failed" ? t("shared.retry") : t("shared.guestCta")}
            </button>
            <p className="text-center text-[11px] text-muted">{t("shared.guestConsent")}</p>
          </div>
        )}
        {debug && (
          <pre className="mx-auto mt-3 w-full max-w-[440px] overflow-x-auto rounded-lg bg-ink p-3 text-[11px] text-white">
            {diag.length ? diag.join("\n") : "(no auth events yet)"}
          </pre>
        )}
      </div>
    </Screen>
  );
}
