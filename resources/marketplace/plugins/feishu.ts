/**
 * 飞书插件（配合市场里的「飞书」MCP——飞书官方托管远程 MCP，OAuth 登录）
 *
 * 每个技能全文内嵌在本文件里：安装后输入 /feishu-im、/feishu-doc、/feishu-base、
 * /feishu-calendar、/feishu-task <需求>，命令会把对应技能准则和需求一起交给模型，
 * 引导它调用飞书 MCP 工具完成操作。
 *
 * 能力边界（2026-11 实测）：「飞书」MCP（mcp__feishu__*，官方 OAuth）覆盖云文档场景
 * （搜索/创建/更新文档、评论）与消息读取（群搜索、群成员、消息列表）；发消息、多维表格、
 * 日历、任务等写操作不在其中——有需要时经「手动添加」配置自建应用的 lark-mcp
 * （npx -y @larksuiteoapi/lark-mcp，APP_ID/APP_SECRET 环境变量传凭据）即可获得全量能力。
 */
import type { PluginFactory } from "meowcode";

/** 全部技能共用的前置说明与排错指引 */
const FEISHU_COMMON = `## 前置条件与能力边界

- 需要已安装市场里的「飞书」MCP（官方托管，OAuth 登录）：装上后在 MCP 行点「授权」，浏览器登录飞书账号即可。
- 工具前缀 \`mcp__feishu__*\`，覆盖：云文档搜索/创建/更新/评论/列表、取文件、搜索用户、搜索群、读群成员与群消息、已读状态。
- **暂不覆盖**：发送消息、群管理写操作、多维表格、日历日程、任务待办（这些需要自建应用 + lark-mcp，可用「手动添加 MCP」自行配置）。
- MeowCode 工具量大时部分工具会延迟加载（deferred）：动手前先 tool_search 关键词（"doc"、"search"、"im"、"message"）唤起工具；工具名以 tool_search 实际返回为准（官方端点在演进）。
- 工具缺失或用户需求超出上述能力时，如实说明当前 MCP 不支持该操作，不要编造工具。

## 常见问题

- 授权失败/令牌失效：回市场 MCP 行重新点「授权」。
- 看不到预期的文档/群：OAuth 以登录用户身份只访问用户可见的数据；让用户确认数据是否在自己的飞书账号里可见。`;

const FEISHU_IM_SKILL = `${FEISHU_COMMON}

# 飞书消息技能（IM，读取）

目标：搜索群聊、获取群成员、读取与检索消息。

## 操作步骤

1. **找群**：用群搜索工具按群名关键词找 chat_id；把候选群列给用户确认（找不到就如实说明哪些群可见）。
2. **读消息**：按 chat_id 拉取消息列表/话题；把毫秒时间戳换算成人类可读时间（用户时区）再汇报，重要消息给原文引用。
3. **搜消息**：全局消息检索按关键词过滤，返回时附来源群与时间。

## 边界

- 当前 MCP 只有读取能力：**发消息、建群、拉人等写操作不支持**——用户要发送时，如实告知并把要发的内容整理好，引导用户去飞书手动发送（或自行配置自建应用的 lark-mcp 获得发送能力）。
- 只能看到登录用户可见的群与消息。`;

const FEISHU_DOC_SKILL = `${FEISHU_COMMON}

# 飞书文档技能（云文档 / 知识库）

目标：搜索、创建、更新云文档，读取正文，管理评论。

## 操作步骤

1. **找文档**：按标题关键词搜索；把候选（标题 + 链接 + 更新时间）列给用户。
2. **读内容**：按 document_id/wiki token 读正文；长文档会截断，超出时如实告知并给出链接。
3. **新建/更新文档**：按用户给的主题/要点组织内容后创建或更新；完成后把链接给用户，内容结构（标题/列表/引用）尽量保留。
4. **评论**：按需增删评论；评论对象与内容先跟用户确认。

## 边界

- OAuth 以登录用户身份访问：用户看不到的文档也搜不到（不是权限 bug）。
- 工具返回的 document 链接要原样给用户，不要自行拼接。`;

