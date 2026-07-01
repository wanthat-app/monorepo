import { PhoneE164 } from "./ids";

const IL_COUNTRY_CODE = "972";

/**
 * Normalize user-entered Israeli phone input to E.164 (`+972…`).
 *
 * The SPA shows a fixed `+972` affordance and the member types the local number, but people include
 * spaces/dashes/parens, a national trunk `0` (e.g. `050-705-8253`), an international `00` prefix, or
 * even the country code itself (`+972…` / `972…`) — all of which Cognito rejects (or, worse, would
 * store a wrong number). This reduces the input to digits, then strips (in order) an international
 * `00`, a leading `972` country code, and the national trunk `0`, and prepends `+972`.
 *
 * Israeli mobile national numbers are 9 digits starting with `5` (never `972`), so stripping a leading
 * `972` is unambiguous here. Applied by the SPA when composing the number AND re-applied by app-api at
 * the boundary (defence in depth — the SPA can be bypassed and the strict E.164 regex still accepts a
 * doubled country code like `+9720507058253`).
 */
export function normalizeIsraeliPhone(input: string): string {
  const national = input
    .replace(/\D/g, "") // digits only
    .replace(/^00/, "") // international access prefix
    .replace(new RegExp(`^${IL_COUNTRY_CODE}`), "") // country code, if the user typed it
    .replace(/^0+/, ""); // national trunk 0 (05x -> 5x)
  return `+${IL_COUNTRY_CODE}${national}`;
}

/** Normalize {@link normalizeIsraeliPhone} then validate; throws if the result isn't valid E.164. */
export function toE164IL(input: string): PhoneE164 {
  return PhoneE164.parse(normalizeIsraeliPhone(input));
}
