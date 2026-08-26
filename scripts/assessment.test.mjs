import test from "node:test";
import assert from "node:assert/strict";
import {
  buildScoreDistribution,
  median,
  numericScore,
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
