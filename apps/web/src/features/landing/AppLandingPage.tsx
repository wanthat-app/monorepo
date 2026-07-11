import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  BalanceCard,
  Button,
  CartIcon,
  FeatureRow,
  Logo,
  Screen,
  ShareNodesIcon,
  ShieldIcon,
} from "../../ui";

// Illustrative "Sample" balance — cycles so no specific number reads as a promise
// (design: Wallet flow app-landing; amounts + 1.8s cadence from the mock).
const DEMO_AMOUNTS = ["₪142.50", "₪318.00", "₪64.20", "₪205.80", "₪89.40"];
const DEMO_CADENCE_MS = 1800;

/**
 * Logged-out app landing at `/` (design: Wallet flow "app-landing") — the pitch that sells
 * the sign-up: headline, illustrative sample balance, value props, then a single CTA into
 * the auth flow. Login and signup are one phone-first flow (ADR-0006), so the landing
 * doesn't split them.
 */
export function AppLandingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [demoIdx, setDemoIdx] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setDemoIdx((i) => i + 1), DEMO_CADENCE_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <Screen>
      <div className="flex flex-col">
        <div className="mb-6 mt-1">
          <Logo />
        </div>
        <h1 className="mb-3 text-[30px] font-bold leading-[1.14] tracking-[-0.03em]">
          {t("landing.headline")}
        </h1>
        <p className="mb-5 text-[15px] leading-normal text-secondary">{t("landing.sub")}</p>
        <BalanceCard
          label={t("landing.availableCashback")}
          chip={
            <span className="rounded-full bg-white/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.06em] text-onink-muted">
              {t("landing.sample")}
            </span>
          }
          amount={DEMO_AMOUNTS[demoIdx % DEMO_AMOUNTS.length]}
        />
        <p className="mb-5 mt-2 text-[11.5px] leading-snug text-placeholder">
          {t("landing.sampleNote")}
        </p>
        <div className="mb-7 flex flex-col gap-3.5">
          <FeatureRow
            icon={<CartIcon />}
            title={t("landing.earnEveryOrder")}
            subtitle={t("landing.earnEveryOrderSub")}
          />
          <FeatureRow
            icon={<ShareNodesIcon />}
            title={t("landing.earnFromLinks")}
            subtitle={t("landing.earnFromLinksSub")}
          />
          <FeatureRow
            icon={<ShieldIcon />}
            title={t("landing.secure")}
            subtitle={t("landing.secureSub")}
          />
        </div>
        <Button onClick={() => navigate("/auth")}>{t("landing.registerCta")}</Button>
      </div>
    </Screen>
  );
}
