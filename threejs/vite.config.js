import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  // Publish only browser-ready assets; raw FITS/parquet data stays outside the build.
  root: path.resolve(__dirname),
  publicDir: path.resolve(__dirname, "..", "data", "export"),
  server: {
    // Listen on every IPv4 interface so localhost and Tailscale can reach it.
    // Access remains subject to the host firewall and Tailscale policy.
    host: "0.0.0.0",
    // Port 5173 is unavailable under the current Windows socket policy.
    port: 4173,
    open: true,
  },
});
