/**
 * 市场搬运脚本：把 Trae 本地技能 / 参考仓库技能 汇总进 resources/marketplace/。
 *
 * 用法：pnpm tsx scripts/build-marketplace.ts
 * - 幂等可重跑：每次重建 skills/ mcp/ index.json；plugins/ 是手工维护源，不触碰
 * - 同名去重优先级：Trae(skills) > Trae(builtin) > Trae(plugins 内嵌) > ZCode(仓库/官方市场) > dsh > codex
 * - ZCode 子进程 hooks 一律丢弃（与 MeowCode 进程内 hook 形态不兼容）
 * - Trae ${connector.x.ACCESS_TOKEN} 凭据占位 → ${MEOWCODE_X_TOKEN}（expandEnvTemplates 只认纯环境变量名）
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as simpleIcons from "simple-icons";
import { promisify } from "node:util";

/** execFile 裸调用返回 ChildProcess 而非 Promise，必须 promisify 才能真正等待 */
const execFileAsync = promisify(execFile);

type Category = "开发工具" | "界面设计" | "内容创作" | "效率提升" | "数据分析";
type Source = "trae" | "zcode" | "dsh" | "codex" | "metis" | "builtin";

type MarketItem = {
  id: string;
  type: "skill" | "plugin" | "mcp";
  name: string;
  description: string;
  category: Category;
  source: Source;
  tags: string[];
  version: string;
  entry: string;
  entryKind: "dir" | "file";
  /** 相对 bundles 的图标路径（icons/<id>.svg 等），无图标则缺省（前端首字母色块兜底） */
  icon?: string;
  /** plugin 专用：详情页展示的使用说明（markdown） */
  usage?: string;
  requiresEnv?: string[];
};

const TRAE = "C:/Users/MuLiu/.trae-cn";
const ZCODE = "D:/MeowCode/ZCode-main/apps/zcode-cli/packages";
const DSH = "D:/MeowCode/deepseek-harness-master/packages/skill/skill-office/assets";
const CODEX = "D:/MeowCode/codex-main/codex-rs/skills/src/assets/samples";
const REPO = "D:/MeowCode";
const OUT = path.join(REPO, "resources", "marketplace");

// ---------------------------------------------------------------- 中文标题

/** 展示名（卡片/详情标题）：中文优先，未映射的回退 frontmatter name / id */
const CN_TITLES: Record<string, string> = {
  // —— Trae 市场技能 ——
  "alipay-payment-integration": "支付宝 AI 付接入技能",
  "byted-bp-cdn-pagesdeploy": "BytePlus Edge Pages 部署",
  "douyin-interact-creation": "抖音互动内容创作",
  "douyin-interactive-content-publish": "抖音互动内容发布",
  "douyinpay-payment-integration": "抖音支付接入",
  "iga-pages": "IGA 一键部署",
  "gh-cli": "GitHub 命令行工具",
  "git-commit": "Git 提交",
  "github": "GitHub",
  "github": "GitHub",
  "gh-address-comments": "GitHub 评论处理",
  "gh-fix-ci": "GitHub CI 修复",
  "yeet": "Yeet 快速发布",
  "react-best-practices": "React 最佳实践",
  "react-native-skills": "React Native 开发",
  "composition-patterns": "React 组件组合模式",
  "security-best-practices": "安全最佳实践",
  "mcp-builder": "MCP 服务构建",
  "webapp-testing": "Web 应用探索测试",
  "internal-comms": "内部沟通材料",
  "doc-coauthoring": "文档协作撰写",
  "brainstorming": "头脑风暴",
  "writing-plans": "编写计划",
  "brand-guidelines": "品牌视觉规范",
  "canvas-design": "画布视觉设计",
  "chart-visualization": "图表可视化",
  "frontend-design": "Anthropic 前端界面设计",
  "frontend-skill": "前端界面开发",
  "shadcn": "shadcn/ui 组件",
  "web-design-guidelines": "Web 设计规范",
  "theme-factory": "Anthropic 主题样式生成",
  "algorithmic-art": "p5.js 算法艺术创作",
  "electron": "Electron 开发",
  "figma": "Figma 设计",
  "redis-development": "Redis 应用开发",
  "report-page": "报告页面",
  "web-artifacts-builder": "Web Artifacts 构建",
  "agent-browser": "Agent Browser",
  "hyperframes": "Hyperframes 框架",
  "hyperframes-cli": "Hyperframes CLI",
  "hyperframes-media": "Hyperframes 媒体",
  "hyperframes-registry": "Hyperframes 注册表",
  "dogfood": "Dogfood 测试",
  "gc-minimal-zine-poster-v0-1": "极简 Zine 海报设计",
  // —— Trae 内置技能 ——
  "trae-code-review": "代码审查",
  "trae-debugger": "调试器",
  "trae-generate-mini-app": "小程序生成",
  "trae-security-review": "安全审查",
  // —— Trae 官方插件内嵌 ——
  "research-guide": "深度研究指南",
  "html-deck": "HTML 演示文稿",
  "html-report": "HTML 报告",
  "prd-authoring": "PRD 需求文档",
  "uicraft": "UICraft 界面搭建",
  "lark-approval": "飞书审批",
  "lark-attendance": "飞书考勤",
  "lark-base": "飞书多维表格",
  "lark-calendar": "飞书日历",
  "lark-contact": "飞书通讯录",
  "lark-doc": "飞书文档",
  "lark-drive": "飞书云盘",
  "lark-event": "飞书事件订阅",
  "lark-im": "飞书消息",
  "lark-mail": "飞书邮箱",
  "lark-markdown": "飞书 Markdown",
  "lark-meeting": "飞书会议",
  "lark-minutes": "飞书妙记",
  "lark-note": "飞书便签",
  "lark-okr": "飞书 OKR",
  "lark-openapi-explorer": "飞书 OpenAPI 探索",
  "lark-shared": "飞书共享能力",
  "lark-sheets": "飞书表格",
  "lark-skill-maker": "飞书技能制作",
  "lark-slides": "飞书幻灯片",
  "lark-task": "飞书任务",
  "lark-vc": "飞书视频会议",
  "lark-vc-agent": "飞书会议助手",
  "lark-whiteboard": "飞书白板",
  "lark-wiki": "飞书知识库",
  "lark-workflow-meeting-summary": "飞书会议纪要工作流",
  "lark-workflow-standup-report": "飞书站会报告工作流",
  "docx": "Word 文档",
  "pdf": "PDF 处理",
  "pptx": "PPT 演示",
  "xlsx": "Excel 表格",
  // —— ZCode 官方插件 ——
  "control-browser": "浏览器控制",
  "web-gui-tester": "Web GUI 测试",
  "dynamic-workflows": "动态工作流",
  "plugin-creator": "插件创建器",
  "skill-creator": "技能创建器",
  "visualize": "图表与可视化",
  "executing-plans": "执行计划",
  "dispatching-parallel-agents": "并行子代理调度",
  "finishing-a-development-branch": "完成开发分支",
  "receiving-code-review": "接受代码审查",
  "requesting-code-review": "请求代码审查",
  "subagent-driven-development": "子代理驱动开发",
  "systematic-debugging": "系统化调试",
  "test-driven-development": "测试驱动开发",
  "using-git-worktrees": "使用 Git Worktree",
  "using-superpowers": "Superpowers 上手",
  "verification-before-completion": "完成前验证",
  "writing-skills": "编写技能",
  "diagnosing-commands": "诊断：命令",
  "diagnosing-hooks": "诊断：Hooks",
  "diagnosing-mcp": "诊断：MCP",
  "diagnosing-plugins": "诊断：插件",
  "diagnosing-skills": "诊断：技能",
  "zcode-configuration-guide": "ZCode 配置指南",
  // —— deepseek-harness office 系列 ——
  "office": "Office 任务路由",
  "office-export-pdf": "导出 PDF",
  "office-recalculate": "表格重算",
  "office-render": "Office 文档渲染",
  // —— codex 样例 ——
  "imagegen": "图像生成",
  "openai-docs": "OpenAI 文档",
  "review-agent": "代码审查代理",
  "skill-installer": "技能安装器",
  // —— 内置插件 ——
  "permission-gate": "危险命令门禁",
  "protected-paths": "敏感文件保护",
  "todo": "Todo 清单",
  "summarize": "会话总结",
  "auto-commit": "自动提交",
  "git-checkpoint": "Git 检查点",
  // —— ZCode 官方插件市场技能 ——
  "3-statement-model": "三表联动模型",
  "account-mapping": "科目映射表",
  "accretion-dilution": "增厚摊薄测算",
  "anet": "AgentNetwork 协作",
  "anet-setup": "anet 环境配置",
  "asset-allocation": "大类资产配置",
  "audit-xls": "表格审计",
  "autoresearch": "自主研究循环",
  "autoresearch-hooks": "研究迭代钩子",
  "bond-profile": "单券深度画像",
  "budget-variance": "预算差异归因",
  "capital-raise": "定增募资测算",
  "cash-forecast": "13 周现金流预测",
  "cli": "阿里云 CLI 操作",
  "client-portrait": "客户画像速写",
  "close-recap": "收盘复盘",
  "cloudbase": "腾讯云开发",
  "codespace": "Codespaces 管理",
  "commit": "Git 提交",
  "competitive-analysis": "竞争格局分析",
  "comps-analysis": "可比公司分析",
  "cost-profitability": "分部盈利拆解",
  "create-toolset": "UE 工具集开发",
  "credit-watch": "信用跟踪监测",
  "curve-spread": "期限利差图谱",
  "dcf-model": "DCF 估值建模",
  "dd-report": "尽调报告撰写",
  "deal-comps": "可比交易整理",
  "defuddle": "网页正文提取",
  "developing-mcp-apps": "MCP 应用开发",
  "docx-viewer": "Word 文档查看",
  "earnings-analysis": "业绩点评报告",
  "earnings-flash": "业绩快报速评",
  "earnings-preview": "财报前瞻分析",
  "env-setup": "视频环境配置",
  "event-monitor": "事件监控扫描",
  "excalidraw": "Excalidraw 画图",
  "excalidraw-diagram": "Obsidian 画图",
  "finance-bp-decision-support": "业务提案测算",
  "financial-reporting": "法定报表编制",
  "fund-profile": "基金深度画像",
  "fund-screen": "基金多维筛选",
  "fund-watch": "持仓基金跟踪",
  "gist": "Gist 管理",
  "glab": "GitLab 命令行",
  "glab-stack": "GitLab 堆叠 MR",
  "holdings-style": "持仓风格透视",
  "hyper3d-rodin": "Hyper3D 建模",
  "idea-generation": "投资灵感筛选",
  "index-valuation": "指数估值分位",
  "intraday-watch": "盘中快照",
  "issue": "Issue 管理",
  "issuer-credit": "发行人信用评估",
  "jev-judgment": "JEV 判断规范",
  "json-canvas": "JSON Canvas 画布",
  "jupyter-notebook": "Jupyter 笔记本",
  "kicad-board": "KiCad 画板",
  "knap": "Knap 模板渲染",
  "lbo-model": "LBO 建模",
  "ledger-reconciliation": "账账核对",
  "libtv-cli": "Libtv 命令行",
  "macro-dashboard": "宏观五板块速览",
  "management-report": "管理口径报表",
  "manager-profile": "基金经理画像",
  "mermaid-visualizer": "Mermaid 图表",
  "model-update": "模型数据更新",
  "month-end-close-review": "月结前检视",
  "morning-note": "晨报速写",
  "obsidian-bases": "Obsidian Bases",
  "obsidian-cli": "Obsidian CLI",
  "obsidian-markdown": "Obsidian 笔记",
  "opportunity-scan": "商机信号扫描",
  "park-cluster-map": "园区企业图谱",
  "pdf-viewer": "PDF 查看",
  "peer-benchmark": "同业对标",
  "photo-card": "照片变 3D 卡片",
  "policy-tracker": "政策产业跟踪",
  "pptx-author": "PPT 生成",
  "pptx-viewer": "PPT 查看",
  "pr": "PR 处理",
  "prospect-screen": "客户名单筛查",
  "related-party-map": "关联方图谱",
  "release": "Release 发布",
  "repo": "仓库克隆与管理",
  "report-render": "报告分页渲染",
  "research-report": "个股深度报告",
  "risk-scan": "风险记录扫描",
  "rolling-forecast": "滚动预测",
  "ruic-card": "3D 收藏卡片",
  "scenario-analysis": "情景压力测试",
  "secret": "Actions 密钥管理",
  "sector-overview": "行业全景报告",
  "setup": "环境配置",
  "site-deploy": "网站部署",
  "sources-uses": "资金来源与用途",
  "statement-consistency-check": "报表勾稽检查",
  "tripo-3d": "Tripo 3D 生成",
  "tripo-game-asset": "Tripo 游戏资产",
  "typst": "Typst 排版",
  "unity-cli": "Unity 编辑器控制",
  "unity-setup": "Unity 环境安装",
  "unreal-mcp": "Unreal 远程操控",
  "unreal-skill": "Unreal 开发指南",
  "url2video": "录屏复刻网页",
  "video-edit-agent": "视频剪辑总控",
  "video-edit-assembly": "多素材混剪",
  "video-recap-workflows": "影视解说工作流",
  "video-speech-workflows": "口播视频工作流",
  "video2code": "录屏转代码",
  "video2code-3d": "录屏转 3D 场景",
  "video2fullstack": "操作录屏全栈复刻",
  "watchlist": "自选列表管理",
  "web-replicate": "现代网页复刻",
  "workflow-run": "Actions 工作流",
  "xlsx-author": "表格生成",
  "xlsx-viewer": "表格查看",
  "zotero": "Zotero 文献库",
};

