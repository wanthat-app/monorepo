import { type CountryCode, parsePhoneNumberFromString } from "libphonenumber-js";
import type { PhoneE164 } from "./ids";

/**
 * Normalize a user-entered phone number to E.164 (`+<cc><national>`), or `null` if it isn't a valid
 * number. Country-agnostic: backed by libphonenumber-js, so it handles every country's national and
 * international formats, trunk prefixes (e.g. Israel's `050…`, the UK's `07…`), and separators, and it
 * actually *validates* (junk like `"0"` returns `null` rather than a fake number).
 *
 * `defaultCountry` (ISO-3166 alpha-2, e.g. `"IL"`) is the region assumed for **national-format** input
 * — pass the country the UI affordance/selector is set to. International input (`+972…`, `+1…`) is
 * self-describing and needs no default. We launch Israel-only (`defaultCountry: "IL"`), but nothing
 * here is Israel-specific, so a country picker is a UI change, not a rewrite.
 *
 * Called by the SPA when composing the number AND re-applied by app-api at the boundary (defence in
 * depth — the SPA can be bypassed, and the E.164 regex alone still accepts a doubled country code).
 */
export function normalizePhone(input: string, defaultCountry?: CountryCode): PhoneE164 | null {
  const parsed = parsePhoneNumberFromString(input.trim(), defaultCountry);
  return parsed?.isValid() ? (parsed.number as PhoneE164) : null;
}
