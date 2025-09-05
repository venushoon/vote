import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // ⚠️ GitHub Pages에 올릴 때 반드시 리포 이름과 맞춰주세요.
  // 예: https://username.github.io/vote → base는 '/vote/'
  base: '/vote/'
})
