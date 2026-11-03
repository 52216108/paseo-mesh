// End-to-end tests for paseo-peer: two real Paseo daemons ("machines" a and b) in temporary homes, with a
// model-free echo provider as the agents. Run with: node --test test/
// Skipped when the Paseo CLI is missing (override its path with PASEO_BIN).
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs"
import path from "node:path"
import { Machine, PASEO_BIN, REAL_SDK_DIR, haveDaemon, waitFor } from "./harness.mjs"

const tag = Math.random().toString(36).slice(2, 8)
const WORD_A = `quokka-${tag}-alpha`
const WORD_B = `quokka-${tag}-bravo`

describe("paseo-peer end-to-end", { skip: haveDaemon() ? false : `Paseo CLI not found at ${PASEO_BIN} (set PASEO_BIN)`, timeout: 600_000 }, () => {
  const a = new Machine("a")
  const b = new Machine("b")
  let alpha, beta, bravo

  before(async () => {
    await Promise.all([a.start(), b.start()])
    for (const m of [a, b]) m.writePeers([a, b])
    ;[alpha, beta, bravo] = await Promise.all([
      a.agent("proj-alpha", "alpha", `working on ${WORD_A}`),
      a.agent("proj-beta", "beta", "beta is ready"),
      b.agent("proj-bravo", "bravo", `working on ${WORD_B}`),
    ])
  })

  after(async () => {
    await Promise.all([a.destroy(), b.destroy()])
  })

  describe("find", () => {
    test("local find returns the session whose messages mention the word", async () => {
      const r = await a.peer(["local", "find", WORD_A])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, new RegExp(`^${alpha.shortId}\\s.*\\salpha$`, "m"))
      assert.match(r.stdout, new RegExp(WORD_A))
      assert.doesNotMatch(r.stdout, new RegExp(beta.shortId))
    })

    test("find on another machine searches that machine's sessions", async () => {
      const r = await a.peer(["b", "find", WORD_B])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, new RegExp(`^${bravo.shortId}\\s.*\\sbravo$`, "m"))
      // Really answered by b: a's own session is not there
      const miss = await a.peer(["b", "find", WORD_A])
      assert.equal(miss.code, 0, miss.stderr)
      assert.match(miss.stdout, /^No match for /)
    })

    test("find -a on another machine also searches recently created archived sessions", async () => {
      const word = `quokka-${tag}-charlie`
      const charlie = await b.agent("proj-charlie", "charlie", `working on ${word}`)
      const ar = await b.cli(["archive", charlie.id])
      assert.equal(ar.code, 0, ar.stderr)
      // The echo provider keeps no timeline once archived, so count the sessions searched instead of matching text
      const count = (r) => Number(/ of (\d+) sessions/.exec(r.stdout)?.[1])
      const live = await a.peer(["b", "find", word])
      assert.equal(live.code, 0, live.stderr)
      const all = await a.peer(["b", "find", "-a", word])
      assert.equal(all.code, 0, all.stderr)
      assert.equal(count(all), count(live) + 1, `${live.stdout}\n${all.stdout}`)
      assert.equal(all.stderr, "") // created just now: inside the default 7-day window, nothing skipped
    })

    test("refuses to run when peers.json is readable by others", async () => {
      const file = path.join(a.home, "peers.json")
      chmodSync(file, 0o644)
      try {
        const r = await a.peer(["b", "find", WORD_B], { PASEO_PEER_LANG: "en" })
        assert.notEqual(r.code, 0)
        assert.match(r.stderr, /readable by others/)
      } finally {
        chmodSync(file, 0o600)
      }
    })
  })

  describe("tell", () => {
    // Sent as session alpha on a, so the sender line and the reply command can be built
    const fromAlpha = (lang) => ({ PASEO_AGENT_ID: alpha.id, PASEO_PEER_LANG: lang })
    const received = (machine, agent, needle) =>
      waitFor(async () => { const out = await machine.logs(agent.id); return out.includes(needle) && out },
        { message: `message "${needle}" never reached ${agent.shortId}` })

    test("cross-machine tell (en) adds the sender line and the reply command", async () => {
      const body = `please check ${tag}-en`
      const r = await a.peer(["b", "tell", bravo.shortId, body], fromAlpha("en"))
      assert.equal(r.code, 0, r.stderr)
      const out = await received(b, bravo, body)
      assert.match(out, new RegExp(`\\[Cross-machine message\\] From session "alpha" in project "proj-alpha" \\(id ${alpha.shortId}\\) on Test A`))
      assert.match(out, new RegExp(`\\(To reply, run: \\S+ a tell ${alpha.shortId} "your reply"`))
      assert.doesNotMatch(out, /Cross-project message/)
    })

    test("cross-machine tell (zh) uses the Chinese sender line", async () => {
      const body = `请看一下 ${tag}-zh`
      const r = await a.peer(["b", "tell", bravo.shortId, body], fromAlpha("zh"))
      assert.equal(r.code, 0, r.stderr)
      const out = await received(b, bravo, body)
      assert.match(out, new RegExp(`【跨机器消息】来自 Test A 上「proj-alpha」项目的会话「alpha」（id ${alpha.shortId}）`))
      assert.match(out, new RegExp(`（回复请运行：\\S+ a tell ${alpha.shortId} "回复内容"`))
    })

    test("local tell is marked as a cross-project message", async () => {
      const body = `local hello ${tag}`
      const r = await a.peer(["local", "tell", beta.shortId, body], fromAlpha("en"))
      assert.equal(r.code, 0, r.stderr)
      const out = await received(a, beta, body)
      assert.match(out, new RegExp(`\\[Cross-project message\\] From session "alpha" in project "proj-alpha" \\(id ${alpha.shortId}\\)`))
      assert.doesNotMatch(out, /Cross-machine message/)
      assert.match(out, new RegExp(`a tell ${alpha.shortId} "your reply"`))
    })
  })

  describe("link", () => {
    // link loads the Paseo SDK from <dirname(peers.json)>/paseo-mesh-sdk and npm-installs it when the version
    // differs from the daemon's. Reuse an installed SDK of exactly that version, read-only via a node_modules
    // link, so nothing is installed (and nothing is ever written into the real SDK dir). Returns a skip reason.
    let sdkProblem
    const prepareSdk = async () => {
      if (sdkProblem !== undefined) return sdkProblem
      const { daemonVersion } = await a.cliJson(["daemon", "status"])
      const pkg = path.join(REAL_SDK_DIR, "node_modules", "@getpaseo", "client", "package.json")
      const have = existsSync(pkg) ? JSON.parse(readFileSync(pkg, "utf8")).version : null
      if (have !== daemonVersion) {
        sdkProblem = `needs @getpaseo/client@${daemonVersion} installed in ${REAL_SDK_DIR} (found ${have ?? "none"}; set PASEO_PEER_SDK)`
      } else {
        const sdk = path.join(a.home, "paseo-mesh-sdk")
        mkdirSync(sdk, { recursive: true })
        symlinkSync(path.join(REAL_SDK_DIR, "node_modules"), path.join(sdk, "node_modules"))
        sdkProblem = null
      }
      return sdkProblem
    }

    test("registers the other machine as an online connected host", async (t) => {
      const problem = await prepareSdk()
      if (problem) return t.skip(problem)

      // peers.json holds direct daemon addresses (no relay offline); PASEO_PEER_ALLOW_DIRECT lets link accept them
      const r = await a.peer(["link", "b"], { PASEO_PEER_LANG: "en", PASEO_PEER_ALLOW_DIRECT: "1" })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /Added connected host b \(Test B\)/)
      assert.match(r.stdout, new RegExp(`✓ b online \\(serverId ${b.serverId}\\)`))

      const hosts = await a.cliJson(["host", "ls"])
      const h = hosts.find((x) => x.serverId === b.serverId)
      assert.ok(h, `b missing from host ls: ${JSON.stringify(hosts)}`)
      assert.equal(h.status, "online")
      assert.equal(h.label, "b")

      const doctor = await a.peer(["doctor"], { PASEO_PEER_LANG: "en" })
      assert.match(doctor.stdout, /✓ b is a connected host here \(online\)/)

      // Running link again updates the same registration instead of adding a second one
      const again = await a.peer(["link", "b"], { PASEO_PEER_LANG: "en", PASEO_PEER_ALLOW_DIRECT: "1" })
      assert.equal(again.code, 0, again.stdout + again.stderr)
      assert.match(again.stdout, /Updated connected host b/)
      assert.equal((await a.cliJson(["host", "ls"])).filter((x) => x.serverId === b.serverId).length, 1)
    })

    test("without the opt-in, a direct address is still rejected as a pairing link", async (t) => {
      const problem = await prepareSdk()
      if (problem) return t.skip(problem)
      const r = await a.peer(["link", "b"], { PASEO_PEER_LANG: "en" })
      assert.notEqual(r.code, 0)
      assert.match(r.stderr, /Can't parse the pairing link for b/)
    })
  })

  // Last: the closed case restarts b's daemon, which closes every session there
  describe("wait", () => {
    const status = async (m, agent) => (await m.cliJson(["inspect", agent.id])).Status
    const fast = ["--interval", "1"]

    test("target was closed: sending wakes it, wait sees the whole turn and prints the full reply", async () => {
      const r0 = await b.cli(["daemon", "restart", "--timeout", "60"])
      assert.equal(r0.code, 0, r0.stderr)
      await waitFor(async () => (await status(b, bravo)) === "closed", { message: "bravo never became closed" })
      // Longer than the 4000 characters a finish notification carries
      const body = `closed-case ${tag} sleep:3 ${"long-".repeat(1000)}end-${tag}`
      const sent = await a.peer(["b", "send", "--no-wait", bravo.id, body])
      assert.equal(sent.code, 0, sent.stderr)
      const r = await a.peer(["b", "wait", bravo.shortId, ...fast], { PASEO_PEER_LANG: "en" })
      console.log(r.stdout.slice(0, 300) + " … " + r.stdout.slice(-80))
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, new RegExp(`^Session ${bravo.shortId} on b finished its turn \\(.+\\); final status idle$`, "m"))
      assert.ok(r.stdout.includes(`Echo: ${body}`), "full reply missing")
      assert.ok(r.stdout.length > 5000)
    })

    test("target was idle: wait (zh) follows the turn to the end", async () => {
      assert.equal(await status(a, beta), "idle")
      const body = `idle-case ${tag} sleep:3`
      const sent = await a.peer(["local", "send", "--no-wait", beta.id, body])
      assert.equal(sent.code, 0, sent.stderr)
      const r = await a.peer(["local", "wait", beta.shortId, ...fast], { PASEO_PEER_LANG: "zh" })
      console.log(r.stdout)
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, new RegExp(`local 上的会话 ${beta.shortId} 这一轮已跑完（.+），最终状态 idle`))
      assert.match(r.stdout, new RegExp(`--- 最后一条回复（全文）---\\nEcho: ${body}$`, "m"))
    })

    test("nothing sent: exits 2 (not started) after the start grace", async () => {
      const r = await a.peer(["local", "wait", alpha.shortId, ...fast, "--start-grace", "3"], { PASEO_PEER_LANG: "en" })
      console.log(r.stdout)
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stdout, new RegExp(`Session ${alpha.shortId} on local did not start within 3 s`))
    })

    test("still running at the timeout: exits 3", async () => {
      const sent = await a.peer(["local", "send", "--no-wait", alpha.id, `slow ${tag} sleep:20`])
      assert.equal(sent.code, 0, sent.stderr)
      const r = await a.peer(["local", "wait", alpha.shortId, ...fast, "--timeout", "0.05"], { PASEO_PEER_LANG: "en" })
      console.log(r.stdout)
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(r.stdout, /is still running/)
    })

    test("unknown session: exits 5 after the start grace", async () => {
      const r = await a.peer(["local", "wait", "fffffff", ...fast, "--start-grace", "2"], { PASEO_PEER_LANG: "en" })
      assert.equal(r.code, 5, r.stdout + r.stderr)
      assert.match(r.stdout, /Could not read the status of session fffffff on local/)
    })
  })
})
