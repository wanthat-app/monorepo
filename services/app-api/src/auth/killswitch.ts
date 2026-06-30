import type { RuntimeConfigRepo } from "@wanthat/dynamo";

/**
 * SMS kill switch (ADR-0020): read the `auth.smsEnabled` runtime-config key before any Cognito SMS
 * send. Backed by DynamoDB (reached over the gateway endpoint, no extra interface endpoint), so ops
 * or an alarm can flip it with no redeploy. Defaults to enabled until the key is first written.
 */
export async function smsEnabled(config: RuntimeConfigRepo): Promise<boolean> {
  return (await config.get("auth.smsEnabled")) === true;
}