const FEISHU_BASE_SKILL = `${FEISHU_COMMON}

# 飞书多维表格技能（Bitable）

⚠️ **当前「飞书」MCP（官方 OAuth 版）暂不覆盖多维表格工具**——本技能目前不可用。

用户提出表格相关需求时：如实说明当前 MCP 不含多维表格能力，引导两条路：
1. 用「手动添加 MCP」配置自建应用的 lark-mcp（npx -y @larksuiteoapi/lark-mcp，App ID/Secret 走 APP_ID/APP_SECRET 环境变量），即可获得 bitable_v1_* 全套工具（建表/建视图字段/记录增查改）；
2. 或暂时在飞书里手动操作。
不要尝试调用不存在的工具。`;

const FEISHU_CALENDAR_SKILL = `${FEISHU_COMMON}

# 飞书日历技能（Calendar）

⚠️ **当前「飞书」MCP（官方 OAuth 版）暂不覆盖日历工具**——本技能目前不可用。

用户提出日程相关需求时：如实说明当前 MCP 不含日历能力，引导用户：
1. 用「手动添加 MCP」配置自建应用的 lark-mcp（calendar_v4_* 工具：日历列表、日程创建/查询）；
2. 或暂时在飞书里手动安排日程。
不要尝试调用不存在的工具。`;

const FEISHU_TASK_SKILL = `${FEISHU_COMMON}

# 飞书任务技能（Tasks）

⚠️ **当前「飞书」MCP（官方 OAuth 版）暂不覆盖任务工具**——本技能目前不可用。

用户提出任务相关需求时：如实说明当前 MCP 不含任务能力，引导用户：
1. 用「手动添加 MCP」配置自建应用的 lark-mcp（task_v2_* 工具：任务创建/查询）；
2. 或暂时在飞书里手动创建任务。
不要尝试调用不存在的工具。`;

const COMMANDS: Array<{ name: string; description: string; skill: string; fallback: string }> = [
  {
    name: "feishu-im",
    description: "飞书消息技能：搜群、读群成员与消息（配合飞书 MCP）",
    skill: FEISHU_IM_SKILL,
    fallback: "用户没有附带具体需求，先问清楚要查哪个群、看什么内容。",
  },
  {
    name: "feishu-doc",
    description: "飞书文档技能：搜索/创建/更新云文档（配合飞书 MCP）",
    skill: FEISHU_DOC_SKILL,
    fallback: "用户没有附带具体需求，先问清楚要找哪篇文档、读什么或写什么。",
  },
  {
    name: "feishu-base",
    description: "飞书多维表格技能（需自建应用 lark-mcp，官方 OAuth 版暂不支持）",
    skill: FEISHU_BASE_SKILL,
    fallback: "用户没有附带具体需求，先说明当前能力边界，再问清楚要对哪个多维表格做什么。",
  },
  {
    name: "feishu-calendar",
    description: "飞书日历技能（需自建应用 lark-mcp，官方 OAuth 版暂不支持）",
    skill: FEISHU_CALENDAR_SKILL,
    fallback: "用户没有附带具体需求，先说明当前能力边界，再问清楚日程的时间与主题。",
  },
  {
    name: "feishu-task",
    description: "飞书任务技能（需自建应用 lark-mcp，官方 OAuth 版暂不支持）",
    skill: FEISHU_TASK_SKILL,
    fallback: "用户没有附带具体需求，先说明当前能力边界，再问清楚任务内容与截止时间。",
  },
];

const factory: PluginFactory = (api) => {
  for (const command of COMMANDS) {
    api.registerCommand({
      name: command.name,
      description: command.description,
      run: (args) => {
        const brief = args.trim();
        return [
          `使用飞书技能（${command.name}）完成下面的任务：先按技能要求确认工具可用性（tool_search 唤起被延迟的工具），再逐步执行；超出能力的部分如实说明，不要编造工具。`,
          brief ? `本次需求：${brief}` : command.fallback,
          "",
          `--- ${command.name} 技能全文 ---`,
          command.skill,
        ].join("\n");
      },
    });
  }
  api.logger.info("feishu loaded（/feishu-im /feishu-doc /feishu-base /feishu-calendar /feishu-task 命令）");
};

export default factory;
