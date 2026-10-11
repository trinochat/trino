import React from "react";
import ReactDOM from "react-dom/client";
import "./design/fonts";
import "./design/base.css";
import App from "./App";
import { initAppearance } from "./design/apply";
import { api } from "./lib/api";
import { applyThemePreference, loadThemePreference } from "./lib/theme";

// Legacy theme of the current screens (data-theme, --color-*).
applyThemePreference(loadThemePreference());
// Redesign tokens (data-style, data-mode, --t-*) and the accessibility
// settings (the root font size, data-vision, data-contrast, data-motion,
// data-spacing), applied before the first render so nothing flashes or jumps.
// Whatever follows the system (colour scheme, contrast, motion, Windows' text
// size) keeps following it. Ctrl + and Ctrl - change the text size, and
// Ctrl 0 follows Windows' again.
initAppearance(window, { readSystemTextScale: api.systemTextScale });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
