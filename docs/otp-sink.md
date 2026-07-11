# OTP sink — log in without SMS/WhatsApp delivery

While the SMS sandbox cap and Meta onboarding block real OTP delivery, any environment —
including prod, since the sandbox is account-wide — can park codes in DynamoDB instead
(`auth.otpSink = "devSink"`; the stored value name predates the prod enablement). Parked codes
appear in the admin panel's Activity feed and expire after 5 minutes.

CAUTION: while `devSink` is set, members' sign-in codes divert to the admin panel instead of
being delivered — members cannot log in, and any admin can read their codes. Flip back to
`delivery` before real members onboard.

## Flip it on
Set "OTP code routing" to "Park in panel" on /admin/settings (or `PUT /admin/config/auth.otpSink`
with `devSink`). Flips are audit-chained like every config write. Flip back to `delivery` when a
real channel is unblocked.

## Read a code (after tapping Continue on the login screen)
    aws dynamodb get-item \
      --table-name "$(aws dynamodb list-tables --query 'TableNames[?contains(@, `DevOtpSink`) && contains(@, `dev`)] | [0]' --output text)" \
      --key '{"phone":{"S":"+972541234567"}}' \
      --query 'Item.code.S' --output text

Items expire after 5 minutes (the OTP lifetime). The code is never logged; the sink item is the
only copy outside Cognito. `otp_sunk_dev` in the message-sender logs confirms the park.
