// =============================================================================
// main.tsx
// The frontend's starting point (like main() in Java). It loads Bootstrap's
// styles and draws the App component into the <div id="root"> in index.html.
// =============================================================================

import React from "react";
import ReactDOM from "react-dom/client";
import "bootstrap/dist/css/bootstrap.min.css";
import App from "./App";

// StrictMode adds extra checks while developing; it has no effect in production.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
