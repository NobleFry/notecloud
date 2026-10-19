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
import { ref } from 'vue';
import { useRouter } from 'vue-router';

import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/utils/error';

const auth = useAuthStore();
const router = useRouter();
const message = useMessage();

const formRef = ref<FormInst | null>(null);
const submitting = ref(false);
const error = ref('');
const model = ref({ name: '', email: '', password: '', confirm: '' });

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
    });
    message.success('管理员账号已创建');
    await router.push({ name: 'home' });
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="nc-centered">
    <n-card class="nc-card" title="初始化 NoteCloud">
      <n-alert type="info" :bordered="false" style="margin-bottom: 16px">
        这是本站的首次启动。你正在创建的账号将成为
        <strong>站点管理员</strong>，之后其他人需要通过邀请链接加入。
      </n-alert>

      <n-alert v-if="error" type="error" :bordered="false" style="margin-bottom: 16px">
        {{ error }}
      </n-alert>

      <n-form ref="formRef" :model="model" :rules="rules" :show-label="true" label-placement="top">
        <n-form-item label="昵称" path="name">
          <n-input v-model:value="model.name" placeholder="你的名字" />
        </n-form-item>
        <n-form-item label="邮箱" path="email">
          <n-input v-model:value="model.email" placeholder="admin@example.com" />
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

      <n-button type="primary" block :loading="submitting" @click="submit">创建管理员账号</n-button>
    </n-card>
  </div>
</template>
