# Dev OTP sink — log in on dev without SMS/WhatsApp

While the SMS sandbox cap and Meta onboarding block real OTP delivery, dev can park codes in
DynamoDB instead (`auth.otpSink = "devSink"`). Prod is immune twice over: message-sender honours
the key only when `WANTHAT_ENV !== "prod"` (deploy-time guard, not config), AND the sink table is
not provisioned in prod at all — no table, no env var, no IAM grant. If a future bug somehow
reached the sink there, the send fails loudly rather than storing a code (fail-closed).

## Flip it on (dev)
Set `auth.otpSink` to `devSink` via the admin config panel (or `PUT /admin/config/auth.otpSink`).
Flip back to `delivery` when a real channel is unblocked.

## Read a code (after tapping Continue on the login screen)
    aws dynamodb get-item \
      --table-name "$(aws dynamodb list-tables --query 'TableNames[?contains(@, `DevOtpSink`) && contains(@, `dev`)] | [0]' --output text)" \
      --key '{"phone":{"S":"+972541234567"}}' \
      --query 'Item.code.S' --output text

Items expire after 5 minutes (the OTP lifetime). The code is never logged; the sink item is the
only copy outside Cognito. `otp_sunk_dev` in the message-sender logs confirms the park.
