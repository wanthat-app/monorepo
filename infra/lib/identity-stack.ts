import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import type { WanthatEnv } from "./config";

export interface IdentityStackProps extends StackProps {
  readonly wanthatEnv: WanthatEnv;
}

/**
 * IdentityStack — Cognito (ADR-0006).
 *
 * A user pool with phone-first sign-in and a public SPA app client (no secret; the SPA carries the
 * JWT as a Bearer header, ADR-0007). This is enough to issue/validate JWTs for the API authorizer.
 *
 * Deferred to the identity slice: native SMS-OTP wiring (SNS role + spend caps + kill switch),
 * passkeys, and the Post-Confirmation provisioning trigger that writes the `customer` row.
 */
export class IdentityStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);
    const { wanthatEnv } = props;

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `wanthat-${wanthatEnv.name}`,
      signInAliases: { phone: true, email: true },
      standardAttributes: {
        phoneNumber: { required: true, mutable: true },
        email: { required: false, mutable: true },
      },
      removalPolicy: wanthatEnv.name === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.userPoolClient = this.userPool.addClient("Spa", {
      userPoolClientName: `wanthat-${wanthatEnv.name}-spa`,
      generateSecret: false,
      authFlows: { userSrp: true, custom: true },
    });
  }
}
