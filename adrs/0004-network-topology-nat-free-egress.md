# ADR 0004 — Network topology: NAT-free egress via non-VPC chaining

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0002](0002-app-compute-topology.md) (compute), [ADR-0003](0003-datastore-aurora-and-dynamodb.md) (datastore), [ADR-0009](0009-conversion-ingestion-poller.md) (poller)
- **Refined by:** [ADR-0006](0006-cognito-native-auth-and-pii.md) (auth is browser-to-Cognito; the app edge keeps only the `links` module)

## Context

PII and the ledger live in in-VPC Aurora (ADR-0003), and the only thing that pins a function to
the VPC is Aurora access — the high-volume redirect read is served from DynamoDB. Two forces
shape the network:

1. **The system must reach IPv4-only third-party retailer APIs** (AliExpress `api-sg`, and the
   first-candidate set Amazon / Shein / Temu / iHerb / Banggood). A third-party HTTPS endpoint
   has no PrivateLink path — only internet egress reaches it.
2. A managed **NAT Gateway (~$33/mo + data)** would otherwise be the single largest fixed cost
   in the MVP and the main thing fighting the near-zero-idle goal.

**IPv6 egress is not an option.** An egress-only internet gateway is free, but only reaches
IPv6 destinations, and every retailer **API** host is IPv4-only (DNS-verified):

| Host | Role | AAAA? |
|---|---|---|
| `api-sg.aliexpress.com` | AliExpress affiliate API | No (Alibaba GDS) |
| `webservices.amazon.com`, `sellingpartnerapi-na.amazon.com` | Amazon PA-API / SP-API | No |
| `api-service.shein.com` | Shein | No (Akamai) |
| `temu.com` | Temu | No |
| `iherb.com` | iHerb | No (Cloudflare) |
| `api.banggood.com` | Banggood | No (Akamai) |
| `www.amazon.com` | Amazon *storefront* (not an API) | yes — irrelevant |

Reaching an IPv4-only host from IPv6 needs NAT64, which is a paid NAT Gateway feature.

## Decision

**Only Aurora and the functions that read/write it live in the VPC. Everything else runs
outside it. Retailer egress happens only from non-VPC functions. No NAT Gateway.**

### Function placement

| Function | In VPC? | Reaches | Internet egress |
|---|---|---|---|
| Landing | No | DynamoDB (`recommendation_id→url`) | none |
| App edge (`app-links`, the `links` module — ADR-0006) | No | DynamoDB, Retailer Proxy (Invoke) | none |
| Core / admin (`app-core`, `admin-api`) | Yes | Aurora, DynamoDB (gateway endpoint) | none |
| **Retailer Proxy** | No | retailer API, Secrets Mgr, DynamoDB | yes (direct) |
| Poller **writer** | Yes | Aurora only | none |

### Non-VPC chaining

Retailer calls are made only by the single non-VPC **Retailer Proxy** (ADR-0002) — it holds the
secret-scoped credential and runs the HMAC-signing client. In-VPC functions never have internet
egress and never hold the retailer secret. Invoke direction exploits an asymmetry — a non-VPC
Lambda can invoke any Lambda freely (control-plane Invoke), but an in-VPC Lambda without NAT
cannot reach the Invoke API without a paid interface endpoint:

- **Poll flow** — `EventBridge Scheduler → Retailer Proxy.listOrders` (calls retailer, resolves
  `guest_attribution` in DynamoDB) `→ invokes in-VPC writer` (Aurora ledger + audit). The
  non-VPC side initiates → **no interface endpoint, $0**.
- **Link generation** — touches **no Aurora** (products + recommendations are DynamoDB, ADR-0003),
  so the `links` module runs on the **non-VPC app edge** (`app-links`, ADR-0006's
  non-VPC half) and invokes `Retailer Proxy.generateLink` **synchronously** (the user waits for
  the affiliate URL) as a free non-VPC→Lambda call — **no interface endpoint, $0**, the same
  asymmetry the poll flow uses. The proxy mints/reuses the product-level affiliate URL and
  upserts the **Product** in DynamoDB; the caller then writes the member's **Recommendation**.
  The retailer credential still never leaves the proxy, and the JWT-authorized route stays on
  the app HTTP API rather than exposing the proxy itself.

### In-VPC connectivity

In-VPC functions reach **Aurora via IAM auth** and **DynamoDB via the free gateway endpoint**.
Lambda delivers stdout/stderr to CloudWatch **out-of-band** (not over the VPC ENI), so an in-VPC
function with zero internet still logs normally. Net: no NAT and no interface endpoint.

## Alternatives considered

- **Managed NAT Gateway** — ~$33/mo standing, the largest MVP fixed cost; unnecessary once only
  non-VPC functions need the internet.
- **VPC interface-endpoint mesh** — more expensive than a NAT for the AWS services, and still
  can't reach third-party retailers.
- **IPv6 + egress-only internet gateway** — free, but retailers are IPv4-only; NAT64 would
  reintroduce a paid NAT Gateway.
- **NAT instance (e.g. fck-nat, ~$4/mo)** — kept only as a fallback if the fetcher split is ever
  undesirable; it's an EC2 to patch, against the serverless grain.
- **Links module in the in-VPC core + a `lambda` interface endpoint (~$7/mo/AZ)** — the original
  placement (briefly deployed, PR #110): kept the links routes on the in-VPC function at the cost
  of the one paid endpoint. Replaced the same week by the non-VPC edge placement above, which
  serves the identical routes for $0; the endpoint was removed (2026-07-08 consolidation).
- **Fronting `POST /links` with the Retailer Proxy directly** — also $0, but it would hang a
  public, JWT-authorized HTTP surface on the credential-holding proxy; keeping the proxy
  invoke-only preserves "attack surface == sensitivity boundary" below.

## Consequences

- **Standing network cost ≈ $0** (no NAT, no RDS Proxy, no interface endpoints, free DynamoDB
  gateway endpoint). Both retailer-proxy flows — the sync link generation and the scheduled
  poll — are initiated from non-VPC functions, so neither needs a paid endpoint.
- **Attack surface == sensitivity boundary:** the public, viral, anonymous redirect path touches
  only one non-PII DynamoDB table — no Aurora reach, no VPC foothold, no PII, no money.
- **Egress containment retained** on the in-VPC money/PII functions; the only internet-facing
  code is the single, thin, secret-scoped Retailer Proxy.
- **Caveat:** a non-VPC Lambda cannot have SG/egress firewalling, so a compromised Retailer Proxy
  has unrestricted outbound. Mitigate with IAM least-privilege + supply-chain hygiene (lockfiles,
  pinned deps, SCA scanning) and keep the Proxy minimal. This is the deliberate trade for
  deleting the NAT.
- **Verify:** retailer hosts remain IPv4-only and confirm the real integration hostname per
  program (Shein/Temu/iHerb/Banggood may onboard via an affiliate network, not the storefront).
