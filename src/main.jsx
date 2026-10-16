import React from "react";
import { createRoot } from "react-dom/client";
import { SessionViewer } from "./components/SessionViewer.jsx";
import "./style.css";

export { SessionViewer };

if (typeof document !== "undefined") {
  const rootElement = document.getElementById("root");
  if (rootElement) createRoot(rootElement).render(<React.StrictMode><SessionViewer /></React.StrictMode>);
}
