import { biometricLabelKey } from "./webauthn";

/**
 * The device-matched biometric glyph (design system convention: inline SVG, stroke
 * currentColor): the Face ID frame-and-face for iPhone/iPad, a fingerprint everywhere else
 * (Touch ID / Windows Hello / generic passkey) — same device-match logic as the label
 * (`biometricLabelKey`). The ONE biometric icon, shared by every surface that shows the
 * affordance (login button, enrolment step, home prompt) so they can never drift apart.
 * Decorative: the surrounding control carries the accessible name.
 */
export function BiometricGlyph({
  size = 24,
  strokeWidth = 2,
}: {
  size?: number;
  strokeWidth?: number;
}) {
  const face = biometricLabelKey() === "faceId";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {face ? (
        <>
          <path d="M4 8V6a2 2 0 0 1 2-2h2" />
          <path d="M16 4h2a2 2 0 0 1 2 2v2" />
          <path d="M20 16v2a2 2 0 0 1-2 2h-2" />
          <path d="M8 20H6a2 2 0 0 1-2-2v-2" />
          <path d="M9 10.5v.5M15 10.5v.5" />
          <path d="M9.5 15a3.5 3.5 0 0 0 5 0" />
        </>
      ) : (
        <>
          <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
          <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
          <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
          <path d="M2 12a10 10 0 0 1 18-6" />
          <path d="M2 16h.01" />
          <path d="M21.8 16c.2-2 .131-5.354 0-6" />
          <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
          <path d="M8.65 22c.21-.66.45-1.32.57-2" />
          <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
        </>
      )}
    </svg>
  );
}
