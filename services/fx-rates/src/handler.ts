/**
 * FX rates updater (UC8 — FX rate update; ADR-0003, ADR-0017). Non-VPC (external HTTPS egress +
 * DynamoDB, no VPC). Triggered by EventBridge Scheduler on an admin-tunable period (CONFIG
 * `fx.updateIntervalMinutes`; admin-api applies it to the schedule), and on demand via
 * POST /admin/fx-rates/refresh.
 *
 * Per run (see {@link runFxUpdate}): pick the live provider (CONFIG `fx.provider`: `ecb` default |
 * `boi`), fetch each tracked pair (settlement → display, USD → ILS), and upsert the DynamoDB
 * `fx_rate` cache as an `ExchangeRate` (`@wanthat/contracts`). The pure `convertMinor`
 * (`@wanthat/domain`) reads that cache for the ILS display figure and the withdrawal conversion.
 * A failed provider fetch is last-known-good: the prior cached rate stays, the run does not throw.
 */
import { Logger } from "@aws-lambda-powertools/logger";
import { FxRateRepo, getDocClient, RuntimeConfigRepo } from "@wanthat/dynamo";
import { runFxUpdate } from "./run";

const SERVICE = "fx-rates";
const logger = new Logger({ serviceName: SERVICE });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export const handler = async () => {
  const doc = getDocClient(process.env.AWS_REGION);
  const config = new RuntimeConfigRepo(doc, requireEnv("RUNTIME_CONFIG_TABLE"));
  const fx = new FxRateRepo(doc, requireEnv("FX_RATE_TABLE"));

  const result = await runFxUpdate({
    config,
    fx,
    log: (msg, ctx) => logger.warn(msg, ctx ?? {}),
  });

  logger.info("fx_update_done", {
    provider: result.provider,
    updated: result.updated.length,
    failed: result.failed.length,
  });
  // `{ rates }` is RefreshFxRatesResponse-compatible for the admin on-demand refresh path.
  return { status: "ok" as const, ...result };
};
