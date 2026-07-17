import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./App";
import { ActivityPage } from "./features/activity/ActivityPage";
import { AuthPage } from "./features/auth/AuthPage";
import { CreateLinkPage } from "./features/create/CreateLinkPage";
import { HomePage } from "./features/home/HomePage";
import { SharedProductPage } from "./features/landing/SharedProductPage";
import { LegalPage } from "./features/legal/LegalPage";
import { NotFoundPage } from "./features/not-found/NotFoundPage";
import { ProfilePage } from "./features/profile/ProfilePage";
import { AdminRedirect } from "./features/shell/AdminRedirect";
import { RouteErrorPage } from "./features/shell/RouteErrorPage";
import { SiteNotice } from "./features/shell/SiteNotice";
import "./i18n";
import "./index.css";
import { initConfig } from "./lib/config";
import { SessionProvider } from "./user";

const queryClient = new QueryClient();
const router = createBrowserRouter([
  {
    // Pathless parent: one errorElement catches a throw from any route below, replacing
    // react-router's developer error page ("Unexpected Application Error!").
    errorElement: <RouteErrorPage />,
    children: [
      { path: "/", element: <App /> },
      { path: "/auth", element: <AuthPage /> },
      // No /auth/callback any more: customer auth is Cognito-native in-page (ADR-0006); the only
      // OAuth redirect left is the ADMIN console's (its own callback below).
      { path: "/home", element: <HomePage /> },
      { path: "/activity", element: <ActivityPage /> },
      { path: "/profile", element: <ProfilePage /> },
      { path: "/create", element: <CreateLinkPage /> },
      // Referral landing (dynamic SPA page; the landing service server-renders only OG for bots).
      { path: "/p/:id", element: <SharedProductPage /> },
      // Sample legal pages — linked from the registration consent checkbox.
      { path: "/terms", element: <LegalPage kind="terms" /> },
      { path: "/privacy", element: <LegalPage kind="privacy" /> },
      // The admin console lives on its OWN origin (admin.{domain}) — employee tokens are
      // storage-isolated from all customer-facing code. Old /admin* deep links redirect there.
      { path: "/admin", element: <AdminRedirect /> },
      { path: "/admin/*", element: <AdminRedirect /> },
      // Catch-all 404 for any unknown URL (otherwise react-router shows its developer error page).
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Load runtime config (/config.json on the deployed site; .env.local fallback locally) before render,
// so the auth clients have their backend URLs + client ids on first use. `finally` renders even if the
// fetch fails — local dev has no config.json and relies on the build-time fallback.
initConfig().finally(() => {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          {/* Admin-set site-wide notice — above the router so EVERY page carries it. */}
          <SiteNotice />
          <RouterProvider router={router} />
        </SessionProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
});
