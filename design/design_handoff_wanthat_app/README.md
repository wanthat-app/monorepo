# Handoff: Wanthat Consumer App

## Overview
Wanthat is a cashback app for Israeli shoppers. A user shops AliExpress (and other partners) through a wanthat referral link; confirmed purchases earn real cash back into a wanthat wallet, which the user withdraws to a bank account, credit card, Bit, or PayBox. This package covers two consumer product flows, an internal admin console, plus the design system:

1. **Shared-Product / acquisition flow** — what a *new* user sees when they open a referral link a friend shared. Product details + earn pitch → sign up → phone → OTP → personal details → enable Face ID → redirect back to the store (now logged in and attributed).
2. **Wallet flow** — the authenticated app: logged-out landing → log in / register → **Home** (wallet dashboard: balance, pending, withdraw, recent activity) → activity, earning detail, create-link, **withdraw (multi-method)**, profile.
3. **Admin / Operations console** — an internal **desktop web** back-office (separate from the consumer app, English-only, LTR) for the wanthat team to monitor cashback performance and configure the platform. Two sections: a **Dashboard** (KPIs, payout chart, status breakdown, merchant-filterable approvals queue + top links) and a **Configuration** page (margin/split rates, payouts, automation).

The app is **bilingual (English + Hebrew)** and must work **RTL** in Hebrew. It is **responsive** — a mobile app layout and a wider desktop web layout share the same screens.

## About the Design Files
The files in `designs/` are **design references created in HTML** — prototypes that show the intended look, copy, and behavior. **They are not production code to copy directly.** They are authored in a small in-house template runtime (`.dc.html` + `support.js`); do **not** port that runtime. The task is to **recreate these designs in the target codebase's environment** (React, React Native, SwiftUI, etc.) using its established components, i18n, routing, and state patterns. If no app environment exists yet, pick the most appropriate framework for a bilingual, RTL-capable consumer app and build there.

To view the prototypes: open any `designs/*.dc.html` in a browser. A sticky preview toolbar (top) toggles **EN ⇄ עברית** and **Mobile ⇄ Desktop** — that toolbar is a prototype affordance only, not part of the product UI.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, radii, copy (both languages), and interactions are all settled. Recreate the UI pixel-accurately using the codebase's libraries. Exact tokens are in **Design Tokens** below; the same values appear verbatim in `designs/Wanthat Design System.dc.html`.

