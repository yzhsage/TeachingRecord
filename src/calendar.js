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

function dateSerial(date) {
  if (!isDateString(date)) return NaN;
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function inclusiveDates(start, end) {
  if (!isDateString(start) || !isDateString(end) || end < start) return [];
  const dates = [];
  const cursor = new Date(dateSerial(start));
  const last = dateSerial(end);
  while (cursor.getTime() <= last && dates.length < 366) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function eventDates(event) {
  if (Array.isArray(event?.dates)) {
    const dates = [...new Set(event.dates.filter(isDateString))].sort();
    if (dates.length) return dates;
  }
  return inclusiveDates(event?.date, event?.endDate || event?.date);
}

export function isContinuousEvent(event) {
  const dates = eventDates(event);
  return dates.length > 1 && dates.every((date, index) => index === 0 || (dateSerial(date) - dateSerial(dates[index - 1])) === 86400000);
}

export function isEventOnDate(event, date) {
  return eventDates(event).includes(date);
}

export function eventsOnDate(events, date) {
  const eventList = Array.isArray(events) ? events : Object.values(events || {});
  return eventList
    .filter((event) => isEventOnDate(event, date))
    .sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), "zh-Hant"));
}

export function normalizeEvent(event) {
  if (!event) return null;
  const rawDates = Array.isArray(event.dates) ? [...new Set(event.dates.filter(isDateString))].sort() : [];
  const firstDate = rawDates[0] || (isDateString(event.date) ? event.date : "");
  if (!firstDate || !String(event.title || "").trim()) return null;
  const lastDate = rawDates[rawDates.length - 1] || (isDateString(event.endDate) && event.endDate >= firstDate ? event.endDate : firstDate);
  const dates = rawDates.length ? rawDates : inclusiveDates(firstDate, lastDate);
  const type = CALENDAR_EVENT_META[event.type] ? event.type : "other";
  const rawSchools = Array.isArray(event.schools) ? event.schools : [event.school];
  const schools = [...new Set(rawSchools.map((school) => String(school || "").trim()).filter(Boolean))].slice(0, 30);
  return {
    id: String(event.id || ""),
    date: firstDate,
    endDate: lastDate,
    dates,
    title: String(event.title).trim().slice(0, 80),
    type,
    note: String(event.note || "").trim().slice(0, 300),
    schools,
    school: schools[0] || "",
    source: String(event.source || "手動建立").trim().slice(0, 120),
    sourceUrl: /^https?:\/\//.test(String(event.sourceUrl || "").trim()) ? String(event.sourceUrl).trim() : "",
    readOnly: Boolean(event.readOnly),
  };
}
