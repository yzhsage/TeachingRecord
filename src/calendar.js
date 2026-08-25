export const CALENDAR_EVENT_META = {
  nationalHoliday: { label: "國定假日", color: "#B23A34", readOnly: true },
  schoolExam: { label: "學校段考", color: "#4C6C99" },
  fieldTrip: { label: "校外教學", color: "#3E8FA8" },
  majorExam: { label: "大考", color: "#7A5EA8" },
  other: { label: "其他", color: "#B8863B" },
};

export const MANUAL_EVENT_TYPES = ["schoolExam", "fieldTrip", "majorExam", "other"];

export function eventTypeMeta(type) {
  return CALENDAR_EVENT_META[type] || CALENDAR_EVENT_META.other;
}

export function isDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

export function isEventOnDate(event, date) {
  const start = event.date;
  const end = event.endDate || event.date;
  return isDateString(start) && isDateString(end) && start <= date && date <= end;
}

export function eventsOnDate(events, date) {
  return (events || [])
    .filter((event) => isEventOnDate(event, date))
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, "zh-Hant"));
}

export function normalizeEvent(event) {
  if (!event || !isDateString(event.date) || !String(event.title || "").trim()) return null;
  const endDate = isDateString(event.endDate) && event.endDate >= event.date ? event.endDate : event.date;
  const type = CALENDAR_EVENT_META[event.type] ? event.type : "other";
  return {
    id: String(event.id || ""),
    date: event.date,
    endDate,
    title: String(event.title).trim().slice(0, 80),
    type,
    note: String(event.note || "").trim().slice(0, 300),
    school: String(event.school || "").trim().slice(0, 80),
    source: String(event.source || "手動建立").trim().slice(0, 120),
    sourceUrl: /^https?:\/\//.test(String(event.sourceUrl || "").trim()) ? String(event.sourceUrl).trim() : "",
    readOnly: Boolean(event.readOnly),
  };
}
