/**
 * 会话日志插件（适配自 metis-main examples/extensions/session-name.ts）
 *
 * MeowCode 无会话重命名 API，改为记录会话历史：session_start 时把会话写入 storage，
 * /sessions-log 查看。适合当作轻量「最近在哪些项目里干了什么」的回顾。
 */
import type { PluginFactory } from "meowcode";

type SessionRecord = { sessionId: string; cwd: string; startedAt: string };

const factory: PluginFactory = (api) => {
  api.on("session_start", async (event) => {
    const records = (await api.storage.get<SessionRecord[]>("sessions")) ?? [];
    if (records.some((r) => r.sessionId === event.sessionId)) return;
    records.unshift({
      sessionId: event.sessionId,
      cwd: event.cwd,
      startedAt: new Date().toISOString(),
    });
    await api.storage.set("sessions", records.slice(0, 100));
  });

  api.registerCommand({
    name: "sessions-log",
    description: "查看插件记录的最近会话",
    run: async () => {
      const records = (await api.storage.get<SessionRecord[]>("sessions")) ?? [];
      if (records.length === 0) return "还没有记录";
      return records
        .slice(0, 20)
        .map((r) => `- ${r.startedAt.slice(0, 16).replace("T", " ")}  ${r.cwd}`)
        .join("\n");
    },
  });

  api.logger.info("session-name loaded（会话日志）");
};

export default factory;
