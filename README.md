# dsh-cpa-provider

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh，0.2.1-rc.5+）通过一个或多个 **CLIProxyAPI（CPA）** 实例提供模型。

- **自动获取模型**：每个实例从自己的 `/v1/models?client_version=dsh` 拿到完整目录，包括每个模型的思考档位、默认档位、上下文窗口、输入类型和是否支持 Fast。不用再手动一个个添加模型、填写说明。
- **多实例**：每个 CPA 是一个独立 provider，路由名 `cpa-<id>`，在模型选择器里各自一组。
- **模型规则**：用通配符或正则批量调整可选思考强度、默认思考强度、上下文窗口等，后面的规则覆盖前面的。
- **按模型 Fast**：给单个模型开关 Fast（`service_tier: priority`），随时切换，下一次请求生效。
- **密钥只存一份**：key 存在 dsh 的凭据存储（`$DSH_HOME/.credentials.yaml`）里，或从环境变量读取；配置文件和缓存里都没有 key。

请求走 CPA 的 OpenAI Responses 接口（`/v1/responses`），消息转换、工具调用、图片、回放都直接复用 dsh 自带的 pi-ai 适配器，跟 dsh 内置 provider 的行为一致。

## 安装

需要 dsh 0.2.1-rc.5+（Node 24.9+）和可用的 CPA 实例。

```bash
dsh plugin --profile web add @lumintian/dsh-cpa-provider
```

升级到最新版用同一条命令，加上 `@latest`：

```bash
dsh plugin --profile web add @lumintian/dsh-cpa-provider@latest
```

`--profile` 写你启动 dsh 时用的 profile。dsh 的每种界面默认用各自的 profile：`dsh web` 用 `web`，`dsh headless` 用 `headless`，`dsh acp` 用 `acp`。每个 profile 都要单独安装本插件、单独配置。

## 快速开始（Web）

在输入框里输入 `/cpa`，**先按 Esc 关掉命令菜单再回车**（原因见下文「Web 使用须知」），会弹出操作菜单：

1. 选「添加实例」，依次填地址、名称、实例 ID、API key；
2. 打开输入框右下角的模型选择器，会多出你刚起名的那一组，选一个模型；
3. 发一句话（比如「你好」）开始对话。

之后随时输入 `/cpa` 打开菜单，开关 Fast、设置模型思考强度、刷新目录都在里面。

每个命令都可以不带参数，缺什么就弹出卡片问什么；熟悉之后也可以一次写全，例如 `/cpa-add http://127.0.0.1:8317 家用 CPA`。

## Web 使用须知

这几条是 dsh Web 界面本身的行为，插件这边改变不了：

- **还没聊过天的新会话里，命令结果不显示。** 命令其实已经执行了，弹出的提问卡片也照常显示，只是最后的结果文字要等会话里有了第一条消息才会出现（之前的结果会一起补上）。所以执行完 `/cpa-add` 后，直接去模型选择器看有没有新分组就行。
- **输入命令后直接回车，会选中命令菜单里高亮的那一项。** 比如输入 `/cpa` 时菜单默认高亮的是 `cpa-add`，回车就变成了 `/cpa-add`。想执行自己输入的内容，先按 Esc 关掉菜单再回车；或者用方向键在菜单里选。
- **命令结果默认只显示第一行**，点一下这一行可以展开看全部内容。本插件所有结果的第一行都是一句话总结。
- **只有一道题的卡片，选完要点「提交」**；多道题的卡片，单选题选完会自动跳到下一题。卡片里输入的内容不会记进会话日志，但输入时屏幕上是明文。
- 卡片等待回答时如果关掉或刷新页面，这次命令会被取消，不会做任何修改。

## 命令

只有交互界面（Web、CLI）能用斜杠命令。ACP、headless、SDK 请直接编辑配置文件（见下文），key 用环境变量提供。在不能弹出卡片的界面里，命令需要把参数写全。

