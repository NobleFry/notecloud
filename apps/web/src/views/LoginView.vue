<script setup lang="ts">
import { emailSchema } from '@notecloud/shared';
import {
  NAlert,
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  useMessage,
  type FormInst,
  type FormRules,
} from 'naive-ui';
import { computed, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/utils/error';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const message = useMessage();

const formRef = ref<FormInst | null>(null);
const submitting = ref(false);
const error = ref('');
const model = ref({ email: '', password: '' });

const rules: FormRules = {
  email: [{ required: true, message: '请填写邮箱', trigger: ['blur', 'input'] }],
  password: [{ required: true, message: '请填写密码', trigger: ['blur', 'input'] }],
};

/** 邀请制下默认不显示注册入口；后端 /site/status 会告诉我们是否开放 */
const canRegister = computed(() => auth.siteStatus?.registration.enabled ?? false);

async function submit(): Promise<void> {
  error.value = '';
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }

  submitting.value = true;
  try {
    await auth.login(model.value.email, model.value.password);
    message.success('登录成功');
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.replace(redirect);
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    submitting.value = false;
  }
}

// 邮箱格式用共享 schema 兜一道，避免明显错误也打一次接口
function checkEmail(value: string): boolean {
  return emailSchema.safeParse(value).success;
}
</script>

<template>
  <div class="nc-centered">
    <n-card class="nc-card">
      <div class="nc-brand" style="justify-content: center; margin-bottom: 20px">
        <span style="font-size: 24px">📚</span>
        <span>{{ auth.siteStatus?.siteName ?? 'NoteCloud' }}</span>
      </div>

      <n-alert v-if="error" type="error" :bordered="false" style="margin-bottom: 16px">
        {{ error }}
      </n-alert>

      <n-form ref="formRef" :model="model" :rules="rules" label-placement="top">
        <n-form-item label="邮箱" path="email">
          <n-input v-model:value="model.email" placeholder="you@example.com" />
        </n-form-item>
        <n-form-item label="密码" path="password">
          <n-input
            v-model:value="model.password"
            type="password"
            show-password-on="click"
            placeholder="请输入密码"
            @keyup.enter="submit"
          />
        </n-form-item>
      </n-form>

      <n-button
        type="primary"
        block
        :loading="submitting"
        :disabled="!checkEmail(model.email) || model.password.length === 0"
        @click="submit"
      >
        登录
      </n-button>

      <div style="margin-top: 14px; text-align: center" class="nc-muted">
        <template v-if="canRegister">
          还没有账号？
          <RouterLink :to="{ name: 'register' }">立即注册</RouterLink>
        </template>
        <template v-else>
          本站为邀请制，请联系管理员获取邀请链接
        </template>
      </div>
    </n-card>
  </div>
</template>
