import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./theme.css";
import { AuthProvider } from "./providers/auth-provider.js";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("missing #root element");
}

createRoot(container).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
