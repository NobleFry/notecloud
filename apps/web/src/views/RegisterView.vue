<script setup lang="ts">
import { emailSchema, nameSchema, passwordSchema } from '@notecloud/shared';
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
const model = ref({ name: '', email: '', password: '', confirm: '' });

/** 从邀请链接跳过来时会带上 token，注册即加入对应工作区 */
const inviteToken = computed(() =>
  typeof route.query.invite === 'string' ? route.query.invite : undefined,
);

function zodRule(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } }) {
  return (_rule: unknown, value: string) => {
    const parsed = schema.safeParse(value);
    if (parsed.success) return true;
    return new Error(parsed.error?.issues[0]?.message ?? '格式不正确');
  };
}

const rules: FormRules = {
  name: [{ required: true, validator: zodRule(nameSchema), trigger: ['blur', 'input'] }],
  email: [{ required: true, validator: zodRule(emailSchema), trigger: ['blur', 'input'] }],
  password: [{ required: true, validator: zodRule(passwordSchema), trigger: ['blur', 'input'] }],
  confirm: [
    {
      validator: (_rule: unknown, value: string) =>
        value === model.value.password ? true : new Error('两次输入的密码不一致'),
      trigger: ['blur', 'input'],
    },
  ],
};

async function submit(): Promise<void> {
  error.value = '';
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }

  submitting.value = true;
  try {
    await auth.register({
      name: model.value.name,
      email: model.value.email,
      password: model.value.password,
      ...(inviteToken.value ? { inviteToken: inviteToken.value } : {}),
    });
    message.success('注册成功，欢迎加入');
    await router.replace({ name: 'home' });
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="nc-centered">
    <n-card class="nc-card" title="注册账号">
      <n-alert v-if="inviteToken" type="success" :bordered="false" style="margin-bottom: 16px">
        你正在通过邀请链接注册，注册后会自动加入对应工作区。
      </n-alert>
      <n-alert v-else type="warning" :bordered="false" style="margin-bottom: 16px">
        直接注册只会创建你的个人空间。
      </n-alert>

      <n-alert v-if="error" type="error" :bordered="false" style="margin-bottom: 16px">
        {{ error }}
      </n-alert>

      <n-form ref="formRef" :model="model" :rules="rules" label-placement="top">
        <n-form-item label="昵称" path="name">
          <n-input v-model:value="model.name" placeholder="你的名字" />
        </n-form-item>
        <n-form-item label="邮箱" path="email">
          <n-input v-model:value="model.email" placeholder="you@example.com" />
        </n-form-item>
        <n-form-item label="密码" path="password">
          <n-input
            v-model:value="model.password"
            type="password"
            show-password-on="click"
            placeholder="至少 10 位，需含字母与数字"
          />
        </n-form-item>
        <n-form-item label="确认密码" path="confirm">
          <n-input
            v-model:value="model.confirm"
            type="password"
            show-password-on="click"
            placeholder="再输入一次"
            @keyup.enter="submit"
          />
        </n-form-item>
      </n-form>

      <n-button type="primary" block :loading="submitting" @click="submit">注册</n-button>

      <div style="margin-top: 14px; text-align: center" class="nc-muted">
        已有账号？<RouterLink :to="{ name: 'login' }">去登录</RouterLink>
      </div>
    </n-card>
  </div>
</template>
