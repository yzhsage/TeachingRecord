# TeachingRecord 功能清單與未來維護指南

> **文件目的**：提供這個教學紀錄系統的功能總覽、日常操作方式、資料與安全邊界、備份還原方法、行事曆資料維護、測試發布流程，以及未來工作建議。
>
> **適用版本**：目前 GitHub 專案版本；文件整理日期：2026-08-26。
>
> **使用者模式**：本系統目前設計為單一教師帳號使用，不以多人協作、角色分權或多租戶資料模型為目標。

## 一、系統總覽

TeachingRecord 是一個以 React 與 Vite 建置的單頁教學紀錄工具。網站前端發布在 GitHub Pages，登入使用 Firebase Authentication，應用資料保存於 Firebase Realtime Database；官方國定假日與大考日期則以網站內的靜態 JSON 檔案提供。這種架構的優點是發布簡單、資料可跨裝置使用；相對地，Firebase Rules、備份與 GitHub Actions 都是系統能否安全穩定運作的必要維護點。

```text
瀏覽器
  ├─ React/Vite 前端 ───── GitHub Pages
  ├─ Firebase Authentication ─ 單一教師帳號登入
  └─ Firebase Realtime Database
       └─ records/：班級、點名、成績、收費、手動行事曆事件

網站發布資料
  ├─ public/calendar/national-holidays.json：政府辦公日曆轉換資料
  └─ public/calendar/major-exams.json：人工核對的大考日期
```

GitHub Pages 自訂 workflow 的發布 job 必須具備 `pages: write` 與 `id-token: write` 權限，並以 `github-pages` environment 部署 [3]。目前 workflow 已將這兩項權限明確放在發布 job，建置 job 則負責測試、建置與上傳 Pages artifact。

## 二、功能清單

| 功能區 | 使用者可做的事 | 主要資料位置 | 維護重點 |
|---|---|---|---|
| 登入 | 以單一密碼登入，不在畫面輸入帳號 | Firebase Authentication | `src/AuthGate.jsx` 的 `TEACHER_EMAIL` 必須與 Firebase 使用者一致 |
| 行事曆 | 查看月份、切換月份、選取日期、查看國定假日與大考 | 靜態 JSON；手動事件另存 Firebase | 國定假日以底色顯示；手動事件支援編輯、刪除、多日與不連續日期 |
| 班級管理 | 新增班級、編輯班級資訊、封存、還原、永久刪除 | `records/classIndex` | 永久刪除前先備份；封存比刪除安全 |
| 學生名單 | 新增、改名、指定學校、試聽／轉正、停班、重新啟用、永久刪除 | `records/classIndex` | 優先使用「停班」保留歷史資料，不要直接永久刪除 |
| 出缺勤 | 依日期記錄出席、請假、曠課、遲到、早退、延課、假期與備註；出席可同時加選遲到／早退 | `records/attendance/<classId>` | 基礎狀態擇一；遲到／早退只有出席時可用；課表調整不應覆寫歷史紀錄 |
| 出缺勤總覽 | A1 儀表板與色彩矩陣、A2 學生行為分析、A3 異常時間軸；點擊日期 × 學生儲存格可直接修改或清除 | 同出缺勤資料 | 遲到／早退獨立統計但可與出席並存；總覽只統計已存在的出缺勤資料 |
| 平時考 | 新增考試欄位、修改評量名稱、日期、科目、範圍，輸入分數並查看 KPI、分數分布、各次摘要、排行、完整統計與趨勢圖 | `records/quiz/<classId>` | 修改名稱不會影響既有分數；成績欄位刪除會連同該欄分數移除，操作前應先備份；色帶以 100 分量尺解讀 |
| 段考 | 新增段考欄位、修改評量名稱、輸入分數、班排／校排並查看同一套視覺化統計 | `records/exam/<classId>` | 修改名稱不會影響既有分數；同樣使用共用評量元件與資料驗證；分數色帶不代表自訂滿分換算 |
| 收費 | 建立收費區間、金額、教材費、折扣，標記已收／取消收費並篩選逾期 | `records/fee/<classId>` | 只有建立班級時啟用收費的班級才會顯示收費分頁 |
| 學生與課表 | 管理班級資訊、學生、分科、每週／隔週課表與生效期間 | `records/classIndex` | 修改課表時應使用生效起始／結束日保留歷史邏輯 |
| 單次調整 | 新增或取消某一個日期的課程，設定補課時間與原因 | 班級的 `overrides` | 適合處理補課、停課、颱風或學校活動 |
| 備份 | 匯出全部資料 JSON、由檔案或貼上文字匯入 | Firebase 與本機下載檔 | 備份包含手動行事曆事件；匯入前一定要先再匯出一份現況備份 |
| 異常恢復 | 找回仍有歷史資料但已從名單移除的學生 | 多個班級資料節點 | 「消失的學生」可重新接回原 ID，並標記為已停班 |

