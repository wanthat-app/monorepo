# infra/lib — CDK stacks

Stacks sliced per ADR-0002 (compute), ADR-0003 (data), ADR-0004 (network), ADR-0005 (DR).
Dependency order: `Network → Data → Identity → Api / Admin / EdgeServices → Edge → Observability`.

> **Status.** All of `Network`, `Data`, `Identity`, `Api`, `Admin`, `EdgeServices`, and the
> us-east-1 `Edge` stack are implemented and deploy as `wanthat-{env}-*` (dev/prod, selected by
> `WANTHAT_ENV`; account resolved from the deploy credentials, not pinned in the repo). The auth
> slice (UC1/UC2, ADR-0006) added **`NetworkStack` (the VPC) + Aurora Serverless v2** to `DataStack`
> and a one-shot in-VPC migration runner; `app-api`/`admin` move in-VPC with their auth backends.
> `ObservabilityStack` is now wired (starter scope; see its row). Still deferred: **Firehose/Athena +
> cross-region backup** in `DataStack`.
> The custom domain (ACM + Route 53 alias) is wired in both environments — the apex in prod
> (`wanthat.app`) and a subdomain in dev (`dev.wanthat.app`), both in the same `wanthat.app` zone. The
> SPA learns its backend URLs + Cognito client ids from a runtime `/config.json` the EdgeStack writes
> into the S3 bucket (no build-time env needed on the hosted site). Service handlers return `501` until
> their feature slices land.

| Stack | Owns | ADR |
|---|---|---|
| `NetworkStack` | VPC, subnets, SGs scoped to Aurora + the in-VPC functions only; **no NAT Gateway** | 0004 |
| `DataStack` | Aurora Serverless v2 (scale-to-zero, **IAM auth, no RDS Proxy**) + per-function Postgres roles; **DynamoDB** (`short_id→url` projection + `guest_attribution`); Firehose→S3 + Athena; Secrets Manager; PITR + cross-region backup | 0003, 0005, 0002 |
| `IdentityStack` | Cognito (native SMS OTP + passkeys, Essentials); Post-Confirmation provisioning trigger | 0006 |
| `ApiStack` | HTTP API + JWT authorizer; app-api Lambdalith (**in-VPC**, IAM DB auth, reserved-concurrency cap); regional WAF + per-phone/IP rate limits; SMS kill-switch flag | 0002, 0006 |
| `AdminStack` | admin Lambda (**in-VPC**, own role/exposure) | 0002 |
| `EdgeServicesStack` | landing Lambda (**non-VPC** → DynamoDB); conversion poller as a **non-VPC fetcher + in-VPC writer**; retailer fetcher(s) (non-VPC, secret-scoped); EventBridge Scheduler (configurable period) | 0007, 0009, 0008, 0004 |
| `EdgeStack` (**us-east-1**) | One CloudFront distribution: **default → S3 SPA** (OAC, private), **`/p/*` → landing HTTP API** (cross-region origin); CloudFront WAF web ACL; ACM cert + Route 53 alias (apex in prod, `dev.` subdomain in dev); runtime **`/config.json`** written into the SPA bucket (backend URLs + Cognito client ids, cross-region from il-central-1); **edge CloudWatch dashboard** (`wanthat-{env}-edge`: CloudFront requests/error-rate + WAF allowed/blocked, us-east-1). app-api/admin reached directly via Bearer, not fronted | 0019, 0016, 0007 |
| `ObservabilityStack` (**deploys last**) | SNS alarm topic (`wanthat-{env}-alarms`, optional email sub); alarms for SMS month-to-date spend (80% of the IdentityStack cap), per-Lambda errors, per-HTTP-API 5xx, Aurora connections (80% of the 50 cap); per-surface CloudWatch dashboard (API count/5xx/p95, Lambda errors/throttles/p95, Aurora ACU+connections, SMS spend vs cap). Also sets **X-Ray tracing + retention-bounded log groups** on every application Lambda (via `config.serviceLogGroup`). Follow-ups: CloudTrail alarm on retailer-secret reads (own issue — needs a single account-level trail, since dev/prod share one account), business/funnel metrics (needs the deferred Firehose/Athena). The CloudFront/WAF dashboard is on the `EdgeStack` (us-east-1) | 0006, 0002 |

Notes:
- **No NAT Gateway and no RDS Proxy** (ADR-0003/0004). The only functions in the VPC are the ones
  that touch Aurora (Lambdalith, admin, poller-writer); they reach DynamoDB via a free gateway
  endpoint and log out-of-band. The landing service and the retailer fetchers run outside the VPC, so nothing
  in-VPC needs internet egress; the IPv4-only retailer APIs are reached only from the non-VPC
  fetchers.
- The `EdgeStack` resources (ACM cert + CloudFront WAF) must live in **us-east-1** — control-plane
  only; traffic still terminates at the edge near the user. Everything else is `il-central-1`.

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
