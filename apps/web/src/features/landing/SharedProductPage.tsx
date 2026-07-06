import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
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
 * server-renders only the OG tags + a content snapshot for bots, then boots the SPA into this page,
 * which runs the SAME session + passkey mechanism as the rest of the app:
 *  - a returning member (stored session) is recognised → straight to the store, no re-auth;
 *  - a returning passkey device with no active session gets the AUTOMATIC Face ID prompt on load
 *    (the same `loginWithPasskey` auto-modal as `/auth`);
 *  - a new visitor sees the product + Sign up / Log in / Continue-as-guest.
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
  // `pending` = we're auto-attempting a passkey login (logged-out + passkey device) — hold the CTAs
  // behind a spinner until it resolves. When there IS a session, `loading` (rehydration) gates instead,
  // so `pending` must be false there or the spinner would never clear.
  const [pending, setPending] = useState(
    !hasStoredSession() && passkeysSupported() && deviceHasPasskey(),
  );
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

  // On load: a stored session rehydrates via useSession; a passkey device with no session gets the
  // auto Face ID prompt (same mechanism as /auth). The passkey ceremony is the first async op (Safari).
  useEffect(() => {
    if (armed.current) return;
    armed.current = true;
    if (hasStoredSession()) {
      note("gate: stored session → rehydrating, no prompt");
      return; // rehydrating → the session effect below forwards them
    }
    if (!passkeysSupported() || !deviceHasPasskey()) {
      note(
        `gate: webauthn=${passkeysSupported()} returningDevice=${deviceHasPasskey()} → no prompt`,
      );
      setPending(false);
      return;
    }
    note("auto-prompt: firing the passkey ceremony");
    void (async () => {
      try {
        const session = await loginWithPasskey(); // auto-modal Face ID on load
        markPasskeyDevice();
        signIn(session);
        toStore();
      } catch (err) {
        note(
          `auto-prompt failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
        );
        setPending(false); // cancelled / no passkey → fall back to the CTAs
      }
    })();
    // note/setDiag are stable enough for this once-guarded effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signIn]);

  const diagPanel = debug ? (
    <pre className="mx-auto mt-3 w-full max-w-[440px] overflow-x-auto rounded-lg bg-ink p-3 text-[11px] text-white">
      {diag.length ? diag.join("\n") : "(no auth events yet)"}
    </pre>
  ) : null;

  // A recognised (or just-authenticated) member → go straight to the store.
  const signedIn = !loading && !!customer;

  if (loading || pending) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-4">
        <Spinner />
        {diagPanel}
      </div>
    );
  }

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

            {signedIn ? (
              <>
                <Button onClick={toStore}>{t("shared.continueCta")}</Button>
                <p className="text-center text-[12px] text-muted">{t("shared.loggedInNote")}</p>
              </>
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
            )}
          </div>
        </div>
        {!signedIn && (
          <button
            type="button"
            onClick={toStore}
            className="mt-2 text-center text-[13px] text-muted hover:text-ink"
          >
            {t("shared.guestCta")}
          </button>
        )}
        {diagPanel}
      </div>
    </Screen>
  );
}
