# Wanthat — Solution Design Document
### MVP Feature Set: Registration & Sign-in · Link Generation · Consumer Redirect & Onboarding · Two-sided Wallet · Admin Dashboard

> **Authoritative-source note.** This SDD is the original detailed design; the **[`../adrs/`](../adrs)
> (ADR-0001–0009) now supersede it where they differ** and are authoritative. Key supersessions:
> - **Compute (ADR-0002):** four Lambda units (Lambdalith + admin + landing + poller), not a single modular monolith.
> - **Datastore (ADR-0003):** polyglot — Aurora (PII + ledger) + DynamoDB (`recommendation_id→url`, `guest_attribution`); **no RDS Proxy**, IAM database auth.
> - **Network (ADR-0004):** NAT-free; only Aurora-touching functions are in-VPC; retailer calls go through non-VPC fetchers.
> - **Identity (ADR-0006):** SMS OTP + passkeys; WhatsApp deferred; layered SMS kill switch.
> - **Landing (ADR-0007):** resolves `recommendation_id` in DynamoDB (not Postgres) on a non-VPC Lambda.
> - **Attribution (ADR-0008):** via injected `custom_parameters` (`ref`/`c`/`g`) — **no `click_id` click-log lookup**.
> - **Conversion (ADR-0009):** scheduled `order.listbyindex` reconciliation **poller**, not a `conversion-webhook` postback.

| |                                                                                                                                                              |
| :--- |:-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Status** | Draft v0.3 — for review                                                                                                                                      |
| **Author** | Architecture                                                                                                                                                 |
| **Source** | Wanthat PRD v1.0 (`Wanthat_PRD_v1.md`)                                                                                                                       |
| **Scope** | Full MVP feature set (below). **Payouts/withdrawals are deferred to a later phase.** Full target-state architecture: `wanthat-poc/docs/AWS_Architecture.md`. |
| **Date** | June 2026                                                                                                                                                    |

---

## 1. Purpose & Scope

This document specifies the solution design for Wanthat's MVP. It is implementation-ready: an engineer should be able to build from it, and a reviewer should be able to challenge each decision.

**In scope (MVP)**

1. **Registration & Sign-in** — phone-first account creation and sign-in, for both referrers and consumers.
2. **Logged-in link generation** — a referrer pastes a product URL (AliExpress in MVP) and gets a tracked Wanthat link.
3. **Consumer redirect & onboarding** — a consumer clicks a shared `wanthat.app/p/{id}` link, sees a branded disclosure, and either **registers** (to claim a share of the cashback) or **continues as guest**, then lands on the retailer.
4. **Wallet & balance** — both referrers and consumers have a wallet whose balance is derived from an append-only ledger; conversions credit a two-sided reward. **Payouts are not in MVP — balances accrue.**
5. **Admin dashboard** — internal, role-gated, simple operational + business stats.

Cross-cutting, applied to **all** of the above: **observability** (§13) and **auditing of payment-related flows** (§14).

**Out of scope (later phases):** payouts/withdrawals; group sharing; the full brand-analytics product (beyond the simple admin stats here); native mobile app; additional networks (Awin, CJ, eBay, Amazon, Temu, Shein, iHerb, Banggood …); Chrome extension; product reviews.

> **Why the consumer-side features are feasible now:** attribution rides on a **SubID** (= our internal `recommendation_id`) on a single publisher tracking ID, and Wanthat owns the `/p/{id}` redirect. We therefore do **not** depend on AliExpress per-user tracking IDs — which is exactly what makes the consumer redirect, guest handling, and two-sided wallet buildable in MVP (see §8.1 attribution).

---

## 2. Personas

**Referrer (primary).** A registered customer who shares tracked links to products they like and earns cashback when a friend buys. PRD Persona 1 (Michal, 34, Tel Aviv). Wants effortless sharing and visible earnings; does not want a second job. Success = "I got money back for a link I'd have shared anyway."

**Consumer (recipient / buyer).** Someone who receives a Wanthat link and clicks it to buy. PRD Persona 2 (Yoni, 29, Haifa). Primary goal is to buy the product and trust the link is safe. On the redirect they can **register to earn their own cashback share** (two-sided reward) or **continue as guest**. Every consumer is a potential future referrer — the click→register path is the core acquisition loop (UC-02).

> A single `customer` record can be *both* a referrer and a consumer; the role is determined **per flow** (sharing a link vs. clicking/buying), not stored on the account. The **Admin/Operator** is an internal role (not an external persona) — see §11.

---

## 3. Assumptions & Constraints

These are given inputs. Technology/architecture choices are design decisions (recorded in §5), not assumptions.

