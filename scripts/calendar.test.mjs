import assert from "node:assert/strict";
import test from "node:test";
import { eventsOnDate, normalizeEvent } from "../src/calendar.js";

test("eventsOnDate includes dates inside a multi-day event", () => {
  const events = [{ id: "a", date: "2026-05-16", endDate: "2026-05-17", title: "會考", type: "majorExam" }];
  assert.equal(eventsOnDate(events, "2026-05-16").length, 1);
  assert.equal(eventsOnDate(events, "2026-05-17").length, 1);
  assert.equal(eventsOnDate(events, "2026-05-18").length, 0);
});

test("normalizeEvent rejects incomplete input and clamps unsafe text", () => {
  assert.equal(normalizeEvent({ title: "沒有日期" }), null);
  const event = normalizeEvent({
    id: "x",
    date: "2026-09-01",
    endDate: "2026-08-01",
    title: "  段考  ",
    type: "not-a-type",
    school: "高中",
    sourceUrl: "javascript:alert(1)",
  });
  assert.equal(event.title, "段考");
  assert.equal(event.endDate, "2026-09-01");
  assert.equal(event.type, "other");
  assert.equal(event.sourceUrl, "");
});
