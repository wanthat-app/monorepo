# Wanthat — Social Affiliate Platform
*Product Requirements Document — MVP v1.0*

> **Note:** the authoritative source for technical/architecture decisions is [`../adrs/`](../adrs)
> (ADR-0001–0009). Where this PRD and an ADR differ, the ADR wins. Most notably, the first-touch
> OTP channel is **SMS** (with passkeys for repeat login), not WhatsApp — see ADR-0006.

> Earn cashback by sharing what you love. The first platform where every everyday shopper becomes an affiliate — automatically.

| Field | Value |
| :---- | :---- |
| Status | Draft — v1.0 |
| Date | May 2026 |
| Market | Israel (MVP) → WhatsApp-native markets → Global |
| Owner | Founder / Product Lead |
| Phase | MVP: Core link generation, wallet, individual sharing. Phase 2: Group sharing, data dashboard, brand partnerships. |

## 1. Executive Summary

Wanthat is a social affiliate platform that lets any person earn cashback by sharing links to products they have genuinely purchased. Unlike traditional cashback platforms (Rakuten, Honey) where users earn only on their own shopping, Wanthat rewards the social recommendation — the link you send to a friend when they ask "where did you get that?"

The platform operates as a single registered affiliate across major e-commerce networks (AliExpress, Awin/CJ, eBay). When a user generates a tracked link through Wanthat and a friend purchases via that link, the affiliate commission flows to Wanthat, which shares the majority back to the original recommender as cashback.

**Key insight:** People already share product links every day in WhatsApp, iMessage, and social media — and get nothing back. Wanthat monetizes a behavior that already exists without changing it.

The MVP targets the Israeli market, where AliExpress holds over 66% of all e-commerce orders and WhatsApp group culture makes peer product-sharing a deeply embedded daily behavior.

## 2. Problem & Opportunity

### 2.1 The Problem

- **Everyday shoppers** — Word-of-mouth recommenders get nothing back. Millions share product links every day after buying and loving a product. They influence purchases worth billions — and earn zero.
- **Cashback users** — Traditional cashback platforms reward passive shopping, not active recommendation. Rakuten and Honey require users to remember to shop through the platform. They capture no social signal.
- **Brands & retailers** — Brands pay enormous sums for influencer marketing that feels inauthentic. They have no visibility into organic peer-to-peer recommendations, which convert at significantly higher rates than paid content.

### 2.2 The Opportunity

| Market Signal | Stat | Implication |
| :---- | :---- | :---- |
| AliExpress in Israel | 66% of all online orders | Primary integration target for MVP |
| Israeli social media usage | 94% of internet users active on social | Sharing behavior is deeply embedded |
| Israeli WhatsApp penetration | Among highest globally | Primary sharing channel for the product |
| Affiliate cookie — AliExpress | 3-day window | Share messages must create urgency |
| Global affiliate market | $17B+ industry (2024) | Proven commercial model to build on |
| Unrewarded recommendations | Word-of-mouth drives 20-50% of purchases | The core unmonetized asset |

## 3. Goals & Success Metrics

### 3.1 MVP Goals

1. Validate that users will generate a tracked link from a product they bought (link generation behavior).
2. Validate that friends click those links at a meaningful rate (click-through behavior).
3. Validate that enough clicks convert to purchases to generate real cashback earnings (conversion rate).
4. Validate that users return to generate a second link after earning their first reward (retention signal).

### 3.2 MVP Success Thresholds

*If all four thresholds are met at Month 3, proceed to Phase 2 build and pre-seed fundraise. If not, iterate UX before expanding.*

| Metric | Target (Month 1) | Target (Month 3) | Why It Matters |
| :---- | :---- | :---- | :---- |
| Active users generating links | 100 | 500 | Core adoption signal |
| Links generated per active user / month | 2+ | 4+ | Measures habit formation |
| Click-through rate on shared links | >15% | >20% | Validates trust in recommendation |
| Conversion rate (click → purchase) | >3% | >6% | Industry avg is 1-3%; aim above |
| 30-day user return rate | >30% | >50% | Key retention proof point |
| Avg cashback earned per active user / month | >₪5 | >₪20 | Reward must feel meaningful |

