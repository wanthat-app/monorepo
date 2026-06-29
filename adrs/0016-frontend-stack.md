# ADR 0016 — Frontend stack: Vite + React SPA

- **Status:** Accepted
- **Date:** 2026-06-28
- **Related:** [ADR-0007](0007-landing-path-and-latency.md) (OG landing is server-side; cookieless), [ADR-0006](0006-identity-sms-otp-and-passkeys.md) (auth via our `/auth/*`)

## Context

The web app is a **pure authenticated client** (browse, generate links, wallet) served as **static
files from S3 + CloudFront** (EdgeStack), talking to the HTTP API. It has **no SSR/SEO need** — OG
unfurling for shared `/p/{id}` links is rendered server-side by the landing Lambda (ADR-0007). The
app is cookieless (ADR-0007) and Israeli (Hebrew/RTL primary).

## Decision

- **Vite + React + TypeScript SPA**, static build → S3/CloudFront. Lean, fast, ESM-native
  (ADR-0010); drops straight onto the static EdgeStack with no extra infra.
- **React Router** (routing) · **TanStack Query** (server state / API caching).
- **Thin auth client against our `/auth/*`** (no Amplify): JWT held in memory + refresh, attached
  as a Bearer header; **WebAuthn** browser API for passkeys. The SPA never calls Cognito directly.
- **Tailwind** (RTL-enabled) · **react-i18next** (`he`/`en`) — RTL/i18n first-class from day one.

## Alternatives considered

- **Next.js static export** — Next's conventions and build weight with SSR disabled; no payoff for
  a pure SPA.
- **Next.js SSR (OpenNext/Lambda)** — contradicts the static-S3 EdgeStack and adds a compute
  surface; OG unfurling is already solved by the landing Lambda. Rejected.
- **AWS Amplify auth** — unnecessary weight; our API fronts Cognito (ADR-0006), so a thin client
  suffices.

## Consequences

- No SSR server to run or pay for; the SPA is cacheable static assets at the edge.
- The SPA depends only on our HTTP API contracts (shared Zod types, ADR-0001), not on Cognito SDKs.
- RTL and i18n are designed in from the start, not retrofitted.
