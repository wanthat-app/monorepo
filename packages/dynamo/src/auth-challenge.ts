import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import type { OtpChannel } from "@wanthat/contracts";

/**
 * Repository over the `auth_challenge` table (ADR-0020) — short-lived server state for the OTP flow.
 * Two record kinds share the `challengeId` partition key (disjoint id namespaces, tagged by
 * `recordType`):
 *
 *  - **challenge** — one per `/auth/start`: the Cognito `Session` (rotated on each resend), whether
 *    the phone was new, the resend cooldown, and an attempt counter. We can't be stateless: the
 *    cooldown and the rotating Session are server state.
 *  - **ticket** — issued by `/auth/verify` for a not-yet-registered user: the freshly minted tokens
 *    are parked here (never handed to the client until `/auth/register`), keyed by an unguessable id
 *    that `/auth/register` presents back as an HMAC-signed registration ticket.
 *
 * Both carry a Unix-seconds `ttl` so abandoned state self-cleans via DynamoDB TTL.
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
  /** OTP channel of the LAST send for this challenge (start or resend) — ADR-0023. Optional: records written before the channel feature lack it. */
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
}