## 4. User Personas

**Persona 1 — The Recommender (Primary User).** Michal, 34, Tel Aviv. Regular AliExpress & Shein shopper. Active in 4 WhatsApp family and friends groups. Frequently asked "where did you buy that?" and shares links naturally. Not a content creator. Has no idea what affiliate marketing is. Goal: get something back for recommendations she already makes. Doesn't want a second job. Pain point: generating a special link feels like friction — she just wants to copy a URL and paste it. Trigger: "Wait — I can earn money for links I already share?" Learns via friend who already earns.

**Persona 2 — The Recipient / New User.** Yoni, 29, Haifa. Receives a Wanthat link from a friend on WhatsApp. Clicks through to an AliExpress product. Sees a small banner explaining the platform. Buys the product. Potentially signs up to start sharing himself. Goal: buy the product, trust that the link is safe and not spam. Pain point: unfamiliar link domains feel untrustworthy. Opportunity: every recipient is a potential new Recommender. The click → signup flow is the primary acquisition loop.

**Persona 3 — The Power Sharer (Phase 2).** Roni, 41, Jerusalem. Runs a 200-member WhatsApp group of neighbors and coordinates group buys. Already informally recommends products weekly. Once Wanthat exists, becomes a top earner by sharing curated links to the group. Generates ₪300–800/month passively. Phase 2 need: group sharing mechanic, earnings dashboard, ability to see which products convert best in their network.

## 5. Feature Scope — MVP vs Phase 2

| Feature | Priority | MVP | Phase 2 | Notes |
| :---- | :---- | :---- | :---- | :---- |
| User registration (email + phone) | P0 | YES | YES | Phone for Israeli WhatsApp auth |
| Link generator (paste URL → get tracked link) | P0 | YES | YES | Core product mechanic |
| AliExpress affiliate integration | P0 | YES | YES | #1 platform in Israel |
| Awin/CJ network integration | P0 | YES | YES | Unlocks 25K+ retailers |
| eBay Partner Network integration | P1 | YES | YES | Popular in Israel |
| Earnings wallet + balance display | P0 | YES | YES | Key engagement driver |
| WhatsApp share template (auto-disclosure) | P0 | YES | YES | FTC/legal compliance built-in |
| Link click + conversion tracking | P0 | YES | YES | Core analytics |
| Cashback payout (bank transfer / PayPal) | P1 | YES | YES | Min payout ₪50 |
| Browser extension (Chrome) | P1 | YES | YES | Zero-friction link gen on desktop |
| Mobile app (iOS + Android) | P2 | NO | YES | Web-first for MVP |
| Group sharing mechanic | P1 | NO | YES | Core viral loop — Phase 2 priority |
| Two-sided reward (recipient cashback) | P1 | NO | YES | Trust mechanic + viral acquisition |
| Product review collection | P2 | NO | YES | Data layer begins Phase 2 |
| Brand analytics dashboard | P2 | NO | YES | B2B revenue stream |
| Amazon Associates integration | P2 | NO | YES | Requires partnership negotiation |
| Hebrew + English UI | P0 | YES | YES | Hebrew MVP, English Phase 2 |
| Earnings history + per-link stats | P1 | YES | YES | "Which link earned most" motivation |
| My Links library (all generated links) | P1 | YES | YES | Browse, re-share, search past links. Data already stored — UI layer only. |
| Referral program (invite a friend) | P1 | YES | YES | Growth loop seeding |

## 6. User Use Cases

### UC-01: Recommender shares a product link (Core Flow)
- **Actor:** Recommender (registered user)
- **Trigger:** User bought a product and wants to share it when asked, or proactively in a WhatsApp group
- **Precondition:** User is signed in. Product is on a supported retailer (AliExpress, eBay, Awin network)
- **Goal:** Generate a tracked Wanthat link and share it — earning cashback if a friend buys
- **Success:** Friend receives link, clicks it, purchases product. Recommender's wallet increases. Notification sent.

