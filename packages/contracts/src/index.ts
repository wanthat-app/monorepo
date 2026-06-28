/**
 * Schema-first contracts (ADR-0001). Each contract is one Zod schema; the static
 * type is inferred via z.infer, and the same schema validates at every trust boundary
 * (API I/O, retailer payloads, custom_parameters, env). Modules are added as designed.
 */
export * from "./common";
export * from "./identity";
export * from "./recommendations";
