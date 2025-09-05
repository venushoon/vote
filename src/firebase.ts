// src/firebase.ts
import { initializeApp } from "firebase/app";
import { getDatabase, setLogLevel } from "firebase/database";
import { getAuth, onAuthStateChanged, signInAnonymously } from "firebase/auth";

// .env에 다음 키들이 있어야 합니다.
// VITE_FB_API_KEY, VITE_FB_AUTH_DOMAIN, VITE_FB_DATABASE_URL, VITE_FB_PROJECT_ID, VITE_FB_APP_ID
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY,
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FB_DATABASE_URL,
  projectId: import.meta.env.VITE_FB_PROJECT_ID,
  appId: import.meta.env.VITE_FB_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
const auth = getAuth(app);

// 필요시 잠깐만 디버그 켜서 Rules 실패 원인 확인 (완료 후 주석 처리 권장)
// setLogLevel("debug");

let _authReady: Promise<void> | null = null;

/** 앱 어디서든 호출해서 "반드시 인증 완료된 상태"를 보장 */
export function ensureAuth(): Promise<void> {
  if (_authReady) return _authReady;
  _authReady = new Promise<void>((resolve, reject) => {
    const unsub = onAuthStateChanged(
      auth,
      async (user) => {
        try {
          if (!user) await signInAnonymously(auth);
          resolve();
        } catch (e) {
          reject(e);
        } finally {
          unsub();
        }
      },
      reject
    );
  });
  return _authReady;
}