| 命令 | 不带参数时 | 带参数的写法 |
|---|---|---|
| `/cpa` | 弹出操作菜单 | `/cpa status` 看总览；`/cpa <实例>` 看该实例每个模型的档位、默认值、上下文 |
| `/cpa-add` | 依次询问地址、名称、实例 ID、API key | `/cpa-add <地址> <名称>` 直接添加，实例 ID 按地址自动起名（本机地址是 `local`）；只写地址会再问名称、ID 和 key；旧写法 `/cpa-add <ID> <地址> [名称]` 仍可用 |
| `/cpa-key` | 选择实例（只有一个时跳过），再输入 key | `/cpa-key [实例] <key>`；`/cpa-key <实例> --clear` 清除 |
| `/cpa-fast` | 列出所有可开 Fast 的模型，勾选的会切换开关；当前会话的模型排在最前 | `/cpa-fast on\|off [实例/模型]`；不写模型时作用于当前会话的模型；`/cpa-fast status` 列出已开启的 |
| `/cpa-model` | 选择模型，再勾选可选思考强度、选择默认强度 | `/cpa-model <实例/模型>` 直接进入后两步 |
| `/cpa-refresh` | 刷新全部实例的目录 | `/cpa-refresh <实例>` |
| `/cpa-remove` | 选择实例并确认 | `/cpa-remove <实例>`（不再确认） |

`/cpa-model` 会在 `models` 规则列表末尾写一条只匹配该实例该模型的规则（`match: cpa-<实例>/<模型>`），所以它优先于你写的通配规则；选「恢复默认」会删掉这条规则。

会改配置的命令会写入 profile 的 `cordis.patch.yml`，效果和手工编辑一样。

## 配置

配置写在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，条目 id 是 `cpa-provider`。Web 设置页顶部的「打开配置文件」打开的就是这个文件。改完保存即生效，不需要重启。完整示例见 [examples/cordis.patch.yml](./examples/cordis.patch.yml)：

```yaml
- id: cpa-provider
  config:
    instances:
      - id: home                       # provider 路由名为 cpa-home
        name: 家用 CPA                  # 模型选择器里的分组名
        baseURL: http://127.0.0.1:8317 # 推荐只写 host:port，/v1 可写可不写
        fast: [gpt-5.5]                # 开启 Fast 的模型
      - id: backup
        baseURL: https://cpa.example.com
        apiKeyEnv: MY_BACKUP_KEY       # 可选，默认 CPA_BACKUP_API_KEY
    models:
      # 所有 GPT 模型：只保留 low / medium / xhigh / max，默认 xhigh
      - match: '/^gpt-/i'
        efforts: [low, medium, xhigh, max]
        defaultEffort: xhigh
      # GPT-6-Luna 更具体：只要 low 和 max，默认 low
      - match: gpt-6-luna
        efforts: [low, max]
        defaultEffort: low
```

注意：dsh 的 patch 会**整体替换**条目的 `config`，所以要把 `instances` 和 `models` 写在同一个条目里。

### 实例字段

| 字段 | 说明 |
|---|---|
| `id` | 1–32 位小写字母、数字、`-`、`_`。决定路由名 `cpa-<id>` 和默认凭据名，已保存的会话会引用它，建好后别改 |
| `name` | 分组显示名，默认 `CPA <id>` |
| `baseURL` | CPA 地址；`/v1`、`/backend-api` 后缀和路径前缀都能识别，不能带 query、fragment 或账号密码 |
| `apiKeyEnv` | 存 key 的凭据名，默认 `CPA_<ID>_API_KEY`。按 dsh 的规则，先查凭据存储，再查同名环境变量 |
| `fast` | 开启 Fast 的模型 ID 列表 |

### 模型规则

`models` 是一个有序列表。对每个模型，所有匹配的规则从上到下依次生效，后面规则里写了的字段覆盖前面的。所以通用规则写在前面，具体的写在后面。

| 字段 | 说明 |
|---|---|
| `match` | 必填。通配符：`*` 匹配任意字符，不区分大小写，要整串匹配，例如 `gpt-*`、`gpt-6-luna`。正则：写成 `/表达式/标志`，例如 `/^gpt-/i`。同时用 `模型ID` 和 `cpa-<实例>/模型ID` 去匹配，所以 `cpa-backup/*` 只作用于一个实例 |
| `efforts` | 可选的思考强度：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。**只能从 CPA 为该模型提供的档位里挑**，写了 CPA 没有的档位会被忽略，并在 `/cpa` 里提示 |
| `defaultEffort` | 切换到该模型时预选的强度，也是请求没指定强度时发送的强度。不写或不可选时，用 CPA 目录给的默认值 |
| `contextWindow` | 上下文窗口（token）。默认用 CPA 目录的 `context_window` |
| `maxTokens` | 最大输出（token），只作为模型信息。请求里不带输出上限，由 CPA 和上游决定 |
| `input` | `[text]` 或 `[text, image]`，默认按目录 |
| `hidden` | `true` 把模型从列表里去掉；`false` 让目录里隐藏的模型显示出来 |