Steps: (1) User pastes product URL into link generator. (2) System detects retailer, fetches product name/thumbnail via affiliate API, generates tracked redirect wanthat.app/p/[ID]. (3) User sees preview card (image, name, retailer, estimated commission), clicks Copy Link or Share to WhatsApp. (4) System pre-fills FTC-disclosure message template. (5) User sends link. (6) Recipient clicks, sees 2-second branded overlay, lands on product page. (7) Recipient purchases within 3-day cookie window. (8) Affiliate network reports conversion; commission credited to Wanthat; wallet updated within 24–48h. (9) Push/email sent to Recommender. (10) User sees updated balance.

### UC-02: New user onboarding (Recipient becomes Recommender)
Recipient clicks link → 2-second overlay → lands on product page → buys → post-purchase interstitial "you can earn too" → signs up (phone OTP + email, no password) → welcome 3-step animation → generates first link within session (key activation metric).

### UC-03: User checks earnings and requests payout
Dashboard → Wallet shows Total earned / Pending / Available + per-link history → tap link for detail (clicks, conversions, earned) → Withdraw when balance ≥ ₪50 → choose bit/Paybox/PayPal → confirm, 5–7 business days.

### UC-04: Unsupported retailer — graceful failure
User pastes unsupported URL → friendly message "We don't support [Retailer] yet" → offer "Suggest this retailer" (logs demand) or "See supported stores" → thank-you.

### UC-05: Browser extension — zero-friction link generation (MVP)
On supported product page → click extension icon → popup shows thumbnail/name/commission + Copy Link / Share to WhatsApp Web → copy → paste into chat. Same tracking flow as UC-01.

### UC-06: My Links — browsing and re-sharing previously generated links
Dashboard → My Links → scrollable list (thumbnail, name, retailer, date, clicks, conversions, earned) → filter/sort/search → tap entry for detail with same tracked link → Copy / Share to WhatsApp → re-share accumulates to same link's stats. The My Links library is the product's long-term engagement surface.

## 7. System Flows

### 7.1 Link Generation & Tracking Flow
User pastes URL → retailer detection → affiliate network lookup → deep link generated with Wanthat affiliate tag → stored as wanthat.app/p/[trackingID] linked to user → (on click) branded overlay → 301 redirect with affiliate tag → (on purchase) network conversion postback → Wanthat webhook → commission allocated (pending → confirmed) → push notification.

### 7.2 Affiliate Network Integration Architecture
Wanthat acts as a single publisher across multiple affiliate networks, abstracting retailer complexity from the user.

| Network | Key Retailers | Integration Method | MVP Priority |
| :---- | :---- | :---- | :---- |
| AliExpress Direct | #1 in Israel — 66% market share | AliExpress Affiliate API + Awin fallback | P0 — Day 1 |
| Awin Network | Etsy, Under Armour, HP, 25K+ brands | Awin Publisher API, deep link generator | P0 — Day 1 |
| CJ Affiliate | Large US/global retailers | CJ Publisher API | P1 — Month 2 |
| eBay Partner Network | eBay Israel — popular secondhand | EPN API | P1 — Month 2 |
| Amazon Associates | amazon.com (direct, not .il) | Direct Associates API | P2 — Phase 2 |

