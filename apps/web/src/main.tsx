import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./App";
import { AuthPage } from "./features/auth/AuthPage";
import { CallbackPage } from "./features/auth/CallbackPage";
import { HomePage } from "./features/home/HomePage";
import "./i18n";
import "./index.css";
import { SessionProvider } from "./lib/session";

const queryClient = new QueryClient();
const router = createBrowserRouter([
  { path: "/", element: <App /> },
  { path: "/auth", element: <AuthPage /> },
  { path: "/auth/callback", element: <CallbackPage /> },
  { path: "/home", element: <HomePage /> },
]);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
