/**
 * The derived conversions projection, applied (refactor PR-6). Every ledger-writer response
 * carries `conversionTotals` — the ABSOLUTE `count(DISTINCT order_id)` of `referrer_cashback`
 * rows per recommendation touched by that batch, computed from the ledger itself. This wrapper
 * applies them to the DynamoDB stat as idempotent SETs right after each successful invoke.
 *
 * Failures are logged and swallowed — deliberately non-fatal: absolute totals make the stat
 * self-healing (the next batch that touches the recommendation re-answers the full count and
 * the SET repairs any missed application), so a DynamoDB hiccup must never fail settlement or
 * re-drive the money path.
 */
import type { Logger } from "@aws-lambda-powertools/logger";
import type { WriteConversionsRequest, WriteConversionsResponse } from "@wanthat/contracts";
import type { RecommendationRepo } from "@wanthat/dynamo";

export type InvokeWriter = (req: WriteConversionsRequest) => Promise<WriteConversionsResponse>;

export interface ApplyTotalsDeps {
  recommendations: Pick<RecommendationRepo, "setConversions">;
  logger: Logger;
}

/** Wrap a writer invoke so every response's totals are applied before it returns. */
export function applyingConversionTotals(
  invoke: InvokeWriter,
  deps: ApplyTotalsDeps,
): InvokeWriter {
  return async (req) => {
    const res = await invoke(req);
    for (const [recommendationId, total] of Object.entries(res.conversionTotals)) {
      try {
        await deps.recommendations.setConversions(recommendationId, total);
      } catch (err) {
        deps.logger.error("conversions stat SET failed (self-heals next batch)", {
          recommendationId,
          total,
          error: String(err),
        });
      }
    }
    return res;
  };
}
