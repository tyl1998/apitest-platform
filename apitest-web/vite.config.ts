import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 前端内部转发（同源）：浏览器只连页面来源（5173），SPA 的 `/api/v1/*` 请求由 dev server
 * 反代到后端，因此没有跨源、不依赖后端 CORS。生产由 Nginx 承担同一层 `/api` 转发。
 *
 * 后端地址取自 `VITE_DEV_API_PROXY_TARGET`（缺省 http://localhost:3000），只作用于 dev server，
 * 不进 bundle。要绕开转发直连后端时，改用 `VITE_API_BASE_URL`（见 .env.example），axios 会
 * 直接打那个绝对地址。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_DEV_API_PROXY_TARGET ?? "http://localhost:3000";
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true },
      },
    },
  };
});
