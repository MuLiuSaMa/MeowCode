import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuPlus } from "react-icons/lu";
import {
  api,
  type ChatMessage,
  type ContextUsage,
  type PlanState,
  type ProviderSettings,
  type QueuedPrompt,
  type SessionMode,
  type TimelineItem,
  type TimelineTool,
} from "../../api";
import { ApprovalDialog } from "../ApprovalDialog";
import { ContextWarningBanner } from "../ContextWarningBanner";
import { Composer, type ComposerImage, type PermissionMode } from "../Composer";
import { MessageList } from "../MessageList";
import {
  clearRunningCompaction,
  markCompactionCompleted,
  markCompactionStarted,
  timelineFromHistory,
} from "../../timeline";
import "./SideChatTab.css";

let sideItemSeq = 0;
function nextSideKey(prefix: string): string {
  sideItemSeq += 1;
  return `side-${prefix}-${sideItemSeq}`;
}

/**
 * 侧边聊天页签：与主聊天完全同款——相同的消息卡片（思考/工具/错误）、计划悬浮胶囊、
 * 压缩横幅、完整 Composer（模型选择、思考档位、权限、上下文占用与压缩）。
 * 会话跑在服务端独立 runtime 上（/side/*），事件按自己的 sessionId 过滤。
 */
export function SideChatTab({
  active,
  cwd,
  providers,
  activeProviderId,
  onManageModels,
  onOpenFile,
}: {
  active: boolean;
  cwd?: string;
  providers: ProviderSettings[];
  /** 主会话当前选择的模型：新建侧边会话时默认跟随 */
  activeProviderId: string;
  /** 打开 设置 → 模型（模型弹层底部「管理模型」） */
  onManageModels: () => void;
  /** read_file 工具行点击 → 右侧「文件」页签打开 */
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useTranslation("panel");
  const [sideId, setSideId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState("");
  const [sideEffort, setSideEffort] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("auto");
  /** 会话模式（plan / goal）与主对话各自独立 */
  const [chatMode, setChatMode] = useState<SessionMode>("default");
  /** 计划文档路径：非空时 Composer 顶部显示确认面板 */
  const [planDocPath, setPlanDocPath] = useState<string | null>(null);
  /** 事件回调里读当前模式（闭包里的 chatMode 会过期） */
  const chatModeRef = useRef<SessionMode>("default");
  useEffect(() => {
    chatModeRef.current = chatMode;
  }, [chatMode]);
  const [recoveredPrompts, setRecoveredPrompts] = useState<QueuedPrompt[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [contextWarningDismissed, setContextWarningDismissed] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<{
    callId: string;
    tool: string;
    input: unknown;
    diff?: string;
    risk?: { level: "medium" | "high"; categories?: string[]; reasons: string[] };
  } | null>(null);
  const ensuringRef = useRef(false);
  const cwdRef = useRef(cwd);
  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);
  /** 主会话当前模型（ref 版本，避免闭包过期） */
  const mainProviderRef = useRef(activeProviderId);
  useEffect(() => {
    mainProviderRef.current = activeProviderId;
  }, [activeProviderId]);

  const sideProvider = providers.find((item) => item.id === providerId);

  const refreshContext = useCallback(async () => {
    try {
      setContextUsage(await api<ContextUsage>("/side/session/context"));
    } catch {
      // 侧边 runtime 未就绪时保留旧值
    }
  }, []);

  const pushError = useCallback((message: string) => {
    setTimeline((items) => [...items, { kind: "error", key: nextSideKey("error"), message }]);
  }, []);

  const enqueueQueuedPrompt = useCallback((item: QueuedPrompt) => {
    queuedPromptsRef.current = [...queuedPromptsRef.current, item];
    setQueuedPrompts(queuedPromptsRef.current);
  }, []);

  const dropQueuedPrompt = useCallback((id: string) => {
    queuedPromptsRef.current = queuedPromptsRef.current.filter((item) => item.id !== id);
    setQueuedPrompts(queuedPromptsRef.current);
  }, []);

  const clearQueuedPrompts = useCallback(() => {
    queuedPromptsRef.current = [];
    setQueuedPrompts([]);
  }, []);

  const completeQueuedPrompt = useCallback((id: string) => {
    const item = queuedPromptsRef.current.find((entry) => entry.id === id);
    queuedPromptsRef.current = queuedPromptsRef.current.filter((entry) => entry.id !== id);
    setQueuedPrompts(queuedPromptsRef.current);
    if (!item) return;
    setTimeline((items) => [
      ...items,
      { kind: "message", key: nextSideKey("user"), role: "user", content: item.text },
    ]);
  }, []);

  const removeQueuedPrompt = useCallback(
    async (id: string) => {
      try {
        await api("/side/session/queue/remove", {
          method: "POST",
          body: JSON.stringify({ id }),
        });
        dropQueuedPrompt(id);
      } catch (error) {
        pushError(error instanceof Error ? error.message : String(error));
      }
    },
    [dropQueuedPrompt, pushError],
  );

  const steerQueuedPrompt = useCallback(
    async (id: string) => {
      try {
        await api("/side/session/steer", { method: "POST", body: JSON.stringify({ id }) });
      } catch (error) {
        pushError(error instanceof Error ? error.message : String(error));
      }
    },
    [pushError],
  );

  useEffect(() => {
    if (!contextUsage?.recommendedCompaction) setContextWarningDismissed(false);
  }, [contextUsage?.recommendedCompaction]);

  // 首次激活时准备好侧边会话：服务端已有则复用（含历史），否则新建
  useEffect(() => {
    if (!active || sideId || ensuringRef.current) return;
    ensuringRef.current = true;
    void (async () => {
      try {
        let id: string;
        let history: ChatMessage[] = [];
        let compaction:
          | { messageIndex: number; summary?: string; status?: "completed" | "interrupted" | "failed" }
          | Array<{
              messageIndex: number;
              summary?: string;
              status?: "completed" | "interrupted" | "failed";
            }>
          | null = null;
        let isCompacting = false;
        let interrupted = false;
        let recovered: QueuedPrompt[] = [];
        try {
          const current = await api<{
            id: string;
            providerId?: string;
            compacting?: boolean;
            lastTurn?: { status: string } | null;
            recoveredPrompts?: QueuedPrompt[];
            mode?: SessionMode;
          }>("/side/session");
          id = current.id;
          if (current.providerId) setProviderId(current.providerId);
          setChatMode(current.mode ?? "default");
          chatModeRef.current = current.mode ?? "default";
          setPlanDocPath(null);
          isCompacting = Boolean(current.compacting);
          interrupted = current.lastTurn?.status === "interrupted";
          recovered = current.recoveredPrompts ?? [];
          const messages = await api<{
            messages: ChatMessage[];
            compaction?: { messageIndex: number; summary: string } | null;
            compactions?: Array<{
              messageIndex: number;
              summary?: string;
              status?: "completed" | "interrupted" | "failed";
            }>;
          }>("/side/session/messages");
          history = messages.messages;
          compaction =
            messages.compactions?.length ? messages.compactions : (messages.compaction ?? null);
        } catch {
          const created = await api<{ id: string; providerId?: string }>("/side/session/new", {
            method: "POST",
            body: JSON.stringify({
              cwd: cwdRef.current,
              providerId: mainProviderRef.current || undefined,
            }),
          });
          id = created.id;
          if (created.providerId) setProviderId(created.providerId);
        }
        setSideId(id);
        setRecoveredPrompts(recovered);
        const loadedTimeline = timelineFromHistory(history, nextSideKey, compaction);
        if (interrupted) {
          loadedTimeline.push({
            kind: "notice",
            key: nextSideKey("notice"),
            message: t("sidechat.interruptedNotice"),
          });
        }
        if (isCompacting) {
          setCompacting(true);
          loadedTimeline.push({
            kind: "compaction",
            key: nextSideKey("compaction"),
            running: true,
          });
        }
        setTimeline(loadedTimeline);
        setFailure(null);
        try {
          const permissions = await api<{ mode: PermissionMode }>("/side/session/permissions");
          setPermissionMode(permissions.mode);
        } catch {
          // 保持默认
        }
        void refreshContext();
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        ensuringRef.current = false;
      }
    })();
  }, [active, sideId, refreshContext, t]);

  // providerId 变化时同步思考档位（侧边改动只在本地，不写入全局设置）
  useEffect(() => {
    const target = providers.find((item) => item.id === providerId);
    if (target) setSideEffort(target.reasoningEffort ?? "");
  }, [providerId, providers]);

  // 订阅本侧边会话的事件（与主聊天同款的时间线处理，只认自己的 sessionId）
  useEffect(() => {
    if (!sideId) return;
    const unsubscribe = window.meow.onEvent((event) => {
      if (!("sessionId" in event) || event.sessionId !== sideId) return;
      if (event.type === "session_mode") {
        const mode = event.mode ?? "default";
        chatModeRef.current = mode;
        setChatMode(mode);
        if (mode !== "plan") setPlanDocPath(null);
        return;
      }
      if (event.type === "plan_documented") {
        if (event.path && chatModeRef.current === "plan") setPlanDocPath(event.path);
        return;
      }
      const compactionKey =
        event.type === "compaction_started" || event.type === "compaction_completed"
          ? nextSideKey("compaction")
          : "";

      setTimeline((items) => {
        const next = [...items];
        switch (event.type) {
          case "thinking_delta": {
            const last = next.at(-1);
            if (last?.kind === "message" && last.role === "assistant" && last.streaming) {
              next[next.length - 1] = { ...last, thinking: (last.thinking ?? "") + (event.delta ?? "") };
            } else {
              next.push({
                kind: "message",
                key: nextSideKey("thinking"),
                role: "assistant",
                content: "",
                thinking: event.delta ?? "",
                streaming: true,
              });
            }
            break;
          }
          case "assistant_delta": {
            const last = next.at(-1);
            if (last?.kind === "message" && last.role === "assistant" && last.streaming) {
              next[next.length - 1] = { ...last, content: last.content + (event.delta ?? "") };
            } else {
              next.push({
                kind: "message",
                key: nextSideKey("assistant"),
                role: "assistant",
                content: event.delta ?? "",
                streaming: true,
              });
            }
            break;
          }
          case "message_complete": {
            const last = next.at(-1);
            if (last?.kind === "message" && last.role === "assistant" && last.streaming) {
              next[next.length - 1] = {
                ...last,
                content: event.text ?? last.content,
                thinking: event.reasoning ?? last.thinking,
                streaming: false,
              };
            } else {
              next.push({
                kind: "message",
                key: nextSideKey("assistant"),
                role: "assistant",
                content: event.text ?? "",
                thinking: event.reasoning,
              });
            }
            break;
          }
          case "tool_started": {
            next.push({
              kind: "tool",
              key: nextSideKey("tool"),
              callId: event.callId ?? "",
              tool: event.tool ?? "",
              input: event.input,
            });
            break;
          }
          case "tool_output": {
            const index = next.findIndex((item) => item.kind === "tool" && item.callId === event.callId);
            if (index >= 0) {
              const item = next[index] as TimelineTool;
              next[index] = { ...item, output: event.output ?? "", truncated: event.truncated };
            }
            break;
          }
          case "tool_finished": {
            const index = next.findIndex((item) => item.kind === "tool" && item.callId === event.callId);
            if (index >= 0) {
              const item = next[index] as TimelineTool;
              next[index] = { ...item, ok: event.ok };
            }
            break;
          }
          case "compaction_started":
            return markCompactionStarted(next, compactionKey);
          case "compaction_completed":
            return markCompactionCompleted(next, compactionKey, event.summary ?? "");
          case "compaction_failed":
            return clearRunningCompaction(next);
          default:
            break;
        }
        return next;
      });

      if (event.type === "message_start") {
        setStreaming(true);
        if (event.queuedId) completeQueuedPrompt(event.queuedId);
      }
      if (event.type === "message_complete") setStreaming(queuedPromptsRef.current.length > 0);
      if (event.type === "turn_complete") {
        setStreaming(queuedPromptsRef.current.length > 0);
        setCompacting(false);
        setTimeline((items) => clearRunningCompaction(items));
        void refreshContext();
      }
      if (event.type === "compaction_started") setCompacting(true);
      if (event.type === "compaction_completed") {
        setCompacting(false);
        void refreshContext();
      }
      if (event.type === "compaction_failed") {
        setCompacting(false);
        void refreshContext();
      }
      if (event.type === "approval_required") {
        setApproval({
          callId: event.callId ?? "",
          tool: event.tool ?? "",
          input: event.input,
          ...(event.diff ? { diff: event.diff } : {}),
          ...(event.risk ? { risk: event.risk } : {}),
        });
      }
      if (event.type === "plan_updated") {
        setPlan({
          steps: event.steps ?? [],
          ...(event.explanation ? { explanation: event.explanation } : {}),
        });
      }
      if (event.type === "error") {
        pushError(event.message ?? "Agent error");
        setCompacting(false);
      }
    });
    return unsubscribe;
  }, [sideId, refreshContext, pushError, completeQueuedPrompt]);

  const waiting = useMemo(() => {
    if (!streaming) return false;
    const last = timeline.at(-1);
    return !(last?.kind === "message" && last.role === "assistant");
  }, [streaming, timeline]);
  const hasSentMessage = useMemo(
    () => timeline.some((item) => item.kind === "message" && item.role === "user"),
    [timeline],
  );

  const send = useCallback(async (
    overrideText?: string,
    recoveredId?: string,
    images?: ComposerImage[],
  ) => {
    const text = (overrideText ?? input).trim();
    if ((!text && !images?.length) || !sideId) return;
    if (compacting) return;
    if (overrideText === undefined) setInput("");
    const queued = streaming;
    let queueId: string | undefined;
    if (queued) {
      queueId = nextSideKey("queued");
      enqueueQueuedPrompt({ id: queueId, text });
    } else {
      const timelineImages = images?.map(({ mimeType, dataUrl, name }) => ({
        mimeType,
        dataUrl,
        ...(name ? { name } : {}),
      }));
      setTimeline((items) => [
        ...items,
        {
          kind: "message",
          key: nextSideKey("user"),
          role: "user",
          content: text,
          ...(timelineImages?.length ? { images: timelineImages } : {}),
        },
      ]);
    }
    try {
      await api("/side/session/prompt", {
        method: "POST",
        body: JSON.stringify({
          message: text,
          ...(queueId ? { queueId } : {}),
          ...(images?.length
            ? { images: images.map(({ mimeType, data }) => ({ mimeType, data })) }
            : {}),
        }),
      });
      setStreaming(true);
      if (recoveredId) {
        setRecoveredPrompts((items) => items.filter((item) => item.id !== recoveredId));
        void api("/side/session/recovered/discard", {
          method: "POST",
          body: JSON.stringify({ id: recoveredId }),
        }).catch(() => undefined);
      }
    } catch (error) {
      if (queueId) dropQueuedPrompt(queueId);
      pushError(error instanceof Error ? error.message : String(error));
      if (!queued) setStreaming(false);
    }
  }, [input, streaming, compacting, sideId, enqueueQueuedPrompt, dropQueuedPrompt, pushError]);

  const stop = useCallback(() => {
    clearQueuedPrompts();
    void api("/side/session/abort", { method: "POST" }).catch((error) =>
      pushError(error instanceof Error ? error.message : String(error)),
    );
  }, [clearQueuedPrompts, pushError]);

  const manualCompact = useCallback(async () => {
    try {
      await api("/side/session/compact", { method: "POST" });
    } catch (error) {
      pushError(error instanceof Error ? error.message : String(error));
    }
  }, [pushError]);

  const changePermissionMode = useCallback(
    async (mode: PermissionMode) => {
      setPermissionMode(mode);
      try {
        await api("/side/session/permissions", { method: "PUT", body: JSON.stringify({ mode }) });
      } catch (error) {
        pushError(error instanceof Error ? error.message : String(error));
      }
    },
    [pushError],
  );

  /** 切换侧边会话模式：乐观更新徽章，失败只提示不回落。 */
  const changeChatMode = useCallback(
    async (mode: SessionMode) => {
      chatModeRef.current = mode;
      setChatMode(mode);
      if (mode !== "plan") setPlanDocPath(null);
      try {
        await api("/side/session/mode", { method: "PUT", body: JSON.stringify({ mode }) });
      } catch (error) {
        pushError(error instanceof Error ? error.message : String(error));
      }
    },
    [pushError],
  );

  /** 计划确认：先退出计划模式（后端顺序等待），再发实施指令。 */
  const confirmPlan = useCallback(async () => {
    const docPath = planDocPath;
    await changeChatMode("default");
    await send(
      docPath
        ? t("sidechat.planConfirmedWithPath", { path: docPath })
        : t("sidechat.planConfirmed"),
    );
  }, [changeChatMode, planDocPath, send, t]);

  const changeActiveProvider = useCallback(
    async (nextId: string) => {
      if (!providers.some((item) => item.id === nextId)) return;
      setProviderId(nextId);
      try {
        await api("/side/session/model", { method: "PUT", body: JSON.stringify({ provider: nextId }) });
      } catch (error) {
        pushError(error instanceof Error ? error.message : String(error));
      }
    },
    [providers, pushError],
  );

  const changeEffort = useCallback(
    async (value: string) => {
      const target = providers.find((item) => item.id === providerId);
      if (!target) return;
      setSideEffort(value);
      try {
        await api("/side/session/model", {
          method: "PUT",
          body: JSON.stringify({
            provider: target.id,
            modelId: target.model,
            reasoningEffort: value || null,
          }),
        });
      } catch (error) {
        pushError(error instanceof Error ? error.message : String(error));
      }
    },
    [providers, providerId, pushError],
  );

  const newSession = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await api<{ id: string; providerId?: string }>("/side/session/new", {
        method: "POST",
        body: JSON.stringify({
          cwd: cwdRef.current,
          providerId: mainProviderRef.current || undefined,
        }),
      });
      setSideId(created.id);
      if (created.providerId) setProviderId(created.providerId);
      setTimeline([]);
      setPlan(null);
      setRecoveredPrompts([]);
      setCompacting(false);
      setContextUsage(null);
      setContextWarningDismissed(false);
      setStreaming(false);
      clearQueuedPrompts();
      setPermissionMode("auto");
      setChatMode("default");
      chatModeRef.current = "default";
      setPlanDocPath(null);
      setApproval(null);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const respondApproval = async (approved: boolean) => {
    if (!approval) return;
    const current = approval;
    setApproval(null);
    try {
      await api("/side/approval/response", {
        method: "POST",
        body: JSON.stringify({ callId: current.callId, approved }),
      });
    } catch {
      // 回传失败时服务端按拒绝处理
    }
  };

  return (
    <div className="mc-sidechat">
      <div className="mc-sidechat__head">
        <span className="mc-sidechat__state mc-truncate">
          {failure ??
            (streaming
              ? t("sidechat.generating")
              : sideId
                ? t("sidechat.standalone")
                : t("sidechat.initializing"))}
        </span>
        <button type="button" className="mc-sidechat__newbtn" disabled={busy} onClick={() => void newSession()}>
          <LuPlus size={13} />
          {t("sidechat.newSession")}
        </button>
      </div>

      <ContextWarningBanner
        usage={contextUsage}
        streaming={streaming}
        compacting={compacting}
        dismissed={contextWarningDismissed}
        onCompact={manualCompact}
        onDismiss={() => setContextWarningDismissed(true)}
      />
      <MessageList items={timeline} canUse={Boolean(sideId)} waiting={waiting} onOpenFile={onOpenFile} />
      <Composer
        value={input}
        onChange={setInput}
        polishTarget="side"
        onSend={(images, overrideText) => void send(overrideText, undefined, images)}
        onError={pushError}
        onStop={stop}
        disabled={!sideId}
        streaming={streaming}
        queuedPrompts={queuedPrompts}
        onSteerQueued={(id) => void steerQueuedPrompt(id)}
        onRemoveQueued={(id) => void removeQueuedPrompt(id)}
        recoveredPrompts={recoveredPrompts}
        onSendRecovered={(item) => void send(item.text, item.id)}
        onDiscardRecovered={(id) => {
          setRecoveredPrompts((items) => items.filter((item) => item.id !== id));
          void api("/side/session/recovered/discard", {
            method: "POST",
            body: JSON.stringify({ id }),
          }).catch((error) =>
            pushError(error instanceof Error ? error.message : String(error)),
          );
        }}
        canUse={Boolean(sideId)}
        workspace={cwd}
        providers={providers}
        activeProviderId={providerId}
        onChangeActiveProvider={(id) => void changeActiveProvider(id)}
        onManageModels={onManageModels}
        model={sideProvider?.displayName || sideProvider?.model || t("sidechat.noModel")}
        effort={sideEffort}
        onChangeEffort={(value) => void changeEffort(value)}
        permissionMode={permissionMode}
        onChangePermissionMode={(mode) => void changePermissionMode(mode)}
        chatMode={chatMode}
        onChangeChatMode={(mode) => void changeChatMode(mode)}
        planDocPath={planDocPath}
        onConfirmPlan={() => void confirmPlan()}
        onDismissPlan={() => setPlanDocPath(null)}
        contextUsage={contextUsage}
        showContext={hasSentMessage}
        compacting={compacting}
        onManualCompact={manualCompact}
        projects={[]}
        projectNames={{}}
        onSwitchProject={() => undefined}
        onNewProject={() => undefined}
        plan={plan}
      />

      <ApprovalDialog
        open={Boolean(approval)}
        tool={approval?.tool}
        input={approval?.input}
        diff={approval?.diff}
        risk={approval?.risk}
        onApprove={() => void respondApproval(true)}
        onDeny={() => void respondApproval(false)}
      />
    </div>
  );
}
