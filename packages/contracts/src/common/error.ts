import { z } from "zod";

/** Stable, machine-readable error codes returned at every boundary. */
export const ErrorCode = z.enum([
  "validation_error",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "otp_invalid",
  "otp_expired",
  "sms_disabled", // kill switch tripped (ADR-0006)
  "retailer_error",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Uniform error envelope for all non-2xx responses. */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
