import { SessionStore } from "../src/agent/session-store.ts";

const file = process.argv[2] ?? String.raw`C:\Users\MuLiu\AppData\Roaming\MeowCode\agent\sessions\2026-11-01T02-15-25-387Z_D-MeowCode.jsonl`;
const store = await SessionStore.load(file);
console.log("id:", store.id);
console.log("entries:", store.entries.length);
console.log("messages:", store.messages.length);
const client = store.messagesForClient;
console.log("messagesForClient:", client.length);
for (const m of client.slice(0, 30)) {
  console.log(" -", m.role, String(m.content).slice(0, 40).replace(/\n/g, " "));
}
console.log("checkpoints:", store.checkpoints.length, "lastRewind:", store.lastRewind?.mode ?? null);
