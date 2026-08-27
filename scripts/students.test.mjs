import test from "node:test";
import assert from "node:assert/strict";
import { isStudentStoppedOnDate, mergeStudentIndex, studentDisplay, validateStudentIndex } from "../src/students.js";

test("student stop date is inclusive and resume date restores membership", () => {
  const student = { endDate: "2026-06-29", resumeDate: "2026-07-10" };
  assert.equal(isStudentStoppedOnDate(student, "2026-06-29"), true);
  assert.equal(isStudentStoppedOnDate(student, "2026-06-30"), true);
  assert.equal(isStudentStoppedOnDate(student, "2026-07-09"), true);
  assert.equal(isStudentStoppedOnDate(student, "2026-07-10"), false);
});

test("mergeStudentIndex builds one student profile with per-class enrollment records", () => {
  const classes = [
    {
      id: "math",
      name: "高中數學班",
      subject: "數學",
      grade: "高中",
      students: [{ id: "wu", name: "吳亭儀", school: "甲高中", joinDate: "2026-03-01", endDate: "2026-06-29" }],
    },
    {
      id: "physics",
      name: "高中物理班",
      subject: "物理",
      grade: "高中",
      students: [{ id: "wu", name: "吳亭儀", school: "甲高中", joinDate: "2026-04-02" }],
    },
  ];
  const index = mergeStudentIndex({}, classes);
  assert.equal(index.wu.name, "吳亭儀");
  assert.equal(index.wu.school, "甲高中");
  assert.equal(index.wu.enrollments.math.joinDate, "2026-03-01");
  assert.equal(index.wu.enrollments.math.endDate, "2026-06-29");
  assert.equal(index.wu.enrollments.physics.joinDate, "2026-04-02");
  assert.equal(index.wu.enrollments.physics.endDate, undefined);
});

test("studentDisplay falls back to the student-first profile when class fields are blank", () => {
  const profile = { wu: { id: "wu", name: "吳亭儀", school: "甲高中", grade: "高中" } };
  assert.deepEqual(studentDisplay({ id: "wu", name: "吳亭儀", school: "" }, profile, { grade: "高中" }), {
    id: "wu",
    name: "吳亭儀",
    school: "甲高中",
    grade: "高中",
  });
});

test("validateStudentIndex rejects malformed profiles", () => {
  assert.equal(validateStudentIndex({ wu: { name: "吳亭儀", school: "甲高中", enrollments: {} } }), true);
  assert.equal(validateStudentIndex({ wu: { name: 123 } }), false);
  assert.equal(validateStudentIndex([]), false);
});
