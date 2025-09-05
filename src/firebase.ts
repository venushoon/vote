/// <reference types="vite/client" />
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getAuth, signInAnonymously } from "firebase/auth";

// .env 에는 다음 키들이 있어야 합니다.
// VITE_FIREBASE_API_KEY=...
// VITE_FIREBASE_AUTH_DOMAIN=...
// VITE_FIREBASE_DATABASE_URL=...
// VITE_FIREBASE_PROJECT_ID=...
// VITE_FIREBASE_STORAGE_BUCKET=...
// VITE_FIREBASE_MESSAGING_SENDER_ID=...
// VITE_FIREBASE_APP_ID=...

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL as string,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string,
};

const app = initializeApp(firebaseConfig);

// ✅ 반드시 export 해주세요 (App.tsx에서 import 합니다)
export const db = getDatabase(app);
export const auth = getAuth(app);

// 앱 어디서든 호출 가능: 익명 로그인 보장
export async function ensureAuth() {
  if (!auth.currentUser) {
    await signInAnonymously(auth);
  }
  return auth.currentUser;
}
