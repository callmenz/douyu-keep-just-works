<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { requestJson } from '../request'

defineProps<{
  appName: string
  loginError: string
  password: string
  submittingLogin: boolean
}>()

// 密码提示：未登录也能读，默认折叠，点开才显示
const hint = ref('')
const hintOpen = ref(false)

onMounted(async () => {
  try {
    const res = await requestJson<{ hint?: string }>('/api/auth/hint', { errorToast: false })
    hint.value = (res?.hint || '').trim()
  } catch {
    // 没有提示或接口不可用时静默，不影响登录
  }
})

const emit = defineEmits<{
  submit: []
  'update:password': [value: string]
}>()

function updatePassword(event: Event): void {
  emit('update:password', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <div id="auth-shell" class="auth-shell">
    <div class="auth-card">
      <section class="auth-panel" aria-labelledby="auth-title">
        <div class="auth-brand">
          <img class="auth-logo" src="/icon.png" alt="" aria-hidden="true">
          <h1 id="auth-title" class="auth-title">
            {{ appName }}
          </h1>
        </div>

        <form id="login-form" autocomplete="on" @submit.prevent="emit('submit')">
          <div class="field-block auth-field">
            <label class="field-label auth-field-label" for="web-password-input">WebUI 密码</label>
            <input
              id="web-password-input"
              :value="password"
              name="web-password"
              type="password"
              autocomplete="current-password"
              spellcheck="false"
              placeholder="WebUI 密码"
              :aria-describedby="loginError ? 'login-error' : undefined"
              :aria-invalid="loginError ? 'true' : 'false'"
              :disabled="submittingLogin"
              @input="updatePassword"
            >
          </div>
          <div v-if="hint" class="auth-hint">
            <button
              class="auth-hint-toggle"
              type="button"
              :aria-expanded="hintOpen ? 'true' : 'false'"
              aria-controls="login-hint"
              @click="hintOpen = !hintOpen"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" :class="{ 'auth-hint-chevron-open': hintOpen }">
                <path d="M9.29 6.71a1 1 0 0 1 1.42 0l5 5a1 1 0 0 1 0 1.42l-5 5a1 1 0 0 1-1.42-1.42L13.59 12 9.29 8.12a1 1 0 0 1 0-1.41z" />
              </svg>
              忘记密码？查看密码提示
            </button>
            <div v-show="hintOpen" id="login-hint" class="auth-hint-text" role="status">
              {{ hint }}
            </div>
          </div>

          <div v-if="loginError" id="login-error" class="auth-error" role="alert">
            {{ loginError }}
          </div>
          <div class="actions auth-actions">
            <button id="login-submit" class="btn btn-success" type="submit" :disabled="submittingLogin">
              {{ submittingLogin ? '登录中…' : '登录' }}
            </button>
          </div>
        </form>
      </section>
    </div>
  </div>
</template>