// ---------------------------------------------------------------- 图标合成（类 3D 质感）

type SiIcon = { path: string; hex: string; title: string; /** 源图非 24×24（官方 logo 直采）时给定，渲染时等比缩放进 24×24 网格 */ viewBox?: [number, number] };

/** 官方 PNG 插件图标（key = 插件名，data URL）：ZCode 官方市场采集时填充，命中则圆角内嵌渲染 */
const IMAGE_BRANDS: Record<string, string> = {};

/** id → simple-icons 键（缺失的走分类色渐变 + 首字母兜底，同样有质感底） */
const BRAND_MAP: Record<string, string> = {
  "alipay-payment-integration": "siAlipay",
  "douyin-interact-creation": "siTiktok",
  "douyin-interactive-content-publish": "siTiktok",
  "douyinpay-payment-integration": "siTiktok",
  "byted-bp-cdn-pagesdeploy": "siBytedance",
  "iga-pages": "siNetlify",
  "gh-cli": "siGithub",
  "git-commit": "siGithub",
  "github": "siGithub",
  "gitcode": "siGitcode",
  "gh-address-comments": "siGithub",
  "gh-fix-ci": "siGithub",
  "yeet": "siGithub",
  "react-best-practices": "siReact",
  "react-native-skills": "siReact",
  "composition-patterns": "siReact",
  "web-artifacts-builder": "siVite",
  "shadcn": "siShadcnui",
  "web-design-guidelines": "siVercel",
  "frontend-design": "siAnthropic",
  "figma": "siFigma",
  "frontend-skill": "siOpenai",
  "electron": "siElectron",
  "redis-development": "siRedis",
  "mcp-builder": "siAnthropic",
  "security-best-practices": "siAnthropic",
  "skill-creator": "siAnthropic",
  "plugin-creator": "siAnthropic",
  "internal-comms": "siAnthropic",
  "doc-coauthoring": "siAnthropic",
  "brand-guidelines": "siAnthropic",
  "canvas-design": "siAnthropic",
  "algorithmic-art": "siAnthropic",
  "theme-factory": "siAnthropic",
  "research-guide": "siAnthropic",
  "webapp-testing": "siGooglechrome",
  "agent-browser": "siGooglechrome",
  "control-browser": "siGooglechrome",
  "web-gui-tester": "siGooglechrome",
  "prd-authoring": "siNotion",
  "html-deck": "siHtml5",
  "html-report": "siHtml5",
  "report-page": "siHtml5",
  "hyperframes": "siHtml5",
  "hyperframes-cli": "siHtml5",
  "hyperframes-media": "siHtml5",
  "hyperframes-registry": "siHtml5",
  "trae-generate-mini-app": "siBytedance",
  "trae-code-review": "siBytedance",
  "trae-debugger": "siBytedance",
  "trae-security-review": "siBytedance",
  "dogfood": "siStorybook",
  "dynamic-workflows": "siZap",
  "visualize": "siGrafana",
  "chart-visualization": "siGrafana",
  "uicraft": "siVercel",
  "gc-minimal-zine-poster-v0-1": "siFigma",
  "imagegen": "siFigma",
  "executing-plans": "siGithub",
  "dispatching-parallel-agents": "siGithub",
  "finishing-a-development-branch": "siGithub",
  "receiving-code-review": "siGithub",
  "requesting-code-review": "siGithub",
  "subagent-driven-development": "siGithub",
  "systematic-debugging": "siGithub",
  "test-driven-development": "siGithub",
  "using-git-worktrees": "siGithub",
  "using-superpowers": "siGithub",
  "verification-before-completion": "siGithub",
  "writing-plans": "siGithub",
  "writing-skills": "siGithub",
  "diagnosing-commands": "siGithub",
  "diagnosing-hooks": "siGithub",
  "diagnosing-mcp": "siGithub",
  "diagnosing-plugins": "siGithub",
  "diagnosing-skills": "siGithub",
  "zcode-configuration-guide": "siGithub",
  "skill-installer": "siGithub",
  "review-agent": "siGithub",
  "todo": "siTodoist",
  "auto-commit": "siGit",
  "git-checkpoint": "siGit",
  "gitee": "siGitee",
  "js-reverse": "siJavascript",
  "firecrawl": "siFirecrawl",
  "figma-context": "siFigma",
  // —— office / 文档族（MS/Adobe 品牌已被下架，用语义替代） ——
  "docx": "siGoogledocs",
  "xlsx": "siGooglesheets",
  "pptx": "siGoogleslides",
  "pdf": "siLibreoffice",
  "office": "siLibreoffice",
  "office-render": "siLibreoffice",
  "office-recalculate": "siGooglesheets",
  "office-export-pdf": "siOnlyoffice",
  "openai-docs": "siMarkdown",
  "brainstorming": "siGithub",
  // —— 内置插件语义品牌 ——
  "summarize": "siLogseq",
  "permission-gate": "siAuth0",
  "protected-paths": "siCryptpad",
  "anthropic-frontend-design": "siAnthropic",
};

