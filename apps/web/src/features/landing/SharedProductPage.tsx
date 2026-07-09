import { convertMinor } from "@wanthat/domain";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import { formatMoneyMinor } from "../../lib/money";
import { Button, Screen, Spinner } from "../../ui/components";
import {
  canLoginWithPasskey,
  hasStoredSession,
  loginWithPasskey,
  passkeysSupported,
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
 * snapshot (`LandingSnapshot`; the landing Lambda resolved the projection and server-rendered
 * the same card, so the React mount is visually seamless). MOCK: the store URL is still a
 * placeholder — the attributed resolve redirect lands with the next slice.
 */
const MOCK_STORE_URL = "https://www.aliexpress.com/";

const MERCHANT_NAMES: Record<string, string> = { aliexpress: "AliExpress" };

export function SharedProductPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const [searchParams] = useSearchParams();
  // A member is recognised by the session status (a valid Cognito refresh) — the profile comes free
  // with it (ID-token claims), so no backend is touched either way (ADR-0006).
  const { status, loading } = useSession();
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

  const toStore = () => window.location.assign(MOCK_STORE_URL);

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

  // A recognised (valid refresh) or just-authenticated member goes straight to the store — the
  // acquisition destination. No button, no interstitial, no backend. Never from a dead link.
  const signedIn = status === "signedIn" || authed;
  useEffect(() => {
    if (signedIn && ok) toStore();
  }, [signedIn, ok]);

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
    if (!canLoginWithPasskey()) {
      note("gate: no remembered phone → no prompt (ADR-0006: userless login waived)");
      return;
    }
    note("auto-prompt: armed — fires on document focus");
    void (async () => {
      try {
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