## 三、日常使用流程

### 1. 每日記錄出缺勤
登入後，首頁預設顯示「行事曆」。選取需要處理的日期，系統會列出當日依課表排定的班級。點選班級卡片進入「出缺勤」，先確認日期與上課時間，再為每位學生選擇狀態，並填寫教學日誌內容與當日備註。狀態變更會自動保存；右上角顯示「儲存中」或「已儲存」。若顯示「儲存失敗，點此重試」，應先按重試並確認網路連線，不要立即關閉頁面。出席、遲到與早退的規則是：先選「出席」，再視需要加選「＋遲到」或「＋早退」，兩者可以同時存在；請假、曠課、延課、假期會排除遲到／早退，且基礎狀態彼此擇一。


若當天原本有排課但臨時停課，使用「取消本次上課」並填寫原因；若當天沒有排課但需要補課，使用「新增本次上課（補課）」。這些操作會建立單次課表調整，不會改動原本的週期課表。

### 2. 使用出缺勤總覽與修正早期紀錄
在出缺勤頁切換「總覽」，可以先看儀表板的紀錄日期、出席率、遲到、早退、請假／曠課與待檢視異常日，再以學生行為分析比較個別出席率與異常次數。異常時間軸會列出請假、曠課、遲到、早退、未知狀態、停課日仍有紀錄、停班後紀錄、入班前紀錄與名單外紀錄；點選日期可以回到該日單日表。狀態矩陣使用色彩晶片呈現複選狀態，點擊任一儲存格即可開啟 C1 編輯器，儲存新的狀態或清除整筆紀錄。修改前若涉及大量早期 Excel 匯入資料，應先匯出備份；系統不會自動刪除疑似錯誤資料。

### 3. 管理班級與學生

在「所有班級」中可以查看進行中與已封存班級。新建班級時填入班級名稱、科目、年級、可選的分科項目，以及是否需要收費。進入班級後，在「學生與課表」分頁可以修改基本資訊、增加學生、指定學校、設定試聽狀態、停班或重新啟用。

學生離開班級時，建議使用「停班」而不是「永久刪除」。停班會讓學生不再出現在後續出缺勤名單，但仍保留過往出缺勤、成績與收費資料。只有在確認資料不再需要、且已完成備份後，才使用永久刪除。

### 3. 維護課表

課表規則可以設定星期、每週／隔週、開始與結束時間，以及生效起始日和生效結束日。升學年度或固定課表變更時，建議替舊規則填上結束日，再新增一條以新日期開始的規則。不要直接刪掉舊規則，否則可能讓過往日期無法依原排課方式顯示。

「單次調整紀錄」適合處理個別日期的取消或新增上課，例如颱風停課、校慶、補課與臨時調課。它與週期性課表分開保存，便於日後回查。

### 4. 管理平時考與段考

在班級詳細頁切換到「平時考」或「段考」後，先新增評量欄位，再填寫每位學生分數。若要更正欄位名稱，至成績矩陣的欄位標題右上角按鉛筆按鈕，輸入新名稱後按「儲存」；也可以按 Enter 儲存或按 Escape／「取消」放棄修改。修改只更新該評量的 `name`，不會刪除或改動日期、科目、範圍、分數及班排／校排資料。平時考可以設定科目與範圍分段；段考可以記錄班排／校排。系統會依目前篩選條件計算平均、中位數、最高／最低、及格率、填寫率、標準差、個別平均、最新分數、前後次變化、班均差、PR 與進步率，並提供五段分數分布、各次評量摘要、個別表現排行與成績趨勢圖。**各次評量的人數分母會依該評量日期判定當時已入班且尚未停班的學生**，因此後來入班或之後停班的學生不會被算進早期考試；各次摘要會顯示「已填／當時人數」，填寫率、各次平均與趨勢也採同一判定。若舊資料沒有評量日期，系統會保留相容行為，以現有名單計算。成績輸入欄會依 90–100、80–89、70–79、60–69、未達 60 顯示色階；這是以 100 分量尺提供直覺提示，若評量有其他滿分，應在解讀時自行換算。

