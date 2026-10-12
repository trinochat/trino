import React from "react";
import ReactDOM from "react-dom/client";
import "./design/fonts";
import "./design/base.css";
import App from "./App";
import { applyStoredCaptureProtection } from "./app/capture-protection";
import { initAppearance } from "./design/apply";
import { api } from "./lib/api";

// The appearance (data-style, data-mode, --t-*) and the accessibility
// settings (the root font size, data-vision, data-contrast, data-motion,
// data-spacing), applied before the first render so nothing flashes or jumps.
// Whatever follows the system (colour scheme, contrast, motion, Windows' text
// size) keeps following it. Ctrl + and Ctrl - change the text size, and
// Ctrl 0 follows Windows' again.
initAppearance(window, { readSystemTextScale: api.systemTextScale });

// The window is created out of screenshots, recordings and screen sharing
// (tauri.conf.json, contentProtected); this applies the choice stored in
// Settings › Privacidad before anything is drawn, the unlock screen included.
void applyStoredCaptureProtection();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
