import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  // Serve the repo root so that /export/ resolves to ../export/ from threejs/
  root: path.resolve(__dirname),
  publicDir: path.resolve(__dirname, ".."),
  server: {
    port: 5173,
    open: true,
  },
});
