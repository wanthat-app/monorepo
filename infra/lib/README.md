# infra/lib — CDK stacks

Stacks sliced per ADR-0002 (compute), ADR-0003 (data), ADR-0004 (network), ADR-0005 (DR).
Dependency order: `Network → Data → Identity → Api / Admin / EdgeServices / WhatsApp → Edge →
Observability` (+ a prod-only `Dns` stack). The consolidated overview with the full diagram is
[`docs/AWS_Architecture.md`](../../docs/AWS_Architecture.md).

> **Status (2026-07-14).** Every stack below is deployed and current in **dev and prod**
> (`wanthat-{env}-*`, selected by `WANTHAT_ENV`; account resolved from the deploy credentials,
> not pinned in the repo). The create-link, landing `/p/`, conversion, wallet, and admin
> slices are **live** — the retailer-proxy speaks to the real AliExpress API and the order
> poll heartbeat is enabled in every env. Funnel analytics (Firehose → S3 → Glue/Athena) is
> live via the `FunnelAnalytics` construct in `ObservabilityStack`. Still deferred:
> **cross-region backup** (ADR-0005). The custom domain (ACM + Route 53 alias) serves the
> apex in prod (`wanthat.app`) and `dev.wanthat.app` in dev; the SPA learns its backend URLs +
> Cognito client ids from a runtime `/config.json` the EdgeStack writes into the S3 bucket.

| Stack | Owns | ADR |
|---|---|---|
| `NetworkStack` | VPC (2 AZs, isolated subnets, **no NAT**), SGs scoped Lambda→Aurora:5432, free DynamoDB gateway endpoint; **zero interface endpoints** | 0004 |
| `DataStack` | Aurora Serverless v2 (PG 16.13, 0–2 ACU, **IAM auth, no RDS Proxy**, `max_connections=50`) + per-function Postgres roles (`app_rw`, `app_ro`, `poller_writer`, `wanthat_migrator`); the in-VPC **db-migrator** + deploy Trigger; **all 10 DynamoDB tables** (product, recommendation, guest_attribution, poller_state, unattributed_order, runtime_config, ops_counters, fx_rate, notification_outbox, otp_sink); the retailer secret (sole reader: retailer-proxy) | 0003, 0005, 0002 |
| `IdentityStack` | Cognito **customer pool** (ESSENTIALS, phone+email aliases, SMS-OTP + native passkeys via `USER_AUTH`, PII in attributes) + **employee pool** (email + mandatory TOTP, Managed Login + PKCE, branded); `message-sender` (custom SMS sender, KMS key) + `post-confirmation` triggers; **REGIONAL WAF on the customer pool** (rate-limits the unauth Cognito ops); SNS monthly SMS spend cap (account-wide, $1 while in the SMS sandbox) | 0006, 0019 |
| `ApiStack` | App HTTP API + customer-pool JWT authorizer; **app-links** (non-VPC: products.resolve, recommendations, invokes retailer-proxy) + **app-core** (in-VPC: wallet + activity, Aurora as `app_rw`); throttling on `$default` | 0002, 0006 |
| `AdminStack` | Admin HTTP API + employee-pool JWT authorizer; **admin-api** (in-VPC: stats/config/orders, Aurora as `app_ro`, sole runtime_config writer) + **admin-credentials** (non-VPC: Cognito user moderation, retailer-secret rotation — write-only) | 0002, 0006 |
| `EdgeServicesStack` | Landing HTTP API (public) + **landing** (non-VPC: OG shell + attributed redirect); **retailer-proxy** (non-VPC, sole retailer egress + order-poll fetcher) → **conversion-poller** (in-VPC writer, `poller_writer` — the only money writer); **fx-rates**; EventBridge schedules `OrderPollHeartbeat` (15 min) + `FxRatesSchedule` (12 h) | 0007, 0009, 0008, 0004, 0017 |
| `WhatsAppStack` | **whatsapp-dispatcher** consuming the notification_outbox DynamoDB stream (batch 10, retries + bisect, SQS DLQ); sends via End User Messaging Social (`eu-central-1`), kill-switched | 0019 |
| `EdgeStack` (**us-east-1**) | One CloudFront distribution: **default → S3 SPA** (OAC, private, 403/404 → index.html), **`/p/*` → landing HTTP API** (cross-region origin, caching disabled); CLOUDFRONT WAF web ACL; ACM cert + Route 53 alias; runtime **`/config.json`** into the SPA bucket; edge CloudWatch dashboard (`wanthat-{env}-edge`). app/admin APIs reached directly via Bearer, not fronted | 0019, 0016, 0007 |
| `ObservabilityStack` (**deploys last**) | SNS alarm topic (email subs); alarms: per-Lambda errors, per-HTTP-API 5xx, Aurora connections (80% of the 50 cap), SMS month-to-date spend (80% of cap); per-surface CloudWatch dashboard; X-Ray + retention-bounded log groups on every Lambda; **FunnelAnalytics** — CloudWatch Logs subscription filters (landing, retailer-proxy, conversion-poller) → Firehose `wanthat-{env}-funnel` → S3 → Glue `wanthat_{env}_analytics.funnel_events` (Athena, partition projection). Follow-up: CloudTrail alarm on retailer-secret reads (needs one account-level trail — dev/prod share an account) | 0006, 0002 |
| `DnsStack` (**prod only**) | Zoho mail records in the `wanthat.app` zone (MX, SPF, DKIM, DMARC, verification TXT) | — |

