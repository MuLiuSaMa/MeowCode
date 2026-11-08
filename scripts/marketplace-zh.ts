/**
 * 市场技能的中文名称与一句话介绍（id → 文案）。
 * 源头 SKILL.md 多为英文：构建脚本与索引回填都读这里，避免市场卡片出现英文名或空介绍。
 * name 缺省时沿用原有中文标题（CN_TITLES / frontmatter）。
 */
export const ZH_SKILL_TEXT: Record<string, { name?: string; description: string }> = {
  "algorithmic-art": { description: "用 p5.js 创作带随机种子和交互参数的算法艺术。" },
  brainstorming: { description: "动手前先澄清意图与方案，探索需求边界，避免直接开工。" },
  "canvas-design": { description: "用设计方法论生成 .png / .pdf 视觉作品，如海报与插画。" },
  "control-browser": { description: "打开、导航、点击、输入、截图并验证网页与本地 HTTP 页面。" },
  "dynamo-router-starter": {
    name: "Dynamo 路由入门",
    description: "启动或修改 NVIDIA Dynamo 路由模式，并对路由端点做冒烟检查。",
  },
  excalidraw: { description: "生成与编辑 Excalidraw 架构图、流程图，在侧栏与用户共同修改画布。" },
  figma: { description: "通过 Figma MCP 读取设计上下文、截图、变量与素材，并转成生产代码。" },
  "frontend-design": { description: "打造有辨识度、生产级的前端界面，避开通用 AI 审美。" },
  "frontend-skill": {
    description: "构建视觉突出的落地页、网站、应用或游戏 UI，强调克制构图与图像质感。",
  },
  "gc-minimal-zine-poster-v0-1": {
    description: "生成极简 Zine 风格的诗意纸感海报提示词与配套图片。",
  },
  "hyper3d-rodin": {
    description: "用 Hyper3D Rodin 从文本或图片生成 3D 模型，并拆分、跟踪进度、取回结果。",
  },
  "nemoclaw-user-get-started": {
    name: "NemoClaw 上手",
    description: "安装 NemoClaw、启动沙箱并运行第一条 Agent 提示。",
  },
  "photo-card": { description: "把照片拆成多层，制作可交互的 3D 全息收藏卡片。" },
  "ruic-card": {
    description: "根据描述或参考图生成交互式 3D 全息收藏卡网站（分层美术 + Blender/Three.js）。",
  },
  shadcn: { description: "搜索、添加、修复与组合 shadcn/ui 组件，管理项目上下文与文档。" },
  "theme-factory": { description: "为幻灯片、文档、报告、HTML 页面套用 10 套预设主题与风格。" },
  "trae-generate-mini-app": {
    description: "仅在明确要求时生成基于 Taro 的可运行小程序代码（微信/支付宝/抖音等）。",
  },
  "tripo-3d": {
    description: "从文本、参考图或现有网格生成 3D 模型，导出 GLB/FBX/OBJ/STL/USDZ/3MF。",
  },
  uicraft: { description: "创建、审查与打磨生产级网页界面，包括落地页与作品集。" },
  "using-git-worktrees": { description: "为需要隔离的功能开发创建独立 worktree 工作区。" },
  "using-superpowers": { description: "建立查找与调用技能的规范，要求任何回复前先调用 Skill 工具。" },
  visualize: { description: "在对话中直接生成可视化与交互工具，解释机制、探索假设。" },
  "web-design-guidelines": {
    description: "按 Web 界面规范审查 UI 代码，检查可访问性与设计一致性。",
  },
  "web-gui-tester": { description: "用浏览器自动化以纯黑盒方式交互测试 Web 前端。" },
  "whiteboard-design": {
    name: "白板设计",
    description: "规划、创建、编辑、校验并导出自包含的可编辑白板 HTML。",
  },
  "agent-browser": {
    name: "Agent 浏览器",
    description: "面向 AI Agent 的浏览器自动化 CLI：导航、填表、点击、截图等。",
  },
  "agents-sdk": {
    name: "Cloudflare Agent 开发",
    description: "用 Agents SDK 在 Cloudflare Workers 上构建有状态、实时、可调度的 AI Agent。",
  },
  "alipay-payment-integration": {
    description:
      "支付宝开放平台支付接入：当面付、App/JSAPI/网站支付、预授权、商家扣款等全场景选型与集成。",
  },
  anet: {
    description: "通过 AgentNetwork 发现 Agent、用 A2A 派任务、等待结果并结算付费技能。",
  },
  "anet-setup": { description: "检查、安装或更新 anet 命令行，启动本地节点并加入集线器。" },
  "building-mcp-server-on-cloudflare": {
    name: "Cloudflare MCP 服务搭建",
    description: "在 Cloudflare Workers 上构建带工具与 OAuth 的远程 MCP 服务并部署。",
  },
  "byted-bp-cdn-pagesdeploy": {
    description: "一键把静态站点部署到 BytePlus Edge Pages，支持自定义域名绑定。",
  },
  cli: { description: "用阿里云 CLI（aliyun）查询和操作云资源，按产品插件选择命令。" },
  cloudbase: { description: "开发、部署、调试与迁移腾讯云开发（CloudBase）项目。" },
  cloudflare: {
    name: "Cloudflare 平台",
    description: "Cloudflare 全平台：Workers、Pages、KV/D1/R2、Workers AI、网络与安全。",
  },
  codespace: { description: "创建、列出、连接、停止或删除 GitHub Codespaces。" },
  commit: { description: "按约定式提交规范从暂存区生成并创建本地 Git 提交。" },
  "composition-patterns": {
    description: "用组合模式重构组件，避免布尔 prop 膨胀，设计可复用 API。",
  },
  "create-toolset": {
    description: "编写或扩展 Unreal Engine 工具集（注册为 AI 可调用的静态函数）。",
  },
  "developing-mcp-apps": {
    description: "用官方 MCP Apps SDK 开发、迁移、构建与测试 ZCode MCP 应用。",
  },
  "diagnosing-commands": {
    description: "排查 ZCode 自定义斜杠命令（/command）缺失、被覆盖等配置问题。",
  },
  "diagnosing-hooks": { description: "排查 ZCode Hook 不触发、事件名或 matcher 配置错误等问题。" },
  "diagnosing-mcp": { description: "排查 ZCode MCP 服务无法连接、配置错误等问题。" },
  "diagnosing-plugins": { description: "排查 ZCode 插件未列出、市场安装失败等问题。" },
  "diagnosing-skills": { description: "排查 ZCode 技能未被发现、已安装但不触发等问题。" },
  dogfood: { description: "系统性地探索和测试 Web 应用，找出 Bug 与体验问题。" },
  "douyinpay-payment-integration": {
    description: "抖音支付端到端接入：产品选型、服务端 SDK、签名验签与质量校验。",
  },
  "durable-objects": {
    name: "Durable Objects 开发",
    description: "创建和审查 Cloudflare Durable Objects，实现有状态协调与实时协作。",
  },
  electron: { description: "通过 Chrome DevTools 协议自动化 Electron 桌面应用。" },
  "env-setup": { description: "检查并准备 video-agent-kit 所需环境（ffmpeg/ffprobe 与编码器）。" },
  "finishing-a-development-branch": {
    description: "实现完成且测试通过后，指导如何整合并收尾开发分支。",
  },
  "gh-address-comments": {
    description: "处理 GitHub PR 审查反馈：未解决线程、请求修改与行内评论。",
  },
  "gh-cli": { description: "GitHub CLI（gh）完整参考：仓库、Issue、PR、Actions、发布等。" },
  "gh-fix-ci": { description: "调试并修复 GitHub Actions 中失败的 PR 检查。" },
  gist: { description: "创建、查看、编辑或删除 GitHub Gist。" },
  "git-commit": { description: "分析暂存变更并生成约定式提交信息，完成 Git 提交。" },
  github: { name: "GitHub 仓库协作", description: "分诊和处理 GitHub 仓库、PR 与 Issue 相关工作。" },
  glab: { description: "GitLab CLI（glab）操作指南：MR、Issue、CI、发布、成员与项目设置。" },
  "glab-stack": { description: "用 GitLab CLI 管理堆叠 diff 与合并请求。" },
  hyperframes: { description: "在 HyperFrames 中制作视频合成、动画、字幕、配音与转场。" },
  "hyperframes-media": { description: "为 HyperFrames 预处理素材：语音合成、转录与抠背景。" },
  "hyperframes-registry": { description: "安装并接入 HyperFrames 注册表里的区块与组件。" },
  "iga-pages": { description: "把前端或全栈项目部署到 IGA Pages。" },
  issue: { description: "创建、查看、列出或关闭 GitHub Issue，管理标签与里程碑。" },
  "kicad-board": {
    description: "用 KiCad 插件设计双层 PCB：原理、布线、DRC、3D 渲染与 Gerber 导出。",
  },
  "mcp-builder": { description: "指导创建高质量 MCP 服务，为 LLM 提供设计良好的工具接口。" },
  "omniverse-usd-performance-tuning": {
    name: "Omniverse USD 性能优化",
    description: "诊断并优化 USD 场景加载慢、内存高、帧率低的问题。",
  },
  "plugin-creator": {
    description: "创建或更新 ZCode 插件源码与本地测试市场，并引导安装试用。",
  },
  pr: { description: "用 GitHub CLI 创建、列出、检出、审查或合并拉取请求。" },
  "react-best-practices": {
    description: "React / Next.js 性能优化准则（来自 Vercel Engineering）。",
  },
  "react-native-skills": {
    description: "React Native 与 Expo 最佳实践：性能、动画、列表与原生模块。",
  },
  "receiving-code-review": { description: "收到代码审查反馈后，先核实再实施建议。" },
  "redis-development": {
    description: "Redis 性能优化与最佳实践：数据结构、查询引擎与向量检索。",
  },
  release: { description: "创建 GitHub Release 并为版本标签整理变更说明。" },
  repo: { description: "克隆或 fork GitHub 仓库，并打开分支、Issue、设置等资源。" },
  "requesting-code-review": { description: "完成任务或合并前请求代码审查，确认符合需求。" },
  "review-agent": {
    description: "对指定代码变更做只读、缺陷优先的审查并返回可执行问题清单。",
  },
  "sandbox-sdk": {
    name: "沙箱应用开发",
    description: "构建安全的沙箱应用，用于 AI 代码执行、解释器与 CI/CD。",
  },
  secret: { description: "列出、设置、删除或同步 GitHub Actions 仓库密钥（不暴露值）。" },
  "security-best-practices": {
    description: "按语言与框架做安全最佳实践审查并给出改进建议。",
  },
  setup: { description: "检查 GitHub CLI 安装并引导对应主机与账号的登录认证。" },
  "site-deploy": {
    description: "用 ZCode Sites 把演示/原型页面发布上线，生成预览或分享链接。",
  },
  "skill-creator": { description: "创建新技能、编辑现有技能并迭代措辞。" },
  "skill-installer": { description: "从精选列表或 GitHub 仓库安装 Codex 技能到本地。" },
  "systematic-debugging": { description: "遇到 Bug 或异常时，先系统化定位再提出修复。" },
  "trae-code-review": { description: "对 MR/PR、commit、分支或差异做通用代码审查并返回结构化问题。" },
  "trae-debugger": {
    description: "对复杂可复现问题收集运行时证据，形成假设→插桩→修复→验证闭环。",
  },
  "trae-security-review": {
    description: "对代码变更做安全扫描，只报告可证实且由本次变更引入的风险。",
  },
  "tripo-game-asset": {
    description: "用 Tripo 制作可直接进游戏的 3D 资产：低模道具、PBR 主资产与 LOD。",
  },
  "unity-cli": { description: "从命令行控制 Unity 编辑器：编辑场景、资产或运行 C#。" },
  "unity-setup": { description: "安装 Unity CLI 与编辑器，检查环境并解决首次配置/授权问题。" },
  "unreal-mcp": { description: "通过实时编辑器 MCP 连接在 Unreal 项目中查询或修改内容。" },
  "unreal-skill": { description: "编写、编辑或审查 Unreal Engine Agent Skill。" },
  url2video: { description: "录制网页为 WebM，再用 ffmpeg 转成 MP4。" },
  video2code: { description: "根据操作录屏复刻网页的布局、样式、交互与动画。" },
  "video2code-3d": { description: "video2code 的 3D/WebGL 扩展，复刻录屏中的三维场景。" },
  video2fullstack: {
    description: "把操作录屏复刻成包含前端与真实后端的全栈项目。",
  },
  "web-artifacts-builder": {
    description: "用 React、Tailwind、shadcn/ui 构建多组件 HTML Artifact。",
  },
  "web-replicate": {
    description: "用 React + TypeScript + Tailwind + shadcn/ui 构建现代 Web 应用。",
  },
  "webapp-testing": {
    description: "用 Playwright 交互测试本地 Web 应用：验证功能、调试 UI。",
  },
  "workflow-run": { description: "列出、检查、触发、观察或重跑 GitHub Actions 工作流。" },
  yeet: { description: "确认范围、提交、推送并通过 GitHub App 创建草稿 PR。" },
  "zcode-configuration-guide": {
    description: "配置 ZCode 的 MCP、斜杠命令、技能、Hooks、插件与指令文件。",
  },
  "brand-guidelines": { description: "给任何产物套用 Anthropic 官方品牌色与字体规范。" },
  "doc-coauthoring": {
    description: "引导用户按结构化流程共同撰写文档、提案与技术规格。",
  },
  docx: { description: "创建、编辑与分析 Word 文档，支持修订、批注、格式与文本提取。" },
  "docx-viewer": { description: "在文档侧栏查看并讨论 Word（.docx）文件。" },
  "douyin-interact-creation": { description: "制作或升级 interact_creation 离线 H5 互动内容。" },
  "douyin-interactive-content-publish": {
    description: "一键发布互动空间应用：上传 zip 与图标并创建/更新。",
  },
  "dynamic-workflows": { description: "编写、调试或重提 CreateWorkflow 动态工作流脚本。" },
  "executing-plans": { description: "在独立会话中按已写好的实现计划执行，并设置审查检查点。" },
  "html-deck": { description: "生成可自包含、动画丰富的 HTML 幻灯片。" },
  "html-report": {
    description: "生成除幻灯片外的自包含 HTML 交付物：报告、白皮书、仪表盘等。",
  },
  "hyperframes-cli": {
    name: "Hyperframes 命令行",
    description: "Hyperframes CLI 开发循环：脚手架、校验、预览、渲染与排障。",
  },
  imagegen: { description: "生成或编辑位图图像：照片、插画、纹理、精灵图与样机。" },
  "internal-comms": { description: "按公司惯用格式撰写各类内部沟通材料。" },
  office: {
    description: "创建、编辑、检查或转换 Office 文档、表格、演示与 PDF，路由到对应工作流。",
  },
  "office-export-pdf": { description: "用 LibreOffice Kit 把 Office 文档转换为 PDF。" },
  "office-render": { description: "用 LibreOffice Kit 渲染文档图片或检查版面。" },
  "omniverse-realtime-viewer": {
    name: "Omniverse 实时查看器",
    description: "Omniverse Realtime Viewer USD 应用请求的顶层路由与参考文档。",
  },
  "openai-docs": {
    description: "查询 Codex 模型、定价、技能、设置、排障与自动化等官方信息。",
  },
  pdf: { description: "PDF 工具箱：提取文本与表格、创建、合并/拆分、处理表单。" },
  "pdf-viewer": { description: "在 PDF 侧栏查看并讨论 PDF 文件。" },
  pptx: { description: "创建、编辑与分析 PowerPoint 演示文稿。" },
  "pptx-author": { description: "用 python-pptx 在磁盘生成专业 .pptx 演示文稿。" },
  "pptx-viewer": { description: "在演示侧栏查看并讨论 PowerPoint 文件。" },
  "prd-authoring": { description: "把不完整的产品想法补全成可评审的 PRD 与功能规格。" },
  "report-page": { description: "生成有来源支撑的报告、备忘录或数据解读页面。" },
  "report-render": {
    description: "生成支持中日韩排版、图表与引用的分页 PDF/DOCX 研究交付物。",
  },
  "test-driven-development": { description: "实现功能或修复前先写测试，按 TDD 流程推进。" },
  typst: { description: "编写并修复 Typst（.typ）文档，在侧栏实时预览。" },
  "video-edit-agent": { description: "视频剪辑任务的默认入口：发现素材、分类任务并路由。" },
  "video-edit-assembly": {
    description: "多素材视频组装的专用流程：挑选、排序、去重与拼接。",
  },
  "video-recap-workflows": {
    description: "电影解说、足球、电竞与篮球等旁白式混剪工作流。",
  },
  "video-speech-workflows": {
    description: "单素材口播视频：语音压缩、口播字幕与字幕/剪辑编排。",
  },
  "workers-best-practices": {
    name: "Workers 最佳实践",
    description: "按生产最佳实践审查和编写 Cloudflare Workers 代码。",
  },
  "writing-plans": { description: "动手写代码前，把需求整理成多步实现计划。" },
  "writing-skills": { description: "创建、编辑并验证技能的写法与规范。" },
  "xlsx-author": { description: "用 openpyxl 生成专业 .xlsx 工作簿，含公式规范与重算校验。" },
  zotero: { description: "在 Zotero 侧栏搜索论文、逐页阅读 PDF 与高亮笔记。" },
  "audit-xls": { description: "审计表格公式准确性、错误与常见问题（可选范围/单表/整表）。" },
  "jupyter-notebook": { description: "在笔记本侧栏创建、读取、编辑并运行 Jupyter 单元格。" },
  "office-recalculate": { description: "用 LibreOffice Kit 刷新表格公式缓存并校验计算结果。" },
  xlsx: { description: "表格是主要输入或输出时使用：打开、读取、编辑、修复 Excel 文件。" },
  "xlsx-viewer": { description: "在表格侧栏查看并讨论 Excel（.xlsx）工作簿。" },
  "aiq-deploy": {
    name: "AIQ 部署",
    description: "安装、部署、运行、校验与排障 NVIDIA AI-Q Blueprint 基础设施。",
  },
  "aiq-research": {
    name: "AIQ 深度研究",
    description: "通过可访问的 NVIDIA AI-Q Blueprint 后端执行深度研究。",
  },
  "building-ai-agent-on-cloudflare": {
    name: "Cloudflare AI Agent 搭建",
    description: "用 Agents SDK 在 Cloudflare 上构建带状态与实时 WebSocket 的 AI Agent。",
  },
  "cuopt-user-rules": {
    name: "cuOpt 使用规范",
    description: "NVIDIA cuOpt 终端用户规则：路由、LP/MILP/QP、安装与服务。",
  },
  defuddle: { description: "用 Defuddle CLI 从网页提取干净 Markdown，去掉导航与杂乱内容。" },
  "dispatching-parallel-agents": {
    description: "面对 2 个以上互不依赖的任务时并行派发子代理。",
  },
  "dynamo-interconnect-check": {
    name: "Dynamo 互联检查",
    description: "校验 Dynamo 部署的 NIXL/UCX/NCCL 互联是否可用于 RDMA/NVLink。",
  },
  "excalidraw-diagram": {
    description: "从文本生成 Excalidraw 图，支持 Obsidian/标准/动画三种输出。",
  },
  "jev-judgment": {
    description: "Jev 判断工具的调用规范（校验、筛选、检索、排序、分类等）。",
  },
  "json-canvas": { description: "创建和编辑 JSON Canvas（.canvas）节点、连线与分组。" },
  knap: { description: "用 Knap CLI 把模板与结构化数据渲染成笔记。" },
  "libtv-cli": {
    name: "LibTV 命令行",
    description: "用 LibTV 官方 CLI 在命令行操作画布、项目、节点、模型与素材。",
  },
  "mermaid-visualizer": { description: "把文本转成专业 Mermaid 图表，用于演示与文档。" },
  "my-coffee": {
    description: "瑞幸点单：查门店/商品、自提下单、支付码、订单状态与取消。",
  },
  "obsidian-bases": {
    name: "Obsidian 数据库",
    description: "创建和编辑 Obsidian Bases（.base）视图、筛选、公式与汇总。",
  },
  "obsidian-cli": {
    name: "Obsidian 命令行",
    description: "用 Obsidian CLI 读写、搜索和管理笔记、任务与属性。",
  },
  "obsidian-markdown": {
    description: "编写 Obsidian 风格 Markdown：双链、嵌入、标注与属性。",
  },
  "omniverse-cad-to-simready": {
    name: "Omniverse CAD 转仿真",
    description: "协调从 CAD/源资产到 SimReady USD 的端到端工作流。",
  },
  "physical-ai-infrastructure-setup-and-resilient-scaling": {
    name: "物理 AI 基础设施搭建与弹性扩容",
    description: "搭建、扩容、校验与加固 NVIDIA 物理 AI 基础设施（MicroK8s/AKS、OSMO 等）。",
  },
  "research-guide": { description: "检索、调研、对比与写研究报告的方法论与信源规则。" },
  "subagent-driven-development": {
    description: "在当前会话中用子代理并行推进独立的实现任务。",
  },
  "verification-before-completion": {
    description: "声称完成或提交前先运行验证命令并确认结果。",
  },
  wrangler: {
    name: "Wrangler 命令行",
    description: "Cloudflare Workers CLI：部署、开发和管理 Workers、KV、R2、D1 等。",
  },
};
