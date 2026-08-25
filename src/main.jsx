import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import AuthGate from "./AuthGate.jsx";

class AppErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("TeachingRecord render failed", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#F4F1EA", color: "#2A2A28", fontFamily: "-apple-system, BlinkMacSystemFont, 'Noto Sans TC', sans-serif" }}>
          <div style={{ width: "100%", maxWidth: 460, background: "#FFFFFF", border: "1px solid #E4DFD3", borderRadius: 14, padding: 24, boxShadow: "0 2px 10px rgba(0,0,0,0.04)" }}>
            <h1 style={{ margin: "0 0 10px", fontSize: 20 }}>教學紀錄系統暫時無法顯示</h1>
            <p style={{ margin: "0 0 16px", lineHeight: 1.7, color: "#71757A", fontSize: 14 }}>資料尚未被刪除。請先重新載入；若問題持續，請記下下方錯誤訊息再回報。</p>
            <button type="button" onClick={() => window.location.reload()} style={{ border: 0, borderRadius: 9, padding: "10px 14px", background: "#B8863B", color: "#FFFFFF", fontWeight: 700, cursor: "pointer" }}>重新載入</button>
            <details style={{ marginTop: 16, color: "#8C332E", fontSize: 12 }}>
              <summary>顯示錯誤訊息</summary>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{String(this.state.error?.message || this.state.error)}</pre>
            </details>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <AuthGate>
        <App />
      </AuthGate>
    </AppErrorBoundary>
  </React.StrictMode>
);
