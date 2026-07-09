# WhatsApp onboarding runbook (ADR-0019)

The code ships kill-switched OFF; this out-of-band onboarding is the critical path to flipping it
on. No redeploys anywhere below.

## 1. Meta Business verification (longest lead time — start first)
- In Meta Business Manager (business.facebook.com): Business settings -> Security centre -> Start
  verification for the Wanthat legal entity. Requires business documents; approval can take days
  to weeks.

## 2. Link a WhatsApp Business Account (WABA) to AWS
- AWS console -> AWS End User Messaging -> Social (region **eu-central-1** — il-central-1 is not
  supported; the Lambdas' `WHATSAPP_SOCIAL_REGION` env matches).
- "Sign up through Facebook" (embedded signup): create/link the WABA, register the business phone
  number, and set the display name ("Wanthat").
- Note the **phone number ID** (`phone-number-id-...`) from the console/`GetLinkedWhatsAppBusinessAccount`.
- Dev can use a Meta test number instead of a real one.

## 3. Create the message templates (Meta approval per language)
- `otp_code` — category **Authentication**, languages **he** and **en**. Meta supplies the fixed
  authentication-template text; enable the **copy-code button** and the security recommendation.
  The code registry sends: body param = the code, button param = the code.
- `optin_welcome` — category **Utility**, languages **he** and **en** (used by PR 2):
  - en: `Hi {{1}}, welcome to Wanthat! Start earning cashback: {{2}}`
  - he: `היי {{1}}, ברוכים הבאים ל-Wanthat! מתחילים להרוויח קאשבק: {{2}}`
  - `{{1}}` = first name, `{{2}}` = app URL. MUST match `packages/whatsapp/src/registry.ts`.

## 4. Flip the switches (admin config, per env)
1. `PUT /admin/config/whatsapp.phoneNumberId` -> the `phone-number-id-...` value.
2. `PUT /admin/config/auth.whatsappEnabled` -> `true`. The SPA offers WhatsApp on the next
   /auth/config fetch; smoke-test a login.
3. After PR 2: `PUT /admin/config/notifications.whatsappEnabled` -> `true`; register a test user
   and confirm the welcome message.

Rollback at any point = flip the keys back. Costs: ~0.0103 USD per OTP to Israel; KMS key ~1 USD/mo.
