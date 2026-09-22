<script setup lang="ts">
/**
 * 设置面板（移动端：从底部弹出的整屏抽屉）。
 *
 * 输入框直接绑在 page.config 上（同一个响应式对象），点「保存」时由 usePhone 校验并写盘；
 * 校验不通过会在页面上显示红字，面板不关。
 *
 * 注意 input 的字号在 CSS 里固定 16px：iOS Safari 对小于 16px 的输入框会自动放大页面。
 */
import type { PhoneConfig } from "../lib/settings";

defineProps<{ open: boolean; config: PhoneConfig }>();
const emit = defineEmits<{ close: []; save: [] }>();
</script>

<template>
  <div v-if="open" class="h5-sheet" @click.self="emit('close')">
    <div class="h5-sheet-panel" role="dialog" aria-labelledby="h5-settings-title">
      <div class="h5-sheet-head">
        <button type="button" class="h5-sheet-link" @click="emit('close')">取消</button>
        <h3 id="h5-settings-title">设置</h3>
        <button type="button" class="h5-sheet-link is-primary" @click="emit('save')">保存</button>
      </div>

      <div class="h5-sheet-body">
        <label for="h5-setting-host">API 主机</label>
        <input
          id="h5-setting-host"
          v-model="config.host"
          type="text"
          placeholder="https://你们的接口网关"
          autocomplete="off"
        />

        <label for="h5-setting-key">API KEY</label>
        <input
          id="h5-setting-key"
          v-model="config.appKey"
          type="text"
          placeholder="请输入 API KEY"
          autocomplete="off"
        />

        <label for="h5-setting-secret">API SECRET</label>
        <input
          id="h5-setting-secret"
          v-model="config.appSecret"
          type="password"
          placeholder="请输入 API SECRET"
          autocomplete="off"
        />

        <label for="h5-setting-extension">内部分机</label>
        <input
          id="h5-setting-extension"
          v-model="config.extension"
          type="text"
          placeholder="例如 8001，不含企业前缀"
          inputmode="numeric"
          autocomplete="off"
        />

        <label for="h5-setting-sipws">软电话 WSS</label>
        <input
          id="h5-setting-sipws"
          v-model="config.sipWs"
          type="text"
          placeholder="wss://你们的软电话地址/api/fs/sip-ws"
          autocomplete="off"
        />

        <label for="h5-setting-expires">SIP 注册有效期（覆盖项，可留空）</label>
        <input
          id="h5-setting-expires"
          v-model="config.registerExpires"
          type="number"
          min="10"
          max="3600"
          step="1"
          placeholder="默认 600"
          inputmode="numeric"
        />
        <p class="h5-hint">交给服务端写进会话的 sip.registerExpires，默认 600 秒。</p>
        <p class="h5-hint">
          本示例页面不自带后端：会话来自同源 <code>/get-session</code>，由 dev 代理转给
          <code>TOKEN_PROXY_ORIGIN</code>（默认桌面 demo 的 127.0.0.1:3000）。
        </p>
      </div>
    </div>
  </div>
</template>
