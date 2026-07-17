import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { GenerateLinkRequest } from "@wanthat/contracts";
import { GenerateLinkResponse } from "@wanthat/contracts";

/**
 * Synchronous invoke of the non-VPC retailer-linkgen (ADR-0004: the user waits for the
 * affiliate URL). The class name predates the proxy split (refactor PR-6) and the wire shape is
 * unchanged — only the target function moved (env `RETAILER_LINKGEN_FUNCTION`). The response is
 * contract-validated exactly like an HTTP boundary.
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
      throw new Error(`retailer-linkgen invoke failed: ${res.FunctionError ?? "empty payload"}`);
    }
    return GenerateLinkResponse.parse(JSON.parse(Buffer.from(res.Payload).toString("utf8")));
  }
}
