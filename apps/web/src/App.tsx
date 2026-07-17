import { Screen, Spinner } from "@wanthat/ui";
import { Navigate } from "react-router-dom";
import { AppLandingPage } from "./features/landing/AppLandingPage";
import { useSession } from "./user";

/** Index route — the wallet home for members, the logged-out app landing for everyone else. */
export function App() {
  const { loading, status } = useSession();
  if (loading) {
    return (
      <Screen>
        <div className="flex justify-center text-muted">
          <Spinner />
        </div>
      </Screen>
    );
  }
  if (status === "signedIn") return <Navigate to="/home" replace />;
  return <AppLandingPage />;
}
