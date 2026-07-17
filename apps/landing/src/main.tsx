import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SharedProductPage } from "./features/landing/SharedProductPage";
import "./i18n";
import "./index.css";
import { initConfig } from "./lib/config";
import { SessionProvider } from "./user";

/**
 * The lean landing app boots ONLY on `/p/{id}` — the landing Lambda serves this build's
 * `landing.html` shell there (with the snapshot + server card injected), so a guest opening a
 * viral link never downloads the member bundle. No router: the one page's id comes straight
 * from the path, and every outbound CTA is a plain same-origin link into the member app
 * (`/auth?...`), which CloudFront serves from the member SPA's index.html.
 */
function recIdFromPath(path: string): string {
  const m = path.match(/^\/p\/([^/?#]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : "";
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Load runtime config (/config.json on the deployed site; .env.local fallback locally) before
// render, so the Cognito client has its region + client id on first use (returning-member passkey
// login). `finally` renders even if the fetch fails — local dev has no config.json.
initConfig().finally(() => {
  createRoot(root).render(
    <StrictMode>
      <SessionProvider>
        <SharedProductPage id={recIdFromPath(window.location.pathname)} />
      </SessionProvider>
    </StrictMode>,
  );
});
