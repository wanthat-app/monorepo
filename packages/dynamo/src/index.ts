/**
 * `@wanthat/dynamo` — the DynamoDB data-access layer (ADR-0003). A shared document client plus one
 * repository per table; every read/write is validated through the `@wanthat/contracts` Zod schemas,
 * so DynamoDB stays the operational, non-PII store behind a typed boundary.
 *
 * Repositories are added per feature slice. Present: runtime `config` and the `fx_rate` cache (the FX
 * slice). `recommendation` and `guest_attribution` land with the links / landing / poller slices.
 */
export { getDocClient } from "./client";
export { FxRateRepo, fxPairKey } from "./fx-rate";
export { RuntimeConfigRepo } from "./runtime-config";
