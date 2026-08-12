import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { registerServiceWorker } from "./lib/pwa";

// Apply the persisted font-size preference before first paint.
//
// Own-key check for the same reason as applyFontSize in Settings.jsx, whose
// comment says this path must agree with it: indexing the map directly let an
// inherited name like `toString` pass the `if` as a truthy function and then be
// rejected by CSSOM, so the pre-paint size was silently skipped. This is the path
// that actually decides what the user sees on load, so it needs the guard more
// than Settings does.
//
// Duplicated rather than imported on purpose: importing from Settings.jsx would
// pull that whole page and its dependencies into the entry chunk and delay the
// very paint this exists to get ahead of.
const FONT_PX = { small: "14px", medium: "16px", large: "18px" };
const storedFont = localStorage.getItem("rxhive_font_size");
document.documentElement.style.fontSize = Object.prototype.hasOwnProperty.call(FONT_PX, storedFont)
  ? FONT_PX[storedFont]
  : FONT_PX.medium;

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

registerServiceWorker();
