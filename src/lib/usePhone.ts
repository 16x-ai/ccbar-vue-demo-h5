/**
 * H5 页面的全部逻辑：签入 / 通话 / 拨号盘 / 日志 / 状态。
 *
 * 业务逻辑与桌面版（D:\code\ccbar-vue-demo\src\lib\usePhone.ts）保持一致，只差三处：
 *   1. 建客户端时 platform 传 'mobile-web'（SDK 按移动端形态请求会话）；
 *   2. 不做 保持 / 恢复 / 转接（移动端形态用不上），改做 静音 / DTMF / 拨号盘输入；
 *   3. 补上移动端特有的三件事：音频解锁（iOS 自动播放策略）、屏幕常亮（通话时别锁屏）、来电振动。
 *
 * 会话从哪来、重拨节奏、日志文案分别在 session.ts / callRetry.ts / logs.ts 里，这里只做编排。
 */

import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from "vue";
import { CCBarClient } from "@16x/webphone-sdk";
import type { CCBarCall, CCBarClientOptions } from "@16x/webphone-sdk";
import { createCallRetry } from "./callRetry";
import { prefixExtension, shortExtension } from "./helpers";
import {
  agentStatus,
  callStatus,
  connectionStatus,
  isTemporarySipFailure,
  sipEventDetail,
  stringifyLog,
  timeStamp,
} from "./logs";
import type { AgentState, CallState, ConnectionState, LogLevel, LogLine, LogPanel } from "./logs";
import {
  SEAT_STATUS_TEXT,
  createLegacySessionProvider,
  createTokenProvider,
  isLegacyPlatform,
  setSeatStatus,
} from "./session";
import type { SeatAccount } from "./session";
import { createConfig, normalizeConfig, persistConfig } from "./settings";
import type { PhoneConfig } from "./settings";
import { enableJsSipDebug } from "./sipDebug";

/** 来电浮层里的一路来电 */
export type IncomingCall = { callid: string; callerName: string };

/** 拨号盘的两种用途：外呼（直接拨号）与内呼（拼企业前缀 + 分机号） */
export type DialMode = "outbound" | "extension";

// 日志最多留多少行：手机内存比桌面紧张，上限压到 300
const LOG_LIMIT = 300;

// 首通保护：平台在每次注册完成后的**第一次外呼**会回 480（Q.850 cause=16），几秒内自愈。
// 重拨的时间点与次数都在 lib/callRetry.ts（有单测），这里只留页面侧的两个参数：
//
// 失败事件要落在最后一次拨号后这么久之内，才算「我们这通外呼失败了」：
// call.failed 不带方向，SDK 又会在发事件前把通话从 getCalls() 里删掉，只能用时间窗认领。
const OUTBOUND_FAILURE_WINDOW_MS = 60_000;

// 真正「在响 / 在通话」的状态：这时候不插自动重拨。
// new / dialing 不算 —— 那可能正是重拨自己刚拨出去的那一路。
const LIVE_CALL_STATES: readonly CallState[] = ["ringing", "connecting", "active", "held"];

// 可以送 DTMF 的状态：只有接通之后（保持中也能送）
const DTMF_CALL_STATES: readonly CallState[] = ["active", "held"];

// SIP 保活间隔（秒）。平台侧注册有效期 600 秒，这里也设 600 ＝ 不额外发心跳，
// 只由 JsSIP 在到期前续一次。链路上有 nginx/NAT 空闲超时（默认 60 秒）时会被静默掐断
// 长连接（表现为「显示已注册但呼叫失败」），这时把 VITE_SIP_KEEPALIVE 设成 25。
function sipKeepaliveSeconds(): number {
  const raw = String(import.meta.env?.VITE_SIP_KEEPALIVE ?? "").trim();
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 600;
}

