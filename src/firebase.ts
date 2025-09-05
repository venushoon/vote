// src/firebase.ts
import { initializeApp } from "firebase/app";
import { getDatabase /*, enableLogging*/ } from "firebase/database";
import { getAuth, onAuthStateChanged, signInAnonymously } from "firebase/auth";

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

// 🔎 RTDB 로그가 필요할 때만 잠깐 켜세요 (완료 후 주석!)
// enableLogging(true); // 또는 enableLogging((msg) => console.debug("[RTDB]", msg));

let _authReady: Promise<void> | null = null;
/** 앱에서 DB 작업 전에 호출해서 익명 인증을 보장합니다. */
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
