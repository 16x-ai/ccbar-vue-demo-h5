<script setup lang="ts">
/**
 * 日志抽屉：手机屏幕小，默认收起，只露出一行最新日志；点标题展开。
 * 展开后两个页签（日志 / SIP），「清空」只清当前页签。
 */
import { computed, nextTick, ref, watch } from "vue";
import type { LogLine, LogPanel as Panel } from "../lib/logs";

const props = defineProps<{
  logs: LogLine[];
  placeholder: Record<Panel, string>;
  clear: (panel: Panel) => void;
}>();

const open = ref(false);
const panel = ref<Panel>("flow");
const body = ref<HTMLElement>();
const lines = computed(() => props.logs.filter((line) => line.panel === panel.value));
/** 收起时露出的那一行 */
const latest = computed(() => {
  const last = props.logs[props.logs.length - 1];
  return last ? `${last.time} [${last.source}] ${last.message}` : "暂无日志";
});

// 收起状态下有新日志也滚一下（下次展开时位置是对的），展开后跟随到底
watch([() => props.logs.length, open, panel], () => {
  void nextTick(() => {
    const el = body.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
});
</script>

<template>
  <section class="h5-log" :class="{ 'is-open': open }">
    <div class="h5-log-head">
      <button
        type="button"
        class="h5-log-toggle"
        :aria-expanded="open"
        @click="open = !open"
      >
        <span class="h5-log-caret" aria-hidden="true">{{ open ? "▾" : "▸" }}</span>
        日志
        <span v-if="!open" class="h5-log-latest">{{ latest }}</span>
      </button>
      <template v-if="open">
        <div class="h5-log-tabs" role="tablist" aria-label="日志类型">
          <button type="button" role="tab" :aria-selected="panel === 'flow'" @click="panel = 'flow'">
            日志
          </button>
          <button type="button" role="tab" :aria-selected="panel === 'sip'" @click="panel = 'sip'">
            SIP
          </button>
        </div>
        <button type="button" class="h5-log-clear" @click="clear(panel)">清空</button>
      </template>
    </div>

    <div v-if="open" ref="body" class="h5-log-body">
      <template v-if="lines.length">
        <div v-for="line in lines" :key="line.id" class="log-line" :class="line.level">
          <span class="log-time">{{ line.time }}</span>
          <span class="log-src">[{{ line.source }}]</span>
          <span class="log-msg">{{ line.message }}</span>
        </div>
      </template>
      <template v-else>{{ placeholder[panel] }}</template>
    </div>
  </section>
</template>
