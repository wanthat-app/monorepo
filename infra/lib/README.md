# infra/lib — CDK stacks

Stacks sliced per ADR-0002 (compute), ADR-0003 (data), ADR-0004 (network), ADR-0005 (DR).
Dependency order: `Network → Data → Identity → Api / Admin / EdgeServices → Edge → Observability`.

> **Status (walking skeleton).** `Data`, `Identity`, `Api`, `Admin`, `EdgeServices`, and the
> us-east-1 `Edge` stack are implemented and deploy as `wanthat-{env}-*` (dev/prod, selected by
> `WANTHAT_ENV`; account resolved from the deploy credentials, not pinned in the repo). Deferred to
> later slices: **`NetworkStack` (the VPC) + the in-VPC placement of app-api/admin** — there's
> nothing in the VPC until Aurora, so the skeleton runs every Lambda outside a VPC; **Aurora +
> Firehose/Athena + cross-region backup** in `DataStack` (DynamoDB + Secrets only for now); and
> `ObservabilityStack`. The custom domain (ACM + Route 53 alias) is wired only in prod (`wanthat.app`);
> dev runs on the default `*.cloudfront.net` hostname. Service handlers return `501` until their
> feature slices land.

| Stack | Owns | ADR |
|---|---|---|
| `NetworkStack` | VPC, subnets, SGs scoped to Aurora + the in-VPC functions only; **no NAT Gateway** | 0004 |
| `DataStack` | Aurora Serverless v2 (scale-to-zero, **IAM auth, no RDS Proxy**) + per-function Postgres roles; **DynamoDB** (`short_id→url` projection + `guest_attribution`); Firehose→S3 + Athena; Secrets Manager; PITR + cross-region backup | 0003, 0005, 0002 |
| `IdentityStack` | Cognito (native SMS OTP + passkeys, Essentials); Post-Confirmation provisioning trigger | 0006 |
| `ApiStack` | HTTP API + JWT authorizer; app-api Lambdalith (**in-VPC**, IAM DB auth, reserved-concurrency cap); regional WAF + per-phone/IP rate limits; SMS kill-switch flag | 0002, 0006 |
| `AdminStack` | admin Lambda (**in-VPC**, own role/exposure) | 0002 |
| `EdgeServicesStack` | landing Lambda (**non-VPC** → DynamoDB); conversion poller as a **non-VPC fetcher + in-VPC writer**; retailer fetcher(s) (non-VPC, secret-scoped); EventBridge Scheduler (configurable period) | 0007, 0009, 0008, 0004 |
| `EdgeStack` (**us-east-1**) | One CloudFront distribution: **default → S3 SPA** (OAC, private), **`/p/*` → landing HTTP API** (cross-region origin); CloudFront WAF web ACL; ACM cert + Route 53 apex alias (prod). app-api/admin reached directly via Bearer, not fronted | 0019, 0016, 0007 |
| `ObservabilityStack` | dashboards, alarms (SMS spend/rate, poll lag, redirect p95), CloudTrail alarm on the retailer secret | 0006, 0002 |

Notes:
- **No NAT Gateway and no RDS Proxy** (ADR-0003/0004). The only functions in the VPC are the ones
  that touch Aurora (Lambdalith, admin, poller-writer); they reach DynamoDB via a free gateway
  endpoint and log out-of-band. The landing service and the retailer fetchers run outside the VPC, so nothing
  in-VPC needs internet egress; the IPv4-only retailer APIs are reached only from the non-VPC
  fetchers.
- The `EdgeStack` resources (ACM cert + CloudFront WAF) must live in **us-east-1** — control-plane
  only; traffic still terminates at the edge near the user. Everything else is `il-central-1`.