/** simple-icons 未收录的品牌（OpenAI 因商标下架）：补 glyph 路径供 buildIconSvg 使用 */
const CUSTOM_BRANDS: Record<string, SiIcon> = {
  siOpenai: {
    title: "OpenAI",
    hex: "#ffffff",
    path: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  },
  // Firecrawl 官方火焰 logo（firecrawl/firecrawl 仓库 apps/test-site/src/assets/firecrawl-logo.svg）
  siFirecrawl: {
    title: "Firecrawl",
    hex: "#FA5D19",
    viewBox: [50, 72],
    path: "M41.7154 23.1929C38.9531 24.0129 36.8707 25.8677 35.3457 27.8826C35.0183 28.3151 34.3358 27.9901 34.4658 27.4601C37.3856 15.4534 33.5283 5.47401 21.5039 0.561817C20.894 0.311833 20.259 0.859299 20.419 1.49926C25.8887 23.4604 2.88236 21.608 5.78971 46.504C5.83971 46.9314 5.35973 47.2239 5.00975 46.9739C3.9198 46.1915 2.70237 44.5591 1.86741 43.4116C1.62242 43.0742 1.09245 43.1692 0.979951 43.5716C0.314984 45.9765 0 48.2413 0 50.4912C0 59.2407 4.49727 66.9427 11.3044 71.4074C11.6944 71.6624 12.1944 71.2974 12.0619 70.8499C11.7119 69.675 11.5144 68.4351 11.4994 67.1527C11.4994 66.3652 11.5494 65.5603 11.6719 64.8103C11.9569 62.9254 12.6119 61.1305 13.7118 59.4957C17.4841 53.8335 25.0462 48.3638 23.8388 40.9368C23.7613 40.4668 24.3163 40.1569 24.6663 40.4793C29.9935 45.3465 31.0485 51.8936 30.1735 57.7658C30.0985 58.2757 30.7385 58.5482 31.061 58.1482C31.8759 57.1283 32.8709 56.2334 33.9533 55.5609C34.2233 55.3934 34.5833 55.5209 34.6858 55.8209C35.2882 57.5733 36.1832 59.2182 37.0281 60.8631C38.0381 62.8404 38.5756 65.0978 38.4906 67.4877C38.4481 68.6501 38.2556 69.775 37.9331 70.8449C37.7956 71.2974 38.2906 71.6749 38.6881 71.4149C45.5002 66.9502 50 59.2482 50 50.4937C50 47.4514 49.4675 44.4691 48.4601 41.6743C46.3477 35.8121 40.988 31.4099 42.3429 23.7704C42.4079 23.4054 42.0704 23.0879 41.7154 23.1929Z",
  },
};

/** 分类兜底色（无品牌 glyph 时的线条颜色） */
const CATEGORY_COLORS: Record<Category, string> = {
  "开发工具": "#3b82f6",
  "界面设计": "#8b5cf6",
  "内容创作": "#f59e0b",
  "数据分析": "#10b981",
  "效率提升": "#ec4899",
};

/** lucide 图标内嵌标记（抽取自 react-icons/lu，MIT）：无品牌/官方 PNG 时的正经图标，按 GLYPH_RULES 指派 */
const LUCIDE_GLYPHS: Record<string, string> = {
  "trend": "<polyline points=\"22 7 13.5 15.5 8.5 10.5 2 17\"/><polyline points=\"16 7 22 7 22 13\"/>",
  "pie": "<path d=\"M21 12c.552 0 1.005-.449.95-.998a10 10 0 0 0-8.953-8.951c-.55-.055-.998.398-.998.95v8a1 1 0 0 0 1 1z\"/><path d=\"M21.21 15.89A10 10 0 1 1 8 2.83\"/>",
  "shield": "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\"/><path d=\"m9 12 2 2 4-4\"/>",
  "doc": "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/><path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/><path d=\"M10 9H8\"/><path d=\"M16 13H8\"/><path d=\"M16 17H8\"/>",
  "coins": "<circle cx=\"8\" cy=\"8\" r=\"6\"/><path d=\"M18.09 10.37A6 6 0 1 1 10.34 18\"/><path d=\"M7 6h1v4\"/><path d=\"m16.71 13.88.7.71-2.82 2.82\"/>",
  "briefcase": "<path d=\"M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16\"/><rect width=\"20\" height=\"14\" x=\"2\" y=\"6\" rx=\"2\"/>",
  "search": "<circle cx=\"11\" cy=\"11\" r=\"8\"/><path d=\"m21 21-4.3-4.3\"/>",
  "clock": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><polyline points=\"12 6 12 12 16 14\"/>",
  "video": "<path d=\"m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5\"/><rect x=\"2\" y=\"6\" width=\"14\" height=\"12\" rx=\"2\"/>",
  "branch": "<line x1=\"6\" x2=\"6\" y1=\"3\" y2=\"15\"/><circle cx=\"18\" cy=\"6\" r=\"3\"/><circle cx=\"6\" cy=\"18\" r=\"3\"/><path d=\"M18 9a9 9 0 0 1-9 9\"/>",
  "table": "<path d=\"M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18\"/>",
  "box": "<path d=\"M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z\"/><path d=\"m3.3 7 8.7 5 8.7-5\"/><path d=\"M12 22V12\"/>",
  "pen": "<path d=\"M12 20h9\"/><path d=\"M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z\"/>",
  "book": "<path d=\"M12 7v14\"/><path d=\"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z\"/>",
  "bot": "<path d=\"M12 8V4H8\"/><rect width=\"16\" height=\"12\" x=\"4\" y=\"8\" rx=\"2\"/><path d=\"M2 14h2\"/><path d=\"M20 14h2\"/><path d=\"M15 13v2\"/><path d=\"M9 13v2\"/>",
  "cloud": "<path d=\"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z\"/>",
  "wrench": "<path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z\"/>",
  "globe": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\"/><path d=\"M2 12h20\"/>",
  "landmark": "<line x1=\"3\" x2=\"21\" y1=\"22\" y2=\"22\"/><line x1=\"6\" x2=\"6\" y1=\"18\" y2=\"11\"/><line x1=\"10\" x2=\"10\" y1=\"18\" y2=\"11\"/><line x1=\"14\" x2=\"14\" y1=\"18\" y2=\"11\"/><line x1=\"18\" x2=\"18\" y1=\"18\" y2=\"11\"/><polygon points=\"12 2 20 7 4 7\"/>",
};

/** skill id → lucide 图标键：按语义关键词指派（顺序即优先级），插件名再兜一轮 */
const GLYPH_RULES: Array<[RegExp, string]> = [
  [/watchlist/i, "pie"],
  [/fund|portfolio|holdings|manager|pick/i, "pie"],
  [/credit|bond|risk|audit|vet|secret|token/i, "shield"],
  [/search|scan|idea|magnif/i, "search"],
  [/company|client|prospect|cluster|party|portrait|tianyancha/i, "briefcase"],
  [/book|zotero|jupyter|literature/i, "book"],
  [/report|note|research|earnings|morning|writing|author|brief|due|policy/i, "doc"],
  [/cash|coin|capital|budget|ledger|account|uses|variance/i, "coins"],
  [/video|film|movie|record|url2/i, "video"],
  [/git|branch|commit|merge|repo|workflow|actions|pipeline|issue|\bpr\b|gist/i, "branch"],
  [/watch|monitor|clock|intraday|event|recap/i, "clock"],
  [/trend|model|valuation|curve|spread|allocation|index|macro|sector|comps|finance|stock|invest/i, "trend"],
  [/table|sheet|statement|xls/i, "table"],
  [/3d|craft|rodin|card|kicad|pcb|unreal|unity|engine|toolset|release|package/i, "box"],
  [/obsidian|canvas|mermaid|diagram|whiteboard|markdown|editor|typst/i, "pen"],
  [/agent|robot|autoresearch|anet|mcp/i, "bot"],
  [/deploy|site|cloud|server|hosting|codespace/i, "cloud"],
  [/setup|install|env|cli|config/i, "wrench"],
  [/browser|web|globe|url/i, "globe"],
  [/landmark|bank|issuer/i, "landmark"],
];

