import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const port = Number(process.env.CTV_LOG_VIEWER_PORT || 4318);
export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5174, strictPort: true, proxy: { "/api": "http://127.0.0.1:" + port } },
});
