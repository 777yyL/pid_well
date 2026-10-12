import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/web", chunkSizeWarningLimit: 1500 },
  server: { host: "127.0.0.1" },
});
