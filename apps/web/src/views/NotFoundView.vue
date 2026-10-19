<script setup lang="ts">
import { NButton, NResult } from 'naive-ui';
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <div class="nc-centered">
    <n-result status="404" title="页面不存在" description="链接可能已失效，或者你输错了地址">
      <template #footer>
        <n-button @click="router.push({ name: 'home' })">回到首页</n-button>
      </template>
    </n-result>
  </div>
</template>
