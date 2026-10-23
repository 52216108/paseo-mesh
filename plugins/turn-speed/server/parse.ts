import type { SpeedRow } from "../shared/speed";

// 一次模型请求：从最后一个输入（用户消息/工具结果）写入到这次回复写完。
export interface ModelRequest {
  startAt: number;
  endAt: number;
  outputTokens: number;
}

// 只取时间戳、类型、消息 ID 和 token 数，对话正文一律不读不存。
function parseLines(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // 从文件中间开始读时第一行可能不完整，跳过即可
    }
  }
  return rows;
}

function timeOf(row: Record<string, unknown>): number | null {
  const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
  return Number.isFinite(at) ? at : null;
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

// Claude Code：一条回复按内容块拆成多行 assistant，共用 message.id；
// 其余带时间戳的行（user/tool_result/attachment 等）视为输入。
export function parseClaude(text: string, fallbackStart: number): ModelRequest[] {
  const byId = new Map<string, ModelRequest>();
  let lastInputAt: number | null = null;
  for (const row of parseLines(text)) {
    const at = timeOf(row);
    if (at === null || row.isSidechain === true) continue;
    if (row.type !== "assistant") {
      lastInputAt = at;
      continue;
    }
    const message = row.message;
    const id = field(message, "id");
    if (typeof id !== "string" || field(message, "model") === "<synthetic>") continue;
    const output = field(field(message, "usage"), "output_tokens");
    let request = byId.get(id);
    if (!request) {
      request = { startAt: lastInputAt ?? fallbackStart, endAt: at, outputTokens: 0 };
      byId.set(id, request);
    }
    request.endAt = Math.max(request.endAt, at);
    if (typeof output === "number") request.outputTokens = Math.max(request.outputTokens, output);
  }
  return [...byId.values()];
}

function isCodexOutput(payload: unknown): boolean {
  const type = field(payload, "type");
  if (typeof type !== "string") return false;
  if (type === "message") return field(payload, "role") === "assistant";
  return type === "reasoning" || type.endsWith("_call");
}

// Codex：每次回复结束写一条 token_usage_record（带本次 usage）；
// 回复开始前最后一条非模型产出的 response_item（用户消息/工具输出）视为输入。
export function parseCodex(text: string, fallbackStart: number): ModelRequest[] {
  const requests: ModelRequest[] = [];
  const seen = new Set<string>();
  let lastInputAt: number | null = null;
  let outputSeen = false;
  for (const row of parseLines(text)) {
    const at = timeOf(row);
    if (at === null) continue;
    if (row.type === "token_usage_record") {
      const responseId = field(row.payload, "response_id");
      const output = field(field(row.payload, "usage"), "output_tokens");
      const fresh = typeof responseId !== "string" || !seen.has(responseId);
      if (typeof responseId === "string") seen.add(responseId);
      if (fresh && typeof output === "number") {
        requests.push({ startAt: lastInputAt ?? fallbackStart, endAt: at, outputTokens: output });
      }
      lastInputAt = at;
      outputSeen = false;
      continue;
    }
    if (row.type !== "response_item") continue;
    if (isCodexOutput(row.payload)) outputSeen = true;
    else if (!outputSeen) lastInputAt = at;
  }
  return requests;
}

// 汇总落在本轮时间窗内的请求；没有可用数据时返回 null（不显示，绝不编造数字）。
export function summarize(
  provider: SpeedRow["provider"],
  requests: ModelRequest[],
  turnStartedAt: number,
  turnEndedAt: number,
): SpeedRow | null {
  let outputTokens = 0;
  let generationMs = 0;
  let count = 0;
  for (const request of requests) {
    const duration = request.endAt - request.startAt;
    if (request.outputTokens <= 0 || duration <= 0) continue;
    if (request.endAt < turnStartedAt - 2_000 || request.endAt > turnEndedAt + 10_000) continue;
    outputTokens += request.outputTokens;
    generationMs += duration;
    count += 1;
  }
  if (count === 0 || generationMs <= 0) return null;
  const tokensPerSecond = Math.round((outputTokens / generationMs) * 10_000) / 10;
  return { provider, outputTokens, generationMs, requests: count, tokensPerSecond };
}
