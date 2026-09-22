import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import basicSsl from "@vitejs/plugin-basic-ssl";
import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv, searchForWorkspaceRoot, type Plugin } from "vite";

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
        const headers = { ...req.headers, host: target.host };
        delete headers.connection;
        const proxyReq = http.request(
          target,
          { method: req.method, headers },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
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
