// =============================================================================
// vite.config.ts
// Settings for Vite, the tool that runs the React app while you develop.
// =============================================================================

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Adds React support (JSX, fast refresh when you save a file).
  plugins: [react()],

  server: {
    // The React app runs at http://localhost:5173
    port: 5173,

    // Any request starting with /api is forwarded to the Express server.
    // The browser only ever talks to one address, so there are no CORS problems.
    // This only exists while Vite runs in development (npm run dev).
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
