import { useMutation } from "@tanstack/react-query";
import { convertMinor } from "@wanthat/domain";
import { type ClipboardEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  ApiError,
  type CashbackEstimateWire,
  type DisplayFxWire,
  linksApi,
  type MoneyWire,
  type ProductWire,
  type RecommendationWire,
} from "../../lib/api";
import { formatMoneyMinor } from "../../lib/money";
import { extractSupportedUrl } from "../../lib/product-url";
import { BackButton, Button } from "../../ui/components";
import { ProductCard, ShareLinkRow } from "../../ui/wallet";
import { useSession } from "../../user";

const LIGHTNING_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M13 2L4.5 12.5H11L10 22l8.5-10.5H12L13 2z" />
  </svg>
);
const CHECK_ICON = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20 6L9 17l-5-5" />
  </svg>
);
const SHARE_ICON = (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <path d="M8.6 13.5l6.9 4M15.5 6.5l-7 4" />
  </svg>
);
const FRIENDS_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9.5" cy="7.5" r="3.5" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M15.5 4.13a3.5 3.5 0 0 1 0 6.74" />
  </svg>
);

const RESOLVE_ERROR_KEYS: Record<string, string> = {
  unsupported_url: "create.unsupported",
  retailer_not_configured: "create.notConfigured",
  product_not_supported: "create.notSupported",
};