function resolveGlyphKey(id: string, plugin?: string): string {
  for (const [pattern, key] of GLYPH_RULES) {
    if (pattern.test(id)) return key;
  }
  if (plugin) {
    for (const [pattern, key] of GLYPH_RULES) {
      if (pattern.test(plugin)) return key;
    }
  }
  return "box"; // 终兜底：通用物件，绝不退回首字母
}

/**
 * 合成图标：纯黑圆角底 + glyph。优先级：品牌原色路径 → 官方 PNG 内嵌 → lucide 线条图标（分类色）。
 * 品牌色过暗（GitHub/TikTok/Vercel 等近黑）时 glyph 改白，保证黑底上可见。
 * 覆盖 bundles/icons/<id>.svg。
 */
function buildIconSvg(id: string, category: Category, plugin?: string): string {
  const siKey = BRAND_MAP[id] ?? (id.startsWith("lark-") ? "siBytedance" : undefined);
  const brand: SiIcon | undefined = siKey
    ? ((simpleIcons as unknown as Record<string, SiIcon | undefined>)[siKey] ?? CUSTOM_BRANDS[siKey])
    : undefined;
  let glyphColor = brand ? `#${brand.hex}` : CATEGORY_COLORS[category];
  if (brand) {
    const num = parseInt(brand.hex.replace("#", ""), 16);
    const luminance =
      0.299 * ((num >> 16) & 255) + 0.587 * ((num >> 8) & 255) + 0.114 * (num & 255);
    if (luminance < 80) glyphColor = "#ffffff";
  }
  let glyph: string;
  if (brand?.viewBox) {
    // 非 24×24 源图（官方 logo 直采）：等比缩放进 24×24 网格居中，再走统一外层变换
    const [vw, vh] = brand.viewBox;
    const scale = 24 / Math.max(vw, vh);
    const ox = ((24 - vw * scale) / 2).toFixed(4);
    const oy = ((24 - vh * scale) / 2).toFixed(4);
    glyph = `<g transform="translate(11.4,11.4) scale(1.05)"><g transform="translate(${ox},${oy}) scale(${scale.toFixed(6)})"><path d="${brand.path}" fill="${glyphColor}"/></g></g>`;
  } else if (brand) {
    glyph = `<g transform="translate(11.4,11.4) scale(1.05)"><path d="${brand.path}" fill="${glyphColor}"/></g>`;
  } else if (IMAGE_BRANDS[id]) {
    // 官方 PNG 插件图标：圆角裁切内嵌，保持纵横比
    glyph = `<clipPath id="rr"><rect width="48" height="48" rx="12"/></clipPath><image href="${IMAGE_BRANDS[id]}" x="0" y="0" width="48" height="48" preserveAspectRatio="xMidYMid meet" clip-path="url(#rr)"/>`;
  } else {
    // lucide 内容画在 24×24 网格：与品牌路径同款变换居中放大进 48×48 底
    const lucide = LUCIDE_GLYPHS[resolveGlyphKey(id, plugin)];
    glyph = `<g transform="translate(11.4,11.4) scale(1.05)" fill="none" stroke="${glyphColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${lucide}</g>`;
  }
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">',
    '<rect x="0" y="0" width="48" height="48" rx="12" fill="#181818"/>',
    glyph,
    "</svg>",
  ].join("");
}

/** 生成并写入图标，返回相对路径（icons/<fileBase>.svg）；品牌查 BRAND_MAP[id]，fileBase 可与 id 不同（mcp 前缀防撞），iconKey 可指向插件名取官方 PNG，plugin 供 lucide 关键词兜底 */
async function writeIcon(
  id: string,
  category: Category,
  fileBase?: string,
  iconKey?: string,
  plugin?: string,
): Promise<string> {
  const base = fileBase ?? id;
  await mkdir(path.join(OUT, "icons"), { recursive: true });
  const file = path.join(OUT, "icons", `${base}.svg`);
  await writeFile(file, buildIconSvg(iconKey ?? id, category, plugin));
  return `icons/${base}.svg`;
}

/** 展示名：中文标题优先（mcp github 与 skill github 同 id —— 用 CN_TITLES 里的键会撞，mcp 单独传名） */
function displayName(id: string, fallback: string): string {
  const cn = CN_TITLES[id];
  return typeof cn === "string" && cn ? cn : fallback || id;
}

// ---------------------------------------------------------------- 工具函数

function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return {};
  const meta: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    meta[match[1].toLowerCase()] = value.replace(/\s*>-\s*$/, "").replace(/\s*\|\s*$/, "");
  }
  return { name: meta.name, description: meta.description };
}

function cleanDescription(raw: string | undefined, fallback: string | undefined): string {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  // fallback 也可能缺（调用方没传 descriptionFallback）：绝不能把 undefined 写进索引，否则渲染层搜索一输入就崩
  if (!text) return fallback ?? "";
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

const CATEGORY_BY_ID: Record<string, Category> = {
  // 界面设计
  "frontend-design": "界面设计", "frontend-skill": "界面设计", shadcn: "界面设计",
  "web-design-guidelines": "界面设计", "theme-factory": "界面设计", "canvas-design": "界面设计",
  figma: "界面设计", "algorithmic-art": "界面设计", "gc-minimal-zine-poster-v0-1": "界面设计",
  // 内容创作
  "doc-coauthoring": "内容创作", "internal-comms": "内容创作", "brand-guidelines": "内容创作",
  "prd-authoring": "内容创作", docx: "内容创作", pptx: "内容创作", pdf: "内容创作",
  "html-report": "内容创作", "html-deck": "内容创作", "report-page": "内容创作",
  "douyin-interact-creation": "内容创作", "douyin-interactive-content-publish": "内容创作",
  // 数据分析
  "chart-visualization": "数据分析", xlsx: "数据分析", "office-recalculate": "数据分析",
  // 开发工具
  "gh-cli": "开发工具", "git-commit": "开发工具", "mcp-builder": "开发工具",
  "webapp-testing": "开发工具", electron: "开发工具", "react-best-practices": "开发工具",
  "react-native-skills": "开发工具", "composition-patterns": "开发工具",
  "security-best-practices": "开发工具", "web-artifacts-builder": "开发工具",
  "agent-browser": "开发工具", github: "开发工具", "gh-address-comments": "开发工具",
  "gh-fix-ci": "开发工具", yeet: "开发工具", "redis-development": "开发工具",
  "skill-creator": "开发工具", "skill-installer": "开发工具", "plugin-creator": "开发工具",
  "office-export-pdf": "内容创作", "office-render": "内容创作",
  // —— ZCode 官方插件技能特例（插件级默认之上的修正）——
  "pptx-author": "内容创作", "xlsx-author": "内容创作", "report-render": "内容创作",
  "env-setup": "开发工具", "tripo-game-asset": "开发工具",
};

const CATEGORY_KEYWORDS: Array<[RegExp, Category]> = [
  [/lark|飞书|meeting|calendar|mail|okr|attendance|vc|wiki/i, "效率提升"],
  [/design|前端|ui\b|shadcn|theme|canvas|figma|poster|zine|art/i, "界面设计"],
  [/\bdoc|ppt|pdf|writ|report|prd|brand|comms|zine|创作|发布/i, "内容创作"],
  [/chart|xlsx|data|analy|recalculate|报表|数据/i, "数据分析"],
  [/git|test|debug|mcp|skill|code|review|browser|electron|react|redis|security|web|api|hyperframes|payment|alipay|douyin/i, "开发工具"],
];

function categorize(id: string, description: string): Category {
  if (CATEGORY_BY_ID[id]) return CATEGORY_BY_ID[id];
  const haystack = `${id} ${description}`;
  for (const [pattern, category] of CATEGORY_KEYWORDS) {
    if (pattern.test(haystack)) return category;
  }
  return "效率提升";
}

// ---------------------------------------------------------------- 收集器

const items: MarketItem[] = [];
const taken = new Map<string, string>(); // id → 来源描述（先到先得，skill 命名空间）
const takenMcp = new Map<string, string>(); // mcp 独立命名空间（install 按 {id,type} 定位）

/** 采集黑名单：无效条目（server 为空/本地无意义的）不进目录；重建时保持剔除。 */
const EXCLUDED_ENTRIES = new Set(["mcp:deployment"]);

function isTaken(id: string): boolean {
  return taken.has(id);
}

function claim(id: string, from: string): boolean {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    console.log(`[skip] "${id}" (invalid id)`);
    return false;
  }
  if (taken.has(id)) {
    console.log(`[dedupe] dropped ${id} (from ${from}, duplicate of ${taken.get(id)})`);
    return false;
  }
  taken.set(id, from);
  return true;
}

