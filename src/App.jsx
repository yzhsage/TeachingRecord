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
import { ref, get, set as dbSet, update as dbUpdate } from "firebase/database";
import { signOut } from "firebase/auth";
import { db, auth } from "./firebase";
import { eventTypeMeta, eventDates, eventsOnDate, isContinuousEvent, normalizeEvent } from "./calendar";
import { buildScoreDistribution, median, numericScore, scoreBand, scoreDelta, scorePercent } from "./assessment";

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
/* Same data as scheduleSummary, but split into one { day, time } entry
   per schedule rule instead of a single joined string — used on the
   class detail header so multiple sessions (e.g. 週二 + 週四) can be
   laid out as separate, aligned lines instead of wrapping mid-string. */
function scheduleLines(cls) {
  const rules = (cls.scheduleRules || []).filter((r) => !r.effectiveTo || r.effectiveTo >= todayStr());
  if (rules.length === 0) return [{ day: "尚未設定課表", time: "" }];
  return rules.map((r) => {
    const freq = r.interval === 2 ? "隔週" : "每週";
    const from = r.effectiveFrom && r.effectiveFrom > todayStr() ? `（自 ${r.effectiveFrom} 起）` : "";
    return { day: `${freq}週${WEEKDAY_FULL[r.dayOfWeek]}`, time: `${formatTimeRange(r.startTime, r.endTime)}${from}` };
  });
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
/* Number of students currently enrolled (試聽生 + 班內生), excluding
   anyone marked 停班 — this is what should show as "N 位學生" anywhere
   in the UI, as opposed to cls.students.length which also counts
   students who have since left the class. */
function activeStudentCount(cls) {
  return (cls.students || []).filter((s) => getMembership(s) !== "stopped").length;
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
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeNumber(value) {
  if (value === undefined || value === null || value === "") return true;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

function validateStoreValue(key, value) {
  if (key === "classIndex") {
    return Array.isArray(value) && value.every((cls) => isRecord(cls) && typeof cls.id === "string" && Array.isArray(cls.students || []) && Array.isArray(cls.scheduleRules || []) && Array.isArray(cls.overrides || []));
  }
  if (key === "calendar:events") {
    return Array.isArray(value) && value.every((event) => normalizeEvent(event) && typeof event.id === "string" && event.id.length > 0);
  }
  if (key === "lastBackupAt") return value === null || (typeof value === "string" && !Number.isNaN(new Date(value).getTime()));
  if (key.startsWith("attendance:")) return isRecord(value) && Object.values(value).every((day) => isRecord(day) && isRecord(day.records || {}));
  if (key.startsWith("quiz:") || key.startsWith("exam:")) {
    return isRecord(value) && Array.isArray(value.columns) && isRecord(value.scores) && value.columns.every((col) => isRecord(col) && typeof col.id === "string" && typeof col.name === "string") && Object.values(value.scores).every((colScores) => isRecord(colScores) && Object.values(colScores).every((cell) => isRecord(cell) && isNonNegativeNumber(cell.score)));
  }
  if (key.startsWith("fee:")) {
    return isRecord(value) && Array.isArray(value.charges) && value.charges.every((charge) => isRecord(charge) && typeof charge.id === "string" && typeof charge.studentId === "string" && isNonNegativeNumber(charge.tuition) && isNonNegativeNumber(charge.materials) && isNonNegativeNumber(charge.discount) && (!charge.periodStart || !charge.periodEnd || charge.periodEnd >= charge.periodStart));
  }
  return true;
}

async function saveKey(key, value) {
  if (!validateStoreValue(key, value)) {
    console.error("store validation failed", key);
    return false;
  }
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
  const [retryToken, setRetryToken] = useState(0);
  const timer = useRef(null);
  const lastSaved = useRef(null);
  const initialized = useRef(false);
  const saveAttempt = useRef(0);
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
    if (_.isEqual(value, lastSaved.current) && retryToken === 0) return;
    setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const attempt = ++saveAttempt.current;
      const ok = await saveKey(key, value);
      timer.current = null;
      if (attempt !== saveAttempt.current) return;
      if (ok) {
        lastSaved.current = value;
        setStatus("saved");
      } else {
        setStatus("error");
      }
    }, delay);
    // Only clears the pending timer so a fresh one can be scheduled on
    // the next change — does NOT run on real unmount discarding data,
    // that's handled by the separate effect below.
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, ready, retryToken]);

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

  return { status, retry: () => setRetryToken((n) => n + 1) };
}

/* ------------------------------------------------------------------ */
/* Small shared UI bits                                                 */
/* ------------------------------------------------------------------ */

