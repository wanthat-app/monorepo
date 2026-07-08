import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import type { OtpChannel } from "@wanthat/contracts";

/**
 * Repository over the `auth_challenge` table (ADR-0006) — short-lived server state for the OTP flow.
 * Record kinds share the `challengeId` partition key (disjoint id namespaces, tagged by
 * `recordType`):
 *
 *  - **challenge** — one per `/auth/start`: the Cognito `Session` (rotated on each resend), whether
 *    the phone was new, the resend cooldown, and an attempt counter. We can't be stateless: the
 *    cooldown and the rotating Session are server state.
 *  - **ticket** — issued by `/auth/verify` for a not-yet-registered user: the freshly minted tokens
 *    are parked here (never handed to the client until `/auth/register`), keyed by an unguessable id
 *    that `/auth/register` presents back as an HMAC-signed registration ticket.
 *  - **pk-challenge** (ADR-0006) — one per passkey register/login ceremony: the single-use WebAuthn
 *    `challenge` we issued, so `app-auth` (which now owns the WebAuthn verification itself, not
 *    Cognito) can check it at verify time. Registration challenges carry the caller's `sub`/`username`
 *    (from the access token); login challenges are issued userless (`sub`/`username` empty) since the
 *    assertion itself resolves the credential.
 *
 * All carry a Unix-seconds `ttl` so abandoned state self-cleans via DynamoDB TTL.
 */

export interface ChallengeRecord {
  challengeId: string;
  /** Cognito username (an opaque UUID; the phone is an alias, never the username). */
  username: string;
  /** Cognito `sub` — carried so `/auth/verify` can check customer existence without a re-lookup. */
  sub: string;
  /** E.164 phone — carried into the registration ticket so `/auth/register` can write `phone_e164`. */
  phone: string;
  cognitoSession: string;
  isNewUser: boolean;
  /** OTP channel of the LAST send for this challenge (start or resend) — ADR-0019. Optional: records written before the channel feature lack it. */
  requestedChannel?: OtpChannel;
  resendAfterEpoch: number;
  attempts: number;
  ttl: number;
}

export interface TicketRecord {
  ticketId: string;
  sub: string;
  phone: string;
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
  ttl: number;
}

/** A single-use WebAuthn ceremony challenge (ADR-0006). `sub`/`username` are empty for a userless
 * login challenge — the assertion resolves the credential, not the challenge record. */
export interface PasskeyChallengeRecord {
  challengeId: string;
  kind: "reg" | "login";
  sub: string;
  username: string;
  /** The base64url `options.challenge` we issued; checked against the credential response at verify. */
  challenge: string;
  ttl: number;
}

export class AuthChallengeRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async putChallenge(rec: ChallengeRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: { recordType: "challenge", ...rec } }),
    );
  }

  async getChallenge(challengeId: string): Promise<ChallengeRecord | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { challengeId } }),
    );
    if (res.Item?.recordType !== "challenge") return undefined;
    return res.Item as unknown as ChallengeRecord;
  }

  async deleteChallenge(challengeId: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: { challengeId } }));
  }

  async putTicket(rec: TicketRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { challengeId: rec.ticketId, recordType: "ticket", ...rec },
      }),
    );
  }

  async getTicket(ticketId: string): Promise<TicketRecord | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { challengeId: ticketId } }),
    );
    if (res.Item?.recordType !== "ticket") return undefined;
    return res.Item as unknown as TicketRecord;
  }

  async deleteTicket(ticketId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { challengeId: ticketId } }),
    );
  }

  async putPasskeyChallenge(rec: PasskeyChallengeRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: { recordType: "pk-challenge", ...rec } }),
    );
  }

  /**
   * ATOMICALLY consume a passkey challenge: delete it and return its prior value, or `undefined` if
   * already consumed / never existed. The conditional delete IS the single-use guarantee — two
   * requests replaying the same assertion (same challengeId) race here and exactly one wins, so a
   * captured assertion can't be redeemed twice (ADR-0006 security review). Non-pk records → undefined.
   */
  async consumePasskeyChallenge(challengeId: string): Promise<PasskeyChallengeRecord | undefined> {
    try {
      const res = await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { challengeId },
          ConditionExpression: "attribute_exists(challengeId)",
          ReturnValues: "ALL_OLD",
        }),
      );
      if (res.Attributes?.recordType !== "pk-challenge") return undefined;
      return res.Attributes as unknown as PasskeyChallengeRecord;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return undefined; // already consumed
      throw err;
    }
  }
}
