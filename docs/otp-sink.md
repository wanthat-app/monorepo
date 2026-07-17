# OTP sink — every code, visible in the admin activity feed

otp-sender parks EVERY decrypted OTP code in DynamoDB (5-minute TTL, the OTP lifetime)
before attempting delivery — a permanent feature in every environment, not a configuration.
The admin panel's Activity feed lists current codes; this keeps sign-in completable and
testable while the account-wide SMS sandbox blocks real delivery, and gives support a way to
read a member's current code.

Delivery itself is best-effort once the code is parked: a delivery failure (e.g. the sandbox
refusing an unverified number) is logged (`otp_delivery_failed`) without failing the Cognito
ceremony. Only when the code is NEITHER parked NOR delivered does the trigger throw
(`otp_send_fatal` in the handler log) and the initiating call fail loudly.

Security posture: codes are readable by the `admin` group for their 5-minute lifetime — an
accepted trade-off for support and sandbox-era testing. The sink table carries no grant beyond
otp-sender (write) and admin-console (read); codes are never written to logs.

## Read a code (CLI alternative to the Activity feed)
    aws dynamodb get-item \
      --table-name "$(aws dynamodb list-tables --query 'TableNames[?contains(@, `DevOtpSink`)] | [0]' --output text)" \
      --key '{"phone":{"S":"+972541234567"}}' \
      --query 'Item.code.S' --output text

(The physical table name keeps its historical `DevOtpSink` construct id — renaming would
replace the table under its cross-stack consumers.)

Observability: `otp_parked` confirms the park, `otp_delivered` a completed hand-off to the
channel, `otp_delivery_failed` / `otp_park_failed` the partial failures.
