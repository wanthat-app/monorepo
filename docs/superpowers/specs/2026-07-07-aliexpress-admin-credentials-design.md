# AliExpress credentials on the admin settings page — design

**Date:** 2026-07-07
**Status:** approved (Dennis)

> **Amendment (2026-07-07, after deploy):** the credential routes moved from admin-api to a
> separate **non-VPC `admin-credentials` function** on the same HTTP API/authorizer. admin-api
> runs in the endpoint-free VPC (ADR-0004; the Secrets Manager interface endpoint was removed in
> PR #92), so its SM calls timed out — Secrets Manager is only reachable over its public
> endpoint. This follows the same pattern as app-auth and retailer-proxy: components that touch
> Secrets Manager live outside the VPC. Sections below describing admin-api as the caller should
> be read as the admin-credentials function; everything else (contracts, write-only IAM, SPA)
> is unchanged.

## Problem

The retailer credential secret `wanthat/{env}/retailer/aliexpress` is populated
out-of-band today. Retailer credentials arrive on the retailer's schedule and must be
rotatable by an operator without a deploy. The admin needs a way to enter the AliExpress
**AppKey** and **AppSecret** from the admin settings page. The admin can **write** the
credentials but can never **read** them back.

## Decision

Write-only Secrets Manager endpoint in `admin-api` (Approach A). This implements the
already-recorded decision (2026-07-07): admin-api gets write-only `PutSecretValue` on the
retailer secret; retailer-proxy stays the sole reader; the value is never logged or echoed.

Rejected alternatives:

- **Runtime-config DynamoDB keys with redacted reads** — `GET /admin/config` echoes values,
  so write-only would need redaction special-cases throughout, and every function with
  table-read access could read the secret. Violates the requirement by construction.
- **One secret per field** — no benefit; retailer-proxy wants both values together.

## Contracts (`packages/contracts`)

New `retailer` area:

- `PutRetailerCredentialsBody = { appKey: string (trim, 1–200), appSecret: string (trim, 1–500) }`.
  Both fields are always required together: `PutSecretValue` replaces the whole secret
  value and write-only means no read-modify-write.
- `RetailerCredentialsStatus = { configured: boolean, lastUpdatedAt: ISO datetime | null }` —
  the only response shape for both routes. It has no field that could carry a credential.
- The body schema doubles as the secret's JSON shape (`{"appKey":"...","appSecret":"..."}`)
  so retailer-proxy parses the secret with the identical Zod schema when it is implemented.

## admin-api

New handler module (`retailer-credentials.ts`) behind the existing `requireAdmin` guard:

- `PUT /admin/retailer/aliexpress/credentials` — validate body, `PutSecretValue` with the
  JSON string, respond with the status object only. The request body is never logged and
  never echoed back, including in error paths (validation errors name the failing field,
  not its content).
- `GET /admin/retailer/aliexpress/credentials` — `DescribeSecret` (metadata only), returns
  `{ configured: true, lastUpdatedAt: LastChangedDate }`.

Known caveat (accepted): CDK created the secret with a generated placeholder value, so a
fresh environment reports "last written = deploy date" until the first real admin write.
After the first write the date is meaningful. Tracking a separate "written via admin"
marker was judged not worth the extra moving part.

## Infra

- Pass `retailerSecret` from `DataStack` into `AdminStack` (new additive cross-stack
  export; no export-ordering trap).
- Narrow inline policy on the admin function role: `secretsmanager:PutSecretValue` +
  `secretsmanager:DescribeSecret` on that one secret ARN. Deliberately not `grantWrite`
  (which also allows `UpdateSecret`).
- New env var `RETAILER_SECRET_ARN` on the admin function.
- No change to retailer-proxy's existing read grant.

## SPA (`apps/web`)

New **Integrations** section on the admin Configuration view, rendered as its own card,
deliberately outside the FieldMeta/dirty-batch machinery (these are not round-trippable
config values):

- Two password inputs (`autocomplete="new-password"`), values held only in local state.
- Save button enabled only when both fields are non-empty.
- Status line from the GET route: "Credentials set — last updated ⟨date⟩" / "Not configured".
- On successful save: clear both fields, refresh the status line.
- EN + HE strings.

## Error handling

- Validation failure → 400 naming the field, never its content.
- Secrets Manager failure → generic 5xx, no submitted values in the message.
- SPA shows a generic success/failure toast consistent with existing config saves.

## Testing

TDD. admin-api handler tests with a mocked Secrets Manager client covering: write path,
status path, validation rejects, and an assertion that responses never contain the
submitted values. Contract tests for the new schemas. Existing web typecheck/build and
`cdk synth` for the infra change.

## Delivery

One PR, one deployable slice: contracts + admin-api + infra + SPA.
