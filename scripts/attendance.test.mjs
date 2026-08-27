import test from "node:test";
import assert from "node:assert/strict";
import {
  attendanceHasStatus,
  findAttendanceAnomalies,
  normalizeAttendanceStatus,
  serializeAttendanceStatus,
  summarizeAttendanceRecords,
  toggleAttendanceStatus,
  wholeDayAttendanceStatus,
} from "../src/attendance.js";

test("legacy string statuses remain readable", () => {
  assert.deepEqual(normalizeAttendanceStatus("出席"), ["出席"]);
  assert.deepEqual(normalizeAttendanceStatus("遲到"), ["出席", "遲到"]);
  assert.deepEqual(normalizeAttendanceStatus(["出席", "早退"]), ["出席", "早退"]);
  assert.equal(attendanceHasStatus("出席", "遲到"), false);
  assert.equal(attendanceHasStatus(["出席", "遲到"], "遲到"), true);
});

test("attendance toggles allow late and early leave only with present", () => {
  let statuses = toggleAttendanceStatus("", "出席");
  statuses = toggleAttendanceStatus(statuses, "遲到");
  statuses = toggleAttendanceStatus(statuses, "早退");
  assert.deepEqual(statuses, ["出席", "遲到", "早退"]);
  assert.deepEqual(toggleAttendanceStatus(statuses, "遲到"), ["出席", "早退"]);
  assert.deepEqual(toggleAttendanceStatus(["請假"], "遲到"), ["請假"]);
  assert.deepEqual(toggleAttendanceStatus(statuses, "請假"), ["請假"]);
  assert.deepEqual(toggleAttendanceStatus(["出席", "遲到"], "出席"), []);
});

test("serialized status keeps simple legacy shape and uses array for multi-select", () => {
  assert.equal(serializeAttendanceStatus(["出席"]), "出席");
  assert.deepEqual(serializeAttendanceStatus(["出席", "遲到", "早退"]), ["出席", "遲到", "早退"]);
  assert.equal(serializeAttendanceStatus([]), "");
});

test("whole-day delay or holiday is not anomalous when every record has the same whole-day status", () => {
  const students = [{ id: "a", name: "甲", endDate: "2026-08-20" }, { id: "b", name: "乙" }];
  const delayedRecords = { a: "延課", b: "延課" };
  assert.equal(wholeDayAttendanceStatus(delayedRecords), "延課");
  assert.deepEqual(findAttendanceAnomalies({ records: delayedRecords, students, date: "2026-08-05", wholeDayStatus: "延課" }), []);
  assert.deepEqual(findAttendanceAnomalies({ records: { a: "出席" }, students, date: "2026-08-05", wholeDayStatus: "延課" }), [{ studentId: "a", studentName: "甲", statuses: ["出席"], value: "出席", reason: "全班延課日個人紀錄" }]);
  assert.deepEqual(findAttendanceAnomalies({ records: { b: "請假" }, students, date: "2026-08-05", wholeDayStatus: "延課" }), [{ studentId: "b", studentName: "乙", statuses: ["請假"], value: "請假", reason: "全班延課日個人紀錄" }]);
});

test("ordinary absence, late, and early leave are not anomalous", () => {
  const students = [{ id: "a", name: "甲" }];
  assert.deepEqual(findAttendanceAnomalies({ records: { a: ["出席", "遲到", "早退"] }, students, date: "2026-08-05" }), []);
  assert.deepEqual(findAttendanceAnomalies({ records: { a: "請假" }, students, date: "2026-08-05" }), []);
  assert.deepEqual(findAttendanceAnomalies({ records: { a: "曠課" }, students, date: "2026-08-05" }), []);
});

test("the stop date begins the stopped period and later records are anomalous", () => {
  const students = [{ id: "wu", name: "吳亭儀", endDate: "2026-06-29" }];
  assert.deepEqual(findAttendanceAnomalies({ records: { wu: "出席" }, students, date: "2026-06-28" }), []);
  const expected = [{ studentId: "wu", studentName: "吳亭儀", statuses: ["出席"], value: "出席", reason: "停課後仍有紀錄" }];
  assert.deepEqual(findAttendanceAnomalies({ records: { wu: "出席" }, students, date: "2026-06-29" }), expected);
  assert.deepEqual(findAttendanceAnomalies({ records: { wu: "出席" }, students, date: "2026-06-30" }), expected);
});

test("stopped, pre-join, unknown, and orphan records are identified by student", () => {
  const students = [
    { id: "stopped", name: "停課生", endDate: "2026-08-05" },
    { id: "not-yet", name: "未入班生", joinDate: "2026-08-10" },
  ];
  const anomalies = findAttendanceAnomalies({
    records: { stopped: "出席", "not-yet": "出席", unknown: "神秘狀態", orphan: "出席" },
    students,
    date: "2026-08-07",
  });
  assert.deepEqual(anomalies, [
    { studentId: "stopped", studentName: "停課生", statuses: ["出席"], value: "出席", reason: "停課後仍有紀錄" },
    { studentId: "not-yet", studentName: "未入班生", statuses: ["出席"], value: "出席", reason: "入班前仍有紀錄" },
    { studentId: "unknown", studentName: "unknown", statuses: [], value: "神秘狀態", reason: "名單外紀錄" },
    { studentId: "orphan", studentName: "orphan", statuses: ["出席"], value: "出席", reason: "名單外紀錄" },
  ]);
});

test("attendance summary counts late and early leave independently from presence", () => {
  const summary = summarizeAttendanceRecords({
    a: "出席",
    b: ["出席", "遲到"],
    c: ["出席", "遲到", "早退"],
    d: "請假",
    e: "曠課",
    f: "延課",
    g: "假期",
  });
  assert.deepEqual(summary, {
    recorded: 7,
    countedSessions: 5,
    出席: 3,
    請假: 1,
    曠課: 1,
    遲到: 2,
    早退: 1,
    延課: 1,
    假期: 1,
  });
});
