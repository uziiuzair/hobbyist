import { useState, type SubmitEvent } from "react";
import * as api from "../api.js";
import { cn } from "../utils/cn.js";
import { CopyCode } from "../components/reusable/copy-code.js";
import { Button } from "../components/reusable/button.js";

// Password only (issue #123). Studio has one operator credential and no
// accounts (ADR 0008), and the daemon's login handler reads nothing but
// `password`, so a username field was a question with no reader. The form
// submits on Enter whenever the password is non-empty, which is what a
// single-field form is expected to do.
export function Login({
  onLoggedIn,
  notice = null,
}: {
  onLoggedIn: () => void;
  // Why the login page is showing, when there is a reason worth stating
  // (a session that ended underneath the app, see auth-provider.tsx).
  notice?: string | null;
}) {
  const [password, setPassword] = useState<string>("");

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (password.length === 0 || loading) return;

    setLoading(true);
    setError(null);

    try {
      await api.login(password);

      onLoggedIn();
    } catch (err) {
      setError(
        err instanceof api.ApiError
          ? err.message
          : "could not reach the daemon",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <form
        className="login-card"
        onSubmit={(event) => void handleSubmit(event)}
      >
        <div className="login-brand">
          <span className="login-mark" aria-hidden="true">
            <i />
          </span>

          <div>
            <div className="login-title">Hobbyist Studio</div>
            <div className="login-sub">The panel on your machine</div>
          </div>
        </div>
        <div className={cn("card", "p-4.5")}>
          <div className="stack">
            {notice !== null && (
              <div className="notice" role="status">
                {notice}
              </div>
            )}

            <div className="field">
              <label htmlFor="password">Operator password</label>
              <input
                id="password"
                className="input"
                type="password"
                autoFocus
                autoComplete="current-password"
                placeholder="Enter the operator password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {error !== null && <div className="error-text">{error}</div>}

            <div className="flex items-center gap-2 justify-end pt-2">
              <Button
                type="submit"
                variant="primary"
                className="w-fit"
                disabled={loading || password.length === 0}
              >
                {loading ? "Signing in..." : "Sign in"}
              </Button>
            </div>
          </div>
        </div>

        <p className={cn("dim", "text-xs mt-3.5 leading-normal")}>
          Set on the box with <CopyCode>hobby studio passwd</CopyCode>. There is
          no username, no reset link and no recovery, on purpose.
        </p>
      </form>
    </div>
  );
}
