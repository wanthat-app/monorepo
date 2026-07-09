import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { GenerateLinkRequest } from "@wanthat/contracts";
import { GenerateLinkResponse } from "@wanthat/contracts";

/**
 * Synchronous invoke of the non-VPC retailer-proxy (ADR-0004: the user waits for the affiliate
 * URL; the in-VPC side reaches the Lambda Invoke API over the VPC's Lambda interface endpoint).
 * The response is contract-validated exactly like an HTTP boundary.
 */
export class RetailerProxyClient {
  constructor(
    private readonly functionName: string,
    private readonly lambda: LambdaClient = new LambdaClient({}),
  ) {}

  async generateLink(url: string): Promise<GenerateLinkResponse> {
    const request: GenerateLinkRequest = { op: "generateLink", retailer: "aliexpress", url };
    const res = await this.lambda.send(
      new InvokeCommand({
        FunctionName: this.functionName,
        Payload: Buffer.from(JSON.stringify(request)),
      }),
    );
    if (res.FunctionError || !res.Payload) {
      throw new Error(`retailer-proxy invoke failed: ${res.FunctionError ?? "empty payload"}`);
    }
    return GenerateLinkResponse.parse(JSON.parse(Buffer.from(res.Payload).toString("utf8")));
  }
}