## Languages & RTL (read first)
- Two locales: **en** (LTR) and **he** (Hebrew, RTL). Default shown in the prototype is Hebrew.
- All copy is stored as an i18n dictionary keyed by locale (see the `T = { en: {...}, he: {...} }` object in each flow's logic). Lift the strings from there.
- When locale is Hebrew, the app root is `dir="rtl"`; use logical properties (`margin-inline-start`, `padding-inline-end`, etc.) rather than left/right so layouts mirror automatically.
- **Money is always LTR and uses tabular numerals**, with the ₪ symbol leading, even in Hebrew (e.g. `₪142.50`). Wrap monetary figures in `dir="ltr"` and a tabular-numerals style.
- Fonts are locale-aware: Latin uses Hanken Grotesk (UI/body) + Space Grotesk (display/wordmark); Hebrew uses **Heebo**.
- Preferred language is also a field on the registration **Personal details** screen (segmented EN / עברית control), so the user can set it during signup.

## Screens / Views

> Layout note: every screen renders inside a centered column. On **mobile** the frame is a phone (~390px wide, full-height, single column). On **desktop** the same content sits in a centered card / max-width column (~430–480px for forms, wider for the home dashboard) on a `#E9EDEB` page. Form screens cap content at `max-width:430–480px; margin:0 auto`.

### Shared-Product / Acquisition flow (`designs/Wanthat Shared Product - Flow.dc.html`)
1. **Referral landing** — entry when opening a shared product link. Shows the **product card** (image, title, price) the friend shared, a short "earn cashback when you buy this" pitch, primary **Sign up to earn**, secondary **Log in**, and a low-emphasis **Continue as guest — no cashback** (guests earn nothing and go straight to the store). Product image asset: `assets/product-feeder.jpg`.
2. **Phone** — country code (+972) prefix + phone input; **Send code**. Helper text about SMS.
3. **OTP** — 4-digit code input (LTR, tabular, letter-spaced), **Verify**, resend countdown, a reassurance chip.
4. **Personal details** — first name, last name, email; **preferred-language** segmented control (EN / עברית); a **terms & privacy** checkbox where "Terms" and "Privacy policy" are links to the respective documents. Continue is disabled until the box is checked.
5. **Enable Face ID** — value prop for biometric sign-in; **Enable Face ID** primary + **Skip for now** text button. (Real implementation: WebAuthn/passkey on web, platform biometrics on native.)
6. **Redirect to store** — "You're signed in, taking you to <product>…" interstitial; the now-attributed user is sent to the partner store automatically.

### Wallet flow (`designs/Wanthat Wallet - Flow.dc.html`)
1. **App landing (logged-out)** — generic wanthat pitch with **Create account** and **Log in**. Includes a dark balance card explicitly marked **Sample** with a caption ("illustrative balance — your real cashback appears once you join"); the figure **animates** through several amounts (~1.8s cadence) so no specific number reads as a promise. Do not show a real or fixed balance to logged-out users.
2. **Phone / OTP / Personal details / Enable Face ID** — same as the acquisition flow (Log in skips registration and Face-ID-enrollment, going straight to Home; Create account goes through the full set).
3. **Welcome-back (Face ID auto-login)** — if a passkey/biometric already exists, a brief "Welcome back — signing you in with Face ID" state resolves to Home automatically.
4. **Home (wallet dashboard)** — the core authenticated screen:
   - **Balance card** (dark, `#15201C`): **multi-currency** — cashback is earned in each merchant's settlement currency (the *real* value), but the headline is the **estimated ILS total** shown large with a `≈` prefix and an **"Estimated"** chip (e.g. `≈₪142.50`). Below it, the **real per-currency holdings** appear as small chips (`$36.20 · €2.14`) with a "held in original currencies" note. Pending note is also estimated ("≈₪68.20 pending confirmation"). A **mint** primary CTA **Withdraw cash** (`#7FE0B0` on ink). FX is ILS-per-unit (`USD→3.70, EUR→4.00, GBP→4.65` in the prototype) — in production pull live rates; the ILS figure is always a display estimate, never a settled amount.
   - **Set up Face ID** prompt (soft green card) shown only if no passkey yet → **enroll** button.
   - **Recent activity** list with a **See all** link; each row is a partner/order with a colored status label (confirmed / pending / rejected) and a **dual amount**: the **estimated ILS** value large on top, the **real source-currency** cashback (e.g. `+$3.35`) small beneath.
   - Desktop adds a top nav (wordmark, Home / Activity links, a green **Create link** button, avatar). Mobile uses a bottom tab bar (Home, Activity, Profile) + a create affordance.
5. **Create link** — paste a product URL; **Create** pulls product info (loading state "pulling…") → Summary.
6. **Summary / share** — created link with its product summary and a **share** affordance (copy link).
7. **Earning detail** — a single order's detail with a status timeline; header shows the **estimated ILS** value large with the **real** source-currency value (e.g. `+$3.35 USD`) beneath. Per-buyer rows on a shared link show the same estimated-ILS-over-real-currency pairing.
8. **Activity** — full list of earnings/orders.
9. **Withdraw (multi-method)** — title **Withdraw cash**; amount context ("₪X available"); a **payout-method picker** with four options, each a selectable row with a logo tile + label + detail line + a green check when selected:
   - **Bank account** — opens **bank details** screen (bank, branch, account number, account holder) → on save, row shows masked account `•••• 4821` and the **Bank Hapoalim** logo (generic blue bank glyph until details are saved).
   - **Credit card** — opens **card details** screen (card number, expiry, CVV, holder) → on save, row shows `Mastercard · •••• 1234` and the **Mastercard** logo (generic violet card glyph until saved).
   - **Bit** — uses the already-verified phone number, no setup; always shows the **Bit** logo.
   - **PayBox** — uses the verified phone number, no setup; always shows the **PayBox** logo.
   MVP scope: **one** bank account and **one** card max. A logo only appears once details exist; otherwise show the neutral generic glyph.
10. **Withdraw done** — success screen; the confirmation copy names the chosen method and a 1–2 business-day ETA.
11. **Profile** — account/settings, language, Face ID status, etc.

### Admin / Operations console (`designs/Wanthat Admin.dc.html`)
Internal back-office, **desktop web only, English / LTR** (not bilingual). Persistent layout: a fixed **left sidebar** (248px) + a **top bar** + a scrolling content area. The sidebar can theme **dark** (`#15201C`, default) or light via the component's `sidebarTheme` prop. A single `view` state switches between two sections.

- **Sidebar** — wanthat mark + "Operations" label; an "Overview" group with **Dashboard** and a "Settings" group with **Configuration** (active item filled with the accent color); an admin user card pinned to the bottom (avatar initials, name, role, sign-out icon).
- **Top bar** — page title + subtitle (changes per view), a **search field** (shown on Dashboard only — hidden on Configuration), and a notification bell with an accent dot.

**1. Dashboard** — `view: 'dashboard'`. Top is a **merchant filter** (pill tabs: All merchants · AliExpress · Amazon · Shein · eBay). Selecting a merchant **rescales every panel** below by that merchant's share of platform volume. Panels:
   - **KPI row** (4 cards): *Cashback paid* (₪, with ▲ delta vs last 30d), *Pending payouts* (₪ + request count awaiting review), *Active users* (+ new-this-week), *Link conversion* (% + active-link count). Each card has a small rounded icon tile (accent or amber tinted).
   - **Cashback paid chart** — a CSS bar chart with a **7d / 30d / 90d** segmented period toggle; bars are accent-colored, labeled with ₪ values + period buckets; header shows the period total. Heights normalize to the period max.
   - **Cashback status** card — a stacked horizontal bar (Confirmed = accent, Pending = `#D9A23E`, Rejected = `#C16A5C`) + a legend with %/counts, and an "Avg. approval time" row. Percentages vary per merchant.
   - **Pending approvals** queue — the core ops surface. **The primary trigger for approval is merchant confirmation, not manual action.** Each row: product thumbnail + user + relative time; a **merchant-status chip** (the prominent signal — "AliExpress confirmed" in accent/green, "Awaiting Amazon" in amber `#B07A1E`, "eBay declined" in red `#B0473A`, each with a colored dot); the cashback amount; and a low-emphasis **Override** column with two small (30px) ghost icon buttons (✓ approve / ✕ reject) — deliberately de-emphasized because manual action is the exception. Approving/rejecting removes the row. The list filters to the selected merchant.
   - **Top earning links** — ranked list (product, merchant, purchase count, earned ₪); filters by merchant.

**2. Configuration** — `view: 'config'`. A single ~860px column of section cards, each a stack of label/description + control rows, with a **sticky save bar** at the bottom ("unsaved changes" hint + Discard + Save changes; Save flips to a confirmed state).
   - **Margins & rewards** — *Operating margin rate* (slider **0–90%**, wanthat's cut of affiliate commission before rewards); *Referrer–buyer split* (slider 0–100 showing live "Referrer X% / Buyer Y%"); *Payout currency* (segmented ₪ ILS / $ USD / € EUR, drives the symbol used elsewhere); *App languages* (English / עברית toggles).
   - **Payouts** — *Minimum withdrawal* (currency input); *Enabled payout methods* — a 2×2 grid of toggle rows (Bank transfer, Debit card, Bit, PayBox) each with an icon tile + ETA.
   - **Automation & features** — *Auto-approve small cashbacks* (toggle + currency threshold input — events under it skip the approvals queue); other operational toggles.

> The admin console is **English-only and LTR** — the bilingual/RTL rules above do **not** apply to it. It is a separate surface/app from the consumer flows and would typically live behind staff auth.

## Interactions & Behavior
- **Navigation** is a single `screen` state string per flow (values listed in each flow's `renderVals`, e.g. `app-landing`, `landing`, `auth-phone`, `auth-otp`, `register`, `enable-face`, `redirect-store`, `home`, `create`, `summary`, `detail`, `activity`, `withdraw`, `withdraw-bank`, `withdraw-card`, `withdraw-done`, `profile`). Recreate as routes/screens in the target router.
- **T&C gate**: personal-details Continue disabled until the agreement checkbox is checked; Terms / Privacy are links.
- **OTP**: auto-advancing 4-digit entry; resend countdown timer.
- **Face ID**: if a passkey exists, auto-login interstitial; otherwise enrollment is offered on the home screen and during registration.
- **Withdraw method selection**: tapping Bank/Card with no saved details routes to the detail-entry screen; saving returns to the withdraw screen with that method selected and its real logo shown. Bit/PayBox select immediately.
- **Sample balance animation** (logged-out landing): cycles through a set of amounts on a timer; purely illustrative.
- **Loading states**: create-link shows a spinner + "pulling…"; buttons have a disabled/loading variant (soft green bg, spinner) — see the design system Buttons section.
- **Responsive**: mobile = phone frame + bottom tabs; desktop = centered card/columns + top nav. Same screens, reflowed.
- **Animations**: spinner `wspin` (0.8s linear infinite rotate); pulse `wpulse` (1.1s ease-in-out, opacity+scale) for the Face ID glyph. Keyframes are in each file's `<style>`.

## State Management
Per flow, the prototype keeps a single component state object. Key fields to model:
- `lang` ('en' | 'he'), `desktop` (bool) — locale + viewport (in product: i18n context + responsive, not manual toggles).
- `screen` — current screen/route (see list above).
- `phone`, `otp` — auth inputs.
- `regFirst`, `regLast`, `regEmail`, `agreed` — registration fields + T&C consent.
- `hasPasskey`, `faceAuthing` — Face ID / passkey enrollment + in-progress auth.
- `payoutMethod` ('bank' | 'card' | 'bit' | 'paybox'), `bankSet`, `cardSet` — withdraw method + whether bank/card details have been saved.
- `demoIdx` — index into the sample-balance amounts (logged-out landing animation only).
- Data needs in a real build: shared product metadata (from referral link), wallet balance + pending, activity/earnings list, created links, saved payout methods, attribution/referral token.

**Admin console state** (`designs/Wanthat Admin.dc.html`): `view` ('dashboard' | 'config'), `merchant` ('all' | 'ali' | 'amazon' | 'shein' | 'ebay'), `period` ('7d' | '30d' | '90d'), `approved` (map of resolved approval ids), `saved` (config save flag), and a `config` object (`marginRate`, `split`, `currency`, `minPayout`, `autoThreshold`, `langEn`, `langHe`, `autoApprove`, `methodBank/Card/Bit/Paybox`). In a real build, all dashboard figures and the approvals/top-links lists come from analytics + the cashback-events service (each event carries a merchant-confirmation status); config values persist to a platform-settings store.

## Design Tokens
**Colors**
- Base `#F4F6F5` · App page bg `#E9EDEB` · Surface `#FFFFFF`
- Ink (text/dark surfaces) `#15201C` · Muted text `#6B7B73` · Secondary text `#5C6B64` · Faint text `#8A968F` · Placeholder `#A6B2AC`
- Hairline border `#E6EBE8` · Input border `#E0E6E3` · Divider `#E2E7E4`
- **Evergreen (accent)** `#1F7A57` · Mint (CTA on ink) `#7FE0B0` · Accent soft (bg) `#E7F1EC` · Accent soft border `#D2E3D9`
- Status — Pending `#B07A1E` · Rejected `#B0473A` · (Confirmed reuses Evergreen `#1F7A57`)
- On-ink muted text `#9DB6AB` / `#B9CCC3`
- Method logo tile accents (generic glyphs before details saved): Bank blue `#2F5BD9` on `#EAF1FB`; Card violet `#6B4FD0` on `#F0ECFB`; Bit teal `#00B3A4` on `#E2F6F3`; PayBox amber `#E07A3A` on `#FBEEE6`.

**Admin console (additional)**
- Sidebar dark bg `#15201C`, dark border `#1E2C26`, dark hairline `#243530`, dark card `#1B2924`, dark muted text `#7E9389`, dark nav text `#B6C7BF`. Light-theme sidebar = Surface `#fff` + standard borders.
- Active nav item: accent fill `#1F7A57`, white text. Merchant pill (active): ink `#15201C` fill, white text; (inactive): white + `#E0E6E3` border.
- Status-bar / chip hues: Confirmed = Evergreen `#1F7A57` on `#E7F1EC`; Pending = `#B07A1E` on `#FAF3E6`, bar swatch `#D9A23E`; Rejected = `#B0473A` on `#F7ECEA`, bar swatch `#C16A5C`.
- KPI icon tiles: accent on `#E7F1EC`, or pending `#B07A1E` on `#FAF3E6`.

**Typography**
- **Space Grotesk** — display, headings, wordmark. Weights 400–700. Display 40–46/700, Heading 22–30/700, both `letter-spacing:-0.02em to -0.03em`.
- **Hanken Grotesk** — UI & body (Latin). Title 15–18/700, Body 14–15/400–500, Label/caption 11–13/500–600.
- **Heebo** — Hebrew (RTL), weights 400–800.
- Money uses **tabular numerals** (`font-variant-numeric: tabular-nums; font-feature-settings:"tnum" 1`), LTR, ₪ leading.
- Google Fonts import: `Hanken Grotesk` (400;500;600;700;800), `Space Grotesk` (400;500;600;700), `Heebo` (400;500;600;700;800).

**Radius**
- 12 input · 16 chip/method card · 20 card · 24 feature · 46 device frame · 50% avatars · 11–15 buttons.

**Elevation**
- Hairline borders first; shadow only for lifted surfaces. Card shadow: `0 1px 2px rgba(0,0,0,.04), 0 18px 36px -22px rgba(20,40,30,.4)`. Toolbar/segment shadow: `0 1px 2px rgba(0,0,0,.08)`.

**Spacing & hit targets**
- Tap targets never below **44px**. Form inputs ~`padding:14–15px 16px`. Primary buttons ~`padding:16–17px`, radius 15.

**Buttons** (from the design system)
- Primary: bg `#1F7A57`, white text, radius 15, weight 700.
- Ink: bg `#15201C`, white text.
- Outline: white bg, `#15201C` text, `1px solid #E0E6E3`.
- Text link: transparent, `#1F7A57` text.
- Loading/disabled: bg `#E7F1EC`, `#1F7A57` text + spinner.
- Mint (only on dark/ink surfaces): bg `#7FE0B0`, text `#0E1A14`.

## Assets
In `designs/assets/`:
- `wanthat-mark.png` — app mark / logo glyph (used in nav, headers).
- `wanthat-wordmark.png`, `wanthat-logo.png` — full logo lockups.
- `product-feeder.jpg` — sample shared-product image (the referral product used in mocks; a real automatic pet feeder listing). Replace with live product imagery.

**Payout-method logos** are loaded at runtime from Wikipedia/Wikimedia URLs in the prototype (Bank Hapoalim, Mastercard, Bit, PayBox) and are used here as **mock brand references only**. In production, use the official, licensed brand/partner assets — do not hotlink Wikimedia. Card-brand logos should be derived from the entered card number (Visa/Mastercard/etc. detection).

## Files
- `designs/Wanthat Shared Product - Flow.dc.html` — acquisition flow (referral → signup → store).
- `designs/Wanthat Wallet - Flow.dc.html` — authenticated wallet app (landing, auth, home, activity, create link, withdraw, profile). **Primary reference for most screens.**
- `designs/Wanthat Admin.dc.html` — internal **Operations console** (Dashboard + Configuration), desktop web, English/LTR. Props: `accent` (color), `sidebarTheme` (Dark/Light), `showDeltas` (bool).
- `designs/Wanthat Design System.dc.html` — color, type, radius/elevation, buttons, inputs — open this first for exact tokens and component specs.
- `designs/support.js` — the prototype runtime. **Reference only — do not port.**
- `designs/assets/` — logos + sample product image.

### How to read a `.dc.html` file
Each file has three parts: an HTML template (between `<x-dc>` and the `<script data-dc-script>` tag), a `class Component` logic block (state, `renderVals()` with all the derived values + handlers, and the `T` i18n dictionary), and optional props JSON. Read the template for structure/markup/inline styles, and the logic block for copy (both languages), state, and behavior.
