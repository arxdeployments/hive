import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { registerServiceWorker } from "./lib/pwa";

// Apply the persisted font-size preference before first paint.
const fontSize = { small: "14px", medium: "16px", large: "18px" }[
  localStorage.getItem("rxhive_font_size") || "medium"
];
if (fontSize) document.documentElement.style.fontSize = fontSize;

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

registerServiceWorker();
