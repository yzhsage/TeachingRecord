import React, { useState, useEffect, useRef } from "react";
import {
  ChevronLeft, ChevronRight, Plus, X, ArrowLeft, Archive, ArchiveRestore,
  Users, ClipboardList, GraduationCap, Wallet, Settings2, CalendarDays,
  Trash2, Pencil, CircleDot, Clock, BadgeCheck, Check
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from "recharts";
import _ from "lodash";
import { ref, get, set as dbSet } from "firebase/database";
import { signOut } from "firebase/auth";
import { db, auth } from "./firebase";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const WEEKDAY_FULL = ["日", "一", "二", "三", "四", "五", "六"];
const STATUS_LIST = ["出席", "請假", "曠課", "遲到", "早退", "延課", "假期"];
const STATUS_STYLE = {
  出席: { bg: "#EAF3EC", fg: "#3F7D5C", bd: "#BFDCC9", short: "出" },
  請假: { bg: "#FBF3DE", fg: "#A87B14", bd: "#EFDBA0", short: "假" },
  曠課: { bg: "#FBEAE9", fg: "#B23A34", bd: "#F0C6C3", short: "曠" },
  遲到: { bg: "#E9EFF6", fg: "#3F5E8C", bd: "#C3D3E7", short: "遲" },
  早退: { bg: "#EFE9F6", fg: "#6A4E9C", bd: "#D8CBEF", short: "早" },
  延課: { bg: "#EEEEEC", fg: "#71757A", bd: "#D9D9D5", short: "延" },
  假期: { bg: "#E6F1F3", fg: "#2E7D8C", bd: "#BFE0E5", short: "假期" },
};
/* statuses that count against attendance for rate calculations */
const RATE_STATUSES = ["出席", "請假", "曠課", "遲到", "早退"];
/* Trial students are promoted to regular membership starting with
   their 3rd recorded session (first 2 are the trial period). */
const TRIAL_SESSION_COUNT = 2;
const CLASS_COLORS = ["#B8863B", "#3F7D5C", "#4C6C99", "#7A5EA8", "#B23A34", "#3E8FA8", "#8C6D3F"];
const CHART_COLORS = ["#B8863B", "#4C6C99", "#7A5EA8", "#3F7D5C", "#B23A34"];

/* ------------------------------------------------------------------ */
/* Date helpers                                                        */
/* ------------------------------------------------------------------ */

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function fromDateStr(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(dateStr, n) {
  const d = fromDateStr(dateStr);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}
function todayStr() { return toDateStr(new Date()); }
function weekdayOf(dateStr) { return fromDateStr(dateStr).getDay(); }
function formatDisplay(dateStr) {
  const d = fromDateStr(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}（週${WEEKDAY_FULL[d.getDay()]}）`;
}
function genId() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }
function parseTimeMinutes(t) {
  if (!t) return Infinity;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/* ------------------------------------------------------------------ */
/* Stats helpers                                                       */
/* ------------------------------------------------------------------ */

function mean(arr) { if (!arr.length) return null; return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}
function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Math.round(n * 10) / 10;
}

/* ------------------------------------------------------------------ */
/* Schedule logic                                                       */
/* ------------------------------------------------------------------ */

function formatTimeRange(startTime, endTime) {
  if (!startTime) return "";
  return endTime ? `${startTime}~${endTime}` : startTime;
}
function getSessionInfo(cls, dateStr) {
  const overrides = cls.overrides || [];
  const ov = overrides.find((o) => o.date === dateStr);
  if (ov) {
    if (ov.action === "add") return { scheduled: true, startTime: ov.time || "", endTime: ov.endTime || "", time: formatTimeRange(ov.time, ov.endTime) };
    return { scheduled: false, startTime: "", endTime: "", time: "" };
  }
  const wd = weekdayOf(dateStr);
  for (const rule of cls.scheduleRules || []) {
    if (rule.effectiveFrom && dateStr < rule.effectiveFrom) continue;
    if (rule.effectiveTo && dateStr > rule.effectiveTo) continue;
    if (Number(rule.dayOfWeek) !== wd) continue;
    if (Number(rule.interval) === 2) {
      const anchor = rule.anchorDate || rule.effectiveFrom;
      if (!anchor) continue;
      const diffDays = Math.round((fromDateStr(dateStr) - fromDateStr(anchor)) / 86400000);
      if (diffDays % 14 !== 0) continue;
      return { scheduled: true, startTime: rule.startTime || "", endTime: rule.endTime || "", time: formatTimeRange(rule.startTime, rule.endTime) };
    }
    return { scheduled: true, startTime: rule.startTime || "", endTime: rule.endTime || "", time: formatTimeRange(rule.startTime, rule.endTime) };
  }
  return { scheduled: false, startTime: "", endTime: "", time: "" };
}
function isClassDay(cls, dateStr) { return getSessionInfo(cls, dateStr).scheduled; }
/* Does this attendance blob have anything recorded for dateStr? */
function hasSessionRecord(attendanceData, dateStr) {
  const day = attendanceData && attendanceData[dateStr];
  return !!(day && (Object.keys(day.records || {}).length > 0 || day.content));
}
/* THE single source of truth for "did/does this class have a session
   on this date": true if it matches the current schedule rules, OR if
   there's already attendance recorded for it. Every place that needs
   to answer that question — the calendar dots, the day's class list,
   the attendance-tab badge, and the nav-arrow boundary — must call
   this (or findAdjacentClassDay, which uses it) rather than checking
   isClassDay directly, so a later schedule-rule edit can never hide
   older real history again. */
function isSessionDay(cls, dateStr, attendanceData) {
  return isClassDay(cls, dateStr) || hasSessionRecord(attendanceData, dateStr);
}
function findAdjacentClassDay(cls, dateStr, direction, attendanceData) {
  let d = dateStr;
  const recordedDates = attendanceData ? Object.keys(attendanceData).filter((k) => hasSessionRecord(attendanceData, k)) : [];
  const boundary = earliestScheduledDate(cls, recordedDates);
  for (let i = 0; i < 1500; i++) {
    d = addDays(d, direction);
    if (direction < 0 && boundary && d < boundary) return dateStr;
    if (isSessionDay(cls, d, attendanceData)) return d;
  }
  return addDays(dateStr, direction);
}
/* Earliest date this class could ever have a session: the earliest
   scheduleRule.effectiveFrom, the earliest one-off "add" override, or
   (if given) the earliest date that already has attendance recorded —
   this last one matters because editing/replacing a schedule rule
   shouldn't make older real history unreachable via the nav arrows. */
function earliestScheduledDate(cls, recordedDates) {
  const froms = (cls.scheduleRules || []).map((r) => r.effectiveFrom).filter(Boolean);
  const overrideAdds = (cls.overrides || []).filter((o) => o.action === "add").map((o) => o.date);
  const recorded = recordedDates || [];
  const all = [...froms, ...overrideAdds, ...recorded];
  if (!all.length) return null;
  return all.sort()[0];
}
function scheduleSummary(cls) {
  const rules = (cls.scheduleRules || []).filter((r) => !r.effectiveTo || r.effectiveTo >= todayStr());
  if (rules.length === 0) return "尚未設定課表";
  return rules
    .map((r) => {
      const freq = r.interval === 2 ? "隔週" : "每週";
      const from = r.effectiveFrom && r.effectiveFrom > todayStr() ? `（自 ${r.effectiveFrom} 起）` : "";
      const time = formatTimeRange(r.startTime, r.endTime);
      return `${freq}週${WEEKDAY_FULL[r.dayOfWeek]}${time ? ` ${time}` : ""}${from}`;
    })
    .join("、");
}
/* Days until (and time of) this class's next occurrence from `fromDate`,
   inclusive of today. Used to order the class list by upcoming schedule. */
function nextSessionInfo(cls, fromDate) {
  for (let i = 0; i < 14; i++) {
    const d = addDays(fromDate, i);
    const session = getSessionInfo(cls, d);
    if (session.scheduled) return { daysUntil: i, startTime: session.startTime, time: session.time };
  }
  return { daysUntil: Infinity, startTime: "", time: "" };
}
function colorForClass(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % CLASS_COLORS.length;
  return CLASS_COLORS[h];
}

/* ------------------------------------------------------------------ */
/* Class-to-class navigation: treats every class's weekly schedule     */
/* rules as slots on one shared weekly timetable (Sun 00:00 → Sat      */
/* 23:59) so the "<" / ">" arrows can step to the adjacent class       */
/* regardless of which real calendar date is currently open.          */
/* ------------------------------------------------------------------ */

function nearestDateForWeekday(fromDate, targetDayOfWeek) {
  let best = fromDate;
  let bestAbs = Infinity;
  for (let off = -6; off <= 6; off++) {
    const d = addDays(fromDate, off);
    if (weekdayOf(d) === targetDayOfWeek && Math.abs(off) < bestAbs) {
      bestAbs = Math.abs(off);
      best = d;
    }
  }
  return best;
}
function buildWeeklySlots(classes) {
  const slots = [];
  classes.forEach((c) => {
    (c.scheduleRules || []).forEach((r) => {
      if (r.effectiveTo && r.effectiveTo < todayStr()) return;
      const sortKey = Number(r.dayOfWeek) * 1440 + parseTimeMinutesSafe(r.startTime);
      slots.push({ classId: c.id, dayOfWeek: Number(r.dayOfWeek), startTime: r.startTime || "", sortKey });
    });
  });
  slots.sort((a, b) => a.sortKey - b.sortKey || a.classId.localeCompare(b.classId));
  return slots;
}
function parseTimeMinutesSafe(t) {
  if (!t) return 0;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function getAdjacentClass(cls, classes, direction, referenceDate) {
  const slots = buildWeeklySlots(classes);
  if (slots.length < 2) return null;
  const mySlots = slots.filter((s) => s.classId === cls.id);
  if (mySlots.length === 0) return null;
  const refDate = referenceDate || todayStr();
  const refWeekday = weekdayOf(refDate);
  // Prefer whichever of this class's own slots matches the weekday
  // currently on screen — that way repeatedly pressing the arrow walks
  // through the week continuously instead of jumping based on the
  // real-world clock (which made some classes unreachable whenever two
  // classes shared the same weekday slot).
  const anchor = mySlots.find((s) => s.dayOfWeek === refWeekday) || mySlots[0];
  const anchorIdx = slots.findIndex((s) => s === anchor);
  const n = slots.length;
  const targetIdx = ((anchorIdx + direction) % n + n) % n;
  const target = slots[targetIdx];
  const targetClass = classes.find((c) => c.id === target.classId);
  if (!targetClass) return null;
  return { cls: targetClass, date: nearestDateForWeekday(refDate, target.dayOfWeek) };
}
function dedupeById(arr) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
/* Student membership as of a SPECIFIC DATE — not a fixed label. A
   student can be "not_yet" on a date before they joined, "trial" on
   their first two recorded sessions, "active" from the third session
   onward, and "stopped" on any date after their end date. This lets
   the same student show up correctly no matter which date you're
   looking at (e.g. viewing last month shouldn't show today's status).
     - joinDate: first date they can appear at all (unset = no floor,
       for pre-existing/imported rosters that predate this feature)
     - endDate: last date they attended (set when marked 停班)
     - forceActive / forceTrial: manual overrides, for when the
       tutor wants to skip or extend the automatic trial period
   Legacy fields (isTrial, active:false, membership) from earlier
   versions are still honored for data created before this change. */
function isStoppedAt(student, dateStr) {
  if (student.endDate && dateStr > student.endDate) return true;
  if (student.membership === "stopped" || student.active === false) return !student.endDate || dateStr > student.endDate;
  return false;
}
function membershipAtDate(student, dateStr, attendanceData) {
  if (student.joinDate && dateStr < student.joinDate) return "not_yet";
  if (isStoppedAt(student, dateStr)) return "stopped";
  if (student.forceActive || student.membership === "active") return "active";
  if (student.forceTrial) return "trial";
  const entryDates = Object.keys(attendanceData || {})
    .filter((d) => (!student.joinDate || d >= student.joinDate) && d <= dateStr && attendanceData[d] && attendanceData[d].records && attendanceData[d].records[student.id] !== undefined)
    .sort();
  if (entryDates.length <= TRIAL_SESSION_COUNT) return "trial";
  return "active";
}
/* "Current" (today) membership when no specific date/attendance is in
   scope — used by places (like the fee tab) that just need to know
   whether someone is still enrolled at all. */
function getMembership(s) {
  if (isStoppedAt(s, todayStr())) return "stopped";
  return "active";
}

/* ------------------------------------------------------------------ */
/* Storage helpers                                                     */
/* ------------------------------------------------------------------ */

/* Storage keys used elsewhere in this file look like "attendance:abc123".
   Firebase Realtime Database paths use "/" for nesting, so ":" is mapped
   to "/" and everything lives under a single "records" root — this keeps
   the security rules simple (one rule covers all app data). */
function keyToPath(key) {
  return `records/${key.replace(/:/g, "/")}`;
}
async function loadKey(key, fallback) {
  try {
    const snap = await get(ref(db, keyToPath(key)));
    if (!snap.exists()) return fallback;
    return snap.val();
  } catch (e) {
    console.error("firebase load failed", key, e);
    return fallback;
  }
}
async function saveKey(key, value) {
  memoryCache.set(key, value);
  try {
    // Firebase's set() throws on `undefined` properties (unlike
    // JSON.stringify, which silently drops them) — round-tripping
    // through JSON first keeps the old, more forgiving behavior.
    const sanitized = JSON.parse(JSON.stringify(value));
    await dbSet(ref(db, keyToPath(key)), sanitized);
    return true;
  } catch (e) {
    console.error("firebase save failed", key, e);
    return false;
  }
}
/* Module-level (not React state) cache, keyed by storage key. This is
   the actual fix for "switch class/tab, come back, edit is gone": that
   was a race between the debounced save (still in flight) and the
   fresh reload-from-storage that happens whenever a tab remounts. By
   keeping the authoritative value in memory for the whole session, a
   remount reuses it instantly instead of re-fetching — so it can never
   read back a stale value while a save is still pending underneath.
   saveKey() also writes through to this cache so that direct saves
   (backup restore, demo import) can never be masked by a stale entry
   left over from an earlier visit to the same class. */
const memoryCache = new Map();
function useCachedStore(key, fallback) {
  const [value, setValue] = useState(() => (memoryCache.has(key) ? memoryCache.get(key) : fallback));
  const [ready, setReady] = useState(() => memoryCache.has(key));

  useEffect(() => {
    let cancelled = false;
    if (memoryCache.has(key)) {
      setValue(memoryCache.get(key));
      setReady(true);
      return;
    }
    (async () => {
      const loaded = await loadKey(key, fallback);
      if (cancelled) return;
      memoryCache.set(key, loaded);
      setValue(loaded);
      setReady(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function update(updater) {
    setValue((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      memoryCache.set(key, next);
      return next;
    });
  }

  return [value, update, ready];
}

/* Robust debounced save: compares content, not a "first run" flag,
   so it survives React StrictMode's double-invoked effects without
   re-saving or clobbering data. */
function useDebouncedSave(value, key, ready, delay = 700) {
  const [status, setStatus] = useState("idle");
  const timer = useRef(null);
  const lastSaved = useRef(null);
  const initialized = useRef(false);
  const latestValue = useRef(value);
  const latestKey = useRef(key);
  latestValue.current = value;
  latestKey.current = key;

  useEffect(() => {
    if (!ready) return;
    if (!initialized.current) {
      initialized.current = true;
      lastSaved.current = value;
      return;
    }
    if (_.isEqual(value, lastSaved.current)) return;
    setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await saveKey(key, value);
      lastSaved.current = value;
      timer.current = null;
      setStatus("saved");
    }, delay);
    // Only clears the pending timer so a fresh one can be scheduled on
    // the next change — does NOT run on real unmount discarding data,
    // that's handled by the separate effect below.
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, ready]);

  // Flush any still-pending save the moment this component actually
  // unmounts (e.g. switching tabs right after an edit) so a quick edit
  // is never silently dropped just because the debounce hadn't fired yet.
  useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        saveKey(latestKey.current, latestValue.current);
      }
    };
  }, []);

  return status;
}

/* ------------------------------------------------------------------ */
/* Small shared UI bits                                                 */
/* ------------------------------------------------------------------ */

function SaveIndicator({ status }) {
  if (status === "idle") return null;
  return <span className="save-indicator">{status === "saving" ? "儲存中…" : "✓ 已儲存"}</span>;
}
function IconBtn({ onClick, children, title, danger, disabled }) {
  return (
    <button onClick={disabled ? undefined : onClick} title={title} disabled={disabled} className={"icon-btn" + (danger ? " icon-btn-danger" : "")} type="button">
      {children}
    </button>
  );
}
/* Inline confirm-to-delete (no native confirm() dialogs, which don't
   reliably work inside sandboxed previews). */
function ConfirmDelete({ onConfirm, title, label }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <span className="confirm-inline">
        <span className="confirm-inline-label">{label || "確定刪除？"}</span>
        <button className="btn-ghost btn-xs" onClick={() => setConfirming(false)}>取消</button>
        <button className="btn-danger btn-xs" onClick={() => { setConfirming(false); onConfirm(); }}>刪除</button>
      </span>
    );
  }
  return <IconBtn danger title={title || "刪除"} onClick={() => setConfirming(true)}><Trash2 size={15} /></IconBtn>;
}
/* Neutral (non-destructive-red) inline confirm, for consequential but
   reversible actions like marking a student 停班. */
function ConfirmAction({ onConfirm, label, confirmText, children }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <span className="confirm-inline confirm-inline-neutral">
        <span className="confirm-inline-label confirm-inline-label-neutral">{label}</span>
        <button className="btn-ghost btn-xs" onClick={() => setConfirming(false)}>取消</button>
        <button className="btn-primary btn-sm" onClick={() => { setConfirming(false); onConfirm(); }}>{confirmText || "確定"}</button>
      </span>
    );
  }
  return <button className="btn-ghost btn-xs" onClick={() => setConfirming(true)}>{children}</button>;
}
function Toast({ message, onClose }) {
  if (!message) return null;
  return (
    <div className="toast">
      <span>{message}</span>
      <button onClick={onClose}><X size={14} /></button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Demo import: seed data extracted from the user's existing Excel     */
/* records, for one-click trial import of all 5 real classes.          */
/* ------------------------------------------------------------------ */

const WUHUA_ID = "demo_gaoyi_wuhua_115";
const WUHUA_STUDENTS = [{"id": "s1", "name": "陳宥晴", "school": "港明"}, {"id": "s2", "name": "廖婕茹", "school": "港明"}, {"id": "s3", "name": "高家芊", "school": "港明"}, {"id": "s4", "name": "張馨云", "school": "新化"}, {"id": "s5", "name": "吳昱葳", "school": "港明", "joinDate": "2026-07-04"}];
const WUHUA_ATTENDANCE = {"2026-06-27": {"note": "", "content": "", "records": {"s1": "曠課", "s2": "出席", "s3": "出席", "s4": "出席"}}, "2026-07-04": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "試聽"}}, "2026-07-11": {"note": "巴威颱風", "content": "", "records": {"s1": "延課", "s2": "延課", "s3": "延課", "s4": "延課", "s5": "延課"}}, "2026-07-18": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席"}}, "2026-07-25": {"note": "", "content": "", "records": {"s3": "請假"}}, "2026-08-08": {"note": "", "content": "", "records": {"s2": "請假"}}};
const WUHUA_FEE = {"charges": [{"id": "fee1", "studentId": "s1", "periodStart": "2026-07-01", "periodEnd": "2026-07-31", "tuition": "", "materials": "", "discount": "", "givenDate": "", "paid": true, "paidDate": "2026-07-18"}, {"id": "fee2", "studentId": "s2", "periodStart": "2026-07-01", "periodEnd": "2026-07-31", "tuition": "", "materials": "", "discount": "", "givenDate": "", "paid": true, "paidDate": "2026-07-18"}, {"id": "fee3", "studentId": "s3", "periodStart": "2026-07-01", "periodEnd": "2026-07-31", "tuition": "", "materials": "", "discount": "", "givenDate": "", "paid": true, "paidDate": "2026-07-18"}, {"id": "fee4", "studentId": "s4", "periodStart": "2026-07-01", "periodEnd": "2026-07-31", "tuition": "", "materials": "", "discount": "", "givenDate": "", "paid": true, "paidDate": "2026-07-18"}, {"id": "fee5", "studentId": "s5", "periodStart": "2026-07-01", "periodEnd": "2026-07-31", "tuition": "", "materials": "", "discount": "", "givenDate": "", "paid": true, "paidDate": "2026-07-18"}]};

const IMPORT_DEFS = [
  {
    meta: {
      id: WUHUA_ID, name: "高一物化", subject: "物理化學", grade: "高一", hasFee: true,
      subjects: ["物理", "化學"], archived: false, students: WUHUA_STUDENTS,
      scheduleRules: [{ id: genId(), dayOfWeek: 6, interval: 1, anchorDate: "", effectiveFrom: "2026-06-27", effectiveTo: null, startTime: "" }],
      overrides: [{ date: "2026-07-11", action: "cancel", note: "巴威颱風", time: "" }],
    },
    attendance: WUHUA_ATTENDANCE,
    quiz: { columns: [], scores: {} },
    exam: { columns: [], scores: {} },
    fee: WUHUA_FEE,
  },
{"meta": {"id": "import_guosan_ziran_113", "name": "國三自然", "subject": "自然", "grade": "國三", "hasFee": false, "subjects": [], "archived": false, "students": [{"id": "s1", "name": "鄭育安", "school": "安南", "isTrial": false}, {"id": "s2", "name": "莊佳敏", "school": "安南", "isTrial": false}, {"id": "s3", "name": "王語安", "school": "安南", "isTrial": false}, {"id": "s4", "name": "林婧淳", "school": "安南", "isTrial": false}, {"id": "s5", "name": "鄭沛瑜", "school": "安南", "isTrial": false}, {"id": "s6", "name": "陳妏晴", "school": "安南", "isTrial": false}, {"id": "s7", "name": "張淯承", "school": "安南", "isTrial": false}, {"id": "s8", "name": "高澤銘", "school": "安南", "isTrial": false}, {"id": "s9", "name": "劉家呈", "school": "安南", "isTrial": false}, {"id": "s10", "name": "郭子瑄", "school": "安南", "isTrial": false}, {"id": "s11", "name": "蘇靖倫", "school": "安南", "isTrial": false}, {"id": "s12", "name": "吳家永", "school": "安南", "isTrial": false}, {"id": "s13", "name": "林俞佐", "school": "安南", "isTrial": false}, {"id": "s14", "name": "林湘芸", "school": "安南", "isTrial": false}, {"id": "s15", "name": "黃姿瑀", "school": "安南", "isTrial": false}, {"id": "s16", "name": "楊育嘉", "school": "慈濟", "isTrial": false}, {"id": "s17", "name": "黃彥維", "school": "瀛海", "isTrial": false}], "scheduleRules": [{"id": "r3", "dayOfWeek": 3, "interval": 1, "anchorDate": "", "effectiveFrom": "2025-07-02", "effectiveTo": null, "startTime": ""}, {"id": "r6", "dayOfWeek": 6, "interval": 1, "anchorDate": "", "effectiveFrom": "2025-07-02", "effectiveTo": null, "startTime": ""}], "overrides": []}, "attendance": {"2025-07-02": {"note": "", "content": "緒論", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "試聽", "s14": "試聽"}}, "2025-07-05": {"note": "", "content": "緒論, CH1-1", "records": {"s1": "出席", "s2": "請假", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "試聽", "s14": "請假"}}, "2025-07-09": {"note": "", "content": "CH1-2", "records": {"s1": "出席", "s2": "請假", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "試聽"}}, "2025-07-12": {"note": "", "content": "CH1-3", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "試聽"}}, "2025-07-16": {"note": "", "content": "CH1-3", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "請假", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席"}}, "2025-07-19": {"note": "", "content": "評量單2", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "請假", "s15": "出席"}}, "2025-07-23": {"note": "", "content": "考第一章HA", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席"}}, "2025-07-26": {"note": "", "content": "檢討第一章HA", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席"}}, "2025-07-30": {"note": "", "content": "CH2-1", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席"}}, "2025-08-02": {"note": "", "content": "颱風停班課", "records": {"s1": "延課", "s2": "延課", "s3": "延課", "s4": "延課", "s5": "延課", "s6": "延課", "s7": "延課", "s8": "延課", "s9": "延課", "s10": "延課", "s11": "延課", "s12": "延課", "s13": "延課", "s14": "延課", "s15": "延課"}}, "2025-08-06": {"note": "", "content": "CH2-2.2", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席"}}, "2025-08-09": {"note": "", "content": "CH2-2.8", "records": {"s1": "出席", "s2": "出席", "s3": "請假", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席"}}, "2025-08-13": {"note": "", "content": "颱風停班課", "records": {"s1": "延課", "s2": "延課", "s3": "延課", "s4": "延課", "s5": "延課", "s6": "延課", "s7": "延課", "s8": "延課", "s9": "延課", "s10": "延課", "s11": "延課", "s12": "延課", "s13": "延課", "s14": "延課", "s15": "延課"}}, "2025-08-16": {"note": "", "content": "量VS度, 評2-1, 2", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "請假", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "遲到", "s15": "出席"}}, "2025-08-20": {"note": "", "content": "CH2-3.2", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席"}}, "2025-08-23": {"note": "", "content": "CH2-3E, 評2-3", "records": {"s1": "遲到", "s2": "請假", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席"}}, "2025-08-27": {"note": "", "content": "檢討評2-3, 考2-1", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席"}}, "2025-08-30": {"note": "", "content": "檢討2-1", "records": {"s1": "出席", "s2": "請假", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "停課", "s15": "出席"}}, "2025-08-31": {"note": "", "content": "補8/2, 檢討2-1", "records": {"s1": "出席", "s2": "出席", "s3": "請假", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-09-03": {"note": "", "content": "考2-2~3", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-09-06": {"note": "", "content": "檢討2-2~3", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "請假", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-09-10": {"note": "", "content": "考CH1~2", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-09-13": {"note": "", "content": "檢討CH1~2", "records": {"s1": "出席", "s2": "停課", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-09-17": {"note": "", "content": "檢討CH1~2", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-09-20": {"note": "", "content": "CH3-1", "records": {"s1": "出席", "s3": "曠課", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-09-24": {"note": "", "content": "複1-1/2, CH3-2", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-09-27": {"note": "", "content": "複1-3/2-1", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-09-28": {"note": "", "content": "補8/13, 複2-1/2-3", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-10-01": {"note": "", "content": "複3-1", "records": {"s1": "請假", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-10-04": {"note": "", "content": "複全", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "請假", "s9": "請假", "s10": "請假", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-10-08": {"note": "", "content": "複全", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-10-11": {"note": "", "content": "複全", "records": {"s1": "遲到", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "請假", "s15": "出席"}}, "2025-10-15": {"note": "", "content": "複全", "records": {"s1": "出席", "s3": "請假", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-10-18": {"note": "", "content": "CH3-2", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-10-22": {"note": "", "content": "CH3-3~4", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-10-25": {"note": "", "content": "光復節", "records": {"s1": "假期", "s2": "假期", "s3": "假期", "s4": "假期", "s5": "假期", "s6": "假期", "s7": "假期", "s8": "假期", "s9": "假期", "s10": "假期", "s11": "假期", "s12": "假期", "s13": "假期", "s14": "假期", "s15": "假期"}}, "2025-10-29": {"note": "", "content": "評5, 檢討評5", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-11-01": {"note": "", "content": "4-1", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "停課", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-11-05": {"note": "", "content": "4-2", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-11-08": {"note": "", "content": "4-3", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "請假", "s15": "出席"}}, "2025-11-12": {"note": "", "content": "", "records": {"s1": "延課", "s2": "延課", "s3": "延課", "s4": "延課", "s5": "延課", "s6": "延課", "s7": "延課", "s8": "延課", "s10": "延課", "s11": "延課", "s12": "延課", "s13": "延課", "s14": "延課", "s15": "延課"}}, "2025-11-15": {"note": "", "content": "４-3, 4", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "請假", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-11-19": {"note": "", "content": "4-3, 5-1", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-11-22": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-11-23": {"note": "", "content": "補11/12", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "請假", "s10": "請假", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-11-26": {"note": "", "content": "複習", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席"}}, "2025-11-29": {"note": "", "content": "複習", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-12-03": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-12-06": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "請假", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-12-10": {"note": "", "content": "", "records": {"s1": "延課", "s2": "延課", "s3": "延課", "s4": "延課", "s5": "延課", "s6": "延課", "s7": "延課", "s8": "延課", "s9": "延課", "s10": "延課", "s11": "延課", "s12": "延課", "s13": "延課", "s14": "延課", "s15": "延課"}}, "2025-12-13": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-12-17": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席"}}, "2025-12-20": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-12-24": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "試聽"}}, "2025-12-27": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席", "s16": "請假"}}, "2025-12-31": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席"}}, "2026-01-03": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席"}}, "2026-01-07": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席"}}, "2026-01-10": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "請假", "s13": "出席", "s15": "出席"}}, "2026-01-11": {"note": "", "content": "", "records": {"s1": "遲到", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2026-01-14": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席"}}, "2026-01-17": {"note": "", "content": "", "records": {"s1": "出席", "s3": "請假", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假"}}, "2026-01-21": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假"}}, "2026-01-24": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假"}}, "2026-01-28": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假"}}, "2026-01-31": {"note": "", "content": "", "records": {"s1": "出席", "s3": "請假", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假"}}, "2026-02-04": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假"}}, "2026-02-07": {"note": "", "content": "", "records": {"s1": "出席", "s3": "請假", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假"}}, "2026-02-11": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "請假", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假"}}, "2026-02-14": {"note": "", "content": "", "records": {"s1": "假期", "s3": "假期", "s4": "假期", "s5": "假期", "s6": "假期", "s7": "假期", "s8": "假期", "s9": "假期", "s10": "假期", "s11": "假期", "s12": "假期", "s13": "假期", "s14": "假期", "s15": "假期", "s16": "假期"}}, "2026-02-18": {"note": "", "content": "", "records": {"s1": "假期", "s2": "假期", "s3": "假期", "s4": "假期", "s5": "假期", "s6": "假期", "s7": "假期", "s8": "假期", "s9": "假期", "s10": "假期", "s11": "假期", "s12": "假期", "s13": "假期", "s14": "假期", "s15": "假期", "s16": "假期"}}, "2026-02-21": {"note": "", "content": "", "records": {"s1": "假期", "s2": "假期", "s3": "假期", "s4": "假期", "s5": "假期", "s6": "假期", "s7": "假期", "s8": "假期", "s9": "假期", "s10": "假期", "s11": "假期", "s12": "假期", "s13": "假期", "s14": "假期", "s15": "假期", "s16": "假期"}}, "2026-02-25": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席"}}, "2026-02-28": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "請假", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假"}}, "2026-03-04": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "試聽"}}, "2026-03-07": {"note": "", "content": "", "records": {"s1": "請假", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席", "s16": "請假", "s17": "試聽"}}, "2026-03-11": {"note": "", "content": "https://youtu.be/P2vrzd8mQW4", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "請假", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-03-14": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "請假", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假", "s17": "出席"}}, "2026-03-18": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-03-21": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假", "s17": "出席"}}, "2026-03-22": {"note": "", "content": "", "records": {"s1": "出席", "s3": "請假", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "請假", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假", "s17": "出席"}}, "2026-03-25": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假", "s17": "出席"}}, "2026-03-28": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席", "s16": "請假", "s17": "出席"}}, "2026-04-01": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假", "s17": "遲到"}}, "2026-04-04": {"note": "", "content": "", "records": {"s1": "假期", "s2": "假期", "s3": "假期", "s4": "假期", "s5": "假期", "s6": "假期", "s7": "假期", "s8": "假期", "s9": "假期", "s10": "假期", "s11": "假期", "s12": "假期", "s13": "假期", "s14": "假期", "s15": "假期", "s16": "假期", "s17": "假期"}}, "2026-04-08": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s14": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-04-11": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假", "s17": "出席"}}, "2026-04-15": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-04-18": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假", "s17": "請假"}}, "2026-04-22": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假", "s17": "曠課"}}, "2026-04-25": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假", "s17": "請假"}}, "2026-04-29": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-05-02": {"note": "", "content": "", "records": {"s1": "遲到", "s3": "請假", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假", "s17": "出席"}}, "2026-05-03": {"note": "", "content": "", "records": {"s1": "出席", "s3": "曠課", "s4": "曠課", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "曠課", "s10": "出席", "s11": "出席", "s12": "請假", "s13": "出席", "s15": "出席", "s16": "曠課", "s17": "曠課"}}, "2026-05-06": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假", "s17": "出席"}}, "2026-05-09": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "遲到"}}, "2026-05-13": {"note": "", "content": "", "records": {"s1": "出席", "s3": "曠課", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "請假", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "遲到"}}, "2026-05-16": {"note": "", "content": "", "records": {"s1": "出席", "s3": "請假", "s4": "曠課", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-05-20": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-05-23": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-05-27": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-05-30": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-06-03": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-06-06": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-06-10": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-06-13": {"note": "", "content": "", "records": {"s1": "出席", "s3": "請假", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "遲到", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-06-17": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-06-20": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-06-24": {"note": "", "content": "", "records": {"s1": "出席", "s3": "請假", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "請假", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-06-27": {"note": "", "content": "", "records": {"s1": "出席", "s3": "請假", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席", "s17": "出席"}}, "2026-07-01": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假"}}, "2026-07-04": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "請假"}}, "2026-07-08": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "曠課", "s11": "出席", "s12": "出席", "s13": "請假", "s15": "出席", "s16": "請假"}}, "2026-07-11": {"note": "", "content": "巴威颱風", "records": {"s1": "延課", "s2": "延課", "s3": "延課", "s4": "延課", "s5": "延課", "s6": "延課", "s7": "延課", "s8": "延課", "s9": "延課", "s10": "延課", "s11": "延課", "s12": "延課", "s13": "延課", "s14": "延課", "s15": "延課", "s16": "請假"}}, "2026-07-15": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "遲到", "s13": "出席", "s15": "出席", "s16": "曠課"}}, "2026-07-18": {"note": "", "content": "", "records": {"s1": "出席", "s3": "請假", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席"}}, "2026-07-22": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席", "s15": "出席", "s16": "出席"}}}, "quiz": {"columns": [{"id": "c1", "name": "緒論+Ch1", "date": "2025-07-23", "subject": "", "segment": ""}, {"id": "c2", "name": "2-1", "date": "2025-08-27", "subject": "", "segment": ""}, {"id": "c3", "name": "2-2~2-3", "date": "2025-09-03", "subject": "", "segment": ""}, {"id": "c4", "name": "1~2", "date": "2025-09-10", "subject": "", "segment": ""}], "scores": {"c1": {"s1": {"score": 94, "rank": ""}, "s2": {"score": 84, "rank": ""}, "s3": {"score": 71, "rank": ""}, "s4": {"score": 72, "rank": ""}, "s5": {"score": 79, "rank": ""}, "s6": {"score": 73, "rank": ""}, "s7": {"score": 55, "rank": ""}, "s8": {"score": 51, "rank": ""}, "s9": {"score": 54, "rank": ""}, "s10": {"score": 39, "rank": ""}, "s11": {"score": 70, "rank": ""}, "s12": {"score": 73, "rank": ""}, "s13": {"score": 52, "rank": ""}, "s14": {"score": 64, "rank": ""}, "s15": {"score": 48, "rank": ""}}, "c2": {"s1": {"score": 97, "rank": ""}, "s2": {"score": 56, "rank": ""}, "s3": {"score": 65, "rank": ""}, "s4": {"score": 64, "rank": ""}, "s5": {"score": 62, "rank": ""}, "s6": {"score": 66, "rank": ""}, "s7": {"score": 57, "rank": ""}, "s8": {"score": 60, "rank": ""}, "s9": {"score": 37, "rank": ""}, "s10": {"score": 40, "rank": ""}, "s11": {"score": 51, "rank": ""}, "s12": {"score": 60, "rank": ""}, "s13": {"score": 54, "rank": ""}, "s14": {"score": 56, "rank": ""}, "s15": {"score": 66, "rank": ""}}, "c3": {"s1": {"score": 91, "rank": ""}, "s2": {"score": 81, "rank": ""}, "s3": {"score": 79, "rank": ""}, "s4": {"score": 61, "rank": ""}, "s5": {"score": 79, "rank": ""}, "s6": {"score": 69, "rank": ""}, "s7": {"score": 55, "rank": ""}, "s8": {"score": 42, "rank": ""}, "s9": {"score": 62, "rank": ""}, "s10": {"score": 27, "rank": ""}, "s11": {"score": 56, "rank": ""}, "s12": {"score": 56, "rank": ""}, "s13": {"score": 34, "rank": ""}, "s15": {"score": 70, "rank": ""}}, "c4": {"s1": {"score": 94, "rank": ""}, "s2": {"score": 73, "rank": ""}, "s3": {"score": 69, "rank": ""}, "s4": {"score": 72, "rank": ""}, "s5": {"score": 56, "rank": ""}, "s6": {"score": 62, "rank": ""}, "s7": {"score": 43, "rank": ""}, "s8": {"score": 72, "rank": ""}, "s9": {"score": 49, "rank": ""}, "s10": {"score": 49, "rank": ""}, "s11": {"score": 44, "rank": ""}, "s12": {"score": 72, "rank": ""}, "s13": {"score": 19, "rank": ""}, "s15": {"score": 64, "rank": ""}}}}, "exam": {"columns": [{"id": "c1", "name": "二上一段", "date": "", "subject": "", "segment": ""}, {"id": "c2", "name": "二上二段", "date": "", "subject": "", "segment": ""}, {"id": "c3", "name": "二上三段", "date": "", "subject": "", "segment": ""}, {"id": "c4", "name": "二下一段", "date": "", "subject": "", "segment": ""}, {"id": "c5", "name": "二下二段", "date": "", "subject": "", "segment": ""}, {"id": "c6", "name": "二下三段", "date": "", "subject": "", "segment": ""}], "scores": {"c1": {"s1": {"score": 92, "rank": ""}, "s3": {"score": 98, "rank": ""}, "s4": {"score": 98, "rank": ""}, "s5": {"score": 92, "rank": ""}, "s6": {"score": 84, "rank": ""}, "s7": {"score": 74, "rank": ""}, "s8": {"score": 76, "rank": ""}, "s9": {"score": 66, "rank": ""}, "s10": {"score": 48, "rank": ""}, "s11": {"score": 62, "rank": ""}, "s12": {"score": 84, "rank": ""}, "s13": {"score": 58, "rank": ""}, "s15": {"score": 78, "rank": ""}}, "c2": {"s1": {"score": 98, "rank": ""}, "s3": {"score": 86, "rank": ""}, "s4": {"score": 94, "rank": ""}, "s5": {"score": 88, "rank": ""}, "s6": {"score": 80, "rank": ""}, "s7": {"score": 74, "rank": ""}, "s8": {"score": 72, "rank": ""}, "s10": {"score": 58, "rank": ""}, "s11": {"score": 60, "rank": ""}, "s12": {"score": 90, "rank": ""}, "s13": {"score": 76, "rank": ""}, "s15": {"score": 76, "rank": ""}}, "c3": {"s1": {"score": 88, "rank": ""}, "s3": {"score": 94, "rank": ""}, "s4": {"score": 92, "rank": ""}, "s5": {"score": 92, "rank": ""}, "s6": {"score": 82, "rank": ""}, "s7": {"score": 74, "rank": ""}, "s8": {"score": 60, "rank": ""}, "s10": {"score": 60, "rank": ""}, "s11": {"score": 60, "rank": ""}, "s12": {"score": 84, "rank": ""}, "s13": {"score": 68, "rank": ""}, "s15": {"score": 70, "rank": ""}}, "c4": {"s1": {"score": 98, "rank": ""}, "s3": {"score": 96, "rank": ""}, "s4": {"score": 100, "rank": ""}, "s5": {"score": 94, "rank": ""}, "s6": {"score": 96, "rank": ""}, "s7": {"score": 80, "rank": ""}, "s8": {"score": 72, "rank": ""}, "s10": {"score": 46, "rank": ""}, "s11": {"score": 72, "rank": ""}, "s12": {"score": 84, "rank": ""}, "s13": {"score": 64, "rank": ""}, "s15": {"score": 80, "rank": ""}, "s16": {"score": 83, "rank": ""}, "s17": {"score": 45, "rank": ""}}, "c5": {"s1": {"score": 100, "rank": ""}, "s3": {"score": 96, "rank": ""}, "s4": {"score": 98, "rank": ""}, "s5": {"score": 98, "rank": ""}, "s6": {"score": 92, "rank": ""}, "s7": {"score": 86, "rank": ""}, "s8": {"score": 86, "rank": ""}, "s10": {"score": 72, "rank": ""}, "s11": {"score": 82, "rank": ""}, "s12": {"score": 86, "rank": ""}, "s13": {"score": 68, "rank": ""}, "s15": {"score": 88, "rank": ""}, "s16": {"score": 93, "rank": ""}, "s17": {"score": 36, "rank": ""}}, "c6": {"s16": {"score": 94, "rank": ""}}}}, "fee": null},
{"meta": {"id": "import_gaozhong_shuxue_114", "name": "高二數學", "subject": "數學", "grade": "高二", "hasFee": false, "subjects": [], "archived": false, "students": [{"id": "s1", "name": "鄭宇昕", "school": "二中", "isTrial": false}, {"id": "s2", "name": "蕭剛眠", "school": "二中", "isTrial": false}, {"id": "s3", "name": "唐語梵", "school": "土城", "isTrial": false}, {"id": "s4", "name": "王柏翔", "school": "南大", "isTrial": false}, {"id": "s5", "name": "吳亭儀", "school": "南大", "isTrial": false}, {"id": "s6", "name": "高秀涵", "school": "南女", "isTrial": false}, {"id": "s7", "name": "許語實", "school": "南女", "isTrial": false}, {"id": "s8", "name": "唐翊豪", "school": "港明", "isTrial": false}, {"id": "s9", "name": "蔡洋誠", "school": "南大", "isTrial": false}, {"id": "s10", "name": "李芷昀", "school": "港明", "isTrial": false}, {"id": "s11", "name": "王心妤", "school": "港明", "isTrial": false}, {"id": "s12", "name": "謝詠媛", "school": "慈濟", "isTrial": false}, {"id": "s13", "name": "郭姵岑", "school": "瀛海", "isTrial": false}, {"id": "s14", "name": "康妤甄", "school": "南女", "isTrial": false}, {"id": "s15", "name": "王可樂", "school": "二中", "isTrial": false}], "scheduleRules": [{"id": "r1", "dayOfWeek": 1, "interval": 1, "anchorDate": "", "effectiveFrom": "2025-07-03", "effectiveTo": null, "startTime": ""}, {"id": "r4", "dayOfWeek": 4, "interval": 1, "anchorDate": "", "effectiveFrom": "2025-07-03", "effectiveTo": null, "startTime": ""}], "overrides": []}, "attendance": {"2025-07-03": {"note": "", "content": "p64.eq.2.2", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s13": "出席"}}, "2025-07-07": {"note": "", "content": "颱風停班課", "records": {"s1": "延課", "s2": "延課", "s3": "延課", "s6": "延課", "s7": "延課", "s8": "延課", "s13": "延課"}}, "2025-07-10": {"note": "", "content": "p71.eq.7.1", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s13": "出席"}}, "2025-07-14": {"note": "", "content": "p74.eq.11.1", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s12": "試聽", "s13": "出席"}}, "2025-07-17": {"note": "", "content": "CH1.End", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s12": "出席", "s13": "出席"}}, "2025-07-21": {"note": "", "content": "p92.eq.4.4", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s12": "出席", "s13": "出席"}}, "2025-07-24": {"note": "", "content": "p95.eq.6", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s12": "出席", "s13": "出席"}}, "2025-07-28": {"note": "", "content": "P100.eq.10", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "試聽", "s6": "出席", "s7": "請假", "s8": "出席", "s12": "出席", "s13": "出席"}}, "2025-07-31": {"note": "", "content": "p109.C2-2", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "試聽", "s6": "出席", "s7": "出席", "s8": "請假", "s12": "出席", "s13": "出席"}}, "2025-08-04": {"note": "", "content": "p112.S4~6", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s12": "出席", "s13": "出席"}}, "2025-08-07": {"note": "", "content": "p114.eq.4", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s6": "出席", "s7": "請假", "s8": "出席", "s12": "遲到", "s13": "出席"}}, "2025-08-11": {"note": "", "content": "p115E, CH1.2", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s6": "出席", "s7": "出席", "s8": "請假", "s9": "試聽", "s12": "出席", "s13": "出席"}}, "2025-08-14": {"note": "", "content": "CH1.10", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s6": "出席", "s7": "出席", "s8": "請假", "s12": "出席", "s13": "出席"}}, "2025-08-18": {"note": "", "content": "CH1.18", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s6": "出席", "s7": "出席", "s8": "請假", "s12": "出席", "s13": "出席"}}, "2025-08-21": {"note": "", "content": "卷完", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s12": "請假", "s13": "出席"}}, "2025-08-25": {"note": "", "content": "竹女108一段", "records": {"s1": "請假", "s2": "出席", "s3": "出席", "s4": "遲到", "s6": "出席", "s7": "請假", "s8": "出席", "s12": "出席", "s13": "出席"}}, "2025-08-28": {"note": "", "content": "檢討竹女108一", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "遲到", "s6": "出席", "s7": "出席", "s8": "出席", "s12": "出席", "s13": "出席"}}, "2025-09-01": {"note": "", "content": "1回, p117.eq.6.2", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2025-09-04": {"note": "", "content": "2回", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2025-09-08": {"note": "", "content": "3回, P118.eq.7", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "試聽", "s11": "試聽", "s12": "出席", "s13": "出席"}}, "2025-09-11": {"note": "", "content": "4回, P121.eq.8", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "試聽", "s12": "出席", "s13": "出席"}}, "2025-09-15": {"note": "", "content": "5回, p121.eq.9.2", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "請假", "s12": "出席", "s13": "出席"}}, "2025-09-18": {"note": "", "content": "6回, eq.9", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席"}}, "2025-09-22": {"note": "", "content": "7回, eq.10", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "遲到", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "遲到", "s12": "出席", "s13": "出席"}}, "2025-09-25": {"note": "", "content": "8,9回", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "遲到", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "遲到", "s12": "出席", "s13": "出席"}}, "2025-09-29": {"note": "", "content": "補7/7, 10,11回", "records": {"s1": "出席", "s2": "出席", "s3": "請假", "s4": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "曠課", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席"}}, "2025-10-02": {"note": "", "content": "12回", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "遲到", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "遲到", "s12": "出席", "s13": "出席"}}, "2025-10-06": {"note": "", "content": "複習", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席"}}, "2025-10-09": {"note": "", "content": "複習", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "試聽", "s6": "出席", "s7": "出席", "s8": "請假", "s9": "出席", "s10": "遲到", "s11": "遲到", "s12": "出席", "s13": "出席"}}, "2025-10-13": {"note": "", "content": "複習", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "試聽", "s6": "遲到", "s7": "出席", "s8": "請假", "s9": "出席", "s10": "出席", "s11": "遲到", "s12": "出席", "s13": "出席"}}, "2025-10-16": {"note": "", "content": "13回, p137.eq.5.1", "records": {"s1": "出席", "s2": "出席", "s3": "請假", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "遲到", "s9": "出席", "s10": "出席", "s11": "遲到", "s12": "出席", "s13": "出席"}}, "2025-10-20": {"note": "", "content": "14回, p138.eq.6.1", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "請假", "s8": "出席", "s9": "出席", "s10": "停課", "s11": "遲到", "s12": "出席", "s13": "出席"}}, "2025-10-23": {"note": "", "content": "15回, p140.eq.7.1", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "請假", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s11": "請假", "s12": "出席", "s13": "出席", "s14": "試聽"}}, "2025-10-27": {"note": "", "content": "16回, p149", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s11": "出席", "s12": "出席", "s13": "出席"}}, "2025-10-30": {"note": "", "content": "17回, p151", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s11": "遲到", "s12": "出席", "s13": "出席"}}, "2025-11-03": {"note": "", "content": "18回, p155", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s11": "停課", "s12": "出席", "s13": "出席", "s15": "試聽"}}, "2025-11-06": {"note": "", "content": "19回, p160", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "請假"}}, "2025-11-10": {"note": "", "content": "20回, p168", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "請假"}}, "2025-11-13": {"note": "", "content": "21回, p171", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "請假", "s13": "出席", "s15": "試聽"}}, "2025-11-17": {"note": "", "content": "22回, ", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-11-20": {"note": "", "content": "複習", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "請假", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-11-24": {"note": "", "content": "複習", "records": {"s1": "遲到", "s2": "出席", "s3": "請假", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-11-27": {"note": "", "content": "複習", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "請假", "s9": "出席", "s12": "出席", "s13": "請假", "s15": "出席"}}, "2025-12-01": {"note": "", "content": "", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-12-04": {"note": "", "content": "23回", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "請假", "s6": "出席", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-12-08": {"note": "", "content": "24回", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-12-11": {"note": "", "content": "25回", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-12-15": {"note": "", "content": "26回", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "請假", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-12-18": {"note": "", "content": "27回", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2025-12-22": {"note": "", "content": "28回", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "遲到"}}, "2025-12-25": {"note": "", "content": "", "records": {"s1": "假期", "s2": "假期", "s3": "假期", "s4": "假期", "s5": "假期", "s6": "假期", "s7": "假期", "s8": "假期", "s9": "假期", "s10": "假期", "s11": "假期", "s12": "假期", "s13": "假期", "s14": "假期", "s15": "假期"}}, "2025-12-29": {"note": "", "content": "29回", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "請假"}}, "2026-01-01": {"note": "", "content": "", "records": {"s1": "假期", "s2": "假期", "s3": "假期", "s4": "假期", "s5": "假期", "s6": "假期", "s7": "假期", "s8": "假期", "s9": "假期", "s10": "假期", "s11": "假期", "s12": "假期", "s13": "假期", "s14": "假期", "s15": "假期"}}, "2026-01-05": {"note": "", "content": "30,31回", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2026-01-08": {"note": "", "content": "32回", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2026-01-12": {"note": "", "content": "段考週", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "請假", "s9": "請假", "s12": "請假", "s13": "出席", "s15": "出席"}}, "2026-01-15": {"note": "", "content": "段考週", "records": {"s1": "遲到", "s2": "出席", "s3": "請假", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "請假", "s15": "請假"}}, "2026-01-19": {"note": "", "content": "", "records": {"s1": "出席", "s2": "請假", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "請假", "s8": "出席", "s9": "遲到", "s12": "出席", "s13": "出席", "s15": "請假"}}, "2026-01-22": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "請假"}}, "2026-01-26": {"note": "", "content": "p29.Eq.2.3", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "請假", "s5": "出席", "s6": "請假", "s7": "請假", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2026-01-29": {"note": "", "content": "", "records": {"s1": "請假", "s2": "出席", "s3": "出席", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "請假", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "請假"}}, "2026-02-02": {"note": "", "content": "", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "請假", "s13": "出席", "s15": "出席"}}, "2026-02-05": {"note": "", "content": "https://youtu.be/e8fyuSdP5PQ", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "請假", "s12": "出席", "s13": "出席", "s15": "請假"}}, "2026-02-09": {"note": "", "content": "p58.Eq6.3", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "遲到", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2026-02-12": {"note": "", "content": "https://youtu.be/vhtUpJWnORA", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "曠課", "s12": "出席", "s13": "出席", "s15": "請假"}}, "2026-02-16": {"note": "", "content": "", "records": {"s1": "假期", "s2": "假期", "s3": "假期", "s4": "假期", "s5": "假期", "s6": "假期", "s7": "假期", "s8": "假期", "s9": "假期", "s10": "假期", "s11": "假期", "s12": "假期", "s13": "假期", "s14": "假期", "s15": "假期"}}, "2026-02-19": {"note": "", "content": "", "records": {"s1": "假期", "s2": "假期", "s3": "假期", "s4": "假期", "s5": "假期", "s6": "假期", "s7": "假期", "s8": "假期", "s9": "假期", "s10": "假期", "s11": "假期", "s12": "假期", "s13": "假期", "s14": "假期", "s15": "假期"}}, "2026-02-23": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2026-02-26": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "遲到", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2026-03-02": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2026-03-05": {"note": "", "content": "https://youtu.be/6L50BSYHM8E", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "請假", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "請假"}}, "2026-03-09": {"note": "", "content": "https://youtu.be/rrJT7Vbhuj4", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "請假"}}, "2026-03-12": {"note": "", "content": "", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2026-03-16": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2026-03-19": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "請假", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "請假", "s9": "出席", "s12": "請假", "s13": "出席", "s15": "出席"}}, "2026-03-23": {"note": "", "content": "", "records": {"s1": "遲到", "s2": "請假", "s3": "請假", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "請假", "s9": "遲到", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2026-03-26": {"note": "", "content": "https://youtu.be/IJK9rKBv3cc", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "請假", "s15": "出席"}}, "2026-03-30": {"note": "", "content": "", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "遲到"}}, "2026-04-02": {"note": "", "content": "", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "請假", "s8": "出席", "s9": "出席", "s12": "曠課", "s13": "出席", "s15": "曠課"}}, "2026-04-06": {"note": "", "content": "", "records": {"s1": "假期", "s2": "假期", "s3": "假期", "s4": "假期", "s5": "假期", "s6": "假期", "s7": "假期", "s8": "假期", "s9": "假期", "s10": "假期", "s11": "假期", "s12": "假期", "s13": "假期", "s14": "假期", "s15": "假期"}}, "2026-04-09": {"note": "", "content": "", "records": {"s1": "出席", "s2": "請假", "s3": "出席", "s4": "出席", "s5": "請假", "s6": "出席", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "請假"}}, "2026-04-13": {"note": "", "content": "", "records": {"s1": "遲到", "s2": "停課", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2026-04-16": {"note": "", "content": "", "records": {"s1": "遲到", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "請假", "s13": "出席", "s15": "曠課"}}, "2026-04-20": {"note": "", "content": "", "records": {"s1": "遲到", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "出席"}}, "2026-04-23": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "請假", "s13": "出席", "s15": "曠課"}}, "2026-04-27": {"note": "", "content": "", "records": {"s1": "遲到", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "出席", "s15": "曠課"}}, "2026-04-30": {"note": "", "content": "", "records": {"s1": "出席", "s3": "請假", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "請假", "s13": "出席", "s15": "停課"}}, "2026-05-04": {"note": "", "content": "", "records": {"s1": "遲到", "s3": "請假", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-05-07": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "遲到", "s7": "出席", "s8": "請假", "s9": "遲到", "s12": "出席", "s13": "出席"}}, "2026-05-11": {"note": "", "content": "", "records": {"s1": "請假", "s3": "出席", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-05-14": {"note": "", "content": "", "records": {"s1": "遲到", "s3": "出席", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "請假", "s12": "請假", "s13": "請假"}}, "2026-05-18": {"note": "", "content": "", "records": {"s1": "遲到", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-05-21": {"note": "", "content": "", "records": {"s1": "遲到", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "請假", "s9": "出席", "s12": "請假", "s13": "出席"}}, "2026-05-25": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "遲到", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-05-28": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "遲到", "s9": "遲到", "s12": "請假", "s13": "出席"}}, "2026-06-01": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "曠課", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-06-04": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s4": "停課", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "請假", "s13": "出席"}}, "2026-06-08": {"note": "", "content": "", "records": {"s1": "遲到", "s3": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-06-11": {"note": "", "content": "", "records": {"s1": "遲到", "s3": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-06-15": {"note": "", "content": "", "records": {"s1": "遲到", "s3": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "請假", "s12": "出席", "s13": "出席"}}, "2026-06-18": {"note": "", "content": "", "records": {"s1": "遲到", "s3": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "遲到", "s12": "出席", "s13": "出席"}}, "2026-06-22": {"note": "", "content": "", "records": {"s1": "出席", "s3": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "遲到", "s12": "請假", "s13": "出席"}}, "2026-06-25": {"note": "", "content": "", "records": {"s1": "出席", "s3": "請假", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "請假", "s9": "遲到", "s12": "請假", "s13": "請假"}}, "2026-06-29": {"note": "", "content": "", "records": {"s1": "遲到", "s3": "請假", "s5": "停課", "s6": "請假", "s7": "請假", "s8": "出席", "s9": "遲到", "s12": "出席", "s13": "請假"}}, "2026-07-02": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s6": "遲到", "s7": "出席", "s8": "遲到", "s9": "遲到", "s12": "出席", "s13": "出席"}}, "2026-07-06": {"note": "", "content": "", "records": {"s1": "請假", "s3": "請假", "s6": "出席", "s7": "請假", "s8": "出席", "s9": "遲到", "s12": "出席", "s13": "請假"}}, "2026-07-09": {"note": "", "content": "", "records": {"s1": "請假", "s3": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "請假"}}, "2026-07-13": {"note": "", "content": "", "records": {"s1": "請假", "s3": "出席", "s6": "出席", "s7": "請假", "s8": "遲到", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-07-16": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s6": "出席", "s7": "請假", "s8": "出席", "s9": "遲到", "s12": "出席", "s13": "請假"}}, "2026-07-20": {"note": "", "content": "", "records": {"s1": "遲到", "s3": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "請假"}}, "2026-07-23": {"note": "", "content": "", "records": {"s1": "出席", "s3": "出席", "s6": "曠課", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-07-27": {"note": "", "content": "", "records": {"s13": "請假"}}, "2026-07-30": {"note": "", "content": "", "records": {"s13": "請假"}}}, "quiz": {"columns": [], "scores": {}}, "exam": {"columns": [{"id": "c1", "name": "高一上第一次", "date": "", "subject": "", "segment": ""}, {"id": "c2", "name": "高一上第二次", "date": "", "subject": "", "segment": ""}, {"id": "c3", "name": "高一上第三次", "date": "", "subject": "", "segment": ""}, {"id": "c4", "name": "高一下第一次", "date": "", "subject": "", "segment": ""}, {"id": "c5", "name": "高一下第二次", "date": "", "subject": "", "segment": ""}, {"id": "c6", "name": "高一下第三次", "date": "", "subject": "", "segment": ""}], "scores": {"c1": {"s1": {"score": 21, "rank": ""}, "s2": {"score": 77, "rank": "14/224"}, "s3": {"score": 88, "rank": "2/3"}, "s4": {"score": 62, "rank": "9/135"}, "s5": {"score": 66, "rank": "5/31"}, "s6": {"score": 49, "rank": ""}, "s7": {"score": 68, "rank": "16/286"}, "s8": {"score": 77, "rank": ""}, "s9": {"score": 78, "rank": "21/"}, "s10": {"score": 26, "rank": ""}, "s11": {"score": 28, "rank": ""}, "s12": {"score": 4, "rank": ""}, "s13": {"score": 77, "rank": "1/54"}, "s15": {"score": 11, "rank": ""}}, "c2": {"s1": {"score": 15, "rank": ""}, "s2": {"score": 65, "rank": "1/13"}, "s3": {"score": 82, "rank": "2/"}, "s4": {"score": 60, "rank": ""}, "s5": {"score": 55, "rank": "3/"}, "s6": {"score": 38, "rank": ""}, "s7": {"score": 47, "rank": ""}, "s8": {"score": 35, "rank": ""}, "s9": {"score": 58, "rank": "2/"}, "s12": {"score": 12, "rank": ""}, "s13": {"score": 79, "rank": "2/55"}, "s15": {"score": 17, "rank": ""}}, "c3": {"s1": {"score": 30, "rank": ""}, "s2": {"score": 57, "rank": ""}, "s3": {"score": 85, "rank": "1/"}, "s4": {"score": 49, "rank": ""}, "s5": {"score": 68, "rank": ""}, "s6": {"score": 48, "rank": ""}, "s7": {"score": 63, "rank": ""}, "s8": {"score": 28, "rank": ""}, "s9": {"score": 71, "rank": ""}, "s12": {"score": 20, "rank": ""}, "s13": {"score": 63, "rank": ""}, "s15": {"score": 16, "rank": ""}}, "c4": {"s1": {"score": 23, "rank": ""}, "s2": {"score": 56, "rank": "12/230"}, "s3": {"score": 70, "rank": ""}, "s4": {"score": 75, "rank": ""}, "s5": {"score": 65, "rank": ""}, "s6": {"score": 49, "rank": ""}, "s7": {"score": 47, "rank": ""}, "s8": {"score": 51, "rank": ""}, "s9": {"score": 75, "rank": ""}, "s12": {"score": 16, "rank": ""}, "s13": {"score": 53, "rank": ""}, "s15": {"score": 26, "rank": ""}}, "c5": {"s1": {"score": 15, "rank": ""}, "s3": {"score": 78, "rank": ""}, "s4": {"score": 79, "rank": ""}, "s5": {"score": 46, "rank": ""}, "s6": {"score": 49, "rank": ""}, "s7": {"score": 65, "rank": ""}, "s8": {"score": 46, "rank": ""}, "s9": {"score": 54, "rank": ""}, "s12": {"score": 49, "rank": ""}, "s13": {"score": 51, "rank": ""}}, "c6": {"s3": {"score": 77, "rank": ""}, "s6": {"score": 68, "rank": ""}, "s7": {"score": 46, "rank": ""}, "s8": {"score": 33, "rank": ""}, "s9": {"score": 73, "rank": ""}, "s12": {"score": 33, "rank": ""}, "s13": {"score": 62, "rank": ""}}}}, "fee": null},
{"meta": {"id": "import_guoer_ziran_114", "name": "國二自然", "subject": "自然", "grade": "國二", "hasFee": false, "subjects": [], "archived": false, "students": [{"id": "s1", "name": "廖翊愷", "school": "", "isTrial": false}, {"id": "s2", "name": "吳瑞芯", "school": "", "isTrial": false}, {"id": "s3", "name": "魏筵庭", "school": "", "isTrial": false}, {"id": "s4", "name": "楊采霓", "school": "", "isTrial": false}, {"id": "s5", "name": "簡銘劭", "school": "", "isTrial": false}, {"id": "s6", "name": "王芊云", "school": "", "isTrial": false}, {"id": "s7", "name": "凃卉嬣", "school": "", "isTrial": false}, {"id": "s8", "name": "黃羿璇", "school": "", "isTrial": false}, {"id": "s9", "name": "葉恩呈", "school": "", "isTrial": false}, {"id": "s10", "name": "萬承叡", "school": "", "isTrial": false}, {"id": "s11", "name": "王奕惟", "school": "", "isTrial": false}, {"id": "s12", "name": "王侑謙", "school": "", "isTrial": false}], "scheduleRules": [{"id": "r3", "dayOfWeek": 3, "interval": 1, "anchorDate": "", "effectiveFrom": "2026-07-01", "effectiveTo": null, "startTime": ""}, {"id": "r6", "dayOfWeek": 6, "interval": 1, "anchorDate": "", "effectiveFrom": "2026-07-01", "effectiveTo": null, "startTime": ""}], "overrides": []}, "attendance": {"2026-07-01": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "曠課", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "請假", "s12": "出席"}}, "2026-07-04": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "請假", "s6": "出席", "s7": "曠課", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "曠課"}}, "2026-07-08": {"note": "", "content": "", "records": {"s1": "請假", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "請假", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席"}}, "2026-07-11": {"note": "", "content": "巴威颱風", "records": {"s1": "延課", "s2": "延課", "s3": "延課", "s4": "延課", "s5": "延課", "s6": "延課", "s7": "延課", "s8": "延課", "s9": "延課", "s10": "延課", "s11": "延課", "s12": "延課"}}, "2026-07-15": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席"}}, "2026-07-18": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "請假", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "請假"}}, "2026-07-22": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席"}}}, "quiz": {"columns": [], "scores": {}}, "exam": {"columns": [], "scores": {}}, "fee": null},
{"meta": {"id": "import_guoer_shuxue_114", "name": "國二數學", "subject": "數學", "grade": "國二", "hasFee": false, "subjects": [], "archived": false, "students": [{"id": "s1", "name": "萬承叡", "school": "港明", "isTrial": false}, {"id": "s2", "name": "鄭煜承", "school": "安南", "isTrial": false}, {"id": "s3", "name": "王侑謙", "school": "安南", "isTrial": false}, {"id": "s4", "name": "王芊云", "school": "安南", "isTrial": false}, {"id": "s5", "name": "葉恩呈", "school": "德光", "isTrial": false}, {"id": "s6", "name": "簡銘劭", "school": "安南", "isTrial": false}, {"id": "s7", "name": "王奕惟", "school": "安南", "isTrial": false}, {"id": "s8", "name": "黃羿璇", "school": "安南", "isTrial": false}, {"id": "s9", "name": "凃卉嬣", "school": "安南", "isTrial": false}, {"id": "s10", "name": "沈政文", "school": "安南", "isTrial": false}, {"id": "s11", "name": "潘睿翊", "school": "安南", "isTrial": false}, {"id": "s12", "name": "吳孟翰", "school": "安南", "isTrial": false}, {"id": "s13", "name": "黃中彥", "school": "瀛海", "isTrial": false}], "scheduleRules": [{"id": "r2", "dayOfWeek": 2, "interval": 1, "anchorDate": "", "effectiveFrom": "2025-07-01", "effectiveTo": null, "startTime": ""}, {"id": "r5", "dayOfWeek": 5, "interval": 1, "anchorDate": "", "effectiveFrom": "2025-07-01", "effectiveTo": null, "startTime": ""}], "overrides": []}, "attendance": {"2025-07-01": {"note": "", "content": "p24EX13", "records": {"s1": "出席", "s2": "出席", "s3": "試聽", "s4": "出席", "s5": "請假"}}, "2025-07-04": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席"}}, "2025-07-08": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "請假", "s6": "出席", "s7": "出席"}}, "2025-07-11": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "請假"}}, "2025-07-15": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "請假"}}, "2025-07-18": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "遲到", "s6": "請假", "s7": "請假"}}, "2025-07-22": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席"}}, "2025-07-25": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席"}}, "2025-07-29": {"note": "", "content": "", "records": {"s1": "停課", "s2": "停課", "s3": "停課", "s4": "停課", "s5": "停課", "s6": "停課", "s7": "停課"}}, "2025-08-01": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席"}}, "2025-08-05": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席"}}, "2025-08-08": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "請假", "s6": "出席", "s7": "出席"}}, "2025-08-12": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席"}}, "2025-08-15": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "請假", "s5": "出席", "s6": "出席", "s7": "出席"}}, "2025-08-19": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席"}}, "2025-08-22": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "請假", "s7": "出席"}}, "2025-08-26": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "請假", "s6": "出席", "s7": "出席"}}, "2025-08-29": {"note": "", "content": "補7/29", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席"}}, "2025-09-02": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "試聽"}}, "2025-09-05": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "試聽"}}, "2025-09-09": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "早退", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s11": "試聽"}}, "2025-09-12": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s11": "試聽"}}, "2025-09-16": {"note": "", "content": "檢討CH1, P73.eq.9", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席"}}, "2025-09-19": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席"}}, "2025-09-23": {"note": "", "content": "複1-1, P79.eq.18", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席"}}, "2025-09-26": {"note": "", "content": "複1-2, P81.eq.21", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "請假", "s9": "出席", "s10": "出席"}}, "2025-09-30": {"note": "", "content": "複1-3", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席"}}, "2025-10-03": {"note": "", "content": "複1-4", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席"}}, "2025-10-07": {"note": "", "content": "複全", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席"}}, "2025-10-10": {"note": "", "content": "複全", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "請假", "s8": "出席", "s9": "請假", "s10": "出席"}}, "2025-10-14": {"note": "", "content": "複全", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "請假", "s8": "遲到", "s9": "出席", "s10": "出席"}}, "2025-10-17": {"note": "", "content": "p83.eq.27,HWp75.76", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "請假", "s8": "出席", "s9": "出席", "s10": "出席"}}, "2025-10-21": {"note": "", "content": "p88.eq.2, HWp84.85", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席"}}, "2025-10-24": {"note": "", "content": "", "records": {"s1": "假期", "s2": "假期", "s3": "假期", "s4": "假期", "s5": "假期", "s6": "假期", "s7": "假期", "s8": "假期", "s9": "假期", "s10": "假期"}}, "2025-10-28": {"note": "", "content": "p91.eq.9, HWp92.93", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席"}}, "2025-10-31": {"note": "", "content": "p98.eq.18, HWp94.95", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "曠課", "s9": "出席", "s10": "出席"}}, "2025-11-04": {"note": "", "content": "p106.eq.5, HWp101.102", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "試聽"}}, "2025-11-07": {"note": "", "content": "p117, HWp106.117", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席"}}, "2025-11-11": {"note": "", "content": "p127, HWp118.127", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2025-11-14": {"note": "", "content": "2-3, p76立, HW128.131", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2025-11-18": {"note": "", "content": "p85, HW全", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "請假", "s13": "出席"}}, "2025-11-21": {"note": "", "content": "複習", "records": {"s1": "遲到", "s2": "出席", "s3": "遲到", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2025-11-25": {"note": "", "content": "複習", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2025-11-28": {"note": "", "content": "複習", "records": {"s1": "出席", "s2": "出席", "s3": "遲到", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2025-12-02": {"note": "", "content": "檢討考卷, 自修", "records": {"s1": "出席", "s2": "出席", "s3": "遲到", "s4": "出席", "s5": "出席", "s6": "請假", "s7": "出席", "s8": "出席", "s9": "請假", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2025-12-05": {"note": "", "content": "p141.eq.12, HW137.141", "records": {"s1": "遲到", "s2": "出席", "s3": "遲到", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "遲到", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "請假"}}, "2025-12-09": {"note": "", "content": "p151.eq.12, HW142.151", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "遲到", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2025-12-12": {"note": "", "content": "p163.eq.4, HW152.163", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "曠課", "s10": "遲到", "s12": "出席", "s13": "出席"}}, "2025-12-16": {"note": "", "content": "p170.eq.13, HW164.170", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2025-12-19": {"note": "", "content": "p179.eq.10, HW173.179", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2025-12-23": {"note": "", "content": "p186.eq.9, HW179.186", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2025-12-26": {"note": "", "content": "p189.eq.16, HW186.189", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2025-12-30": {"note": "", "content": "第一冊完, 2-4~3-1", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-01-02": {"note": "", "content": "~3-1(2), T2-4", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-01-06": {"note": "", "content": "~3-1, T3-1", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "遲到", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-01-09": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "遲到", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "請假", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-01-13": {"note": "", "content": "", "records": {"s1": "請假", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-01-16": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "曠課", "s10": "遲到", "s12": "出席", "s13": "出席"}}, "2026-01-20": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "請假", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席"}}, "2026-01-23": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "遲到", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "請假", "s10": "出席", "s12": "請假", "s13": "出席"}}, "2026-01-27": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "請假", "s13": "出席"}}, "2026-01-30": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "請假", "s10": "遲到", "s12": "出席", "s13": "出席"}}, "2026-02-03": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "遲到", "s12": "出席", "s13": "曠課"}}, "2026-02-06": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "遲到", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "請假", "s8": "出席", "s9": "遲到", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-02-10": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "遲到", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "遲到", "s12": "出席", "s13": "出席"}}, "2026-02-13": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "曠課", "s9": "曠課", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-02-17": {"note": "", "content": "", "records": {"s1": "假期", "s2": "假期", "s3": "假期", "s4": "假期", "s5": "假期", "s6": "假期", "s7": "假期", "s8": "假期", "s9": "假期", "s10": "假期", "s11": "假期", "s12": "假期", "s13": "假期"}}, "2026-02-20": {"note": "", "content": "", "records": {"s1": "假期", "s2": "假期", "s3": "假期", "s4": "假期", "s5": "假期", "s6": "假期", "s7": "假期", "s8": "假期", "s9": "假期", "s10": "假期", "s11": "假期", "s12": "假期", "s13": "假期"}}, "2026-02-24": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-02-27": {"note": "", "content": "", "records": {"s1": "出席", "s2": "請假", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "遲到", "s12": "出席", "s13": "請假"}}, "2026-03-03": {"note": "", "content": "", "records": {"s1": "請假", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-03-06": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-03-10": {"note": "", "content": "https://youtu.be/gZwNm0cnvwk", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "請假"}}, "2026-03-13": {"note": "", "content": "p43", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "請假"}}, "2026-03-17": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-03-20": {"note": "", "content": "", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s11": "出席", "s12": "出席", "s13": "出席"}}, "2026-03-24": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "遲到"}}, "2026-03-27": {"note": "", "content": "", "records": {"s1": "遲到", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "請假", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "遲到"}}, "2026-03-31": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "請假", "s7": "出席", "s8": "出席", "s9": "曠課", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-04-03": {"note": "", "content": "", "records": {"s1": "假期", "s2": "假期", "s3": "假期", "s4": "假期", "s5": "假期", "s6": "假期", "s7": "假期", "s8": "假期", "s9": "假期", "s10": "假期", "s11": "假期", "s12": "假期", "s13": "假期"}}, "2026-04-07": {"note": "", "content": "", "records": {"s1": "遲到", "s2": "出席", "s3": "遲到", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-04-10": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-04-14": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "請假"}}, "2026-04-17": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-04-21": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-04-24": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-04-28": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-05-01": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "請假", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-05-05": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-05-08": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "出席", "s13": "出席"}}, "2026-05-12": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "請假", "s7": "出席", "s8": "出席", "s9": "出席", "s10": "出席", "s12": "遲到", "s13": "出席"}}, "2026-05-15": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "曠課", "s10": "遲到", "s12": "出席", "s13": "出席"}}, "2026-05-19": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-05-22": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-05-26": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-05-29": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "曠課", "s12": "出席", "s13": "請假"}}, "2026-06-02": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-06-05": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-06-09": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "請假", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-06-12": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-06-16": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-06-19": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-06-23": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-06-26": {"note": "", "content": "豪雨停課", "records": {"s1": "延課", "s2": "延課", "s3": "延課", "s4": "延課", "s5": "延課", "s6": "延課", "s7": "延課", "s8": "延課", "s9": "延課", "s10": "延課", "s11": "延課", "s12": "延課", "s13": "延課"}}, "2026-06-30": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "曠課", "s12": "出席", "s13": "出席"}}, "2026-07-03": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "曠課", "s12": "出席", "s13": "出席"}}, "2026-07-07": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "請假", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "請假", "s13": "出席"}}, "2026-07-10": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-07-14": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-07-17": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-07-21": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}, "2026-07-24": {"note": "", "content": "", "records": {"s1": "出席", "s2": "出席", "s3": "出席", "s4": "出席", "s5": "出席", "s6": "出席", "s7": "出席", "s8": "出席", "s9": "出席", "s12": "出席", "s13": "出席"}}}, "quiz": {"columns": [], "scores": {}}, "exam": {"columns": [{"id": "c1", "name": "一上一段", "date": "", "subject": "", "segment": ""}, {"id": "c2", "name": "一上二段", "date": "", "subject": "", "segment": ""}, {"id": "c3", "name": "一上三段", "date": "", "subject": "", "segment": ""}, {"id": "c4", "name": "一下一段", "date": "", "subject": "", "segment": ""}, {"id": "c5", "name": "一下二段", "date": "", "subject": "", "segment": ""}, {"id": "c6", "name": "一下三段", "date": "", "subject": "", "segment": ""}], "scores": {"c1": {"s1": {"score": 85, "rank": "21/235"}, "s2": {"score": 91, "rank": "8/80"}, "s3": {"score": 74, "rank": "16/244"}, "s4": {"score": 94, "rank": "4/50?"}, "s5": {"score": 71, "rank": "37/"}, "s6": {"score": 97, "rank": "1/2"}, "s7": {"score": 89, "rank": "5/84"}, "s8": {"score": 84, "rank": ""}, "s9": {"score": 65, "rank": "13/170"}, "s10": {"score": 70, "rank": "19/244"}, "s12": {"score": 37, "rank": ""}, "s13": {"score": 53, "rank": ""}}, "c2": {"s1": {"score": 80, "rank": "23/271"}, "s2": {"score": 79, "rank": "8/85"}, "s3": {"score": 62, "rank": "17/249"}, "s4": {"score": 87, "rank": "7/91"}, "s5": {"score": 65, "rank": ""}, "s6": {"score": 95, "rank": "1/1"}, "s7": {"score": 85, "rank": "3/20"}, "s8": {"score": 65, "rank": ""}, "s9": {"score": 59, "rank": "13/166"}, "s10": {"score": 61, "rank": ""}, "s12": {"score": 60, "rank": "14/260"}, "s13": {"score": 88, "rank": "9/68"}}, "c3": {"s1": {"score": 58, "rank": ""}, "s2": {"score": 80, "rank": ""}, "s3": {"score": 74, "rank": "13/198"}, "s4": {"score": 78, "rank": ""}, "s5": {"score": 54, "rank": ""}, "s6": {"score": 85, "rank": "1/8"}, "s7": {"score": 89, "rank": "1/9"}, "s8": {"score": 49, "rank": ""}, "s9": {"score": 57, "rank": ""}, "s10": {"score": 52, "rank": ""}, "s12": {"score": 44, "rank": ""}, "s13": {"score": 80, "rank": ""}}, "c4": {"s1": {"score": 57, "rank": "25/271"}, "s2": {"score": 89, "rank": "7/76"}, "s3": {"score": 83, "rank": "14/242"}, "s4": {"score": 98, "rank": "8/104"}, "s5": {"score": 45, "rank": "32/"}, "s6": {"score": 100, "rank": "1/3"}, "s7": {"score": 100, "rank": "3/27"}, "s8": {"score": 69, "rank": ""}, "s9": {"score": 92, "rank": "10/120"}, "s10": {"score": 57, "rank": "12/280"}, "s12": {"score": 26, "rank": "15/300"}, "s13": {"score": 67, "rank": "9/82"}}, "c5": {"s1": {"score": 93, "rank": ""}, "s2": {"score": 69, "rank": ""}, "s3": {"score": 51, "rank": ""}, "s4": {"score": 74, "rank": ""}, "s5": {"score": 50, "rank": ""}, "s6": {"score": 100, "rank": ""}, "s7": {"score": 93, "rank": ""}, "s8": {"score": 45, "rank": ""}, "s9": {"score": 61, "rank": ""}, "s10": {"score": 39, "rank": ""}, "s12": {"score": 28, "rank": ""}, "s13": {"score": 74, "rank": ""}}, "c6": {"s1": {"score": 61, "rank": ""}, "s2": {"score": 85, "rank": ""}, "s3": {"score": 61, "rank": ""}, "s4": {"score": 92, "rank": ""}, "s5": {"score": 61, "rank": ""}, "s6": {"score": 97, "rank": ""}, "s7": {"score": 95, "rank": ""}, "s8": {"score": 63, "rank": ""}, "s9": {"score": 69, "rank": ""}, "s12": {"score": 61, "rank": ""}, "s13": {"score": 80, "rank": ""}}}}, "fee": null}

];

async function seedAllImportClasses(classes, addClass) {
  const existingIds = new Set(classes.map((c) => c.id));
  const todo = IMPORT_DEFS.filter((d) => !existingIds.has(d.meta.id));
  if (todo.length === 0) {
    return "5 個班級都已經匯入過了，直接在班級列表找它們就可以。";
  }
  for (const def of todo) {
    await saveKey(`attendance:${def.meta.id}`, def.attendance);
    await saveKey(`quiz:${def.meta.id}`, def.quiz);
    await saveKey(`exam:${def.meta.id}`, def.exam);
    if (def.fee) await saveKey(`fee:${def.meta.id}`, def.fee);
    const derivedOverrides = deriveWholeDayOverrides(def.attendance);
    const overrides = [...(def.meta.overrides || [])];
    derivedOverrides.forEach((o) => { if (!overrides.some((e) => e.date === o.date)) overrides.push(o); });
    addClass({ ...def.meta, overrides });
  }
  return `已匯入 ${todo.length} 個班級！有一份試算表的平時考／段考分頁殘留舊班級的資料，已自動略過未匯入，建議進入各班確認一遍。`;
}
/* Any historical date where someone's status is 延課/假期 gets treated
   as a whole-class cancellation automatically. 停課 is different — it
   means that ONE student stopped attending, not that the class didn't
   run — so it's deliberately excluded here. */
function deriveWholeDayOverrides(attendance) {
  const overrides = [];
  Object.entries(attendance || {}).forEach(([date, day]) => {
    const statuses = Object.values(day.records || {});
    const wholeDay = statuses.find((v) => v === "延課" || v === "假期");
    if (wholeDay) overrides.push({ date, action: "cancel", note: wholeDay, time: "" });
  });
  return overrides;
}

/* ------------------------------------------------------------------ */
/* App                                                                  */
/* ------------------------------------------------------------------ */

export default function App() {
  const [ready, setReady] = useState(false);
  const [classes, setClassesRaw] = useState([]);
  const [view, setView] = useState("today");
  const [selectedId, setSelectedId] = useState(null);
  const [selectedTab, setSelectedTab] = useState("attendance");
  const [jumpDate, setJumpDate] = useState(todayStr());
  const [showArchived, setShowArchived] = useState(false);
  const [toast, setToast] = useState(null);
  const [returnView, setReturnView] = useState("today");

  // Every write to `classes` goes through this so duplicate ids can never
  // accumulate, no matter what caused them.
  function setClasses(updater) {
    setClassesRaw((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      return dedupeById(next);
    });
  }

  useEffect(() => {
    (async () => {
      const idx = await loadKey("classIndex", []);
      setClasses(dedupeById(idx));
      setReady(true);
    })();
  }, []);

  const classIdxStatus = useDebouncedSave(classes, "classIndex", ready);

  function updateClass(id, updater) {
    setClasses((prev) => prev.map((c) => (c.id === id ? updater({ ...c }) : c)));
  }
  function addClass(newCls) {
    setClasses((prev) => (prev.some((c) => c.id === newCls.id) ? prev : [...prev, newCls]));
  }
  function deleteClass(id) {
    setClasses((prev) => prev.filter((c) => c.id !== id));
  }
  function importClasses(imported) {
    setClasses((prev) => {
      const map = new Map(prev.map((c) => [c.id, c]));
      imported.forEach((c) => map.set(c.id, c));
      return Array.from(map.values());
    });
  }
  function openClass(id, tab, date) {
    setReturnView(view);
    setSelectedId(id);
    setSelectedTab(tab || "attendance");
    if (date) setJumpDate(date);
    setView("detail");
  }
  function navigateClass(id, date) {
    setSelectedId(id);
    if (date) setJumpDate(date);
  }

  const knownSchools = Array.from(
    new Set(classes.flatMap((c) => (c.students || []).map((s) => s.school).filter(Boolean)))
  ).sort();

  const selectedClass = classes.find((c) => c.id === selectedId) || null;

  if (!ready) {
    return (
      <Shell>
        <div className="loading">載入中…</div>
      </Shell>
    );
  }

  return (
    <Shell>
      <TopNav view={view} setView={setView} saveStatus={classIdxStatus} />
      <Toast message={toast} onClose={() => setToast(null)} />
      {view === "today" && (
        <TodayView classes={classes.filter((c) => !c.archived)} onOpenClass={openClass} />
      )}
      {view === "classes" && (
        <ClassesView
          classes={classes}
          showArchived={showArchived}
          setShowArchived={setShowArchived}
          onOpenClass={(id) => openClass(id, "attendance")}
          onAddClass={addClass}
          onArchive={(id, archived) => updateClass(id, (c) => ({ ...c, archived }))}
          onDelete={deleteClass}
          onToast={setToast}
          onImportClasses={importClasses}
        />
      )}
      {view === "detail" && selectedClass && (
        <ClassDetail
          cls={selectedClass}
          allClasses={classes.filter((c) => !c.archived)}
          onNavigateClass={navigateClass}
          tab={selectedTab}
          setTab={setSelectedTab}
          jumpDate={jumpDate}
          setJumpDate={setJumpDate}
          knownSchools={knownSchools}
          onBack={() => setView(returnView)}
          onUpdateClass={(updater) => updateClass(selectedClass.id, updater)}
          onArchive={(archived) => updateClass(selectedClass.id, (c) => ({ ...c, archived }))}
        />
      )}
      <style>{CSS}</style>
    </Shell>
  );
}

function Shell({ children }) {
  return <div className="shell">{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Top nav                                                              */
/* ------------------------------------------------------------------ */

function TopNav({ view, setView, saveStatus }) {
  return (
    <div className="topnav">
      <div className="brand">
        <span className="brand-mark">課</span>
        <span className="brand-text">教學紀錄</span>
      </div>
      <div className="nav-pills">
        <button className={"pill" + (view === "today" ? " pill-active" : "")} onClick={() => setView("today")}>日期</button>
        <button className={"pill" + (view !== "today" ? " pill-active" : "")} onClick={() => setView("classes")}>所有班級</button>
      </div>
      <SaveIndicator status={saveStatus} />
      <button className="pill logout-pill" onClick={() => signOut(auth)} title="登出">登出</button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Today (date/calendar) view                                          */
/* ------------------------------------------------------------------ */

function MonthCalendar({ selected, onSelect, classes, hasSession }) {
  const selDate = fromDateStr(selected);
  const [viewYear, setViewYear] = useState(selDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(selDate.getMonth());

  const startWeekday = new Date(viewYear, viewMonth, 1).getDay();
  const gridStart = new Date(viewYear, viewMonth, 1 - startWeekday);
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });

  function changeMonth(delta) {
    let m = viewMonth + delta;
    let y = viewYear;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setViewMonth(m);
    setViewYear(y);
  }

  const today = todayStr();

  return (
    <div className="calendar">
      <div className="calendar-header">
        <IconBtn title="上個月" onClick={() => changeMonth(-1)}><ChevronLeft size={18} /></IconBtn>
        <div className="calendar-title">{viewYear} 年 {viewMonth + 1} 月</div>
        <IconBtn title="下個月" onClick={() => changeMonth(1)}><ChevronRight size={18} /></IconBtn>
      </div>
      <div className="calendar-weekdays">
        {WEEKDAY_FULL.map((w) => <div key={w} className="calendar-wd">{w}</div>)}
      </div>
      <div className="calendar-grid">
        {cells.map((d, i) => {
          const ds = toDateStr(d);
          const inMonth = d.getMonth() === viewMonth;
          const dayClasses = classes.filter((c) => hasSession(c, ds));
          const isToday = ds === today;
          const isSelected = ds === selected;
          return (
            <button
              key={i}
              className={"calendar-cell" + (inMonth ? "" : " calendar-cell-out") + (isSelected ? " calendar-cell-selected" : "") + (isToday ? " calendar-cell-today" : "")}
              onClick={() => onSelect(ds)}
            >
              <span className="calendar-cell-num">{d.getDate()}</span>
              <span className="calendar-cell-dots">
                {dayClasses.slice(0, 4).map((c) => <span key={c.id} className="dot" style={{ background: colorForClass(c.id) }} />)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TodayView({ classes, onOpenClass }) {
  const [selected, setSelected] = useState(todayStr());
  const [attendanceMap, setAttendanceMap] = useState({});
  const classIdsKey = classes.map((c) => c.id).join(",");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        classes.map(async (c) => [c.id, await loadKey(`attendance:${c.id}`, {})])
      );
      if (!cancelled) setAttendanceMap(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classIdsKey]);

  /* Delegates to the same isSessionDay() used by the attendance-tab nav,
     just supplying this class's loaded attendance blob. */
  function hasSession(cls, dateStr) {
    return isSessionDay(cls, dateStr, attendanceMap[cls.id]);
  }

  const matches = classes
    .filter((c) => hasSession(c, selected))
    .map((c) => ({ c, time: getSessionInfo(c, selected).time }))
    .sort((a, b) => parseTimeMinutes(a.time) - parseTimeMinutes(b.time));

  return (
    <div className="view-pad">
      <MonthCalendar selected={selected} onSelect={setSelected} classes={classes} hasSession={hasSession} />

      <div className="section-label">{formatDisplay(selected)} 上課班級</div>
      {matches.length === 0 && <div className="empty-note">這天沒有排定的課。</div>}
      <div className="card-list">
        {matches.map(({ c, time }) => (
          <button key={c.id} className="class-card" onClick={() => onOpenClass(c.id, "attendance", selected)}>
            <div className="class-card-dot" style={{ background: colorForClass(c.id) }} />
            <div className="class-card-body">
              <div className="class-card-title">{c.name}</div>
              <div className="class-card-sub">{c.subject}{c.grade ? ` · ${c.grade}` : ""} · {c.students.length} 位學生</div>
            </div>
            {time && <div className="class-card-time"><Clock size={13} /> {time}</div>}
            <ChevronRight size={18} color="#9AA0A6" />
          </button>
        ))}
      </div>

      {classes.length === 0 && <div className="empty-state">還沒有任何班級。到「所有班級」新增第一個班級吧。</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Classes list / management view                                      */
/* ------------------------------------------------------------------ */

function ClassesView({ classes, showArchived, setShowArchived, onOpenClass, onAddClass, onArchive, onDelete, onToast, onImportClasses }) {
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [lastBackupAt, setLastBackupAt] = useState(undefined); // undefined = still loading
  const fileInputRef = useRef(null);

  useEffect(() => {
    (async () => {
      const v = await loadKey("lastBackupAt", null);
      setLastBackupAt(v);
    })();
  }, []);

  const daysSinceBackup = lastBackupAt ? Math.floor((Date.now() - new Date(lastBackupAt).getTime()) / 86400000) : null;
  const backupOverdue = lastBackupAt !== undefined && (lastBackupAt === null || daysSinceBackup >= 7);
  const list = classes
    .filter((c) => !!c.archived === showArchived)
    .map((c) => ({ c, next: nextSessionInfo(c, todayStr()) }))
    .sort((a, b) => {
      if (a.next.daysUntil !== b.next.daysUntil) return a.next.daysUntil - b.next.daysUntil;
      return parseTimeMinutes(a.next.startTime) - parseTimeMinutes(b.next.startTime);
    })
    .map((x) => x.c);
  const allDemoImported = IMPORT_DEFS.every((d) => classes.some((c) => c.id === d.meta.id));

  async function handleImport() {
    if (importing) return;
    setImporting(true);
    const msg = await seedAllImportClasses(classes, onAddClass);
    setImporting(false);
    onToast(msg);
  }

  async function handleExport() {
    setExporting(true);
    try {
      const records = {};
      for (const c of classes) {
        records[c.id] = {
          attendance: await loadKey(`attendance:${c.id}`, {}),
          quiz: await loadKey(`quiz:${c.id}`, { columns: [], scores: {} }),
          exam: await loadKey(`exam:${c.id}`, { columns: [], scores: {} }),
          fee: c.hasFee ? await loadKey(`fee:${c.id}`, { charges: [] }) : null,
        };
      }
      const bundle = { exportedAt: new Date().toISOString(), classIndex: classes, records };
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `教學紀錄備份_${todayStr()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      const nowIso = new Date().toISOString();
      await saveKey("lastBackupAt", nowIso);
      setLastBackupAt(nowIso);
      onToast("備份檔案已下載。");
    } catch (e) {
      onToast("匯出失敗，請再試一次。");
    }
    setExporting(false);
  }

  async function importBundleText(text) {
    try {
      const bundle = JSON.parse(text);
      if (!bundle || !Array.isArray(bundle.classIndex) || !bundle.records) {
        onToast("備份內容格式不正確。");
        return;
      }
      for (const c of bundle.classIndex) {
        const rec = bundle.records[c.id];
        if (!rec) continue;
        if (rec.attendance) await saveKey(`attendance:${c.id}`, rec.attendance);
        if (rec.quiz) await saveKey(`quiz:${c.id}`, rec.quiz);
        if (rec.exam) await saveKey(`exam:${c.id}`, rec.exam);
        if (rec.fee) await saveKey(`fee:${c.id}`, rec.fee);
      }
      onImportClasses(bundle.classIndex);
      onToast(`已從備份還原 ${bundle.classIndex.length} 個班級的資料。`);
      return true;
    } catch (e) {
      onToast("讀取備份內容失敗，請確認格式沒有被截斷或修改過。");
      return false;
    }
  }
  async function handleImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      await importBundleText(text);
    } catch (e) {
      onToast("讀取備份檔案失敗，手機瀏覽器有時候選檔會失敗，可以試試看下面「貼上備份內容」的方式。");
    }
  }

  return (
    <div className="view-pad">
      {backupOverdue && (
        <div className="backup-warning">
          <span>
            {lastBackupAt === null ? "還沒有備份過資料。" : `已經 ${daysSinceBackup} 天沒有備份資料了。`}
            建議定期匯出，避免資料遺失。
          </span>
          <button className="btn-primary btn-sm" onClick={() => setBackupOpen(true)}>立即備份</button>
        </div>
      )}
      <div className="row-between">
        <div className="nav-pills nav-pills-sub">
          <button className={"pill pill-sm" + (!showArchived ? " pill-active" : "")} onClick={() => setShowArchived(false)}>進行中</button>
          <button className={"pill pill-sm" + (showArchived ? " pill-active" : "")} onClick={() => setShowArchived(true)}>已封存</button>
        </div>
        <div className="row-actions">
          {!allDemoImported && !showArchived && (
            <button className="btn-ghost btn-sm" disabled={importing} onClick={handleImport}>
              {importing ? "匯入中…" : "匯入示範資料：5 個班級"}
            </button>
          )}
          <button className={"btn-ghost btn-sm" + (backupOverdue ? " btn-ghost-warning" : "")} onClick={() => setBackupOpen((v) => !v)}>資料備份{backupOverdue ? " ⚠" : ""}</button>
          {!showArchived && (
            <button className="btn-primary btn-sm" onClick={() => setCreating(true)}><Plus size={16} /> 新增班級</button>
          )}
        </div>
      </div>

      {backupOpen && (
        <div className="form-card">
          <div className="form-title">資料備份</div>
          <div className="section-hint" style={{ marginBottom: 10 }}>建議定期匯出備份檔存到自己的裝置，避免資料遺失。匯入備份會用檔案內容覆蓋同 ID 的班級，其他班級不受影響。</div>
          <div className="row-actions">
            <button className="btn-primary btn-sm" disabled={exporting} onClick={handleExport}>{exporting ? "匯出中…" : "匯出全部資料"}</button>
            <button className="btn-ghost btn-sm" onClick={() => fileInputRef.current && fileInputRef.current.click()}>選擇備份檔案</button>
            <input ref={fileInputRef} type="file" accept="application/json" style={{ display: "none" }} onChange={handleImportFile} />
          </div>
          <PasteImport onImport={importBundleText} />
        </div>
      )}


      {creating && (
        <NewClassForm onCancel={() => setCreating(false)} onCreate={(cls) => { onAddClass(cls); setCreating(false); }} />
      )}

      <div className="card-list" style={{ marginTop: 12 }}>
        {list.map((c) => (
          <div key={c.id} className="class-card class-card-static">
            <div className="class-card-dot" style={{ background: colorForClass(c.id) }} />
            <button className="class-card-body class-card-clickable" onClick={() => onOpenClass(c.id)}>
              <div className="class-card-title">{c.name}</div>
              <div className="class-card-sub">{c.subject}{c.grade ? ` · ${c.grade}` : ""} · {c.students.length} 位學生 · {scheduleSummary(c)}</div>
            </button>
            <div className="row-actions">
              <IconBtn title={showArchived ? "還原" : "封存"} onClick={() => onArchive(c.id, !showArchived)}>
                {showArchived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
              </IconBtn>
              {showArchived && (
                <ConfirmDelete title="永久刪除" label={`確定永久刪除「${c.name}」？`} onConfirm={() => onDelete(c.id)} />
              )}
            </div>
          </div>
        ))}
        {list.length === 0 && <div className="empty-note">{showArchived ? "沒有已封存的班級。" : "還沒有進行中的班級。"}</div>}
      </div>
    </div>
  );
}

