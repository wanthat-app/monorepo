import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { AdminCallbackPage } from "./features/AdminCallbackPage";
import { AdminPage } from "./features/AdminPage";
import "./index.css";
import { initConfig } from "./lib/config";

// The admin console serves at the ROOT of its own origin (admin.{domain}) — no /admin prefix.
// Each view has its own URL so deep links, reloads and browser history work; unknown paths fall
// back to the console shell (which resolves them to the dashboard).
const router = createBrowserRouter([
  { path: "/", element: <AdminPage /> },
  { path: "/users", element: <AdminPage /> },
  { path: "/users/:sub", element: <AdminPage /> },
  { path: "/orders", element: <AdminPage /> },
  { path: "/orders/:orderId", element: <AdminPage /> },
  { path: "/activity", element: <AdminPage /> },
  { path: "/settings", element: <AdminPage /> },
  // OAuth callback for the employee Managed Login flow (registered on the app client).
  { path: "/callback", element: <AdminCallbackPage /> },
  { path: "*", element: <AdminPage /> },
]);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Load runtime config (/config.json on the deployed site; .env.local fallback locally) before
// render, so the login + API clients have their URLs and client id on first use. `finally` renders
// even if the fetch fails — local dev has no config.json and relies on the build-time fallback.
initConfig().finally(() => {
  createRoot(root).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
});
