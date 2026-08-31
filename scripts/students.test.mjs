import test from "node:test";
import assert from "node:assert/strict";
import { formatStudentSchoolGroup, isStudentStoppedOnDate, mergeStudentIndex, removeStudentFromRecords, removeStudentFromStudentIndex, studentDisplay, studentStartDate, validateStudentIndex } from "../src/students.js";

test("student stop date is inclusive and resume date restores membership", () => {
  const student = { endDate: "2026-06-29", resumeDate: "2026-07-10" };
  assert.equal(isStudentStoppedOnDate(student, "2026-06-29"), true);
  assert.equal(isStudentStoppedOnDate(student, "2026-06-30"), true);
  assert.equal(isStudentStoppedOnDate(student, "2026-07-09"), true);
  assert.equal(isStudentStoppedOnDate(student, "2026-07-10"), false);
});

test("studentStartDate prefers joinDate and infers the first legacy attendance date", () => {
  const legacyAttendance = {
    "2026-06-04": { records: {} },
    "2026-06-11": { records: { wu: "出席" } },
    "2026-06-18": { records: { wu: ["出席", "遲到"] } },
  };
  assert.equal(studentStartDate({ id: "wu", joinDate: "2026-05-01" }, legacyAttendance), "2026-05-01");
  assert.equal(studentStartDate({ id: "wu" }, legacyAttendance), "2026-06-11");
  assert.equal(studentStartDate({ id: "none" }, legacyAttendance), "");
});

test("mergeStudentIndex builds one student profile with per-class enrollment records", () => {
  const classes = [
    {
      id: "math",
      name: "高中數學班",
      subject: "數學",
      grade: "高中",
      students: [{ id: "wu", name: "吳亭儀", school: "甲高中", group: "數A", joinDate: "2026-03-01", endDate: "2026-06-29" }],
    },
    {
      id: "physics",
      name: "高中物理班",
      subject: "物理",
      grade: "高中",
      students: [{ id: "wu", name: "吳亭儀", school: "乙高中", joinDate: "2026-04-02" }],
    },
  ];
  const index = mergeStudentIndex({}, classes);
  assert.equal(index.wu.name, "吳亭儀");
  assert.equal(index.wu.school, "乙高中");
  assert.equal(index.wu.enrollments.math.school, "甲高中");
  assert.equal(index.wu.enrollments.math.group, "數A");
  assert.equal(index.wu.enrollments.math.joinDate, "2026-03-01");
  assert.equal(index.wu.enrollments.math.endDate, "2026-06-29");
  assert.equal(index.wu.enrollments.physics.school, "乙高中");
  assert.equal(index.wu.enrollments.physics.joinDate, "2026-04-02");
  assert.equal(index.wu.enrollments.physics.endDate, undefined);
  assert.equal(studentDisplay({ id: "wu", name: "吳亭儀", school: "" }, index, { id: "math", grade: "高中" }).school, "甲高中");
  assert.equal(studentDisplay({ id: "wu", name: "吳亭儀", school: "", group: "" }, index, { id: "math", grade: "高中" }).group, undefined);
  assert.equal(studentDisplay({ id: "wu", name: "吳亭儀", school: "" }, index, { id: "physics", grade: "高中" }).school, "乙高中");
});

test("studentDisplay keeps an explicit blank group in the current class", () => {
  const index = {
    wu: { id: "wu", name: "吳亭儀", group: "數B", enrollments: { math: { group: "" }, physics: { group: "數A" } } },
  };
  assert.equal(studentDisplay({ id: "wu", name: "吳亭儀", group: "" }, index, { id: "math" }).group, undefined);
  assert.equal(studentDisplay({ id: "wu", name: "吳亭儀" }, index, { id: "math" }).group, undefined);
  assert.equal(studentDisplay({ id: "wu", name: "吳亭儀" }, index, { id: "physics" }).group, "數A");
});

test("studentDisplay prefers the class enrollment school before the global fallback", () => {
  const display = studentDisplay({ id: "wu", name: "吳亭儀", school: "" }, { wu: { id: "wu", name: "吳亭儀", school: "錯誤學校", enrollments: { math: { school: "甲高中" } } } }, { id: "math", grade: "高中" });
  assert.equal(display.school, "甲高中");
  assert.equal(display.name, "吳亭儀");
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

test("removeStudentFromRecords removes only the selected student from every record type", () => {
  const cleaned = removeStudentFromRecords("wu", {
    attendance: { "2026-06-01": { records: { wu: "出席", li: "請假" }, note: "保留" } },
    quiz: { columns: [{ id: "q1", name: "小考一" }], scores: { q1: { wu: { score: 88 }, li: { score: 92 } } } },
    exam: { columns: [{ id: "e1", name: "段考" }], scores: { e1: { wu: { score: 80 }, li: { score: 90 } } } },
    fee: { charges: [{ id: "f1", studentId: "wu", tuition: 100 }, { id: "f2", studentId: "li", tuition: 200 }] },
  });
  assert.deepEqual(cleaned.attendance["2026-06-01"].records, { li: "請假" });
  assert.deepEqual(cleaned.quiz.scores.q1, { li: { score: 92 } });
  assert.deepEqual(cleaned.exam.scores.e1, { li: { score: 90 } });
  assert.deepEqual(cleaned.fee.charges, [{ id: "f2", studentId: "li", tuition: 200 }]);
  assert.deepEqual(cleaned.quiz.columns, [{ id: "q1", name: "小考一" }]);
});

test("removeStudentFromStudentIndex removes one class enrollment but keeps other classes", () => {
  const index = {
    wu: { id: "wu", name: "吳亭儀", enrollments: { math: { school: "甲高中" }, physics: { school: "乙高中" } }, classes: { math: { name: "數學" }, physics: { name: "物理" } } },
  };
  const afterMath = removeStudentFromStudentIndex(index, "wu", "math");
  assert.deepEqual(afterMath.wu.enrollments, { physics: { school: "乙高中" } });
  const afterPhysics = removeStudentFromStudentIndex(afterMath, "wu", "physics");
  assert.equal(afterPhysics.wu, undefined);
});

test("formatStudentSchoolGroup appends the group only when present", () => {
  assert.equal(formatStudentSchoolGroup({ school: "二中", group: "數A" }), "二中．數A");
  assert.equal(formatStudentSchoolGroup({ school: "二中", group: "" }), "二中");
  assert.equal(formatStudentSchoolGroup({ school: "", group: "數B" }), "數B");
  assert.equal(formatStudentSchoolGroup({ school: "", group: "" }), "");
});

test("validateStudentIndex rejects malformed profiles", () => {
  assert.equal(validateStudentIndex({ wu: { name: "吳亭儀", school: "甲高中", enrollments: {} } }), true);
  assert.equal(validateStudentIndex({ wu: { name: 123 } }), false);
  assert.equal(validateStudentIndex([]), false);
});
