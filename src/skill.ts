/**
 * The bundled skill that teaches the agent how this plugin is configured.
 * It lives in code (not a SKILL.md asset) so the published `lib/` carries it
 * without a copy step, and so it always matches the installed version.
 */

export const SKILL_NAME = 'cpa-provider-config'

export const SKILL_DESCRIPTION
  = '配置 dsh-cpa-provider（CLIProxyAPI / CPA 模型提供商插件）：添加或修改 CPA 实例、按模型调整思考强度与默认强度、上下文窗口、隐藏模型、开关 Fast、处理带前缀的模型（如 api/gpt-6-luna）。用户提到 CPA、CLIProxyAPI、cpa-<实例> 分组里的模型设置时使用。'

export const SKILL_WHEN_TO_USE
  = '用户想让某些 CPA 模型默认用某个思考强度、只保留部分档位、隐藏/显示模型、开 Fast、加实例或改地址，或者问 CPA 插件该怎么配置时。'

export const SKILL_CONTENT = `# 配置 dsh-cpa-provider

本插件把一个或多个 CLIProxyAPI（CPA）实例注册成模型提供商，路由名 \`cpa-<实例id>\`，模型来自各实例的 \`/v1/models?client_version=dsh\`。你的任务是把用户的自然语言需求变成正确的插件配置，并在用户确认后写入。

## 工作流程（必须按顺序）

1. **先读现状**：调用 \`cpa_config\`，\`action: "read"\`。它返回当前完整配置（YAML）和每个实例的真实模型目录：模型 ID、CPA 提供的档位与默认值、当前生效档位、上下文、输入类型、能否 Fast、命中了哪些规则。**模型 ID 和档位只能从这里取，不要凭记忆猜。**
2. **起草方案**：写出完整的 \`instances\` 和/或 \`models\` 列表（整体替换；不需要改的列表就不传）。尽量少写规则：能用一条通配规则就不要逐个模型写。
3. **预览**：\`action: "preview"\`，带上方案。看返回的错误、提醒和「变化」列表，确认每个模型的结果正是用户要的；有错误或意外变化就修改方案再预览。
4. **向用户说明**：用一两句话告诉用户会改什么（引用预览里的变化），然后 \`action: "apply"\` 带同一个方案。apply 会弹卡片让用户确认，用户同意才写入，立即生效，不需要重启。
5. **不能写入时**（apply 返回没有设置服务、没有界面能确认，或用户想自己改）：把预览返回的完整 YAML 条目给用户，告诉他替换 \`$DSH_HOME/profiles/<profile>/cordis.patch.yml\` 里 \`id: cpa-provider\` 的条目（Web 设置页顶部「打开配置文件」打开的就是这个文件）。dsh 会**整体替换**条目的 \`config\`，所以给出的必须是包含 instances 和 models 的完整条目，不能只给片段。

## 绝对不要

- 不要把 API key 写进任何配置、方案或回复。key 只能由用户用 \`/cpa-key [实例]\` 设置（卡片输入，不进会话日志），或放在环境变量里并用 \`apiKeyEnv\` 指向变量名。用户把 key 发给你时，提醒他改用 /cpa-key，不要复述 key。
- 不要改实例的 \`id\`：它决定路由名和凭据名，已保存的会话引用它。要换地址就改 \`baseURL\`。
- 不要编造档位：\`efforts\` 只能从该模型「CPA 提供的档位」里挑，写了没有的会被忽略。
- 不要直接用文件工具改 cordis.patch.yml，除非用户明确要求；优先用 \`cpa_config\`。

## 配置结构

\`\`\`yaml
- id: cpa-provider
  config:
    instances:
      - id: home                        # 1–32 位小写字母/数字/-/_，路由名 cpa-home
        name: 家用 CPA                   # 模型选择器分组名，默认 "CPA <id>"
        baseURL: http://127.0.0.1:8317  # 推荐只写 host:port；/v1 可有可无；不能带 query、#、账号密码
        apiKeyEnv: MY_KEY               # 可选，凭据名，默认 CPA_<ID>_API_KEY
        fast: [gpt-5.5, api/gpt-6-luna] # 开 Fast 的完整模型 ID（含前缀）
    models:                             # 有序规则，后面的逐字段覆盖前面的
      - match: '/^gpt-/i'
        efforts: [low, medium, xhigh, max]
        defaultEffort: xhigh
      - match: gpt-6-luna
        efforts: [low, max]
        defaultEffort: low
    refreshIntervalMinutes: 10          # 后台刷新间隔，0 关闭
    fetchTimeoutMs: 15000
    showHiddenModels: false             # 显示 CPA 标为隐藏的模型（图片/视频/内部）
\`\`\`

\`cpa_config\` 只写 \`instances\` 和 \`models\`；后三个标量字段需要时让用户手动改，或在给出的完整 YAML 里保留它们。

### 模型规则字段

| 字段 | 含义 |
|---|---|
| \`match\` | 必填。通配符：\`*\` 任意字符、不区分大小写、整串匹配。正则：\`/表达式/flags\`。同时与 \`模型ID\`、\`cpa-<实例>/模型ID\` 比较；带前缀的模型还会用去掉前缀的 ID 比较 |
| \`efforts\` | 可选档位，取值 off、minimal、low、medium、high、xhigh、max，只能收窄 CPA 提供的档位。CPA 的 none = off；ultra 在 dsh 没有对应 |
| \`defaultEffort\` | 切到该模型时预选、且请求没指定时发送的档位；必须在生效档位里 |
| \`contextWindow\` / \`maxTokens\` | token 数；maxTokens 只是信息，请求不带输出上限 |
| \`input\` | \`[text]\` 或 \`[text, image]\` |
| \`hidden\` | true 从列表去掉；false 让目录隐藏的模型显示 |

空数组（\`efforts: []\`）等于没写。通用规则写前面、具体的写后面。

### 匹配范围速查

- \`gpt-6-luna\`：所有实例上的 gpt-6-luna，以及 \`api/gpt-6-luna\`、\`team/gpt-6-luna\` 等前缀版本。
- \`cpa-home/gpt-6-luna\`：只匹配 home 实例上无前缀的那一个（\`/cpa-model\` 写的就是这种）。
- \`cpa-home/*\`：home 实例上的全部模型。
- \`api/*\`：所有实例上前缀为 api 的模型。
- \`gpt-6*\` 或 \`'/^gpt-6/i'\`：以 gpt-6 开头的模型，连同它们的前缀版本（前缀版本去掉前缀后也参与匹配）。
- 只想改无前缀的那个、不动前缀版本：写成 \`cpa-<实例>/模型ID\`，每个实例一条。

### 模型前缀

CPA 给凭据配置 \`prefix\` 后，模型 ID 变成 \`<prefix>/<模型>\`，例如 \`api/gpt-6-luna\`、\`team/gpt-6-luna\`，它们通常走不同的账号或渠道。选择器里显示为 \`team/GPT 6.0 Luna\`。fast 列表和精确规则里要写完整 ID。

### Fast

只有目录里「可 Fast」的模型能开。开了以后该模型的所有请求带 \`service_tier: "priority"\`：Codex 订阅更快、额度消耗更快；官方 API key 按 priority 单价计费。开之前要告诉用户这一点。

## 其他命令（告诉用户可以用）

- \`/cpa\`：菜单和总览；\`/cpa <实例>\` 看模型表。
- \`/cpa-add\`、\`/cpa-remove\`：添加/删除实例（含 key 输入）。
- \`/cpa-key [实例]\`：设置或清除 key。
- \`/cpa-fast\`、\`/cpa-model\`：卡片里开关 Fast、调单个模型的档位。
- \`/cpa-refresh [实例]\`：立即刷新目录（read 显示没有目录或目录过旧时建议用户执行）。

「设置 → 模型」页面不显示 CPA 实例，这是已知限制，用 /cpa 或本工具管理。
`