function claimMcp(id: string, from: string): boolean {
  if (EXCLUDED_ENTRIES.has(`mcp:${id}`)) {
    console.log(`[skip] mcp "${id}" (excluded)`);
    return false;
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    console.log(`[skip] mcp "${id}" (invalid id)`);
    return false;
  }
  if (takenMcp.has(id)) {
    console.log(`[dedupe] dropped mcp ${id} (from ${from}, duplicate of ${takenMcp.get(id)})`);
    return false;
  }
  takenMcp.set(id, from);
  return true;
}

async function dirHasSkill(dir: string): Promise<boolean> {
  try {
    const stat = await readFile(path.join(dir, "SKILL.md"), "utf8");
    return stat.trim().length > 0;
  } catch {
    return false;
  }
}

async function collectSkill(options: {
  srcDir: string;
  id: string;
  source: Source;
  from: string;
  name?: string;
  descriptionFallback: string;
  tags?: string[];
  version?: string;
  /** 来源插件名：命中官方 PNG 图标（IMAGE_BRANDS）时按插件名取图标 */
  plugin?: string;
  /** 插件级分类默认值；技能级 CATEGORY_BY_ID 特例优先，未提供走关键词启发式 */
  category?: Category;
}): Promise<void> {
  const { srcDir, id, source, from } = options;
  if (!(await dirHasSkill(srcDir))) {
    console.log(`[skip] ${id} (${from}: no SKILL.md)`);
    return;
  }
  if (!claim(id, from)) return;
  const dest = path.join(OUT, "skills", id);
  await cp(srcDir, dest, { recursive: true });
  const raw = await readFile(path.join(srcDir, "SKILL.md"), "utf8");
  const meta = parseFrontmatter(raw);
  const description = cleanDescription(meta.description, options.descriptionFallback);
  const category = CATEGORY_BY_ID[id] ?? options.category ?? categorize(id, description);
  const name = displayName(id, options.name ?? meta.name ?? id);
  const iconKey = BRAND_MAP[id] ? id : options.plugin && IMAGE_BRANDS[options.plugin] ? options.plugin : id;
  const icon = await writeIcon(id, category, undefined, iconKey, options.plugin);
  items.push({
    id,
    type: "skill",
    name,
    description,
    category,
    source,
    tags: options.tags ?? [],
    version: options.version ?? "0.0.0",
    entry: `skills/${id}`,
    entryKind: "dir",
    icon,
  });
}

// ---------------------------------------------------------------- Trae

type TraePluginInfo = { display_name?: string; description?: string; keywords?: string[]; version?: string };

