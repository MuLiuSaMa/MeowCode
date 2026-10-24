/**
 * 市场搬运脚本：把 Trae 本地技能 / 参考仓库技能 汇总进 resources/marketplace/。
 *
 * 用法：pnpm tsx scripts/build-marketplace.ts
 * - 幂等可重跑：每次重建 skills/ mcp/ index.json；plugins/ 是手工维护源，不触碰
 * - 同名去重优先级：Trae(skills) > Trae(builtin) > Trae(plugins 内嵌) > ZCode > dsh > codex
 * - ZCode 子进程 hooks 一律丢弃（与 MeowCode 进程内 hook 形态不兼容）
 * - Trae ${connector.x.ACCESS_TOKEN} 凭据占位 → ${MEOWCODE_X_TOKEN}（expandEnvTemplates 只认纯环境变量名）
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as simpleIcons from "simple-icons";

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
  "notify": "回合通知",
  "permission-gate": "危险命令门禁",
  "protected-paths": "敏感文件保护",
  "todo": "Todo 清单",
  "session-log": "会话日志",
  "summarize": "会话总结",
  "auto-commit": "自动提交",
  "git-checkpoint": "Git 检查点",
  "guard": "安全守卫",
};

// ---------------------------------------------------------------- 图标合成（类 3D 质感）

type SiIcon = { path: string; hex: string; title: string };

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
  "notify": "siTelegram",
  "session-log": "siObsidian",
  "summarize": "siLogseq",
  "permission-gate": "siAuth0",
  "guard": "si1password",
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
};

/** 分类兜底色（无品牌 glyph 时的字母颜色） */
const CATEGORY_COLORS: Record<Category, string> = {
  "开发工具": "#3b82f6",
  "界面设计": "#8b5cf6",
  "内容创作": "#f59e0b",
  "数据分析": "#10b981",
  "效率提升": "#ec4899",
};

/**
 * 合成图标：纯黑圆角底 + 品牌原色 glyph（无品牌用分类色首字母）。无渐变无高光。
 * 品牌色过暗（GitHub/TikTok/Vercel 等近黑）时 glyph 改白，保证黑底上可见。
 * 覆盖 bundles/icons/<id>.svg。
 */
function buildIconSvg(id: string, name: string, category: Category): string {
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
  const glyph = brand
    ? `<g transform="translate(11.4,11.4) scale(1.05)"><path d="${brand.path}" fill="${glyphColor}"/></g>`
    : `<text x="24" y="25" text-anchor="middle" dominant-baseline="central" font-family="Segoe UI,system-ui,sans-serif" font-size="21" font-weight="800" fill="${glyphColor}">${(name || id).charAt(0).toUpperCase()}</text>`;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">',
    '<rect x="0" y="0" width="48" height="48" rx="12" fill="#181818"/>',
    glyph,
    "</svg>",
  ].join("");
}

/** 生成并写入图标，返回相对路径（icons/<fileBase>.svg）；品牌查 BRAND_MAP[id]，fileBase 可与 id 不同（mcp 前缀防撞） */
async function writeIcon(id: string, name: string, category: Category, fileBase?: string): Promise<string> {
  const base = fileBase ?? id;
  await mkdir(path.join(OUT, "icons"), { recursive: true });
  const file = path.join(OUT, "icons", `${base}.svg`);
  await writeFile(file, buildIconSvg(id, name, category));
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

function cleanDescription(raw: string | undefined, fallback: string): string {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
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
  const category = categorize(id, description);
  const name = displayName(id, options.name ?? meta.name ?? id);
  const icon = await writeIcon(id, name, category);
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
        const mcpIcon = await writeIcon(serverName, mcpName, categorize(serverName, mcpName), `mcp-${serverName}`);
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

// ---------------------------------------------------------------- ZCode / dsh / codex

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
    "notify": {
      name: "回合通知",
      description: "回合结束时弹 Windows Toast 通知（适配自 metis notify 扩展）。",
      category: "效率提升",
      usage: "安装即生效。每个回合结束时弹出系统通知：\n- 回合正常完成 → 「回合已完成，等待你的输入」\n- 回合异常结束 → 提示结束状态\n\n仅 Windows 生效；通知失败静默忽略，不影响回合。",
    },
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
    "session-log": {
      name: "会话日志",
      description: "记录最近打开的会话（cwd + 时间），/sessions-log 查看。",
      category: "效率提升",
      usage: "每次打开/切换会话自动记录（最多 100 条），`/sessions-log` 查看最近 20 条。适合回顾「最近在哪些项目里干了什么」。",
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
    "guard": {
      name: "安全守卫",
      description: "tool_call 拦截危险命令 + prompt_submit 过滤注入模式（内置示例）。",
      category: "开发工具",
      usage: "双重守卫：\n- `tool_call`：拦截 `rm -rf` / `del /s` / `format` 等破坏性命令\n- `prompt_submit`：拦截「忽略之前所有指令」类注入模式\n\n也是插件 API 的最小参考实现。",
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
    const icon = await writeIcon(id, meta.name, meta.category);
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

/** 手工维护的 MCP 条目（不来自 Trae）：GitCode 社区 Node MCP。 */
async function collectManualMcp(): Promise<void> {
  const id = "gitcode";
  if (!claimMcp(id, "builtin:manual")) return;
  const description = "GitCode 平台集成：仓库、Issue、PR、Fork、里程碑与看板（社区 Node MCP，npx 启动）。";
  const bundle = {
    description,
    server: {
      command: "npx",
      args: ["-y", "@yangxt65535/gitcode-mcp@1.4.0"],
      env: { GITCODE_TOKEN: "${MEOWCODE_GITCODE_TOKEN}" },
    },
  };
  await writeFile(path.join(OUT, "mcp", `${id}.json`), `${JSON.stringify(bundle, null, 2)}\n`);
  const icon = await writeIcon(id, "GitCode", "开发工具", "mcp-gitcode");
  items.push({
    id,
    type: "mcp",
    name: "GitCode",
    description,
    category: "开发工具",
    source: "builtin",
    tags: ["mcp", "gitcode", "repository", "issue", "pull-request"],
    version: "1.4.0",
    entry: `mcp/${id}.json`,
    entryKind: "file",
    icon,
    requiresEnv: ["MEOWCODE_GITCODE_TOKEN"],
  });
  console.log("[mcp] gitcode (manual)");
}

async function main(): Promise<void> {
  await rm(path.join(OUT, "skills"), { recursive: true, force: true });
  await rm(path.join(OUT, "mcp"), { recursive: true, force: true });
  await rm(path.join(OUT, "index.json"), { force: true });
  await mkdir(path.join(OUT, "skills"), { recursive: true });
  await mkdir(path.join(OUT, "mcp"), { recursive: true });
  await mkdir(path.join(OUT, "plugins"), { recursive: true });

  await collectTrae();
  await collectZcode();
  await collectDsh();
  await collectCodex();
  await collectPlugins();
  await collectManualMcp();

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
