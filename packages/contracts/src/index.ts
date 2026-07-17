/**
 * Schema-first contracts (ADR-0001). Each contract is one Zod schema; the static
 * type is inferred via z.infer, and the same schema validates at every trust boundary
 * (API I/O, retailer payloads, custom_parameters, env). Modules are added as designed.
 */
export * from "./activity";
export * from "./audit";
export * from "./common";
export * from "./config";
export * from "./conversion";
export * from "./fx";
export * from "./identity";
export * from "./landing";
export * from "./recommendations";
export * from "./retailer";
export * from "./stats";
export * from "./wallet";
