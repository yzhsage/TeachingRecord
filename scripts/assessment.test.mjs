import test from "node:test";
import assert from "node:assert/strict";
import {
  assessmentCapacity,
  buildScoreDistribution,
  updateAssessmentColumn,
  isStudentEnrolledOnDate,
  median,
  numericScore,
  studentsEnrolledOnDate,
  scoreBand,
  scoreDelta,
  scorePercent,
} from "../src/assessment.js";

test("numericScore accepts numeric strings and ignores empty or invalid values", () => {
  assert.equal(numericScore("88.5"), 88.5);
  assert.equal(numericScore(0), 0);
  assert.equal(numericScore(""), null);
  assert.equal(numericScore("not-a-score"), null);
});

test("score bands cover the visible 100-point scale", () => {
  assert.equal(scoreBand(100).key, "excellent");
  assert.equal(scoreBand(90).key, "excellent");
  assert.equal(scoreBand(89.9).key, "good");
  assert.equal(scoreBand(70).key, "fair");
  assert.equal(scoreBand(60).key, "pass");
  assert.equal(scoreBand(59.9).key, "below");
  assert.equal(scoreBand(101).key, "excellent");
  assert.equal(scoreBand("") , null);
  assert.equal(scorePercent(135), 100);
  assert.equal(scorePercent(-5), 0);
});

test("buildScoreDistribution counts bands and calculates percentages", () => {
  const distribution = buildScoreDistribution([95, "88", 75, 65, 40, "", "invalid"]);
  assert.deepEqual(distribution.map(({ key, count, percent }) => ({ key, count, percent })), [
    { key: "excellent", count: 1, percent: 20 },
    { key: "good", count: 1, percent: 20 },
    { key: "fair", count: 1, percent: 20 },
    { key: "pass", count: 1, percent: 20 },
    { key: "below", count: 1, percent: 20 },
  ]);
  assert.deepEqual(buildScoreDistribution([]).map((band) => band.count), [0, 0, 0, 0, 0]);
});

test("median ignores blanks and supports odd and even collections", () => {
  assert.equal(median([95, "", 65, 80]), 80);
  assert.equal(median([90, 70, 80]), 80);
  assert.equal(median([]), null);
});

test("scoreDelta reports first, latest, and change while preserving a zero first score", () => {
  assert.deepEqual(scoreDelta([0, 25, "40"]), { first: 0, latest: 40, delta: 40 });
  assert.deepEqual(scoreDelta([88]), { first: 88, latest: 88, delta: null });
  assert.deepEqual(scoreDelta(["", "bad"]), { first: null, latest: null, delta: null });
});

test("student enrollment uses the assessment date rather than today's roster", () => {
  const students = [
    { id: "active", name: "仍在班" },
    { id: "joined-later", name: "後來入班", joinDate: "2026-09-01" },
    { id: "left", name: "已停班", endDate: "2026-08-15" },
    { id: "legacy-stopped", name: "舊停班", membership: "stopped" },
    { id: "legacy-active-false", name: "舊停班旗標", active: false },
  ];

  assert.equal(isStudentEnrolledOnDate(students[1], "2026-08-31"), false);
  assert.equal(isStudentEnrolledOnDate(students[2], "2026-08-14"), true);
  assert.equal(isStudentEnrolledOnDate(students[2], "2026-08-15"), false);
  assert.equal(isStudentEnrolledOnDate(students[3], "2026-08-01"), false);
  assert.equal(isStudentEnrolledOnDate(students[4], "2026-08-01"), false);
  assert.deepEqual(studentsEnrolledOnDate(students, "2026-08-15").map((student) => student.id), ["active"]);
  assert.deepEqual(studentsEnrolledOnDate(students, "").map((student) => student.id), students.map((student) => student.id));
});

test("assessmentCapacity sums each assessment's historical enrolled count", () => {
  assert.equal(assessmentCapacity([{ enrolledCount: 5 }, { enrolledCount: 3 }, { enrolledCount: 0 }]), 8);
  assert.equal(assessmentCapacity([{ count: 10 }, {}]), 0);
});

test("updateAssessmentColumn changes name and range without losing other metadata", () => {
  const column = { id: "q1", name: "小考一", date: "2026-06-04", subject: "數學", segment: "CH1", extra: "keep" };
  assert.deepEqual(updateAssessmentColumn(column, { name: " 小考一修訂 ", segment: " CH1 1-1～1-3 " }), {
    id: "q1", name: "小考一修訂", date: "2026-06-04", subject: "數學", segment: "CH1 1-1～1-3", extra: "keep",
  });
  assert.equal(updateAssessmentColumn(column, { name: "", segment: "new" }), column);
  assert.equal(updateAssessmentColumn(column, { name: "小考一" }).segment, "CH1");
  assert.equal(updateAssessmentColumn(column, { name: "小考一", segment: "" }).segment, "");
});
