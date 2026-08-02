import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import { useSettingsStore } from "./stores/settings.store";

// Suppress the browser's native context menu globally so the app feels
// like a native desktop application rather than a web page.
document.addEventListener("contextmenu", (e) => e.preventDefault(), true);

// Synchronous light fallback so first paint is never the dark CSS default.
document.documentElement.setAttribute("data-theme", "light");

// Apply the PERSISTED theme before creating the root — but never let a
// hung plugin-store IPC deadlock startup: race load() against a 1500 ms
// timeout and render with whatever won (load() falls back to defaults
// internally and never rejects). If the timeout wins, the late load()
// still flips data-theme when it lands; the glass catch-up lives in
// load() too, so a late dark resolution still re-tints.
await Promise.race([
  useSettingsStore.getState().load(),
  new Promise<void>((resolve) => { setTimeout(resolve, 1500); }),
]);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
