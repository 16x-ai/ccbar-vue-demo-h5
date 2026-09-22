<script setup lang="ts">
/**
 * 拨号盘：3×4 键（1-9 / * / 0 / #），带字母副标，跟系统拨号盘一致。
 *
 * 这里只负责把按键报上去：通话前点它是在输号码，通话中点它是 DTMF ——
 * 两种含义的判定在 usePhone.appendDigit 里（移动端形态的标准做法）。
 */
const KEYS = [
  { digit: "1", letters: "" },
  { digit: "2", letters: "ABC" },
  { digit: "3", letters: "DEF" },
  { digit: "4", letters: "GHI" },
  { digit: "5", letters: "JKL" },
  { digit: "6", letters: "MNO" },
  { digit: "7", letters: "PQRS" },
  { digit: "8", letters: "TUV" },
  { digit: "9", letters: "WXYZ" },
  { digit: "*", letters: "" },
  { digit: "0", letters: "+" },
  { digit: "#", letters: "" },
] as const;

defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ digit: [tone: string] }>();
</script>

<template>
  <div class="h5-dialpad" role="group" aria-label="拨号盘">
    <button
      v-for="key in KEYS"
      :key="key.digit"
      type="button"
      class="h5-key"
      :disabled="disabled"
      :aria-label="key.letters ? `${key.digit} ${key.letters}` : key.digit"
      @click="emit('digit', key.digit)"
    >
      <span class="h5-key-digit">{{ key.digit }}</span>
      <span class="h5-key-letters">{{ key.letters }}</span>
    </button>
  </div>
</template>
