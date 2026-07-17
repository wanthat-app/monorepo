import {
  CognitoIdentityProviderClient,
  GetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const defaultClient = new CognitoIdentityProviderClient({});

/**
 * The creator's given_name, denormalized onto the recommendation for landing display
 * (spec 2026-07-09 §3). The SPA authenticates with an ACCESS token whose claims carry no
 * profile, so this is a one-off self-serve Cognito GetUser with the caller's own token —
 * link creation only, NEVER the redirect hot path (ADR-0007). Best-effort: any failure
 * (missing scope, network, no attribute) → null, and the landing renders generic copy.
 */
export async function referrerFirstName(
  accessToken: string | undefined,
  deps: { client: { send: CognitoIdentityProviderClient["send"] } } = { client: defaultClient },
): Promise<string | null> {
  if (!accessToken) return null;
  try {
    const res = await deps.client.send(new GetUserCommand({ AccessToken: accessToken }));
    const given = res.UserAttributes?.find((a) => a.Name === "given_name")?.Value?.trim();
    return given || null;
  } catch {
    return null;
  }
}
