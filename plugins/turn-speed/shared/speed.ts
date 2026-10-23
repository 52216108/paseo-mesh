import { z } from "zod";

// 对话里「本轮生成速度」那一行的数据契约，服务端写入、客户端按同一 schema 校验后渲染。
export const SPEED_ROW_KIND = "turn-speed";
export const SPEED_ROW_VERSION = 1;

export const speedRowSchema = z.object({
  // 会话日志来源：claude = Claude Code，codex = Codex
  provider: z.enum(["claude", "codex"]),
  // 本轮所有模型请求的输出 token 之和（含思考/推理 token）
  outputTokens: z.number().int().nonnegative(),
  // 本轮所有模型请求的耗时之和（毫秒），不含工具执行时间，含首字延迟
  generationMs: z.number().nonnegative(),
  // 本轮模型请求次数
  requests: z.number().int().positive(),
  // outputTokens ÷ generationMs 折算的每秒 token 数
  tokensPerSecond: z.number().nonnegative(),
});

export type SpeedRow = z.output<typeof speedRowSchema>;
