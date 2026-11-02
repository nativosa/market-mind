import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The browser talks only to /api on its own origin. In development Vite (127.0.0.1:5173) proxies /api
// to the MarketMind web server, which must then allow that origin: MARKETMIND_WEB_DEV_ORIGIN=http://127.0.0.1:5173
// (npm run web:dev sets it). The proxy keeps the browser's Host and Origin, so the server checks them as usual.
export const DEV_ORIGIN = "http://127.0.0.1:5173";
const apiPort = process.env.MARKETMIND_WEB_PORT ?? "4317";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
