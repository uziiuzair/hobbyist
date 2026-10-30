import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import * as api from "../api.js";
import { navigate } from "../lib/router.js";

type SessionState = "checking" | "anonymous" | "authenticated";

interface AuthContextType {
  session: SessionState;
  /**
   * Why the login page is showing, when it is showing for a reason other
   * than "nobody has signed in yet". Null on a fresh visit.
   */
  notice: string | null;
  handleLoggedIn: () => void;
  handleLogout: () => void;
}

// Shown on the login page after a 401 from inside the app (issue #124). The
// two causes are indistinguishable from the browser, so the note names both.
export const SESSION_LOST_NOTICE =
  "Your session ended, because it expired or the daemon restarted. Sign in again to continue.";

const AuthContext = createContext<AuthContextType>({
  session: "checking",
  notice: null,
  handleLoggedIn: () => {},
  handleLogout: () => {},
});

export const AuthProvider = ({ children }: { children?: React.ReactNode }) => {
  const [session, setSession] = useState<SessionState>("checking");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .session()
      .then((result) =>
        setSession(result.authenticated ? "authenticated" : "anonymous"),
      )
      .catch(() => setSession("anonymous"));
  }, []);

  /**
   * A 401 from any authenticated API call drops the session and returns to
   * the login page with a note, instead of leaving the shell up with a bare
   * "authentication required" box in it. api.ts excludes the login route
   * itself, so a wrong password never trips this.
   */
  useEffect(() => {
    return api.onUnauthorized(() => {
      setNotice(SESSION_LOST_NOTICE);
      setSession("anonymous");
      navigate("/");
    });
  }, []);

  /**
   * Handles the login event.
   */
  const handleLoggedIn = useCallback(() => {
    setNotice(null);
    setSession("authenticated");
    navigate("/");
  }, []);

  /**
   * Handles the logout event.
   */
  const handleLogout = useCallback(() => {
    api
      .logout()
      .catch(() => {
        // Best effort: drop the local session view either way so the gate returns.
      })
      .finally(() => {
        // Loaded data is not cleared here. Every provider that holds any
        // watches `session` and drops its own on the way to "anonymous",
        // which keeps each one responsible for what it fetched instead of
        // this callback growing a line per provider.
        setNotice(null);
        setSession("anonymous");
        navigate("/");
      });
  }, []);

  return (
    <AuthContext.Provider
      value={{
        session: session,
        notice: notice,
        handleLoggedIn: handleLoggedIn,
        handleLogout: handleLogout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  return useContext(AuthContext);
};