刪除評量欄位會一併刪除該欄的成績資料。這是不可直接在介面復原的操作，因此建議刪除前先使用「備份」匯出 JSON。

### 5. 管理收費

啟用收費的班級會多出「收費」分頁。新增收費時選擇學生、填寫收費區間、金額、教材費與折扣，系統會自動計算總金額。收款後按「收費」標記，若誤標可以按「取消收費」恢復未收狀態。頁面可依全部、逾期、未收、已收或特定學生篩選。

收費資料屬於高敏感度資料，建議每次大量調整前都先備份，且不要把下載的備份 JSON 放入 GitHub repository。

### 6. 使用行事曆

行事曆會顯示三類官方資料：國定假日、學測／分科測驗、國中教育會考；也會顯示自行建立的學校段考、校外教學與其他事件。國定假日會以不同底色標示，事件會以色帶或色框表示。選定日期有節日或事件時，下方才會出現簡短事件窗格；沒有內容時窗格會隱藏。

建立自訂事件時，可以加入單日、連續日期區間，或多個不連續日期。例如同一個「校內段考」可以同時選取 10/14、10/16、10/17；適用學校可以複選，未選學校則代表適用全部學校。已建立的手動事件可從事件窗格按「編輯」修改，也可以刪除。

## 四、行事曆資料維護

### 1. 國定假日

`public/calendar/national-holidays.json` 是由 `scripts/sync-holidays.mjs` 根據政府資料開放平臺的政府行政機關辦公日曆表產生，來源資料集可由政府資料開放平臺查閱 [5]。這個 JSON 不應直接手動修改；若需要更新，執行：

```bash
npm run sync:holidays
```

`.github/workflows/sync-holidays.yml` 會每月執行一次同步，只有產生結果真的改變時才會提交。提交後會觸發 GitHub Pages 發布流程。維護者應在同步後檢查 JSON 日期是否仍為 `YYYY-MM-DD`，尤其注意補休日、連假與跨年度資料。

### 2. 大考日期

`public/calendar/major-exams.json` 是人工核對的資料，不應假設學測、分科測驗或會考日期每年固定。每次新增年度資料時，應先查看大學入學考試中心的年度簡章或公告 [6]，以及國中教育會考官方公告 [7]，確認日期後再加入事件，並保留 `source` 與 `sourceUrl`。

更新大考資料的建議步驟如下：

1. 先確認官方公告或簡章已正式發布。
2. 將日期以 `YYYY-MM-DD` 寫入 `dates` 或 `date`／`endDate`。
3. 保留官方來源名稱與網址。
4. 執行 `npm test` 與 `npm run build`。
5. 開啟本機行事曆，逐月核對日期位置。

### 3. 校內段考與校外教學

校內日期沒有單一全國性資料源，因此目前以 App 內手動建立、編輯為主。若未來取得學校行事曆的 CSV 或 ICS 檔案，可以新增匯入功能，但必須先定義欄位對應、重複事件處理與資料來源覆蓋規則，不能直接把外部檔案全部覆蓋現有事件。

## 五、資料結構與相容性

所有應用資料都位於 Firebase Realtime Database 的 `records/` 節點。前端使用的儲存鍵會將冒號轉換為斜線，例如 `attendance:abc123` 會保存為 `records/attendance/abc123`。

| Firebase 路徑 | 內容與主要欄位 |
|---|---|
| `records/classIndex` | 班級陣列；班級包含 `id`、`name`、`subject`、`grade`、`hasFee`、`students`、`subjects`、`scheduleRules`、`overrides`、`archived` |
| `records/attendance/<classId>` | 以日期為鍵；每日可包含 `content`、`note`、`records`，其中 `records` 對應 `studentId` 到舊單一字串或新複選陣列狀態 |
| `records/quiz/<classId>` | `{ columns: [], scores: {} }`；欄位包含評量名稱、日期、科目與範圍，分數位於 `scores` |
| `records/exam/<classId>` | 與平時考相同的基本結構，另可保存班排／校排 |
| `records/fee/<classId>` | `{ charges: [] }`；收費項目包含學生、區間、金額、教材費、折扣、付款狀態與付款日期 |
| `records/calendar/events` | 手動事件陣列；事件包含 `id`、`title`、`type`、`dates`、`date`、`endDate`、`schools`、`school`、`note`、`source`、`sourceUrl` |
| `records/lastBackupAt` | 最近一次成功把備份時間寫入 Firebase 的 ISO 日期時間 |

