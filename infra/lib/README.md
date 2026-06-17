# infra/lib — CDK stacks

Stacks sliced per ADR-0005 (compute), ADR-0006 (data), ADR-0007 (DR). Dependency order:
`Network → Data → Identity → Api / Admin / EdgeServices → Edge → Observability`.

| Stack | Owns | ADR |
|---|---|---|
| `NetworkStack` | VPC, subnets, security groups (in-VPC Aurora) | 0006 |
| `DataStack` | Aurora Serverless v2 (scale-to-zero) + RDS Proxy; Firehose→S3 + Athena; Secrets Manager; per-function DB roles; PITR + cross-region backup | 0006, 0007, 0005 |
| `IdentityStack` | Cognito (native SMS OTP + passkeys, Essentials); Post-Confirmation provisioning trigger | 0004 |
| `ApiStack` | HTTP API + JWT authorizer; app-api Lambdalith; regional WAF + per-phone/IP rate limits; SMS kill-switch flag | 0005, 0004 |
| `AdminStack` | admin Lambda (own role/exposure) | 0005 |
| `EdgeServicesStack` | redirect Lambda; conversion poller + EventBridge Scheduler (configurable period) | 0001, 0002, 0003 |
| `EdgeStack` (**us-east-1**) | CloudFront + S3 static site + ACM cert + CloudFront WAF web ACL | — |
| `ObservabilityStack` | dashboards, alarms (SMS spend/rate, poll lag, redirect p95), CloudTrail alarm on the AE secret | 0004, 0005 |

Notes: the `EdgeStack` resources (ACM cert + CloudFront WAF) must live in **us-east-1** —
control-plane only; traffic still terminates at the edge near the user. Everything else is
in `il-central-1`.
