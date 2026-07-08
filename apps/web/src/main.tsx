import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./App";
import { AdminCallbackPage } from "./features/admin/AdminCallbackPage";
import { AdminPage } from "./features/admin/AdminPage";
import { AuthPage } from "./features/auth/AuthPage";
import { CallbackPage } from "./features/auth/CallbackPage";
import { HomePage } from "./features/home/HomePage";
import { SharedProductPage } from "./features/landing/SharedProductPage";
import { NotFoundPage } from "./features/not-found/NotFoundPage";
import "./i18n";
import "./index.css";
import { initConfig } from "./lib/config";
import { SessionProvider } from "./lib/session";

const queryClient = new QueryClient();
const router = createBrowserRouter([
  { path: "/", element: <App /> },
  { path: "/auth", element: <AuthPage /> },
  { path: "/auth/callback", element: <CallbackPage /> },
  { path: "/home", element: <HomePage /> },
  // Referral landing (dynamic SPA page; the landing service server-renders only OG for bots).
  { path: "/p/:id", element: <SharedProductPage /> },
  // Each admin view has its own URL so deep links, reloads and browser history work.
  { path: "/admin", element: <AdminPage /> },
  { path: "/admin/users", element: <AdminPage /> },
  { path: "/admin/activity", element: <AdminPage /> },
  { path: "/admin/settings", element: <AdminPage /> },
  { path: "/admin/callback", element: <AdminCallbackPage /> },
  // Catch-all 404 for any unknown URL (otherwise react-router shows its developer error page).
  { path: "*", element: <NotFoundPage /> },
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
          <RouterProvider router={router} />
        </SessionProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
});
