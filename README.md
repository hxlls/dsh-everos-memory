# dsh-everos-memory

把一台自托管 [EverOS](https://docs.evermind.ai)（Memory API v2）接入 **DeepSeek Harness**：Agent 可以写入长期记忆、按语义检索、按类型拉取，并检查服务健康。

这是一个 DSH **bundle** 包：`package.json` 声明了 `dsh.bundle.patch`，安装后由 `cordis.patch.yml` 插入一个 Host 插件行，改动对该 profile 的所有会话生效。

仓库：<https://github.com/hxlls/dsh-everos-memory>（公开，匿名可下载）

## 一条命令安装

把命令里的 `desktop` 换成目标 profile。**装完需要重启一次 Harness**，profile 才会重新组合。

```powershell
# 1) 从 GitHub 源码安装 —— 需要本机有 Git（pnpm 用 git 拉取）
dsh plugin --profile desktop add https://github.com/hxlls/dsh-everos-memory.git

# 2) 从 Release 的 tarball 直链安装 —— 不需要 Git，匿名可下载
dsh plugin --profile desktop add https://github.com/hxlls/dsh-everos-memory/releases/download/v1.0.0/dsh-everos-memory-1.0.0.tgz

# 3) 从本地目录安装 —— 开发时最常用，装成 link，改代码即生效
dsh plugin --profile desktop add C:\path\to\dsh-everos-memory
```

`dsh plugin add` 会做三件事：在 profile 里执行 `pnpm add`、把包名追加进 `package.json` 的 `dsh.profile.bundles`、由 loader 校验能否加载。卸载用 `dsh plugin --profile desktop remove @local/dsh-everos-memory`。

### 别用 `github:owner/repo` 简写

npm/pnpm 会把 `github:owner/repo` 解析成 **SSH** 地址（`git+ssh://git@github.com/...`），公开仓库用它会因为缺少 SSH key 而失败。要匿名安装就写完整的 **HTTPS** 地址，也就是上面方式 1 那种 `https://github.com/…/….git`。

### 找不到 `dsh` 命令时

桌面版默认不把 `dsh` 放进 PATH，可以直接调用安装目录里的启动器（注意 `DeepSeek Harness` 中间有空格，路径要加引号）：

```powershell
& "G:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add https://github.com/hxlls/dsh-everos-memory.git
```

### 没有 Git 时

方式 1 由 pnpm 调用 `git` 拉取，DSH 也会先用 `git ls-remote` 预检，所以需要装 Git：

```powershell
winget install --id Git.Git -e
```

不想装 Git 就用方式 2（tarball 直链），pnpm 直接走 HTTPS，**完全不需要 Git**；本地已有打包好的 tgz 时也可以直接 `dsh plugin add <本地 tgz 路径>`。

### 在对话里让它装

直接在对话里说一句：

> 帮我装一下 https://github.com/hxlls/dsh-everos-memory.git

Agent 会调用 `dsh plugin --profile desktop add <spec>`（会请你批准一次越权写入，因为要写 profile 目录）。如果这个 profile 启用了 `plugin_manager` 工具，也可以让它走官方的 `install_bundle`。

## 配置

默认值写在 bundle 自己的 `cordis.patch.yml` 里；要改就在 profile 的 `cordis.patch.yml` 覆盖（**覆盖会替换整份 `config`**，所以要么写全，要么只写想改的那份完整配置）：

```yaml
- id: everos-memory
  name: '@local/dsh-everos-memory'
  config:
    baseUrl: 'http://192.168.1.35:8000'
    userId: 'dsh-user'
    defaultSessionId: 'dsh-session'
```

| 字段 | 默认值 | 作用 |
|---|---|---|
| `baseUrl` | `http://192.168.1.35:8000` | EverOS 服务地址。 |
| `userId` | `dsh-user` | 默认记忆归属者，作为 `user_id` 发送。 |
| `agentId` | `''` | 非空时可用作归属者（以 `agent_id` 发送）；与 `userId` 只会发送一个。 |
| `appId` / `projectId` | `''` | 非空时随请求发送，用于服务端分区。 |
| `defaultSessionId` | `dsh-session` | `add` / `flush` 未显式给 `session_id` 时使用。 |
| `defaultMethod` | `hybrid` | `search` 的默认检索方式。 |
| `searchTopK` | `10` | `search` 默认返回条数。 |
| `includeProfile` | `true` | `search` 默认是否带上 profile 记忆。 |
| `enableHealth` / `enableWrite` / `enableSearch` / `enableGet` | `true` | 分别控制四类工具是否注册。 |
| `promptGuidance` | `true` | 是否注册系统提示段落。 |
| `requestTimeoutMs` | `15000` | 单次 HTTP 请求超时。 |
| `toolTimeoutMs` | `30000` | 工具调用的协作式超时预算。 |

## 注册的工具

| 工具 | 调用 | 说明 |
|---|---|---|
| `everos_health` | `GET /health` | 服务是否在线、版本、已启用能力。 |
| `everos_add_memories` | `POST /api/v2/memory/add` | 把一组 `{role, content}` 消息写入会话。 |
| `everos_flush_memory` | `POST /api/v2/memory/flush` | 强制立即抽取，让刚写入的内容可被检索。 |
| `everos_search_memories` | `POST /api/v2/memory/search` | 语义检索（`keyword` / `vector` / `hybrid` / `agentic`）。 |
| `everos_get_memories` | `POST /api/v2/memory/get` | 按 `episode` / `profile` / `agent_case` / `agent_skill` 拉取。 |

另外注册一段系统提示（order `6000`），提醒模型在回答涉及用户身份、偏好、历史决定的问题前先检索，并且只使用真正检索到的内容。

## EverOS 接口约定（实测）

- 成功：HTTP 200，payload 包在 `data` 里，例如 `{"data":{"message_count":1,"status":"accumulated"}}`。
- 失败：`{"request_id":"…","error":{"code":"INVALID_INPUT","message":"…"}}`，配 4xx/5xx；插件把 `error.message` 直接变成工具错误。
- `add` 的每条消息 **`sender_id` / `role` / `content` / `timestamp` 四个字段全必填**；后两个由插件自动补齐，`sender_id` 有配置兜底。
- `search` 要求 `user_id` 与 `agent_id` **恰好给一个**。
- `get` / `search` **拒绝 `session_id`**（多余字段直接 422），所以插件只在 `add` / `flush` 上发送会话。
- `get` 的 `memory_type` 只接受 `episode` / `profile` / `agent_case` / `agent_skill`。
- 记忆抽取是异步的：`add` 之后立刻 `get` 可能查不到，必要时先 `flush` 再稍等。
- 自托管 OSS 版没有删除接口（delete 是 Cloud-only）。

## 给维护者：为什么 `peerDependencies` 是 optional

`index.js` 从 `@deepseek-ai/dsh-tools` 和 `@deepseek-ai/schemastery` 引入，但这两个包由 DSH 安装自带，**不能**从 npm 装：npm 上的 `@deepseek-ai/dsh-tools` 只有 `0.0.1-rc.1`，和运行时的 `0.2.0-rc.2` 不是一回事。

- DSH 的模块解析对**链接目录**（`link:` / 本地路径安装）依赖 profile 包的 `peerDependencies` **名字**来把 `@deepseek-ai/*` 路由到运行时表；名字不声明，`import` 会解析失败。
- 同时不能声明成必装 peer，否则 pnpm 在物理安装（GitHub / tarball）时会去 registry 抓一个不存在或错误版本的副本而失败。

所以两个 peer 都写进 `peerDependencies`（满足解析路由与版本兼容性校验），再用 `peerDependenciesMeta.*.optional = true` 让 pnpm 永不尝试安装它们。

## 发新版本

仓库根目录就是包根目录，所以源码方式可以直接装。发新版时改 `package.json` 的 `version`，提交后打 tag 并附上打包产物：

```powershell
pnpm pack                                  # 生成 dsh-everos-memory-<version>.tgz
git add -A; git commit -m "chore: release v<version>"; git push
# 再到 GitHub Releases 建一个 v<version> 的 release，把 tgz 作为附件传上去
```

Release 附件的直链形如 `https://github.com/hxlls/dsh-everos-memory/releases/download/v<version>/dsh-everos-memory-<version>.tgz`，安装命令里的 URL 要跟着改。

## 许可

MIT
