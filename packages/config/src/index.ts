import { z } from "zod";

/**
 * Runtime environment contract — validated at boot, fail-fast (SDD §12).
 * Secrets are referenced by ARN and fetched from Secrets Manager at runtime, never
 * placed in env directly.
 */
export const Env = z.object({
  AWS_REGION: z.string().default("il-central-1"),
  NODE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  DB_SECRET_ARN: z.string().optional(),
  ALIEXPRESS_SECRET_ARN: z.string().optional(),
  OTP_SMS_ENABLED: z.coerce.boolean().default(true),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}
