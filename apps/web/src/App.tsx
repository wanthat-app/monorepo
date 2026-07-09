import { Navigate } from "react-router-dom";
import { Screen, Spinner } from "./ui/components";
import { useSession } from "./user";

/** Index route — route to the wallet home or the auth flow once the session is resolved. */
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
  return <Navigate to={status === "signedIn" ? "/home" : "/auth"} replace />;
}
