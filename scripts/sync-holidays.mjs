import { mkdir, readFile, writeFile } from "node:fs/promises";

const SOURCE_URL = "https://data.ntpc.gov.tw/api/datasets/308dcd75-6434-45bc-a95f-584da4fed251/csv/file";
const OUTPUT_PATH = "public/calendar/national-holidays.json";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }

  if (cell !== "" || row.length) {
    row.push(cell);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
  }
  return rows;
}

function toIsoDate(raw) {
  const value = String(raw || "").trim();
  if (!/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function eventId(date, title) {
  const slug = title.replace(/\s+/g, "-").replace(/[^\u4e00-\u9fffA-Za-z0-9-]/g, "").slice(0, 32) || "holiday";
  return `national-${date}-${slug}`;
}

const response = await fetch(SOURCE_URL, { headers: { accept: "text/csv" } });
if (!response.ok) throw new Error(`辦公日曆下載失敗：HTTP ${response.status}`);

const text = await response.text();
const [header, ...body] = parseCsv(text.replace(/^\uFEFF/, ""));
const index = Object.fromEntries(header.map((name, i) => [name.trim(), i]));
const events = body
  .map((row) => {
    const date = toIsoDate(row[index.date]);
    const category = String(row[index.holidaycategory] || "").trim();
    const name = String(row[index.name] || "").trim();
    const description = String(row[index.description] || "").trim();
    if (!date || row[index.isholiday] !== "是" || category === "星期六、星期日") return null;
    const title = name || category || "國定假日";
    return {
      id: eventId(date, title),
      date,
      endDate: date,
      title,
      type: "nationalHoliday",
      note: description || category,
      source: "行政院人事行政總處政府行政機關辦公日曆表",
      sourceUrl: "https://data.gov.tw/dataset/123662",
      readOnly: true,
    };
  })
  .filter(Boolean)
  .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, "zh-Hant"));

await mkdir("public/calendar", { recursive: true });
const nextBundle = { sourceUrl: SOURCE_URL, events };
let previousBundle = null;
try {
  previousBundle = JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
} catch {
  // The first run has no previous bundle.
}
if (JSON.stringify(previousBundle?.events || []) === JSON.stringify(events)) {
  console.log(`官方日期沒有變更：${events.length} 筆非週末放假資料`);
} else {
  await writeFile(
    OUTPUT_PATH,
    `${JSON.stringify({ ...nextBundle, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  console.log(`已更新 ${OUTPUT_PATH}：${events.length} 筆非週末放假資料`);
}
