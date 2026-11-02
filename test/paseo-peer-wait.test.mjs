// Unit tests for paseo-peer wait: argument parsing, status parsing and the exit-code decisions. No daemon needed.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { EXIT, initialState, parseArgs, parseInspect, parseLastReply, step } from "../skills/paseo-peer/scripts/paseo-peer-wait.mjs"

const inspect = (status, updatedAt = "2026-11-02T10:00:00.000Z", pending = []) =>
  JSON.stringify({ Id: "abcdef1-2345", Name: "x", Status: status, UpdatedAt: updatedAt, PendingPermissions: pending })
const sample = (...a) => parseInspect(inspect(...a))
const OPTS = { timeoutMs: 60_000, startGraceMs: 10_000 }

/** Feeds samples one per second from t=0; returns the first decision (and when it came), or null. */
function drive(samples, opts = OPTS) {
  let state = initialState(0)
  for (let i = 0; i < samples.length; i++) {
    const r = step(state, samples[i], i * 1000, opts)
    state = r.state
    if (r.done) return { ...r.done, at: i, state }
  }
  return null
}

describe("parseArgs", () => {
  test("defaults: 60 min timeout, 30 s interval, 300 s start grace", () => {
    assert.deepEqual(parseArgs(["abc"]), { id: "abc", timeoutMs: 3_600_000, intervalMs: 30_000, startGraceMs: 300_000 })
  })
  test("accepts options in any order", () => {
    assert.deepEqual(parseArgs(["--interval", "5", "abc", "--timeout", "0.5", "--start-grace", "0"]),
      { id: "abc", timeoutMs: 30_000, intervalMs: 5000, startGraceMs: 0 })
  })
  test("rejects a timeout over 120 minutes, bad numbers, unknown options, missing id", () => {
    assert.ok(parseArgs(["abc", "--timeout", "121"]).error)
    assert.ok(parseArgs(["abc", "--timeout", "0"]).error)
    assert.ok(parseArgs(["abc", "--interval", "x"]).error)
    assert.ok(parseArgs(["abc", "--interval"]).error)
    assert.ok(parseArgs(["abc", "--follow"]).error)
    assert.ok(parseArgs(["abc", "def"]).error)
    assert.ok(parseArgs([]).error)
  })
})

describe("parseInspect", () => {
  test("reads Status / UpdatedAt / PendingPermissions from the JSON fields", () => {
    const s = parseInspect(inspect("running", "2026-11-02T10:00:00.000Z", [{ id: "p1", tool: "Bash" }]))
    assert.deepEqual(s, { ok: true, id: "abcdef1-2345", status: "running", updatedAt: "2026-11-02T10:00:00.000Z", pending: [{ id: "p1", tool: "Bash" }] })
  })
  test("table text (like `ls` columns) is not mistaken for a status", () => {
    assert.equal(parseInspect("abcdef1  idle  3 hours ago  title").ok, false)
    assert.equal(parseInspect(JSON.stringify({ Id: "x" })).ok, false)
    assert.equal(parseInspect("").ok, false)
  })
})

describe("step", () => {
  test("not running → running → idle: finished (0), reply looked up from the last idle poll", () => {
    const r = drive([sample("idle"), sample("running"), sample("running"), sample("idle", "2026-11-02T10:05:00Z")])
    assert.equal(r.code, EXIT.done)
    assert.equal(r.status, "idle")
    assert.equal(r.at, 3)
    assert.equal(r.state.sinceMs, 0)
  })
  test("closed → initializing → running → idle (the lost-notification case): finished (0)", () => {
    const r = drive([sample("closed"), sample("initializing"), sample("running"), sample("idle", "2026-11-02T10:05:00Z")])
    assert.equal(r.code, EXIT.done)
    assert.equal(r.at, 3)
  })
  test("already running on the first poll counts as started; no since bound", () => {
    const r = drive([sample("running"), sample("idle", "2026-11-02T10:05:00Z")])
    assert.equal(r.code, EXIT.done)
    assert.equal(r.state.sinceMs, null)
  })
  test("ending in error is still the end of the turn, with status error", () => {
    const r = drive([sample("running"), sample("error")])
    assert.deepEqual([r.code, r.status], [EXIT.done, "error"])
  })
  test("a turn shorter than one interval: UpdatedAt moved while idle → finished (0)", () => {
    const r = drive([sample("idle", "t1"), sample("idle", "t1"), sample("idle", "t2")])
    assert.equal(r.code, EXIT.done)
    assert.equal(r.at, 2)
  })
  test("a closed session waking up without running is not a finished turn", () => {
    const r = drive([sample("closed", "t1"), sample("closed", "t2"), sample("initializing", "t3")])
    assert.equal(r, null)
  })
  test("never starts within the grace: not started (2)", () => {
    const r = drive(Array.from({ length: 20 }, () => sample("idle")))
    assert.deepEqual([r.code, r.at], [EXIT.notStarted, 10])
  })
  test("still running at the timeout: timeout (3)", () => {
    const r = drive(Array.from({ length: 70 }, () => sample("running")))
    assert.deepEqual([r.code, r.at], [EXIT.timeout, 60])
  })
  test("a pending permission request ends the wait at once: permission (4)", () => {
    const r = drive([sample("running"), sample("running", undefined, [{ id: "p1", tool: "Bash" }])])
    assert.deepEqual([r.code, r.at], [EXIT.permission, 1])
  })
  test("status never readable: unreachable (5) after the start grace", () => {
    const r = drive(Array.from({ length: 20 }, () => ({ ok: false, error: "connect ECONNREFUSED" })))
    assert.deepEqual([r.code, r.at], [EXIT.unreachable, 10])
    assert.equal(r.state.lastError, "connect ECONNREFUSED")
  })
  test("a few failed polls in the middle of a turn are tolerated", () => {
    const fail = { ok: false, error: "timeout" }
    const r = drive([sample("running"), fail, fail, sample("running"), sample("idle", "t9")])
    assert.deepEqual([r.code, r.at], [EXIT.done, 4])
  })
})

describe("parseLastReply", () => {
  test("keeps the whole reply (no 4000-character cut) and trims trailing whitespace", () => {
    const long = "x".repeat(9000)
    assert.equal(parseLastReply(`${long}\n\n`), long)
  })
  test("no activity → empty", () => {
    assert.equal(parseLastReply("No activity to display.\n"), "")
    assert.equal(parseLastReply(""), "")
  })
})
