import React, { useEffect, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "./firebase";

// Replace this with the exact email you registered under Firebase ->
// Authentication -> Users. The person using this app only ever types
// the password below — this email is just the account Firebase
// requires behind the scenes.
const TEACHER_EMAIL = "yzhsage@gmail.com";

export default function AuthGate({ children }) {
  const [user, setUser] = useState(undefined); // undefined = still checking
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return unsub;
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, TEACHER_EMAIL, password);
    } catch (err) {
      setError("密碼錯誤，請再試一次");
    } finally {
      setLoading(false);
      setPassword("");
    }
  }

  if (user === undefined) {
    return (
      <div className="auth-shell">
        <div className="auth-loading">載入中…</div>
        <style>{AUTH_CSS}</style>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="auth-shell">
        <form className="auth-card" onSubmit={handleLogin}>
          <div className="auth-title">教學紀錄系統</div>
          <input
            type="password"
            className="auth-input"
            placeholder="請輸入密碼"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          {error && <div className="auth-error">{error}</div>}
          <button type="submit" className="auth-btn" disabled={loading || !password}>
            {loading ? "登入中…" : "登入"}
          </button>
        </form>
        <style>{AUTH_CSS}</style>
      </div>
    );
  }

  return children;
}

const AUTH_CSS = `
.auth-shell { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #F4F1EA; font-family: -apple-system, BlinkMacSystemFont, "Noto Sans TC", sans-serif; padding: 20px; }
.auth-loading { color: #71757A; font-size: 14px; }
.auth-card { width: 100%; max-width: 320px; background: #FFFFFF; border: 1px solid #E4DFD3; border-radius: 14px; padding: 28px 24px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.04); }
.auth-title { font-family: 'Noto Serif TC', serif; font-weight: 700; font-size: 18px; text-align: center; margin-bottom: 6px; color: #2A2A28; }
.auth-input { border: 1px solid #D9D9D5; border-radius: 9px; padding: 10px 12px; font-size: 15px; font-family: inherit; }
.auth-error { color: #B23A34; font-size: 12.5px; }
.auth-btn { background: #B8863B; color: white; border: none; border-radius: 9px; padding: 10px 12px; font-size: 14px; font-weight: 700; cursor: pointer; font-family: inherit; }
.auth-btn:disabled { opacity: 0.6; cursor: default; }
`;
