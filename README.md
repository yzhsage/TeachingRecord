# 教學紀錄系統

這是一個供**單一教師帳號使用**的教學紀錄工具，部署於 GitHub Pages，資料保存於 Firebase Realtime Database。系統包含班級與學生管理、課表、點名、成績、收費、備份，以及整合國定假日、校內活動與大考日期的行事曆。

完整的功能清單、日常操作、資料結構、備份、安全、測試、發布與未來工作，請參閱 [功能清單與未來維護指南](docs/TEACHING_RECORD_MAINTENANCE.md)。

## 目前功能

| 區域 | 功能說明 |
|---|---|
| 班級 | 新增、編輯與封存班級，管理學生、學校、課表規則與單次補課；所有主要頁面使用一致的桌機／平板內容寬度 |
| 點名 | 依上課日期記錄出席、請假、曠課、遲到、早退、延課與假期；出席可同時加選遲到／早退，並保留備註；總覽提供儀表板、學生行為分析、完整上課情形矩陣與真正異常時間軸。停班日當天起即不再列入應出席；異常只標示停班日／停班後、入班前、全班延課日仍有個人狀態、未知或名單外紀錄。點異常項目或矩陣儲存格會在總覽內開啟固定於畫面下方的編輯窗格；停班日異常可直接清除，不必另填出缺勤狀態；誤按停班可在學生管理中撤銷停班，保留原學生 ID 與歷史資料 |
| 成績 | 管理平時考與段考欄位；提供平均、中位數、最高／最低、及格率、填寫率、分數分布、各次評量摘要、個別排行、班均差與趨勢圖；平時考可修改名稱與範圍；段考另支援班排／校排 |
| 收費 | 記錄應收、已收與收款日期 |
| 行事曆 | 顯示國定假日、學測／分科測驗／會考與自訂事件；自訂事件支援不連續日期、連續日期區間、適用學校複選、編輯與刪除 |
| 備份 | 匯出與匯入 JSON；備份包含班級索引、學生主檔索引、教學資料與手動行事曆事件 |

上方導覽的「行事曆」會開啟月曆。國定假日以不同底色標示；選定日期沒有節日或事件時，下方事件窗格會隱藏。事件清單會顯示事件名稱、適用學校與多日數量。

在班級的「平時考」與「段考」頁面，成績輸入欄會依 90–100、80–89、70–79、60–69、未達 60 顯示色階；畫面同時提供班級 KPI、分布條、各次評量摘要、個別表現排行，以及含最新、變化、班均差、最高、最低與 PR 的學生統計表。各次評量的人數分母會依考試日期判定當時已入班且尚未停班的學生，因此後來入班或之後停班的學生不會被算入早期考試；摘要會顯示「已填／當時人數」，填寫率、各次平均與趨勢也採同一規則。若舊評量沒有日期，則以現有名單維持相容計算。欄位標題右上角的鉛筆按鈕可修改平時考或段考名稱；平時考編輯器會一併提供範圍欄位。按「儲存」或 Enter 套用，按 Escape／「取消」放棄；修改名稱或範圍不會影響該欄既有分數、日期、科目或班排／校排。色階以 100 分量尺提供直覺提示，非百分制評量請依實際滿分自行換算後解讀。

## 專案結構

| 路徑 | 用途 |
|---|---|
| `src/App.jsx` | 主要畫面、班級流程、行事曆、出缺勤、成績與資料操作 |
| `src/AuthGate.jsx` | Firebase Email／Password 登入閘門；目前只接受單一教師帳號 |
| `src/firebase.js` | Firebase 初始化設定 |
| `src/calendar.js` | 行事曆事件正規化、日期判斷與連續性判斷 |
| `src/attendance.js` | 出缺勤複選狀態正規化、舊資料相容與總覽統計 |
| `src/students.js` | 學生主檔相容建立、班別日期區間與班別專屬學校 fallback |
| `src/assessment.js` | 成績數值解析、100 分色帶、分數分布、中位數與前後次變化 |
| `public/calendar/national-holidays.json` | 由政府辦公日曆資料產生的國定假日資料 |
| `public/calendar/major-exams.json` | 經官方公告確認的大考日期資料 |
| `scripts/sync-holidays.mjs` | 下載並轉換官方國定假日資料 |
| `scripts/calendar.test.mjs` | 行事曆日期、事件與多選學校資料測試 |
| `scripts/attendance.test.mjs` | 出缺勤舊字串、複選互斥規則、停班邊界與總覽統計測試 |
| `scripts/students.test.mjs` | 學生主檔合併、停班／復課日期與班別學校優先順序測試 |
| `scripts/assessment.test.mjs` | 成績色帶、分布比例、中位數與變化量測試 |
| `.github/workflows/deploy.yml` | GitHub Pages 建置與發布 |
| `.github/workflows/sync-holidays.yml` | 定期同步官方國定假日資料 |
| `firebase.rules.json` | 單人模式 Firebase Realtime Database 安全規則 |

## Firebase 登入與安全規則

`src/AuthGate.jsx` 中的 `TEACHER_EMAIL` 必須與 Firebase Authentication → Users 裡的登入帳號完全一致。密碼只在登入畫面輸入，**不要寫入程式碼或提交至 Git**。