出缺勤狀態的基礎狀態為 `出席`、`請假`、`曠課`、`延課`、`假期`，彼此擇一；`遲到` 與 `早退` 是只有出席才可存在的修飾狀態。舊資料的單一字串仍可讀取，例如舊的 `"遲到"` 會以「出席＋遲到」解讀；新複選資料則保存為狀態陣列。總覽可直接修改或清除單一日期／學生紀錄，清除最後一筆紀錄時會移除該學生的資料鍵，必要時也會移除空白日期節點。

行事曆事件的正式資料欄位是 `dates` 陣列，因此可以同時保存連續與不連續日期。舊資料若只有 `date`／`endDate`，`src/calendar.js` 仍會展開為連續日期；舊有單一 `school` 欄位也會相容轉換成 `schools` 陣列。未來修改資料模型時，必須維持這些舊欄位的讀取相容性，或先寫明確的遷移程式與回復方式。

## 六、登入、安全與資料保護

目前是單一使用者系統，`src/AuthGate.jsx` 的 `TEACHER_EMAIL` 會在前端固定登入帳號，使用者只輸入密碼。Firebase Web API key 出現在前端是正常現象，真正的安全邊界是 Firebase Authentication、Realtime Database Rules 與前端登入閘門 [8]。

`firebase.rules.json` 目前以登入帳號 email 限制 `records/` 的讀寫，其他路徑預設拒絕。更換登入帳號時必須同步修改：

| 檔案／位置 | 要修改的內容 |
|---|---|
| `src/AuthGate.jsx` | `TEACHER_EMAIL` |
| `firebase.rules.json` | `.read` 與 `.write` 的 email 條件 |
| Firebase Authentication | 使用者帳號本身 |
| Firebase Console → Realtime Database → Rules | 發布新的 Rules |

長期而言，Rules 以固定 Firebase UID 會比 email 條件更穩定。這不是目前使用功能的必要條件，但如果帳號 email 會變更，應優先處理。密碼絕對不要寫入程式碼、README、備份檔或 Git 提交。

## 七、備份與還原

### 備份

在「備份」面板按「匯出全部資料」會下載 JSON，內容包含班級索引、各班級的出缺勤、平時考、段考、收費資料，以及手動行事曆事件。系統也會嘗試把最近備份時間寫入 `records/lastBackupAt`；若這一步失敗，檔案仍可能已下載，但畫面會提示雲端備份時間尚未同步。

建議採用以下備份習慣：

| 時機 | 建議動作 |
|---|---|
| 大量改名、刪除評量或調整課表前 | 先匯出一份備份，檔名加上操作前標記 |
| 每週至少一次 | 匯出全部資料，保存到專案目錄以外的位置 |
| 發布新版前 | 匯出現況備份，確認檔案可以開啟且大小合理 |
| 還原資料前 | 先匯出目前狀態，因為匯入沒有一鍵復原按鈕 |

### 還原

可以選擇 JSON 檔案，若手機瀏覽器無法正常開啟檔案選擇器，也可以貼上 JSON 文字。匯入前會檢查備份版本與基本格式；目前匯入會用備份內容覆蓋相同班級 ID 的資料，未出現在備份中的既有班級不會自動刪除。若備份包含 `calendarEvents`，手動行事曆事件也會一併更新。

若匯入失敗，先保留原始備份檔與現況備份，不要連續嘗試多個不同版本的檔案。必要時可用 Firebase Console 的資料匯出或人工比對，並在任何手動修復前建立另一份備份。

## 八、開發、測試與發布

### 本機環境

本機建議使用 Node.js 20 以上；GitHub Actions 發布流程使用 Node.js 24。第一次建立依賴時使用鎖定檔：

```bash
npm ci
```

啟動本機開發伺服器：

```bash
npm run dev
```

由於 GitHub Pages 的 base path 是 `/TeachingRecord/`，本機測試請開啟：

```text
http://localhost:5173/TeachingRecord/
```

### 必做驗證

每次修改程式、資料模型、行事曆 JSON 或 workflow 後，至少執行：

```bash
TZ=Asia/Taipei npm test
npm run build
npx --yes prettier@3 --check .github/workflows/deploy.yml .github/workflows/sync-holidays.yml
```

