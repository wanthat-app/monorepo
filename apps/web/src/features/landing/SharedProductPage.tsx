import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import { warmDb } from "../../lib/api";
import {
  deviceHasPasskey,
  loginWithPasskey,
  markPasskeyDevice,
  passkeysSupported,
} from "../../lib/passkey";
import { hasStoredSession, useSession } from "../../lib/session";
import { Button, Screen, Spinner } from "../../ui/components";

/**
 * Referral landing (ADR-0007/0024) — the dynamic, SPA-rendered `/p/{id}` page. The landing SERVICE
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
  const { customer, loading, signIn } = useSession();
  // True from the moment the biometric succeeds until the session resolves (verify + /auth/session can
  // ride a cold-Aurora resume) — the module shows "signing you in…" instead of looking hung.
  const [verifying, setVerifying] = useState(false);
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

  // A recognised (or just-authenticated) member goes straight to the store — the acquisition
  // destination. No button, no interstitial.
  const signedIn = !loading && !!customer;
  useEffect(() => {
    if (signedIn) toStore();
  }, [signedIn]);

  // Arm the auto passkey prompt for a returning device with no session. It fires when the document
  // gains focus (not on a timer — see waitForDocumentFocus); rendering is never blocked on it.
  useEffect(() => {
    if (armed.current) return;
    armed.current = true;
    // Kick the Aurora resume NOW (fire-and-forget, not awaited — the ceremony must stay the first
    // AWAITED async op): by the time Face ID completes, the DB is warm(ing) for the session resolve.
    warmDb();
    if (hasStoredSession()) {
      note("gate: stored session → rehydrating, no prompt");
      return; // the session effect above redirects once rehydration lands
    }
    if (!passkeysSupported() || !deviceHasPasskey()) {
      note(
        `gate: webauthn=${passkeysSupported()} returningDevice=${deviceHasPasskey()} → no prompt`,
      );
      return;
    }
    note("auto-prompt: armed — fires on document focus");
    void (async () => {
      try {
        const session = await loginWithPasskey({
          onCredential: () => {
            note("biometric ok → resolving session");
            setVerifying(true);
          },
        });
        markPasskeyDevice();
        signIn(session); // → signedIn → the redirect effect above
      } catch (err) {
        note(
          `auto-prompt failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
        );
        setVerifying(false); // the CTAs are already on screen — nothing else to do
      }
    })();
    // note/setDiag are stable enough for this once-guarded effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signIn]);

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
