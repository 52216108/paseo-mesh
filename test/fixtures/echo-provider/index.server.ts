// Test-only Paseo agent provider for the paseo-peer end-to-end tests: every prompt is echoed back as the
// assistant reply ("Echo: <prompt>"). It calls no model and needs no credentials.
// Structure adapted from jtsang4/paseo-mesh (MIT), test/fixtures/echo-provider, trimmed to what paseo-peer needs.
//
// Deliberately imports nothing: Paseo 0.13 resolves type imports when it compiles a plugin, and this fixture has
// no node_modules. The provider protocol types (@getpaseo/plugin/server/provider) are therefore loosely inlined.

type Json = any
type Emit = (event: Json) => void

const MODEL = { id: "echo-1", label: "Echo 1" }
const MODE = { id: "default", label: "Default" }
// Steer is declared because paseo-peer tell sends with --behavior steer; an echo turn finishes at once,
// so a steered prompt is simply answered as a new turn.
const SUPPORTED = ["prompt.message", "prompt.steer", "session.archive", "session.unarchive", "session.list", "session.persistence"]

interface Session {
  config: Json
  persistence: Json
  turn: number
}

export default function contribute(server: Json) {
  server.registerProvider({
    id: "peer-echo",
    label: "paseo-peer echo (test)",
    description: "Echoes every prompt; for paseo-peer end-to-end tests",
    async connect(request: Json) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required")
      const capabilities = SUPPORTED.filter((c) => request.capabilities.includes(c))
      return connection(capabilities)
    },
  })
  return () => {}
}

function connection(capabilities: string[]) {
  const listeners = new Set<Emit>()
  const sessions = new Map<string, Session>()
  let closed = false
  const emit: Emit = (event) => {
    if (!closed) for (const listener of listeners) listener(event)
  }
  return {
    version: 1,
    capabilities,
    async send(input: Json) {
      if (closed) throw new Error("Provider connection is closed")
      if (input.type === "session.open" && sessions.has(input.sessionId)) throw new Error("Session already exists")
      if (input.type !== "session.open" && "sessionId" in input && !sessions.has(input.sessionId))
        throw new Error(`Unknown session: ${input.sessionId}`)
      queueMicrotask(() => { if (!closed) dispatch(input, sessions, emit) })
    },
    onEvent(listener: Emit) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() {
      closed = true
      sessions.clear()
      listeners.clear()
    },
  }
}

function dispatch(input: Json, sessions: Map<string, Session>, emit: Emit) {
  const done = () => { if (input.requestId) emit({ type: "request.completed", requestId: input.requestId }) }
  switch (input.type) {
    case "catalog":
      emit({
        type: "catalog",
        requestId: input.requestId,
        catalog: { models: [MODEL], modes: [MODE], defaultModel: MODEL.id, defaultMode: MODE.id },
      })
      return
    case "sessions":
      emit({
        type: "sessions",
        requestId: input.requestId,
        sessions: [...sessions.values()].map((s) => ({ persistence: s.persistence, cwd: s.config.cwd, title: s.config.title })),
      })
      return
    case "session.open": {
      const persistence = input.persistence ?? { version: 1, data: { nativeSessionId: `echo:${input.sessionId}` } }
      sessions.set(input.sessionId, { config: input.config, persistence, turn: 0 })
      emit({
        type: "session.opened",
        requestId: input.requestId,
        sessionId: input.sessionId,
        capabilities: SUPPORTED,
        restoration: "core",
        persistence,
        title: input.config.title,
        cwd: input.config.cwd,
      })
      emit({
        type: "session.config",
        sessionId: input.sessionId,
        config: { model: MODEL.id, mode: MODE.id, models: [MODEL], modes: [MODE], thinkingOptions: [], settings: [] },
      })
      emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId })
      return
    }
    case "session.prompt":
      prompt(input, sessions.get(input.sessionId)!, emit)
      return
    case "session.close":
      sessions.delete(input.sessionId)
      emit({ type: "session.closed", sessionId: input.sessionId })
      done()
      return
    default:
      // interrupt / archive / unarchive / configure: nothing is ever running, so just acknowledge
      done()
  }
}

function prompt(input: Json, session: Session, emit: Emit) {
  const { sessionId } = input
  const { clientMessageId } = input.prompt
  if (input.prompt.input.type !== "message") {
    emit({ type: "session.prompt_result", sessionId, clientMessageId, result: { type: "failed", error: { message: "Commands are not supported" } } })
    return
  }
  const text = input.prompt.input.content.filter((p: Json) => p.type === "text").map((p: Json) => p.text).join("\n")
  session.turn += 1
  const turnId = `turn-${session.turn}`
  emit({ type: "timeline.item", sessionId, item: { type: "user_message", id: `user-${session.turn}`, text, clientMessageId } })
  emit({ type: "session.prompt_result", sessionId, clientMessageId, result: { type: "turn", turnId } })
  emit({ type: "session.turn", sessionId, turnId, state: "started" })
  emit({ type: "timeline.item", sessionId, item: { type: "assistant_message", id: `assistant-${session.turn}`, text: `Echo: ${text}` } })
  session.persistence = { version: 1, data: { nativeSessionId: `echo:${sessionId}`, turns: session.turn } }
  emit({ type: "session.persistence", sessionId, persistence: session.persistence })
  emit({ type: "session.turn", sessionId, turnId, state: "completed" })
}
