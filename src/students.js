function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isStudentStoppedOnDate(student, dateStr) {
  if (!student || !dateStr) return false;
  if (student.resumeDate && dateStr >= student.resumeDate) return false;
  if (student.endDate && dateStr >= student.endDate) return true;
  return (student.membership === "stopped" || student.active === false) && (!student.endDate || dateStr > student.endDate);
}

/**
 * Return the first date on which a student can be considered present in a
 * historical view. New records should carry joinDate; for older Excel imports
 * without it, the first non-empty record is the safest available boundary.
 */
export function studentStartDate(student, attendanceData = {}) {
  if (student?.joinDate) return student.joinDate;
  if (!isRecord(attendanceData)) return "";
  return Object.keys(attendanceData)
    .filter((date) => {
      if (!isRecord(attendanceData[date]) || !isRecord(attendanceData[date].records)) return false;
      const value = attendanceData[date].records[student?.id];
      return value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
    })
    .sort()[0] || "";
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
      if (student.school) enrollment.school = student.school;
      if (student.group) enrollment.group = student.group;
      next[student.id] = {
        ...previous,
        id: student.id,
        name: student.name || previous.name || "",
        school: student.school || previous.school || "",
        group: student.group || previous.group || "",
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
  const enrollment = profile.enrollments?.[cls?.id] || {};
  const display = {
    ...profile,
    ...(student || {}),
    id: student?.id || profile.id || "",
    name: student?.name || profile.name || "未命名學生",
    school: student?.school || enrollment.school || profile.school || "",
    grade: student?.grade || enrollment.grade || profile.grade || cls?.grade || "",
  };
  const group = student?.group || enrollment.group || profile.group || "";
  if (group) display.group = group;
  return display;
}

export function formatStudentSchoolGroup(student) {
  const school = String(student?.school || "").trim();
  const group = String(student?.group || "").trim();
  if (school && group) return `${school}．${group}`;
  return school || group;
}

export function validateStudentIndex(value) {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([id, profile]) => typeof id === "string" && isRecord(profile) && (!profile.name || typeof profile.name === "string") && (!profile.school || typeof profile.school === "string") && (!profile.group || typeof profile.group === "string") && (!profile.enrollments || isRecord(profile.enrollments)));
}
