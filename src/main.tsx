import React from "react";
import ReactDOM from "react-dom/client";
import "./design/fonts";
import App from "./App";
import { initAppearance } from "./design/apply";
import { applyThemePreference, loadThemePreference } from "./lib/theme";

// Legacy theme of the current screens (data-theme, --color-*).
applyThemePreference(loadThemePreference());
// Redesign tokens (data-style, data-mode, --t-*), applied before the first
// render so nothing flashes; in "system" mode they follow the OS colour scheme.
initAppearance(window);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