function SaveIndicator({ status, onRetry }) {
  if (!status || status === "idle") return null;
  if (status === "error") {
    return <button type="button" className="save-indicator save-indicator-error" onClick={onRetry}>儲存失敗，點此重試</button>;
  }
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
  const [backupOpen, setBackupOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [lastBackupAt, setLastBackupAt] = useState(undefined); // undefined = still loading
  const fileInputRef = useRef(null);
  const [calendarEvents, setCalendarEvents, calendarReady] = useCachedStore("calendar:events", []);
  const [officialEvents, setOfficialEvents] = useState([]);
  const [officialCalendarStatus, setOfficialCalendarStatus] = useState("loading");

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

  const classIdxSave = useDebouncedSave(classes, "classIndex", ready);

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

  useEffect(() => {
    (async () => {
      const v = await loadKey("lastBackupAt", null);
      setLastBackupAt(v);
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setOfficialCalendarStatus("loading");
      try {
        const base = import.meta.env.BASE_URL || "/";
        const [holidayRes, examRes] = await Promise.all([
          fetch(`${base}calendar/national-holidays.json`),
          fetch(`${base}calendar/major-exams.json`),
        ]);
        if (!holidayRes.ok || !examRes.ok) throw new Error("calendar asset unavailable");
        const [holidayBundle, examBundle] = await Promise.all([holidayRes.json(), examRes.json()]);
        const bundled = [...(holidayBundle.events || []), ...(examBundle.events || [])]
          .map(normalizeEvent)
          .filter(Boolean);
        if (!cancelled) {
          setOfficialEvents(bundled);
          setOfficialCalendarStatus("ready");
        }
      } catch (e) {
        console.error("calendar asset load failed", e);
        if (!cancelled) setOfficialCalendarStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function addCalendarEvent(event) {
    const normalized = normalizeEvent({ ...event, id: genId(), readOnly: false, source: "手動建立" });
    if (!normalized) return false;
    setCalendarEvents((prev) => [...prev, normalized]);
    return true;
  }

  function updateCalendarEvent(id, event) {
    const normalized = normalizeEvent({ ...event, id, readOnly: false, source: "手動建立" });
    if (!normalized) return false;
    setCalendarEvents((prev) => prev.map((item) => item.id === id ? normalized : item));
    return true;
  }

  function removeCalendarEvent(id) {
    setCalendarEvents((prev) => prev.filter((event) => event.id !== id));
  }

  const calendarSave = useDebouncedSave(calendarEvents, "calendar:events", calendarReady);
  const allCalendarEvents = [...officialEvents, ...(calendarEvents || [])];
  const daysSinceBackup = lastBackupAt ? Math.floor((Date.now() - new Date(lastBackupAt).getTime()) / 86400000) : null;
  const backupOverdue = lastBackupAt !== undefined && (lastBackupAt === null || daysSinceBackup >= 7);

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
      const bundle = {
        schemaVersion: 2,
        exportedAt: new Date().toISOString(),
        classIndex: classes,
        calendarEvents: calendarEvents || [],
        records,
      };
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
      const backupMarked = await saveKey("lastBackupAt", nowIso);
      if (backupMarked) {
        setLastBackupAt(nowIso);
        setToast("備份檔案已下載。");
      } else {
        setToast("備份檔案已下載，但備份時間未能同步到雲端；請稍後重試。");
      }
    } catch (e) {
      setToast("匯出失敗，請再試一次。");
    }
    setExporting(false);
  }

  async function importBundleText(text) {
    try {
      const bundle = JSON.parse(text);
      if (!bundle || !Array.isArray(bundle.classIndex) || !bundle.records) {
        setToast("備份內容格式不正確。");
        return;
      }
      if (bundle.schemaVersion && bundle.schemaVersion > 2) {
        setToast("備份版本較新，請先更新系統再匯入。");
        return false;
      }
      const importedEvents = Array.isArray(bundle.calendarEvents)
        ? bundle.calendarEvents.map(normalizeEvent).filter(Boolean).filter((event) => !event.readOnly)
        : null;
      const updates = {};
      const cacheEntries = [];
      const importedClasses = dedupeById(bundle.classIndex);
      updates[keyToPath("classIndex")] = JSON.parse(JSON.stringify(importedClasses));
      cacheEntries.push(["classIndex", importedClasses]);
      for (const c of importedClasses) {
        const rec = bundle.records[c.id];
        if (!rec) continue;
        for (const [name, value] of Object.entries({ attendance: rec.attendance, quiz: rec.quiz, exam: rec.exam, fee: rec.fee })) {
          if (value === undefined || value === null) continue;
          const key = `${name}:${c.id}`;
          updates[keyToPath(key)] = JSON.parse(JSON.stringify(value));
          cacheEntries.push([key, value]);
        }
      }
      if (importedEvents) {
        updates[keyToPath("calendar:events")] = JSON.parse(JSON.stringify(importedEvents));
        cacheEntries.push(["calendar:events", importedEvents]);
      }
      if (Object.keys(updates).length > 0) {
        await dbUpdate(ref(db), updates);
        cacheEntries.forEach(([key, value]) => memoryCache.set(key, value));
      }
      if (importedEvents) setCalendarEvents(importedEvents);
      importClasses(importedClasses);
      setToast(`已從備份還原 ${importedClasses.length} 個班級${importedEvents ? `與 ${importedEvents.length} 個行事曆事件` : ""}。`);
      return true;
    } catch (e) {
      setToast("讀取備份內容失敗，請確認格式沒有被截斷或修改過。");
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
      setToast("讀取備份檔案失敗，手機瀏覽器有時候選檔會失敗，可以試試看下面「貼上備份內容」的方式。");
    }
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
      <TopNav
        view={view}
        setView={setView}
        saveStatus={classIdxSave}
        backupOverdue={backupOverdue}
        onToggleBackup={() => setBackupOpen((v) => !v)}
      />
      <Toast message={toast} onClose={() => setToast(null)} />
      {backupOpen && (
        <div className="view-pad" style={{ paddingBottom: 0 }}>
          <div className="form-card">
            <div className="form-title">資料備份</div>
            <div className="section-hint" style={{ marginBottom: 10 }}>建議定期匯出備份檔存到自己的裝置，避免資料遺失。備份也會包含手動建立的行事曆事件；匯入備份會用檔案內容覆蓋同 ID 的班級，其他班級不受影響。</div>
            <div className="row-actions">
              <button className="btn-primary btn-sm" disabled={exporting} onClick={handleExport}>{exporting ? "匯出中…" : "匯出全部資料"}</button>
              <button className="btn-ghost btn-sm" onClick={() => fileInputRef.current && fileInputRef.current.click()}>選擇備份檔案</button>
              <input ref={fileInputRef} type="file" accept="application/json" style={{ display: "none" }} onChange={handleImportFile} />
            </div>
            <PasteImport onImport={importBundleText} />
          </div>
        </div>
      )}
      {backupOverdue && !backupOpen && (
        <div className="view-pad" style={{ paddingBottom: 0 }}>
          <div className="backup-warning">
            <span>
              {lastBackupAt === null ? "還沒有備份過資料。" : `已經 ${daysSinceBackup} 天沒有備份資料了。`}
              建議定期匯出，避免資料遺失。
            </span>
            <button className="btn-primary btn-sm" onClick={() => setBackupOpen(true)}>立即備份</button>
          </div>
        </div>
      )}
      {view === "today" && (
        <TodayView
          classes={classes.filter((c) => !c.archived)}
          onOpenClass={openClass}
          calendarEvents={allCalendarEvents}
          onAddCalendarEvent={addCalendarEvent}
          onDeleteCalendarEvent={removeCalendarEvent}
          onEditCalendarEvent={updateCalendarEvent}
          calendarReady={calendarReady}
          officialCalendarStatus={officialCalendarStatus}
          calendarSaveState={calendarSave}
          knownSchools={knownSchools}
        />
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

function TopNav({ view, setView, saveStatus, backupOverdue, onToggleBackup }) {
  return (
    <div className="topnav">
      <div className="brand">
        <span className="brand-mark">課</span>
        <span className="brand-text">教學紀錄</span>
      </div>
      <div className="nav-pills nav-pills-center">
        <button className={"pill" + (view === "today" ? " pill-active" : "")} onClick={() => setView("today")}>行事曆</button>
        <button className={"pill" + (view !== "today" ? " pill-active" : "")} onClick={() => setView("classes")}>所有班級</button>
      </div>
      <div className="topnav-actions">
        <SaveIndicator status={saveStatus.status} onRetry={saveStatus.retry} />
        <button className={"pill" + (backupOverdue ? " pill-warning" : "")} onClick={onToggleBackup} title="資料備份">備份{backupOverdue ? " ⚠" : ""}</button>
        <button className="pill logout-pill" onClick={() => signOut(auth)} title="登出">登出</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Today (date/calendar) view                                          */
/* ------------------------------------------------------------------ */

function MonthCalendar({ selected, onSelect, classes, hasSession, calendarEvents, onAddEvent, knownSchools, calendarSaveState }) {
  const selDate = fromDateStr(selected);
  const [viewYear, setViewYear] = useState(selDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(selDate.getMonth());
  const [adding, setAdding] = useState(false);

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
        <div className="calendar-title-group">
          <IconBtn title="上個月" onClick={() => changeMonth(-1)}><ChevronLeft size={18} /></IconBtn>
          <div className="calendar-title">{viewYear} 年 {viewMonth + 1} 月</div>
          <IconBtn title="下個月" onClick={() => changeMonth(1)}><ChevronRight size={18} /></IconBtn>
        </div>
        <div className="calendar-header-actions">
          <SaveIndicator status={calendarSaveState.status} onRetry={calendarSaveState.retry} />
          <button type="button" className="btn-primary btn-sm" onClick={() => setAdding((value) => !value)}>{adding ? "取消新增" : "新增事件"}</button>
        </div>
      </div>
      {adding && <CalendarEventForm date={selected} knownSchools={knownSchools} onCancel={() => setAdding(false)} onCreate={(event) => { onAddEvent(event); setAdding(false); }} />}
      <div className="calendar-weekdays">
        {WEEKDAY_FULL.map((w) => <div key={w} className="calendar-wd">{w}</div>)}
      </div>
      <div className="calendar-grid">
        {cells.map((d, i) => {
          const ds = toDateStr(d);
          const inMonth = d.getMonth() === viewMonth;
          const dayClasses = classes.filter((c) => hasSession(c, ds));
          const dayEvents = eventsOnDate(calendarEvents, ds);
          const hasHoliday = dayEvents.some((event) => event.type === "nationalHoliday");
          const isToday = ds === today;
          const isSelected = ds === selected;
          return (
            <button
              key={i}
              className={"calendar-cell" + (inMonth ? "" : " calendar-cell-out") + (hasHoliday ? " calendar-cell-holiday" : "") + (isSelected ? " calendar-cell-selected" : "") + (isToday ? " calendar-cell-today" : "")}
              onClick={() => onSelect(ds)}
              title={dayEvents.length ? dayEvents.map((event) => event.title).join("、") : formatDisplay(ds)}
              aria-label={`${formatDisplay(ds)}${dayEvents.length ? `：${dayEvents.map((event) => event.title).join("、")}` : ""}`}
            >
              <span className="calendar-cell-num">{d.getDate()}</span>
              {dayClasses.length > 0 && <span className="calendar-cell-dots">{dayClasses.slice(0, 4).map((c) => <span key={c.id} className="dot" style={{ background: colorForClass(c.id) }} />)}</span>}
              {dayEvents.length > 0 && <span className="calendar-cell-event-labels">
                {dayEvents.slice(0, 2).map((event) => {
                  const dates = eventDates(event);
                  const continuous = isContinuousEvent(event);
                  const isStart = dates[0] === ds;
                  const isEnd = dates[dates.length - 1] === ds;
                  const meta = eventTypeMeta(event.type);
                  return <span key={event.id} className={"calendar-event-label" + (continuous ? " calendar-event-label-range" : " calendar-event-label-scattered") + (isStart ? " calendar-event-label-start" : "") + (isEnd ? " calendar-event-label-end" : "")} style={{ color: meta.color, borderColor: meta.color, backgroundColor: event.type === "nationalHoliday" ? "#FFE8E3" : "#F4F1EA" }}>{event.title}</span>;
                })}
                {dayEvents.length > 2 && <span className="calendar-event-more">+{dayEvents.length - 2}</span>}
              </span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CalendarEventsPanel({ date, events, onDelete, onEdit, knownSchools }) {
  const [editingId, setEditingId] = useState(null);
  const dayEvents = eventsOnDate(events, date);

  return (
    <div className="calendar-events-panel">
      <div className="calendar-events-heading">
        <div className="section-label calendar-events-title">{formatDisplay(date)} 的行事</div>
        {dayEvents.length > 0 && <span className="calendar-events-count">{dayEvents.length} 項</span>}
      </div>
      {dayEvents.length === 0 ? (
        <div className="empty-note">尚無節日或事件</div>
      ) : (
        <div className="calendar-event-list">
          {dayEvents.map((event) => {
            const meta = eventTypeMeta(event.type);
            const dates = eventDates(event);
            const schools = event.schools?.length ? event.schools : (event.school ? [event.school] : []);
            if (editingId === event.id) {
              return <CalendarEventForm key={event.id} date={date} initialEvent={event} knownSchools={knownSchools} onCancel={() => setEditingId(null)} onCreate={(updated) => { onEdit(event.id, updated); setEditingId(null); }} />;
            }
            return (
              <div className="calendar-event-row" key={event.id} title={dates.length > 1 ? `共 ${dates.length} 天` : event.title}>
                <span className="event-dot event-dot-large" style={{ background: meta.color }} />
                <div className="calendar-event-body">
                  <span className="calendar-event-name">{event.title}</span>
                  {schools.length > 0 && <span className="calendar-event-schools">{schools.join("、")}</span>}
                </div>
                {dates.length > 1 && <span className="calendar-event-duration">{dates.length}日</span>}
                {!event.readOnly && <button type="button" className="btn-ghost btn-xs" onClick={() => setEditingId(event.id)}>編輯</button>}
                {!event.readOnly && <ConfirmDelete label="刪除這個事件？" onConfirm={() => onDelete(event.id)} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CalendarEventForm({ date, initialEvent, knownSchools, onCancel, onCreate }) {
  const initialDates = eventDates(initialEvent || { date });
  const [dateInput, setDateInput] = useState(initialDates[0] || date);
  const [rangeEndDate, setRangeEndDate] = useState(initialDates[initialDates.length - 1] || date);
  const [selectedDates, setSelectedDates] = useState(initialDates.length ? initialDates : [date]);
  const [title, setTitle] = useState(initialEvent?.title || "");
  const [type, setType] = useState(initialEvent?.type || "schoolExam");
  const [schools, setSchools] = useState(initialEvent?.schools?.length ? initialEvent.schools : (initialEvent?.school ? [initialEvent.school] : []));
  const [note, setNote] = useState(initialEvent?.note || "");

  function addDates(dates) {
    setSelectedDates((current) => [...new Set([...current, ...dates].filter(Boolean))].sort());
  }

  function addSingleDate() {
    addDates([dateInput]);
  }

  function addDateRange() {
    if (!dateInput || !rangeEndDate || rangeEndDate < dateInput) return;
    addDates(eventDates({ date: dateInput, endDate: rangeEndDate }));
  }

  function removeDate(value) {
    if (selectedDates.length === 1) return;
    setSelectedDates((current) => current.filter((item) => item !== value));
  }

  function submit() {
    const cleanTitle = title.trim();
    if (!cleanTitle || selectedDates.length === 0) return;
    onCreate({ date: selectedDates[0], endDate: selectedDates[selectedDates.length - 1], dates: selectedDates, title: cleanTitle, type, schools, note, source: "手動建立" });
  }

  return (
    <div className="form-card calendar-event-form">
      <div className="form-grid">
        <label className="field"><span>事件名稱</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例：第一次段考" autoFocus /></label>
        <label className="field"><span>類型</span><select value={type} onChange={(e) => setType(e.target.value)}>{["schoolExam", "fieldTrip", "majorExam", "other"].map((value) => <option value={value} key={value}>{eventTypeMeta(value).label}</option>)}</select></label>
        <div className="field calendar-date-picker-field"><span>加入日期</span><div className="calendar-date-picker-row"><input type="date" value={dateInput} onChange={(e) => setDateInput(e.target.value)} /><button type="button" className="btn-ghost btn-sm" onClick={addSingleDate}>加入單日</button></div></div>
        <div className="field calendar-date-picker-field"><span>加入連續區間</span><div className="calendar-date-picker-row"><input type="date" min={dateInput} value={rangeEndDate} onChange={(e) => setRangeEndDate(e.target.value)} /><button type="button" className="btn-ghost btn-sm" disabled={!dateInput || !rangeEndDate || rangeEndDate < dateInput} onClick={addDateRange}>加入區間</button></div></div>
        <div className="field calendar-schools-field"><span>適用學校（可複選）</span><details className="school-multi-picker"><summary>{schools.length ? `已選 ${schools.length} 所學校` : "全部學校"}</summary><div className="school-multi-options">{(knownSchools || []).length === 0 ? <span className="section-hint">目前沒有可選學校</span> : (knownSchools || []).map((name) => <label key={name}><input type="checkbox" checked={schools.includes(name)} onChange={() => setSchools((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name])} />{name}</label>)}</div></details></div>
        <label className="field calendar-event-note-field"><span>備註（選填）</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例：以學校公告為準" /></label>
      </div>
      <div className="calendar-selected-dates"><span className="calendar-selected-dates-label">已選 {selectedDates.length} 日</span>{selectedDates.map((value) => <span className="calendar-date-chip" key={value}>{value}<button type="button" onClick={() => removeDate(value)} aria-label={`移除 ${value}`} disabled={selectedDates.length === 1}><X size={11} /></button></span>)}</div>
      <div className="form-actions">
        <button type="button" className="btn-ghost" onClick={onCancel}>取消</button>
        <button type="button" className="btn-primary" disabled={!title.trim() || selectedDates.length === 0} onClick={submit}>儲存事件</button>
      </div>
    </div>
  );
}

function TodayView({ classes, onOpenClass, calendarEvents, onAddCalendarEvent, onDeleteCalendarEvent, onEditCalendarEvent, calendarReady, officialCalendarStatus, calendarSaveState, knownSchools }) {
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
  const selectedDayEvents = eventsOnDate(calendarEvents, selected);

  return (
    <div className="view-pad">
      <MonthCalendar selected={selected} onSelect={setSelected} classes={classes} hasSession={hasSession} calendarEvents={calendarEvents} onAddEvent={onAddCalendarEvent} knownSchools={knownSchools} calendarSaveState={calendarSaveState} />

      {selectedDayEvents.length > 0 && <CalendarEventsPanel date={selected} events={calendarEvents} onDelete={onDeleteCalendarEvent} onEdit={onEditCalendarEvent} knownSchools={knownSchools} />}

      <div className="section-label">{formatDisplay(selected)} 上課班級</div>
      {matches.length === 0 && <div className="empty-note">這天沒有排定的課。</div>}
      <div className="card-list">
        {matches.map(({ c, time }) => (
          <button key={c.id} className="class-card" onClick={() => onOpenClass(c.id, "attendance", selected)}>
            <div className="class-card-dot" style={{ background: colorForClass(c.id) }} />
            <div className="class-card-body">
              <div className="class-card-title">{c.name}</div>
              <div className="class-card-sub">{c.subject}{c.grade ? ` · ${c.grade}` : ""} · {activeStudentCount(c)} 位學生</div>
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

function ClassesView({ classes, showArchived, setShowArchived, onOpenClass, onAddClass, onArchive, onDelete }) {
  const [creating, setCreating] = useState(false);

  const list = classes
    .filter((c) => !!c.archived === showArchived)
    .map((c) => ({ c, next: nextSessionInfo(c, todayStr()) }))
    .sort((a, b) => {
      if (a.next.daysUntil !== b.next.daysUntil) return a.next.daysUntil - b.next.daysUntil;
      return parseTimeMinutes(a.next.startTime) - parseTimeMinutes(b.next.startTime);
    })
    .map((x) => x.c);

  return (
    <div className="view-pad">
      <div className="row-between">
        <div className="nav-pills nav-pills-sub">
          <button className={"pill pill-sm" + (!showArchived ? " pill-active" : "")} onClick={() => setShowArchived(false)}>進行中</button>
          <button className={"pill pill-sm" + (showArchived ? " pill-active" : "")} onClick={() => setShowArchived(true)}>已封存</button>
        </div>
        <div className="row-actions">
          {!showArchived && (
            <button className="btn-primary btn-sm" onClick={() => setCreating(true)}><Plus size={16} /> 新增班級</button>
          )}
        </div>
      </div>

      {creating && (
        <NewClassForm onCancel={() => setCreating(false)} onCreate={(cls) => { onAddClass(cls); setCreating(false); }} />
      )}

      <div className="card-list" style={{ marginTop: 12 }}>
        {list.map((c) => (
          <div key={c.id} className="class-card class-card-static">
            <div className="class-card-dot" style={{ background: colorForClass(c.id) }} />
            <button className="class-card-body class-card-clickable" onClick={() => onOpenClass(c.id)}>
              <div className="class-card-title">{c.name}</div>
              <div className="class-card-sub">{c.subject}{c.grade ? ` · ${c.grade}` : ""} · {activeStudentCount(c)} 位學生 · {scheduleSummary(c)}</div>
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
          <div className="detail-sub">{cls.subject}{cls.grade ? ` · ${cls.grade}` : ""}</div>
          <div className="detail-schedule">
            {scheduleLines(cls).map((line, i) => (
              <div className="detail-schedule-line" key={i}>
                <span className="detail-schedule-day">{line.day}</span>
                {line.time && <span className="detail-schedule-time">{line.time}</span>}
              </div>
            ))}
          </div>
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

  const saveState = useDebouncedSave(data, storageKeyName, ready);

  const dayData = { note: "", content: "", records: {}, ...(data[date] || {}) };
  const session = getSessionInfo(cls, date);
  const isSession = isSessionDay(cls, date, data);
  const boundary = earliestScheduledDate(cls, Object.keys(data).filter((k) => hasSessionRecord(data, k)));
  const atStart = !!(boundary && date <= boundary);

  function setDay(updater) {
    setData((prev) => {
      const base = { note: "", content: "", records: {}, ...(prev[date] || {}) };
      if (!base.records) base.records = {};
      return { ...prev, [date]: updater(base) };
    });
  }
  function setStatusFor(studentId, value) {
    const wholeDayStatus = value === "延課" || value === "假期";
    if (wholeDayStatus) {
      setDay((d) => ({
        ...d,
        records: Object.fromEntries(
          cls.students.filter((s) => membershipAtDate(s, date, data) !== "stopped").map((s) => [s.id, value])
        ),
      }));
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
    setDay((d) => ({
      ...d,
      note: cancelReason,
      records: Object.fromEntries(
        cls.students.filter((s) => membershipAtDate(s, date, data) !== "stopped").map((s) => [s.id, "延課"])
      ),
    }));
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
        <SaveIndicator status={saveState.status} onRetry={saveState.retry} />
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

function ScoreMetric({ label, value, detail, tone }) {
  return (
    <div className={"score-metric" + (tone ? ` score-metric-${tone}` : "")}>
      <span className="score-metric-label">{label}</span>
      <strong className="score-metric-value">{value}</strong>
      {detail && <span className="score-metric-detail">{detail}</span>}
    </div>
  );
}

function ScoreOverview({ unitLabel, classAvg, classMedian, classMax, classMin, passRate, completionRate, scoreDistribution }) {
  const hasScores = scoreDistribution.some((band) => band.count > 0);
  return (
    <div className="score-dashboard">
      <div className="score-dashboard-heading">
        <div>
          <div className="section-hint">{unitLabel}整體表現</div>
          <div className="score-dashboard-title">看平均，也看分布與完成度</div>
        </div>
        <span className="score-dashboard-note">分數色帶以 100 分量尺顯示 · 僅統計目前篩選範圍</span>
      </div>
      <div className="score-metric-grid">
        <ScoreMetric label="平均" value={fmtNum(classAvg)} detail="全班平均" tone="primary" />
        <ScoreMetric label="中位數" value={fmtNum(classMedian)} detail="一半高於此分數" />
        <ScoreMetric label="最高／最低" value={`${fmtNum(classMax)} / ${fmtNum(classMin)}`} detail="目前已填分數" />
        <ScoreMetric label="及格率" value={passRate === null ? "—" : `${passRate}%`} detail="分數 ≥ 60" tone={passRate !== null && passRate >= 60 ? "positive" : "warning"} />
        <ScoreMetric label="填寫率" value={completionRate === null ? "—" : `${completionRate}%`} detail="已填／應填" />
      </div>
      <div className="score-distribution">
        <div className="score-section-title">分數分布</div>
        {!hasScores ? <div className="empty-note">尚未填入分數。</div> : (
          <div className="score-distribution-list">
            {scoreDistribution.map((band) => (
              <div className="score-distribution-row" key={band.key}>
                <span className="score-distribution-label">{band.label}</span>
                <div className="score-distribution-track"><span className="score-distribution-fill" style={{ width: `${band.percent}%`, background: band.color }} /></div>
                <span className="score-distribution-count">{band.count} 人 <small>{band.percent}%</small></span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ScoreLeaderboard({ leaderboard }) {
  if (leaderboard.length === 0) return null;
  return (
    <div className="score-leaderboard">
      <div className="score-section-title">個別表現</div>
      <div className="score-leaderboard-list">
        {leaderboard.map(({ student, avg, count, delta, latest, pr }, index) => {
          const band = scoreBand(avg);
          const deltaText = delta === null ? "—" : `${delta > 0 ? "+" : ""}${fmtNum(delta)}`;
          return (
            <div className="score-leaderboard-row" key={student.id}>
              <span className="score-leaderboard-rank">{index + 1}</span>
              <div className="score-leaderboard-main">
                <div className="score-leaderboard-name">{student.name}<span className="score-leaderboard-count">{count} 次</span></div>
                <div className="score-leaderboard-track"><span className="score-leaderboard-fill" style={{ width: `${scorePercent(avg)}%`, background: band?.color || "var(--brass)" }} /></div>
              </div>
              <strong className="score-leaderboard-score">{fmtNum(avg)}</strong>
              <span className={"score-leaderboard-delta" + (delta > 0 ? " is-up" : delta < 0 ? " is-down" : "")}>{deltaText}</span>
              <span className="score-leaderboard-pr">PR {pr === null ? "—" : pr}</span>
              <span className="score-leaderboard-latest">最近 {fmtNum(latest)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AssessmentTab({ cls, storageKeyName, unitLabel, withSegment, withRank }) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDate, setNewDate] = useState(todayStr());
  const [newSubject, setNewSubject] = useState("");
  const [newSegment, setNewSegment] = useState("");
  const [subjectFilter, setSubjectFilter] = useState("all");
  const [segmentFilter, setSegmentFilter] = useState("all");
  const [focusStudentId, setFocusStudentId] = useState("");
  const [editingColumnId, setEditingColumnId] = useState(null);
  const [editingColumnName, setEditingColumnName] = useState("");

  const hasSubjects = (cls.subjects || []).length > 0;

  const [data, setData, ready] = useCachedStore(storageKeyName, { columns: [], scores: {} });

  const saveState = useDebouncedSave(data, storageKeyName, ready);

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
    if (editingColumnId === colId) {
      setEditingColumnId(null);
      setEditingColumnName("");
    }
  }
  function startEditingColumn(col) {
    setEditingColumnId(col.id);
    setEditingColumnName(col.name || "");
  }
  function cancelEditingColumn() {
    setEditingColumnId(null);
    setEditingColumnName("");
  }
  function saveColumnName(colId) {
    const nextName = editingColumnName.trim();
    if (!nextName) return;
    setData((prev) => ({
      ...prev,
      columns: prev.columns.map((col) => (col.id === colId ? { ...col, name: nextName } : col)),
    }));
    cancelEditingColumn();
  }
  function handleColumnNameKeyDown(event, colId) {
    if (event.key === "Enter") {
      event.preventDefault();
      saveColumnName(colId);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEditingColumn();
    }
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

  // 已停班的學生：只有在這個班曾經留下成績資料時才繼續顯示（保留歷史紀錄），
  // 否則不出現在名單裡（例如停班之後才新增的考試）。
  const hasAnyScoreEverywhere = (s) =>
    data.columns.some((col) => {
      const v = (data.scores[col.id] || {})[s.id]?.score;
      return v !== undefined && v !== "";
    });
  const rosterStudents = cls.students.filter((s) => getMembership(s) !== "stopped" || hasAnyScoreEverywhere(s));

  const pooled = [];
  filteredColumns.forEach((col) => {
    rosterStudents.forEach((s) => {
      const v = (data.scores[col.id] || {})[s.id]?.score;
      if (v !== undefined && v !== "" && !Number.isNaN(Number(v))) pooled.push(Number(v));
    });
  });
  const classAvg = mean(pooled);
  const classStd = stddev(pooled);
  const classMedian = median(pooled);
  const classMax = pooled.length ? Math.max(...pooled) : null;
  const classMin = pooled.length ? Math.min(...pooled) : null;
  const passCount = pooled.filter((value) => value >= 60).length;
  const possibleScores = rosterStudents.length * filteredColumns.length;
  const completionRate = possibleScores ? Math.round((pooled.length / possibleScores) * 1000) / 10 : null;
  const passRate = pooled.length ? Math.round((passCount / pooled.length) * 1000) / 10 : null;
  const scoreDistribution = buildScoreDistribution(pooled);

  const columnStats = filteredColumns.map((col) => {
    const values = rosterStudents
      .map((s) => (data.scores[col.id] || {})[s.id]?.score)
      .map(numericScore)
      .filter((value) => value !== null);
    return { col, values, avg: mean(values), median: median(values), highest: values.length ? Math.max(...values) : null, lowest: values.length ? Math.min(...values) : null, count: values.length };
  });

  const studentStatsBase = rosterStudents.map((s) => {
    const vals = filteredColumns
      .map((col) => (data.scores[col.id] || {})[s.id]?.score)
      .filter((v) => v !== undefined && v !== "" && !Number.isNaN(Number(v)))
      .map(Number);
    const improvement =
      vals.length >= 2 && vals[0] !== 0 ? Math.round(((vals[vals.length - 1] - vals[0]) / Math.abs(vals[0])) * 1000) / 10 : null;
    const delta = scoreDelta(vals).delta;
    return { student: s, avg: mean(vals), std: stddev(vals), count: vals.length, improvement, delta, latest: vals.at(-1) ?? null, highest: vals.length ? Math.max(...vals) : null, lowest: vals.length ? Math.min(...vals) : null };
  });
  const sortedAvgs = studentStatsBase.filter((s) => s.count > 0).map((s) => s.avg).sort((a, b) => a - b);
  const studentStats = studentStatsBase.map((s) => {
    if (s.count === 0 || sortedAvgs.length < 2) return { ...s, pr: null };
    const below = sortedAvgs.filter((a) => a < s.avg).length;
    return { ...s, pr: Math.round((below / (sortedAvgs.length - 1)) * 100) };
  });
  const leaderboard = studentStats.filter((s) => s.count > 0).sort((a, b) => b.avg - a.avg || a.student.name.localeCompare(b.student.name, "zh-Hant"));

  const chartData = filteredColumns.map((col) => {
    const colVals = rosterStudents
      .map((s) => (data.scores[col.id] || {})[s.id]?.score)
      .filter((v) => v !== undefined && v !== "" && !Number.isNaN(Number(v)))
      .map(Number);
    const row = { name: col.name, 班平均: mean(colVals) };
    if (focusStudentId) {
      const v = (data.scores[col.id] || {})[focusStudentId]?.score;
      row[rosterStudents.find((s) => s.id === focusStudentId)?.name || "個人"] =
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
          <SaveIndicator status={saveState.status} onRetry={saveState.retry} />
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
          <ScoreOverview
            unitLabel={unitLabel}
            classAvg={classAvg}
            classMedian={classMedian}
            classMax={classMax}
            classMin={classMin}
            passRate={passRate}
            completionRate={completionRate}
            scoreDistribution={scoreDistribution}
          />

          <div className="assessment-column-section">
            <div className="score-section-title">各次{unitLabel}比較</div>
            <div className="assessment-column-strip">
              {columnStats.map(({ col, avg, median: columnMedian, highest, lowest, count }) => {
                const band = scoreBand(avg);
                return (
                  <div className="assessment-column-card" key={col.id}>
                    <div className="assessment-column-card-top">
                      <div className="assessment-column-name">{col.name}</div>
                      <span className="assessment-column-count">{count}/{rosterStudents.length} 人</span>
                    </div>
                    <div className="assessment-column-date">{col.date}{col.subject ? ` · ${col.subject}` : ""}</div>
                    <div className="assessment-column-score-row">
                      <strong>{fmtNum(avg)}</strong>
                      <span>平均</span>
                    </div>
                    <div className="assessment-column-bar"><span style={{ width: `${scorePercent(avg)}%`, background: band?.color || "var(--brass)" }} /></div>
                    <div className="assessment-column-range">中位 {fmtNum(columnMedian)} · {fmtNum(lowest)}–{fmtNum(highest)}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <ScoreLeaderboard leaderboard={leaderboard} />

          <div className="stats-panel">
            <div className="stats-row-head">
              <span>全班平均</span><span>{fmtNum(classAvg)}</span>
              <span>標準差</span><span>{fmtNum(classStd)}</span>
            </div>
            <div className="stats-table stats-table-scroll">
              <div className="stats-table-row-8 stats-table-head"><span>學生</span><span>平均</span><span>最新</span><span>變化</span><span>班均差</span><span>最高</span><span>最低</span><span>PR</span></div>
              {studentStats.map(({ student, avg, std, count, pr, delta, latest, highest, lowest }) => {
                const relativeToClass = avg !== null && classAvg !== null ? avg - classAvg : null;
                return (
                  <div className="stats-table-row-8" key={student.id}>
                    <span title={std === null ? "尚無足夠資料計算標準差" : `標準差 ${fmtNum(std)}`}>{student.name}</span>
                    <span>{count ? fmtNum(avg) : "—"}</span>
                    <span>{fmtNum(latest)}</span>
                    <span className={delta > 0 ? "stat-positive" : delta < 0 ? "stat-negative" : ""}>{delta === null ? "—" : `${delta > 0 ? "+" : ""}${fmtNum(delta)}`}</span>
                    <span className={relativeToClass > 0 ? "stat-positive" : relativeToClass < 0 ? "stat-negative" : ""}>{relativeToClass === null ? "—" : `${relativeToClass > 0 ? "+" : ""}${fmtNum(relativeToClass)}`}</span>
                    <span>{fmtNum(highest)}</span>
                    <span>{fmtNum(lowest)}</span>
                    <span>{pr !== null ? pr : "—"}</span>
                  </div>
                );
              })}
            </div>
            <div className="section-hint" style={{ marginTop: 6 }}>變化：篩選範圍內第一次到最後一次的分數差；班均差：個人平均減全班平均。各欄的標準差可將游標移到學生姓名查看。</div>
          </div>

          <div className="chart-card">
            <div className="row-between" style={{ marginBottom: 6 }}>
              <span className="section-hint">成績趨勢</span>
              <select className="filter-select" value={focusStudentId} onChange={(e) => setFocusStudentId(e.target.value)}>
                <option value="">只看全班平均</option>
                {rosterStudents.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
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
                  <Line type="monotone" dataKey={rosterStudents.find((s) => s.id === focusStudentId)?.name || "個人"} stroke={CHART_COLORS[1]} strokeWidth={2} connectNulls dot={{ r: 3 }} />
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
                      {editingColumnId === col.id ? (
                        <div className="assessment-name-editor">
                          <input className="assessment-name-input" value={editingColumnName} onChange={(event) => setEditingColumnName(event.target.value)} onKeyDown={(event) => handleColumnNameKeyDown(event, col.id)} aria-label={`修改${unitLabel}名稱`} autoFocus />
                          <div className="assessment-name-editor-actions">
                            <button className="btn-primary btn-xs" onClick={() => saveColumnName(col.id)} disabled={!editingColumnName.trim()}>儲存</button>
                            <button className="btn-ghost btn-xs" onClick={cancelEditingColumn}>取消</button>
                          </div>
                        </div>
                      ) : (
                        <div className="matrix-col-head-top">
                          <div className="matrix-col-name">{col.name}</div>
                          <div className="matrix-col-head-actions">
                            <IconBtn title={`修改${unitLabel}「${col.name}」名稱`} onClick={() => startEditingColumn(col)}><Pencil size={14} /></IconBtn>
                            <ConfirmDelete title={`刪除${unitLabel}「${col.name}」`} label="刪除這項？" onConfirm={() => removeColumn(col.id)} />
                          </div>
                        </div>
                      )}
                      <div className="matrix-col-date">{col.date}{col.subject ? ` · ${col.subject}` : ""}{col.segment ? ` · ${col.segment}` : ""}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rosterStudents.map((s) => (
                  <tr key={s.id}>
                    <td className="matrix-row-head">{s.name}</td>
                    {filteredColumns.map((col) => {
                      const cell = (data.scores[col.id] || {})[s.id] || {};
                      const band = scoreBand(cell.score);
                      return (
                        <td key={col.id} className="matrix-cell">
                          <input className={"matrix-input" + (band ? ` matrix-input-band-${band.key}` : "")} inputMode="decimal" value={cell.score ?? ""} onChange={(e) => setCell(col.id, s.id, "score", e.target.value)} placeholder="分數" aria-label={`${s.name} ${col.name}分數`} />
                          {withRank && <input className="matrix-input matrix-input-sub" value={cell.rank ?? ""} onChange={(e) => setCell(col.id, s.id, "rank", e.target.value)} placeholder="班排/校排" aria-label={`${s.name} ${col.name}班排或校排`} />}
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
function isOverdue(c) { return !c.paid && c.periodEnd && c.periodEnd < todayStr(); }

function FeeTab({ cls }) {
  const [adding, setAdding] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all"); // all | unpaid | paid
  const [studentFilter, setStudentFilter] = useState(null); // studentId | null
  const storageKeyName = `fee:${cls.id}`;
  const [data, setData, ready] = useCachedStore(storageKeyName, { charges: [] });

  const saveState = useDebouncedSave(data, storageKeyName, ready);

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

  // Build per-student status so it's possible to see at a glance who has
  // paid, who hasn't, and who's overdue — instead of scanning a flat
  // chronological list.
  const perStudent = cls.students.map((s) => {
    const charges = data.charges.filter((c) => c.studentId === s.id);
    const unpaid = charges.filter((c) => !c.paid);
    const overdue = unpaid.filter(isOverdue);
    const unpaidTotal = unpaid.reduce((sum, c) => sum + num(c.tuition) + num(c.materials) - num(c.discount), 0);
    const overdueTotal = overdue.reduce((sum, c) => sum + num(c.tuition) + num(c.materials) - num(c.discount), 0);
    const paidTotal = charges.filter((c) => c.paid).reduce((sum, c) => sum + num(c.tuition) + num(c.materials) - num(c.discount), 0);
    const state = overdue.length > 0 ? "overdue" : unpaid.length > 0 ? "unpaid" : charges.length > 0 ? "paid" : "none";
    return { student: s, charges, unpaidCount: unpaid.length, unpaidTotal, overdueCount: overdue.length, overdueTotal, paidTotal, state };
  }).filter((row) => row.state !== "none" || getMembership(row.student) !== "stopped");

  const order = { overdue: 0, unpaid: 1, none: 2, paid: 3 };
  const overview = perStudent.slice().sort((a, b) => order[a.state] - order[b.state] || a.student.name.localeCompare(b.student.name, "zh-Hant"));

  const overdueCountTotal = perStudent.filter((r) => r.state === "overdue").length;
  const overdueAmountTotal = perStudent.reduce((sum, r) => sum + r.overdueTotal, 0);
  const unpaidNotOverdueCountTotal = perStudent.filter((r) => r.state === "unpaid").length;
  const unpaidNotOverdueAmountTotal = perStudent.reduce((sum, r) => sum + (r.unpaidTotal - r.overdueTotal), 0);
  const paidAmountTotal = perStudent.reduce((sum, r) => sum + r.paidTotal, 0);

  function toggleStudentFilter(id) {
    setStudentFilter((prev) => (prev === id ? null : id));
  }

  let filtered = data.charges;
  if (statusFilter === "unpaid") filtered = filtered.filter((c) => !c.paid && !isOverdue(c));
  if (statusFilter === "overdue") filtered = filtered.filter(isOverdue);
  if (statusFilter === "paid") filtered = filtered.filter((c) => c.paid);
  if (studentFilter) filtered = filtered.filter((c) => c.studentId === studentFilter);
  const sorted = filtered.slice().sort((a, b) => (b.periodStart || "").localeCompare(a.periodStart || ""));

  return (
    <div>
      <div className="row-between" style={{ marginTop: 10 }}>
        <span className="section-hint">收費區間、金額、教材費、折扣，總金額自動計算</span>
        <div className="row-actions">
          <SaveIndicator status={saveState.status} onRetry={saveState.retry} />
          <button className="btn-primary btn-sm" onClick={() => setAdding(true)}><Plus size={16} /> 新增收費</button>
        </div>
      </div>

      {adding && <NewChargeForm students={cls.students.filter((s) => getMembership(s) !== "stopped")} onCancel={() => setAdding(false)} onCreate={addCharge} />}

      <div className="fee-overview" style={{ marginTop: 14 }}>
        <div className="fee-overview-stats">
          <span className="fee-stat fee-stat-overdue">逾期 {overdueCountTotal} 人・${overdueAmountTotal}</span>
          <span className="fee-stat fee-stat-bad">未收（未逾期）{unpaidNotOverdueCountTotal} 人・${unpaidNotOverdueAmountTotal}</span>
          <span className="fee-stat fee-stat-good">已收金額 ${paidAmountTotal}</span>
        </div>
        <div className="fee-chip-grid">
          {overview.map(({ student, unpaidTotal, overdueTotal, state }) => (
            <button
              key={student.id}
              type="button"
              className={"fee-chip fee-chip-" + state + (studentFilter === student.id ? " fee-chip-active" : "")}
              onClick={() => toggleStudentFilter(student.id)}
              title={state === "overdue" ? `逾期 $${overdueTotal}` : state === "unpaid" ? `未收 $${unpaidTotal}` : state === "paid" ? "已收清" : "尚無收費紀錄"}
            >
              <span className="fee-chip-name">{student.name}</span>
              <span className="fee-chip-status">
                {state === "overdue" ? `逾期 $${overdueTotal}` : state === "unpaid" ? `未收 $${unpaidTotal}` : state === "paid" ? "已收清" : "無紀錄"}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="row-between" style={{ marginTop: 14 }}>
        <div className="segmented">
          <button className={"segmented-btn" + (statusFilter === "all" ? " active" : "")} onClick={() => setStatusFilter("all")}>全部</button>
          <button className={"segmented-btn" + (statusFilter === "overdue" ? " active" : "")} onClick={() => setStatusFilter("overdue")}>逾期</button>
          <button className={"segmented-btn" + (statusFilter === "unpaid" ? " active" : "")} onClick={() => setStatusFilter("unpaid")}>未收</button>
          <button className={"segmented-btn" + (statusFilter === "paid" ? " active" : "")} onClick={() => setStatusFilter("paid")}>已收</button>
        </div>
        {studentFilter && (
          <button className="btn-ghost btn-xs" onClick={() => setStudentFilter(null)}>
            清除「{cls.students.find((s) => s.id === studentFilter)?.name}」篩選
          </button>
        )}
      </div>

      <div className="card-list" style={{ marginTop: 12 }}>
        {sorted.map((c) => {
          const student = cls.students.find((s) => s.id === c.studentId);
          const total = num(c.tuition) + num(c.materials) - num(c.discount);
          const overdue = isOverdue(c);
          return (
            <div key={c.id} className="fee-card">
              <div className="fee-card-top">
                <div>
                  <div className="fee-card-name">{student ? student.name : "（已移除的學生）"}</div>
                  <div className="fee-card-period">{c.periodStart || "?"} ～ {c.periodEnd || "?"}</div>
                </div>
                <span className={"tag " + (c.paid ? "tag-good" : overdue ? "tag-overdue" : "tag-bad")}>
                  {c.paid ? `已收 ${c.paidDate}` : overdue ? "逾期" : "未收"}
                </span>
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
        {sorted.length === 0 && <div className="empty-note">{data.charges.length === 0 ? "尚未新增任何收費紀錄。" : "沒有符合篩選條件的收費紀錄。"}</div>}
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
.nav-pills-center { margin: 0 auto; }
.nav-pills-sub { margin-bottom: 2px; }
.pill { border: 1px solid var(--line); background: var(--card); padding: 7px 14px; border-radius: 999px; font-size: 13px; color: var(--ink-soft); cursor: pointer; font-family: inherit; }
.pill-sm { padding: 5px 12px; font-size: 12px; }
.pill-active { background: var(--ink); color: white; border-color: var(--ink); }
.pill-warning { background: #FBEAE9; color: #8C332E; border-color: #F0C6C3; }

.topnav-actions { display: flex; align-items: center; gap: 10px; }
  .save-indicator { font-size: 11px; color: var(--ink-soft); font-family: 'IBM Plex Mono', monospace; white-space: nowrap; }
  .save-indicator-error { border: none; background: none; color: #B23A34; cursor: pointer; font-family: inherit; padding: 0; text-decoration: underline; }

.toast { position: sticky; top: 58px; z-index: 9; margin: 0 16px 0; max-width: 688px; margin-left: auto; margin-right: auto; background: var(--ink); color: white; border-radius: 10px; padding: 10px 14px; font-size: 12.5px; display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }
.toast button { background: none; border: none; color: white; opacity: 0.7; cursor: pointer; display: flex; }

.backup-warning { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: #FBEAE9; border: 1px solid #F0C6C3; color: #8C332E; border-radius: 10px; padding: 10px 14px; font-size: 12.5px; margin-bottom: 12px; flex-wrap: wrap; }

.view-pad { padding: 16px; max-width: 720px; margin: 0 auto; }

.section-label { font-family: 'Noto Serif TC', serif; font-weight: 700; font-size: 15px; margin: 18px 0 10px; }
.section-hint { font-size: 12px; color: var(--ink-soft); }

.calendar { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px; }
.calendar-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.calendar-title-group { display: flex; align-items: center; gap: 5px; min-width: 0; }
.calendar-title { font-family: 'Noto Serif TC', serif; font-weight: 700; font-size: 15px; white-space: nowrap; }
.calendar-header-actions { display: flex; align-items: center; justify-content: flex-end; gap: 7px; min-width: 0; }
.calendar-weekdays { display: grid; grid-template-columns: repeat(7,1fr); text-align: center; font-size: 11px; color: var(--ink-soft); margin-bottom: 4px; }
.calendar-grid { display: grid; grid-template-columns: repeat(7,1fr); gap: 3px; }
.calendar-cell { min-height: 74px; border: 1px solid transparent; background: none; border-radius: 9px; display: flex; flex-direction: column; align-items: stretch; justify-content: flex-start; gap: 3px; padding: 6px 3px 4px; cursor: pointer; font-family: inherit; overflow: hidden; }
.calendar-cell-num { font-family: 'IBM Plex Mono', monospace; font-size: 12px; text-align: center; }
.calendar-cell-out { opacity: 0.38; }
.calendar-cell-dots { display: flex; align-self: center; gap: 2px; height: 5px; }
.calendar-cell-event-labels { display: flex; flex-direction: column; align-items: stretch; gap: 2px; width: 100%; min-height: 0; overflow: hidden; }
.calendar-event-label { display: block; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; border-left: 3px solid; border-radius: 3px; padding: 2px 3px; font-size: 9px; line-height: 1.2; text-align: left; }
.calendar-event-label-range { background: #F0EAF5 !important; }
.calendar-event-label-scattered { border-style: dashed; }
.calendar-event-label-start { border-top-left-radius: 6px; border-bottom-left-radius: 6px; }
.calendar-event-label-end { border-top-right-radius: 6px; border-bottom-right-radius: 6px; }
.calendar-event-more { color: var(--ink-soft); font-size: 9px; text-align: left; padding-left: 4px; }
.calendar-cell-holiday { background: #FFF1EE; color: #8C332E; }
.calendar-cell-selected { border-color: var(--ink); background: #F1F1EE; }
.calendar-cell-selected.calendar-cell-holiday { background: #FFE1DC; }
.calendar-cell-today { box-shadow: 0 0 0 2px var(--brass-soft); border-color: var(--brass); }
.dot, .event-dot { width: 5px; height: 5px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.event-dot-large { width: 9px; height: 9px; margin-top: 4px; }
.calendar-events-panel { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; margin-top: 14px; }
.calendar-events-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.calendar-events-title { margin: 0; }
.calendar-events-count, .calendar-event-duration { color: var(--ink-soft); font-size: 11px; font-family: 'IBM Plex Mono', monospace; white-space: nowrap; }
.calendar-event-list { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
.calendar-event-row { display: flex; align-items: center; gap: 9px; padding: 6px 0; border-top: 1px solid var(--line); }
.calendar-event-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.calendar-event-name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; font-weight: 700; }
.calendar-event-schools { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--ink-soft); font-size: 11px; }
.calendar-event-form { margin-top: 10px; }
  .calendar-event-note-field { grid-column: 1 / -1; }
  .calendar-schools-field { min-width: 0; grid-column: 1 / -1; }
  .school-multi-picker { position: relative; }
  .school-multi-picker summary { list-style: none; border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; background: var(--card); color: var(--ink); font-size: 13px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .school-multi-picker summary::-webkit-details-marker { display: none; }
  .school-multi-picker[open] summary { border-color: var(--brass); }
  .school-multi-options { position: absolute; z-index: 3; left: 0; right: 0; display: flex; flex-direction: column; gap: 3px; max-height: 190px; overflow: auto; margin-top: 4px; padding: 7px 9px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 8px 20px rgba(33,38,43,0.12); }
  .school-multi-options label { display: flex; align-items: center; gap: 7px; width: 100%; min-height: 27px; padding: 2px; font-size: 12px; white-space: nowrap; }
  .school-multi-options input { accent-color: var(--brass); }
  .calendar-date-picker-row { display: flex; align-items: center; gap: 6px; }
  .calendar-date-picker-row input { min-width: 0; flex: 1; }
  .calendar-selected-dates { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 10px; }
  .calendar-selected-dates-label { color: var(--ink-soft); font-size: 11px; }
  .calendar-date-chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line); border-radius: 999px; padding: 4px 7px; background: #F8F5EE; color: var(--ink-soft); font-size: 11px; font-family: 'IBM Plex Mono', monospace; }
  .calendar-date-chip button { display: inline-flex; align-items: center; border: 0; padding: 0; background: none; color: var(--ink-soft); }
  .calendar-date-chip button:disabled { opacity: 0.35; cursor: default; }
  .btn-xs { padding: 4px 7px; font-size: 11px; }

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
.detail-schedule { margin-top: 3px; display: flex; flex-direction: column; gap: 1px; }
.detail-schedule-line { display: flex; flex-wrap: wrap; gap: 2px 8px; font-size: 12px; color: var(--ink-soft); }
.detail-schedule-day { min-width: 60px; }
.detail-schedule-time { font-family: 'IBM Plex Mono', monospace; }

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
.tag-bad { background: #F7E5E3; color: #B23A34; }
.tag-overdue { background: #B23A34; color: white; }

.fee-overview-stats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.fee-stat { font-size: 12.5px; font-weight: 600; padding: 5px 11px; border-radius: 999px; }
.fee-stat-overdue { background: #B23A34; color: white; }
.fee-stat-bad { background: #F7E5E3; color: #B23A34; }
.fee-stat-good { background: #EAF3EC; color: #3F7D5C; }
.fee-chip-grid { display: flex; flex-wrap: wrap; gap: 8px; }
.fee-chip { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; border-radius: 10px; padding: 7px 12px; border: 1px solid transparent; cursor: pointer; font-family: inherit; text-align: left; transition: transform 0.1s ease; }
.fee-chip:active { transform: scale(0.97); }
.fee-chip-name { font-size: 13px; font-weight: 700; color: var(--ink); }
.fee-chip-status { font-size: 11px; font-weight: 600; }
.fee-chip-overdue { background: #B23A34; }
.fee-chip-overdue .fee-chip-name { color: white; }
.fee-chip-overdue .fee-chip-status { color: white; }
.fee-chip-unpaid { background: #F7E5E3; }
.fee-chip-unpaid .fee-chip-status { color: #B23A34; }
.fee-chip-paid { background: #EAF3EC; }
.fee-chip-paid .fee-chip-status { color: #3F7D5C; }
.fee-chip-none { background: #EEEEEC; }
.fee-chip-none .fee-chip-status { color: #71757A; }
.fee-chip-active { border-color: var(--brass); box-shadow: 0 0 0 2px var(--brass-soft); }

.segmented { display: inline-flex; background: #EEEEEC; border-radius: 10px; padding: 3px; gap: 2px; }
.segmented-btn { border: none; background: transparent; font-family: inherit; font-size: 12.5px; font-weight: 600; color: var(--ink-soft); padding: 5px 12px; border-radius: 8px; cursor: pointer; }
.segmented-btn.active { background: var(--card); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,0.08); }

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
.stats-table-row-8 { display: grid; grid-template-columns: minmax(74px,1.2fr) repeat(7, minmax(48px, 1fr)); min-width: 450px; font-size: 11px; padding: 4px 2px; gap: 3px; }
.stats-table-row-8 span:not(:first-child) { font-family: 'IBM Plex Mono', monospace; text-align: right; overflow: hidden; text-overflow: ellipsis; }
.stat-positive { color: #3F7D5C; font-weight: 700; }
.stat-negative { color: #B23A34; font-weight: 700; }
.stats-table-row-rate { display: grid; grid-template-columns: minmax(60px,1fr) 44px 44px 44px 44px; font-size: 12px; padding: 4px 2px; gap: 3px; }
.stats-table-row-rate span:not(:first-child) { font-family: 'IBM Plex Mono', monospace; text-align: right; overflow: hidden; text-overflow: ellipsis; }
.stats-table-scroll { overflow-x: auto; max-width: 100%; }
.icon-btn:disabled { opacity: 0.35; cursor: default; }
.journal-textarea { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 13px; font-family: inherit; resize: vertical; background: white; color: var(--ink); }
.status-chip { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 20px; padding: 0 4px; border-radius: 5px; font-size: 10.5px; font-weight: 700; }
.matrix-row-head-clickable { cursor: pointer; }
.matrix-row-head-clickable:hover { text-decoration: underline; }

.chart-card { margin-top: 14px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px; }

.score-dashboard { margin-top: 14px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
.score-dashboard-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.score-dashboard-title { margin-top: 2px; font-size: 15px; font-weight: 700; }
.score-dashboard-note { flex-shrink: 0; color: var(--ink-soft); font-size: 11px; }
.score-metric-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-top: 11px; }
.score-metric { min-width: 0; padding: 9px 10px; border: 1px solid var(--line); border-radius: 10px; background: #F8F5EE; }
.score-metric-primary { background: var(--ink); border-color: var(--ink); color: white; }
.score-metric-positive { background: #EAF3EC; border-color: #BFDCC9; }
.score-metric-warning { background: #FBF3DE; border-color: #EFDBA0; }
.score-metric-label, .score-metric-detail { display: block; color: var(--ink-soft); font-size: 11px; }
.score-metric-primary .score-metric-label, .score-metric-primary .score-metric-detail { color: rgba(255,255,255,0.72); }
.score-metric-value { display: block; margin: 4px 0 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: 'IBM Plex Mono', monospace; font-size: 18px; }
.score-distribution, .score-leaderboard { margin-top: 14px; }
.score-section-title { margin-bottom: 8px; font-size: 12px; font-weight: 700; color: var(--ink-soft); }
.score-distribution-list { display: flex; flex-direction: column; gap: 6px; }
.score-distribution-row { display: grid; grid-template-columns: 62px minmax(80px, 1fr) 72px; align-items: center; gap: 8px; font-size: 11px; }
.score-distribution-label { color: var(--ink-soft); font-family: 'IBM Plex Mono', monospace; }
.score-distribution-track, .score-leaderboard-track { height: 9px; overflow: hidden; border-radius: 999px; background: #EEEEEC; }
.score-distribution-fill, .score-leaderboard-fill { display: block; height: 100%; min-width: 0; border-radius: inherit; transition: width 0.2s ease; }
.score-distribution-count { text-align: right; font-family: 'IBM Plex Mono', monospace; white-space: nowrap; }
.score-distribution-count small { color: var(--ink-soft); font-family: inherit; }
.assessment-column-section { margin-top: 14px; }
.assessment-column-strip { display: flex; gap: 8px; overflow-x: auto; padding: 1px 1px 4px; }
.assessment-column-card { flex: 0 0 180px; min-width: 0; padding: 10px; border: 1px solid var(--line); border-radius: 10px; background: #F8F5EE; }
.assessment-column-card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; }
.assessment-column-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 700; }
.assessment-column-count, .assessment-column-date, .assessment-column-range { color: var(--ink-soft); font-size: 10px; }
.assessment-column-date { margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: 'IBM Plex Mono', monospace; }
.assessment-column-score-row { display: flex; align-items: baseline; gap: 5px; margin-top: 9px; }
.assessment-column-score-row strong { font-family: 'IBM Plex Mono', monospace; font-size: 21px; }
.assessment-column-score-row span { color: var(--ink-soft); font-size: 10px; }
.assessment-column-bar { height: 7px; overflow: hidden; margin: 4px 0 6px; border-radius: 999px; background: #EEEEEC; }
.assessment-column-bar span { display: block; height: 100%; border-radius: inherit; }
.score-leaderboard-list { display: flex; flex-direction: column; gap: 5px; }
.score-leaderboard-row { display: grid; grid-template-columns: 22px minmax(120px, 1fr) 48px 42px 46px 74px; align-items: center; gap: 7px; padding: 7px 8px; border: 1px solid var(--line); border-radius: 8px; background: #F8F5EE; font-size: 11px; }
.score-leaderboard-rank { color: var(--ink-soft); text-align: center; font-family: 'IBM Plex Mono', monospace; }
.score-leaderboard-name { display: flex; align-items: center; gap: 5px; overflow: hidden; font-weight: 600; }
.score-leaderboard-name > span:first-child, .score-leaderboard-count { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.score-leaderboard-count { flex-shrink: 0; color: var(--ink-soft); font-size: 10px; font-weight: 400; }
.score-leaderboard-track { height: 7px; margin-top: 4px; }
.score-leaderboard-score, .score-leaderboard-delta, .score-leaderboard-pr, .score-leaderboard-latest { overflow: hidden; text-align: right; font-family: 'IBM Plex Mono', monospace; white-space: nowrap; }
.score-leaderboard-score { font-size: 14px; }
.score-leaderboard-delta.is-up { color: #3F7D5C; }
.score-leaderboard-delta.is-down { color: #B23A34; }
.score-leaderboard-pr, .score-leaderboard-latest { color: var(--ink-soft); font-size: 10px; }

.matrix-scroll { overflow-x: auto; margin-top: 14px; border: 1px solid var(--line); border-radius: 10px; }
.matrix { border-collapse: collapse; width: 100%; background: var(--card); }
.matrix th, .matrix td { border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); padding: 6px 8px; }
.matrix-corner { position: sticky; left: 0; background: var(--card); z-index: 2; min-width: 76px; font-size: 12px; color: var(--ink-soft); text-align: left; }
.matrix-row-head { position: sticky; left: 0; background: var(--card); z-index: 1; font-size: 13px; font-weight: 500; white-space: nowrap; }
.matrix-col-head { min-width: 110px; position: relative; font-size: 12px; }
.matrix-col-head-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 5px; min-height: 28px; }
.matrix-col-head-top .confirm-inline { padding: 2px 3px; }
.matrix-col-head-top .icon-btn { width: 25px; height: 25px; border-radius: 6px; }
.matrix-col-head-actions { display: flex; align-items: flex-start; gap: 2px; flex-shrink: 0; }
.matrix-col-name { min-width: 0; padding-top: 3px; font-weight: 700; overflow-wrap: anywhere; }
.assessment-name-editor { width: 100%; }
.assessment-name-input { box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid var(--brass); border-radius: 6px; padding: 5px 6px; background: #FFFDF7; color: var(--ink); font-family: inherit; font-size: 12px; font-weight: 600; outline: 2px solid rgba(184,134,59,0.16); }
.assessment-name-editor-actions { display: flex; align-items: center; gap: 4px; margin-top: 5px; }
.assessment-name-editor-actions .btn-xs { padding: 4px 7px; }
.matrix-col-date { color: var(--ink-soft); font-family: 'IBM Plex Mono', monospace; font-size: 10px; margin-bottom: 4px; }
.matrix-cell { text-align: center; }
.matrix-input { width: 64px; border: 1px solid var(--line); border-radius: 6px; padding: 5px 6px; font-family: 'IBM Plex Mono', monospace; font-size: 13px; text-align: center; transition: background 0.15s ease, border-color 0.15s ease; }
.matrix-input::placeholder { color: #A2A5A1; }
.matrix-input-band-excellent { background: #EAF3EC; border-color: #BFDCC9; color: #3F7D5C; font-weight: 700; }
.matrix-input-band-good { background: #E9EFF6; border-color: #C3D3E7; color: #3F5E8C; font-weight: 700; }
.matrix-input-band-fair { background: #FBF3DE; border-color: #EFDBA0; color: #8C6D2E; font-weight: 700; }
.matrix-input-band-pass { background: #F3EEE3; border-color: #DCCCA8; color: #8C6D3F; font-weight: 700; }
.matrix-input-band-below { background: #FBEAE9; border-color: #F0C6C3; color: #B23A34; font-weight: 700; }
.matrix-input-sub { margin-top: 4px; font-size: 11px; color: var(--ink-soft); }

@media (max-width: 720px) {
  .score-dashboard-heading { flex-direction: column; gap: 2px; }
  .score-metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .score-metric:first-child { grid-column: span 2; }
  .score-leaderboard-row { grid-template-columns: 20px minmax(100px, 1fr) 48px 42px; }
  .score-leaderboard-pr, .score-leaderboard-latest { display: none; }
}

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
