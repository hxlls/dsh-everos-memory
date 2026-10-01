# 使用说明

这份文档面向**使用者**：装好之后你该怎么用它、它在你说话时做了什么、以及出问题怎么查。
只想安装的话看 [README](README.md)。

## 1. 先确认它活了

安装后**重启一次 DeepSeek Harness**，然后任选一种确认：

- 侧边栏 **Plugins** 页面里出现「EverOS 记忆」这一项；
- 直接对 Agent 说一句：**「EverOS 现在正常吗？」**

Agent 会调用 `everos_health`，正常时你会看到类似：

```
EverOS http://192.168.1.35:8000 — 在线，版本 1.4.1，能力：llm, embed, rerank, multimodal_llm, parser
```

如果 Agent 回「unknown tool」之类，说明 profile 还没重新组合 —— 重启。

## 2. 最重要的观念：你不用手动调用工具

插件注册了 5 个工具，并额外注入了一段系统提示。所以**你正常说话就行**，Agent 会自己判断：

- 当你透露值得长期保留的稳定事实时 → 它调 `everos_add_memories` 写入；
- 当问题涉及你的身份、偏好、历史决定、过往对话时 → 它先调 `everos_search_memories` 检索，再回答；
- 检索不到时它应该直说「没有相关记忆」，而不是编。

你也可以显式点名，比如「用 EverOS 查一下我的偏好」。

## 3. 可以直接照抄的说法

### 让它记住

> 记住：我这边所有项目都用 pnpm，别用 npm。

> 记一下：部署环境是内网 192.168.1.0/24，没有外网。

写入的消息先**累积**在会话里，EverOS 之后异步抽取成长期记忆。想让它**立刻**能检索到，加一句：

> 顺便立刻抽取一下。

（对应 `everos_flush_memory`。）

### 让它回忆

> 我之前说过包管理器用什么吗？

> 你还记得我的部署环境有什么限制吗？

> 翻一下我们之前关于 EverOS 的讨论。

Agent 会做语义检索，命中的内容按 `episode`（事件）/ `profile`（画像）等类型带分数、时间、来源会话列出来。

### 看它到底记了什么（画像）

> 帮我看看 EverOS 里对我的长期画像记了些什么。

对应 `everos_get_memories` + `memory_type: profile`。想看原始事件就换成 `episode`。

### 排错

> EverOS 连得上吗？版本多少？

> 查不到记忆，帮我看下怎么回事。

## 4. 五个工具分别什么时候会被用到

| 工具 | 你什么时候会看到它 | 对应你的说法 |
|---|---|---|
| `everos_health` | 确认服务在线、版本、能力 | 「EverOS 正常吗」 |
| `everos_add_memories` | 你说了值得长期记住的事 | 「记住…」 |
| `everos_flush_memory` | 刚写完、想马上能搜到 | 「立刻抽取一下」 |
| `everos_search_memories` | 问题涉及你的偏好/历史 | 「我之前说过…吗」 |
| `everos_get_memories` | 想按类型翻看已有记忆 | 「看看你对我的画像」 |

## 5. 记忆是怎么归类的（这决定你搜不搜得到）

写入和检索都带一组身份字段，默认值来自插件配置：

| 字段 | 默认 | 作用 |
|---|---|---|
| `user_id` | `dsh-user` | **记忆归属者**。检索时按它过滤，换了它之前写的就搜不到。 |
| `agent_id` | 空 | 另一种归属者；与 `user_id` **只会送出一个**，给了 `agent_id` 就优先用它。 |
| `session_id` | `dsh-session` | 只用于**写入**（`add` / `flush`）把消息分组；检索**不按会话过滤**。 |
| `app_id` / `project_id` | 空 | 服务端分区用，非空才会发送。 |

两个要点：

1. **检索是用户级、不是会话级**。只要 `user_id` 一致，在任何新会话里都能搜到以前的记忆。
2. **改 `userId` 等于换了一个人**。旧记忆不会消失，但不会再被默认检索命中 —— 除非检索时显式指定旧的 `user_id`。

## 6. 调配置

配置在 profile 的 `cordis.patch.yml` 里按 `id: everos-memory` 覆盖。**覆盖会替换整份 `config`**，所以要把想保留的字段一起写上：

```yaml
- id: everos-memory
  name: '@local/dsh-everos-memory'
  config:
    baseUrl: 'http://192.168.1.35:8000'
    userId: 'hxlls'              # 换成你自己的归属者
    defaultSessionId: 'dsh-session'
    defaultMethod: 'hybrid'
    searchTopK: 10
    includeProfile: true
    enableHealth: true
    enableWrite: true            # false = 只读，不写任何记忆
    enableSearch: true
    enableGet: true
    promptGuidance: true
    requestTimeoutMs: 15000
    toolTimeoutMs: 30000
```

常见几种调法：

- **换台 EverOS**：改 `baseUrl`。
- **换成只读**：`enableWrite: false`，Agent 就没有写入/抽取工具了。
- **想少占提示词**：`promptGuidance: false` 关掉那段系统提示（工具还在，只是不再主动提示它去检索）。
- **想每次检索多拿几条**：调大 `searchTopK`。
- **服务慢**：调大 `requestTimeoutMs`。

改完 profile 补丁会触发热重载，但**外部改文件一般仍建议重启**一次最稳。

## 7. 排查手册

| 现象 | 原因 / 处理 |
|---|---|
| Agent 说 unknown tool | profile 没重新组合 → 重启 Harness。 |
| 刚让它记住，马上搜却搜不到 | 抽取是**异步**的。先让它 `flush`，再等几秒重试。 |
| 一直搜不到以前记的事 | 多半是 `user_id` 变了。确认写入时和检索时用的是同一个归属者。 |
| 连接失败 / 超时 | 让它调 `everos_health`；确认 `baseUrl` 写对、那台机器在网、端口 8000 通。 |
| 检索结果里 profile 是空的 | OSS 版不一定产出 profile，可能只有 episode（事件）+ 原子事实。空是正常的。 |
| 想删掉某条记忆 | **自托管 OSS 版没有删除接口**（delete 是 Cloud-only），只能去服务端自己清库。 |

## 8. 数据落在哪

记忆全部写在**你自己的 EverOS 服务器**上（默认 `http://192.168.1.35:8000`），不经过任何第三方。
插件本身不落盘、不缓存，只在你要的时候发 HTTP 请求。

## 9. 关掉 / 卸载

```powershell
# 临时停用（保留依赖，改回 true 即可恢复）
# 在 profile 的 cordis.patch.yml 里：
# - id: everos-memory
#   disabled: true

# 完全卸载
dsh plugin --profile desktop remove @local/dsh-everos-memory
```

卸载后同样需要重启一次 Harness。
