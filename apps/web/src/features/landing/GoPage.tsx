import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import { useSession } from "../../lib/session";
import { Button, Card, Logo, Screen } from "../../ui/components";

/**
 * Mock store hand-off (ADR-0007/0024) — the "redirecting to store" step of the acquisition flow. The
 * referral landing (/p/{id}) sends members here after the real auth (`/auth?next=/go/{id}`), or guests
 * here directly. MOCK: there is no real affiliate redirect yet (that lands with the full-landing
 * slice); this confirms the outcome — cashback attributed for a member, none for a guest — and links
 * onward. The auth that precedes it is real.
 */
const MERCHANT = "AliExpress";
const PRODUCT = "Jebao Smart Aquarium Fish Feeder";
const MOCK_STORE_URL = "https://www.aliexpress.com/";

export function GoPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const { customer } = useSession();
  const isGuest = params.get("guest") === "1";
  const signedIn = !isGuest && !!customer;

  return (
    <Screen>
      <div className="flex flex-col items-center gap-2">
        <Logo />
      </div>
      <Card className="flex flex-col items-center gap-4 text-center">
        <div
          className={`flex h-20 w-20 items-center justify-center rounded-3xl ${
            signedIn ? "bg-accent-soft" : "bg-surface border border-line"
          }`}
        >
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke={signedIn ? "#1f7a57" : "#6b7b73"}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <title>{signedIn ? "Signed in" : "Store"}</title>
            {signedIn ? (
              <path d="M20 6 9 17l-5-5" />
            ) : (
              <>
                <path d="M3 9h18l-1.5 10.5a2 2 0 0 1-2 1.5H6.5a2 2 0 0 1-2-1.5L3 9Z" />
                <path d="M8 9V6a4 4 0 0 1 8 0v3" />
              </>
            )}
          </svg>
        </div>

        <div className="flex flex-col gap-1">
          <h1 className="text-[25px] tracking-[-0.02em]">
            {signedIn ? t("go.signedIn") : isGuest ? t("go.guestTitle") : t("go.redirecting")}
          </h1>
          <p className="text-[15px] leading-normal text-muted">
            {signedIn ? t("go.cashbackOn") : isGuest ? t("go.guestNote") : ""}
          </p>
        </div>

        <div className="w-full rounded-input border border-line bg-surface px-4 py-3 text-sm text-muted">
          {PRODUCT} · {MERCHANT}
        </div>

        <div className="flex w-full flex-col gap-2">
          <a
            className="block w-full rounded-input bg-accent px-4 py-3.5 text-center font-semibold text-white"
            href={MOCK_STORE_URL}
            rel="noopener noreferrer"
          >
            {t("go.continueToStore")}
          </a>
          {isGuest && (
            <Button variant="ghost" onClick={() => window.location.assign(`/auth?next=/go/${id}`)}>
              {t("go.signupInstead")}
            </Button>
          )}
        </div>
      </Card>
    </Screen>
  );
}