目前測試涵蓋連續多日事件、不連續日期、多選學校、事件正規化、台灣時區日期，出缺勤舊字串相容、出席與遲到／早退複選互斥、總覽統計，以及成績數值解析、100 分色帶、分布比例、中位數、前後次變化、入班／停班日期與各次評量容量。建置成功只代表程式可編譯，不代表 Firebase 登入後的每一條操作路徑都已完成瀏覽器驗證；若修改涉及登入、備份、行事曆表單、成績輸入或 Firebase 寫入，仍應在瀏覽器實際操作一次。

### GitHub Pages 發布

發布 workflow 位於 `.github/workflows/deploy.yml`，會在 `main` 分支收到 push 或手動執行時啟動。流程依序執行 checkout、Pages 設定、Node 24、`npm ci`、`npm test`、`npm run build`、上傳 `dist/`，再由獨立的 deploy job 發布。

正式發布前請依序確認：

1. 已在 Firebase Console 發布目前使用的 `firebase.rules.json`。
2. 已匯出一份現況 JSON 備份。
3. `npm test`、`npm run build` 與 workflow 格式檢查全部通過。
4. 已確認 Git 工作區只有預期修改。
5. 提交並推送至 `main`。
6. 在 Actions 查看建置與部署兩個 job 都成功。
7. 開啟 [正式網站][2]，使用無痕視窗或強制重新整理確認新版本已載入。

