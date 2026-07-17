import { Screen, Spinner } from "@wanthat/ui";
import { useEffect } from "react";
import { getConfig } from "../../lib/config";
import { NotFoundPage } from "../not-found/NotFoundPage";

/**
 * The admin console moved to its OWN origin (admin.{domain}) so employee-pool tokens are
 * storage-isolated from all customer-facing code. This stub keeps old /admin* deep links
 * working: it forwards them to the admin origin with the /admin prefix stripped (the console
 * serves at its root). Without a configured admin origin (e.g. plain local dev) there is
 * nothing to forward to, so the member 404 renders instead.
 */
export function AdminRedirect() {
  const { adminOrigin } = getConfig();
  useEffect(() => {
    if (!adminOrigin) return;
    const path = window.location.pathname.replace(/^\/admin/, "") || "/";
    window.location.replace(`${adminOrigin}${path}${window.location.search}`);
  }, [adminOrigin]);
  if (!adminOrigin) return <NotFoundPage />;
  return (
    <Screen>
      <div className="flex justify-center text-muted">
        <Spinner />
      </div>
    </Screen>
  );
}
