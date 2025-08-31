import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages용 base 경로 설정
export default defineConfig({
  plugins: [react()],
  base: "/vote/"
});
