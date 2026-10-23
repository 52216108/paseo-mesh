import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { parseClaude, parseCodex, summarize } from "./server/parse";
import {
  fileSize,
  findSessionFile,
  providerKind,
  readFrom,
  type SessionProvider,
} from "./server/session-files";
import { SPEED_ROW_KIND, SPEED_ROW_VERSION, type SpeedRow } from "./shared/speed";

interface TurnStart {
  startedAt: number;
  sessionId: string | null;
  file: string | null;
  offset: number;
}

// 会话日志在回合结束后可能还没落盘，按这些间隔重读
const READ_DELAYS_MS = [800, 2_500];

async function sessionIdOf(paseo: PluginHandlerContext["paseo"], agentId: string): Promise<string | null> {
  const ref = paseo.agents.ref(agentId);
  await ref.refresh();
  return ref.runtimeInfo?.sessionId ?? ref.current()?.persistence?.sessionId ?? null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

function logError(stage: string, error: unknown): void {
  // 只记错误信息，不带任何日志内容
  console.error(`turn-speed ${stage}: ${error instanceof Error ? error.message : String(error)}`);
}

export default function contribute(server: PluginServerContext) {
  const turns = new Map<string, TurnStart>();

  server.on("agent.turn_started", async (event, { paseo }) => {
    const kind = providerKind(event.agent.provider);
    if (!kind) return;
    const turn: TurnStart = { startedAt: Date.now(), sessionId: null, file: null, offset: 0 };
    turns.set(event.agent.id, turn);
    try {
      turn.sessionId = await sessionIdOf(paseo, event.agent.id);
      if (!turn.sessionId) return;
      turn.file = await findSessionFile(kind, turn.sessionId, event.agent.cwd);
      if (turn.file) turn.offset = await fileSize(turn.file);
    } catch (error) {
      logError("turn_started", error);
    }
  });

  server.on("agent.turn_ended", async (event, { paseo, signal }) => {
    const turn = turns.get(event.agent.id);
    turns.delete(event.agent.id);
    const kind = providerKind(event.agent.provider);
    if (!turn || !kind || event.outcome.kind !== "completed") return;
    const endedAt = Date.now();
    try {
      const sessionId = await sessionIdOf(paseo, event.agent.id);
      if (!sessionId) return;
      // 会话换了（新建或恢复成新会话）时，开始时记下的偏移量作废，从头按时间窗筛
      const sameFile = sessionId === turn.sessionId && turn.file !== null;
      const file = sameFile ? turn.file : await findSessionFile(kind, sessionId, event.agent.cwd);
      if (!file) return;
      const offset = sameFile ? turn.offset : 0;
      let row: SpeedRow | null = null;
      for (const delay of READ_DELAYS_MS) {
        await sleep(delay, signal);
        row = measure(kind, await readFrom(file, offset), turn.startedAt, endedAt);
        if (row) break;
      }
      if (!row) return;
      await paseo.agents.ref(event.agent.id).timeline.append({
        type: "plugin",
        id: `turn-${turn.startedAt}`,
        kind: SPEED_ROW_KIND,
        version: SPEED_ROW_VERSION,
        data: { ...row },
      });
    } catch (error) {
      logError("turn_ended", error);
    }
  });

  return () => {
    turns.clear();
  };
}

function measure(
  kind: SessionProvider,
  text: string,
  startedAt: number,
  endedAt: number,
): SpeedRow | null {
  const requests = kind === "claude" ? parseClaude(text, startedAt) : parseCodex(text, startedAt);
  return summarize(kind, requests, startedAt, endedAt);
}
