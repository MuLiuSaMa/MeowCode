/**
 * SSE→IPC 微批合帧（纯逻辑，无 Electron 依赖，可单测）。
 *
 * agent server 的每个事件走一条 SSE 帧 → 主进程逐帧 webContents.send，
 * 高频 delta（assistant/thinking/tool_output）会把 IPC 打成每秒几百条，
 * renderer 每帧一次 setState。这里按事件类型分流：
 *  - 可合并的纯增量事件 → 16ms 微批，一帧 IPC 回放多条；
 *  - 终态/关键事件（回合结束、审批、错误、重同步…）→ 先 flush 队列保持
 *    全局顺序，再立即单发，绝不被合帧吞掉或延迟到批后；
 *  - 未知类型默认直发（新增事件类型天然安全）。
 * 单条批次保持原 payload 形态（不包 batch），旧版渲染层零兼容负担。
 */

/** 允许合并进批次的高频纯增量事件类型。 */
const BATCHABLE_TYPES = new Set([
  "assistant_delta",
  "thinking_delta",
  "tool_output",
  "tool_call_progress",
]);

const BATCH_INTERVAL_MS = 16;

function createEventBatcher(send, intervalMs = BATCH_INTERVAL_MS) {
  let queue = [];
  let timer = null;

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    if (batch.length === 1) {
      send(batch[0]);
      return;
    }
    send({ batch });
  }

  return {
    push(payload) {
      if (!payload || typeof payload !== "object" || !BATCHABLE_TYPES.has(payload.type)) {
        // 终态/关键/未知事件：先冲掉已排队增量（保序），再立即直发
        flush();
        send(payload);
        return;
      }
      queue.push(payload);
      if (!timer) timer = setTimeout(flush, intervalMs);
    },
    /** 事件流断开/进程退出前冲掉尾巴，防止最后几条增量滞留在队列里。 */
    flush,
    /** 丢弃未发送的批次（窗口销毁时用）。 */
    stop() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      queue = [];
    },
  };
}

module.exports = { createEventBatcher, BATCHABLE_TYPES, BATCH_INTERVAL_MS };
