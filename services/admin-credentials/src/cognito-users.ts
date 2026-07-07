import {
  AdminDeleteUserCommand,
  type CognitoIdentityProviderClient,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";

/**
 * Customer-pool account removal for the admin users page. Runs here (non-VPC) because the
 * endpoint-free VPC cannot reach cognito-idp (ADR-0004) — admin-api deletes the Aurora row, this
 * function removes the sign-in account. Username is the phone (phone-as-username, ADR-0020);
 * an already-deleted account resolves as `existed: false` so the SPA's retry is idempotent.
 */
export class CognitoUserRemover {
  constructor(
    private readonly client: CognitoIdentityProviderClient,
    private readonly userPoolId: string,
  ) {}

  /** Returns whether the account existed (false = already gone; treated as success). */
  async remove(phone: string): Promise<boolean> {
    try {
      await this.client.send(
        new AdminDeleteUserCommand({ UserPoolId: this.userPoolId, Username: phone }),
      );
      return true;
    } catch (err) {
      if (err instanceof UserNotFoundException) return false;
      throw err;
    }
  }
}
