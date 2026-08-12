import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { AuditWriteRequest } from "@wanthat/contracts";
import {
  CustomerCounterRepo,
  getDocClient,
  OpsMetricsRepo,
  OtpSinkRepo,
  ProductRepo,
  RecommendationRepo,
  RuntimeConfigRepo,
  UnattributedOrderRepo,
} from "@wanthat/dynamo";
import { CognitoUserAdmin } from "./cognito-users";
import { RetailerSecretWriter } from "./retailer-secret";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

/**
 * Client-side ceiling on the synchronous audit-writer invoke, kept just UNDER admin-console's own
 * Lambda timeout (29s, `infra/lib/admin-stack.ts`). The budget is deliberately long enough to ride
 * out a scale-to-zero Aurora cold resume (~25s): the first config save after an idle period WAITS
 * for the append to land and succeeds, instead of aborting early into a 500. Only a resume that
 * overruns even this budget trips the abort — and then it surfaces as a caught, logged
 * `audit_append_failed` + 500 (never a silent `Status: timeout` kill). Warm appends are sub-second.
 */
const AUDIT_INVOKE_TIMEOUT_MS = 28_000;

export interface AdminConsoleContext {
  retailerSecret: RetailerSecretWriter;
  cognitoUsers: CognitoUserAdmin;
  /** Recommendation reads for stats/views; deletion keeps recommendations (ADR-0006 d8 amended). */
  recommendations: RecommendationRepo;
  /** The exact customer counter: delete decrements, suspend / lift move the disabled count. */
  customerCounter: CustomerCounterRepo;
  /** Read-only (stats): daily counters + presence items in OpsCounters (dashboard trends). */
  opsMetrics: OpsMetricsRepo;
  /** The runtime config table — this function is its SOLE writer. */
  config: RuntimeConfigRepo;
  /** Read-only (stats): the transactional product counter. */
  products: ProductRepo;
  /** The unattributed-order claim queue (list + claim/dismiss intents; the proxy settles). */
  unattributedOrders: UnattributedOrderRepo;
  /** Parked OTP codes (docs/otp-sink.md) — GET /admin/otp-sink; present in every env. */
  otpSink: OtpSinkRepo;
  /**
   * SYNCHRONOUS audit append via the in-VPC audit-writer Lambda (audit-or-fail): the promise
   * rejects when the invoke fails OR the writer itself threw (FunctionError), so the calling
   * route can fail loudly — a silently broken audit trail is worse than a retried save.
   */
  audit: { write(request: AuditWriteRequest): Promise<void> };
  /** SYNCHRONOUS on-demand FX refresh (POST /admin/fx-rates/refresh) — returns the run result. */
  fxRates: { refresh(): Promise<unknown> };
}

let cached: AdminConsoleContext | undefined;

/**
 * Per-container deps for admin-console (refactor PR-5): ALL admin actions + ALL Dynamo-backed
 * views, non-VPC — Cognito moderation, the write-only retailer-credential drop, runtime config
 * (sole writer), Dynamo stats/queues/sink, and synchronous Lambda invokes of audit-writer
 * (audit-or-fail) and fx-rates (on-demand refresh) by deterministic function name (ADR-0004:
 * no cross-stack refs). NO Aurora — the ledger reads live on the in-VPC admin-ledger-view.
 */
export function getContext(): AdminConsoleContext {
  if (cached) return cached;
  const region = process.env.AWS_REGION ?? "il-central-1";
  const doc = getDocClient(region);
  const lambda = new LambdaClient({ region });
  // RequestResponse (the default) — the caller must see the outcome. A handler exception
  // surfaces as FunctionError on a 200 invoke, so it is checked and thrown explicitly.
  //
  // `timeoutMs` bounds the wait with a client-side AbortSignal: without it, a callee that stalls
  // (e.g. the in-VPC audit-writer resuming a scale-to-zero Aurora, ~30s) would run past this
  // function's own Lambda timeout and be force-killed — no catch, no log, just `Status: timeout`.
  // A budget UNDER the Lambda timeout turns that stall into a catchable, logged rejection instead.
  const invokeSync = async (
    functionName: string,
    payload?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<unknown> => {
    const res = await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        ...(payload !== undefined ? { Payload: Buffer.from(JSON.stringify(payload)) } : {}),
      }),
      opts?.timeoutMs ? { abortSignal: AbortSignal.timeout(opts.timeoutMs) } : undefined,
    );
    if (res.FunctionError) {
      throw new Error(`invoke of ${functionName} failed: ${res.FunctionError}`);
    }
    return res.Payload?.length ? JSON.parse(Buffer.from(res.Payload).toString("utf8")) : undefined;
  };
  const auditWriterFn = requireEnv("AUDIT_WRITER_FUNCTION");
  const fxRatesFn = requireEnv("FX_RATES_FUNCTION");
  cached = {
    retailerSecret: new RetailerSecretWriter(
      new SecretsManagerClient({ region }),
      requireEnv("RETAILER_SECRET_ARN"),
    ),
    cognitoUsers: new CognitoUserAdmin(
      new CognitoIdentityProviderClient({ region }),
      requireEnv("CUSTOMER_USER_POOL_ID"),
    ),
    recommendations: new RecommendationRepo(doc, requireEnv("RECOMMENDATION_TABLE")),
    customerCounter: new CustomerCounterRepo(doc, requireEnv("OPS_COUNTERS_TABLE")),
    opsMetrics: new OpsMetricsRepo(doc, requireEnv("OPS_COUNTERS_TABLE")),
    config: new RuntimeConfigRepo(doc, requireEnv("RUNTIME_CONFIG_TABLE")),
    products: new ProductRepo(doc, requireEnv("PRODUCT_TABLE")),
    unattributedOrders: new UnattributedOrderRepo(doc, requireEnv("UNATTRIBUTED_ORDER_TABLE")),
    otpSink: new OtpSinkRepo(doc, requireEnv("OTP_SINK_TABLE")),
    audit: {
      write: async (request) => {
        await invokeSync(auditWriterFn, request, { timeoutMs: AUDIT_INVOKE_TIMEOUT_MS });
      },
    },
    fxRates: { refresh: () => invokeSync(fxRatesFn) },
  };
  return cached;
}
