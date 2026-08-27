export const SCORE_BANDS = [
  { key: "excellent", label: "90–100", min: 90, max: 100, color: "#3F7D5C" },
  { key: "good", label: "80–89", min: 80, max: 89.999, color: "#4C6C99" },
  { key: "fair", label: "70–79", min: 70, max: 79.999, color: "#B8863B" },
  { key: "pass", label: "60–69", min: 60, max: 69.999, color: "#8C6D3F" },
  { key: "below", label: "未達 60", min: -Infinity, max: 59.999, color: "#B23A34" },
];

export function numericScore(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function scoreBand(value) {
  const score = numericScore(value);
  if (score === null) return null;
  return SCORE_BANDS.find((band) => score >= band.min && score <= band.max) || (score > 100 ? SCORE_BANDS[0] : SCORE_BANDS[SCORE_BANDS.length - 1]);
}

export function scorePercent(value) {
  const score = numericScore(value);
  if (score === null) return 0;
  return Math.max(0, Math.min(100, score));
}

export function scoreDelta(values) {
  const scores = values.map(numericScore).filter((value) => value !== null);
  if (scores.length < 2) return { first: scores[0] ?? null, latest: scores.at(-1) ?? null, delta: null };
  return { first: scores[0], latest: scores.at(-1), delta: scores.at(-1) - scores[0] };
}

export function buildScoreDistribution(values) {
  const scores = values.map(numericScore).filter((value) => value !== null);
  const total = scores.length;
  return SCORE_BANDS.map((band) => {
    const count = scores.filter((score) => score >= band.min && score <= band.max).length;
    return { ...band, count, percent: total ? Math.round((count / total) * 1000) / 10 : 0 };
  });
}

export function median(values) {
  const scores = values.map(numericScore).filter((value) => value !== null).sort((a, b) => a - b);
  if (!scores.length) return null;
  const middle = Math.floor(scores.length / 2);
  return scores.length % 2 ? scores[middle] : (scores[middle - 1] + scores[middle]) / 2;
}

/**
 * Return whether a student should be counted as enrolled on an assessment date.
 * joinDate is inclusive and endDate is the first date the student no longer attends;
 * legacy stopped/active flags without an endDate remain stopped for all dates.
 */
import { isStudentStoppedOnDate } from "./students.js";

export function isStudentEnrolledOnDate(student, dateStr) {
  if (!student || !dateStr) return true;
  if (student.joinDate && dateStr < student.joinDate) return false;
  return !isStudentStoppedOnDate(student, dateStr);
}

export function studentsEnrolledOnDate(students, dateStr) {
  return (students || []).filter((student) => isStudentEnrolledOnDate(student, dateStr));
}

export function assessmentCapacity(columns) {
  return (columns || []).reduce((total, column) => {
    const count = Number(column?.enrolledCount);
    return total + (Number.isFinite(count) && count >= 0 ? count : 0);
  }, 0);
}

export function updateAssessmentColumn(column, { name, segment } = {}) {
  if (!column || !String(name || "").trim()) return column;
  const next = { ...column, name: String(name).trim() };
  if (segment !== undefined) next.segment = String(segment).trim();
  return next;
}
