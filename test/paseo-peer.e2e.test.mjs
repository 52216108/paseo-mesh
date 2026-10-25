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
})
