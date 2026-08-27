export const ATTENDANCE_BASE_STATUSES = ["出席", "請假", "曠課", "延課", "假期"];
export const ATTENDANCE_MODIFIER_STATUSES = ["遲到", "早退"];
export const ATTENDANCE_STATUSES = [...ATTENDANCE_BASE_STATUSES.slice(0, 3), ...ATTENDANCE_MODIFIER_STATUSES, ...ATTENDANCE_BASE_STATUSES.slice(3)];
export const COUNTED_ATTENDANCE_BASE_STATUSES = ["出席", "請假", "曠課"];

function rawStatusTokens(value) {
  if (Array.isArray(value)) return value.flatMap(rawStatusTokens);
  if (typeof value !== "string") return [];
  return value
    .trim()
    .split(/[、,，/+／＆&\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function attendanceStatusTokens(value) {
  return rawStatusTokens(value);
}

/**
 * Normalize legacy single-string records and new multi-select records.
 * A legacy modifier-only record such as "遲到" is interpreted as
 * "出席" + "遲到" so its historical meaning is not lost.
 */
export function normalizeAttendanceStatus(value) {
  const tokens = rawStatusTokens(value);
  const base = ATTENDANCE_BASE_STATUSES.find((status) => tokens.includes(status));
  const modifiers = ATTENDANCE_MODIFIER_STATUSES.filter((status) => tokens.includes(status));
  if (!base) return modifiers.length ? ["出席", ...modifiers] : [];
  return [base, ...(base === "出席" ? modifiers : [])];
}

export function serializeAttendanceStatus(value) {
  const statuses = normalizeAttendanceStatus(value);
  if (statuses.length === 0) return "";
  return statuses.length === 1 ? statuses[0] : statuses;
}

export function attendanceBaseStatus(value) {
  return normalizeAttendanceStatus(value).find((status) => ATTENDANCE_BASE_STATUSES.includes(status)) || null;
}

export function attendanceHasStatus(value, status) {
  return normalizeAttendanceStatus(value).includes(status);
}

export function hasUnknownAttendanceStatus(value) {
  return rawStatusTokens(value).some((token) => !ATTENDANCE_STATUSES.includes(token));
}

/** Toggle a status while enforcing one base status and optional modifiers. */
export function toggleAttendanceStatus(value, status) {
  const current = normalizeAttendanceStatus(value);
  if (!ATTENDANCE_STATUSES.includes(status)) return current;
  if (ATTENDANCE_BASE_STATUSES.includes(status)) {
    return current[0] === status ? [] : [status];
  }
  if (current[0] !== "出席") return current;
  const modifiers = ATTENDANCE_MODIFIER_STATUSES.filter((item) => current.includes(item) || item === status);
  if (current.includes(status)) return ["出席", ...modifiers.filter((item) => item !== status)];
  return ["出席", ...modifiers];
}

export function wholeDayAttendanceStatus(records, { cancelled = false, cancelNote = "" } = {}) {
  if (cancelled) return cancelNote === "假期" ? "假期" : "延課";
  const bases = Object.values(records || {}).map(attendanceBaseStatus).filter(Boolean);
  if (!bases.length || !bases.every((status) => status === bases[0] && (status === "延課" || status === "假期"))) return null;
  return bases[0];
}

export function attendanceAnomalyReason({ student, studentId, date, value, knownStudent = true, wholeDayStatus = null }) {
  if (!knownStudent) return "名單外紀錄";
  const tokens = rawStatusTokens(value);
  if (tokens.length && tokens.some((token) => !ATTENDANCE_STATUSES.includes(token))) return "未知狀態";
  if (!tokens.length) return null;
  if (student?.joinDate && date < student.joinDate) return "入班前仍有紀錄";
  const stopped = student && ((student.endDate && date > student.endDate) || ((student.membership === "stopped" || student.active === false) && (!student.endDate || date > student.endDate)));
  if (stopped) return "停課後仍有紀錄";
  if (wholeDayStatus && attendanceBaseStatus(value) !== wholeDayStatus) return `全班${wholeDayStatus}日個人紀錄`;
  return null;
}

export function findAttendanceAnomalies({ records, students, date, wholeDayStatus = null } = {}) {
  const studentMap = new Map((students || []).map((student) => [student.id, student]));
  return Object.entries(records || {}).flatMap(([studentId, value]) => {
    const student = studentMap.get(studentId);
    const reason = attendanceAnomalyReason({ student, studentId, date, value, knownStudent: !!student, wholeDayStatus });
    if (!reason) return [];
    return [{ studentId, studentName: student?.name || studentId, statuses: normalizeAttendanceStatus(value), value, reason }];
  });
}

export function summarizeAttendanceRecords(records) {
  const summary = {
    recorded: 0,
    countedSessions: 0,
    出席: 0,
    請假: 0,
    曠課: 0,
    遲到: 0,
    早退: 0,
    延課: 0,
    假期: 0,
  };
  Object.values(records || {}).forEach((record) => {
    const statuses = normalizeAttendanceStatus(record);
    if (!statuses.length) return;
    summary.recorded += 1;
    if (statuses.some((status) => COUNTED_ATTENDANCE_BASE_STATUSES.includes(status))) summary.countedSessions += 1;
    statuses.forEach((status) => {
      if (Object.prototype.hasOwnProperty.call(summary, status)) summary[status] += 1;
    });
  });
  return summary;
}