async function traeDictionary(): Promise<Map<string, TraePluginInfo>> {
  const map = new Map<string, TraePluginInfo>();
  try {
    const raw = await readFile(path.join(TRAE, "installed-plugins.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      data?: { marketplaces?: Array<{ plugins?: Array<Record<string, unknown>> }> };
    };
    for (const plugin of parsed.data?.marketplaces?.[0]?.plugins ?? []) {
      const origin = String(plugin.origin_plugin_name ?? "");
      if (origin) {
        map.set(origin, {
          display_name: typeof plugin.display_name === "string" ? plugin.display_name : undefined,
          description: typeof plugin.description === "string" ? plugin.description : undefined,
          keywords: Array.isArray(plugin.keywords) ? (plugin.keywords as string[]) : undefined,
          version: typeof plugin.version === "string" ? plugin.version : undefined,
        });
      }
    }
  } catch {
    console.log("[warn] installed-plugins.json unavailable; using frontmatter only");
  }
  return map;
}

async function collectTrae(): Promise<void> {
  const dictionary = await traeDictionary();

  // 1) 用户级技能目录
  for (const entry of await readdir(path.join(TRAE, "skills"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const info = dictionary.get(entry.name);
    await collectSkill({
      srcDir: path.join(TRAE, "skills", entry.name),
      id: entry.name,
      source: "trae",
      from: "trae:skills",
      tags: info?.keywords?.slice(0, 4) ?? [],
      version: info?.version,
    });
  }

  // 2) 内置技能（跳过 _shared）
  for (const entry of await readdir(path.join(TRAE, "builtin_skills"), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "_shared") continue;
    await collectSkill({
      srcDir: path.join(TRAE, "builtin_skills", entry.name),
      id: entry.name.toLowerCase(),
      source: "trae",
      from: "trae:builtin",
      name: entry.name,
      tags: ["trae-builtin"],
    });
  }

  // 3) 官方插件：内嵌技能提取 + .mcp.json 抄录
  const officialDir = path.join(TRAE, "plugins", "trae-remote-official");
  for (const plugin of await readdir(officialDir, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const info = dictionary.get(plugin.name);
    const versions = await readdir(path.join(officialDir, plugin.name), { withFileTypes: true });
    const versionDir = versions.find((v) => v.isDirectory());
    if (!versionDir) continue;
    const pluginRoot = path.join(officialDir, plugin.name, versionDir.name);

    // 3a) 内嵌技能
    const skillsDir = path.join(pluginRoot, "skills");
    try {
      for (const skill of await readdir(skillsDir, { withFileTypes: true })) {
        if (!skill.isDirectory()) continue;
        await collectSkill({
          srcDir: path.join(skillsDir, skill.name),
          id: skill.name,
          source: "trae",
          from: `trae:plugin:${plugin.name}`,
          tags: info?.keywords?.slice(0, 4) ?? [plugin.name],
          version: versionDir.name,
        });
      }
    } catch {
      /* 无 skills 目录 */
    }

    // 3b) .mcp.json → mcp/<server>.json（凭据占位改写）
    try {
      const mcpRaw = await readFile(path.join(pluginRoot, ".mcp.json"), "utf8");
      const mcpConfig = JSON.parse(mcpRaw) as {
        mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
      };
      for (const [serverName, server] of Object.entries(mcpConfig.mcpServers ?? {})) {
        if (!claimMcp(serverName, `trae:mcp:${plugin.name}`)) continue;
        const requiresEnv: string[] = [];
        const rewritten: Record<string, string> = {};
        for (const [key, value] of Object.entries(server.headers ?? {})) {
          rewritten[key] = value.replace(
            /\$\{connector\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\}/g,
            (_all, connector: string, field: string) => {
              if (field.toUpperCase() !== "ACCESS_TOKEN") {
                throw new Error(`unhandled connector field ${connector}.${field}（请人工处理）`);
              }
              const envVar = `MEOWCODE_${connector.toUpperCase()}_TOKEN`;
              requiresEnv.push(envVar);
              return `\${${envVar}}`;
            },
          );
        }
        const entryFile = path.join(OUT, "mcp", `${serverName}.json`);
        await writeFile(
          entryFile,
          JSON.stringify(
            {
              description: info?.description ?? `${serverName} MCP server（来自 Trae 官方插件 ${plugin.name}）`,
              server: {
                ...(server.url ? { url: server.url } : {}),
                ...(Object.keys(rewritten).length > 0 ? { headers: rewritten } : {}),
              },
            },
            null,
            2,
          ),
        );
        const mcpName = info?.display_name ?? serverName;
        const mcpIcon = await writeIcon(serverName, categorize(serverName, mcpName), `mcp-${serverName}`);
        items.push({
          id: serverName,
          type: "mcp",
          name: mcpName,
          description: cleanDescription(info?.description, `${serverName} MCP server`),
          category: categorize(serverName, `${serverName} ${info?.description ?? ""}`),
          source: "trae",
          tags: ["mcp", ...(info?.keywords?.slice(0, 3) ?? [])],
          version: versionDir.name,
          entry: `mcp/${serverName}.json`,
          entryKind: "file",
          icon: mcpIcon,
          requiresEnv,
        });
        console.log(`[mcp] ${serverName} (${plugin.name})`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.log(`[warn] mcp extract failed for ${plugin.name}: ${(error as Error).message}`);
      }
    }
  }
}

// ---------------------------------------------------------------- ZCode 官方插件市场（应用缓存 + CDN zip）

const ZCODE_MARKET_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json";
const ZCODE_ICON_BASE = "https://cdn-zcode.z.ai/zcode/official-plugin/assets";
/** zip 下载与解压的本地缓存（gitignore，重跑免下载） */
const ZCODE_MARKET_CACHE = path.join(REPO, ".cache", "zcode-marketplace");
const ZCODE_APP_CACHE = "C:/Users/MuLiu/.zcode/cli/plugins/cache/zcode-plugins-official";

/** ZCode 官方插件 → 分类默认值（技能级特例放 CATEGORY_BY_ID；未列出的插件走关键词启发式） */
const ZCODE_MARKET_CATEGORY: Record<string, Category> = {
  github: "开发工具", gitlab: "开发工具", "cloudbase-skills": "开发工具", video2code: "开发工具",
  "zcode-mcp-app-dev": "开发工具", "alibaba-cloud-cli": "开发工具", anet: "开发工具", kicad: "开发工具",
  "unreal-engine": "开发工具", unity: "开发工具", "browser-use": "开发工具", "zcode-guide": "开发工具",
  "zcode-site": "开发工具", "plugin-creator": "开发工具", "skill-creator": "开发工具",
  "node-repl-host": "开发工具", "android-emulator": "开发工具", "ios-simulator": "开发工具",
  autoresearch: "数据分析", "write-research": "数据分析", "accounting-and-reporting": "数据分析",
  "run-fpa": "数据分析", "model-deals": "数据分析", "assess-credit": "数据分析", "read-macro": "数据分析",
  "pick-funds": "数据分析", "watch-positions": "数据分析", "find-clients": "数据分析", "vet-companies": "数据分析",
  "finance-search": "数据分析", hexin: "数据分析", wind: "数据分析", tianyancha: "数据分析",
  "jupyter-notebook": "数据分析", visualize: "数据分析",
  documents: "内容创作", pdf: "内容创作", presentations: "内容创作", spreadsheets: "内容创作",
  "document-skills": "内容创作", "typst-workbench": "内容创作", "video-agent-kit": "内容创作",
  excalidraw: "界面设计", "hyper3d-rodin": "界面设计", "ruic-card": "界面设计", "tripo-3d": "界面设计",
  obsidian: "效率提升", mimosa: "效率提升", "libtv-cli": "效率提升", "lark-cli": "效率提升",
  "dingtalk-cli": "效率提升", "tencent-meeting-cli": "效率提升", "wecom-cli": "效率提升",
  "jev-decisions": "效率提升", "image-search": "效率提升", "restore-legacy-sessions": "开发工具",
};

/** 拉官方插件 PNG 图标进 IMAGE_BRANDS（缺失/失败静默走首字母兜底）；文件缓存避免重跑下载 */
async function loadZcodePluginIcon(pluginName: string): Promise<void> {
  if (IMAGE_BRANDS[pluginName]) return;
  const file = path.join(ZCODE_MARKET_CACHE, "icons", `${pluginName}.png`);
  const cached = await readFile(file).catch(() => null);
  let buffer: Buffer | null = cached;
  if (!buffer) {
    const response = await fetch(`${ZCODE_ICON_BASE}/${pluginName}/icon.png`).catch(() => null);
    if (!response?.ok) return;
    const blob = Buffer.from(await response.arrayBuffer());
    if (blob.length < 100) return;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, blob);
    buffer = blob;
  }
  IMAGE_BRANDS[pluginName] = `data:image/png;base64,${buffer.toString("base64")}`;
}

type ZcodeMarketPlugin = {
  name: string;
  description?: string;
  source?: { source?: string; type?: string; url?: string; sha256?: string };
};

async function fetchZcodeMarketIndex(): Promise<ZcodeMarketPlugin[]> {
  const cacheFile = path.join(ZCODE_MARKET_CACHE, "marketplace.json");
  try {
    const response = await fetch(ZCODE_MARKET_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, text);
    return (JSON.parse(text) as { plugins?: ZcodeMarketPlugin[] }).plugins ?? [];
  } catch (error) {
    console.log(`[warn] zcode-market index fetch failed (${(error as Error).message}); fallback to cached copy`);
    const cached = await readFile(cacheFile, "utf8").catch(() => "null");
    return (JSON.parse(cached) as { plugins?: ZcodeMarketPlugin[] } | null)?.plugins ?? [];
  }
}

/** 版本目录挑最新：逐段数值比较 */
function newerVersionDir(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const na = Number(pa[index] ?? 0);
    const nb = Number(pb[index] ?? 0);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  }
  return 0;
}

async function versionDirs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [] as Dirent[]);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(newerVersionDir);
}

async function hasSkillsDir(dir: string): Promise<boolean> {
  try {
    return (await stat(path.join(dir, "skills"))).isDirectory();
  } catch {
    return false;
  }
}

/** zip 内容完整性跟 CDN 发布的 sha256 对账；缓存命中且一致就不再下载 */
async function downloadZcodeZip(url: string, sha256: string, zipPath: string): Promise<void> {
  const hashOf = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
  const cached = await readFile(zipPath).then((buffer) => hashOf(buffer) === sha256, () => false);
  if (cached) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = Buffer.from(await response.arrayBuffer());
  if (hashOf(blob) !== sha256) throw new Error("sha256 mismatch");
  await mkdir(path.dirname(zipPath), { recursive: true });
  await writeFile(zipPath, blob);
}

/** CDN zip 顶层是 <插件名>/ 目录；解压后返回含 skills/ 的插件根（没有则 null） */
async function extractZcodeZip(pluginName: string, url: string, sha256: string): Promise<string | null> {
  const version = url.match(/\/(\d+\.\d+\.\d+)\/plugin\.zip$/)?.[1] ?? "0";
  const zipPath = path.join(ZCODE_MARKET_CACHE, `${pluginName}-${version}.zip`);
  const outDir = path.join(ZCODE_MARKET_CACHE, `${pluginName}-${version}`);
  if (await hasSkillsDir(outDir)) return outDir; // 之前解压过且完整
  await downloadZcodeZip(url, sha256, zipPath);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await execFileAsync("python", ["-I", "-m", "zipfile", "-e", zipPath, outDir]);
  if (await hasSkillsDir(outDir)) return outDir;
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    const candidate = path.join(outDir, entry.name);
    if (entry.isDirectory() && (await hasSkillsDir(candidate))) return candidate;
  }
  return null;
}

/** 单个 ZCode 插件的 skills/ 全量喂进 collectSkill（运行时强绑定技能按 ZCODE_SKIP 丢弃） */
async function collectZcodePluginSkills(
  root: string,
  pluginName: string,
  version: string,
  from: string,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(path.join(root, "skills"), { withFileTypes: true });
  } catch {
    return;
  }
  for (const skill of entries) {
    if (!skill.isDirectory()) continue;
    if (ZCODE_SKIP.has(skill.name)) {
      console.log(`[skip] ${skill.name} (zcode runtime-tied, ${pluginName})`);
      continue;
    }
    await collectSkill({
      srcDir: path.join(root, "skills", skill.name),
      id: skill.name,
      source: "zcode",
      from,
      tags: [pluginName],
      version,
      plugin: pluginName,
      category: ZCODE_MARKET_CATEGORY[pluginName],
    });
  }
}

/**
 * ZCode 官方插件市场技能 → 内置市场：
 * CDN 清单里每个插件优先用本机 ZCode 应用缓存（免下载），没有再拉 zip（sha256 校验）；
 * 已从 CDN 下架但应用缓存里还有的插件（github/browser-use/documents 等）同样搬。
 * 与 collectZcode（ZCode-main 仓库源）共用 claim 去重：仓库先收的保持不动，这里只补增量。
 */
