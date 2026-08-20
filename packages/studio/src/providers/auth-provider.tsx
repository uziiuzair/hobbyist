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
  handleLoggedIn: () => void;
  handleLogout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  session: "checking",
  handleLoggedIn: () => {},
  handleLogout: () => {},
});

export const AuthProvider = ({ children }: { children?: React.ReactNode }) => {
  const [session, setSession] = useState<SessionState>("checking");

  useEffect(() => {
    api
      .session()
      .then((result) =>
        setSession(result.authenticated ? "authenticated" : "anonymous"),
      )
      .catch(() => setSession("anonymous"));
  }, []);

  /**
   * Handles the login event.
   */
  const handleLoggedIn = useCallback(() => {
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
        setSession("anonymous");
        navigate("/");
      });
  }, []);

  return (
    <AuthContext.Provider
      value={{
        session: session,
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