GitHub Pages 不會自動發布 Firebase Rules；Rules 的發布仍須在 Firebase Console 完成。Node 20 已進入 GitHub Actions 淘汰流程，GitHub 建議更新到支援 Node 24 的 Actions [4]，因此不要以 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true` 作為長期解法。

## 九、故障排除

| 症狀 | 優先檢查 | 處理方式 |
|---|---|---|
| GitHub Actions 顯示 `Failed to get ID Token` | deploy job 是否有 `pages: write`、`id-token: write`；Pages 是否使用 GitHub Actions | 確認 workflow 使用目前版本，先重新執行一次；若持續失敗，再檢查 `github-pages` environment 與 GitHub Status |
| 網站空白 | 瀏覽器 Console、最近一次前端提交、是否載入錯誤 JSON | 先用 ErrorBoundary 顯示的重新載入操作；回退最近一次前端修改，確認是否為元件例外 |
| 登入成功但資料顯示空白 | Firebase Rules、登入 email、Realtime Database `records/` | 確認 Rules 已發布且 email 與 `TEACHER_EMAIL` 完全一致；不要把讀取失敗當作資料遺失 |
| 儲存一直顯示失敗 | 網路、Firebase Rules、輸入格式 | 按「儲存失敗，點此重試」，再查看 Console；先不要關閉頁面或重複快速點擊 |
| 國定假日提前一天 | `src/calendar.js` 是否使用 UTC 日曆序號；JSON 日期是否為 `YYYY-MM-DD` | 執行日期測試，確認 `eventDates()` 未使用本地時間加 `toISOString()` 造成偏移 |
| 國定假日資料未更新 | Actions 的同步 workflow 與政府 CSV 來源 | 手動執行 `npm run sync:holidays`，查看產生差異；確認 workflow 有權限提交資料 |
| 備份匯入後資料不如預期 | 備份的 `schemaVersion`、班級 ID、是否包含 `calendarEvents` | 保留匯入前現況備份，先以副本檢查 JSON，不要直接修改原始備份 |

## 十、檔案維護地圖

| 檔案 | 何時修改 | 修改後必做 |
|---|---|---|
| `src/App.jsx` | UI、班級、出缺勤、成績、收費、備份與行事曆流程 | `npm test`、`npm run build`，並在瀏覽器操作受影響功能 |
| `src/calendar.js` | 日期計算、事件格式、多日／不連續日期、學校相容性 | 補單元測試，特別在 `TZ=Asia/Taipei` 執行 |
| `src/attendance.js` | 出缺勤複選狀態正規化、舊資料相容、互斥規則與總覽統計 | 修改狀態規則時同步更新 `scripts/attendance.test.mjs` |
| `src/assessment.js` | 分數解析、100 分色帶、分布比例、中位數、前後次變化與歷史在班人數 | 修改統計規則時同步更新 `scripts/assessment.test.mjs` |
| `src/AuthGate.jsx` | 更換唯一登入帳號或登入行為 | 與 Firebase Authentication、Rules 同步確認 |
| `src/firebase.js` | 更換 Firebase 專案或資料庫端點 | 確認 Rules、Authentication 與資料庫環境一致 |
| `firebase.rules.json` | 調整資料存取邊界 | 在 Firebase Console 發布，並用實際登入帳號測試讀寫 |
| `public/calendar/national-holidays.json` | 不直接修改；由同步腳本產生 | 執行同步腳本與 JSON 日期檢查 |
| `public/calendar/major-exams.json` | 新增官方公告的大考年度資料 | 核對官方來源、保留網址、測試建置 |
| `scripts/sync-holidays.mjs` | 政府資料格式或來源改變 | 用實際 CSV 測試，確認不會把日期轉錯 |
| `scripts/calendar.test.mjs` | 日期或事件規則改變 | 新增回歸案例，確保舊資料格式仍可讀 |
| `scripts/attendance.test.mjs` | 出缺勤資料格式或複選規則改變 | 驗證舊字串、複選互斥與獨立統計 |
| `scripts/assessment.test.mjs` | 成績統計與分數區間規則改變 | 驗證色帶邊界、分布比例、中位數、變化量與歷史班級人數分母 |
| `.github/workflows/deploy.yml` | Node、Actions、Pages 發布流程改變 | Prettier 檢查、建置測試、手動 workflow 驗證 |
| `.github/workflows/sync-holidays.yml` | 同步排程或自動提交流程改變 | 手動執行 workflow，確認提交與後續發布 |
| `README.md` | 使用方式、資料路徑、部署流程改變 | 與本指南同步更新 |

## 十一、未來維護優先級

### P0：資料安全與可恢復性

第一優先是把 `firebase.rules.json` 從 email 條件改成固定 Firebase UID，並在 Firebase Console 實際驗證未登入、錯誤帳號與正確帳號的讀寫結果。第二是讓資料讀取失敗與「資料確實為空」在介面上明確區分，避免網路或 Rules 問題被誤認為資料消失。第三是考慮為備份匯入加入匯入前快照或可回復機制。

### P1：測試與工程穩定性

`src/App.jsx` 目前集中包含大量畫面與資料流程，未來可以依功能拆成行事曆、班級、出缺勤、評量、收費與備份元件。現有測試主要集中在行事曆資料模型，應逐步增加備份格式、輸入驗證、資料寫入錯誤與關鍵使用流程的測試。也應固定檢查 `npm audit --omit=dev` 與完整 audit，並安排 Recharts 2.x 升級評估；目前套件可建置，但 Recharts 2.x 已停止維護，升級前要先驗證圖表 API。

### P2：功能擴充與使用體驗

可考慮加入 CSV／ICS 匯入，讓校內段考與校外教學能從學校提供的行事曆檔案建立；加入事件來源更新日期、重複事件檢查與匯入預覽；再視實際需要加入離線草稿、行動裝置安裝提示與更細緻的搜尋。這些功能不應以犧牲目前資料安全與備份流程為代價。

## 十二、版本交接檢查表

交接給下一位維護者前，應確認以下事項：

| 項目 | 完成條件 |
|---|---|
| Firebase 帳號 | 知道唯一登入帳號，但密碼不寫入文件或 Git |
| Firebase Rules | 知道目前版本已發布時間，且與 `firebase.rules.json` 一致 |
| GitHub Pages | Settings → Pages 的 Source 為 GitHub Actions |
| Actions | `Deploy to GitHub Pages` 最近一次建置與部署成功 |
| 行事曆來源 | 知道國定假日由腳本同步，大考資料需人工核對，校內日期由 App 手動維護 |
| 備份 | 有一份最近可讀的 JSON 備份，且存放在 repository 以外 |
| 本機環境 | Node.js 20 以上、`npm ci` 可成功完成 |
| 品質檢查 | `npm test`、`npm run build` 與 workflow 格式檢查通過 |
| 未來風險 | 已知 email Rules、讀取錯誤辨識、Recharts 2.x、bundle 大小與缺少 E2E 測試等技術債 |

## 參考來源

[1]: https://github.com/yzhsage/TeachingRecord "TeachingRecord GitHub repository"
[2]: https://yzhsage.github.io/TeachingRecord/ "TeachingRecord GitHub Pages"
[3]: https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages "GitHub Pages：Using custom workflows with GitHub Pages"
[4]: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/ "GitHub Actions：Deprecation of Node 20"
[5]: https://data.gov.tw/dataset/123662 "政府資料開放平臺：政府行政機關辦公日曆表"
[6]: https://www.ceec.edu.tw/ "大學入學考試中心"
[7]: https://www.k12ea.gov.tw/ "國中教育會考官方網站"
[8]: https://firebase.google.com/docs/database/security "Firebase Realtime Database Security Rules"
