# AGENTS.md

本文件适用于 `dsh-cpa-provider` 整个项目。

## 项目定位

DeepSeek Harness（dsh）的 Cordis 插件：把一个或多个 CLIProxyAPI（CPA）实例注册成 provider 路由 `cpa-<id>`，模型目录来自 CPA 的 `/v1/models?client_version=dsh`，再按有序的 `models` 规则调整，支持按模型开关 Fast（`service_tier: priority`）。

开始修改前阅读 `README.md`。涉及 dsh 接口时，核对 `devDependencies` 里固定的 dsh 版本的类型声明和官方源码（`github.com/deepseek-ai/deepseek-harness`，对应 `dsh-vX.Y.Z` tag），不凭记忆猜接口。

## 目录与职责

- `src/index.ts`：插件入口。读取 volatile 配置、注册适配器、监听 `loader/volatile-update` 和凭据变更、定时刷新、注册斜杠命令。
- `src/config.ts`：Schemastery 配置 schema、类型、路由名与凭据名规则。
- `src/endpoints.ts`：CPA 地址归一化。
- `src/catalog.ts`：获取并解析 CPA 目录，磁盘缓存。
- `src/rules.ts`：规则匹配与合并，计算每个模型的最终设置。
- `src/provider.ts`：生成 pi-ai `Model` 和 `Provider`；Fast 在这里通过 `onPayload` 注入。
- `src/runtime.ts`：实例状态、刷新、失败隔离；把「配置 + 目录」变成 `PiAiAdapter` 读取的 profile map（按修订号缓存）。
- `src/adapter.ts`：`PiAiAdapter` 子类，补上按模型的 `defaultEffort`，首次使用时等待目录。
- `src/ask.ts`：提问卡片（`ctx.userQuestions`）的封装：`AskUnavailable`（界面不能弹卡片）与 `AskCancelled`（用户关掉卡片）。
- `src/commands.ts`：`/cpa*` 命令，通过 `CommandHost` 访问配置和凭据，通过 `Ask` 弹卡片，便于测试。
- `src/assistant.ts`：给 Agent 用的配置助手（纯函数）：读取现状与目录、预览方案（schema、错误、提醒、逐模型变化）、生成完整的 `cordis.patch.yml` 条目。
- `src/tool.ts`：`cpa_config` 工具（read / preview / apply）。apply 必须先用卡片请用户确认；不能确认或不能写入时只返回 YAML。
- `src/skill.ts`：内置技能 `cpa-provider-config` 的正文。改配置语义、命令或字段时同步更新它。
- `tests/`：单元测试；`commands.test.ts` 用脚本化的卡片回答驱动命令；`plugin.e2e.test.ts` 在真实 Cordis + dsh-llm 运行时里对接模拟 CPA 服务。

## 必须保持的行为

1. **密钥隔离**：key 只来自 dsh 凭据存储或同名环境变量；不写进配置、缓存或日志。`/cpa-key` 保持 `recordInput: false`。pi-ai 集合使用空凭据存储和空 ambient 上下文，不能让无关的环境变量 key 发到 CPA。
2. **失败隔离**：一个实例 URL 错误、缺 key 或刷新失败，不影响其他实例；刷新失败保留上一次成功的目录。
3. **规则语义**：按列表顺序合并，后者逐字段覆盖；空数组等于未设置；思考档位只能收窄 CPA 提供的档位；CPA `none` ↔ dsh `off`。
4. **Fast**：只对目录列出 `priority` 档位、且在实例 `fast` 列表里的模型生效；只加 `service_tier`，并让调用方已有的 `onPayload` 保留最终决定权。
5. **复用 dsh 请求链路**：消息转换、工具、图片、回放交给 `PiAiAdapter`，不要自己实现传输。profile 对象里保留新版本 dsh 需要的前向兼容字段。
6. **热更新**：配置字段都是 volatile；未变化的输入不重建 profile map，变化后通过 `registration.replace()` 通知模型选择器刷新。
7. **命令交互**：每个命令不带参数也能用，缺的信息用卡片问；不能弹卡片的界面回退到用法说明，参数写法保持兼容。结果第一行必须是一句话总结（dsh Web 只显示第一行）。命令结果文字会写进会话日志，绝不能包含 key。
8. **Agent 配置助手**：`cpa_config` 只写 `instances` 和 `models`，不读写 key，方案里带疑似密钥字段一律拒绝；apply 写入前必须经过用户卡片确认；输出不得包含 key。

## 修改与交付

- 代码风格：单引号、无分号、两空格缩进；保持 `erasableSyntaxOnly`（测试直接用 Node 24 的类型剥离运行），相对导入写 `.ts` 后缀。
- 修缺陷要加回归测试；改配置语义要覆盖解析和合并；改请求行为要在 e2e 测试里断言请求体。
- 用户可见行为变化时同步更新 `README.md`、`CHANGELOG.md` 和 `examples/`，发布前改 `package.json` 版本号。用户文档用中文。
- 交付前运行 `pnpm check`（需要 Node 24），涉及打包时再跑 `pnpm build`。不提交 `lib/`、`node_modules/`、凭据或本机路径。
