import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SpeedRow } from "../shared/speed";

export type SessionProvider = SpeedRow["provider"];

// 单次最多读取的日志字节数，防止从头读超大会话文件
const MAX_READ_BYTES = 64 * 1024 * 1024;

const pathCache = new Map<string, string>();

export function providerKind(provider: string): SessionProvider | null {
  const base = provider.split("/")[0];
  if (base === "claude") return "claude";
  if (base === "codex") return "codex";
  return null;
}

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function listDirs(path: string, newestFirst = false): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    return newestFirst ? names.sort().reverse() : names;
  } catch {
    return [];
  }
}

async function findClaudeFile(sessionId: string, cwd: string): Promise<string | null> {
  const projects = join(claudeHome(), "projects");
  const name = `${sessionId}.jsonl`;
  const guessed = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), name);
  if (await exists(guessed)) return guessed;
  for (const dir of await listDirs(projects)) {
    const candidate = join(projects, dir, name);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

// Codex 会话文件在 sessions/年/月/日/rollout-<时间>-<线程ID>.jsonl，从最近的日期往前找
async function findCodexFile(threadId: string): Promise<string | null> {
  const sessions = join(codexHome(), "sessions");
  const suffix = `-${threadId}.jsonl`;
  for (const year of await listDirs(sessions, true)) {
    for (const month of await listDirs(join(sessions, year), true)) {
      for (const day of await listDirs(join(sessions, year, month), true)) {
        const dir = join(sessions, year, month, day);
        const names = await readdir(dir).catch(() => [] as string[]);
        const hit = names.find((name) => name.endsWith(suffix));
        if (hit) return join(dir, hit);
      }
    }
  }
  return null;
}

export async function findSessionFile(
  kind: SessionProvider,
  sessionId: string,
  cwd: string,
): Promise<string | null> {
  // 会话 ID 拼进文件路径，只接受字母数字和连字符，杜绝路径穿越
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return null;
  const key = `${kind}:${sessionId}`;
  const cached = pathCache.get(key);
  if (cached && (await exists(cached))) return cached;
  const found = kind === "claude" ? await findClaudeFile(sessionId, cwd) : await findCodexFile(sessionId);
  if (found) pathCache.set(key, found);
  return found;
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

export async function readFrom(path: string, offset: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(Math.min(offset, size), size - MAX_READ_BYTES, 0);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}