async function collectZcodeMarket(): Promise<void> {
  const plugins = await fetchZcodeMarketIndex();
  for (const plugin of plugins) {
    const version = plugin.source?.url?.match(/\/(\d+\.\d+\.\d+)\/plugin\.zip$/)?.[1] ?? "0.0.0";
    let root: string | null = null;
    const cachedVersions = await versionDirs(path.join(ZCODE_APP_CACHE, plugin.name));
    const latest = cachedVersions[cachedVersions.length - 1];
    if (latest && (await hasSkillsDir(path.join(ZCODE_APP_CACHE, plugin.name, latest)))) {
      root = path.join(ZCODE_APP_CACHE, plugin.name, latest);
    } else if (plugin.source?.type === "zip" && plugin.source.url) {
      root = await extractZcodeZip(plugin.name, plugin.source.url, plugin.source.sha256 ?? "").catch(
        (error: unknown) => {
          console.log(`[warn] zcode-market ${plugin.name}: ${(error as Error).message}`);
          return null;
        },
      );
    }
    if (!root) {
      console.log(`[warn] zcode-market ${plugin.name}: no usable source, skipped`);
      continue;
    }
    await loadZcodePluginIcon(plugin.name);
    await collectZcodePluginSkills(root, plugin.name, version, `zcode-market:${plugin.name}`);
  }

  // 应用缓存里已不在 CDN 清单上的插件（下架/内置分发），也把技能搬进来
  const cacheEntries = await readdir(ZCODE_APP_CACHE, { withFileTypes: true }).catch(() => [] as Dirent[]);
  const listed = new Set(plugins.map((plugin) => plugin.name));
  for (const entry of cacheEntries) {
    if (!entry.isDirectory()) continue;
    const versions = await versionDirs(path.join(ZCODE_APP_CACHE, entry.name));
    const latest = versions[versions.length - 1];
    if (!latest) continue;
    await loadZcodePluginIcon(entry.name);
    const from = listed.has(entry.name) ? `zcode-market:${entry.name}` : `zcode-app:${entry.name}`;
    await collectZcodePluginSkills(
      path.join(ZCODE_APP_CACHE, entry.name, latest),
      entry.name,
      latest,
      from,
    );
  }
}

// ---------------------------------------------------------------- ZCode 仓库 / dsh / codex

/** 与宿主运行时强绑定、搬过去只有死文本的技能 */
const ZCODE_SKIP = new Set(["android-dev", "ios-dev", "computer-use", "restore-legacy-sessions"]);