// 可选：WebPhone API 的基地址（新平台形态才用）。留空＝同源，由 Vite / nginx 转给平台。
function webphoneBaseUrl(): string {
  return String(import.meta.env?.VITE_WEBPHONE_API_BASE || "")
    .trim()
    .replace(/\/+$/, "");
}

// 屏幕常亮：手机息屏会掐掉音频，签入期间申请一把，退签时释放。
type WakeLockSentinel = { release: () => Promise<void> };
type WakeLockApi = { request: (type: "screen") => Promise<WakeLockSentinel> };

export function usePhone() {
  // ---------- 状态 ----------
  const config = reactive<PhoneConfig>(createConfig());
  const client = shallowRef<CCBarClient>();
  const connection = ref<ConnectionState | "registered">("offline");
  const callState = ref<CallState | "idle">("idle");
  const agent = ref<AgentState>("offline");
  /** 当前分机（签入成功后显示在标题右边） */
  const extension = ref("");
  /** 拨号盘输入的内容 */
  const number = ref("");
  /** 外呼 / 内呼：内呼会在号码前拼企业前缀（见 helpers.prefixExtension） */
  const dialMode = ref<DialMode>("outbound");
  /** 是否已静音（只对当前这路通话有意义） */
  const muted = ref(false);
  /** 当前通话的对方号码：通话中把拨号盘上方的大字换成它 */
  const callDestination = ref("");
  /** 页面上那一行红色错误提示 */
  const feedback = ref("");
  /** 正在执行的动作名，用来禁用按钮防重复点击 */
  const busy = ref("");
  /** 全屏加载提示文案（空＝不显示）：签入、设置坐席状态这类要等服务的操作会用它 */
  const loading = ref("");
  const logs = ref<LogLine[]>([]);
  const incoming = ref<IncomingCall[]>([]);
  const placeholder = reactive<Record<LogPanel, string>>({
    flow: "等待签入。签入、取 Token、坐席账号会写在这里。",
    sip: "等待话机登录。连接与通话事件会写在这里。",
  });

  const connected = computed(
    () => connection.value === "registered" || connection.value === "connected",
  );
  /** 有未结束的通话（含还没接听的来电）——决定通话面板与挂断按钮 */
  const hasCall = computed(
    () => !["idle", "ended", "failed"].includes(callState.value),
  );
  /** 能不能送 DTMF / 静音 */
  const callActive = computed(() => DTMF_CALL_STATES.includes(callState.value as CallState));

  // ---------- 内部记账 ----------
  let logSequence = 0;
  let unsubscribeSipDebug: (() => void) | undefined;
  const subscriptions: Array<() => void> = [];
  /** 最近一次拨出去的号码与时间：用来认领 call.failed 是不是我们这通外呼 */
  let lastDialTarget = "";
  let lastDialAt = 0;
  /** 网关是旧平台还是新平台（构建时决定，见 session.ts） */
  const legacyPlatform = isLegacyPlatform();
  /** 旧平台的坐席前缀（customerPrefix）：标题栏要和分机一起显示，内呼时也要拼在号码前 */
  const customerPrefix = ref("");
  /** 平台认的坐席账号（取回会话后才知道，可能带企业前缀）；置忙 / 退签要用它 */
  let seatAccount = config.extension;
  let activeCallId = "";

  // ---------- 移动端特有的小事 ----------
  const wakeLockApi = (navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock;
  let wakeLock: WakeLockSentinel | undefined;

  async function acquireWakeLock(): Promise<void> {
    if (!wakeLockApi || wakeLock) return;
    try {
      wakeLock = await wakeLockApi.request("screen");
    } catch {
      /* 浏览器不支持或被策略拒绝：不影响通话，只是可能息屏断音 */
    }
  }
  function releaseWakeLock(): void {
    if (!wakeLock) return;
    void wakeLock.release().catch(() => undefined);
    wakeLock = undefined;
  }
  /** 页面切到后台时浏览器会自动释放常亮，回到前台要重新申请 */
  function onVisibilityChange(): void {
    if (document.visibilityState === "visible" && connected.value) void acquireWakeLock();
  }
  /** 来电振动（安卓/部分浏览器支持，iOS Safari 不支持，静默忽略） */
  function vibrate(pattern: number | number[]): void {
    try {
      (navigator as unknown as { vibrate?: (input: number | number[]) => boolean }).vibrate?.(pattern);
    } catch {
      /* 不支持就算了 */
    }
  }

  // ---------- 日志 ----------
  function appendPanelLog(panel: LogPanel, level: LogLevel, source: string, message: unknown) {
    logs.value = [
      ...logs.value,
      {
        id: ++logSequence,
        panel,
        level,
        source,
        message: stringifyLog(message),
        time: timeStamp(),
      },
    ].slice(-LOG_LIMIT);
  }
  /** 写流程日志；来源是 sip/jssip 时自动落到 SIP 面板（与参考页一致） */
  function appendFlowLog(level: LogLevel, source: string, message: unknown) {
    appendPanelLog(/^(sip|jssip)$/i.test(source) ? "sip" : "flow", level, source, message);
  }
  function clearLog(panel: LogPanel) {
    logs.value = logs.value.filter((line) => line.panel !== panel);
    placeholder[panel] = panel === "sip" ? "SIP 日志已清空。" : "日志已清空。";
  }

  // ---------- 错误行 ----------
  function clearError() {
    feedback.value = "";
  }
  function showError(message: unknown) {
    const text = stringifyLog(message).trim();
    if (!text) {
      clearError();
      return;
    }
    feedback.value = text;
    appendFlowLog("error", "ccbar", text);
  }

  // ---------- 设置 ----------
  /**
   * 保存设置：校验 → 写盘。
   * 校验失败会抛错，由页面显示到错误行（App.vue 的 saveSettings）。
   */
  function saveSettings() {
    const next = normalizeConfig(config);
    Object.assign(config, next);
    persistConfig(next);
  }

  // ---------- 通话状态 ----------
  /** 从 SDK 的通话列表里挑出「当前这一路」，页面状态标签与按钮都用它 */
  function refreshCallState() {
    const calls = client.value?.getCalls() ?? [];
    const active = client.value?.getActiveCall();
    // 来电在接通之前不算 active call，所以退回到第一路还没结束的通话
    const target =
      active ?? calls.find((call) => call.state !== "ended" && call.state !== "failed");
    activeCallId = target?.id ?? "";
    callState.value = target ? target.state : "idle";
    callDestination.value = target?.destination ?? "";
    // 通话结束/切走时别把「静音」留在按钮上
    if (!target) muted.value = false;
  }
  function currentCall(): CCBarCall | undefined {
    return client.value?.getActiveCall() ?? client.value?.getCalls().find((call) => call.id === activeCallId);
  }
  function removeIncoming(callId: string) {
    incoming.value = incoming.value.filter((call) => call.callid !== callId);
  }

  // ---------- 首通保护：注册后第一个外呼回 480 时兜底重拨 ----------
  // 节奏与次数都在 lib/callRetry.ts（那里有单测）：每次签入最多 3 次、
  // 链条自己失败不会把进度清零、时间点从第一次失败起算。
  // 这里只负责把事件翻译成日志，以及「拨哪儿、什么时候不拨」。
  const retry = createCallRetry({
    // 重拨走 startCall（不经过 dial），否则会把正在跑的链条自己取消掉
    attempt: (target) => {
      void startCall(target).catch(() => undefined);
    },
    // 已经有呼叫在响/在通话就别插进去抢（new / dialing 可能是重拨自己那一路）
    hasLiveCall: () =>
      (client.value?.getCalls() ?? []).some((call) => LIVE_CALL_STATES.includes(call.state)),
    onEvent: (event) => {
      switch (event.type) {
        case "armed":
          appendFlowLog(
            "warn",
            "sip",
            `呼叫暂时不可用，${event.delays.map((ms) => `${ms / 1000}s`).join(" / ")} 处自动重拨` +
              `（本次签入最多 ${event.delays.length} 次）`,
          );
          break;
        case "attempt":
          appendFlowLog("warn", "sip", `自动重拨（第 ${event.attempt} 次）${event.target}`);
          break;
        case "skipped":
          appendFlowLog("info", "sip", `跳过第 ${event.attempt} 次自动重拨：已有呼叫在响或在通话`);
          break;
        case "exhausted":
          appendFlowLog("warn", "sip", "自动重拨已用完，不再兜底（下次签入才会重新记账）");
          break;
      }
    },
  });

  // ---------- 动作：给页面按钮调用 ----------
  /**
   * iOS / 微信里远端音频必须落在一次用户手势里才播得出来（自动播放策略）。
   * 页面根节点的每次点按、以及每个按钮动作都会调它 —— 幂等，重复调没有代价。
   * 外呼接通时没有任何手势，全靠这一步提前把播放权限解锁。
   */
  function unlockRemoteAudio() {
    const call = client.value?.getActiveCall();
    if (!call) return;
    void client.value?.media?.playRemoteAudio?.(call.id).catch(() => undefined);
  }

  /** 统一包一层：防重复点击、清掉上一次的错误、结束刷新通话状态 */
  async function run(name: string, action: () => unknown | Promise<unknown>) {
    if (busy.value) return;
    busy.value = name;
    clearError();
    unlockRemoteAudio();
    try {
      await action();
    } catch (error) {
      // dial / answer 在未连接时是同步抛错，所以 try 必须包住调用本身
      showError(error instanceof Error ? error.message : error);
    } finally {
      busy.value = "";
      refreshCallState();
    }
  }

  async function signIn() {
    saveSettings();
    const instance = client.value;
    if (!instance) throw new Error("SDK 未就绪，请刷新页面");
    extension.value = config.extension;
    appendFlowLog("info", "sip", `开始签入 extension=${config.extension} host=${config.host}`);
    // 取会话 → 连 WSS → REGISTER 要几秒，期间盖全屏遮罩，别让人以为卡住了
    loading.value = "正在签入…";
    try {
      await instance.connect({ extension: config.extension });
    } finally {
      loading.value = "";
    }
  }

  async function signOut() {
    retry.finish();
    releaseWakeLock();
    await client.value?.disconnect();
    // 与旧版一致：退签时把坐席置为「退出登录」，否则平台上还挂着这个坐席。
    // 只是告知平台，失败不阻塞退签（页面状态照旧清空）
    if (legacyPlatform) {
      const [status, reason] = SEAT_STATUS_TEXT.offline;
      void setSeatStatus(config, seatAccount, status, reason, appendFlowLog).catch((error: unknown) => {
        appendFlowLog("warn", "seat", `置离线失败：${error instanceof Error ? error.message : error}`);
      });
    }
    connection.value = "offline";
    agent.value = "offline";
    callState.value = "idle";
    extension.value = "";
    customerPrefix.value = "";
    callDestination.value = "";
    muted.value = false;
    incoming.value = [];
  }

  /**
   * 真正拨出去：外呼、内呼、以及首通保护的重拨都走这里（所以不碰重拨链的状态）。
   * 内呼在旧平台上的含义就是「企业前缀 + 分机号」（参考实现 insideCall 的拼法），
   * 不能只靠 SDK 的 type=extension —— 那只是在 INVITE 上加一个平台不认的头。
   */
  async function startCall(destination: string, extensionCall = false) {
    const instance = client.value;
    if (!instance) throw new Error("请先签入");
    const target = extensionCall && legacyPlatform ? prefixExtension(destination, customerPrefix.value) : destination;
    // 记下这一通是谁、什么时候拨的：call.failed 来得太晚就不认（可能是别的通话失败了）
    lastDialTarget = target;
    lastDialAt = Date.now();
    const note = extensionCall && target !== destination ? `（拼前缀 ${customerPrefix.value}）` : "";
    appendFlowLog(
      "info",
      "sip",
      `${extensionCall ? "内呼" : "外呼"} ${target}${note}（话机连接=${connection.value}）`,
    );
    muted.value = false;
    await instance.dial(
      extensionCall && !legacyPlatform ? { destination, type: "extension" } : { destination: target },
    );
  }

  /** 用户点「呼叫」：先停掉上一轮还没走完的重拨时间点，再按当前 外呼/内呼 拨出去 */
  async function dial() {
    retry.cancel();
    await startCall(number.value, dialMode.value === "extension");
  }

  async function hangup() {
    await currentCall()?.hangup();
  }

  /** 静音 / 取消静音：只对已接通的那一路有效（会话能力里有 mute 才允许） */
  async function toggleMute() {
    const call = currentCall();
    if (!call || !DTMF_CALL_STATES.includes(call.state)) throw new Error("没有可静音的通话");
    if (muted.value) await call.unmute();
    else await call.mute();
    muted.value = !muted.value;
    appendPanelLog("sip", "info", "call", muted.value ? "已静音" : "已取消静音");
  }

  /** 拨号盘：通话前是输入号码，通话中是 DTMF（移动端形态的标准做法） */
  async function appendDigit(tone: string) {
    unlockRemoteAudio();
    const call = currentCall();
    if (call) {
      // 拨号中/振铃中先不通话，等接通了再送 DTMF
      if (!DTMF_CALL_STATES.includes(call.state)) return;
      try {
        await call.sendDtmf(tone);
        appendPanelLog("sip", "info", "call", `DTMF ${tone}`);
      } catch (error) {
        // 按键是高频操作，不进 run()（那会整屏 busy），错误就地显示
        showError(error instanceof Error ? error.message : error);
      }
      return;
    }
    number.value = `${number.value}${tone}`;
  }

  function backspaceDigit() {
    if (currentCall()) return;
    number.value = number.value.slice(0, -1);
  }

  function clearNumber() {
    number.value = "";
  }

  async function answerCall(callId: string) {
    // 接听按钮的点击本身就是手势，顺手把远端音频放出来（iOS/微信里必须这么做）
    await client.value?.answer(callId);
    removeIncoming(callId);
    void client.value?.media?.playRemoteAudio?.(callId).catch(() => undefined);
  }

  async function rejectCall(callId: string) {
    const call = client.value?.getCalls().find((item) => item.id === callId);
    await call?.reject({ reason: "已拒接" });
    removeIncoming(callId);
  }

  /** 空闲 / 休息：走 SDK 的 setAgentStatus（最终由会话来源落到平台接口） */
  async function setAgent(status: "available" | "break") {
    loading.value = "正在设置坐席状态…";
    try {
      await client.value?.setAgentStatus(status);
    } finally {
      loading.value = "";
    }
    agent.value = status;
  }

  /**
   * 置忙：SDK 的 setAgentStatus 只有 空闲 / 休息 / 离线，没有「忙碌」，
   * 所以页面直接调服务端的坐席状态接口（平台侧是 On Break + reason=忙碌）。
   */
  async function setBusy() {
    if (!legacyPlatform) {
      showError("新平台形态请在平台侧管理坐席状态（当前 SDK 只提供 空闲 / 休息）");
      return;
    }
    const [status, reason] = SEAT_STATUS_TEXT.busy;
    loading.value = "正在设置坐席状态…";
    try {
      await setSeatStatus(config, seatAccount, status, reason, appendFlowLog);
    } finally {
      loading.value = "";
    }
    agent.value = "busy";
  }

  // ---------- SDK 事件 → 页面状态 + 日志 ----------
  function subscribe(instance: CCBarClient) {
    subscriptions.push(
      instance.on("connection.stateChanged", (event) => {
        connection.value = event.state;
        appendFlowLog("info", "status", `connection=${event.state}`);
      }),
      instance.on("connection.registered", () => {
        connection.value = "registered";
        // 与旧版一致：注册成功即视为坐席「在线」（平台侧状态由服务端维护，这里只是本地标记）。
        // 重连后再次注册时不覆盖，免得把页面上的「忙碌 / 休息」冲掉
        if (agent.value === "offline") agent.value = "available";
        // 每次注册完成都重新记账：首通保护只在这个周期内生效（额度、进度都清零）
        retry.reset();
        void acquireWakeLock();
        const account = instance.getAgent()?.extension || config.extension;
        // 坐席账号可能带企业前缀，显示时去掉（参考页 shortExtension）
        extension.value = shortExtension(account, customerPrefix.value);
        appendPanelLog("sip", "ok", "sip", "connection.registered");
      }),
      instance.on("connection.reconnecting", (event) => {
        appendFlowLog("warn", "status", `重连中（第 ${event.attempt} 次）`);
      }),
      instance.on("connection.failed", (event) => {
        appendFlowLog("error", "ccbar", event.error.message);
        showError(event.error.message);
      }),
      instance.on("token.expiring", (event) => {
        appendFlowLog("info", "token", `Token 将过期 expiresAt=${event.expiresAt}`);
      }),
      instance.on("token.refreshed", (event) => {
        appendFlowLog("ok", "token", `Token 已刷新 expiresAt=${event.expiresAt}`);
      }),
      instance.on("agent.statusChanged", (event) => {
        const status = event.status as AgentState;
        if (status in agentStatus) agent.value = status;
        appendFlowLog("info", "status", `坐席=${event.status}`);
      }),
      instance.on("call.created", (event) => {
        appendFlowLog("info", "call", `call.created ${sipEventDetail(event)}`);
        refreshCallState();
      }),
      instance.on("call.incoming", (event) => {
        if (!incoming.value.some((call) => call.callid === event.callId)) {
          incoming.value = [
            ...incoming.value,
            { callid: event.callId, callerName: event.from || "未知号码" },
          ];
        }
        // 手机放在桌上时靠振动提醒（iOS 不支持，会静默忽略）
        vibrate([200, 100, 200]);
        appendFlowLog("info", "call", `来电 ${sipEventDetail(event)}`);
        refreshCallState();
      }),
      instance.on("call.stateChanged", (event) => {
        appendPanelLog("sip", event.to === "failed" ? "error" : "info", "call", `call.stateChanged ${sipEventDetail(event)}`);
        refreshCallState();
      }),
      instance.on("call.activeChanged", (event) => {
        appendFlowLog("info", "call", `call.activeChanged ${sipEventDetail(event)}`);
        // 有一路接通了，说明平台已经正常，不用再兜底重拨
        if (instance.getActiveCall()?.state === "active") retry.finish();
        refreshCallState();
      }),
      instance.on("call.ended", (event) => {
        appendFlowLog("info", "call", `呼叫结束 ${sipEventDetail(event)}`);
        removeIncoming(event.callId);
        retry.cancel();
        muted.value = false;
        refreshCallState();
      }),
      instance.on("call.failed", (event) => {
        appendFlowLog("error", "call", `呼叫失败 connection=${connection.value} ${sipEventDetail(event)}`);
        // 只有「UA 的 WebSocket 已经没了」这一种情况才提示重签（JsSIP 抛 InvalidStateError/NotConnected）；
        // 平台回的 480 之类也会被 SDK 归到这个错误码上，不能一概而论
        const cause = (event.error as { cause?: { name?: string; message?: string } }).cause;
        const transportGone = /InvalidStateError|NotConnected|not connected/i.test(
          `${cause?.name ?? ""} ${cause?.message ?? ""}`,
        );
        if (event.error.code === "CALL_OPERATION_NOT_ALLOWED" && transportGone) {
          appendFlowLog("warn", "sip", "话机连接可能已断开：请点退签再签入后重试");
        }
        removeIncoming(event.callId);
        showError(event.error.message);
        // 注册后的第一次外呼碰到「暂时不可用」：交给首通保护兜底。
        // 额度按每次签入算（见 lib/callRetry.ts），所以这里可以放心对每次失败都调一次 arm。
        if (isTemporarySipFailure(event.error) && Date.now() - lastDialAt < OUTBOUND_FAILURE_WINDOW_MS) {
          retry.arm(lastDialTarget);
        }
        muted.value = false;
        refreshCallState();
      }),
      instance.on("error", (event) => {
        appendFlowLog("error", "ccbar", `SDK 错误 ${sipEventDetail(event)}`);
        showError(event.error.message);
      }),
    );
  }

  // ---------- 客户端生命周期 ----------
  function createClient(): CCBarClient {
    const baseUrl = webphoneBaseUrl();
    const options: CCBarClientOptions = {
      locale: "zh-CN",
      // H5：按移动端形态建会话（不传的话 SDK 自己探测，传了就固定下来）
      platform: "mobile-web",
      sipKeepaliveSeconds: sipKeepaliveSeconds(),
      ...(baseUrl ? { baseUrl } : {}),
      // 单标签页，不用 SharedWorker
      sharedWorker: { enabled: false, fallback: "single-tab" },
    };
    if (legacyPlatform) {
      // 旧平台：会话由服务端拼好（桌面 demo 的 server/get-session.js）
      const provider = createLegacySessionProvider(config, appendFlowLog, (account: SeatAccount) => {
        customerPrefix.value = String(account.customerPrefix || "");
        seatAccount = String(account.username || seatAccount);
        appendFlowLog(
          "ok",
          "seat",
          `坐席账号就绪 ${stringifyLog({ username: account.username, prefix: account.customerPrefix || "-" })}`,
        );
      });
      return new CCBarClient({ ...options, sessionProvider: provider });
    }
    // 新平台：SDK 拿 token 去换会话
    return new CCBarClient({ ...options, tokenProvider: createTokenProvider(config, appendFlowLog) });
  }

  function mount() {
    // 必须在 SDK 第一次 connect（懒加载 JsSIP）之前打开 SIP 原文
    unsubscribeSipDebug = enableJsSipDebug((level, text) => appendPanelLog("sip", level, "jssip", text));
    document.addEventListener("visibilitychange", onVisibilityChange);
    try {
      client.value = createClient();
    } catch (error) {
      // 例如 SDK 版本太老、没有旧平台需要的 sessionProvider：提示清楚，别白屏
      client.value = undefined;
      showError(error instanceof Error ? error.message : error);
      return;
    }
    subscribe(client.value);
    appendFlowLog("info", "app", "页面已就绪，等待签入");
  }

  function disposeClient() {
    for (const off of subscriptions.splice(0)) off();
    void client.value?.dispose();
    client.value = undefined;
  }

  function unmount() {
    disposeClient();
    retry.cancel();
    releaseWakeLock();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    unsubscribeSipDebug?.();
    unsubscribeSipDebug = undefined;
  }

  onMounted(mount);
  onBeforeUnmount(unmount);

  return {
    // 设置
    config,
    saveSettings,
    // 状态
    connection,
    connectionText: connectionStatus,
    callState,
    callStatusText: callStatus,
    agent,
    agentText: agentStatus,
    extension,
    customerPrefix,
    number,
    dialMode,
    muted,
    callDestination,
    feedback,
    busy,
    loading,
    connected,
    hasCall,
    callActive,
    incoming,
    logs,
    placeholder,
    // 动作
    signIn,
    signOut,
    dial,
    hangup,
    toggleMute,
    appendDigit,
    backspaceDigit,
    clearNumber,
    answerCall,
    rejectCall,
    setAgent,
    setBusy,
    clearLog,
    run,
    showError,
    clearError,
    unlockRemoteAudio,
  };
}
