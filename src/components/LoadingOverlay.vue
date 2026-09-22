<script setup lang="ts">
/**
 * 全屏加载遮罩：签入、以及设置坐席状态（空闲 / 置忙 / 休息）这类要等服务端回应、
 * 期间不该让人重复点的操作，都盖一层这个。
 * 文案由 usePhone 的 loading 决定，空字符串＝不显示。
 */
defineProps<{ text: string }>();
</script>

<template>
  <div class="h5-loading-overlay" role="status" aria-live="polite">
    <div class="h5-loading-box">
      <span class="h5-loading-spinner" aria-hidden="true"></span>
      <span>{{ text }}</span>
    </div>
  </div>
</template>
