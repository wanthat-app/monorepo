# Region allow-list SCP (governance)

A Service Control Policy that **denies all AWS API calls outside the regions Wanthat uses**, to
shrink blast radius and enforce the single-region-active posture (ADR-0005). Out-of-band Org
governance — committed here for review/history; applied deliberately by an Org admin (see below).

## Allowed regions

| Region | Role |
|---|---|
| `il-central-1` (Tel Aviv) | **Primary / active** — almost everything runs here |
| `us-east-1` (N. Virginia) | **Mandatory** — CloudFront's ACM cert + CloudFront WAF web ACL must live here; also the home of several global-service control planes |
| `eu-central-1` (Frankfurt) | Cross-region **backups** (ADR-0005); lowest-latency EU region from IL |

Everything else is denied.

## Why the `NotAction` carve-outs

Global / partition-wide services don't honor `aws:RequestedRegion` the way regional services do —
their endpoints are global or anchored in `us-east-1`. Blocking them would break IAM, CloudFront,
Route 53, billing, etc. even though they aren't "in" a forbidden region. So they're exempted:
`iam`, `cloudfront`, `route53(+domains)`, `organizations`, `account`, `sts`, `support`,
`trustedadvisor`, `health`, `shield`, `waf` (classic global), `globalaccelerator`, and the
billing/cost family (`billing`, `budgets`, `ce`, `cur`, `pricing`, `aws-portal`, `aws-marketplace`,
`consolidatedbilling`, `tax`).

Note: **CloudFront's ACM cert and WAF need no carve-out beyond the region list** — they're created in
`us-east-1`, which is allowed. Regional WAF (`wafv2`) on the il-central-1 API is likewise covered by
the region list, so `wafv2` is intentionally **not** exempted (keeps the policy tight).

## Prerequisites & cautions

- **AWS Organizations with all features enabled.** SCPs are an Organizations feature.
- **SCPs never apply to the management (payer) account** — attach to an **OU or member account**.
  If `818913587533` is the management account, create/move workloads into a member account/OU and
  attach there.
- **SCPs only restrict; they never grant.** Identity/resource policies still apply on top.
- ⚠️ **A wrong SCP can lock you out.** Before attaching org-wide:
  1. Confirm nothing is running outside the three allowed regions (check each enabled region).
  2. Attach to a **non-prod OU / test account first** and verify deploys + console still work.
  3. Keep a break-glass path (the management account is unaffected, so you can always detach).
- Disabling *opt-in* regions in the console is complementary but **can't disable the ~17 legacy
  default regions** — this SCP is the durable guardrail that also covers those.

## Apply (Org admin, reviewed)

```bash
# 1. Create the policy
aws organizations create-policy \
  --name wanthat-region-allowlist \
  --type SERVICE_CONTROL_POLICY \
  --description "Deny AWS API calls outside il-central-1, eu-central-1, us-east-1 (ADR-0005)" \
  --content file://region-allowlist.json

# 2. Attach to the target OU or account (NOT the management account) — start non-prod
aws organizations attach-policy --policy-id <POLICY_ID> --target-id <OU_OR_ACCOUNT_ID>

# Detach if needed:
# aws organizations detach-policy --policy-id <POLICY_ID> --target-id <OU_OR_ACCOUNT_ID>
```

## Verify after attaching

```bash
# Allowed region — should succeed:
aws ec2 describe-availability-zones --region il-central-1 >/dev/null && echo OK
# Forbidden region — should be AccessDenied (explicit deny by SCP):
aws ec2 describe-availability-zones --region ap-south-1 || echo "denied (expected)"
```
