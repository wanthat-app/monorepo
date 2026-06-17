/**
 * App API — identity + links + wallet Lambdalith (ADR-0005), behind API Gateway HTTP API.
 * One function, internal HTTP routing; in-VPC + RDS Proxy to Aurora (ADR-0006).
 * Modules: identity (/auth/*, /me), links (/links, /products/*), wallet (/wallet*).
 *
 * Stub — wire an HTTP framework (e.g. Hono) and the domain modules here.
 */
export const handler = async (): Promise<unknown> => {
  throw new Error("not implemented");
};
