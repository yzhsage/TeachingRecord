function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isStudentStoppedOnDate(student, dateStr) {
  if (!student || !dateStr) return false;
  if (student.resumeDate && dateStr >= student.resumeDate) return false;
  if (student.endDate && dateStr >= student.endDate) return true;
  return (student.membership === "stopped" || student.active === false) && (!student.endDate || dateStr > student.endDate);
}

export function normalizeStudentIndex(value) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([id, profile]) => typeof id === "string" && isRecord(profile))
      .map(([id, profile]) => [id, { ...profile, id }])
  );
}

/**
 * Build or refresh the student-first index without removing legacy class
 * roster data. The class roster remains the source of class membership; this
 * index preserves a stable profile fallback for historical views and future
 * cross-class reporting.
 */
export function mergeStudentIndex(value, classes) {
  const next = normalizeStudentIndex(value);
  (classes || []).forEach((cls) => {
    (cls.students || []).forEach((student) => {
      if (!student || typeof student.id !== "string" || !student.id) return;
      const previous = next[student.id] || { id: student.id };
      const enrollment = { ...(previous.enrollments?.[cls.id] || {}) };
      if (Object.prototype.hasOwnProperty.call(student, "joinDate")) enrollment.joinDate = student.joinDate || "";
      if (Object.prototype.hasOwnProperty.call(student, "endDate")) enrollment.endDate = student.endDate || "";
      if (Object.prototype.hasOwnProperty.call(student, "resumeDate")) enrollment.resumeDate = student.resumeDate || "";
      next[student.id] = {
        ...previous,
        id: student.id,
        name: student.name || previous.name || "",
        school: student.school || previous.school || "",
        grade: student.grade || cls.grade || previous.grade || "",
        enrollments: { ...(previous.enrollments || {}), [cls.id]: enrollment },
        classes: {
          ...(previous.classes || {}),
          [cls.id]: { name: cls.name || "", subject: cls.subject || "", grade: cls.grade || "" },
        },
      };
    });
  });
  return next;
}

export function studentDisplay(student, studentIndex, cls) {
  const profile = normalizeStudentIndex(studentIndex)[student?.id] || {};
  return {
    ...profile,
    ...(student || {}),
    id: student?.id || profile.id || "",
    name: student?.name || profile.name || "未命名學生",
    school: student?.school || profile.school || "",
    grade: student?.grade || profile.grade || cls?.grade || "",
  };
}

export function validateStudentIndex(value) {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([id, profile]) => typeof id === "string" && isRecord(profile) && (!profile.name || typeof profile.name === "string") && (!profile.school || typeof profile.school === "string") && (!profile.enrollments || isRecord(profile.enrollments)));
}
