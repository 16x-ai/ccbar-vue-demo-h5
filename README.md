# CC Bar H5 嵌入示例

手机浏览器 / App WebView 里的坐席条示例：**Vue 3 + 拨号盘 + 日志抽屉**。界面形态对齐 `@16x/webphone-sdk` 自带的移动端视图（`ccbar-web-sdk/src/ui/views/renderMobile.ts`），业务逻辑与桌面版示例 `D:\code\ccbar-vue-demo` 共用同一套约定（会话契约、状态文案、首通保护）。

**自带本地后端**：`server/` 里是从桌面 demo 搬过来的 Token 代理（会话 + 坐席状态 + fs token），`npm run dev` 会把页面和它一起起来，不用再开第二个项目。上线/接客户后端时换掉 `TOKEN_PROXY_ORIGIN` 即可，见「会话从哪来」。

## 跑起来

```powershell
cd D:\code\ccbar-vue-demo-h5
npm install
npm run dev
# 页面: http://127.0.0.1:5174  ·  Token 代理: http://127.0.0.1:3100
```

一条命令起两个进程：`server/dev.mjs` 先在 **3100** 起 Token 代理，再起 Vite（页面 **5174**），并把代理地址通过 `TOKEN_PROXY_ORIGIN` 传给 Vite。端口故意和桌面 demo（5173 / 3000）错开，两个项目可以同时跑。

- **桌面浏览器调试**：开发者工具切到手机模拟（iPhone/安卓任选）打开 `http://localhost:5174` 即可——`localhost` 是安全上下文，麦克风能用。
- **真机打开**（手机与电脑同一局域网）：`H5_HTTPS=1 npm run dev` 用自签名证书起 HTTPS，手机访问 `https://<电脑局域网IP>:5174`（IP 见启动日志的 Network 一行），首次要手动信任证书。

> 真机必须 HTTPS：`getUserMedia`（麦克风）只在安全上下文里可用，用 `http://192.168.x.x` 打开会直接拿不到麦克风。也可以换 ngrok / cloudflared 把 5174 映射成一个 https 域名。

打开页面 →「设置」填 **API 主机 / API KEY / API SECRET / 内部分机 / 软电话 WSS** →「保存」→「签入」。

## 页面操作与对应 SDK 调用

| 操作 | 行为 |
|---|---|
| 签入 / 退签 | `client.connect({ extension })` / `client.disconnect()`；签入期间申请屏幕常亮，退签释放 |
| 拨号盘 | 通话前输入号码；**通话中送 DTMF**（`call.sendDtmf(tone)`） |
| 外呼 / 内呼 | 号码上方切换；内呼会先把企业前缀拼在号码前（旧平台约定，与参考实现 `insideCall` 一致） |
| 呼叫 | `client.dial({ destination })` |
| 静音 | `call.mute()` / `call.unmute()`（只在接通后可点） |
| 挂断 | `call.hangup()` |
| 接听 / 拒接 | 来电全屏浮层（同时振动）→ `client.answer(callId)` / `call.reject({ reason })` |
| 空闲 / 休息 | `client.setAgentStatus('available' \| 'break')` |
| 置忙 | 页面直接调同源 `/set-agent-status`（SDK 的 `setAgentStatus` 没有 busy 取值，平台侧是 On Break + reason=忙碌） |

按钮统一带 busy / 连接 / 号码条件禁用；`dial` / `answer` 在未连接时**同步抛错**，都包在 `run()` 里。

## 移动端特有的四处

1. **音频解锁**：iOS / 微信里远端音频必须落在一次用户手势里才播得出来（自动播放策略）。页面在根节点 `pointerdown` 和每个按钮动作里都调一次 `media.playRemoteAudio`（幂等）——外呼接通时并没有手势，全靠这一步提前解锁。
2. **屏幕常亮**：签入后申请 `navigator.wakeLock`，页面切回前台会重新申请（浏览器切后台时会自己释放），退签 / 卸载时释放。不支持的浏览器静默跳过，但**息屏确实会掐断音频**，接入方要自己评估。
3. **来电振动**：`call.incoming` 时 `navigator.vibrate([200, 100, 200])`（iOS Safari 不支持，静默忽略）。
4. **安全区与触控**：`viewport-fit=cover` + `env(safe-area-inset-*)`；主按钮 ≥ 48px，输入框字号 16px（iOS 聚焦时不会放大页面），`touch-action: manipulation` 去掉双击缩放延迟。

## platform 传的是 mobile-web

