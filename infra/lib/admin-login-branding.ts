import * as fs from "node:fs";
import * as path from "node:path";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import { REPO_ROOT } from "./config";

/**
 * Managed Login branding for the ADMIN hosted login (employee pool) — the design system's
 * tokens (design/design_handoff_wanthat_app: evergreen accent, ink text, page/surface
 * neutrals, 12-20px radii) expressed as the branding style document, so the login page reads
 * as part of the admin console rather than stock AWS.
 *
 * The document schema is the branding editor's export format (AWS publishes no standalone
 * reference); Cognito validates it server-side at apply and PRESERVES any setting the
 * document omits, so this stays a minimal, high-confidence subset. Known gap: Managed Login
 * cannot load web fonts, so the page renders system fonts, not Space Grotesk.
 */

// Design tokens as the 8-digit hex (rrggbbaa) the style document expects.
const EVERGREEN = "1f7a57ff";
const EVERGREEN_HOVER = "1a6349ff";
const EVERGREEN_ACTIVE = "15503aff";
const INK = "15201cff";
const SURFACE = "ffffffff";
const PAGE = "e9edebff";
const BASE = "f4f6f5ff";
const HAIRLINE = "e6ebe8ff";
const INPUT_BORDER = "e0e6e3ff";
const PLACEHOLDER = "a6b2acff";

export const ADMIN_LOGIN_SETTINGS = {
  categories: {
    form: {
      displayGraphics: true,
      location: { horizontal: "CENTER", vertical: "CENTER" },
    },
    global: {
      colorSchemeMode: "LIGHT",
      pageHeader: { enabled: false },
      pageFooter: { enabled: false },
      spacingDensity: "REGULAR",
    },
  },
  componentClasses: {
    buttons: { borderRadius: 15 },
    input: {
      borderRadius: 12,
      lightMode: {
        defaults: { backgroundColor: SURFACE, borderColor: INPUT_BORDER },
        placeholderColor: PLACEHOLDER,
      },
    },
    focusState: { lightMode: { borderColor: EVERGREEN } },
    link: {
      lightMode: {
        defaults: { textColor: EVERGREEN },
        hover: { textColor: EVERGREEN_ACTIVE },
      },
    },
    divider: { lightMode: { borderColor: HAIRLINE } },
  },
  components: {
    pageBackground: { lightMode: { color: PAGE } },
    form: {
      borderRadius: 20,
      lightMode: { backgroundColor: SURFACE, borderColor: HAIRLINE },
      logo: { enabled: true, formInclusion: "IN", location: "CENTER", position: "TOP" },
    },
    primaryButton: {
      lightMode: {
        defaults: { backgroundColor: EVERGREEN, textColor: SURFACE },
        hover: { backgroundColor: EVERGREEN_HOVER, textColor: SURFACE },
        active: { backgroundColor: EVERGREEN_ACTIVE, textColor: SURFACE },
      },
    },
    secondaryButton: {
      lightMode: {
        defaults: { backgroundColor: SURFACE, borderColor: INPUT_BORDER, textColor: INK },
        hover: { backgroundColor: BASE, borderColor: INPUT_BORDER, textColor: INK },
        active: { backgroundColor: PAGE, borderColor: INPUT_BORDER, textColor: INK },
      },
    },
  },
};

/**
 * The brand assets uploaded with the style: the real wanthat logo lockup from the design
 * handoff (assets are base64 in the CFN payload; the PNG is ~200KB, well under the 2MB
 * request cap). Copied into infra/assets so the infra package is self-contained.
 */
export function adminLoginAssets(): cognito.CfnManagedLoginBranding.AssetTypeProperty[] {
  const logo = fs.readFileSync(
    path.join(REPO_ROOT, "infra", "assets", "managed-login", "wanthat-logo.png"),
  );
  return [
    {
      category: "FORM_LOGO",
      colorMode: "LIGHT",
      extension: "PNG",
      bytes: logo.toString("base64"),
    },
  ];
}