/** The share row shows the link without its protocol, like the design's `wnt.ht/…`. */
const displayLink = (shareUrl: string) => shareUrl.replace(/^https?:\/\//, "");

/**
 * Create-link flow (design handoff: Wallet flow, create + summary screens). Paste an AliExpress
 * product URL → the product is pulled (and its affiliate link minted server-side) → the link is
 * ready immediately on the summary screen, where the review is edited in place and the link is
 * copied/shared.
 */
export function CreateLinkPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { profile, loading: sessionLoading, accessToken } = useSession();
  const token = accessToken();

  const [url, setUrl] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<{
    product: ProductWire;
    estimate: CashbackEstimateWire;
    displayFx: DisplayFxWire | null;
  } | null>(null);
  const [recommendation, setRecommendation] = useState<RecommendationWire | null>(null);
  const [review, setReview] = useState("");
  const savedReview = useRef("");
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: (product: ProductWire) =>
      linksApi.createRecommendation(token as string, {
        storeId: product.storeId,
        storeProductId: product.storeProductId,
      }),
    onSuccess: (data) => setRecommendation(data.recommendation),
  });

  const resolve = useMutation({
    mutationFn: (pastedUrl: string) => linksApi.resolveProduct(token as string, pastedUrl),
    onSuccess: (data) => {
      setResolved(data);
      // The design's summary opens with "Your link is ready" — mint the recommendation
      // immediately (idempotent server-side); the review is attached afterwards via PATCH.
      create.mutate(data.product);
    },
    onError: (err) => {
      const key = err instanceof ApiError ? RESOLVE_ERROR_KEYS[err.code] : undefined;
      setInputError(t(key ?? "create.resolveFailed"));
    },
  });

  const saveReview = useMutation({
    mutationFn: (vars: { recommendationId: string; text: string }) =>
      linksApi.updateReview(
        token as string,
        vars.recommendationId,
        vars.text ? { text: vars.text } : null,
      ),
    onSuccess: (_data, vars) => {
      savedReview.current = vars.text;
    },
  });

  // Wait out the session rehydrate before deciding: a hard reload of /create must not bounce a
  // signed-in member to /auth (and lose this page) while the refresh-token exchange is in flight.
  if (sessionLoading) return null;
  if (!profile) {
    navigate("/auth", { replace: true });
    return null;
  }

  const startCreate = (text: string) => {
    if (resolve.isPending) return;
    setInputError(null);
    // The paste may be the whole share-button message — send the extracted URL, not the prose.
    const candidate = extractSupportedUrl(text);
    if (!candidate) {
      setInputError(t("create.unsupported"));
      return;
    }
    resolve.mutate(candidate);
  };

  // Auto-submit the moment a supported link lands in the field — whether pasted bare or inside
  // the share-button text (design: onPaste → startCreate).
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData("text").trim();
    const next = (url + pasted).trim();
    if (extractSupportedUrl(next)) {
      e.preventDefault();
      setUrl(next);
      startCreate(next);
    }
  };

  const persistReview = () => {
    const text = review.trim();
    if (!recommendation || text === savedReview.current) return;
    saveReview.mutate({ recommendationId: recommendation.recommendationId, text });
  };

  const copyLink = async () => {
    if (!recommendation) return;
    try {
      await navigator.clipboard.writeText(recommendation.shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions) — the visible URL remains selectable by hand.
    }
  };

  const shareLink = async () => {
    if (!recommendation) return;
    persistReview();
    if (navigator.share) {
      try {
        await navigator.share({ title: resolved?.product.title, url: recommendation.shareUrl });
      } catch {
        // Share sheet dismissed — nothing to do.
      }
    } else {
      await copyLink();
    }
  };

  const done = () => {
    persistReview();
    navigate("/home");
  };

  const isSummary = resolved !== null;
  // Prefer the recommendation's estimate: it reflects the SNAPSHOTTED split locked at the link's
  // original creation (a re-created link keeps its old economics — ADR-0008), while the resolve
  // estimate is current policy and can diverge after an admin rate change.
  const estimate = recommendation?.estimate ?? resolved?.estimate ?? null;
  const fx = resolved?.displayFx ?? null;

  // Display conversion (contracts DisplayFx): amounts arrive in the settlement currency (USD) and
  // are shown in ₪ when the cached rate covers them. Cashback figures carry the FX margin so the
  // shown amount matches what a withdrawal would actually yield; the product price converts at
  // the pure rate (it is information, not money we pay out). No rate → settlement currency as-is.
  const display = (money: MoneyWire | null | undefined, cashback: boolean): string | null => {
    if (!money) return null;
    if (fx && money.currency === fx.rate.base) {
      const minor = convertMinor(
        BigInt(money.amountMinor),
        fx.rate.rate,
        cashback ? fx.commissionBps : 0,
      );
      return formatMoneyMinor(minor.toString(), fx.rate.quote);
    }
    return formatMoneyMinor(money.amountMinor, money.currency);
  };
  const youEarn = display(estimate?.referrer.estimated, true);
  const theyEarn = display(estimate?.consumer.estimated, true);

  return (
    <div className="min-h-screen bg-page">
      <main className="mx-auto flex w-full max-w-[560px] flex-col gap-5 px-6 pb-16 pt-6">
        <div className="flex items-center gap-3">
          <BackButton
            onClick={() => (isSummary ? navigate("/home") : navigate(-1))}
            label={t("auth.back")}
          />
          <h1 className="font-display text-[22px] font-bold text-ink">
            {isSummary ? t("create.linkReady") : t("create.title")}
          </h1>
        </div>

        {!isSummary ? (
          <>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-secondary">
                {t("create.linkLabel")}
              </span>
              <textarea
                rows={3}
                dir="ltr"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setInputError(null);
                }}
                onPaste={onPaste}
                placeholder={t("create.pastePlaceholder")}
                disabled={resolve.isPending}
                className={`w-full resize-none rounded-field border bg-surface px-4 py-3 text-[15px] font-medium text-ink outline-none transition placeholder:text-placeholder focus:border-accent ${
                  inputError ? "border-rejected" : "border-edge"
                }`}
              />
              {inputError ? (
                <span className="mt-1 block text-sm text-rejected">{inputError}</span>
              ) : null}
            </label>

            <p className="flex items-center gap-2 text-[13px] text-muted">
              <span className="text-accent">{LIGHTNING_ICON}</span>
              {t("create.hint")}
            </p>

            <Button loading={resolve.isPending} onClick={() => startCreate(url)}>
              {resolve.isPending ? t("create.pulling") : t("create.cta")}
            </Button>
          </>
        ) : (
          <>
            <div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 text-[12.5px] font-bold text-accent">
                {CHECK_ICON}
                {t("create.detailsPulled")}
              </span>
            </div>

            <ProductCard
              src={resolved.product.imageUrl ?? undefined}
              title={resolved.product.title}
              price={display(resolved.product.price, false) ?? undefined}
              meta="AliExpress"
            />

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-card border border-line bg-surface px-4 py-3.5">
                <div className="text-[12.5px] font-semibold text-muted">
                  {t("create.youEarnSale")}
                </div>
                <div className="tabular mt-1 text-lg font-bold text-accent" dir="ltr">
                  {youEarn ?? "—"}
                </div>
              </div>
              <div className="rounded-card border border-line bg-surface px-4 py-3.5">
                <div className="text-[12.5px] font-semibold text-muted">{t("create.theyEarn")}</div>
                <div className="tabular mt-1 text-lg font-bold text-ink" dir="ltr">
                  {theyEarn ?? "—"}
                </div>
              </div>
            </div>

            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-secondary">
                {t("create.reviewLabel")}
              </span>
              <textarea
                rows={3}
                value={review}
                onChange={(e) => setReview(e.target.value)}
                onBlur={persistReview}
                maxLength={2000}
                placeholder={t("create.reviewPlaceholder")}
                className="w-full resize-none rounded-field border border-edge bg-surface px-4 py-3 text-[15px] font-medium text-ink outline-none transition placeholder:text-placeholder focus:border-accent"
              />
              <span className="mt-1 block text-[12.5px] text-muted">{t("create.reviewHint")}</span>
            </label>

            <p className="flex items-start gap-2 text-[13px] text-muted">
              <span className="mt-0.5 shrink-0 text-accent">{FRIENDS_ICON}</span>
              {youEarn
                ? t("create.shareManyNote", { amount: youEarn })
                : t("create.shareManyNoteNoAmount")}
            </p>

            {create.isError ? (
              <div className="flex flex-col items-center gap-2 rounded-card bg-surface p-4">
                <p className="text-sm text-rejected">{t("create.createFailed")}</p>
                <Button variant="ghost" onClick={() => create.mutate(resolved.product)}>
                  {t("home.retry")}
                </Button>
              </div>
            ) : (
              <>
                <ShareLinkRow
                  loading={!recommendation}
                  link={recommendation ? displayLink(recommendation.shareUrl) : undefined}
                  copyLabel={copied ? t("create.copied") : t("create.copy")}
                  onCopy={() => void copyLink()}
                />
                <Button disabled={!recommendation} onClick={() => void shareLink()}>
                  <span className="inline-flex items-center gap-2">
                    {SHARE_ICON}
                    {t("create.share")}
                  </span>
                </Button>
              </>
            )}

            <button
              type="button"
              onClick={done}
              className="py-1 text-center text-sm font-bold text-accent transition hover:opacity-80"
            >
              {t("create.done")}
            </button>
          </>
        )}
      </main>
    </div>
  );
}