/* Fallback for importing a backup when the OS file picker doesn't
   behave inside a mobile in-app browser: paste the raw JSON text
   instead of picking a file. */
function PasteImport({ onImport }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await onImport(text);
    setBusy(false);
    if (ok) { setText(""); setOpen(false); }
  }

  if (!open) {
    return <button className="btn-ghost btn-xs" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>選檔案沒反應？改成貼上備份內容</button>;
  }
  return (
    <div style={{ marginTop: 10 }}>
      <div className="section-hint" style={{ marginBottom: 6 }}>用文字編輯器打開備份 .json 檔案，全選複製內容，貼在下面：</div>
      <textarea className="journal-textarea" style={{ width: "100%", minHeight: 100 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="貼上備份 JSON 內容…" />
      <div className="form-actions">
        <button className="btn-ghost" onClick={() => { setOpen(false); setText(""); }}>取消</button>
        <button className="btn-primary" disabled={busy} onClick={submit}>{busy ? "匯入中…" : "匯入這段內容"}</button>
      </div>
    </div>
  );
}

function NewClassForm({ onCancel, onCreate }) {
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [grade, setGrade] = useState("");
  const [hasFee, setHasFee] = useState(false);
  const [subjectsText, setSubjectsText] = useState("");

  function submit() {
    if (!name.trim()) return;
    const subjects = subjectsText.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    onCreate({
      id: genId(), name: name.trim(), subject: subject.trim(), grade: grade.trim(), hasFee, subjects,
      archived: false, students: [], scheduleRules: [], overrides: [],
    });
  }

  return (
    <div className="form-card">
      <div className="form-title">新增班級</div>
      <div className="form-grid">
        <label className="field"><span>班級名稱</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="例：高一物化" /></label>
        <label className="field"><span>科目</span><input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="例：物理化學" /></label>
        <label className="field"><span>年級</span><input value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="例：高一" /></label>
        <label className="field"><span>分科目（選填，逗號分隔，例：物理,化學）</span><input value={subjectsText} onChange={(e) => setSubjectsText(e.target.value)} placeholder="留空表示不分科" /></label>
        <label className="field field-checkbox">
          <input type="checkbox" checked={hasFee} onChange={(e) => setHasFee(e.target.checked)} />
          <span>需要記錄收費（自行收費班級）</span>
        </label>
      </div>
      <div className="form-actions">
        <button className="btn-ghost" onClick={onCancel}>取消</button>
        <button className="btn-primary" onClick={submit}>建立班級</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Class detail                                                        */
/* ------------------------------------------------------------------ */

function ClassDetail({ cls, allClasses, onNavigateClass, tab, setTab, jumpDate, setJumpDate, knownSchools, onBack, onUpdateClass, onArchive }) {
  const tabs = [
    { id: "attendance", label: "出缺勤", icon: ClipboardList },
    { id: "quiz", label: "平時考", icon: CircleDot },
    { id: "exam", label: "段考", icon: GraduationCap },
    ...(cls.hasFee ? [{ id: "fee", label: "收費", icon: Wallet }] : []),
    { id: "roster", label: "學生與課表", icon: Settings2 },
  ];

  const prevAdj = getAdjacentClass(cls, allClasses, -1, jumpDate);
  const nextAdj = getAdjacentClass(cls, allClasses, 1, jumpDate);

  function goAdjacent(adj) {
    if (!adj) return;
    onNavigateClass(adj.cls.id, adj.date);
  }

  return (
    <div className="view-pad">
      <div className="detail-header">
        <IconBtn onClick={onBack} title="返回"><ArrowLeft size={18} /></IconBtn>
        <IconBtn onClick={() => goAdjacent(prevAdj)} disabled={!prevAdj} title={prevAdj ? `上一個上課班級：${prevAdj.cls.name}` : "沒有其他班級"}><ChevronLeft size={18} /></IconBtn>
        <div className="detail-title-wrap">
          <div className="detail-title">{cls.name}</div>
          <div className="detail-sub">{cls.subject}{cls.grade ? ` · ${cls.grade}` : ""} · {scheduleSummary(cls)}</div>
        </div>
        <IconBtn onClick={() => goAdjacent(nextAdj)} disabled={!nextAdj} title={nextAdj ? `下一個上課班級：${nextAdj.cls.name}` : "沒有其他班級"}><ChevronRight size={18} /></IconBtn>
        <IconBtn title={cls.archived ? "取消封存" : "封存班級"} onClick={() => onArchive(!cls.archived)}>
          {cls.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
        </IconBtn>
      </div>

      <div className="tabbar">
        {tabs.map((t) => (
          <button key={t.id} className={"tab" + (tab === t.id ? " tab-active" : "")} onClick={() => setTab(t.id)}>
            <t.icon size={15} />{t.label}
          </button>
        ))}
      </div>

      <div style={{ display: tab === "attendance" ? "block" : "none" }}>
        <AttendanceTab key={cls.id + ":attendance"} cls={cls} date={jumpDate} setDate={setJumpDate} onUpdateClass={onUpdateClass} />
      </div>
      <div style={{ display: tab === "quiz" ? "block" : "none" }}>
        <AssessmentTab key={cls.id + ":quiz"} cls={cls} storageKeyName={`quiz:${cls.id}`} unitLabel="平時考" withSegment withRank={false} />
      </div>
      <div style={{ display: tab === "exam" ? "block" : "none" }}>
        <AssessmentTab key={cls.id + ":exam"} cls={cls} storageKeyName={`exam:${cls.id}`} unitLabel="段考" withSegment={false} withRank />
      </div>
      {cls.hasFee && (
        <div style={{ display: tab === "fee" ? "block" : "none" }}>
          <FeeTab key={cls.id + ":fee"} cls={cls} />
        </div>
      )}
      <div style={{ display: tab === "roster" ? "block" : "none" }}>
        <RosterTab key={cls.id + ":roster"} cls={cls} knownSchools={knownSchools} onUpdateClass={onUpdateClass} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Attendance tab                                                       */
/* ------------------------------------------------------------------ */

function AttendanceTab({ cls, date, setDate, onUpdateClass }) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addTime, setAddTime] = useState("");
  const [viewMode, setViewMode] = useState("single");
  const storageKeyName = `attendance:${cls.id}`;
  const [data, setData, ready] = useCachedStore(storageKeyName, {});

  const status = useDebouncedSave(data, storageKeyName, ready);

  const dayData = data[date] || { note: "", content: "", records: {} };
  const session = getSessionInfo(cls, date);
  const isSession = isSessionDay(cls, date, data);
  const boundary = earliestScheduledDate(cls, Object.keys(data).filter((k) => hasSessionRecord(data, k)));
  const atStart = !!(boundary && date <= boundary);

  function setDay(updater) {
    setData((prev) => ({ ...prev, [date]: updater({ note: "", content: "", records: {}, ...(prev[date] || {}) }) }));
  }
  function setStatusFor(studentId, value) {
    const wholeDayStatus = value === "延課" || value === "假期";
    if (wholeDayStatus) {
      setDay((d) => ({ ...d, records: Object.fromEntries(cls.students.map((s) => [s.id, value])) }));
      onUpdateClass((c) => {
        const overrides = (c.overrides || []).filter((o) => o.date !== date);
        overrides.push({ date, action: "cancel", note: value, time: "" });
        return { ...c, overrides };
      });
      return;
    }
    setDay((d) => ({ ...d, records: { ...d.records, [studentId]: value } }));
    // if this date was auto-cancelled by a whole-day status, clear that
    // override now that someone has a normal, real attendance status.
    onUpdateClass((c) => {
      const existing = (c.overrides || []).find((o) => o.date === date);
      if (existing && existing.action === "cancel" && (existing.note === "延課" || existing.note === "假期")) {
        return { ...c, overrides: c.overrides.filter((o) => o.date !== date) };
      }
      return c;
    });
  }
  function markStopped(studentId) {
    onUpdateClass((c) => ({ ...c, students: c.students.map((s) => (s.id === studentId ? { ...s, endDate: date } : s)) }));
  }
  function setNote(value) {
    setDay((d) => ({ ...d, note: value }));
  }
  function setContent(value) {
    setDay((d) => ({ ...d, content: value }));
  }
  function confirmCancel() {
    onUpdateClass((c) => {
      const overrides = (c.overrides || []).filter((o) => o.date !== date);
      overrides.push({ date, action: "cancel", note: cancelReason, time: "" });
      return { ...c, overrides };
    });
    setDay((d) => ({ ...d, note: cancelReason, records: Object.fromEntries(cls.students.map((s) => [s.id, "延課"])) }));
    setCancelOpen(false);
    setCancelReason("");
  }
  function confirmAdd() {
    onUpdateClass((c) => {
      const overrides = (c.overrides || []).filter((o) => o.date !== date);
      overrides.push({ date, action: "add", note: "", time: addTime });
      return { ...c, overrides };
    });
    setAddOpen(false);
    setAddTime("");
  }
  function goToNearestClassDay(direction) {
    setDate(findAdjacentClassDay(cls, date, direction, data));
  }

  return (
    <div>
      <div className="row-between">
        <div className="nav-pills nav-pills-sub">
          <button className={"pill pill-sm" + (viewMode === "single" ? " pill-active" : "")} onClick={() => setViewMode("single")}>單日紀錄</button>
          <button className={"pill pill-sm" + (viewMode === "overview" ? " pill-active" : "")} onClick={() => setViewMode("overview")}>總覽</button>
        </div>
        <SaveIndicator status={status} />
      </div>

      {viewMode === "overview" ? (
        <AttendanceOverview cls={cls} data={data} onJump={(d) => { setDate(d); setViewMode("single"); }} />
      ) : (
        <>
          <div className="date-nav" style={{ marginTop: 12 }}>
            <IconBtn onClick={() => goToNearestClassDay(-1)} title={atStart ? "已經是第一堂課" : "上一個上課日"} disabled={atStart}><ChevronLeft size={18} /></IconBtn>
            <div className="date-nav-label">
              <CalendarDays size={15} />
              {formatDisplay(date)}
              {session.time && <span className="date-nav-time"><Clock size={12} /> {session.time}</span>}
            </div>
            <IconBtn onClick={() => goToNearestClassDay(1)} title="下一個上課日"><ChevronRight size={18} /></IconBtn>
            <input type="date" className="date-nav-picker" value={date} onChange={(e) => setDate(e.target.value)} />
            {date !== todayStr() && <button className="btn-ghost btn-xs" onClick={() => setDate(todayStr())}>回到今天</button>}
          </div>

          <div className="row-between" style={{ marginTop: 10 }}>
            {isSession ? <span className="tag tag-good">{session.scheduled ? "排定上課日" : "有紀錄的上課日"}</span> : <span className="tag tag-muted">非排定上課日</span>}
            <div className="row-actions">
              {!cancelOpen && !addOpen && (
                session.scheduled ? (
                  <button className="btn-ghost btn-xs" onClick={() => setCancelOpen(true)}>取消本次上課</button>
                ) : (
                  <button className="btn-ghost btn-xs" onClick={() => setAddOpen(true)}>＋新增本次上課（補課）</button>
                )
              )}
            </div>
          </div>

          {cancelOpen && (
            <div className="inline-form">
              <input className="student-input" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="取消原因（例：颱風、學校活動）" autoFocus />
              <button className="btn-ghost btn-xs" onClick={() => { setCancelOpen(false); setCancelReason(""); }}>取消</button>
              <button className="btn-primary btn-sm" onClick={confirmCancel}>確定取消上課</button>
            </div>
          )}
          {addOpen && (
            <div className="inline-form">
              <input type="time" className="student-input" value={addTime} onChange={(e) => setAddTime(e.target.value)} placeholder="時間（選填）" />
              <button className="btn-ghost btn-xs" onClick={() => { setAddOpen(false); setAddTime(""); }}>取消</button>
              <button className="btn-primary btn-sm" onClick={confirmAdd}>確定新增本次上課</button>
            </div>
          )}

          <label className="field" style={{ marginTop: 10 }}>
            <span>教學日誌內容（這堂課教了什麼）</span>
            <textarea className="journal-textarea" value={dayData.content || ""} onChange={(e) => setContent(e.target.value)} placeholder="例：CH2 2-1～2-2、講義 p12-15…" rows={2} />
          </label>
          <label className="field" style={{ marginTop: 8 }}>
            <span>當日備註</span>
            <input value={dayData.note} onChange={(e) => setNote(e.target.value)} placeholder="例：颱風停課、教室異動…" />
          </label>

          {cls.students.length === 0 ? (
            <div className="empty-note">尚未新增學生，請至「學生與課表」分頁新增。</div>
          ) : (
            <div className="roll-list">
              {cls.students
                .filter((s) => {
                  const m = membershipAtDate(s, date, data);
                  return m === "trial" || m === "active" || dayData.records[s.id];
                })
                .map((s) => {
                const val = dayData.records[s.id] || "";
                const isTrial = membershipAtDate(s, date, data) === "trial";
                return (
                  <div key={s.id} className="roll-row">
                    <div className="roll-name">
                      <div>{s.name}{isTrial && <span className="trial-tag">試</span>}</div>
                      {s.school && <div className="roll-school">{s.school}</div>}
                    </div>
                    <div className="status-group">
                      {STATUS_LIST.map((st) => {
                        const active = val === st;
                        const style = STATUS_STYLE[st];
                        return (
                          <button
                            key={st}
                            className={"status-btn" + (active ? " status-btn-active" : "")}
                            style={active ? { background: style.bg, color: style.fg, borderColor: style.bd } : {}}
                            onClick={() => setStatusFor(s.id, active ? "" : st)}
                          >
                            {st}
                          </button>
                        );
                      })}
                    </div>
                    <ConfirmAction label={`確定將 ${s.name} 標記為停班？往後就不會再出現在出席表裡。`} confirmText="確定停班" onConfirm={() => markStopped(s.id)}><Archive size={14} /> 停班</ConfirmAction>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* Overview: a date x student grid (like the original spreadsheet) so
   absence/lateness patterns are visible at a glance, plus per-student
   attendance-rate stats. */
function AttendanceOverview({ cls, data, onJump }) {
  const dates = Object.keys(data).filter((d) => Object.keys(data[d].records || {}).length > 0).sort();

  const counts = {};
  cls.students.forEach((s) => { counts[s.id] = {}; });
  dates.forEach((d) => {
    Object.entries(data[d].records || {}).forEach(([sid, st]) => {
      if (!counts[sid]) counts[sid] = {};
      counts[sid][st] = (counts[sid][st] || 0) + 1;
    });
  });

  function rate(sid, st) {
    const c = counts[sid] || {};
    const total = RATE_STATUSES.reduce((sum, k) => sum + (c[k] || 0), 0);
    if (!total) return null;
    return Math.round(((c[st] || 0) / total) * 1000) / 10;
  }

  if (cls.students.length === 0) {
    return <div className="empty-note" style={{ marginTop: 12 }}>尚未新增學生，請至「學生與課表」分頁新增。</div>;
  }

  return (
    <div>
      <div className="stats-panel" style={{ marginTop: 12 }}>
        <div className="stats-table stats-table-scroll">
          <div className="stats-table-row-rate stats-table-head">
            <span>學生</span><span>出席率</span><span>請假率</span><span>曠課率</span><span>遲到率</span>
          </div>
          {cls.students.map((s) => (
            <div className="stats-table-row-rate" key={s.id}>
              <span>{s.name}</span>
              <span>{rate(s.id, "出席") ?? "—"}{rate(s.id, "出席") !== null ? "%" : ""}</span>
              <span>{rate(s.id, "請假") ?? "—"}{rate(s.id, "請假") !== null ? "%" : ""}</span>
              <span>{rate(s.id, "曠課") ?? "—"}{rate(s.id, "曠課") !== null ? "%" : ""}</span>
              <span>{rate(s.id, "遲到") ?? "—"}{rate(s.id, "遲到") !== null ? "%" : ""}</span>
            </div>
          ))}
        </div>
      </div>

      {dates.length === 0 ? (
        <div className="empty-note">還沒有任何出缺勤紀錄。</div>
      ) : (
        <div className="matrix-scroll">
          <table className="matrix">
            <thead>
              <tr>
                <th className="matrix-corner">日期</th>
                {cls.students.map((s) => <th key={s.id} className="matrix-col-head"><div className="matrix-col-name">{s.name}</div></th>)}
              </tr>
            </thead>
            <tbody>
              {dates.map((d) => (
                <tr key={d}>
                  <td className="matrix-row-head matrix-row-head-clickable" onClick={() => onJump(d)}>{d}</td>
                  {cls.students.map((s) => {
                    const st = (data[d].records || {})[s.id];
                    const style = st ? STATUS_STYLE[st] : null;
                    return (
                      <td key={s.id} className="matrix-cell">
                        {st ? <span className="status-chip" style={{ background: style ? style.bg : "#EEEEEC", color: style ? style.fg : "#71757A" }}>{style ? style.short : st.slice(0, 2)}</span> : ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Assessment tab (shared by 平時考 / 段考)                             */
/* ------------------------------------------------------------------ */

function AssessmentTab({ cls, storageKeyName, unitLabel, withSegment, withRank }) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDate, setNewDate] = useState(todayStr());
  const [newSubject, setNewSubject] = useState("");
  const [newSegment, setNewSegment] = useState("");
  const [subjectFilter, setSubjectFilter] = useState("all");
  const [segmentFilter, setSegmentFilter] = useState("all");
  const [focusStudentId, setFocusStudentId] = useState("");

  const hasSubjects = (cls.subjects || []).length > 0;

  const [data, setData, ready] = useCachedStore(storageKeyName, { columns: [], scores: {} });

  const status = useDebouncedSave(data, storageKeyName, ready);

  function addColumn() {
    if (!newName.trim()) return;
    const col = { id: genId(), name: newName.trim(), date: newDate, subject: newSubject, segment: withSegment ? newSegment.trim() : "" };
    setData((prev) => ({ ...prev, columns: [...prev.columns, col] }));
    setNewName(""); setNewSegment(""); setAdding(false);
  }
  function removeColumn(colId) {
    setData((prev) => {
      const scores = { ...prev.scores };
      delete scores[colId];
      return { columns: prev.columns.filter((c) => c.id !== colId), scores };
    });
  }
  function setCell(colId, studentId, field, value) {
    setData((prev) => {
      const colScores = { ...(prev.scores[colId] || {}) };
      const cell = { ...(colScores[studentId] || {}) };
      cell[field] = value;
      colScores[studentId] = cell;
      return { ...prev, scores: { ...prev.scores, [colId]: colScores } };
    });
  }

  if (cls.students.length === 0) {
    return <div className="empty-note" style={{ marginTop: 12 }}>尚未新增學生，請至「學生與課表」分頁新增。</div>;
  }

  const segments = withSegment ? Array.from(new Set(data.columns.map((c) => c.segment).filter(Boolean))) : [];
  const subjects = hasSubjects ? cls.subjects : [];

  const filteredColumns = data.columns
    .filter((c) => subjectFilter === "all" || c.subject === subjectFilter)
    .filter((c) => !withSegment || segmentFilter === "all" || c.segment === segmentFilter)
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  const pooled = [];
  filteredColumns.forEach((col) => {
    cls.students.forEach((s) => {
      const v = (data.scores[col.id] || {})[s.id]?.score;
      if (v !== undefined && v !== "" && !Number.isNaN(Number(v))) pooled.push(Number(v));
    });
  });
  const classAvg = mean(pooled);
  const classStd = stddev(pooled);

  const studentStatsBase = cls.students.map((s) => {
    const vals = filteredColumns
      .map((col) => (data.scores[col.id] || {})[s.id]?.score)
      .filter((v) => v !== undefined && v !== "" && !Number.isNaN(Number(v)))
      .map(Number);
    const improvement =
      vals.length >= 2 && vals[0] !== 0 ? Math.round(((vals[vals.length - 1] - vals[0]) / Math.abs(vals[0])) * 1000) / 10 : null;
    return { student: s, avg: mean(vals), std: stddev(vals), count: vals.length, improvement };
  });
  const sortedAvgs = studentStatsBase.filter((s) => s.count > 0).map((s) => s.avg).sort((a, b) => a - b);
  const studentStats = studentStatsBase.map((s) => {
    if (s.count === 0 || sortedAvgs.length < 2) return { ...s, pr: null };
    const below = sortedAvgs.filter((a) => a < s.avg).length;
    return { ...s, pr: Math.round((below / (sortedAvgs.length - 1)) * 100) };
  });

  const chartData = filteredColumns.map((col) => {
    const colVals = cls.students
      .map((s) => (data.scores[col.id] || {})[s.id]?.score)
      .filter((v) => v !== undefined && v !== "" && !Number.isNaN(Number(v)))
      .map(Number);
    const row = { name: col.name, 班平均: mean(colVals) };
    if (focusStudentId) {
      const v = (data.scores[col.id] || {})[focusStudentId]?.score;
      row[cls.students.find((s) => s.id === focusStudentId)?.name || "個人"] =
        v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : null;
    }
    return row;
  });

  return (
    <div>
      <div className="row-between" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
        <div className="row-actions" style={{ flexWrap: "wrap" }}>
          {hasSubjects && (
            <select className="filter-select" value={subjectFilter} onChange={(e) => setSubjectFilter(e.target.value)}>
              <option value="all">全部科目</option>
              {subjects.map((sub) => <option key={sub} value={sub}>{sub}</option>)}
            </select>
          )}
          {withSegment && (
            <select className="filter-select" value={segmentFilter} onChange={(e) => setSegmentFilter(e.target.value)}>
              <option value="all">全部範圍</option>
              {segments.map((seg) => <option key={seg} value={seg}>{seg}</option>)}
            </select>
          )}
        </div>
        <div className="row-actions">
          <SaveIndicator status={status} />
          <button className="btn-primary btn-sm" onClick={() => setAdding(true)}><Plus size={16} /> 新增{unitLabel}</button>
        </div>
      </div>

      {adding && (
        <div className="form-card" style={{ marginTop: 10 }}>
          <div className="form-grid">
            <label className="field"><span>{unitLabel}名稱</span><input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="例：CH1 1-3 / 一上一段" /></label>
            <label className="field"><span>日期</span><input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} /></label>
            {hasSubjects && (
              <label className="field">
                <span>科目</span>
                <select value={newSubject} onChange={(e) => setNewSubject(e.target.value)}>
                  <option value="">（未指定）</option>
                  {cls.subjects.map((sub) => <option key={sub} value={sub}>{sub}</option>)}
                </select>
              </label>
            )}
            {withSegment && (
              <label className="field">
                <span>範圍分段（選填）</span>
                <input list="segment-options" value={newSegment} onChange={(e) => setNewSegment(e.target.value)} placeholder="例：一次段考範圍" />
                <datalist id="segment-options">{segments.map((seg) => <option key={seg} value={seg} />)}</datalist>
              </label>
            )}
          </div>
          <div className="form-actions">
            <button className="btn-ghost" onClick={() => setAdding(false)}>取消</button>
            <button className="btn-primary" onClick={addColumn}>新增</button>
          </div>
        </div>
      )}

      {filteredColumns.length === 0 ? (
        <div className="empty-note">尚未新增任何{unitLabel}。</div>
      ) : (
        <>
          <div className="stats-panel">
            <div className="stats-row-head">
              <span>全班平均</span><span>{fmtNum(classAvg)}</span>
              <span>標準差</span><span>{fmtNum(classStd)}</span>
            </div>
            <div className="stats-table stats-table-scroll">
              <div className="stats-table-row-5 stats-table-head"><span>學生</span><span>平均</span><span>標準差</span><span>PR</span><span>進步率</span></div>
              {studentStats.map(({ student, avg, std, count, pr, improvement }) => (
                <div className="stats-table-row-5" key={student.id}>
                  <span>{student.name}</span>
                  <span>{count ? fmtNum(avg) : "—"}</span>
                  <span>{count > 1 ? fmtNum(std) : "—"}</span>
                  <span>{pr !== null ? pr : "—"}</span>
                  <span>{improvement !== null ? `${improvement > 0 ? "+" : ""}${improvement}%` : "—"}</span>
                </div>
              ))}
            </div>
            <div className="section-hint" style={{ marginTop: 6 }}>PR：在目前篩選範圍內贏過多少百分比的同學（100 為最高）。進步率：篩選範圍內第一次到最後一次成績的變化幅度。</div>
          </div>

          <div className="chart-card">
            <div className="row-between" style={{ marginBottom: 6 }}>
              <span className="section-hint">成績趨勢</span>
              <select className="filter-select" value={focusStudentId} onChange={(e) => setFocusStudentId(e.target.value)}>
                <option value="">只看全班平均</option>
                {cls.students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 5, right: 12, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E1DACB" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="班平均" stroke={CHART_COLORS[0]} strokeWidth={2} connectNulls dot={{ r: 3 }} />
                {focusStudentId && (
                  <Line type="monotone" dataKey={cls.students.find((s) => s.id === focusStudentId)?.name || "個人"} stroke={CHART_COLORS[1]} strokeWidth={2} connectNulls dot={{ r: 3 }} />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="matrix-scroll">
            <table className="matrix">
              <thead>
                <tr>
                  <th className="matrix-corner">學生</th>
                  {filteredColumns.map((col) => (
                    <th key={col.id} className="matrix-col-head">
                      <div className="matrix-col-name">{col.name}</div>
                      <div className="matrix-col-date">{col.date}{col.subject ? ` · ${col.subject}` : ""}{col.segment ? ` · ${col.segment}` : ""}</div>
                      <ConfirmDelete label="刪除這項？" onConfirm={() => removeColumn(col.id)} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cls.students.map((s) => (
                  <tr key={s.id}>
                    <td className="matrix-row-head">{s.name}</td>
                    {filteredColumns.map((col) => {
                      const cell = (data.scores[col.id] || {})[s.id] || {};
                      return (
                        <td key={col.id} className="matrix-cell">
                          <input className="matrix-input" inputMode="decimal" value={cell.score ?? ""} onChange={(e) => setCell(col.id, s.id, "score", e.target.value)} placeholder="分數" />
                          {withRank && <input className="matrix-input matrix-input-sub" value={cell.rank ?? ""} onChange={(e) => setCell(col.id, s.id, "rank", e.target.value)} placeholder="班排/校排" />}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fee tab                                                              */
/* ------------------------------------------------------------------ */

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function FeeTab({ cls }) {
  const [adding, setAdding] = useState(false);
  const storageKeyName = `fee:${cls.id}`;
  const [data, setData, ready] = useCachedStore(storageKeyName, { charges: [] });

  const status = useDebouncedSave(data, storageKeyName, ready);

  function addCharge(charge) {
    setData((prev) => ({ charges: [...prev.charges, { id: genId(), paid: false, paidDate: "", ...charge }] }));
    setAdding(false);
  }
  function markPaid(id) {
    setData((prev) => ({ charges: prev.charges.map((c) => (c.id === id ? { ...c, paid: true, paidDate: todayStr() } : c)) }));
  }
  function undoPaid(id) {
    setData((prev) => ({ charges: prev.charges.map((c) => (c.id === id ? { ...c, paid: false, paidDate: "" } : c)) }));
  }
  function removeCharge(id) {
    setData((prev) => ({ charges: prev.charges.filter((c) => c.id !== id) }));
  }

  if (cls.students.length === 0) {
    return <div className="empty-note" style={{ marginTop: 12 }}>尚未新增學生，請至「學生與課表」分頁新增。</div>;
  }

  const sorted = data.charges.slice().sort((a, b) => (b.periodStart || "").localeCompare(a.periodStart || ""));

  return (
    <div>
      <div className="row-between" style={{ marginTop: 10 }}>
        <span className="section-hint">收費區間、金額、教材費、折扣，總金額自動計算</span>
        <div className="row-actions">
          <SaveIndicator status={status} />
          <button className="btn-primary btn-sm" onClick={() => setAdding(true)}><Plus size={16} /> 新增收費</button>
        </div>
      </div>

      {adding && <NewChargeForm students={cls.students.filter((s) => getMembership(s) !== "stopped")} onCancel={() => setAdding(false)} onCreate={addCharge} />}

      <div className="card-list" style={{ marginTop: 12 }}>
        {sorted.map((c) => {
          const student = cls.students.find((s) => s.id === c.studentId);
          const total = num(c.tuition) + num(c.materials) - num(c.discount);
          return (
            <div key={c.id} className="fee-card">
              <div className="fee-card-top">
                <div>
                  <div className="fee-card-name">{student ? student.name : "（已移除的學生）"}</div>
                  <div className="fee-card-period">{c.periodStart || "?"} ～ {c.periodEnd || "?"}</div>
                </div>
                <span className={"tag " + (c.paid ? "tag-good" : "tag-muted")}>{c.paid ? `已收 ${c.paidDate}` : "未收"}</span>
              </div>
              <div className="fee-card-breakdown">
                <span>金額 {num(c.tuition)}</span>
                <span>+ 教材 {num(c.materials)}</span>
                <span>− 折扣 {num(c.discount)}</span>
                <span className="fee-card-total">＝ 總金額 {total}</span>
              </div>
              <div className="row-actions" style={{ marginTop: 8 }}>
                {c.paid ? (
                  <button className="btn-ghost btn-xs" onClick={() => undoPaid(c.id)}>取消收費</button>
                ) : (
                  <button className="btn-primary btn-sm" onClick={() => markPaid(c.id)}><BadgeCheck size={14} /> 收費</button>
                )}
                <ConfirmDelete label="刪除這筆收費？" onConfirm={() => removeCharge(c.id)} />
              </div>
            </div>
          );
        })}
        {sorted.length === 0 && <div className="empty-note">尚未新增任何收費紀錄。</div>}
      </div>
    </div>
  );
}

function NewChargeForm({ students, onCancel, onCreate }) {
  const [studentId, setStudentId] = useState(students[0]?.id || "");
  const [periodStart, setPeriodStart] = useState(todayStr());
  const [periodEnd, setPeriodEnd] = useState(todayStr());
  const [tuition, setTuition] = useState("");
  const [materials, setMaterials] = useState("");
  const [discount, setDiscount] = useState("");
  const [givenDate, setGivenDate] = useState("");
  const total = num(tuition) + num(materials) - num(discount);

  return (
    <div className="form-card" style={{ marginTop: 10 }}>
      <div className="form-grid">
        <label className="field"><span>學生</span>
          <select value={studentId} onChange={(e) => setStudentId(e.target.value)}>
            {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="field"><span>發收費袋日期（選填）</span><input type="date" value={givenDate} onChange={(e) => setGivenDate(e.target.value)} /></label>
        <label className="field"><span>收費區間起</span><input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /></label>
        <label className="field"><span>收費區間迄</span><input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></label>
        <label className="field"><span>金額</span><input inputMode="numeric" value={tuition} onChange={(e) => setTuition(e.target.value)} placeholder="0" /></label>
        <label className="field"><span>教材費</span><input inputMode="numeric" value={materials} onChange={(e) => setMaterials(e.target.value)} placeholder="0" /></label>
        <label className="field"><span>折扣</span><input inputMode="numeric" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0" /></label>
        <div className="field"><span>總金額</span><div className="computed-total">{total}</div></div>
      </div>
      <div className="form-actions">
        <button className="btn-ghost" onClick={onCancel}>取消</button>
        <button className="btn-primary" onClick={() => onCreate({ studentId, periodStart, periodEnd, tuition, materials, discount, givenDate })}>新增</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Roster & schedule tab                                               */
/* ------------------------------------------------------------------ */

function RosterTab({ cls, knownSchools, onUpdateClass }) {
  return (
    <div>
      <ClassInfoEditor cls={cls} onUpdateClass={onUpdateClass} />
      <OrphanRecovery cls={cls} onUpdateClass={onUpdateClass} />
      <StudentEditor cls={cls} knownSchools={knownSchools} onUpdateClass={onUpdateClass} />
      <SubjectEditor cls={cls} onUpdateClass={onUpdateClass} />
      <ScheduleEditor cls={cls} onUpdateClass={onUpdateClass} />
      <OverrideList cls={cls} onUpdateClass={onUpdateClass} />
    </div>
  );
}

/* Finds studentIds that still appear inside stored attendance / quiz /
   exam / fee data but have no matching entry in cls.students anymore
   (this happens to any student that was permanently deleted, e.g.
   before the "停止上課" option existed instead of hard delete). Lets
   the person reattach a name to that exact id so every historical row
   across every tab reconnects immediately — nothing needs to be
   re-entered. */
function OrphanRecovery({ cls, onUpdateClass }) {
  const [loading, setLoading] = useState(true);
  const [orphans, setOrphans] = useState([]);
  const [names, setNames] = useState({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [attendance, quiz, exam, fee] = await Promise.all([
        loadKey(`attendance:${cls.id}`, {}),
        loadKey(`quiz:${cls.id}`, { columns: [], scores: {} }),
        loadKey(`exam:${cls.id}`, { columns: [], scores: {} }),
        cls.hasFee ? loadKey(`fee:${cls.id}`, { charges: [] }) : Promise.resolve({ charges: [] }),
      ]);
      const knownIds = new Set(cls.students.map((s) => s.id));
      const info = {}; // id -> { attDates: [], quizCount, examCount, feeCount }
      function touch(id) {
        if (!info[id]) info[id] = { attDates: [], quizCount: 0, examCount: 0, feeCount: 0 };
        return info[id];
      }
      Object.entries(attendance).forEach(([date, day]) => {
        Object.keys(day.records || {}).forEach((id) => { touch(id).attDates.push(date); });
      });
      Object.values(quiz.scores || {}).forEach((colScores) => {
        Object.keys(colScores).forEach((id) => { touch(id).quizCount += 1; });
      });
      Object.values(exam.scores || {}).forEach((colScores) => {
        Object.keys(colScores).forEach((id) => { touch(id).examCount += 1; });
      });
      (fee.charges || []).forEach((c) => { touch(c.studentId).feeCount += 1; });

      const list = Object.keys(info)
        .filter((id) => !knownIds.has(id))
        .map((id) => {
          const d = info[id].attDates.sort();
          return {
            id,
            attCount: d.length,
            attFirst: d[0] || null,
            attLast: d[d.length - 1] || null,
            quizCount: info[id].quizCount,
            examCount: info[id].examCount,
            feeCount: info[id].feeCount,
          };
        });
      if (!cancelled) { setOrphans(list); setLoading(false); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cls.id, cls.students.length]);

  function restore(o) {
    const name = (names[o.id] || "").trim();
    if (!name) return;
    onUpdateClass((c) => ({
      ...c,
      students: [...c.students, { id: o.id, name, school: "", membership: "stopped", endDate: o.attLast || "" }],
    }));
    setOrphans((prev) => prev.filter((x) => x.id !== o.id));
  }

  if (loading || orphans.length === 0) return null;

  return (
    <div className="panel panel-warning">
      <div className="panel-title"><Users size={15} /> 找到 {orphans.length} 位「消失的學生」紀錄</div>
      <div className="section-hint" style={{ marginBottom: 10 }}>
        這些學生之前被永久刪除過，資料還在，只是名單上沒有人對應。幫每個 ID 填上姓名並按「還原」，所有分頁的歷史紀錄就會立刻接回來（會標記為「已停止上課」）。
      </div>
      {orphans.map((o) => (
        <div key={o.id} className="orphan-row">
          <div className="orphan-info">
            {o.attCount > 0 && <span>出缺勤 {o.attCount} 筆（{o.attFirst} ～ {o.attLast}）</span>}
            {o.quizCount > 0 && <span>平時考 {o.quizCount} 筆</span>}
            {o.examCount > 0 && <span>段考 {o.examCount} 筆</span>}
            {o.feeCount > 0 && <span>收費 {o.feeCount} 筆</span>}
          </div>
          <div className="row-actions">
            <input className="student-input" placeholder="這位是誰？輸入姓名" value={names[o.id] || ""} onChange={(e) => setNames((prev) => ({ ...prev, [o.id]: e.target.value }))} />
            <button className="btn-primary btn-sm" onClick={() => restore(o)}>還原</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ClassInfoEditor({ cls, onUpdateClass }) {
  const [name, setName] = useState(cls.name);
  const [subject, setSubject] = useState(cls.subject);
  const [grade, setGrade] = useState(cls.grade);

  useEffect(() => {
    setName(cls.name);
    setSubject(cls.subject);
    setGrade(cls.grade);
  }, [cls.id]);

  function save() {
    onUpdateClass((c) => ({ ...c, name: name.trim() || c.name, subject: subject.trim(), grade: grade.trim() }));
  }

  return (
    <div className="panel">
      <div className="panel-title"><Pencil size={15} /> 班級資訊</div>
      <div className="section-hint" style={{ marginBottom: 8 }}>升學年後（例如國一變國二、高一變高二），可以直接在這裡改班級名稱，歷史紀錄不會受影響。</div>
      <div className="form-grid">
        <label className="field"><span>班級名稱</span><input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} /></label>
        <label className="field"><span>科目</span><input value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={save} /></label>
        <label className="field"><span>年級</span><input value={grade} onChange={(e) => setGrade(e.target.value)} onBlur={save} /></label>
      </div>
    </div>
  );
}

/* School picker: real dropdown of every school seen across all classes,
   plus an explicit "add a new school" flow (works reliably on iPad Safari,
   unlike a bare <input list=...> datalist). */
function SchoolField({ value, onChange, knownSchools }) {
  const [addingNew, setAddingNew] = useState(false);
  const [draft, setDraft] = useState("");

  if (addingNew) {
    return (
      <div className="school-add-row">
        <input className="student-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="輸入新學校名稱" />
        <IconBtn title="確定新增" onClick={() => { if (draft.trim()) onChange(draft.trim()); setAddingNew(false); setDraft(""); }}><Check size={15} /></IconBtn>
        <IconBtn title="取消" onClick={() => { setAddingNew(false); setDraft(""); }}><X size={15} /></IconBtn>
      </div>
    );
  }
  return (
    <select
      className="student-input"
      value={value || ""}
      onChange={(e) => { if (e.target.value === "__new__") setAddingNew(true); else onChange(e.target.value); }}
    >
      <option value="">（未選擇學校）</option>
      {value && !knownSchools.includes(value) && <option value={value}>{value}</option>}
      {knownSchools.map((sc) => <option key={sc} value={sc}>{sc}</option>)}
      <option value="__new__">➕ 新增學校…</option>
    </select>
  );
}

function StudentEditor({ cls, knownSchools, onUpdateClass }) {
  const [name, setName] = useState("");
  const [school, setSchool] = useState("");
  const [isNewStudent, setIsNewStudent] = useState(true);
  const [attendance] = useCachedStore(`attendance:${cls.id}`, {});

  const today = todayStr();
  const enrolled = cls.students.filter((s) => membershipAtDate(s, today, attendance) !== "stopped");
  const stopped = cls.students.filter((s) => membershipAtDate(s, today, attendance) === "stopped");

  function add() {
    if (!name.trim()) return;
    onUpdateClass((c) => ({
      ...c,
      students: [...c.students, { id: genId(), name: name.trim(), school: school.trim(), joinDate: today, forceActive: !isNewStudent }],
    }));
    setName(""); setSchool("");
  }
  function stop(id) {
    onUpdateClass((c) => ({ ...c, students: c.students.map((s) => (s.id === id ? { ...s, endDate: today } : s)) }));
  }
  function reactivate(id) {
    onUpdateClass((c) => ({ ...c, students: c.students.map((s) => (s.id === id ? { ...s, endDate: "", membership: undefined, active: undefined } : s)) }));
  }
  function toggleForce(id, current) {
    onUpdateClass((c) => ({
      ...c,
      students: c.students.map((s) => (s.id === id ? { ...s, forceActive: current === "trial", forceTrial: current === "active" } : s)),
    }));
  }
  function removePermanently(id) {
    onUpdateClass((c) => ({ ...c, students: c.students.filter((s) => s.id !== id) }));
  }
  function edit(id, field, value) {
    onUpdateClass((c) => ({ ...c, students: c.students.map((s) => (s.id === id ? { ...s, [field]: value } : s)) }));
  }

  return (
    <div className="panel">
      <div className="panel-title"><Users size={15} /> 學生名單</div>
      {enrolled.map((s) => {
        const membership = membershipAtDate(s, today, attendance);
        return (
          <div key={s.id} className="student-row">
            <input className="student-input" value={s.name} onChange={(e) => edit(s.id, "name", e.target.value)} placeholder="姓名" />
            <SchoolField value={s.school} knownSchools={knownSchools} onChange={(v) => edit(s.id, "school", v)} />
            <button className="btn-ghost btn-xs" title="試聽滿兩堂後會自動轉為班內生；這裡可以提前手動轉正，或反向手動延長試聽" onClick={() => toggleForce(s.id, membership)}>
              {membership === "trial" ? <><span className="trial-tag">試</span>轉為班內生</> : "設為試聽生"}
            </button>
            <ConfirmAction label={`確定將 ${s.name} 標記為停班？往後就不會再出現在出席表裡（歷史紀錄仍會保留）。`} confirmText="確定停班" onConfirm={() => stop(s.id)}>
              <Archive size={13} /> 停班
            </ConfirmAction>
          </div>
        );
      })}
      <div className="student-row">
        <input className="student-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="新學生姓名" />
        <SchoolField value={school} knownSchools={knownSchools} onChange={setSchool} />
        <label className="trial-check">
          <input type="checkbox" checked={isNewStudent} onChange={(e) => setIsNewStudent(e.target.checked)} />
          <span>新生（先試聽兩堂）</span>
        </label>
        <IconBtn title="新增" onClick={add}><Plus size={15} /></IconBtn>
      </div>

      {stopped.length > 0 && (
        <>
          <div className="section-hint" style={{ marginTop: 14, marginBottom: 6 }}>
            已停班（不會出現在出缺勤名單，但平時考/段考/總覽的歷史紀錄仍會保留）
          </div>
          {stopped.map((s) => (
            <div key={s.id} className="student-row student-row-inactive">
              <span className="student-inactive-name">{s.name}{s.school ? `（${s.school}）` : ""}</span>
              <span className="student-inactive-date">{s.endDate ? `停班於 ${s.endDate}` : ""}</span>
              <button className="btn-ghost btn-xs" onClick={() => reactivate(s.id)}>重新啟用</button>
              <ConfirmDelete label={`永久刪除${s.name}的所有資料？`} onConfirm={() => removePermanently(s.id)} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function SubjectEditor({ cls, onUpdateClass }) {
  const [name, setName] = useState("");
  const subjects = cls.subjects || [];

  function add() {
    if (!name.trim() || subjects.includes(name.trim())) return;
    onUpdateClass((c) => ({ ...c, subjects: [...(c.subjects || []), name.trim()] }));
    setName("");
  }
  function remove(sub) {
    onUpdateClass((c) => ({ ...c, subjects: (c.subjects || []).filter((s) => s !== sub) }));
  }

  return (
    <div className="panel">
      <div className="panel-title"><CircleDot size={15} /> 分科設定</div>
      <div className="section-hint" style={{ marginBottom: 8 }}>若這個班同時上多個科目（例如物理＋化學），在這裡新增科目標籤，平時考／段考就能分開統計。</div>
      <div className="chip-row" style={{ marginBottom: 8 }}>
        {subjects.map((sub) => (
          <span key={sub} className="chip chip-removable">{sub}<button onClick={() => remove(sub)}><X size={12} /></button></span>
        ))}
        {subjects.length === 0 && <span className="empty-note">尚未設定分科（成績將視為單一科目）</span>}
      </div>
      <div className="student-row">
        <input className="student-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="新增科目，例：物理" />
        <IconBtn title="新增" onClick={add}><Plus size={15} /></IconBtn>
      </div>
    </div>
  );
}

function ScheduleEditor({ cls, onUpdateClass }) {
  const [adding, setAdding] = useState(false);
  const [dayOfWeek, setDayOfWeek] = useState(2);
  const [interval, setIntervalVal] = useState(1);
  const [anchorDate, setAnchorDate] = useState(todayStr());
  const [effectiveFrom, setEffectiveFrom] = useState(todayStr());
  const [effectiveTo, setEffectiveTo] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [endingRuleId, setEndingRuleId] = useState(null);
  const [endingDate, setEndingDate] = useState(todayStr());

  function addRule() {
    const rule = { id: genId(), dayOfWeek: Number(dayOfWeek), interval: Number(interval), anchorDate: Number(interval) === 2 ? anchorDate : "", effectiveFrom, effectiveTo: effectiveTo || null, startTime, endTime };
    onUpdateClass((c) => ({ ...c, scheduleRules: [...(c.scheduleRules || []), rule] }));
    setAdding(false);
  }
  function confirmEndRule() {
    onUpdateClass((c) => ({ ...c, scheduleRules: c.scheduleRules.map((r) => (r.id === endingRuleId ? { ...r, effectiveTo: endingDate } : r)) }));
    setEndingRuleId(null);
  }
  function removeRule(id) {
    onUpdateClass((c) => ({ ...c, scheduleRules: c.scheduleRules.filter((r) => r.id !== id) }));
  }

  return (
    <div className="panel">
      <div className="panel-title"><CalendarDays size={15} /> 課表規則</div>
      <div className="rule-list">
        {(cls.scheduleRules || []).map((r) => {
          const active = !r.effectiveTo || r.effectiveTo >= todayStr();
          return (
            <div key={r.id} className={"rule-chip" + (active ? "" : " rule-chip-past")}>
              <span>
                {r.interval === 2 ? "隔週" : "每週"}週{WEEKDAY_FULL[r.dayOfWeek]}{formatTimeRange(r.startTime, r.endTime) ? ` ${formatTimeRange(r.startTime, r.endTime)}` : ""}
                {"　"}生效：{r.effectiveFrom}{r.effectiveTo ? ` ～ ${r.effectiveTo}` : "（持續中）"}
              </span>
              {endingRuleId === r.id ? (
                <span className="confirm-inline">
                  <input type="date" className="date-nav-picker" value={endingDate} onChange={(e) => setEndingDate(e.target.value)} />
                  <button className="btn-ghost btn-xs" onClick={() => setEndingRuleId(null)}>取消</button>
                  <button className="btn-primary btn-sm" onClick={confirmEndRule}>確定</button>
                </span>
              ) : (
                <div className="row-actions">
                  {active && <button className="btn-ghost btn-xs" onClick={() => { setEndingRuleId(r.id); setEndingDate(todayStr()); }}>結束此規則</button>}
                  <ConfirmDelete label="刪除這條規則？" onConfirm={() => removeRule(r.id)} />
                </div>
              )}
            </div>
          );
        })}
        {(cls.scheduleRules || []).length === 0 && <div className="empty-note">尚未設定課表規則。</div>}
      </div>

      {adding ? (
        <div className="form-card" style={{ marginTop: 10 }}>
          <div className="form-grid">
            <label className="field"><span>星期</span>
              <select value={dayOfWeek} onChange={(e) => setDayOfWeek(e.target.value)}>
                {WEEKDAY_FULL.map((w, i) => <option key={i} value={i}>週{w}</option>)}
              </select>
            </label>
            <label className="field"><span>頻率</span>
              <select value={interval} onChange={(e) => setIntervalVal(e.target.value)}>
                <option value={1}>每週</option><option value={2}>隔週</option>
              </select>
            </label>
            <label className="field"><span>上課開始時間（選填）</span><input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></label>
            <label className="field"><span>上課結束時間（選填）</span><input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></label>
            {Number(interval) === 2 && (
              <label className="field"><span>基準上課日（用來判斷單雙週）</span><input type="date" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} /></label>
            )}
            <label className="field"><span>生效起始日</span><input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></label>
            <label className="field"><span>生效結束日（留空＝持續）</span><input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} /></label>
          </div>
          <div className="form-actions">
            <button className="btn-ghost" onClick={() => setAdding(false)}>取消</button>
            <button className="btn-primary" onClick={addRule}>新增規則</button>
          </div>
        </div>
      ) : (
        <button className="btn-primary btn-sm" style={{ marginTop: 10 }} onClick={() => setAdding(true)}><Plus size={16} /> 新增排課規則</button>
      )}
      <div className="hint-block">調整課表時，建議把「生效起始日」設為未來日期，並幫舊規則填上「生效結束日」——這樣過去已經記錄的出缺勤、成績都不會被更動。</div>
    </div>
  );
}

function OverrideList({ cls, onUpdateClass }) {
  const overrides = (cls.overrides || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  function remove(date) {
    onUpdateClass((c) => ({ ...c, overrides: c.overrides.filter((o) => o.date !== date) }));
  }
  if (overrides.length === 0) return null;
  return (
    <div className="panel">
      <div className="panel-title"><Pencil size={15} /> 單次調整紀錄</div>
      <div className="rule-list">
        {overrides.map((o) => (
          <div key={o.date} className="rule-chip">
            <span>{o.date}（{WEEKDAY_FULL[weekdayOf(o.date)]}）· {o.action === "add" ? "新增上課" : "取消上課"}{o.time ? ` · ${o.time}` : ""}{o.note ? ` · ${o.note}` : ""}</span>
            <ConfirmDelete label="移除此調整？" onConfirm={() => remove(o.date)} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Styles                                                                */
/* ------------------------------------------------------------------ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@600;700&family=Noto+Sans+TC:wght@400;500;700&family=IBM+Plex+Mono:wght@500&display=swap');

:root {
  --paper: #FAF8F3; --ink: #21262B; --ink-soft: #5B6672; --brass: #B8863B;
  --brass-soft: #EFE3CC; --line: #E1DACB; --card: #FFFFFF;
}
* { box-sizing: border-box; }
.shell { min-height: 100vh; width: 100%; overflow-x: hidden; background: var(--paper); color: var(--ink); font-family: 'Noto Sans TC', sans-serif; padding-bottom: 40px; }
.loading { padding: 40px; text-align: center; color: var(--ink-soft); }

.topnav { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 12px; padding: 14px 16px; background: var(--paper); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 8px; margin-right: 4px; }
.brand-mark { width: 28px; height: 28px; border-radius: 6px; background: var(--brass); color: white; display: flex; align-items: center; justify-content: center; font-family: 'Noto Serif TC', serif; font-weight: 700; font-size: 14px; transform: rotate(-4deg); }
.brand-text { font-family: 'Noto Serif TC', serif; font-weight: 700; font-size: 16px; }

.nav-pills { display: flex; gap: 6px; }
.nav-pills-sub { margin-bottom: 2px; }
.pill { border: 1px solid var(--line); background: var(--card); padding: 7px 14px; border-radius: 999px; font-size: 13px; color: var(--ink-soft); cursor: pointer; font-family: inherit; }
.pill-sm { padding: 5px 12px; font-size: 12px; }
.pill-active { background: var(--ink); color: white; border-color: var(--ink); }

.save-indicator { margin-left: auto; font-size: 11px; color: var(--ink-soft); font-family: 'IBM Plex Mono', monospace; white-space: nowrap; }

.toast { position: sticky; top: 58px; z-index: 9; margin: 0 16px 0; max-width: 688px; margin-left: auto; margin-right: auto; background: var(--ink); color: white; border-radius: 10px; padding: 10px 14px; font-size: 12.5px; display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }
.toast button { background: none; border: none; color: white; opacity: 0.7; cursor: pointer; display: flex; }

.backup-warning { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: #FBEAE9; border: 1px solid #F0C6C3; color: #8C332E; border-radius: 10px; padding: 10px 14px; font-size: 12.5px; margin-bottom: 12px; flex-wrap: wrap; }
.btn-ghost-warning { border-color: #F0C6C3; color: #B23A34; }

.view-pad { padding: 16px; max-width: 720px; margin: 0 auto; }

.section-label { font-family: 'Noto Serif TC', serif; font-weight: 700; font-size: 15px; margin: 18px 0 10px; }
.section-hint { font-size: 12px; color: var(--ink-soft); }

.calendar { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px; }
.calendar-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.calendar-title { font-family: 'Noto Serif TC', serif; font-weight: 700; font-size: 15px; }
.calendar-weekdays { display: grid; grid-template-columns: repeat(7,1fr); text-align: center; font-size: 11px; color: var(--ink-soft); margin-bottom: 4px; }
.calendar-grid { display: grid; grid-template-columns: repeat(7,1fr); gap: 3px; }
.calendar-cell { aspect-ratio: 1/1; border: 1px solid transparent; background: none; border-radius: 9px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; cursor: pointer; font-family: inherit; }
.calendar-cell-num { font-family: 'IBM Plex Mono', monospace; font-size: 12px; }
.calendar-cell-out { opacity: 0.3; }
.calendar-cell-dots { display: flex; gap: 2px; height: 5px; }
.calendar-cell-selected { border-color: var(--ink); background: #F1F1EE; }
.calendar-cell-today { box-shadow: 0 0 0 2px var(--brass-soft); border-color: var(--brass); }
.dot { width: 5px; height: 5px; border-radius: 50%; }

.card-list { display: flex; flex-direction: column; gap: 8px; }
.class-card { display: flex; align-items: center; gap: 10px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; cursor: pointer; text-align: left; font-family: inherit; width: 100%; }
.class-card-static { cursor: default; }
.class-card-clickable { cursor: pointer; border: none; background: none; padding: 0; flex: 1; text-align: left; font-family: inherit; min-width: 0; }
.class-card-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.class-card-body { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.class-card-title { font-weight: 700; font-size: 15px; }
.class-card-sub { font-size: 12px; color: var(--ink-soft); }
.class-card-time { display: flex; align-items: center; gap: 3px; font-size: 11px; color: var(--brass); font-family: 'IBM Plex Mono', monospace; white-space: nowrap; }

.chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid var(--line); background: var(--card); border-radius: 999px; padding: 6px 12px; font-size: 12px; cursor: pointer; font-family: inherit; color: var(--ink); }
.chip-removable { display: inline-flex; align-items: center; gap: 6px; cursor: default; }
.chip-removable button { border: none; background: none; color: var(--ink-soft); cursor: pointer; display: flex; }

.empty-note { color: var(--ink-soft); font-size: 13px; padding: 10px 2px; }
.empty-state { text-align: center; color: var(--ink-soft); padding: 40px 20px; font-size: 14px; }

.row-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.row-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.btn-primary { background: var(--ink); color: white; border: none; border-radius: 9px; padding: 9px 14px; font-size: 13px; font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-family: inherit; }
.btn-primary:disabled { opacity: 0.6; cursor: default; }
.btn-sm { padding: 6px 11px; font-size: 12px; }
.btn-ghost { background: none; border: 1px solid var(--line); color: var(--ink-soft); border-radius: 9px; padding: 8px 12px; font-size: 12px; cursor: pointer; font-family: inherit; }
.btn-ghost:disabled { opacity: 0.6; cursor: default; }
.btn-xs { padding: 5px 10px; font-size: 11px; }
.btn-danger { background: #B23A34; color: white; border: none; border-radius: 9px; padding: 6px 11px; font-size: 12px; cursor: pointer; font-family: inherit; }

.icon-btn { border: 1px solid var(--line); background: var(--card); border-radius: 8px; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--ink-soft); flex-shrink: 0; }
.icon-btn-danger { color: #B23A34; }

.confirm-inline { display: inline-flex; align-items: center; gap: 6px; background: #FBEAE9; border: 1px solid #F0C6C3; border-radius: 9px; padding: 4px 6px; flex-wrap: wrap; }
.confirm-inline-neutral { background: var(--brass-soft); border-color: #E3D2A9; }
.confirm-inline-label-neutral { color: #8C6D2E; }
.trial-tag { display: inline-block; margin-left: 4px; font-size: 10px; font-weight: 700; color: #7A5EA8; background: #F1EAF6; border: 1px solid #DCC8ED; border-radius: 4px; padding: 0 4px; vertical-align: middle; }
.confirm-inline-label { font-size: 11.5px; color: #B23A34; padding-left: 4px; }

.inline-form { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; background: var(--brass-soft); border: 1px solid #E3D2A9; border-radius: 10px; padding: 8px 10px; }

.form-card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin-top: 10px; }
.form-title { font-weight: 700; margin-bottom: 10px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ink-soft); min-width: 0; }
.field input, .field select { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 14px; color: var(--ink); font-family: inherit; background: white; width: 100%; min-width: 0; }
.field-checkbox { flex-direction: row; align-items: center; gap: 8px; grid-column: 1 / -1; }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.computed-total { font-family: 'IBM Plex Mono', monospace; font-weight: 700; padding: 8px 10px; font-size: 14px; }

.detail-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.detail-title-wrap { flex: 1; min-width: 0; }
.detail-title { font-family: 'Noto Serif TC', serif; font-weight: 700; font-size: 18px; }
.detail-sub { font-size: 12px; color: var(--ink-soft); margin-top: 2px; }

.tabbar { display: flex; gap: 4px; overflow-x: auto; border-bottom: 1px solid var(--line); margin-bottom: 12px; }
.tab { display: flex; align-items: center; gap: 5px; white-space: nowrap; background: none; border: none; padding: 8px 10px; font-size: 13px; color: var(--ink-soft); cursor: pointer; border-bottom: 2px solid transparent; font-family: inherit; }
.tab-active { color: var(--ink); border-bottom-color: var(--brass); font-weight: 700; }

.date-nav { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.date-nav-label { display: flex; align-items: center; gap: 6px; font-weight: 700; font-family: 'IBM Plex Mono', monospace; font-size: 14px; }
.date-nav-time { display: flex; align-items: center; gap: 3px; color: var(--brass); font-size: 12px; }
.date-nav-picker { border: 1px solid var(--line); border-radius: 8px; padding: 5px 8px; font-size: 12px; font-family: inherit; color: var(--ink-soft); }

.tag { font-size: 11px; padding: 4px 9px; border-radius: 999px; font-weight: 500; }
.tag-good { background: #EAF3EC; color: #3F7D5C; }
.tag-muted { background: #EEEEEC; color: #71757A; }

.roll-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.roll-row { display: flex; align-items: center; gap: 10px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; flex-wrap: wrap; }
.roll-name { min-width: 74px; font-size: 13px; font-weight: 500; }
.roll-school { font-size: 11px; color: var(--ink-soft); font-weight: 400; }
.status-group { display: flex; flex-wrap: wrap; gap: 5px; flex: 1; }
.status-btn { border: 1px solid var(--line); background: white; color: var(--ink-soft); border-radius: 7px; padding: 5px 9px; font-size: 12px; cursor: pointer; font-family: inherit; }
.status-btn-active { font-weight: 700; }

.filter-select { border: 1px solid var(--line); border-radius: 8px; padding: 6px 9px; font-size: 12px; font-family: inherit; background: white; color: var(--ink); }

.stats-panel { margin-top: 14px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px; }
.stats-row-head { display: flex; gap: 14px; font-size: 13px; font-weight: 700; margin-bottom: 10px; flex-wrap: wrap; }
.stats-row-head span:nth-child(2), .stats-row-head span:nth-child(4) { color: var(--brass); font-family: 'IBM Plex Mono', monospace; }
.stats-table { display: flex; flex-direction: column; gap: 2px; }
.stats-table-row { display: grid; grid-template-columns: 1fr 70px 70px; font-size: 12.5px; padding: 4px 2px; }
.stats-table-head { color: var(--ink-soft); font-weight: 700; border-bottom: 1px solid var(--line); padding-bottom: 6px; margin-bottom: 2px; }
.stats-table-row span:nth-child(2), .stats-table-row span:nth-child(3) { font-family: 'IBM Plex Mono', monospace; text-align: right; }
.stats-table-row-5 { display: grid; grid-template-columns: minmax(60px,1fr) 44px 44px 36px 52px; font-size: 12px; padding: 4px 2px; gap: 3px; }
.stats-table-row-5 span:not(:first-child) { font-family: 'IBM Plex Mono', monospace; text-align: right; overflow: hidden; text-overflow: ellipsis; }
.stats-table-row-rate { display: grid; grid-template-columns: minmax(60px,1fr) 44px 44px 44px 44px; font-size: 12px; padding: 4px 2px; gap: 3px; }
.stats-table-row-rate span:not(:first-child) { font-family: 'IBM Plex Mono', monospace; text-align: right; overflow: hidden; text-overflow: ellipsis; }
.stats-table-scroll { overflow-x: auto; max-width: 100%; }
.icon-btn:disabled { opacity: 0.35; cursor: default; }
.journal-textarea { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 13px; font-family: inherit; resize: vertical; background: white; color: var(--ink); }
.status-chip { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 20px; padding: 0 4px; border-radius: 5px; font-size: 10.5px; font-weight: 700; }
.matrix-row-head-clickable { cursor: pointer; }
.matrix-row-head-clickable:hover { text-decoration: underline; }

.chart-card { margin-top: 14px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px; }

.matrix-scroll { overflow-x: auto; margin-top: 14px; border: 1px solid var(--line); border-radius: 10px; }
.matrix { border-collapse: collapse; width: 100%; background: var(--card); }
.matrix th, .matrix td { border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); padding: 6px 8px; }
.matrix-corner { position: sticky; left: 0; background: var(--card); z-index: 2; min-width: 76px; font-size: 12px; color: var(--ink-soft); text-align: left; }
.matrix-row-head { position: sticky; left: 0; background: var(--card); z-index: 1; font-size: 13px; font-weight: 500; white-space: nowrap; }
.matrix-col-head { min-width: 110px; position: relative; font-size: 12px; }
.matrix-col-name { font-weight: 700; }
.matrix-col-date { color: var(--ink-soft); font-family: 'IBM Plex Mono', monospace; font-size: 10px; margin-bottom: 4px; }
.matrix-cell { text-align: center; }
.matrix-input { width: 64px; border: 1px solid var(--line); border-radius: 6px; padding: 5px 6px; font-family: 'IBM Plex Mono', monospace; font-size: 13px; text-align: center; }
.matrix-input-sub { margin-top: 4px; font-size: 11px; color: var(--ink-soft); }

.fee-card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
.fee-card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.fee-card-name { font-weight: 700; font-size: 14px; }
.fee-card-period { font-size: 11.5px; color: var(--ink-soft); font-family: 'IBM Plex Mono', monospace; }
.fee-card-breakdown { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--ink-soft); margin-top: 8px; }
.fee-card-total { font-weight: 700; color: var(--ink); }

.panel { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin-top: 14px; }
.panel-warning { background: #FBF3DE; border-color: #EFDBA0; }
.panel-title { display: flex; align-items: center; gap: 6px; font-weight: 700; margin-bottom: 10px; font-family: 'Noto Serif TC', serif; }
.orphan-row { background: white; border: 1px solid #EFDBA0; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
.orphan-info { display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; color: var(--ink-soft); margin-bottom: 8px; font-family: 'IBM Plex Mono', monospace; }

.student-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; align-items: center; }
.student-row-inactive { background: #F1F1EE; border-radius: 8px; padding: 8px 10px; }
.student-inactive-name { font-size: 13px; color: var(--ink-soft); flex: 1 1 140px; }
.student-inactive-date { font-size: 11px; color: var(--ink-soft); font-family: 'IBM Plex Mono', monospace; }
.student-input { flex: 1 1 120px; min-width: 0; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 13px; font-family: inherit; background: white; color: var(--ink); }
.school-add-row { display: flex; align-items: center; gap: 6px; flex: 1 1 200px; }
.trial-check { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--ink-soft); white-space: nowrap; flex-shrink: 0; }

.rule-list { display: flex; flex-direction: column; gap: 6px; }
.rule-chip { display: flex; align-items: center; justify-content: space-between; gap: 8px; background: var(--brass-soft); border: 1px solid #E3D2A9; border-radius: 9px; padding: 8px 12px; font-size: 12.5px; flex-wrap: wrap; }
.rule-chip-past { background: #F1F1EE; border-color: var(--line); color: var(--ink-soft); }
.hint-block { margin-top: 10px; font-size: 11.5px; color: var(--ink-soft); background: #F1F1EE; border-radius: 8px; padding: 8px 10px; line-height: 1.6; }
`;
