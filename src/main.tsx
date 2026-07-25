import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import "./styles/vibrancy.css";

// Default to light theme. Set before first paint to avoid a flash of the
// dark default. (Swap to "dark" for dark mode.)
document.documentElement.setAttribute("data-theme", "light");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