## 8. Phase 2 Features (Post-MVP)
- **8.1 Group Sharing** — the killer feature for Israel's group-first WhatsApp culture. One group link; every member who purchases earns the Recommender a commission. Live group dashboard, optional two-sided reward, optional expiry.
- **8.2 Two-Sided Reward** — recipient also earns small cashback (e.g. 20% of Recommender's commission, funded from margin). Shifts dynamic to "sharing a deal" and creates viral acquisition loop.
- **8.3 Product Review Layer** — post-conversion review prompt; verified-buyer, peer-recommended reviews tied to social graph. Monetized via anonymized data.
- **8.4 Brand Analytics Dashboard** — B2B SaaS showing organic peer-to-peer recommendation intelligence by product, demographic, geography, conversion rate.
- **8.5 Mobile App (iOS + Android)** — share-sheet integration is the key feature, making link generation as fast as copy-URL.

## 9. Legal & Compliance Requirements
- **9.1 FTC / Advertising Disclosure** — every shared link carries an affiliate disclosure (US FTC, EU, Israeli Consumer Protection Law). Disclosure is user-editable but a minimum tag is always appended. Redirect overlay doubles as consumer-facing disclosure.
- **9.2 Affiliate Network TOS Compliance** — Wanthat is the single registered affiliate/publisher; users are customers of Wanthat, not sub-affiliates. Model used by Rakuten, Honey/PayPal, TopCashback. No redirect cloaking.
- **9.3 Data Privacy (GDPR / Israeli Privacy Law)** — purchase/click data not shared without consent; aggregated/anonymized for analytics; GDPR-compliant policy required; EU/Israeli data centers for MVP.
- **9.4 VAT Risk Monitor** — Israel considering removing VAT exemption on international purchases under $75. Mitigation: accelerate onboarding of Israeli domestic retailers.

## 10. Technical Requirements (MVP)

### 10.1 Core Infrastructure
- Web app: React or Next.js front-end, Node.js or Python backend, PostgreSQL database
- Link shortener/tracker: custom redirect service at wanthat.app/p/[ID] with click logging
- Affiliate API integrations: AliExpress Affiliate API, Awin Publisher API
- Webhook listener: receives conversion postbacks in real time
- Wallet engine: tracks pending vs confirmed commissions per user, handles Wanthat's revenue cut
- Notification service: Email + WhatsApp Business API

### 10.2 Browser Extension
- Chrome extension (Manifest V3); auth shared with web app via secure token; available from Chrome Web Store Day 1.

### 10.3 Non-Functional Requirements
| Requirement | Target |
| :---- | :---- |
| Link generation latency | < 1.5s from URL paste to tracked link ready |
| Redirect speed | < 500ms |
| Uptime | 99.5% MVP — 99.9% Phase 2 |
| Conversion attribution accuracy | Within 2% of network figures |
| Mobile web performance | Core Web Vitals passing |
| Security | HTTPS everywhere, OAuth2, no raw passwords, PCI-DSS not required |

## 11. MVP Roadmap
| Phase | Timeline | Deliverables | Exit Criteria |
| :---- | :---- | :---- | :---- |
| 0 — Foundations | Weeks 1–4 | Affiliate API integrations (AliExpress + Awin). Link generator web app. User auth (phone OTP). Basic wallet. | Link generator works end-to-end for 5 test users |
| 1 — Alpha | Weeks 5–8 | Chrome extension. WhatsApp share template. Click + conversion tracking. Earnings dashboard. | 50 internal users generating real links. First tracked conversion. |
| 2 — Beta | Weeks 9–12 | Referral program. Payout flow (bit/PayPal). eBay integration. Recipient onboarding. Hebrew UI polished. | 500 active users. First organic acquisition via referral link. |
| 3 — Decision point | Month 3 | Analyze metrics vs Section 3.2. User interviews. Retention cohort analysis. | Go/no-go decision. |
| 4 — Phase 2 prep | Months 4–6 | Group sharing. Two-sided reward. Mobile app (iOS first). English UI. CJ/Amazon prep. | Phase 2 launch with 2,000+ active users. |

## 12. Open Questions & Decisions Needed
1. **Revenue split:** Wanthat's commission split? (e.g. user 70% / Wanthat 30%). Needs financial modeling.
2. **Payout minimum:** ₪50 proposed. Lower = more cashouts/higher ops cost; higher = frustration.
3. **Brand:** Domain and brand name? "Wanthat" is working title. Needs Israel trademark check.
4. **Support model:** Who handles commission disputes? Networks have 15–60 day dispute windows; users ask "where is my money?" within 48h.
5. **Legal structure:** Israeli Ltd (חברה בע"מ) or Delaware C-Corp from day one? Affects fundraising optionality.

---
*Wanthat — PRD v1.0. Confidential — for internal use and investor discussions only. Source: [Google Doc](https://docs.google.com/document/d/1JeljuOcxYn8fAMFq3NFMY9MX5huluzbSlPwce-V4YzE/edit)*
