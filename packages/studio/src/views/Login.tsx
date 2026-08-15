import { useState, type SubmitEvent } from "react";
import * as api from "../api.js";
import { cn } from "../utils/cn.js";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(
    event: SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (password.length === 0 || busy) return;
    setBusy(true);
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
      setBusy(false);
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
        <div className={cn("card", "p-4")} style={{ padding: 18 }}>
          <div className="stack">
            <div className="field">
              <label htmlFor="password">Operator password</label>
              <input
                id="password"
                className="input"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {error !== null && <div className="error-text">{error}</div>}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || password.length === 0}
            >
              {busy ? "Signing in..." : "Sign in"}
            </button>
          </div>
        </div>
        <p
          className="dim"
          style={{ fontSize: 12, marginTop: 14, lineHeight: 1.5 }}
        >
          Set on the box with <code className="mono">hobby studio passwd</code>.
          There is no reset link and no recovery, on purpose.
        </p>
      </form>
    </div>
  );
}
