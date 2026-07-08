import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import {
  deviceHasPasskey,
  loginWithPasskeyTokens,
  passkeyImmediateSupported,
  passkeysSupported,
} from "../../lib/passkey";
import { hasStoredSession, persistRefreshToken, useSession } from "../../lib/session";
import { Button, Screen, Spinner } from "../../ui/components";

/**
 * Referral landing (ADR-0007/0006) — the dynamic, SPA-rendered `/p/{id}` page. The landing SERVICE
 * server-renders only the OG tags + a content snapshot for bots; this page is what humans get.
 *
 * Design rule: CONTENT FIRST — the product card renders immediately and unconditionally; auth is a
 * small module under it and never gates rendering. The module walks the same states as /auth:
 *  - logged in (stored session) → "signing you in…" while rehydrating → auto-redirect to the store;
 *  - logged out + returning passkey device → the Face ID prompt is ARMED and fires when the document
 *    gains focus (iOS Safari rejects an unfocused get(); worst case it pops on the first tap) — the
 *    CTAs stay visible underneath; on success → auto-redirect;
 *  - logged out / unknown device → Sign up / Log in (→ /auth?ref, which redirects to the store after
 *    auth) + a direct guest link.
 * MOCK: hardcoded product + a placeholder store URL (the real resolve + attributed redirect land with
 * the full-landing slice). The auth is real.
 */
const PRODUCT = {
  title: "Jebao Smart Aquarium Fish Feeder",
  priceIls: "₪95.21",
  cashbackIls: "₪12.40",
  merchant: "AliExpress",
  image: "/product-feeder.jpg",
};
const MOCK_STORE_URL = "https://www.aliexpress.com/";

export function SharedProductPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const [searchParams] = useSearchParams();
  // Aurora-free by design (ADR-0007): a member is recognised by `tokens` (a valid Cognito refresh) —
  // never by the profile (`customer` needs /me → Aurora, which this page must not touch).
  const { tokens, loading } = useSession();
  // True from the moment the biometric succeeds until the verify round-trip lands — the module shows
  // "signing you in…" instead of looking hung.
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

  const toStore = () => window.location.assign(MOCK_STORE_URL);

  // A recognised (valid refresh) or just-authenticated member goes straight to the store — the
  // acquisition destination. No button, no interstitial, no Aurora.
  const signedIn = (!loading && !!tokens) || authed;
  useEffect(() => {
    if (signedIn) toStore();
  }, [signedIn]);

  // Arm the automatic passkey prompt when there is no session: immediate mode where supported
  // (zero-storage, fires on first interaction iff a passkey exists), else the per-device-flag modal
  // prompt that fires on document focus. Rendering is never blocked on it. The whole path is
  // Aurora-free: DynamoDB challenge + credential, Cognito token mint, done.
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
    void (async () => {
      // Immediate mode (Chrome 149+) is the zero-storage automatic path: fires on the first
      // interaction iff a locally-available passkey exists (even one synced from another device),
      // rejects silently otherwise. Elsewhere (Safari/Firefox) the per-device flag gates the
      // focus-armed modal prompt, so a brand-new visitor is never shown an unsatisfiable sheet.
      const immediate = await passkeyImmediateSupported();
      if (!immediate && !deviceHasPasskey()) {
        note("gate: immediateGet unsupported + not a returning device → no prompt");
        return;
      }
      note(
        immediate
          ? "auto-prompt: immediate mode — fires on first interaction if a passkey exists"
          : "auto-prompt: armed — fires on document focus",
      );
      try {
        const freshTokens = await loginWithPasskeyTokens({
          mode: immediate ? "immediate" : "modal",
          onCredential: () => {
            note("biometric ok → verifying");
            setVerifying(true);
          },
        });
        persistRefreshToken(freshTokens.refreshToken);
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

  // The auth module under the product card: progress while a session is being established; once
  // signed in, a "Go to store" button (the auto-redirect fires anyway — the button is the visible
  // affordance while it does, and the recovery if the member comes BACK from the store via bfcache).
  // CTAs otherwise. The product content above is NEVER gated by any of this.
  const authModule =
    loading || verifying ? (
      <div className="flex items-center justify-center gap-2 py-2 text-[13.5px] text-muted">
        <Spinner />
        <span>{t("shared.signingIn")}</span>
      </div>
    ) : signedIn ? (
      <Button onClick={toStore}>{t("shared.goToStore")}</Button>
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
          <img
            src={PRODUCT.image}
            alt={PRODUCT.title}
            className="aspect-[16/10] w-full bg-accent-soft object-cover"
          />
          <div className="flex flex-col gap-3 p-[18px]">
            <h1 className="font-display text-[19px] font-semibold tracking-[-0.02em]">
              {PRODUCT.title}
            </h1>
            <div className="flex items-baseline gap-2">
              <b className="text-[20px] tabular-nums" dir="ltr">
                {PRODUCT.priceIls}
              </b>
              <span className="text-[13px] text-muted">
                {t("shared.onMerchant", { merchant: PRODUCT.merchant })}
              </span>
            </div>
            <div className="flex items-center justify-between rounded-[14px] border border-[#d2e3d9] bg-accent-soft px-3.5 py-3">
              <span className="text-[12.5px] font-semibold text-accent">
                {t("shared.earnLabel")}
              </span>
              <span className="text-[22px] font-bold tabular-nums text-accent" dir="ltr">
                {PRODUCT.cashbackIls}
              </span>
            </div>
            <p className="text-[13.5px] text-muted">{t("shared.pitch")}</p>
            {authModule}
          </div>
        </div>
        {!signedIn && !loading && !verifying && (
          <button
            type="button"
            onClick={toStore}
            className="mt-2 text-center text-[13px] text-muted hover:text-ink"
          >
            {t("shared.guestCta")}
          </button>
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
