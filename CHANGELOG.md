# 更新记录

## 0.3.0

让 dsh 的 Agent 直接帮你配置本插件：

- 内置技能 `cpa-provider-config`：说明配置结构、规则语义、模型前缀、Fast 和禁止事项（不写 key、不改实例 id 等）。用户用自然语言提需求（「所有 GPT 默认 xhigh」「把 grok 都藏起来」「team 前缀的模型开 Fast」）时，Agent 会加载它。
- 新增 Agent 工具 `cpa_config`：
  - `read`：当前配置 YAML，加上每个实例的真实模型目录（模型 ID、CPA 提供的档位和默认值、生效档位、能否 Fast、命中哪些规则）；
  - `preview`：检查方案，列出错误、提醒（档位 CPA 没有、Fast 不支持、规则没匹配到模型等）和逐模型的变化，并给出完整的 `cordis.patch.yml` 条目；
  - `apply`：先弹卡片请你确认，确认后才写入，立即生效。不能弹卡片（headless、ACP）或没有设置服务时不写入，返回完整 YAML 条目，供你手动替换。
- 方案里出现 `apiKey`、`token` 之类的字段会被拒绝；工具的输出里不含 key。

### 模型前缀

支持 CPA 的模型前缀（凭据上配置了 `prefix` 时，模型 ID 形如 `api/gpt-6-luna`）：

- 模型选择器里带前缀的模型显示名也带上前缀，例如 `team/GPT 6.0 Luna`。CPA 会把基础模型的显示名原样复制给每个带前缀的别名，之前 `gpt-6-luna`、`api/gpt-6-luna`、`team/gpt-6-luna` 在选择器里看起来一模一样。
- `models` 规则写基础模型 ID（如 `match: gpt-6-luna`）时，也作用于它带前缀的别名；写成 `cpa-<实例>/<模型>` 的规则（`/cpa-model` 写入的就是这种）仍然只匹配那一个模型。
- 命令参数可以直接写带前缀的模型 ID：`/cpa-fast on api/gpt-6-luna`、`/cpa-model home/team/gpt-6-luna`。之前会把 `api` 当成实例名，报「没有 CPA 实例 api」。
- 新增可选的真实 CPA 端到端测试 `tests/live.e2e.test.ts`，设置 `CPA_LIVE_URL`、`CPA_LIVE_KEY` 时才运行。

## 0.2.0

命令交互整体改版：

- 每个命令都可以不带参数：缺什么就弹出提问卡片问什么（单选、多选或直接输入），参数写法保留为快捷方式。
- `/cpa` 不带参数时弹出操作菜单；`/cpa status` 看总览，`/cpa <实例>` 看模型列表。
- `/cpa-add` 依次询问地址、名称、实例 ID、API key；也支持 `/cpa-add <地址> <名称>`，实例 ID 按地址自动起名。旧写法 `/cpa-add <ID> <地址> [名称]` 仍可用。
- `/cpa-key` 只有一个实例时可以省略实例名；key 也可以在卡片里输入，不会记进会话日志。
- `/cpa-fast` 不带参数时列出所有可开 Fast 的模型，勾选即切换；当前会话的模型排在最前。
- 新增 `/cpa-model`：用卡片设置单个模型的可选思考强度和默认强度，写入一条只匹配该模型的规则，可一键恢复默认。
- `/cpa-remove` 不带参数时让你选择实例并确认。
- 所有结果的第一行都是一句话总结（dsh Web 默认只显示第一行）。
- 实例添加成功但 key 保存失败时，结果会说明实例已添加，并提示怎么重试。
- README 增加「Web 使用须知」。

## 0.1.0

首个版本：按 CPA 目录自动注册模型、多实例、模型规则、按模型 Fast、凭据存储、`/cpa*` 命令。
