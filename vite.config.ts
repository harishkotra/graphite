import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend on 5173; everything model/exec related goes through the Node
// gateway on 3001 (which fronts the FastAPI executor on 8000).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.GRAPHITE_GATEWAY ?? "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
});
