import { useState, type SubmitEvent } from "react";
import * as api from "../api.js";
import { cn } from "../utils/cn.js";
import { CopyCode } from "../components/reusable/copy-code.js";
import { Button } from "../components/reusable/button.js";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState<string>("");
  const [password, setPassword] = useState<string>("");

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (password.length === 0 || loading) return;
    if (username.length === 0) {
      setError("Username is required");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Attempt login
      await api.login(username, password);

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

  const handleClearForm = () => {
    setUsername("");
    setPassword("");
    setError(null);
  };

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
            <div className="field">
              <label htmlFor="email">Username / Email</label>
              <input
                id="email"
                className="input"
                type="text"
                autoFocus
                autoComplete="current-username"
                placeholder="Enter your username or email"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                className="input"
                type="password"
                autoFocus
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {error !== null && <div className="error-text">{error}</div>}

            <div className="flex items-center gap-2 justify-end pt-2">
              <Button
                variant="ghost"
                disabled={
                  loading || password.length === 0 || username.length === 0
                }
                onClick={handleClearForm}
              >
                Clear form
              </Button>

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
          no reset link and no recovery, on purpose.
        </p>
      </form>
    </div>
  );
}