列表留空（`efforts: []`）等于没写。CPA 的 `none` 对应 dsh 的 `off`。`ultra` 在 dsh 里没有对应档位，不会出现。

### 其他字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `refreshIntervalMinutes` | `10` | 后台刷新目录的间隔，`0` 关闭定时刷新 |
| `fetchTimeoutMs` | `15000` | 获取目录的超时 |
| `showHiddenModels` | `false` | 显示 CPA 标为隐藏的模型（图片、视频和内部模型） |

## Fast 怎么工作

开了 Fast 的模型，请求体里会多一个 `service_tier: "priority"` 字段，其余内容不变。CPA 会把它交给上游：

- **Codex 订阅（OAuth 登录）**：走 Codex 的 Fast 档，速度更快，额度消耗也更快；
- **codex 提供商下添加的官方 API key**：OpenAI 的 Priority processing，**按 priority 单价计费**（比标准价贵）。

同一个模型背后如果挂了多个账号，CPA 每次请求选哪个账号就按那个账号的方式计费。

只有 CPA 目录里列出 `priority` 档位的模型才能开 Fast。CPA 只给全部渠道都是 codex（订阅或 codex 下的官方 key）的模型列这个档位；同一个模型如果还挂了别的渠道（比如 `openai-compatibility`），目录就不列，也就开不了。开了 Fast 的模型在选择器里名字后面带「· Fast」。

## 文件

```text
$DSH_HOME/profiles/<profile>/cordis.patch.yml   # 本插件的配置（id: cpa-provider）
$DSH_HOME/.credentials.yaml                      # dsh 凭据存储，key 存在这里
$DSH_HOME/cache/dsh-cpa-provider/<id>.json       # 每个实例的目录快照（不含 key，权限 600）
```

`$DSH_HOME` 默认是 `~/.dsh`。

## 行为细节

- **启动**：有缓存的实例直接用缓存，缓存超过 5 分钟才在后台刷新。没有缓存时，第一次用到该实例（列模型或发请求）会先等首次获取完成，最多等 `fetchTimeoutMs`。所以 headless 首次运行也不会因为目录还没到而失败。获取失败后 30 秒内不会因为用到它而再次自动获取，避免 CPA 连不上时每次刷新模型列表都要等超时；`/cpa-refresh` 可以随时手动刷新。
- **刷新失败**：保留上一次成功的目录，错误显示在 `/cpa`。上游成功返回后以新目录为准，消失的模型不再保留。
- **改配置**：实例、规则、Fast 都是热更新的，模型选择器会自动刷新。
- **key 变更**：通过 `/cpa-key` 或 dsh 其他界面更新凭据后，对应实例会自动重新获取目录。

## 限制

- 「设置 → 模型」页面不显示 CPA 实例，请用 `/cpa` 菜单或配置文件管理。如果你只配置了 CPA、没有其他 API key，Web 端的首次引导可能仍会提示登录 DeepSeek 账号。
- Fast 作用于该模型的所有请求，包括 dsh 自己发起的辅助请求（例如生成会话标题）。
- 插件复用 `@deepseek-ai/dsh-llm-pi-ai` 导出的 `PiAiAdapter`。dsh 还在 developer preview 阶段，大版本升级时可能需要跟着调整；已在 0.2.1-rc.5 和 0.2.2-rc.1 上测试。
- 只走 `/v1/responses`，不支持 Chat Completions 或 Codex WebSocket 传输。

## 开发

```bash
pnpm install
pnpm check   # tsc + node --test（需要 Node 24）
pnpm build   # 输出到 lib/
```

发布新版本：先改 `package.json` 的 `version`，并在 [CHANGELOG.md](./CHANGELOG.md) 写清改动，然后运行 `pnpm publish`。发布前会自动跑 `pnpm check` 并构建 `lib/`。

`tests/plugin.e2e.test.ts` 会在真实的 Cordis + dsh LLM 运行时里挂载插件，连到一个模拟的 CPA HTTP 服务，验证目录、规则、默认强度、请求体里的 Fast 和热更新。
