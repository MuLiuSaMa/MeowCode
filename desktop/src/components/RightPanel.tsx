import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  LuArrowLeft,
  LuArrowRight,
  LuClipboardList,
  LuFolderTree,
  LuGlobe,
  LuLayoutGrid,
  LuListChecks,
  LuMessageSquare,
  LuPlus,
  LuPuzzle,
  LuRotateCw,
  LuSparkles,
  LuTerminal,
  LuUsers,
  LuX,
} from "react-icons/lu";
import type {
  ProviderSettings,
  SubagentRun,
  TurnMetrics,
  WorkflowRoadmap,
} from "../api";
import { normalizeAddress } from "../panel/address";
import type { SideTab, SideTabOpen } from "../panel/useSideTabs";
import { BrowserTab } from "./panel/BrowserTab";
import { HomeTab } from "./panel/HomeTab";
import { PlanTab } from "./panel/PlanTab";
import { PluginFrameTab } from "./panel/PluginFrameTab";
import { ReviewTab } from "./panel/ReviewTab";
import { SideChatTab } from "./panel/SideChatTab";
import { SubagentTab } from "./panel/SubagentTab";
import { SubagentsTab } from "./panel/SubagentsTab";
import { TerminalTab } from "./panel/TerminalTab";
import { WorkspaceTab } from "./panel/WorkspaceTab";
import "./RightPanel.css";

/** 页签图标 */
function tabIcon(tab: SideTab): ReactNode {
  switch (tab.kind) {
    case "home":
      return <LuLayoutGrid size={12} />;
    case "browser":
      return <LuGlobe size={12} />;
    case "workspace":
      return <LuFolderTree size={12} />;
    case "review":
      return <LuListChecks size={12} />;
    case "plan":
      return <LuClipboardList size={12} />;
    case "sidechat":
      return <LuMessageSquare size={12} />;
    case "terminal":
      return <LuTerminal size={12} />;
    case "subagent":
      return <LuSparkles size={12} />;
    case "subagents":
      return <LuUsers size={12} />;
    case "plugin":
      return <LuPuzzle size={12} />;
  }
}

