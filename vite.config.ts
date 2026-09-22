import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import basicSsl from "@vitejs/plugin-basic-ssl";
import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv, searchForWorkspaceRoot, type Plugin } from "vite";

// 逐跳（hop-by-hop）头：h1 里可以转发，h2 里是禁止的
const DROP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);

/**
 * 把一份 Node 头对象整理成可以在 h1 / h2 之间搬运的样子：剔除伪头与逐跳头。
 *
 * 两个坑（都是 HTTPS 模式才暴露，因为 Vite 的 HTTPS dev server 是
 * `http2.createSecureServer`（带 allowHTTP1），浏览器一上 https 就走 h2）：
 *   1. 请求方向：h2 的 `req.headers` 带 `:method` / `:path` / `:authority` 伪头，
 *      透传给 `http.request()` 会抛 `Header name must be a valid HTTP token [":method"]` → 接口 500。
 *   2. 响应方向：h1 响应里的 `keep-alive` / `connection` 写回 h2 响应会抛
 *      `ERR_HTTP2_INVALID_CONNECTION_HEADERS` —— 这是**未捕获异常，直接把 Vite 进程带崩**。
 * 表现就是「http 打开一切正常，换成 https（手机必须 https）就 Internal server error / dev server 挂掉」。
 */
function forwardHeaders(source: Record<string, string | string[] | undefined>) {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const name = key.toLowerCase();
    if (name.startsWith(":") || DROP_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  return headers;
}

// 会话 / 坐席状态 / Token 三个接口由本仓库的 server/（token-server.js）提供，
// npm run dev 会先在 127.0.0.1:3100 起它，再起页面并把地址通过 TOKEN_PROXY_ORIGIN 传进来。
// 换成你们自己的后端时，把 TOKEN_PROXY_ORIGIN 改成你们的地址（或部署时直接反代，见 README）。
function tokenProxyPlugin(tokenOrigin: string): Plugin {
  const prefixes = [
    "/api/xcall/webphone-token",
    "/ccbar/",
    "/get-token",
    "/get-session",
    "/set-agent-status",
  ];
  return {
    name: "ccbar-token-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || "";
        if (!prefixes.some((prefix) => url === prefix || url.startsWith(prefix))) {
          next();
          return;
        }
        const target = new URL(url, tokenOrigin);
        const headers = forwardHeaders(req.headers);
        headers.host = target.host;
        const proxyReq = http.request(
          target,
          { method: req.method, headers },
          (proxyRes) => {
            // 响应方向同样要过滤：h1 的 keep-alive / connection 写进 h2 响应会直接抛异常
            res.writeHead(proxyRes.statusCode || 500, forwardHeaders(proxyRes.headers));
            proxyRes.pipe(res);
          },
        );
        proxyReq.on("error", (error) => {
          console.error(`[token-proxy] ${tokenOrigin} ${error.message}`);
          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              code: -1,
              message:
                `连不上 Token 代理 ${tokenOrigin}：${error.message}。` +
                `用 npm run dev 会把两个进程一起起来；单独跑 npm run dev:vite 时要先 npm run token-server`,
            }),
          );
        });
        req.pipe(proxyReq);
      });
    },
  };
}

// 本机的局域网 IPv4（真机用 https 时要写进自签证书里，否则手机看到的域名对不上，
// 会多一层「名称不匹配」报警——自签证书本身仍会提示不受信任，点一次「继续访问」即可）
function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(
      (info): info is os.NetworkInterfaceInfo =>
        info !== undefined && info.family === "IPv4" && !info.internal,
    )
    .map((info) => info.address);
}

const sdkRoot = fileURLToPath(new URL("../ccbar-web-sdk", import.meta.url));
const sdkSrc = path.join(sdkRoot, "src");
// 本地有 SDK 源码时优先用源码（方便调 SDK），没有就用 npm 上的 @16x/webphone-sdk
// 想强制走 npm 包：CCBAR_LOCAL_SDK=0 npm run build
const useLocalSdk = process.env.CCBAR_LOCAL_SDK !== "0" && fs.existsSync(sdkSrc);

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const tokenOrigin =
    process.env.TOKEN_PROXY_ORIGIN || env.TOKEN_PROXY_ORIGIN || "http://127.0.0.1:3100";
  // 新平台形态才用得到（页面直连 /webphone/v1/*）；旧平台形态留空即可
  const webphoneTarget = process.env.WEBPHONE_PROXY_TARGET || env.WEBPHONE_PROXY_TARGET;
  const apiPrefix = (
    process.env.WEBPHONE_API_PREFIX ||
    env.WEBPHONE_API_PREFIX ||
    "/webphone"
  ).replace(/\/+$/, "");
  // 真机调试要 HTTPS：getUserMedia（麦克风）只在安全上下文里可用，
  // 用 http://<局域网IP>:5174 打开手机页面会直接拿不到麦克风。
  //   H5_HTTPS=1 npm run dev   → 自签名证书，手机首次打开要点「继续访问」
  // 也可以在 .env 里写 H5_HTTPS=1，省得每次带环境变量
  const https = String(process.env.H5_HTTPS || env.H5_HTTPS || "") === "1";
  return {
    resolve: {
      alias: [
        ...(useLocalSdk
          ? [
              {
                find: "@16x/webphone-sdk/styles.css",
                replacement: path.join(sdkSrc, "ui/styles/index.css"),
              },
              {
                find: "@16x/webphone-sdk/shared-worker",
                replacement: path.join(sdkSrc, "shared-worker.ts"),
              },
              {
                find: "@16x/webphone-sdk/diagnostics",
                replacement: path.join(sdkSrc, "diagnostics/index.ts"),
              },
              {
                find: "@16x/webphone-sdk/legacy",
                replacement: path.join(sdkSrc, "legacy/index.ts"),
              },
              {
                find: "@16x/webphone-sdk/ui",
                replacement: path.join(sdkSrc, "ui/index.ts"),
              },
              {
                find: "@16x/webphone-sdk",
                replacement: path.join(sdkSrc, "index.ts"),
              },
            ]
          : []),
      ],
    },
    optimizeDeps: {
      ...(useLocalSdk ? { exclude: ["@16x/webphone-sdk"] } : {}),
    },
    plugins: [
      tokenProxyPlugin(tokenOrigin),
      ...(https ? [basicSsl({ domains: lanAddresses() })] : []),
      vue(),
    ],
    server: {
      // 手机要能打开，所以监听所有网卡（局域网 IP 见 npm run dev 打印的 Network 一行）
      host: true,
      port: 5174,
      strictPort: true,
      fs: {
        allow: [searchForWorkspaceRoot(process.cwd()), sdkRoot],
      },
      ...(webphoneTarget
        ? {
            proxy: {
              "/webphone": {
                target: webphoneTarget,
                changeOrigin: true,
                ws: true,
                rewrite: (requestPath: string) =>
                  requestPath.replace(/^\/webphone/, apiPrefix),
              },
              "/openapi": { target: webphoneTarget, changeOrigin: true, ws: true },
            },
          }
        : {}),
    },
  };
});