- **Posture (working assumption):** lean & reversible — invest upfront only where retrofitting is expensive (money, identity, data model, compliance); defer the rest. *Still a review point.*
- **Platform:** AWS, carried over from the foundation discussion. Revisit if the portability stance hardens.
- **Market constraints (from PRD):** Israel-first; Hebrew (RTL) **and English** from day one; phone-first identity; ILS currency; data resident in IL/EU (PRD §9.3).
- **Optimization priority (this phase):** operational cost and security. On trade-offs, prefer lower run-cost and lower attack-surface. Per-decision cost model in §5.1.
- **Two-sided reward funding:** the consumer's cashback share is funded out of Wanthat's commission margin (PRD §8.2), not added on top — it never makes a conversion unprofitable.
- **Attribution windows (two — don't conflate):** the **network commission window** is per-platform (AliExpress = 3 days, declared by the retailer adapter as `attributionWindowDays`) and governs whether a purchase earns commission; Wanthat's **first-party attribution cookie is 30 days (configurable)**, used to link a returning guest to their click. Consumer attribution must be established at click time.

---

## 4. Requirements

Functional requirements per feature, traced to the PRD. The **Source** column references the PRD (use cases `UC-xx`, personas, and PRD sections prefixed `PRD §`). Design decisions (§5) and detailed designs (§7–§11) derive from these.

### 4.1 Feature 1 — Registration & Sign-in

| ID | Requirement | Source |
| :-- | :-- | :-- |
| F1-R1 | Register with phone (Israeli mobile) + email; no password (OTP) | UC-02 step 6; PRD §5 |
| F1-R2 | Phone verified via OTP before the account is usable | PRD §10.1; UC-02 |
| F1-R3 | Registration captures referral attribution (`referredBy`) when present | UC-02 step 5; PRD §5 |
| F1-R4 | A returning user signs in with phone + OTP | UC-03 step 1 |
| F1-R5 | Sign-up → first action within session (activation); auth must not add friction | UC-02 step 7 |
| F1-R6 | Bilingual Hebrew (RTL) + English UI from day one, phone-first | PRD §5, Persona 1; review directive |
| F1-R7 | A wallet is provisioned on registration (empty, ILS) | UC-03 |
| F1-R8 | Registration is reachable from the consumer redirect path (§4.3) | UC-02 |
| F1-R9 | Capture first name + last name at registration; **consumers see first name only** (last name internal) — used for share attribution "[First name] recommends…" and greetings | UC-01 step 4; review directive |
| F1-R10 | Preferred language auto-selected from the visitor's location/country at first touch (Hebrew for IL, English otherwise); stored as `locale`, user-overridable | F1-R6; review directive |
| F1-R11 | Offer **passkey/WebAuthn (Face ID/Touch ID)** as an opt-in step-up after the first OTP sign-in; phone-OTP stays primary enrollment + recovery | review directive; §18 #10 |

### 4.2 Feature 2 — Logged-in Link Generation

| ID | Requirement | Source |
| :-- | :-- | :-- |
| F2-R1 | Authenticated referrer pastes a product URL → tracked `wanthat.app/p/{id}` link | UC-01 steps 1–3 |
| F2-R2 | Retailer detected & validated; AliExpress supported in MVP | UC-01 step 1; PRD §7.2 |
| F2-R3 | Tracked link via the **real** AliExpress Affiliate API (`aliexpress.affiliate.link.generate`) | PRD §7.2; user directive |
| F2-R4 | Product name/thumbnail fetched and cached on the link record | UC-01 step 2; UC-06 |
| F2-R5 | Link persisted, owned by the referrer, ready to accumulate clicks/conversions | UC-06 |
| F2-R6 | Unsupported retailer fails gracefully + logs demand signal | UC-04 |
| F2-R7 | Link generation < 1.5s from paste to ready | PRD §10.3 |
| F2-R8 | Editable Hebrew/English WhatsApp share template with disclosure | UC-01 step 4; PRD §9.1 |
| F2-R9 | Per-recommender attribution via SubID (= `recommendation_id`), single publisher tracking ID | UC-01; design |
| F2-R10 | Generating a link for a product the referrer already shared **reuses their existing active link** — no duplicate link per (customer, product) | UC-06; review directive |
| F2-R11 | A **review belongs to a product** (not a link) and is authored by a customer; writing/editing a review is a **separate action**, not part of link generation. The share flow encourages it; it's woven into the share message and shown as social proof | review directive; PRD §8.3 |

### 4.3 Feature 3 — Consumer Redirect & Onboarding

| ID | Requirement | Source |
| :-- | :-- | :-- |
| F3-R1 | On a consumer click, log the click and 301-redirect to the retailer with affiliate tag + SubID | UC-01 step 6 |
| F3-R2 | Redirect p95 < 500ms — must not feel like a broken link; the landing page is lightweight/fast | PRD §10.3 |
| F3-R3 | An **anonymous** consumer gets a landing page showing the FTC disclosure + referrer context + explicit choices | UC-01 step 6; PRD §9.1 |
| F3-R10 | A **logged-in** consumer is redirected **automatically** — no landing-page friction (disclosure shown briefly) | review directive |
| F3-R5 | **Sign-up / log-in is the primary CTA** on the landing page (grow the customer base this phase); registering claims a cashback share (two-sided reward) | UC-02 steps 4–6; PRD §8.2; review directive |
| F3-R4 | Consumer can **continue as guest** as a secondary option — sign-up is not forced, purchase intent not blocked | UC-02 step 3 |
| F3-R6 | A guest who registers later within the attribution window is linked to the prior click (best-effort) | UC-02; design |
| F3-R7 | Open-redirect safe — only redirect to Wanthat-generated affiliate URLs | Security |
| F3-R8 | Click ingestion must not degrade under a viral burst | PRD §10.3; scalability |
| F3-R9 | The anonymous `/p/{recommendation_id}` landing page carries Open Graph tags (product title + thumbnail + description) so WhatsApp unfurls a rich preview — **no separate crawler/user-agent path** | UC-01 step 6; review directive |

### 4.4 Feature 4 — Wallet & Balance

| ID | Requirement | Source |
| :-- | :-- | :-- |
| F4-R1 | Both referrer and consumer have a wallet; balance derived from an append-only ledger | UC-03; PRD §8.2 |
| F4-R2 | Balance distinguishes **pending** vs **confirmed** (network validation delay) | UC-03 step 2 |
| F4-R3 | Referrer sees per-link earnings | UC-03 step 3; UC-06 |
| F4-R4 | Consumer sees cashback earned on their own purchases | PRD §8.2 |
| F4-R5 | On a confirmed conversion: credit referrer commission and (if attributed + registered) consumer reward, split from gross commission | PRD §8.2 |
| F4-R6 | **Payouts/withdrawals are NOT in MVP** — balances accrue | review directive |
| F4-R7 | Every wallet mutation is auditable | §14 |
| F4-R8 | The wallet is **held in the retailer's settlement currency** (USD from AliExpress) — our liability matches our receivable (zero FX float). Commissions are credited in that settlement currency; the balance is **displayed** converted to the member's currency (ILS) net of a conversion commission (CONFIG `fx.conversionCommissionBps`); the **real conversion happens only at withdrawal** (gated on the current converted ILS value) | review directive; PRD ILS-first |

### 4.5 Feature 5 — Admin Dashboard

| ID | Requirement | Source |
| :-- | :-- | :-- |
| F5-R1 | Admin-only, role-gated access | Security |
| F5-R2 | Simple stats: customers, links, impressions, clicks, click-through rate, conversions, conversion rate, GMV, gross commission, wallet liabilities (pending/confirmed) | PRD §3.2; ops need |
| F5-R3 | Simple trends over time (signups, links, conversions) | PRD §3.2 |
| F5-R4 | Top links / top referrers | UC-06; ops need |
| F5-R5 | Operational health snapshot (redirect latency, AliExpress error rate, conversion-poller lag) | §13 |
| F5-R6 | Read-only in MVP (any manual wallet adjustment is audited — §14) | review directive |

---

## 5. Key Design Decisions (derived from requirements)

Each decision is driven by a requirement from §4, not assumed. **Each is a review point.**

| # | Decision | Choice | Driven by | Reversible? | Revisit trigger |
| :-- | :-- | :-- | :-- | :-- | :-- |
| D1 | Backend shape | Modular monolith API + a separate high-volume **landing** service (§6) | Two divergent workloads — app CRUD vs public, viral-spiky redirect at <500ms (F3-R2, PRD §10.3) | Yes | Need to scale a single module independently |
| D2 | Language/runtime | TypeScript, Node 20, monorepo with shared types | Web (desktop + mobile) and backend share one domain model + share/disclosure contract | Costly | — |
| D3 | Identity provider | AWS Cognito (phone OTP + email, groups for roles); alt. Auth0/Clerk | F1-R1/F1-R2 passwordless OTP; F5-R1 admin role; avoid building OTP security | Medium | Cognito OTP UX/cost/localisation limits |
| D4 | Primary datastore | Managed PostgreSQL | Money-ledger integrity (§10), referral/link relationships, admin reporting (§11) | Costly | — |
| D5 | Auth model | Cognito-issued JWT validated at API Gateway; API never sees raw credentials | F1-R4/F1-R5 low-friction auth; stateless API | Low | — |
| D6 | Hosting region | AWS `il-central-1` (Tel Aviv), `eu-central-1` fallback | Data residency — PRD §9.3 | Medium | — |
| D7 | Event store | Click/conversion events → managed stream (Kinesis Firehose → S3) + aggregated counters on `link`, separate from OLTP | Viral redirect/click volume must not hit the transactional DB (F3-R8) | Yes | — |
| D8 | Audit store | Append-only, write-once **hash-chained Postgres table** (no UPDATE/DELETE grants) | Payment-flow auditing (F4-R7, §14) | Medium | Need cryptographic verifiability → QLDB |
| D9 | Two-sided split | Commission split server-side from gross; consumer share funded from margin | F4-R5; PRD §8.2 | Low | — |

> Decided (§18 #1): **Cognito** — we accept deeper AWS lock-in for speed and native OTP/JWT/passkey/group support; the identity/profile separation (§7.1) keeps app data portable if we ever switch.

### 5.1 Operational cost estimate (monthly, USD)

Per the optimization-priority assumption (§3), each cost driver is modeled at three scales. Planning estimates, not quotes.

**Usage assumptions** (steady state, per active referrer/month): ~2 OTP sends, ~4 link generations, ~20 redirects/clicks on their links, a handful of conversions; ~50 app API requests. **Excludes** payouts (deferred) and not-yet-built networks. USD; region `il-central-1`; pricing current as of June 2026 (sources at end of §5.1).

| Driver | @100 | @1,000 | @10,000 | Notes |
| :-- | --: | --: | --: | :-- |
| Compute — app API (API Gateway HTTP API + Lambda) | <$1 | <$1 | ~$1–2 | Per-request; scales to zero between bursts |
| Redirect + CDN + click/conversion stream (CloudFront + Lambda + Firehose) | <$1 | ~$1–2 | ~$5–8 | ~2k / 20k / 200k redirects/mo; tiny payloads |
| Runtime / monorepo | ~$0 | ~$0 | ~$0 | No runtime cost; CI within free tier (flat) |
| Identity provider (Cognito) | $0 | $0 | $0 | Essentials: first **10k MAU free**, then $0.015/MAU. Auth0 (≤25k) & Clerk (≤50k) also $0 here |
| **OTP delivery — SMS to Israel** | ~$13 | ~$130 | ~$1,300 | ~$0.065/SMS × ~2/user/mo (estimate — verify IL rate). **Dominant cost.** WhatsApp OTP cuts this materially |
| Primary datastore — managed Postgres | $0 | ~$19–25 | ~$25–50 | Neon free → Launch $19; Supabase Pro $25; Aurora Serverless v2 floor ~$45 |
| Audit log store | $0 | $0 | ~$0–5 | Append-only Postgres table (no extra infra). QLDB optional, small |
| Auth model (JWT at API Gateway) | $0 | $0 | $0 | No incremental charge |
| Hosting region premium (Tel Aviv) | ~$0 | ~$1–3 | ~$5–15 | `il-central-1` ~10–15% over `eu-central-1` on some services |
| **Modeled total** | **~$15** | **~$155–165** | **~$1.36k** | OTP SMS ≈ 85–90% of the bill at every scale |

**Cost-and-security conclusions:**
- Identity is effectively free at MVP scale across all vendor options → D3 is a security/lock-in decision, not a cost one.
- **OTP delivery is both the top cost and the top abuse surface** (SMS-pumping). Optimizing for cost *and* security pointed to the same answer, now **decided (§18 #2): WhatsApp-first OTP, SMS fallback** + per-phone/per-IP rate limits.
- Redirect/compute/datastore/audit are all minor (<$80/mo even at 10k). Scale-to-zero Postgres (Neon) beats an always-on Aurora floor here.
- **Biometric sign-in (Face ID/Touch ID via passkeys/WebAuthn)** is a cost *and* security win for **repeat** logins — it sends no SMS (cutting the dominant cost) and is phishing/toll-fraud-resistant. Cognito supports it natively on the Essentials tier we already use (no new vendor, ~no added cost). Recommend offering it as an opt-in step-up *after* the first OTP sign-in, not as primary day-1 auth (see §18).

*Pricing sources: [AWS Cognito](https://aws.amazon.com/cognito/pricing/), [Amazon SNS SMS](https://aws.amazon.com/sns/sms-pricing/), [Neon](https://neon.com/pricing), [Supabase](https://supabase.com/pricing), [Auth0](https://auth0.com/pricing), [Clerk](https://clerk.com/pricing), [Kinesis Firehose](https://aws.amazon.com/kinesis/data-firehose/pricing/).*

---

## 6. Architecture — Where Features Sit

```
   Referrer (web)                          Consumer (web)
        │ HTTPS                                  │ click /p/{id}
        ▼                                        ▼
   CloudFront (TLS, WAF, CDN) ───────────────────┤
        │ /api/*                                 │ /p/*
        ▼                                        ▼
   API Gateway (HTTP API) ──jwt──► Cognito   Landing service (Lambda)
        │   (groups: user, admin)   User Pool      │  • resolve recommendation_id
        ├─ /auth/*   ─► identity module             │  • member → auto-redirect
        ├─ /links    ─► links module ─► AliExpress  │  • anon → OG landing page
        ├─ /wallet   ─► wallet module      Affiliate │  • on go: click → stream, 301 + SubID
        └─ /admin/*  ─► admin module (admin only)    │
              │                │                     ▼
              ▼                ▼               Kinesis Firehose ─► S3 (clicks/conv)
        PostgreSQL  ◄── Secrets Manager              │
        (customer, link,     (AliExpress creds)      │ scheduled pull (no postback)
         referral, ledger,                           ▼
         conversion, audit)  ◄──────────  conversion poller (EventBridge → listOrders)
                                          • resolve custom_parameters (ref/c/g) → referrer/consumer (no click log)
                                          • append event-log ledger (order_id, kind, status)
                                          • write audit log
```

The app API is a modular monolith (`identity`, `links`, `wallet`, `admin`). The **landing service** and the **scheduled conversion poller** (ADR-0009 — not a webhook) are separated because they are public/bursty and latency- or schedule-driven (D1, D7). All money mutations flow through the ledger and the audit log (§10, §14).

---

## 7. Feature 1 — Registration & Sign-in

*(Requirements: §4.1)*

### 7.1 Design

**Identity provider.** A Cognito User Pool is the system of record for credentials/verification. Phone is the primary username; email a secondary attribute. Authentication is **passwordless OTP** (Custom Auth challenge), matching "no password for MVP." Cognito groups model roles: `user` (default) and `admin` (Feature 5). Cognito handles OTP generation, expiry, throttling, lockout.

**Profile vs identity separation.** Cognito owns *authentication state*; our `customer` table owns *application state* (name, wallet, referral, status, locale). Linked by Cognito `sub`. We can swap identity provider later without migrating app data.

**Profile & language.** Registration collects the customer's **first and last name** (F1-R9) — used to personalize the share message and interstitial ("[First name] recommends this") and greetings. **Preferred language is auto-selected from location** (F1-R10): the edge derives the country from the CloudFront `CloudFront-Viewer-Country` header (fallback `Accept-Language`) and defaults `locale` to Hebrew (`he-IL`) for Israel, English (`en`) elsewhere. This is a *default only* — the user can switch language anytime in settings and the choice persists. Only coarse country is used; no precise geolocation is requested or stored.

**Account provisioning.** On first verification, a Cognito **Post-Confirmation trigger** creates the `customer` row + empty wallet + referral edge, idempotently keyed on `cognito_sub` — exactly once, only after the phone is verified.

**No per-user affiliate tracking ID.** Registration provisions only the Wanthat `customer` record — no AliExpress/network tracking ID per user, and no external affiliate call. Per-recommender attribution is at link time via SubID (§8.1).

**Referral capture.** The client carries a `ref` token from the UC-02 deep link (or the consumer redirect, §9) through sign-up; persisted to `referral` on provisioning. Invalid `ref` is dropped (not an error).

**Sessions/tokens.** Cognito issues a short-lived access JWT (~1h) + refresh token. The SPA (desktop + mobile web) holds the access token in memory and the refresh token in an httpOnly secure cookie. API Gateway's JWT authorizer validates on every protected call; the API trusts the `sub` + `cognito:groups` claims.

**Biometric step-up (F1-R11).** After a customer's first OTP sign-in we offer to enrol a **passkey/WebAuthn** credential (Face ID / Touch ID / Android biometric), handled natively by Cognito (Essentials tier). Subsequent sign-ins via passkey send **no OTP** — cutting the dominant SMS cost and resisting phishing/toll-fraud. Phone-OTP remains the enrolment and recovery path; biometrics are never the first-touch method (WhatsApp in-app browser WebAuthn support is patchy, and forcing it would add first-touch friction).

### 7.2 Flows

**Registration:** `POST /auth/register {phone,email,firstName,lastName,ref?}` → validate (IL phone→E.164, email, names) → set `locale` from geo (CloudFront country) → Cognito `SignUp` → OTP via WhatsApp (SMS fallback) → `POST /auth/verify {phone,code,session}` → Post-Confirmation provisioning → tokens. Lands on the next action (generate link, or claim consumer reward if arriving from §9).

**Sign-in:** `POST /auth/login {phone}` → OTP challenge → `POST /auth/verify` → tokens.
**Refresh:** `POST /auth/refresh` (refresh cookie) → new access token.

### 7.3 Data model (PostgreSQL)

```
customer
  id              uuid pk
  cognito_sub     text unique not null
  phone_e164      text unique not null
  email           citext unique not null
  first_name      text not null
  last_name       text not null
  status          text not null            -- 'active' | 'suspended'
  locale          text not null default 'he-IL'   -- auto-set by geo at first touch; user-overridable
  created_at      timestamptz not null default now()

referral
  id              uuid pk
  referred_customer_id  uuid not null references customer(id)
  referrer_customer_id  uuid not null references customer(id)
  created_at      timestamptz not null default now()
  unique (referred_customer_id)
```

### 7.4 API contracts

| Method | Path | Description | Auth | Body | Success | Errors |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| POST | `/auth/register` | Start sign-up for a new customer; triggers the OTP challenge | none | `{phone,email,firstName,lastName,ref?}` | `200 {session,challenge}` | `400`; `409` exists |
| POST | `/auth/login` | Start sign-in for an existing customer; triggers the OTP challenge | none | `{phone}` | `200 {session,challenge}` | `400` |
| POST | `/auth/verify` | Verify the OTP code and issue access/refresh tokens | none | `{phone,code,session}` | `200 {accessToken,expiresIn,customer}` | `400`; `401` |
| POST | `/auth/refresh` | Exchange the refresh cookie for a fresh access token | refresh cookie | — | `200 {accessToken,expiresIn}` | `401` |
| GET | `/me` | Return the current customer profile + wallet balance | jwt | — | `200 {customer, walletBalance}` | `401` |

### 7.5 Security & compliance

- **OTP abuse:** Cognito limits + per-phone/per-IP rate limits at API Gateway/WAF to blunt SMS-pumping toll fraud.
- **Enumeration (account-existence leak).** A phone-first app must not let anyone probe *which phone numbers have Wanthat accounts* — in a viral WhatsApp market numbers are widely shared, so membership is sensitive and useful for targeted phishing/social engineering. **Decision:** `/auth/login` returns a **uniform** `{session, challenge}` response whether or not the number is registered, so the response can't distinguish members from non-members. Importantly, we **do not dispatch an OTP to an unrecognised number** — this leaks nothing *and* avoids paying for SMS to non-accounts (the same SMS-pumping/toll-fraud surface noted above); a subsequent `/auth/verify` simply fails the challenge. Per-phone and per-IP rate limits cap probing regardless.
  - *Registration-path decision (option a):* `/auth/register` must either create an account or detect a duplicate, so the `409 exists` response is a **deliberate, accepted** enumeration vector on that endpoint only — common and simplest, as most consumer apps do — mitigated by per-phone/per-IP rate limiting. If enumeration abuse appears we can harden later (option b: register returns a uniform "check your phone" and we instead notify the *real* owner, "you already have an account — sign in"). Recorded in §18 #5.
- **PII minimisation (PRD §9.3):** phone, email, and name only; no government ID/address. Preferred language is inferred from coarse country geo (no precise location stored). Consent (Terms/Privacy version + timestamp) recorded at sign-up — pre-launch requirement.
- **Right to deletion:** `cognito_sub` + single `customer` row keep deletion bounded.

### 7.6 Edge cases

- Existing verified phone → `409`, route to sign-in. Unverified registration expires in Cognito (no `customer` row). Email reuse across phones → `409` (default: disallowed; review).

---

## 8. Feature 2 — Logged-in Link Generation

*(Requirements: §4.2)*

### 8.1 Design

**Retailer adapter interface.** One implementation today (`AliExpressAdapter`); stubs for future networks. This is the seam (D1) for adding networks without touching the endpoint or data model.

```
interface RetailerAdapter {
  id: 'aliexpress' | 'awin' | 'ebay'
  matches(url: URL): boolean
  attributionWindowDays: number   // network commission window (AliExpress = 3)
  generate(url: string, subId: string): Promise<{ affiliateUrl, productName?, imageUrl?, commissionRate? }>
}
```

**AliExpress client.** Signed client for the AliExpress Affiliate Open Platform using **HMAC-SHA256 on the current System Interface gateway** (`api-sg.aliexpress.com/sync`). We deliberately do **not** implement the legacy MD5 / `gw.api.taobao.com` path: it's a deprecated gateway with a weak hash, and a greenfield MVP has no reason to use it — dropping it also shrinks the signing and test surface (consistent with the security posture). Link via `aliexpress.affiliate.link.generate`; metadata via `aliexpress.affiliate.productdetail.get`. Signing spec in Appendix A. Credentials from Secrets Manager, cached per warm instance.

**Attribution — SubID, not per-user tracking IDs.** Wanthat stays a single registered publisher per network with *one* tracking ID per network/channel. We never mint a per-user network tracking ID (AliExpress tracking IDs are coarse campaign buckets with limits). Attribution is **two-level**:
- **Link-level → referrer.** The static `recommendation_id` is baked into the generated link as the network's **SubID** and echoed back in the order report. It identifies the **referrer's link** (referrer + product) — *not* a referrer+consumer pair: many consumers click the same link and all carry the same SubID. Referrer attribution is therefore always available and robust.
- **Click-level → consumer.** Because we own the `/p/{recommendation_id}` redirect (§9), at resolve time we append a **consumer key** to `custom_parameters` on the outgoing affiliate URL — `c` = the member's `customer_id` (Bearer token resolved client-side) or `g` = an opaque `guestId` from localStorage — which AliExpress echoes back in its order report. There is **no click log**: at conversion `c` credits the member directly, while `g` is resolved via the DynamoDB `guest_attribution[g] → customer_id` mapping (a guest who later registered) — else it stays a guest. Consumer attribution is thus best-effort (ADR-0008).

How these drive crediting (referrer always; consumer when attributed, funded from margin) is detailed in §10.1.

| Network | SubID parameter | Per-user attribution |
| :-- | :-- | :-- |
| AliExpress | custom tracking string (Live Order report) | Yes |
| Awin | `clickref` (×6, ≤50 chars) | Yes |
| CJ | `sid` (≤64 chars) | Yes |
| eBay EPN | `customid` | Yes |
| Rakuten | `u1` | Yes |
| Amazon Associates | — (tracking tags only, ~100 cap) | **No** — fall back to our click-layer attribution |

Temu, Shein, iHerb, Banggood run through one of the networks above and inherit its SubID support; Amazon is the lone exception.

**Meeting <1.5s (F2-R7).** At most two upstream calls: generate link (required) on the path; fetch metadata in parallel, best-effort — if slow/failed, persist and return without metadata and enrich async. Keeps p95 well under 1.5s.

**Products & links.** A pasted URL is resolved to a **`product`** — a shared entity keyed by `(retailer, normalized_url)` — that caches the title, thumbnail and commission rate. A `link` is one referrer's tracked link *to a product*; many referrers can link to the same product. Product metadata is fetched once and reused.

**Reuse, no duplicate links (F2-R10).** A referrer has at most one **active** link per product. `POST /links` for a product the caller already shared **returns their existing active link** rather than minting a new one, so clicks/conversions keep accumulating on a single link (UC-06). Enforced by a partial unique index on `(customer_id, product_id) WHERE status='active'`. Mint a URL-safe `recommendation_id` (~48-bit, collision-checked) only when creating.

**Reviews are product-scoped and separate (F2-R11).** A **review belongs to a product** and is authored by a customer; it is **not** created during link generation and is not stored on the link. Writing/editing a review is its own action (`PUT /products/{id}/review`, §8.4). The share flow *encourages* the referrer to add/update their review for the product, but link generation succeeds with or without one. A present review is woven into the share message and surfaced on the consumer interstitial (§9.1) as social proof; reviews aggregate per product, seeding the verified-recommender review layer (PRD §8.3). Review text is user-generated content — moderated (§17).

**Share template (F2-R8).** Response includes a localized (Hebrew/English, per the referrer's `locale`) editable WhatsApp message, personalized with the referrer's first name ("[First name] recommends this", F1-R9), with the mandatory non-removable disclosure baked in (PRD §9.1), plus the referrer's product review if they've written one. The shared `wanthat.app` link unfurls into a rich product card (thumbnail + title) in WhatsApp via Open Graph (F3-R9).

### 8.2 Flow (UC-01 steps 1–3)

1. Client (web) → `POST /links {url}` with JWT.
2. Authorizer validates JWT → `customer_id`.
3. `links` selects an adapter via `matches()`. Unsupported → `400` UC-04 + `retailer_demand` row.
4. Resolve/`upsert` the `product` by `(retailer, normalized_url)` (caching title/thumbnail). 
5. **Reuse check:** if the caller already has an active link for this product, return it (no new link, no new API call).
6. Otherwise mint `recommendation_id`, then `AliExpressAdapter.generate(url, recommendation_id)` (`recommendation_id` = SubID): sign → `link.generate`; in parallel best-effort `productdetail.get` (~600ms cap) to enrich the product.
7. Persist `link`.
8. Return `{recommendationId, shareUrl, affiliateUrl, product, review?, shareTemplate, stats}` — `review` is the caller's existing review for the product if any (read, not created here).

### 8.3 Data model (PostgreSQL)

```
product                    -- shared across all referrers who link to it
  id              uuid pk
  retailer        text not null
  external_id     text             -- retailer product id, if parseable
  normalized_url  text not null    -- canonical product URL
  title           text             -- cached metadata (F2-R4)
  image_url       text
  commission_rate numeric
  created_at      timestamptz not null default now()
  unique (retailer, normalized_url)

link                       -- one referrer's tracked link to a product
  id              uuid pk
  recommendation_id        text unique not null
  customer_id     uuid not null references customer(id)
  product_id      uuid not null references product(id)
  affiliate_url   text not null            -- carries SubID = recommendation_id
  status          text not null default 'active'
  created_at      timestamptz not null default now()
  -- one active link per (customer, product) → reuse, no duplicates (F2-R10):
  unique (customer_id, product_id) where status = 'active'
  -- denormalised counters (source of truth = event stream, D7)
  impression_count int default 0, click_count int default 0, conversion_count int default 0, earned_minor bigint default 0

review                     -- belongs to a PRODUCT, authored by a customer (F2-R11); created separately
  id              uuid pk
  product_id      uuid not null references product(id)
  author_customer_id uuid not null references customer(id)
  rating          int null                 -- 1..5, optional
  body            text not null
  status          text not null default 'pending'   -- moderation; UGC (§17)
  created_at, updated_at  timestamptz
  unique (product_id, author_customer_id)  -- one review per product per author

retailer_demand            -- UC-04 demand signal
  id, customer_id?, raw_url, detected_host, created_at
```

### 8.4 API contract

| Method | Path | Description | Auth | Body | Success | Errors |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| POST | `/links` | Get the caller's tracked link for a product — **reuses** their existing active link or creates one (no duplicates) | jwt | `{url}` | `201`/`200 {recommendationId,shareUrl,affiliateUrl,product,review?,shareTemplate,stats}` | `400` invalid; `400 {reason:'unsupported_retailer'}`; `401`; `502` upstream |
| GET | `/links` | List the referrer's own links with cached stats (My Links) | jwt | — (sort/filter) | `200 {items:[…]}` | `401` |
| PUT | `/products/{id}/review` | Create or update the caller's review for a product (separate from link gen) | jwt | `{rating?, body}` | `200 {review}` | `400`; `401`; `404` product |
| GET | `/products/{id}/reviews` | Product reviews (approved) — for the interstitial / product view | none | — | `200 {items:[…]}` | `404` |

### 8.5 Security
Link bound to `customer_id` from JWT (no cross-customer access). **SSRF-safe:** the pasted URL is host-allow-listed and only passed *as a parameter* to the AliExpress API — never fetched by us. Secrets only in Secrets Manager. Upstream errors → `502` + correlation id; retries with backoff for transient 5xx only. Per-customer rate limit on generation.

---

## 9. Feature 3 — Consumer Redirect & Onboarding

*(Requirements: §4.3)*

### 9.1 Design

**Landing service.** A dedicated, public, latency-critical service behind CloudFront (D1). It resolves `recommendation_id → link` and then **branches on auth state**: a **logged-in** consumer is auto-redirected; an **anonymous** request gets the landing page (which carries the Open Graph tags, so link-preview crawlers render their thumbnail from the very same page — see F3-R9). On redirect-through it logs the click and 301s to the retailer's affiliate URL with the SubID intact. Read-mostly and independently scalable so a viral burst can't degrade the app API (F3-R8).

**Event logging off the hot path (D7).** Two event types are emitted to Kinesis Firehose (→ S3), never written synchronously to Postgres, so the path stays < 500ms (F3-R2) under bursts: an **impression** when the landing page renders (top-of-funnel; may include preview-crawler fetches), and a **click / engagement** on redirect-through (the meaningful action). Aggregated `impression_count` and `click_count` on `link` are updated asynchronously from the stream — their ratio is the click-through rate the PRD tracks (PRD §3.2). On a click we set a signed, short-lived **attribution token** (cookie + URL param) carrying `{recommendation_id, click_id}` so a later registration or conversion can be tied back to it.

**Auto-redirect for members; landing page for everyone else (F3-R3/R4/R5/R10).** The post-click experience branches on auth state:
- **Logged-in consumer → automatic redirect.** They're already a member and their attribution is known, so we add no friction: log the click, show the FTC / PRD §9.1 disclosure as a brief branded splash, and 301 straight to the retailer. Their purchase is automatically eligible for the two-sided consumer reward (§10).
- **Anonymous consumer → a landing page** (not a timed auto-redirect). It names the referrer by first name (F1-R9), shows the disclosure ("X recommends this; you'll continue to AliExpress") and, if present, the referrer's product review (F2-R11) as **social proof**, then presents explicit actions:
  - **Sign up / Log in to earn cashback too** — the prominent **primary** CTA (we lead with growth this phase). Routes to Feature 1 with referral context + the attribution token; on success we 301 to the product and this consumer becomes eligible for the **consumer reward** as well as the referrer commission (two-sided, §10) — the "possible share of affiliation."
  - **Continue to AliExpress** — a clearly-available **secondary** option (guest). The referrer still earns (attribution via SubID); the guest earns nothing.

  *Design note:* this deliberately replaces the PRD's timed auto-overlay for anonymous visitors. Leading with sign-up prioritizes growing the customer base (the goal this phase); guest-continue stays one tap away so we don't hard-gate the purchase (UC-02). Logged-in members skip the page entirely (auto-redirect).

**Guest→register linking (F3-R6).** Wanthat sets a **first-party attribution cookie — 30 days, configurable** — carrying `{recommendation_id, click_id}`. If a guest registers while that cookie is valid, we link the prior `click_id`(s) to the new `customer_id` (best-effort): for identity continuity, re-engagement, and to attribute a still-open conversion to them. **Two windows, kept separate:**
  - *Our 30-day cookie* — how long we remember a click and can link a returning guest.
  - *The network commission window* — declared **per platform** by the retailer adapter (`attributionWindowDays`; AliExpress = 3 days) — governs whether a *purchase* earns commission at all. Wanthat cannot extend it: a buy outside the network window earns nothing to split, regardless of our cookie.

  So a guest who registers on day 10 is still linked (within the 30-day cookie) and earns the consumer reward on **future** purchases, but cannot retroactively earn on a purchase whose network window already closed.
  - *Do we regenerate the affiliate link past the network window?* **No** — the link never expires; the network window is per **click**, not per link. Every click-through re-arms a fresh window (a new click event through the stored `affiliate_url`, same SubID). Re-engagement is about getting the consumer to *click through again*, not minting new links.

**Open-redirect safety (F3-R7).** The service only ever redirects to an `affiliate_url` it generated and stored for that `recommendation_id`. No user-supplied destination is honored.

**Rich link preview — Open Graph (F3-R9).** The anonymous `/p/{recommendation_id}` **landing page itself carries the Open Graph tags** — `og:title` = product title, `og:image` = product thumbnail, `og:description` = the referrer's review if present, else the disclosure. When the link is pasted into WhatsApp/Telegram/social, the crawler fetches `/p/{recommendation_id}` and, because crawlers are unauthenticated, receives the *same* anonymous landing page as any logged-out human and renders the preview from its meta tags. **No user-agent sniffing:** we deliberately do **not** branch on "is this a bot" — bot detection is never 100%, and we don't want the same GET path serving different content to bots vs. humans. The only branch is **auth state** (logged-in → auto-redirect; anonymous → this page), which is reliable. This keeps the two metrics clean: rendering the page — by a human *or* a preview crawler — is logged as an **impression** (top-of-funnel), while a **click / engagement** is logged only on **redirect-through** (Continue / logged-in auto-redirect). So bot previews can lift impressions but never clicks; the funnel stays impressions → clicks → conversions. Notes: (a) the F2-R4 product metadata is load-bearing for the preview — if a thumbnail/title isn't enriched yet, fall back to a generic Wanthat title/image until async enrichment completes; (b) `og:image` must be an absolute HTTPS URL — serve the cached image via our CDN (proxying the retailer thumbnail) for reliability and to avoid hotlink breakage.

### 9.2 Flow (UC-01 step 6 / UC-02)

1. Request hits `GET /p/{recommendation_id}`.
2. Resolve `recommendation_id`; unknown/disabled → friendly 404 page.
3. **Branch on auth state (session cookie), not user-agent:**
   - **Logged-in →** emit click event to Firehose (attributed to the customer) + set attribution token; brief disclosure splash; `301` to `affiliate_url` (+ SubID). Done.
   - **Anonymous (including link-preview crawlers) →** return the landing page HTML: Open Graph meta (F3-R9) + disclosure + referrer + social proof + CTAs. Render logs an **impression**, not a click.
4. On the anonymous landing page the consumer chooses:
   - **Sign up / Log in** (primary) → Feature 1 with `ref` + attribution token → on success emit click (attributed) → `301` to `affiliate_url`. Now eligible for the two-sided reward.
   - **Continue as guest** (secondary) → emit click (guest) → `301` to `affiliate_url`.
5. Consumer buys on AliExpress within the 3-day window.
6. (Async) the **scheduled conversion poller** (ADR-0009) pulls the order via `order.listbyindex`; the order echoes back our injected `custom_parameters` — `ref` (→ recommendation → referrer + product) and the consumer key `c`/`g` (member `customer_id` / opaque `guestId`, resolved via the DynamoDB `guest_attribution` lookup — **no click log**, ADR-0008). The poller-writer splits the reported commission by the **recommendation's snapshotted rates** (referrer cashback always; consumer reward when attributed — see §10.1), appends to the ledger (§10), and writes the audit log (§14).

### 9.3 Data model

```
-- High-volume, written via stream (D7), not on the hot path:
funnel_event (S3/stream; queryable via Athena, aggregated to link counters)
  event_id (uuid), type ('impression' | 'click'), recommendation_id, ts,
  ip_hash, ua, referrer_header,
  attribution_token, consumer_id?  -- token/consumer set on 'click' only (null for guest/impression)

conversion                  -- one row per confirmed/pending network conversion
  id              uuid pk
  link_id         uuid not null references link(id)
  click_id        uuid null
  referrer_customer_id  uuid not null references customer(id)
  consumer_customer_id  uuid null references customer(id)   -- set only when attribution='member'
  attribution     text not null            -- 'member' | 'guest' | 'untracked'
  order_ref       text not null            -- network order id
  gross_commission_minor   bigint not null  -- integer minor units of...
  settlement_currency      text not null    -- ...the retailer's settlement currency (USD for AliExpress) — ISO-4217; the wallet is held in it (F4-R8)
  -- split rates are NOT stored here: they come from the Recommendation's snapshot (taken from
  -- CONFIG cashback.referrerBps/consumerBps at link creation, ADR-0008), applied to the reported commission.
  -- No fx_rate at credit: amounts stay in settlement currency; FX → ILS is withdrawal-time metadata, not credit-time (F4-R8).
  status          text not null            -- 'pending' | 'confirmed' | 'clawback'
  source_subid    text not null            -- = recommendation_id (the `ref` custom_parameter)
  created_at, confirmed_at
  unique (order_ref)                        -- idempotent poller
```

### 9.4 API / endpoints

| Method | Path | Auth | Description |
| :-- | :-- | :-- | :-- |
| GET | `/p/{recommendation_id}` | none | Public entry: logged-in → log click + 301; anonymous → OG-tagged landing page (Sign-up primary / guest), then log click + 301 on go |
| POST | `/redirect/claim` | none→jwt | Link a click's attribution token to a newly-registered consumer (F3-R6) |
| — | _(no public conversion endpoint)_ | — | Conversions are ingested by the **scheduled poller** (ADR-0009), not a webhook — `EventBridge → Retailer Proxy.listOrders → in-VPC writer`; idempotent via the event-log key `(order_id, kind, status)` |

### 9.5 Security & resilience
Open-redirect safe (F3-R7). WAF + per-IP rate limiting on `/p/*` (click-fraud / bot mitigation). Click ingestion is async + buffered (Firehose) with a DLQ. There is **no public conversion endpoint** — ingestion is the scheduled poller (smaller attack surface); crediting is **idempotent** via the event-log key `(order_id, kind, status)`. Self-referral / self-click fraud: flag conversions where `consumer_customer_id == referrer_customer_id` or where click/convert patterns are anomalous (held for review, never auto-confirmed).

### 9.6 Edge cases
Unknown/disabled `recommendation_id` → friendly 404 (no raw error). Consumer never registers → guest; referrer still earns. Purchase outside the 3-day window → no conversion (expected); the next click through the same link re-arms a fresh window. Multiple clicks before purchase → last-click attribution per network rules. Guest registers after window → no retro-credit for the old click, but a new click-through restarts attribution (links are reusable, not regenerated).

---

## 10. Feature 4 — Wallet & Balance

*(Requirements: §4.4)*

### 10.1 Design

**Money is an append-only event log, not a balance.** The wallet is an **append-only** `wallet_entry` log of typed, signed, **integer minor-unit** entries (the smallest unit of each row's `currency`). Each conversion reward is keyed `(order_id, kind, status)`, so a reward advances `pending → confirmed → clawback` as **separate immutable rows** while a poller re-read of an unchanged order no-ops (the row already exists). A balance is always *derived* — take each reward's **furthest-advanced status**: `confirmed = Σ confirmed rewards + adjustments − withdrawals`, `pending = Σ pending rewards`, a `clawback` terminal state contributes 0; never stored or mutated. This is the one area we intentionally over-invest in (per the lean posture, §3): financial correctness is the most expensive thing to retrofit, and it underpins the auditing requirements (§14).

**Currency — held in settlement currency, converted at withdrawal (not at credit).** Integers (not floats) keep it precision-safe; storing minor units **alongside an ISO-4217 `currency`** — rather than hardcoding agorot — keeps the ledger ready for the PRD's multi-market expansion. The minor-unit scale is derived per currency (ILS/USD = 2 places, JPY = 0, KWD = 3), so no `amount` semantics change when a new currency is added. **The wallet is held in the retailer's settlement currency** (USD for AliExpress): our liability matches our receivable, so there is **no FX float risk and no conversion at credit time** (a reversal of the earlier ILS-at-credit model — F4-R8). The ledger stores amounts in that settlement currency; the wallet returns one balance **per currency held**. It is **displayed** to the member in ILS, converted **net of a conversion commission** (CONFIG `fx.conversionCommissionBps`), and the **real conversion happens only at withdrawal**, gated on the current converted (ILS) value. *FX infrastructure (decided, build pending, §18 #12):* a DynamoDB `fx_rate` cache keyed `(base, quote)` with an `asOf` timestamp, refreshed by a scheduled rates-updater (an FX-provider adapter), and a pure conversion function in `packages/domain` doing exact bigint math (`amountMinor × rate × (1 − commission)`). What's still *deferred*: multiple user-selectable display currencies for other markets and rate hedging — the currency-tagged schema makes that additive, not a migration.

**Entry kinds × status (MVP):** an entry's `kind` is one of `referrer_cashback`, `consumer_reward` (the two-sided consumer share), `adjustment`, or `withdrawal`; a reward row carries a `status` of `pending` / `confirmed` / `clawback`, advancing as separate rows keyed `(order_id, kind, status)`. A `withdrawal` is a **negative standalone event** with `order_id` null (the payout flow itself is **deferred** — no withdrawals in MVP; the kind exists so the ledger and derived balance already account for it).

**Identifying the parties (who gets credited).** The network's order report tells us the **gross commission** Wanthat earned and echoes back our tracking identifiers, but **not** the buyer's identity. We resolve the parties from our *own* data (see §8.1 two-level attribution):
- **Referrer** — from the static `recommendation_id` SubID on the link. Always resolvable. The SubID identifies the *referrer's link*, **not** a referrer+consumer pair (many consumers click the same link, all with the same SubID).
- **Consumer** — from the **consumer key** echoed back in `custom_parameters` (no click log): `c` = the member's `customer_id`; `g` = an opaque `guestId` resolved via the DynamoDB `guest_attribution[g]` mapping. This produces a three-way **`attribution`** status stored on the conversion, so guest and untracked orders are *distinguishable* (not both collapsed to "no consumer"):
  - **`member`** — a `c` key, or a `g` that maps to a registered consumer → `consumer_customer_id` set; consumer reward paid.
  - **`guest`** — a `g` key with no `guest_attribution` mapping (the consumer is still a guest) → no `consumer_customer_id`, no reward, but a *tracked guest* conversion.
  - **`untracked`** — no consumer key echoed (missing/unmatched) → referrer credited via `recommendation_id` only; the buyer is unknown.

  We model this as an explicit status rather than a sentinel id (`0`/`-1`) in the FK column — sentinels in a foreign key break referential integrity and joins, while the status gives the same guest-vs-untracked distinction cleanly (and `untracked` rate = the echo-miss metric, §13).

**Crediting on conversion (F4-R5, D9).** The gross commission `C` arrives in the retailer's settlement currency (USD for AliExpress). There is **no conversion at credit** — amounts are credited in that settlement currency (the wallet is held in it; FX → ILS happens only at withdrawal, F4-R8). The poller-writer splits `C` server-side using the **split rates snapshotted on the Recommendation at link creation** (taken from CONFIG `cashback.referrerBps`/`cashback.consumerBps`, ADR-0008) — so a CONFIG policy change applies to *future* links only and never recomputes existing ones:
- **referrer cashback** = `referrerBps × C` → a `referrer_cashback` row (`pending` then `confirmed`). *(Always.)*
- **consumer reward** = `consumerBps × C` (a configurable default, PRD §8.2), **funded from Wanthat's margin**, not added on top (§3) → a `consumer_reward` row (`pending` then `confirmed`). *(Only for `member` attribution — not guest or untracked.)*
- **Wanthat margin** = the remainder (must stay ≥ 0 — the consumer share is carved out of margin, so a conversion is never loss-making).

The split percentages are CONFIG policy snapshotted on the Recommendation at creation (§18 #3 — forward-only per link). Referrer credit is robust (depends only on `recommendation_id`); consumer credit is best-effort (needs the consumer-key (`c`/`g`) echo *and* a known consumer).

**MVP scope — measure, don't mitigate.** We do **not** build a fallback for missing/unreliable consumer-key echoes in MVP: if the `c`/`g` key doesn't come back, that order simply credits the referrer and no consumer reward is paid. Instead we **instrument the echo reliability** via the conversion **attribution mix** (member / guest / `untracked`), where `untracked`% is precisely the consumer-key echo-miss rate (§13) — so we can quantify the real-world hit rate before deciding whether a fallback is worth building. This keeps MVP simple and turns an unknown into a measured number.

Entries are written with `status='pending'` on a pending conversion and advanced by **appending** a `confirmed` row (and a terminal `clawback` row if the network later rejects), keyed `(order_id, kind, status)` — never by editing prior rows. Every such append writes an audit record (§14).

**Balance views.** `pending` (not yet network-validated), `confirmed` (available-to-accrue; payout deferred), and totals. Referrer balance breaks down per link (F4-R3, UC-06); consumer balance shows cashback per purchase (F4-R4).

### 10.2 Data model (PostgreSQL)

```
wallet_entry            -- append-only event log
  id              uuid pk
  customer_id     uuid not null references customer(id)
  kind            text not null   -- 'referrer_cashback' | 'consumer_reward' | 'adjustment' | 'withdrawal'
  status          text not null   -- 'pending' | 'confirmed' | 'clawback'  (reward lifecycle; advances as new rows)
  amount_minor    bigint not null -- signed integer, smallest unit of `currency` (ISO-4217 exponent)
  currency        text not null   -- ISO-4217; the retailer's SETTLEMENT currency (USD for AliExpress) — no ILS default; FX → ILS is applied at withdrawal/display, not stored here
  order_id        text null       -- the network order the reward derives from; null for 'adjustment' / 'withdrawal'
  link_id         uuid null references link(id)
  conversion_id   uuid null references conversion(id)
  created_at      timestamptz not null default now()
  unique (order_id, kind, status)  -- event-log idempotency: a re-read of an unchanged order no-ops
-- No UPDATE/DELETE permitted (enforced by grants + trigger). Corrections/transitions are new rows.
```

### 10.3 API contract

| Method | Path | Description | Auth | Returns |
| :-- | :-- | :-- | :-- | :-- |
| GET | `/wallet` | Derived wallet balance for the caller (pending vs confirmed) — one balance **per settlement currency held**, plus the ILS display value (converted net of `fx.conversionCommissionBps`) | jwt | `{balances:[{currency, pending, confirmed}], display:{currency:'ILS', pending, confirmed}}` (derived) |
| GET | `/wallet/entries` | The caller's own ledger history | jwt | paginated ledger entries (own customer only) |
| GET | `/links/{id}/earnings` | Earnings breakdown for one of the referrer's links | jwt | per-link pending/confirmed (referrer) |

### 10.4 Security & integrity
Wallet endpoints are scoped to the caller's `customer_id`. The ledger table grants exclude UPDATE/DELETE. Crediting happens only inside the conversion poller-writer (idempotent via the event-log key `(order_id, kind, status)`) — never from a user-facing endpoint. Manual `adjustment`/`clawback` entries require the `admin` role and a reason, and are audited (§14). Payouts are out of scope, so no money leaves the system in MVP.

---

## 11. Feature 5 — Admin Dashboard

*(Requirements: §4.5)*

### 11.1 Design
A small, internal, **read-only** dashboard (MVP) for an `admin`-group operator. It is a thin SPA route plus a few aggregate endpoints; the same auth (Cognito JWT) gated on `cognito:groups` containing `admin`. Stats are computed from Postgres (transactional truth) and the click/conversion stream via scheduled rollups (so the dashboard reads cheap pre-aggregates, not heavy live scans).

**Stats (F5-R2/R3/R4):** total & new customers (referrers/consumers), links generated, impressions, clicks, **click-through rate** (clicks/impressions, PRD §3.2), conversions, conversion rate, GMV, gross commission, **wallet liabilities** (Σ pending + Σ confirmed owed), simple time trends, top links / top referrers. **Health (F5-R5):** redirect p95, AliExpress error rate, conversion-poller lag / reconciliation gap (surfaced from §13 metrics). This is the deliberately-simple seed of the Phase-2 brand analytics product — internal only.

### 11.2 API contract

| Method | Path | Description | Auth | Returns |
| :-- | :-- | :-- | :-- | :-- |
| GET | `/admin/stats/overview` | Headline KPIs and wallet liabilities at a glance | jwt + admin | headline counts + liabilities |
| GET | `/admin/stats/trends?metric=&period=` | Time series for a chosen metric/period | jwt + admin | time series |
| GET | `/admin/stats/top?by=links\|referrers` | Leaderboards of top links or referrers | jwt + admin | leaderboards |
| GET | `/admin/health` | Operational health snapshot (redirect/AliExpress/conversion-poller) | jwt + admin | redirect/AliExpress/poller health |

### 11.3 Security
Admin role enforced at the authorizer (group claim) *and* re-checked in the module (defense in depth). Read-only in MVP; any future write (manual adjustment) is admin-gated, reason-required, and audited (§14). All admin reads are themselves logged (who viewed what) per §13/§14. Least-privilege: the admin module can read aggregates and write only audited adjustments.

---

## 12. Cross-cutting Concerns

**Configuration & secrets.** All secrets in Secrets Manager; **boot-time** config via environment with typed validation at boot (fail fast, the `Env` env-var contract). No secret in the repo. **Admin-tunable *runtime* settings live in a separate generic key-value DynamoDB `config` table** — each value validated per-key by a contracts registry, written by `admin-api` (audited) and read where needed (e.g. the redirect path reads `landing.countdownSeconds`). Keys so far: `landing.countdownSeconds`, `cashback.referrerBps`, `cashback.consumerBps`, `fx.conversionCommissionBps`.

**Testing strategy.** *Unit:* validation, AliExpress signing (vs independent HMAC), retailer detection, dedupe, ledger-sum, commission split. *Integration:* auth against a Cognito test pool; link gen against an AliExpress sandbox/contract mock; redirect + idempotent conversion poller; DB constraints (unique phone/email/referral/link; ledger `(order_id, kind, status)`); ledger append-only enforcement. *Contract:* recorded AliExpress fixtures. *E2E (walking skeleton):* register → generate link → consumer clicks → guest/registered redirect → simulated conversion → ledger credit → admin stats reflect it.

**Environments & IaC.** `dev`/`staging`/`prod`, all via IaC (CDK or Terraform); Cognito, DB, stream, secrets, API per environment; no manual console changes.

Observability (§13) and payment auditing (§14) are first-class and specified separately because they apply to every flow.

---

## 13. Observability (all flows)

Every flow emits structured JSON logs with a propagated **correlation/trace id**, RED metrics (rate/errors/duration), and traces (X-Ray / OpenTelemetry) across API → adapters → DB/stream. PII is redacted in logs (no phone/email/tokens). Log retention meets compliance; financial-event logs align with audit retention (§14).

| Flow | Log (with corr-id) | Key metrics | SLO / alert |
| :-- | :-- | :-- | :-- |
| Auth (register/login/verify) | attempt, outcome, OTP channel; **no codes/PII** | verify success rate, OTP send count/cost, lockouts | alert on OTP send spike (toll-fraud), verify success drop |
| Link generation | retailer, latency, upstream status | p95 latency, AliExpress error rate, gen volume | **p95 < 1.5s**; alert on error rate > X% |
| Consumer redirect | recommendation_id, guest/registered, impression vs click, 301 target | **p95 < 500ms**, impressions, clicks, CTR, 4xx rate, event-ingest lag | **p95 < 500ms**; alert on 5xx or Firehose backlog |
| Conversion poller | order_id, match result, amount, attribution (member/guest/untracked) | poll lag / reconciliation gap, referrer-match rate, **attribution mix: member / guest / `untracked`%**, duplicate rate | alert on poll lag > N min, unmatched-conversion rate; **track `untracked`% as a product metric** |
| Wallet crediting | conversion_id, entries written, split | credited amount pending/confirmed, failures | alert on crediting failure (paged — money path) |
| Admin | actor, query, **who-viewed-what** | usage, latency | alert on auth-bypass attempts |

Global: CloudWatch (or Grafana) dashboards per flow; synthetic canaries on `/p/*` and `/links`; business metrics (signups, links, impressions, clicks, CTR, conversions, ₪ pending/confirmed) on one operational dashboard shared with §11.

---

## 14. Auditing (payment-related flows)

Every event that creates or changes financial state is recorded in an **append-only, write-once audit log**, independent of the ledger. The ledger (§10) is the financial source of truth; the audit log records the *who / what / when / why* of each mutation for tamper-evident traceability. Applies now to crediting, splits, clawbacks, and manual adjustments; **payouts are deferred but will be audited the same way when added.**

**Requirements**
- **Coverage:** conversion crediting, two-sided split, clawback/reversal, manual `adjustment`, and any admin action touching money. Each audit entry references the resulting `wallet_entry`/`conversion`, the actor (system poller vs named admin), the source event (network `order_id`), and before/after balances.
- **Immutability & tamper-evidence (D8):** write-once **Postgres** store — no UPDATE/DELETE grants; entries **hash-chained** (each row carries the prior row's hash) so any alteration is detectable. *(Decided: hash-chained table, not QLDB — §18 #7; revisit QLDB only if cryptographic verifiability becomes a hard requirement.)*
- **Separation of duties:** manual adjustments require the `admin` role + a mandatory reason; the actor is recorded. Second-person approval for large adjustments is deferred (maybe later — §18 #8).
- **Reconciliation:** scheduled reconciliation of network-reported commissions vs ledger; discrepancies flagged to the admin dashboard and alerted (§13).
- **Idempotency:** crediting keyed on the event-log `(order_id, kind, status)` so poller re-reads of an unchanged order never double-credit; re-reads are themselves audited as no-ops.
- **Retention & access:** financial audit retained per Israeli tax/accounting obligations (multi-year); access to audit data is least-privilege and itself logged.

```
audit_log               -- append-only, hash-chained
  id              uuid pk
  ts              timestamptz not null default now()
  actor_type      text not null     -- 'system' | 'admin'
  actor_id        text null         -- admin customer_id / service name
  action          text not null     -- 'credit'|'split'|'clawback'|'adjustment'|'view'
  conversion_id   uuid null
  wallet_entry_id uuid null
  reason          text null
  before_json     jsonb null
  after_json      jsonb null
  prev_hash       text not null
  row_hash        text not null     -- H(prev_hash || canonical(row))
```

---

## 15. Non-functional alignment (PRD §10.3)

| NFR | Target | How met |
| :-- | :-- | :-- |
| Link-gen latency | < 1.5s | ≤1 required upstream call; metadata async (§8.1) |
| Redirect latency | < 500ms | dedicated landing service; click logged off-path via stream (§9.1) |
| Auth friction | first action in-session | passwordless OTP; immediate post-verify routing |
| Attribution accuracy | within 2% | SubID (`custom_parameters`) attribution; idempotent reconciliation poller (§8.1, §9) |
| Availability | 99.5% MVP | serverless + managed services; redirect isolated from app API |
| Security | OAuth2, no raw passwords | Cognito OTP + JWT; SSRF-safe link gen; open-redirect-safe (§9) |
| Data residency | GDPR/IL | IL/EU region for Cognito + DB + stream |
| Auditability | full payment trail | append-only ledger + hash-chained audit log (§10, §14) |

---

## 16. Build sequence

1. Postgres schema + migrations (`customer`, `referral`, `link`, `retailer_demand`, `conversion`, `wallet_entry`, `audit_log`); ledger append-only grants.
2. Cognito pool (+ `admin` group) + Post-Confirmation provisioning → Feature 1.
3. AliExpress signed client + `AliExpressAdapter` (SubID) → Feature 2.
4. Landing service + Firehose click stream + interstitial → Feature 3 (guest path first, then register path).
5. Conversion poller (EventBridge → listOrders → in-VPC writer) → ledger crediting + two-sided split + audit log → Feature 4 + §14.
6. Wallet read APIs + admin stats rollups → Feature 4 / Feature 5.
7. Observability wired across all flows (§13).
8. Walking-skeleton E2E (register → link → click → convert → credit → admin) on real infra.

---

## 17. Risks

| Risk | Impact | Mitigation |
| :-- | :-- | :-- |
| SMS OTP toll-fraud | Cost spike | WhatsApp-first OTP, rate limits + WAF (§5.1) |
| Click / conversion fraud (self-click, bots, self-referral) | Wrong payouts later, network TOS risk | Idempotent poller (event-log key); flag `consumer==referrer`; anomaly hold; never auto-confirm suspicious |
| Open redirect on `/p/*` | Abuse / phishing | Only redirect to stored affiliate URLs (F3-R7) |
| Guest→register attribution leakage | Lost/incorrect rewards | Signed attribution token + window-bound linking (F3-R6) |
| Two-sided reward gaming | Margin erosion | Split capped to margin (D9); fraud holds; admin review |
| Audit/ledger integrity | Financial disputes | Append-only + hash-chain (D8, §14); reconciliation |
| AliExpress API approval delays | Blocks Feature 2 | Adapter mock unblocks dev; pursue access in parallel |
| Per-click sub-value not reliably echoed by the network → missed consumer rewards | Some two-sided rewards not credited | **MVP: not solved by design** — referrer still credited; instrument the consumer-attribution rate (§13) to measure real impact before building any fallback |
| Referrer review is user-generated content (profanity, PII, defamation, false claims) | Trust / legal exposure when shown to consumers (F2-R11, §9.1) | Length cap + profanity/PII filter on submit; report-abuse; human moderation queue before public display; full moderation later |

---

## 18. Open Questions (decisions needed at review)

1. **Identity provider (D3) — decided: Cognito.** Chosen for speed and native support (phone OTP, JWT, passkeys, role groups), accepting deeper AWS lock-in. The identity/profile separation (§7.1) keeps app data portable, so Auth0/Clerk stay drop-in alternatives if we ever revisit.
2. **OTP channel — decided: WhatsApp-first, SMS fallback.** WhatsApp Business API is the primary OTP channel (cheaper than SMS and avoids SMS-pumping toll fraud — both the top cost and top abuse surface); SMS is the fallback when WhatsApp delivery isn't available.
3. **Two-sided split (D9) — decided:** cashback = the retailer's reported commission × **our split** (`referrerBps` / `consumerBps`). Our split is **admin policy living in CONFIG** (`cashback.referrerBps` / `cashback.consumerBps`), **snapshotted onto the Recommendation at creation** so a link's economics are **locked** — a later CONFIG change affects **new links only**, never existing/pending conversions (no retroactive recompute). The consumer share is funded from margin, which stays ≥ 0 by construction.
4. **Guest→register window — decided:** Wanthat's **first-party attribution cookie = 30 days, configurable** (remembers the click for linking + re-engagement). Separately, the **network commission window is per-platform** (the adapter's `attributionWindowDays` — AliExpress = 3 days) and governs whether a purchase actually earns commission. (Cookie-consent handling still required.)
5. **Enumeration (§7.5) — decided:** uniform login response + no-OTP-send for unknown numbers; register-path `409` accepted for MVP (option a) with rate limiting. Revisit (option b: owner-notification) only if enumeration abuse appears.
6. **Datastore (D4) & event store (D7) — decided:** managed **PostgreSQL** for transactional data; **Kinesis Firehose → S3** for the high-volume impression/click/conversion stream (with async rollups to the `link` counters).
7. **Audit store (D8) — decided:** append-only, write-once, **hash-chained Postgres table** (cheap, no extra infra, no lock-in). QLDB is not pursued for MVP; revisit only if cryptographic verifiability becomes a hard requirement.
8. **Admin access — decided:** Cognito **`admin` group** (no separate SSO for MVP); enforced at the API Gateway authorizer and re-checked in the admin module (§11.3). Second-person approval for large manual adjustments is **deferred** (maybe later) — MVP requires admin role + mandatory reason + audit (§14).
9. **Payouts — confirmed out of MVP.** No withdrawals in MVP; balances accrue (pending/confirmed) until a later payout phase. The ledger + audit log are already shaped to add payouts without rework.
10. **Biometric sign-in — decided: include as an opt-in step-up.** Passkeys/WebAuthn (Face ID/Touch ID) offered *after* the first OTP sign-in (Cognito-native, Essentials tier) — cuts repeat-login SMS cost and is phishing-resistant. Phone-OTP stays primary enrollment + recovery; biometrics are never the day-1 first-touch method (first-touch friction; WhatsApp in-app browser WebAuthn gaps).
11. **Profile name — decided:** collect **both** first and last name at registration; **display only the first name** to consumers (interstitial / share), keep last name internal.
12. **Currency & FX — decided: hold in settlement currency, convert at withdrawal (a reversal of the old convert-at-credit model).** The wallet is **held in the retailer's settlement currency** (USD for AliExpress) so our liability matches our receivable (zero FX float); the ledger stores settlement-currency amounts, the balance is **displayed** in ILS net of a conversion commission (CONFIG `fx.conversionCommissionBps`), and the **real conversion happens only at withdrawal**, gated on the converted (ILS) value (F4-R8, §10.1). *FX infrastructure — decided, build pending:* a DynamoDB `fx_rate` cache keyed `(base, quote)` with an `asOf` timestamp, a scheduled rates-update function (FX-provider adapter) refreshing it, and a pure conversion function in `packages/domain` doing exact bigint math (`amountMinor × rate × (1 − commission)`). *Still open:* the **FX provider** choice and the **spread/rounding** policy; the **₪50 withdrawal threshold** is evaluated on the converted (ILS) value. *Deferred:* multiple user-selectable display currencies for other markets and rate hedging — additive on the currency-tagged schema, not a migration.

---

## Appendix A — AliExpress Affiliate API signing

`aliexpress.affiliate.link.generate` on the System Interface gateway `https://api-sg.aliexpress.com/sync`.

- **System params:** `app_key`, `method`, `v=2.0`, `format=json`, `sign_method=sha256`, `timestamp` (epoch ms as string).
- **Business params:** `promotion_link_type` (0 = normal), `source_values` (product URL(s), comma-separated, ≤50), `tracking_id`; our `recommendation_id` carried as the SubID/custom tracking string.
- **Signature (sha256 / current gateway):** sort all params except `sign` by key ASCII-ascending; concatenate `key+value` with no separators; `sign = HMAC_SHA256(appSecret, baseString)` → hex, **uppercase**.
- **Legacy MD5 gateway (`gw.api.taobao.com/router/rest`) — not used by Wanthat.** Documented only for awareness; it's deprecated and uses a weak hash. The MVP uses the HMAC-SHA256 gateway above exclusively. (The POC includes an MD5 path for completeness; production does not need it.)
- **Response:** nested under `…link_generate_response.resp_result.result.promotion_links.promotion_link[]`; each item has `source_value` + `promotion_link`. Platform errors arrive as `error_response{code,msg}`.

A reference implementation and unit tests exist in `wanthat-poc/src/lib/aliexpress.js`.

---
*End of draft v0.2 — ready for review.*
