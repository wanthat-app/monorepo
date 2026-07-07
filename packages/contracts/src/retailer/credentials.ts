import { z } from "zod";
import { IsoDateTime } from "../common/time";

/**
 * PUT /admin/retailer/aliexpress/credentials — write-only credential drop (admin can write,
 * never read back). Both fields are always required together: PutSecretValue replaces the
 * whole secret value, and write-only rules out read-modify-write. This schema is also the
 * JSON shape stored in the `wanthat/{env}/retailer/aliexpress` secret, so the retailer-proxy
 * (the sole reader) parses the secret with this exact schema.
 */
export const PutRetailerCredentialsBody = z.object({
  appKey: z.string().trim().min(1).max(200),
  appSecret: z.string().trim().min(1).max(500),
});
export type PutRetailerCredentialsBody = z.infer<typeof PutRetailerCredentialsBody>;

/**
 * Response for both credential routes. Deliberately carries only non-secret metadata —
 * there is no field a credential value could travel through. `lastUpdatedAt` reflects the
 * secret's LastChangedDate; on a fresh environment that is the deploy-time placeholder
 * write until the first real admin write.
 */
export const RetailerCredentialsStatus = z.object({
  configured: z.boolean(),
  lastUpdatedAt: IsoDateTime.nullable(),
});
export type RetailerCredentialsStatus = z.infer<typeof RetailerCredentialsStatus>;
