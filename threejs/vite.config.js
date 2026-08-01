import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  // Publish only browser-ready assets; raw FITS/parquet data stays outside the build.
  root: path.resolve(__dirname),
  publicDir: path.resolve(__dirname, "..", "data", "export"),
  server: {
    // Windows may resolve localhost to IPv6 (::1), which can be blocked by the
    // local socket policy. Bind explicitly to the IPv4 loopback interface.
    host: "127.0.0.1",
    // Port 5173 is unavailable under the current Windows socket policy.
    port: 4173,
    open: true,
  },
});