Notes:
- **No NAT Gateway and no RDS Proxy** (ADR-0003/0004). The only functions in the VPC are the
  four that touch Aurora (`app-core`, `admin-api`, `conversion-poller`, `db-migrator`); they
  reach DynamoDB via the free gateway endpoint. Everything else — landing, app-links,
  admin-credentials, retailer-proxy, fx-rates, message-sender, post-confirmation,
  whatsapp-dispatcher — runs outside the VPC, so nothing in-VPC needs internet egress; the
  IPv4-only retailer APIs are reached only from retailer-proxy. In-VPC functions cannot invoke
  outward: the conversion chain is always proxy → writer.
- The `EdgeStack` resources (ACM cert + CloudFront WAF) must live in **us-east-1** —
  control-plane only; traffic still terminates at the edge near the user. WhatsApp sends go
  through **eu-central-1** (End User Messaging Social is not in il-central-1). Everything
  else is `il-central-1`.
- **No reserved concurrency anywhere** — the account limit (10) is the cap until the quota
  is raised; re-introduce per-function caps after that.

## Runbook — first-admin bootstrap (employee pool)

The admin surface authenticates against the **employee** Cognito pool (ADR-0006 §two-pool, decision
6), which has **no self-signup** — staff are provisioned, never registered. The very first admin is
created out-of-band by an operator; everyone after that can be added the same way (or, later, from
the console). This is the only manual identity step, and every command below is CloudTrail-audited.

Take the employee pool id from the `IdentityStack` output `EmployeePoolIdOut` (`aws cloudformation
describe-stacks --stack-name wanthat-<env>-identity`), then, for each new admin:

```bash
# 1. Create the employee (no password — Cognito emails a one-time temporary password).
aws cognito-idp admin-create-user \
  --user-pool-id <employeePoolId> \
  --username <email> \
  --user-attributes Name=email,Value=<email> Name=email_verified,Value=true

# 2. Put them in the `admin` group (the claim the admin-api authorizer + in-handler guard check).
aws cognito-idp admin-add-user-to-group \
  --user-pool-id <employeePoolId> \
  --group-name admin \
  --username <email>
```

On first sign-in through the admin hosted UI (`AdminLoginBaseUrl`, reached via the SPA `/admin`
route), the employee sets a permanent password and **enrols a TOTP authenticator** (MFA is mandatory
on this pool). No further out-of-band steps; routine config/stats are managed in the console.
