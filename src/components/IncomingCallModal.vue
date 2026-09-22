<script setup lang="ts">
/**
 * 来电浮层（移动端全屏）：可能同时有多路来电，所以按列表渲染，每路一组「接听 / 拒接」。
 * 来电时 usePhone 还会顺手振动一下（不支持的浏览器静默忽略）。
 */
import type { IncomingCall } from "../lib/usePhone";

defineProps<{ calls: IncomingCall[]; busy: boolean }>();
const emit = defineEmits<{ answer: [callId: string]; reject: [callId: string] }>();
</script>

<template>
  <div class="h5-incoming">
    <div class="h5-incoming-panel">
      <div class="h5-incoming-count">来电（{{ calls.length }}）</div>
      <div v-for="call in calls" :key="call.callid" class="h5-incoming-item">
        <div class="h5-incoming-number">{{ call.callerName }}</div>
        <div class="h5-incoming-btns">
          <button
            type="button"
            class="h5-btn is-answer"
            :disabled="busy"
            @click="emit('answer', call.callid)"
          >
            接听
          </button>
          <button
            type="button"
            class="h5-btn is-danger"
            :disabled="busy"
            @click="emit('reject', call.callid)"
          >
            拒接
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
