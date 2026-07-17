# infra/lib — CDK stacks

Stacks sliced per ADR-0002 (compute), ADR-0003 (data), ADR-0004 (network), ADR-0005 (DR).
Dependency order: `Network → Data → Identity → Api / Admin / EdgeServices / WhatsApp → Edge →
Observability` (+ a prod-only `Dns` stack). The consolidated overview with the full diagram is
[`docs/AWS_Architecture.md`](../../docs/AWS_Architecture.md).

> **Status (2026-07-14).** Every stack below is deployed and current in **dev and prod**
> (`wanthat-{env}-*`, selected by `WANTHAT_ENV`; account resolved from the deploy credentials,
> not pinned in the repo). The create-link, landing `/p/`, conversion, wallet, and admin
> slices are **live** — the retailer-linkgen/settlement pair speaks to the real AliExpress API and the order
> poll heartbeat is enabled in every env. Funnel analytics (Firehose → S3 → Glue/Athena) is
> live via the `FunnelAnalytics` construct in `ObservabilityStack`. Still deferred:
> **cross-region backup** (ADR-0005). The custom domain (ACM + Route 53 alias) serves the
> apex in prod (`wanthat.app`) and `dev.wanthat.app` in dev; the SPA learns its backend URLs +
> Cognito client ids from a runtime `/config.json` the EdgeStack writes into the S3 bucket.

| Stack | Owns | ADR |
|---|---|---|
| `NetworkStack` | VPC (2 AZs, isolated subnets, **no NAT**), SGs scoped Lambda→Aurora:5432, free DynamoDB gateway endpoint; **zero interface endpoints** | 0004 |
| `DataStack` | Aurora Serverless v2 (PG 16.13, 0–2 ACU, **IAM auth, no RDS Proxy**, `max_connections=50`) + per-function Postgres roles (`wallet_reader`, `ledger_reader`, `ledger_writer`, `audit_writer`, `wanthat_migrator` — created by the **role-bootstrap** deploy Trigger, which also retired the legacy `app_rw`/`app_ro`/`poller_writer`); the in-VPC **db-migrator** + deploy Trigger; **all 9 DynamoDB tables** (product, recommendation, guest_attribution, poller_state, unattributed_order, runtime_config, ops_counters, fx_rate, otp_sink); the retailer secret (sole readers: retailer-linkgen + retailer-settlement) | 0003, 0005, 0002 |
| `IdentityStack` | Cognito **customer pool** (ESSENTIALS, phone+email aliases, SMS-OTP + native passkeys via `USER_AUTH`, PII in attributes) + **employee pool** (email + mandatory TOTP, Managed Login + PKCE, branded); `otp-sender` (custom SMS sender, KMS key) + `post-confirmation` triggers; **REGIONAL WAF on the customer pool** (rate-limits the unauth Cognito ops); SNS monthly SMS spend cap (account-wide, $1 while in the SMS sandbox) | 0006, 0019 |
| `ApiStack` | App HTTP API + customer-pool JWT authorizer; **member-catalog** (non-VPC: products.resolve, recommendations, invokes retailer-linkgen) + **member-wallet** (in-VPC: wallet + activity, Aurora as `wallet_reader`); throttling on `$default` | 0002, 0006 |
| `AdminStack` | Admin HTTP API + employee-pool JWT authorizer; **admin-console** (non-VPC: all admin actions + Dynamo views — Cognito moderation, retailer-secret drop (write-only), sole runtime_config writer) + **admin-ledger-view** (in-VPC: money stats + audit feed, Aurora as `ledger_reader`) + **audit-writer** (in-VPC: the one generic audit_log append path, `audit_writer`) | 0002, 0006 |
| `EdgeServicesStack` | Landing HTTP API (public) + **landing** (non-VPC: OG shell + attributed redirect); **retailer-linkgen** (non-VPC, sync link minter) + **retailer-settlement** (non-VPC, order-poll fetcher + claim settlement) → **ledger-writer** (in-VPC writer, `ledger_writer` — the only money writer); **fx-rates**; EventBridge schedules `OrderPollHeartbeat` (15 min) + `FxRatesSchedule` (12 h) | 0007, 0009, 0008, 0004, 0017 |
| `WhatsAppStack` | **notification-sender**, async-invoked directly by producers with the full payload (the outbox table + stream are gone; 2 retries → SQS DLQ via the on-failure destination); sends via End User Messaging Social (`eu-central-1`), kill-switched | 0019 |
| `EdgeStack` (**us-east-1**) | One CloudFront distribution: **default → S3 SPA** (OAC, private, 403/404 → index.html), **`/p/*` → landing HTTP API** (cross-region origin, caching disabled); CLOUDFRONT WAF web ACL; ACM cert + Route 53 alias; runtime **`/config.json`** into the SPA bucket; edge CloudWatch dashboard (`wanthat-{env}-edge`). app/admin APIs reached directly via Bearer, not fronted | 0019, 0016, 0007 |
| `ObservabilityStack` (**deploys last**) | SNS alarm topic (email subs); alarms: per-Lambda errors, per-HTTP-API 5xx, Aurora connections (80% of the 50 cap), SMS month-to-date spend (80% of cap); per-surface CloudWatch dashboard; X-Ray + retention-bounded log groups on every Lambda; **FunnelAnalytics** — CloudWatch Logs subscription filters (landing, retailer-settlement, ledger-writer) → Firehose `wanthat-{env}-funnel` → S3 → Glue `wanthat_{env}_analytics.funnel_events` (Athena, partition projection). Follow-up: CloudTrail alarm on retailer-secret reads (needs one account-level trail — dev/prod share an account) | 0006, 0002 |
| `DnsStack` (**prod only**) | Zoho mail records in the `wanthat.app` zone (MX, SPF, DKIM, DMARC, verification TXT) | — |