`createClient()` 里写死 `platform: 'mobile-web'`（`src/lib/usePhone.ts`）：SDK 会按移动端形态请求会话（请求体里是 `platform: "mobile_web"`），移动端默认请求的能力是 `outbound / mute / dtmf`。不传的话 SDK 会自己探测（结果一样），写死是为了让行为确定、排障时少一个变量。

## 会话从哪来

默认旧平台形态，与桌面 demo 完全一致：

```
页面 ──POST /get-session──▶ dev 代理 ──▶ TOKEN_PROXY_ORIGIN（默认 127.0.0.1:3100）
                                            └── server/get-session.js
                                                token/fs → seat/account/get → 解出 SIP 密码 → 拼 WSS
```

- **换地址**：`.env` 里 `TOKEN_PROXY_ORIGIN=https://你们的网关`；或让页面直连你们自己的后端，用 `VITE_SESSION_API` / `VITE_AGENT_STATUS_API`（需要对方开 CORS 并允许携带 Cookie）。
- **切新平台形态**：`VITE_LEGACY_PLATFORM=0` + `WEBPHONE_PROXY_TARGET`（网关要有 `/webphone/v1/*`）。
- **接口契约、AES 解密、部署反代、排障表**都写在桌面 demo 的文档里：`D:\code\ccbar-vue-demo\docs\前端接入文档.md`。两边共用同一套契约，这里不重复，只写 H5 的差异。

## 部署

`npm run build` 产出纯静态 `dist\`。上线时**必须 HTTPS**，并且同源反代：

| 路径 | 转发到 | 什么时候用 |
|---|---|---|
| `/get-session` | 本仓库的 `server/token-server.js`（`npm run token-server`，或你们自己的会话服务） | 默认形态（旧平台） |
| `/set-agent-status` | 同上（空闲 / 置忙 / 休息 / 退签） | 默认形态（旧平台） |
| `/get-token`、`/webphone/v1/*` | 平台的签发 / WebPhone API | 只有新平台形态时 |

## 已知环境行为

平台在**每次注册完成后的首个外呼**会回 `480 Temporarily Unavailable`（`Q.850;cause=16`），几秒内自愈。页面按「首次失败」起算的 1.5s / 3s / 6s 自动重拨兜底：**额度按每次签入记账，一轮最多 3 次**，重拨自己再失败不会重置次数或重新计时；某一路接通、退签、或额度用完即停止；已有呼叫在响或在通话时跳过该时间点。节奏与计数在 `src/lib/callRetry.ts`（有单测）。

## 脚本与目录

| 命令 | 作用 |
|---|---|
| `npm run dev` | 页面 + Token 代理一起起（`H5_HTTPS=1` 时页面走自签名 HTTPS，便于真机调试） |
| `npm run dev:vite` / `npm run token-server` | 只起其中一个（改后端代码时方便） |
| `npm test` | `node --test`：日志/校验/会话/首通保护 + 会话与坐席状态接口 + 六个 Vue 组件编译 |
| `npm run typecheck` / `npm run build` | `vue-tsc` / 生产构建（Node ≥ 22.18） |

```
src/App.vue              整屏骨架：状态条 + 号码/拨号盘 + 主操作 + 坐席状态 + 日志抽屉
src/components/          Dialpad / SettingsDialog / LogPanel / IncomingCallModal / LoadingOverlay
src/lib/usePhone.ts      页面逻辑（含移动端三件事：音频解锁、屏幕常亮、来电振动）
src/lib/callRetry.ts     首通保护：重拨节奏与额度（纯函数，有单测）
src/lib/session.ts       会话来源（默认 sessionProvider）+ 坐席状态
src/lib/settings.ts      设置读、校验、写 localStorage
src/lib/sipDebug.ts      SIP 原文：打开 JsSIP debug 并接住 console
src/lib/logs.ts          日志格式化与状态文案（纯函数，有单测）
src/lib/helpers.ts       地址校验、分机前缀处理
server/dev.mjs           一次起两个进程：Token 代理(3100) + Vite(5174)
server/token-server.js   HTTP 服务：/get-session、/set-agent-status、/get-token、/health
server/get-session.js    token/fs → seat/account/get → 解出 SIP 密码 → 拼会话
server/get-token.js      fs token（X-Ca 签名 + 缓存）
server/set-agent-status.js  坐席状态 → 平台 seats/set-status
```

> `src/lib/`（除 `usePhone.ts`）和整个 `server/` 都是从桌面 demo 原样搬过来的，表现层才是 H5 的差异。改这些共用文件时建议两边同步，尤其是 `logs.ts` 的文案、`callRetry.ts` 的重拨节奏、以及 `server/` 里的接口路径。
