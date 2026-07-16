import assert from "node:assert/strict";
import test from "node:test";

import { resumeEnabled, stripResumeFields, stripResumeDraft } from "./resumeVisibility.mjs";

function withFlag(value, fn) {
  const saved = process.env.WORK_LOG_ENABLE_RESUME;
  if (value === undefined) delete process.env.WORK_LOG_ENABLE_RESUME;
  else process.env.WORK_LOG_ENABLE_RESUME = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.WORK_LOG_ENABLE_RESUME;
    else process.env.WORK_LOG_ENABLE_RESUME = saved;
  }
}

test("resumeEnabled is true only for exactly '1'", () => {
  withFlag("1", () => assert.equal(resumeEnabled(), true));
  withFlag("0", () => assert.equal(resumeEnabled(), false));
  withFlag(undefined, () => assert.equal(resumeEnabled(), false));
  withFlag("true", () => assert.equal(resumeEnabled(), false));
});

test("stripResumeFields removes resume when disabled, keeps it when enabled", () => {
  const summary = { date: "2026-07-16", sessionCount: 3, resume: { candidates: ["x"] } };
  withFlag(undefined, () => {
    const out = stripResumeFields(summary);
    assert.equal("resume" in out, false);
    assert.equal(out.sessionCount, 3);
    assert.equal("resume" in summary, true, "must not mutate input");
  });
  withFlag("1", () => assert.deepEqual(stripResumeFields(summary), summary));
});

test("stripResumeDraft removes resumeDraft when disabled, keeps it when enabled", () => {
  const profile = { dayCount: 5, resumeDraft: { headline: "h" }, workStyleAnalysis: null };
  withFlag(undefined, () => {
    const out = stripResumeDraft(profile);
    assert.equal("resumeDraft" in out, false);
    assert.equal(out.dayCount, 5);
  });
  withFlag("1", () => assert.deepEqual(stripResumeDraft(profile), profile));
});

test("strip helpers pass through null / non-object", () => {
  withFlag(undefined, () => {
    assert.equal(stripResumeFields(null), null);
    assert.equal(stripResumeDraft(undefined), undefined);
  });
});
