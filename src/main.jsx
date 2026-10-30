import React from "react";
import { createRoot } from "react-dom/client";
import { SessionViewer } from "./components/SessionViewer.jsx";
import { browserLogger, initializeBrowserLogger, safeBrowserError } from "./lib/logger.js";
import "./style.css";

export { SessionViewer };

if (typeof document !== "undefined") {
  const rootElement = document.getElementById("root");
  if (rootElement) {
    initializeBrowserLogger();
    createRoot(rootElement, {
      onCaughtError: (error) => browserLogger.log("browser_error", { ...safeBrowserError(error), error_code: "render_error", action: "failure" }),
      onUncaughtError: (error) => browserLogger.log("browser_error", { ...safeBrowserError(error), error_code: "render_error", action: "failure" }),
      onRecoverableError: (error) => browserLogger.log("browser_error", { ...safeBrowserError(error), error_code: "recoverable_render_error", action: "failure" }),
    }).render(<React.StrictMode><SessionViewer /></React.StrictMode>);
  }
}
