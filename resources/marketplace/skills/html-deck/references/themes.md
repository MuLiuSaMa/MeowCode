# Themes catalog

Every theme is a short CSS file in `assets/themes/` that overrides tokens
defined in `assets/base.css`. Switch themes by changing the `href` of
`<link id="theme-link">` or by pressing **T** if the deck has a
`data-themes="a,b,c"` attribute on `<body>` or `<html>`.

All themes define the same variables: `--bg`, `--bg-soft`, `--surface`,
`--surface-2`, `--border`, `--text-1/2/3`, `--accent`, `--accent-2/3`,
`--good`, `--warn`, `--bad`, `--grad`, `--grad-soft`, `--radius*`, `--shadow*`,
`--font-sans`, `--font-display`.

## Light & calm

| name | description | when to use |
|---|---|---|
| `minimal-white` | 极简白，克制高级。Inter，强文字层级，极低阴影。 | 内部汇报、一对一技术评审、不抢内容的严肃话题 |
| `editorial-serif` | 杂志风 Playfair 衬线 + 奶油底。 | 品牌故事、文字密度大的长文演讲 |
| `soft-pastel` | 柔和马卡龙三色渐变。 | 产品发布、面向消费者、轻松话题 |
| `xiaohongshu-white` | 小红书白底 + 暖红 accent + 衬线标题。 | 小红书图文、生活/美学类内容 |
| `solarized-light` | 经典低眩光配色。 | 长时间观看的工作坊、教学 |
| `catppuccin-latte` | catppuccin 浅色。 | 开发者、极客友好的技术分享 |

## Bold & statement

| name | description | when to use |
|---|---|---|
| `sharp-mono` | 纯黑白 + Archivo Black + 硬阴影。 | 宣言类、极具冲击力的视觉 |
| `neo-brutalism` | 厚描边、硬阴影、明黄 accent。 | 创业路演、敢说敢做的调性 |
| `bauhaus` | 几何 + 红黄蓝原色。 | 设计 talk、艺术史/产品美学主题 |
| `swiss-grid` | 瑞士网格 + Helvetica 感 + 12 栏底纹。 | 严肃排版、设计行业 |
| `memphis-pop` | 孟菲斯波普背景点 + 大字标题。 | 年轻、潮流、品牌合作 |

## Cool & dark

| name | description | when to use |
|---|---|---|
| `catppuccin-mocha` | catppuccin 深。 | 开发者内部分享、长时间观看 |
| `dracula` | 经典 Dracula 紫红主色。 | 代码密集的技术分享 |
| `tokyo-night` | Tokyo Night 蓝夜。 | 偏冷技术分享、基础设施 |
| `nord` | 北欧清冷蓝白。 | 基础设施、云产品 |
| `gruvbox-dark` | 温暖复古深色。 | Terminal / vim / *nix 社群 |
| `rose-pine` | 玫瑰松，柔和暗色。 | 设计+开发交界、审美向技术 |
| `arctic-cool` | 蓝/青/石板灰 浅色版。 | 商业分析、金融、冷静理性 |

## Warm & vibrant

| name | description | when to use |
|---|---|---|
| `sunset-warm` | 橘 / 珊瑚 / 琥珀三色渐变。 | 生活方式、奖项颁发、情绪正向 |

## Effect-heavy

| name | description | when to use |
|---|---|---|
| `glassmorphism` | 毛玻璃 + 多色光斑背景。 | Apple 式发布会、产品特性展示 |
| `aurora` | 极光渐变 + blur + saturate。 | 封面 / CTA / 结语页 |
| `rainbow-gradient` | 白底 + 彩虹流动渐变 accent。 | 欢乐向、节日、庆祝页 |
| `blueprint` | 蓝图工程 + 网格底纹 + 蒙太奇字体。 | 系统架构、工程蓝图 |
| `terminal-green` | 绿屏终端 + 等宽 + 发光文字。 | CLI/black-hat/复古朋克 |

## v2 additions

### Light & professional

| name | description | when to use |
|---|---|---|
| `corporate-clean` | 纯白 + 海军蓝 accent + Inter + 保守边框。 | 董事会汇报、B2B 销售、金融保险 |
| `pitch-deck-vc` | YC 风白底 + 蓝紫渐变 accent + 大留白。 | 融资路演、种子轮、VC meeting |
| `academic-paper` | 论文白 + 衬线正文 + 黑墨 + 蓝链接。 | 学术报告、研究分享、会议论文 |
| `japanese-minimal` | 象牙白 + 朱红 accent + 极大留白 + Noto Serif。 | 品牌升级、匠人故事、禅意叙事 |
| `engineering-whiteprint` | 白底 + 坐标纸网格 + 海军墨线 + 等宽字。 | 系统设计、API 文档、架构白皮书 |

