import test from "node:test";
import assert from "node:assert/strict";
import {
  attendanceHasStatus,
  normalizeAttendanceStatus,
  serializeAttendanceStatus,
  summarizeAttendanceRecords,
  toggleAttendanceStatus,
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