export function RightPanel({
  tabs,
  activeId,
  onActivate,
  onClose,
  onOpen,
  onOpenPalette,
  onOpenSearch,
  onOpenWorkspace,
  onOpenFile,
  onPatchTab,
  subagentRuns,
  onEnsureSubagent,
  onOpenSubagent,
  onStopSubagent,
  onContinueSubagent,
  onSteerSubagent,
  workspace,
  session,
  metrics,
  provider,
  providers,
  onManageModels,
  toolCount,
  planPath,
  planWriting,
  planDocVersion,
  roadmap,
}: {
  tabs: SideTab[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: (request: SideTabOpen) => void;
  /** 打开文件快开面板（Ctrl+P） */
  onOpenPalette: () => void;
  /** 打开会话全文检索弹窗（Ctrl+K） */
  onOpenSearch: () => void;
  onOpenWorkspace: (cwd: string) => void;
  /** 在「文件」页签里选中文件（树点击 / 快开选中） */
  onOpenFile: (path: string) => void;
  /** 浏览器页签回写标题 / 地址 */
  onPatchTab: (id: string, patch: { title?: string; url?: string }) => void;
  /** 子 Agent 页签的实时状态（按 agentId） */
  subagentRuns: Record<string, SubagentRun>;
  onEnsureSubagent: (agentId: string) => void;
  onOpenSubagent: (agentId: string) => void;
  onStopSubagent: (agentId: string) => void;
  onContinueSubagent: (agentId: string, message: string) => Promise<void>;
  onSteerSubagent: (agentId: string, message: string) => Promise<void>;
  workspace?: string;
  session: { id: string; cwd: string } | null;
  /** 最近一次 AI 回合的响应统计（会话信息） */
  metrics: TurnMetrics | null;
  provider?: ProviderSettings;
  /** 全部服务商（侧边聊天的模型选择用） */
  providers: ProviderSettings[];
  /** 打开 设置 → 模型（侧边聊天模型弹层的「管理模型」） */
  onManageModels: () => void;
  toolCount: number;
  /** 计划文档（工作区相对路径）与写入状态：计划页签据此预览 plans/ 下的 Markdown */
  planPath?: string | null;
  planWriting?: boolean;
  planDocVersion?: number;
  /** 治理 roadmap 快照（当前会话）；计划页签顶部展示 lanes 与 gate 状态 */
  roadmap?: WorkflowRoadmap | null;
}) {
  const { t } = useTranslation("chat");
  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  /** 顶部搜索栏只属于「新标签页」；其他页签各有自己的上下文 */
  const isHome = activeTab?.kind === "home";
  const [address, setAddress] = useState("");

  /** 新标签页的搜索栏提交：新开浏览器页签（地址栏随后由浏览器页签自带） */
  const submitAddress = () => {
    const value = address.trim();
    if (!value) return;
    setAddress("");
    onOpen({ kind: "browser", url: normalizeAddress(value) });
  };

  const handleBrowserMeta = useCallback(
    (id: string, meta: { title?: string; url?: string }) => {
      onPatchTab(id, meta);
    },
    [onPatchTab],
  );

  return (
    <aside className="mc-panel mc-panel--inspector mc-rtp">
      {/* 页签栏 */}
      <div className="mc-rtp__tabs" role="tablist" aria-label={t("rightPanel.tabsAria")}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="mc-rtp__tab"
            data-active={tab.id === activeId}
            data-tab={tab.kind}
            role="tab"
            aria-selected={tab.id === activeId}
          >
            <button type="button" className="mc-rtp__tabmain" title={tab.title} onClick={() => onActivate(tab.id)}>
              <span className="mc-rtp__tabicon">{tabIcon(tab)}</span>
              <span className="mc-rtp__tabtitle mc-truncate">{tab.title}</span>
            </button>
            {tab.kind !== "home" ? (
              <button
                type="button"
                className="mc-rtp__tabclose"
                aria-label={t("rightPanel.closeTab")}
                onClick={() => onClose(tab.id)}
              >
                <LuX size={12} />
              </button>
            ) : null}
          </div>
        ))}
        <button type="button" className="mc-rtp__tabadd" aria-label={t("rightPanel.newTab")} onClick={() => onActivate("home")}>
          <LuPlus size={14} />
        </button>
      </div>

      {/* 工具栏：只有新标签页有 */}
      {isHome ? (
        <div className="mc-rtp__toolbar">
          <button type="button" className="mc-rtp__navbtn" aria-label={t("rightPanel.back")} disabled>
            <LuArrowLeft size={14} />
          </button>
          <button type="button" className="mc-rtp__navbtn" aria-label={t("rightPanel.forward")} disabled>
            <LuArrowRight size={14} />
          </button>
          <button type="button" className="mc-rtp__navbtn" aria-label={t("rightPanel.reload")} disabled>
            <LuRotateCw size={13} />
          </button>
          <input
            className="mc-rtp__address"
            value={address}
            placeholder={t("rightPanel.addressPlaceholder")}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitAddress();
            }}
          />
        </div>
      ) : null}

      {/* 内容：页签常挂载，非激活隐藏（webview / 终端保活） */}
      <div className="mc-rtp__body" data-home={isHome}>
        {tabs.map((tab) => (
          <div key={tab.id} className="mc-rtp__tabbody" data-kind={tab.kind} data-hidden={tab.id !== activeId}>
            {tab.kind === "home" ? (
              <HomeTab
                onOpen={onOpen}
                onOpenPalette={onOpenPalette}
                onOpenSearch={onOpenSearch}
                onOpenWorkspace={onOpenWorkspace}
                workspace={workspace}
                session={session}
                metrics={metrics}
                provider={provider}
                toolCount={toolCount}
              />
            ) : tab.kind === "review" ? (
              <ReviewTab sessionId={session?.id} />
            ) : tab.kind === "plan" ? (
              <PlanTab
                path={planPath}
                writing={planWriting}
                version={planDocVersion}
                workspace={workspace}
                roadmap={roadmap}
              />
            ) : tab.kind === "workspace" ? (
              <WorkspaceTab file={tab.path} workspace={workspace} onSelect={onOpenFile} />
            ) : tab.kind === "browser" ? (
              <BrowserTab tabId={tab.id} url={tab.url} agent={tab.agent} onMeta={handleBrowserMeta} />
            ) : tab.kind === "terminal" ? (
              <TerminalTab active={tab.id === activeId} cwd={workspace} />
            ) : tab.kind === "subagents" ? (
              <SubagentsTab
                runs={Object.values(subagentRuns).filter(
                  (run) => run.parentSessionId === session?.id,
                )}
                onOpen={onOpenSubagent}
                onStop={onStopSubagent}
              />
            ) : tab.kind === "subagent" ? (
              <SubagentTab
                agentId={tab.agentId}
                run={subagentRuns[tab.agentId]}
                onEnsure={onEnsureSubagent}
                onStop={onStopSubagent}
                onContinue={onContinueSubagent}
                onSteer={onSteerSubagent}
                onOpenFile={onOpenFile}
              />
            ) : tab.kind === "plugin" ? (
              <PluginFrameTab
                pluginId={tab.pluginId}
                active={tab.id === activeId}
                sessionId={session?.id}
              />
            ) : (
              <SideChatTab
                active={tab.id === activeId}
                cwd={workspace}
                providers={providers}
                activeProviderId={provider?.id ?? ""}
                onManageModels={onManageModels}
                onOpenFile={onOpenFile}
              />
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