`firebase.rules.json` 目前以登入帳號 email 限制整個 `records` 節點的讀寫權限，其他路徑預設拒絕。若日後更換登入帳號，必須同步修改 `src/AuthGate.jsx` 與 `firebase.rules.json`，再到 Firebase Console 的 Realtime Database → Rules 發布新規則。更嚴格的長期做法是改用固定 Firebase UID。

## 資料保存位置

所有應用資料位於 Firebase Realtime Database 的 `records/` 節點：

| 路徑 | 內容 |
|---|---|
| `records/classIndex` | 班級、各班學生與課表設定；各班學生保存該班進班／停課日期 |
| `records/studentIndex` | 以學生 ID 為主的基本資料索引，保存姓名、全域學校／年級、各班日期資訊與班別專屬 `enrollments[<classId>].school`；由舊 `classIndex` 相容建立 |
| `records/attendance/<班級 id>` | 以日期保存點名資料 |
| `records/quiz/<班級 id>`、`records/exam/<班級 id>` | 平時考與段考資料 |
| `records/fee/<班級 id>` | 收費資料 |
| `records/calendar/events` | 手動建立的行事曆事件 |
| `records/lastBackupAt` | 最近一次成功同步的備份時間 |

官方國定假日與大考資料是隨網站發布的靜態檔案，不會寫入 Firebase。手動行事曆事件則會寫入 `records/calendar/events`，也會包含在 JSON 備份中。

## 行事曆資料維護

國定假日資料由政府行政機關辦公日曆資料轉換而來。可以在專案根目錄執行下列指令重新產生資料：

```bash
npm run sync:holidays
```

GitHub Actions 會每月執行同步；只有資料實際變更時才會提交，之後由部署流程發布新資料。同步腳本產生的 `public/calendar/national-holidays.json` 不應手動修改。

學測、分科測驗與國中教育會考不是固定規則，而是依年度官方簡章或公告確認。因此，年度資料請人工核對後更新 `public/calendar/major-exams.json`，並保留官方來源網址。校內段考與校外教學沒有單一全國資料源，請在行事曆的「新增事件」中建立；適用學校可以複選，未選學校代表適用全部學校。

| 資料 | 維護方式 | 來源或核對方式 |
|---|---|---|
| 國定假日 | 腳本與 GitHub Actions 自動同步 | 政府資料開放平臺的政府行政機關辦公日曆表 [1] |
| 學測、分科測驗 | 更新 `public/calendar/major-exams.json` | 大學入學考試中心年度簡章與公告 [2] |
| 國中教育會考 | 更新 `public/calendar/major-exams.json` | 國中教育會考官方公告 [3] |
| 校內段考、校外教學 | 在 App 中手動建立或編輯 | 以各校公告為準 |

## 本機開發

本機需要 Node.js 20 以上；GitHub Actions 發布流程使用 Node.js 24，以符合 GitHub Actions 的目前執行環境。第一次建立依賴時使用鎖定檔安裝：

```bash
npm ci
npm run dev
```

Vite 開發伺服器啟動後，請開啟：

```text
http://localhost:5173/TeachingRecord/
```

由於本專案的 `base` 是 GitHub Pages 的 `/TeachingRecord/`，本機測試時也要保留這個路徑。

## 測試與建置

提交前至少執行以下指令：

```bash
npm test
npm run build
```

`npm test` 會驗證日期區間、不連續日期、事件正規化、多選學校、台灣時區日期，出缺勤複選、真正異常判定、學生停班／復課邊界、舊匯入資料的起始日推導、學生主檔索引與班別學校 fallback，以及成績數值解析、分數色帶、分布比例、中位數、前後次變化、入班／停班日期與各次評量歷史人數分母；`npm run build` 會產生 `dist/`。`dist/` 與 `node_modules/` 不應提交至 Git。

## GitHub Pages 部署

部署流程只會在 `main` 分支收到 push，或從 GitHub Actions 手動執行時啟動。流程會使用 Node.js 24、`npm ci` 安裝鎖定版本、執行 `npm test` 與 `npm run build`，再透過 GitHub Pages Actions 發布 `dist/`。建置與發布 job 分開，發布 job 明確使用 `pages: write` 與 `id-token: write`。

目前 workflow 使用 `actions/checkout@v7`、`actions/configure-pages@v5`、`actions/setup-node@v7`、`actions/upload-pages-artifact@v4` 與 `actions/deploy-pages@v5`。這些版本是為了配合 GitHub Actions runner 的 Node.js 24 執行環境；不要用 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true` 退回 Node.js 20。

第一次設定時，請在 GitHub repository 的 Settings → Pages 將 Source 設為 **GitHub Actions**。成功發布後網址為：

```text
https://yzhsage.github.io/TeachingRecord/
```

若要發布本機修改，請先確認 `npm test` 與 `npm run build` 通過，再提交並推送至 `main`。Firebase Rules 不會由 GitHub Pages 自動發布，Rules 修改後仍須到 Firebase Console 手動發布。

## 備份建議

系統提供 JSON 匯出／匯入，但它是額外備份手段，不取代 Firebase 本身的資料保留策略。建議在大量修改班級、成績或收費資料前先按「備份」，並將下載的 JSON 保存於專案目錄以外的位置；下載的備份檔案不要提交至 Git。

## 參考來源

[1]: https://data.gov.tw/dataset/123662 "政府資料開放平臺：政府行政機關辦公日曆表"
[2]: https://www.ceec.edu.tw/ "大學入學考試中心"
[3]: https://www.k12ea.gov.tw/ "國中教育會考官方網站"