### Bold & editorial

| name | description | when to use |
|---|---|---|
| `magazine-bold` | 奶油底 + 超大 Playfair 衬线 + 橙色 spot。 | 专栏文章、封面故事、品牌月刊 |
| `news-broadcast` | 白底 + 红色竖条 + Oswald 大写 + 硬阴影。 | 突发新闻、发布通稿、数据播报 |
| `midcentury` | 奶油底 + 芥末/青/焦橙 + 锐利几何。 | 设计史、家居美学、复古品牌 |
| `retro-tv` | 暖奶油 + CRT 扫描线 + 琥珀橙 accent。 | 怀旧叙事、八零九零年代主题 |

### Effect-heavy / dramatic

| name | description | when to use |
|---|---|---|
| `cyberpunk-neon` | 纯黑 + 霓虹粉青黄 + 发光 + JetBrains Mono。 | 黑客、地下文化、赛博 talk |
| `vaporwave` | 深紫 + 粉红青蓝渐变 + 晕染光斑。 | 音乐、潮流艺术、A E S T H E T I C |
| `y2k-chrome` | 银铬渐变 + 彩虹 accent + 大圆角 + Space Grotesk。 | 千禧怀旧、时尚品牌、Gen-Z |

## v3 additions — from ui-ux-pro-max palette

### Light & professional

| name | description | when to use |
|---|---|---|
| `trust-blue` | 信任蓝 + 橙色 CTA，Poppins + Open Sans。 | SaaS 产品介绍、B2B 方案、通用商务 |
| `navy-formal` | 海军蓝深色 accent + Lexend 无衬线。 | 企业内训、管理培训、制度宣讲 |
| `clean-teal` | 清新青绿 + Figtree 圆润无衬线。 | 医疗健康、环保报告、清新话题 |
| `scholar-teal` | 学者青 + 橙色 accent + Crimson Pro 衬线。 | 在线教育、课程教学、培训讲座 |

### Bold & editorial

| name | description | when to use |
|---|---|---|
| `crimson-gold` | 赤红 + 金色渐变，EB Garamond 衬线，零圆角。 | 党建汇报、红色主题、庄重场合（浅底） |
| `alert-crimson` | 警示红 + 蓝色双 accent + Lexend 粗标题。 | 安全培训、合规宣讲、应急演练 |
| `fuchsia-cyan` | 品红 + 青色双色，Syne + Manrope。 | 创意提案、品牌发布、时尚话题 |
| `luxury-noir` | 黑金奢品，Cormorant 衬线 + Montserrat，零圆角。 | 高端品牌、奢侈品发布、颁奖典礼 |

### Cool & dark

| name | description | when to use |
|---|---|---|
| `crimson-night` | 深色红金 + 径向辉光 + Lexend 无衬线。 | 党建汇报（深底庄重版）、红色文化 |
| `ledger-dark` | 暗色账簿绿 + IBM Plex Sans/Mono。 | 金融数据、交易看板、数据密集 |
| `amber-purple` | 琥珀金 + 紫色，Orbitron + Exo 2 科技感。 | 加密/Web3、前沿科技、黑客松 |
| `cinema-dark` | 纯黑 + 红色 accent + Bebas Neue 大写。 | 影视发布、娱乐行业、沉浸式叙事 |
| `indigo-code` | 靛蓝 + 橙色 + JetBrains Mono 等宽。 | 技术分享、编程培训、代码 walkthrough |

### Warm & nature

| name | description | when to use |
|---|---|---|
| `warm-cafe` | 暖棕 + 奶油白，Playfair Display SC 衬线。 | 餐饮、生活方式、文化沙龙 |
| `forest-gold` | 森林绿 + 丰收金，Lora 衬线 + Raleway。 | 自然生态、农业、可持续发展 |
| `indigo-mint` | 靛蓝 + 薄荷绿，Space Grotesk + DM Sans。 | 科技创企、产品路演、创新话题 |

## How to apply

```html
<link rel="stylesheet" id="theme-link" href="../assets/themes/aurora.css">
```

Or enable `T`-cycling by listing themes on the body:

```html
<body data-themes="minimal-white,aurora,catppuccin-mocha" data-theme-base="../assets/themes/">
```

## How to extend

Copy an existing theme, rename it, and override only the variables you want to
change. Keep each theme under ~200 lines. Prefer adjusting tokens to adding
new selectors.
