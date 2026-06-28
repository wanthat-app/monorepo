import { z } from "zod";

/** ISO-8601 UTC timestamp, e.g. `2026-06-28T12:00:00.000Z`. */
export const IsoDateTime = z.string().datetime();
export type IsoDateTime = z.infer<typeof IsoDateTime>;
