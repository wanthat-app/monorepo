import { Navigate } from "react-router-dom";
import { useSession } from "./lib/session";
import { Screen, Spinner } from "./ui/components";

/** Index route — route to the wallet home or the auth flow once the session is resolved. */
export function App() {
  const { loading, customer } = useSession();
  if (loading) {
    return (
      <Screen>
        <div className="flex justify-center text-muted">
          <Spinner />
        </div>
      </Screen>
    );
  }
  return <Navigate to={customer ? "/home" : "/auth"} replace />;
}
