<script setup lang="ts">
/**
 * H5 页面骨架：状态条 + 号码/拨号盘 + 主操作（呼叫 / 挂断 / 静音）+ 坐席状态 + 日志抽屉。
 *
 * 布局对齐 SDK 自带的移动端 UI（ccbar-web-sdk/src/ui/views/renderMobile.ts）：
 *   空闲：号码 + 拨号盘 + 呼叫；通话中：对方号码 + 静音 + 拨号盘(DTMF) + 挂断。
 * 真正的逻辑都在 src/lib 里，页面只做绑定（与桌面版 demo 同一套约定）。
 */
import { computed, ref } from "vue";
import Dialpad from "./components/Dialpad.vue";
import IncomingCallModal from "./components/IncomingCallModal.vue";
import LoadingOverlay from "./components/LoadingOverlay.vue";
import LogPanel from "./components/LogPanel.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import { usePhone } from "./lib/usePhone";
import type { DialMode } from "./lib/usePhone";

const phone = usePhone();
const settingsOpen = ref(false);

// 三个状态标签：坐席 / 通话 / SIP，各自取自 SDK 的状态
const agentLabel = computed(() => phone.agentText[phone.agent.value]);
const callLabel = computed(() => phone.callStatusText[phone.callState.value]);
const connectionLabel = computed(() => phone.connectionText[phone.connection.value]);

// 呼叫按钮：已签入 + 号码非空 + 不忙
const canDial = computed(
  () => phone.connected.value && phone.number.value.trim() !== "" && !phone.busy.value,
);
// 外呼 / 内呼 切换只在「已签入且没有通话」时有意义
const showDialMode = computed(() => !phone.hasCall.value && phone.connected.value);

function setDialMode(mode: DialMode) {
  phone.dialMode.value = mode;
}

// 保存设置失败时，错误会显示在操作区下方的红字行里，面板保持打开
function saveSettings() {
  try {
    phone.saveSettings();
    settingsOpen.value = false;
    phone.clearError();
  } catch (error) {
    phone.showError(error instanceof Error ? error.message : String(error));
  }
}
</script>

