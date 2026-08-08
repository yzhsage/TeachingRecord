# 教學紀錄系統 — 部署說明

## 這個專案的架構
- 前端：React + Vite,程式碼在 `src/App.jsx`(你原本 Claude artifact 的邏輯,幾乎沒動,只換了資料存取層)
- 資料庫：Firebase Realtime Database,取代原本的 `window.storage`
- 登入：`src/AuthGate.jsx`,輸入密碼 → 背後用 Firebase Authentication(Email/Password)驗證
- 部署：GitHub Actions 自動 build 並發布到 GitHub Pages

## 上線前,你需要做三件事

### 1. 改 `src/AuthGate.jsx` 裡的 email
打開這個檔案,把這一行:
```js
const TEACHER_EMAIL = "teacher@shark.app";
```
換成你在 Firebase Authentication → Users 裡實際新增的那組 email(要一字不差)。密碼不用寫在程式碼裡,是你登入畫面自己輸入的那組密碼。

### 2. 設定 Firebase 安全規則
到 Firebase Console → Realtime Database → 規則(Rules)分頁,把內容整個換成 `firebase.rules.json` 裡的內容,然後按「發布」。這樣可以確保沒登入的人完全讀不到、寫不到任何資料。

### 3. 推上 GitHub 並開啟 Pages
在專案資料夾內(也就是這些檔案所在的地方)依序執行:
```bash
git init
git add .
git commit -m "初始版本"
git branch -M main
git remote add origin https://github.com/yzhsage/TeachingRecord.git
git push -u origin main
```
接著到 GitHub 上的 repo → Settings → Pages,把「Source」設定成 **GitHub Actions**(不是 Deploy from a branch)。push 完之後,repo 的 Actions 分頁會自動開始跑部署流程,跑完後網址會是:

```
https://yzhsage.github.io/TeachingRecord/
```

之後每次你請我改程式碼、把新版檔案 push 上去,GitHub 會自動重新建置部署,不用手動操作。

## 本機測試(可選)
如果想在推上線前先在自己電腦上看看畫面對不對:
```bash
npm install
npm run dev
```
會啟動一個本機網址(通常是 http://localhost:5173),但因為 base path 設定是給 GitHub Pages 用的 `/TeachingRecord/`,本機測試時瀏覽器要打開 `http://localhost:5173/TeachingRecord/` 才看得到畫面。

## 資料存放位置
所有資料都存在 Firebase Realtime Database 底下的 `records/` 這個節點,結構跟原本的 storage key 對應:
- `records/classIndex` — 班級、學生、課表設定
- `records/attendance/<班級id>` — 點名紀錄
- `records/quiz/<班級id>`、`records/exam/<班級id>` — 平時考、段考成績
- `records/fee/<班級id>` — 收費紀錄

原本 artifact 裡「JSON 匯出/匯入」的功能沒有改動,可以繼續當作額外備份手段。