async function collectZcode(): Promise<void> {
  for (const plugin of await readdir(ZCODE, { withFileTypes: true })) {
    if (!plugin.isDirectory() || !plugin.name.endsWith("-plugin") && plugin.name !== "bundled-skills") continue;
    const skillsDir = path.join(ZCODE, plugin.name, "skills");
    let entries;
    try {
      entries = await readdir(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    let version = "0.0.0";
    try {
      const pkg = JSON.parse(await readFile(path.join(ZCODE, plugin.name, "package.json"), "utf8")) as {
        version?: string;
      };
      if (pkg.version) version = pkg.version;
    } catch {
      /* 无 package.json */
    }
    for (const skill of entries) {
      if (!skill.isDirectory()) continue;
      if (ZCODE_SKIP.has(skill.name)) {
        console.log(`[skip] ${skill.name} (zcode runtime-tied)`);
        continue;
      }
      await collectSkill({
        srcDir: path.join(skillsDir, skill.name),
        id: skill.name,
        source: "zcode",
        from: `zcode:${plugin.name}`,
        tags: [plugin.name.replace(/-plugin$/, "")],
        version,
      });
    }
  }
}

/** dsh office-* 与已收集的 docx/pptx/xlsx 功能重复：别名去重 */
const DSH_ALIAS_DROP: Record<string, string> = {
  "office-docx": "docx",
  "office-pptx": "pptx",
  "office-xlsx": "xlsx",
};

async function collectDsh(): Promise<void> {
  for (const entry of await readdir(DSH, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const aliasTarget = DSH_ALIAS_DROP[entry.name];
    if (aliasTarget && isTaken(aliasTarget)) {
      console.log(`[dedupe] dropped ${entry.name} (from dsh, duplicate of ${aliasTarget})`);
      continue;
    }
    await collectSkill({
      srcDir: path.join(DSH, entry.name),
      id: entry.name,
      source: "dsh",
      from: "dsh:skill-office",
      tags: ["office"],
    });
  }
}

async function collectCodex(): Promise<void> {
  for (const entry of await readdir(CODEX, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await collectSkill({
      srcDir: path.join(CODEX, entry.name),
      id: entry.name,
      source: "codex",
      from: "codex:samples",
      tags: ["openai"],
    });
  }
}

// ---------------------------------------------------------------- 内置插件索引

async function collectPlugins(): Promise<void> {
  const pluginsDir = path.join(OUT, "plugins");
  const PLUGIN_META: Record<
    string,
    { name: string; description: string; category: Category; usage: string }
  > = {
    "permission-gate": {
      name: "危险命令门禁",
      description: "拦截 rm -rf / sudo / chmod 777 等高危命令。",
      category: "开发工具",
      usage: "安装后自动拦截 `run_command` 中的高危模式：\n- `rm -rf` / 递归强删\n- `sudo`\n- `chmod|chown … 777`\n- `format` / `diskpart` / `del /s` `rd /s`\n\n被拦截的调用会把原因返回给模型，不会执行。对话中发送 `/gate allow` 临时放行一回合，`/gate strict` 恢复拦截。",
    },
    "protected-paths": {
      name: "敏感文件保护",
      description: "阻止写入 .env、.git、node_modules 等敏感路径。",
      category: "开发工具",
      usage: "安装后 `write_file` / `edit_file` / `multi_edit` 触碰以下路径片段会被拦截：`.env`、`.git/`、`node_modules/`、`.meowcode/`、`id_rsa`。\n\n`/protect` 查看规则，`/protect add <片段>` 追加，`/protect remove <片段>` 解除。",
    },
    "todo": {
      name: "Todo 清单",
      description: "todo 工具 + /todos 命令，任务清单持久化存储。",
      category: "效率提升",
      usage: "注册 `todo` 工具（list / add / toggle / clear）供模型管理多步任务，状态持久化到 `~/.meowcode/plugin-data/todo.json`。\n\n`/todos` 随时查看当前清单。",
    },
    "summarize": {
      name: "会话总结",
      description: "/summarize 生成结构化总结 prompt（目标/已完成/待办/风险）。",
      category: "效率提升",
      usage: "对话中输入 `/summarize [重点]`，生成一份结构化总结提示（目标 / 已完成 / 待办 / 风险），可带重点方向。",
    },
    "auto-commit": {
      name: "自动提交",
      description: "回合结束后自动 git commit（默认关闭，/autocommit on 开启）。",
      category: "开发工具",
      usage: "**默认关闭**。`/autocommit on` 开启后，每个正常完成的回合若有未提交改动，自动执行 `git add -A && git commit`（提交信息含回合 id）。`/autocommit off` 关闭。",
    },
    "git-checkpoint": {
      name: "Git 检查点",
      description: "每回合结束用 git stash create 打检查点（不改工作树，默认关闭）。",
      category: "开发工具",
      usage: "**默认关闭**。`/checkpoint on` 开启后，每回合结束用 `git stash create` + `stash store` 生成检查点提交——**不改动工作区文件**。\n\n`/checkpoint-now` 立即打点；回滚用 `git stash list` 找 `meowcode-checkpoint` 条目后 `git stash apply stash@{N}`。",
    },
    "anthropic-frontend-design": {
      name: "Anthropic 前端界面设计",
      description:
        "Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, or applications. Generates creative, polished code that avoids generic AI aesthetics.",
      category: "界面设计",
      usage:
        "包含技能：`frontend-design` —— 生成有辨识度的生产级前端界面，避开通用 AI 审美。\n\n安装后对话中输入 `/frontend-design <需求>`，插件会把技能全文随需求一起发给模型：先确定设计方向（用途 / 调性 / 约束 / 记忆点），再输出可运行代码。",
    },
  };
  for (const file of await readdir(pluginsDir)) {
    if (!file.endsWith(".ts")) continue;
    const id = file.slice(0, -3);
    if (!claim(id, "plugins")) continue;
    const meta = PLUGIN_META[id] ?? {
      name: id,
      description: `内置插件 ${id}`,
      category: "效率提升" as Category,
      usage: "",
    };
    const icon = await writeIcon(id, meta.category);
    items.push({
      id,
      type: "plugin",
      name: displayName(id, meta.name),
      description: meta.description,
      category: meta.category,
      source: "metis",
      tags: ["plugin"],
      version: "1.0.0",
      entry: `plugins/${file}`,
      entryKind: "file",
      icon,
      ...(meta.usage ? { usage: meta.usage } : {}),
    });
  }
}

// ---------------------------------------------------------------- 主流程

/** 手工维护的 MCP 条目（不来自 Trae）：源头在此，重跑脚本不会丢。 */
type ManualMcp = {
  id: string;
  name: string;
  description: string;
  category: Category;
  tags: string[];
  version: string;
  server: Record<string, unknown>;
  requiresEnv?: string[];
  /** 品牌图标直用（官方 PNG 资产）：从 brand-icons/ 拷进 icons/；源缺失回退首字母 */
  brandIcon?: { source: string; file: string };
};

const MANUAL_MCPS: ManualMcp[] = [
  {
    id: "gitcode",
    name: "GitCode",
    description: "GitCode 平台集成：仓库、Issue、PR、Fork、里程碑与看板（社区 Node MCP，npx 启动）。",
    category: "开发工具",
    tags: ["mcp", "gitcode", "repository", "issue", "pull-request"],
    version: "1.4.0",
    server: {
      command: "npx",
      args: ["-y", "@yangxt65535/gitcode-mcp@1.4.0"],
      env: { GITCODE_TOKEN: "${MEOWCODE_GITCODE_TOKEN}" },
    },
    requiresEnv: ["MEOWCODE_GITCODE_TOKEN"],
  },
  {
    id: "js-reverse",
    name: "JS 逆向调试",
    description:
      "JS 逆向调试：Chrome 断点/单步/调用栈、脚本源码搜索与保存、XHR/WebSocket 抓包与调用链定位、页面脚本执行（npx 启动，需本地 Chrome）。",
    category: "开发工具",
    tags: ["mcp", "js-reverse", "reverse-engineering", "debugger", "devtools"],
    version: "4.0.5",
    server: {
      command: "npx",
      args: ["-y", "js-reverse-mcp@4.0.5"],
    },
  },
  {
    id: "firecrawl",
    name: "Firecrawl 网页抓取",
    description:
      "官方免 key 托管 MCP：网页抓取转 Markdown（scrape）、联网搜索（search）、文档解析（parse），零配置安装即用（托管端点限速）。",
    category: "开发工具",
    tags: ["mcp", "firecrawl", "scrape", "search", "web"],
    version: "3.34.1",
    server: {
      url: "https://mcp.firecrawl.dev/v2/mcp",
    },
  },
  {
    id: "figma-context",
    name: "Figma 设计稿上下文",
    description:
      "Framelink Figma Context MCP：抓取 Figma 设计稿并简化为模型友好的布局与样式信息，设计稿转代码首选（npx 启动，需 Figma 个人访问令牌）。",
    category: "开发工具",
    tags: ["mcp", "figma", "design", "design-to-code"],
    version: "1.5.0",
    server: {
      command: "npx",
      args: ["-y", "figma-context-mcp@1.5.0", "--stdio"],
      env: { FIGMA_API_KEY: "${MEOWCODE_FIGMA_TOKEN}" },
    },
    requiresEnv: ["MEOWCODE_FIGMA_TOKEN"],
  },
  {
    id: "mobile-mcp",
    name: "移动设备自动化",
    description:
      "mobile-mcp：Android 模拟器/真机与 iOS 设备自动化——截图、点击滑动、屏幕元素识别、应用管理、日志与崩溃采集（Windows 下为 Android；iOS 需 macOS）。",
    category: "开发工具",
    tags: ["mcp", "mobile", "android", "ios", "automation"],
    version: "1.0.12",
    server: {
      command: "npx",
      args: ["-y", "@mobilenext/mobile-mcp@1.0.12"],
      env: { MOBILEMCP_DISABLE_TELEMETRY: "1" },
    },
    brandIcon: { source: "resources/brand-icons/mcp-mobile-mcp.png", file: "mcp-mobile-mcp.png" },
  },
  {
    id: "my-coffee",
    name: "瑞幸咖啡（luckin coffee）",
    description:
      "瑞幸咖啡官方点单 MCP：门店查询、商品搜索、自提下单、支付二维码、订单状态与取餐码查询、取消订单。Token 在 open.lkcoffee.com/mcp 登录后创建。",
    category: "效率提升",
    tags: ["mcp", "luckin", "coffee", "order"],
    version: "1.0.0",
    server: {
      url: "https://gwmcp.lkcoffee.com/order/user/mcp",
      headers: { Authorization: "Bearer ${LUCKIN_MCP_TOKEN}" },
    },
    requiresEnv: ["LUCKIN_MCP_TOKEN"],
    brandIcon: { source: "resources/brand-icons/mcp-luckin-coffee.png", file: "mcp-luckin-coffee.png" },
  },
];

/** 手工维护的技能条目（不来自采集源）：源头在此，重跑脚本不会丢。 */
type ManualSkill = {
  /** 相对仓库根的技能目录（需含 SKILL.md） */
  dir: string;
  id: string;
  name: string;
  /** SKILL.md frontmatter 缺 description 时的兜底 */
  descriptionFallback: string;
  category: Category;
  tags: string[];
  version: string;
};

const MANUAL_SKILLS: ManualSkill[] = [
  {
    dir: "resources/skills/my-coffee",
    id: "my-coffee",
    name: "瑞幸咖啡（luckin coffee）",
    descriptionFallback: "瑞幸咖啡下单助手：查门店、搜商品、自提下单、支付二维码、订单与取餐码查询、取消订单（需搭配瑞幸点单 MCP）。",
    category: "效率提升",
    tags: ["skill", "luckin", "coffee", "order"],
    version: "0.8.4",
  },
];

async function collectManualMcp(): Promise<void> {
  for (const entry of MANUAL_MCPS) {
    if (!claimMcp(entry.id, "builtin:manual")) continue;
    const bundle = { description: entry.description, server: entry.server };
    await writeFile(path.join(OUT, "mcp", `${entry.id}.json`), `${JSON.stringify(bundle, null, 2)}\n`);
    let icon: string;
    if (entry.brandIcon) {
      try {
        await cp(path.join(REPO, entry.brandIcon.source), path.join(OUT, "icons", entry.brandIcon.file));
        icon = `icons/${entry.brandIcon.file}`;
      } catch {
        console.log(`[warn] brand icon missing for ${entry.id}; falling back to letter`);
        icon = await writeIcon(entry.id, entry.category, `mcp-${entry.id}`);
      }
    } else {
      icon = await writeIcon(entry.id, entry.category, `mcp-${entry.id}`);
    }
    items.push({
      id: entry.id,
      type: "mcp",
      name: entry.name,
      description: entry.description,
      category: entry.category,
      source: "builtin",
      tags: entry.tags,
      version: entry.version,
      entry: `mcp/${entry.id}.json`,
      entryKind: "file",
      icon,
      ...(entry.requiresEnv ? { requiresEnv: entry.requiresEnv } : {}),
    });
    console.log(`[mcp] ${entry.id} (manual)`);
  }
}

async function collectManualSkills(): Promise<void> {
  for (const entry of MANUAL_SKILLS) {
    await collectSkill({
      srcDir: path.join(REPO, entry.dir),
      id: entry.id,
      source: "builtin",
      from: "builtin:manual",
      name: entry.name,
      descriptionFallback: entry.descriptionFallback,
      tags: entry.tags,
      version: entry.version,
      category: entry.category,
    });
    console.log(`[skill] ${entry.id} (manual)`);
  }
}

/** IMAGE_BRANDS 是静态表而 PNG 资产在仓库里：构建期读文件转 data URI 填充（技能条目复用品牌 PNG）。 */
async function loadImageBrands(): Promise<void> {
  const sources: Array<[string, string]> = [
    ["my-coffee", "resources/brand-icons/mcp-luckin-coffee.png"],
  ];
  for (const [id, file] of sources) {
    try {
      const raw = await readFile(path.join(REPO, file));
      IMAGE_BRANDS[id] = `data:image/png;base64,${raw.toString("base64")}`;
    } catch {
      console.log(`[warn] brand image missing for ${id}; falling back to letter`);
    }
  }
}

async function main(): Promise<void> {
  await rm(path.join(OUT, "skills"), { recursive: true, force: true });
  await rm(path.join(OUT, "mcp"), { recursive: true, force: true });
  await rm(path.join(OUT, "index.json"), { force: true });
  await mkdir(path.join(OUT, "skills"), { recursive: true });
  await mkdir(path.join(OUT, "mcp"), { recursive: true });
  await mkdir(path.join(OUT, "plugins"), { recursive: true });

  await loadImageBrands();
  await collectTrae();
  await collectZcode();
  await collectZcodeMarket();
  await collectDsh();
  await collectCodex();
  await collectPlugins();
  await collectManualMcp();
  await collectManualSkills();

  const typeOrder = { skill: 0, plugin: 1, mcp: 2 } as const;
  items.sort(
    (a, b) =>
      typeOrder[a.type] - typeOrder[b.type] ||
      a.category.localeCompare(b.category, "zh") ||
      a.id.localeCompare(b.id),
  );
  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    items,
  };
  await writeFile(path.join(OUT, "index.json"), `${JSON.stringify(index, null, 2)}\n`);

  const byType = { skill: 0, plugin: 0, mcp: 0 } as Record<MarketItem["type"], number>;
  for (const item of items) byType[item.type] += 1;
  console.log(`marketplace: ${items.length} items (skill ${byType.skill}, plugin ${byType.plugin}, mcp ${byType.mcp})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