<template>
  <!-- 根节点上接一次 pointerdown：iOS/微信里远端音频要靠用户手势解锁（usePhone.unlockRemoteAudio） -->
  <div class="h5" @pointerdown="phone.unlockRemoteAudio">
    <header class="h5-head">
      <div class="h5-brand"><strong>CC Bar</strong><span> · H5</span></div>
      <div class="h5-head-right">
        <span v-if="phone.extension.value" class="h5-chip">
          <template v-if="phone.customerPrefix.value"
            >前缀 <b>{{ phone.customerPrefix.value }}</b> ·
          </template>
          分机 <b>{{ phone.extension.value }}</b>
        </span>
        <button type="button" class="h5-gear" aria-label="设置" @click="settingsOpen = true">
          设置
        </button>
      </div>
    </header>

    <div class="h5-rails">
      <span class="ccbar_status" :class="`ccbar_work_status_${agentLabel.tone}`">{{
        agentLabel.text
      }}</span>
      <span class="ccbar_status" :class="`ccbar_serv_status_${callLabel.tone}`">{{
        callLabel.text
      }}</span>
      <span class="ccbar_status" :class="`ccbar_sip_status_${connectionLabel.tone}`">{{
        connectionLabel.text
      }}</span>
    </div>

    <main class="h5-main">
      <div class="h5-display">
        <!-- 通话中：大字显示对方号码（拨号盘这时是 DTMF） -->
        <template v-if="phone.hasCall.value">
          <div class="h5-destination">{{ phone.callDestination.value || "通话中" }}</div>
          <div class="h5-destination-sub">{{ callLabel.text }}</div>
        </template>
        <!-- 空闲：号码可以直接用键盘输入，也可以用下面的拨号盘 -->
        <template v-else>
          <input
            v-model="phone.number.value"
            class="h5-number"
            type="tel"
            inputmode="tel"
            autocomplete="off"
            placeholder="输入号码"
          />
          <div v-if="showDialMode" class="h5-modes">
            <button
              type="button"
              class="h5-mode"
              :class="{ 'is-on': phone.dialMode.value === 'outbound' }"
              :aria-pressed="phone.dialMode.value === 'outbound'"
              @click="setDialMode('outbound')"
            >
              外呼
            </button>
            <button
              type="button"
              class="h5-mode"
              :class="{ 'is-on': phone.dialMode.value === 'extension' }"
              :aria-pressed="phone.dialMode.value === 'extension'"
              @click="setDialMode('extension')"
            >
              内呼
            </button>
          </div>
        </template>
      </div>

      <Dialpad :disabled="!!phone.busy.value" @digit="(tone) => phone.appendDigit(tone)" />

      <div v-if="!phone.hasCall.value" class="h5-edit">
        <button
          type="button"
          class="h5-edit-btn"
          :disabled="!phone.number.value"
          @click="phone.backspaceDigit"
        >
          退格
        </button>
        <button
          type="button"
          class="h5-edit-btn"
          :disabled="!phone.number.value"
          @click="phone.clearNumber"
        >
          清空
        </button>
      </div>
    </main>

    <footer class="h5-foot">
      <div class="h5-primary">
        <!-- 有通话：静音 + 挂断 -->
        <template v-if="phone.hasCall.value">
          <button
            type="button"
            class="h5-btn is-mute"
            :disabled="!phone.callActive.value || !!phone.busy.value"
            @click="phone.run('静音', phone.toggleMute)"
          >
            {{ phone.muted.value ? "取消静音" : "静音" }}
          </button>
          <button
            type="button"
            class="h5-btn is-danger"
            :disabled="!!phone.busy.value"
            @click="phone.run('挂断', phone.hangup)"
          >
            挂断
          </button>
        </template>
        <!-- 没签入：先签入 -->
        <template v-else-if="!phone.connected.value">
          <button
            type="button"
            class="h5-btn is-call"
            :disabled="!!phone.busy.value"
            @click="phone.run('签入', phone.signIn)"
          >
            签入
          </button>
        </template>
        <!-- 其余：呼叫 -->
        <template v-else>
          <button
            type="button"
            class="h5-btn is-call"
            :disabled="!canDial"
            @click="phone.run('呼叫', phone.dial)"
          >
            呼叫
          </button>
        </template>
      </div>

      <div v-if="phone.connected.value" class="h5-seat">
        <button
          type="button"
          class="h5-seat-btn"
          :disabled="!!phone.busy.value"
          @click="phone.run('空闲', () => phone.setAgent('available'))"
        >
          空闲
        </button>
        <button
          type="button"
          class="h5-seat-btn"
          :disabled="!!phone.busy.value"
          @click="phone.run('置忙', phone.setBusy)"
        >
          置忙
        </button>
        <button
          type="button"
          class="h5-seat-btn"
          :disabled="!!phone.busy.value"
          @click="phone.run('休息', () => phone.setAgent('break'))"
        >
          休息
        </button>
        <button
          type="button"
          class="h5-seat-btn is-quiet"
          :disabled="!!phone.busy.value"
          @click="phone.run('退签', phone.signOut)"
        >
          退签
        </button>
      </div>
    </footer>

    <div v-if="phone.feedback.value" class="h5-error">{{ phone.feedback.value }}</div>

    <LogPanel :logs="phone.logs.value" :placeholder="phone.placeholder" :clear="phone.clearLog" />

    <SettingsDialog
      :open="settingsOpen"
      :config="phone.config"
      @close="settingsOpen = false"
      @save="saveSettings"
    />

    <LoadingOverlay v-if="phone.loading.value" :text="phone.loading.value" />

    <IncomingCallModal
      v-if="phone.incoming.value.length"
      :calls="phone.incoming.value"
      :busy="!!phone.busy.value"
      @answer="(callId) => phone.run('接听', () => phone.answerCall(callId))"
      @reject="(callId) => phone.run('拒接', () => phone.rejectCall(callId))"
    />
  </div>
</template>
