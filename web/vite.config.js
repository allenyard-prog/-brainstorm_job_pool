import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export function apiProxy(
  target = process.env.WEB_API_TARGET ?? "http://127.0.0.1:3000",
) {
  const backend = new URL(target);
  if (
    backend.protocol !== "http:" ||
    backend.hostname !== "127.0.0.1" ||
    backend.username ||
    backend.password ||
    backend.pathname !== "/"
  )
    throw new Error("WEB_API_TARGET must be a loopback HTTP origin.");
  return {
    target: backend.origin,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyReq", (proxyRequest, request) => {
        if (request.headers.origin === "http://127.0.0.1:5173")
          proxyRequest.setHeader("origin", backend.origin);
      });
    },
  };
}
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": apiProxy(), "/health": apiProxy(), "/ready": apiProxy() },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.js",
    include: ["src/**/*.test.{js,jsx}"],
    restoreMocks: true,
  },
});