Notes:
- **No NAT Gateway and no RDS Proxy** (ADR-0003/0004). The only functions in the VPC are the
  functions that touch Aurora (`member-wallet`, `admin-ledger-view`, `audit-writer`,
  `ledger-writer`, `db-migrator`, `role-bootstrap`); they reach DynamoDB via the free gateway
  endpoint. Everything else — landing, member-catalog, admin-console, retailer-linkgen,
  retailer-settlement, fx-rates, otp-sender, post-confirmation, notification-sender — runs
  outside the VPC, so nothing in-VPC needs internet egress; the IPv4-only retailer APIs are
  reached only from the retailer-linkgen/settlement pair. In-VPC functions cannot invoke
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

## Postgres service-role creation (R1, AUTOMATED) and legacy-role retirement (R2, AUTOMATED)

The db-migrator runs as `wanthat_migrator`, which deliberately has **no CREATEROLE** — a
`CREATE ROLE` inside a migration fails the deploy; role creation (and destruction) is a
master-only capability.
**R1 is automated**: the `role-bootstrap` deploy Trigger (DataStack) runs as master on every
deploy, BEFORE the migrator — connecting via **IAM token auth as `wanthat_master`** (no
password, no Secrets Manager: 0003 made master a member of `wanthat_migrator`, which holds
`rds_iam`, and RDS routes any — even transitive — rds_iam member through IAM/PAM auth; this
also means master PASSWORD login is disabled cluster-wide) and executes `runRoleBootstrap`
(`packages/db/src/role-bootstrap.ts`):
create-if-missing the four service roles + `GRANT rds_iam` + `GRANT USAGE ON SCHEMA public`,
idempotently. Migration `0008_service_role_grants.sql` then GRANTs table privileges on roles
the bootstrap guarantees exist. No operator steps in either env.

The bootstrap is **permanent infrastructure**, not refactor scaffolding: it is also the
fresh-env R1 mechanism (a new environment has no service roles until it runs), so it is never
removed.

**R1 psql equivalent — DISASTER-RECOVERY REFERENCE ONLY (what the bootstrap executes):**

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wallet_reader') THEN CREATE ROLE wallet_reader LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ledger_reader') THEN CREATE ROLE ledger_reader LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ledger_writer') THEN CREATE ROLE ledger_writer LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_writer')  THEN CREATE ROLE audit_writer  LOGIN; END IF;
END $$;
GRANT rds_iam TO wallet_reader, ledger_reader, ledger_writer, audit_writer;
-- Master (not the migrator) owns schema public - USAGE must be granted here, not in a migration.
GRANT USAGE ON SCHEMA public TO wallet_reader, ledger_reader, ledger_writer, audit_writer;
```

Never `ALTER ROLE ... RENAME` an in-use role — IAM database auth binds tokens to the role name
(`rds-db:connect` ARNs embed it), so a rename breaks every connected function mid-flight. The
rename path is always: create new role (R1) → migration GRANTs → CDK flips `grantConnect` +
`DB_USER` → cleanup migration REVOKEs → drop old role (R2).

**R2 — drop the legacy roles (refactor PR-8): also automated** — `runRoleBootstrap` ends
with an idempotent retirement step (same master-only code path): per legacy role
(`app_rw` / `app_ro` / `poller_writer`), guarded on `pg_roles` existence so fresh envs and
re-runs no-op, it REVOKEs everything master can revoke, clears stray grants with
`DROP OWNED`, then `DROP ROLE`. Migration `0010_drop_admin_audit_wrapper.sql` separately
drops the retired `admin_audit_config_change` SQL wrapper (audit shaping moved into the
audit-writer service). psql equivalent, for reference:

```sql
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_rw;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app_rw;
    REVOKE EXECUTE ON FUNCTION audit_append(jsonb, timestamptz) FROM app_rw;
    REVOKE USAGE ON SCHEMA public FROM app_rw;
    GRANT app_rw TO CURRENT_USER; -- DROP OWNED needs membership; master holds ADMIN OPTION
    DROP OWNED BY app_rw;         -- clears stray grants (e.g. 0007's wrapper EXECUTE)
    DROP ROLE app_rw;
  END IF;
END $$;
-- ... same block for app_ro and poller_writer
```

**Retailer secret rotation is NOT a runbook** — it stays an admin-panel feature (write-only
`PutSecretValue` from the admin surface; the console can rotate credentials without AWS access,
deliberately, so a non-technical operator can manage retailer keys). The planned CloudTrail
alarm on secret operations covers both the panel writes and the two runtime readers.
