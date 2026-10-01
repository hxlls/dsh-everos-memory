/**
 * EverOS memory bundle: exposes a self-hosted EverOS Memory API (v2) to Agents.
 *
 * The service is a FastAPI app (uvicorn) whose `/health` reports its version and
 * capabilities. Everything else lives under `/api/v2/memory/*`:
 *
 *   POST /api/v2/memory/add    {session_id, messages[], user_id?|agent_id?, app_id?, project_id?}
 *   POST /api/v2/memory/flush  {session_id}
 *   POST /api/v2/memory/get    {memory_type, user_id?|agent_id?, session_id?, ...}
 *   POST /api/v2/memory/search {query, user_id XOR agent_id, method?, top_k?, include_profile?}
 *
 * Successful replies wrap their payload in `data`; failures use
 * `{request_id, error: {code, message}}` with a 4xx/5xx status.
 *
 * @module @local/dsh-everos-memory
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'everos-memory'

/** Services this plugin registers into. */
export const inject = ['tools', 'systemPrompt']

/** Values accepted by EverOS `/api/v2/memory/get`. */
const MEMORY_TYPES = ['episode', 'profile', 'agent_case', 'agent_skill']

/** Values accepted by EverOS `/api/v2/memory/search`. */
const SEARCH_METHODS = ['keyword', 'vector', 'hybrid', 'agentic']

export const Config = z.object({
  baseUrl: z.string().default('http://192.168.1.35:8000'),
  userId: z.string().default('dsh-user'),
  agentId: z.string().default(''),
  appId: z.string().default(''),
  projectId: z.string().default(''),
  defaultSessionId: z.string().default('dsh-session'),
  defaultMethod: z.string().default('hybrid'),
  searchTopK: z.number().default(10),
  includeProfile: z.boolean().default(true),
  enableHealth: z.boolean().default(true),
  enableWrite: z.boolean().default(true),
  enableSearch: z.boolean().default(true),
  enableGet: z.boolean().default(true),
  promptGuidance: z.boolean().default(true),
  requestTimeoutMs: z.number().default(15000),
  toolTimeoutMs: z.number().default(30000),
})

/** Trimmed string, or `''` for anything that is not a usable string. */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** The configured service origin without a trailing slash. */
function origin(config) {
  const value = text(config.baseUrl).replace(/\/+$/u, '')
  if (value.length === 0) throw new Error('everos-memory: baseUrl is not configured')
  return value
}

/** First non-empty string among `keys`. */
function pick(source, keys) {
  for (const key of keys) {
    const value = text(source?.[key])
    if (value.length > 0) return value
  }
  return undefined
}

/** Session-scoped fields for `add` / `flush`; empty values are omitted, never sent as `''`. */
function sessionScope(config, args = {}) {
  const sessionId = text(args.session_id) || text(config.defaultSessionId)
  return {
    ...sessionId.length > 0 ? { session_id: sessionId } : {},
    ...partition(config),
  }
}

/**
 * Partition fields for `get` / `search`. Those two reject `session_id` as an
 * extra input, so a session never travels with a read.
 */
function partition(config) {
  const appId = text(config.appId)
  const projectId = text(config.projectId)
  return {
    ...appId.length > 0 ? { app_id: appId } : {},
    ...projectId.length > 0 ? { project_id: projectId } : {},
  }
}

/**
 * The memory owner for a read. EverOS requires exactly one of `user_id` /
 * `agent_id`, so an explicit tool argument wins over the configured default and
 * only one of the two is ever sent.
 */
function owner(config, args = {}) {
  const explicitAgent = text(args.agent_id)
  if (explicitAgent.length > 0) return { agent_id: explicitAgent }
  const explicitUser = text(args.user_id)
  if (explicitUser.length > 0) return { user_id: explicitUser }
  const configuredUser = text(config.userId)
  if (configuredUser.length > 0) return { user_id: configuredUser }
  const configuredAgent = text(config.agentId)
  if (configuredAgent.length > 0) return { agent_id: configuredAgent }
  throw new Error('everos-memory: no memory owner; set userId or agentId in the plugin config, or pass user_id/agent_id')
}

/** The owner when one is configured, without failing a write that has none. */
function optionalOwner(config, args = {}) {
  try {
    return owner(config, args)
  } catch {
    return {}
  }
}

/**
 * Call one EverOS endpoint and return its `data` payload.
 *
 * @param config - resolved plugin config.
 * @param path - endpoint path beginning with `/`.
 * @param body - JSON body, or `undefined` for a GET.
 * @param signal - the tool call's cancellation signal.
 * @param method - HTTP method.
 */
async function request(config, path, body, signal, method = 'POST') {
  const url = `${origin(config)}${path}`
  const budget = Math.max(1, Math.trunc(config.requestTimeoutMs))
  const timeout = AbortSignal.timeout(budget)
  let response
  try {
    response = await fetch(url, {
      method,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
  } catch (error) {
    if (signal?.aborted) throw new Error(`EverOS ${method} ${path} was cancelled`)
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`EverOS ${method} ${path} timed out after ${budget} ms (${url})`)
    }
    throw new Error(`EverOS ${method} ${path} could not be reached at ${url}: ${error?.message ?? String(error)}`)
  }
  const raw = await response.text()
  let payload
  try {
    payload = raw.length === 0 ? undefined : JSON.parse(raw)
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.detail ?? raw.slice(0, 300)
    throw new Error(`EverOS ${method} ${path} failed with HTTP ${response.status}: ${typeof detail === 'string' && detail.length > 0 ? detail : 'no error body'}`)
  }
  if (payload === undefined) throw new Error(`EverOS ${method} ${path} returned a body that is not JSON`)
  if (payload?.error !== undefined) {
    throw new Error(`EverOS ${method} ${path} reported ${payload.error?.code ?? 'an error'}: ${payload.error?.message ?? 'no message'}`)
  }
  return payload?.data ?? payload
}

/**
 * Project one raw EverOS record into the flat, bounded shape the tools declare.
 * Every EverOS memory family carries its own field names, so the projection
 * falls back to a JSON rendering instead of dropping an unfamiliar record.
 */
function project(kind, record) {
  if (typeof record !== 'object' || record === null) return { kind, content: String(record) }
  const id = pick(record, ['id', 'memory_id'])
  const title = pick(record, ['subject', 'title', 'name', 'task', 'intent', 'category', 'attribute'])
  // A profile keeps its payload under `profile_data`: a summary plus the
  // explicit facts and implicit traits the extractor derived, so it is worth
  // unpacking rather than rendering the raw document.
  const profileData = typeof record.profile_data === 'object' && record.profile_data !== null ? record.profile_data : undefined
  const summary = pick(record, ['summary', 'description']) ?? (profileData === undefined ? undefined : pick(profileData, ['summary']))
  const content = pick(record, kind === 'episode'
    ? ['episode', 'summary', 'content', 'text']
    : ['content', 'profile', 'value', 'text', 'episode', 'summary', 'description'])
    ?? (profileData === undefined ? undefined : pick(profileData, ['summary']))
    ?? JSON.stringify(record)
  const facts = Array.isArray(record.atomic_facts)
    ? record.atomic_facts
      .map((fact) => (typeof fact === 'string' ? fact : text(fact?.content)))
      .filter((fact) => fact.length > 0)
    : []
  if (profileData !== undefined) {
    for (const item of Array.isArray(profileData.explicit_info) ? profileData.explicit_info : []) {
      const line = [text(item?.category), text(item?.description)].filter((part) => part.length > 0).join(': ')
      if (line.length > 0) facts.push(line)
    }
    for (const item of Array.isArray(profileData.implicit_traits) ? profileData.implicit_traits : []) {
      const line = [text(item?.trait), text(item?.description)].filter((part) => part.length > 0).join(': ')
      if (line.length > 0) facts.push(line)
    }
  }
  const timestamp = pick(record, ['timestamp', 'create_time', 'created_at'])
  const sessionId = pick(record, ['session_id'])
  return {
    kind,
    ...id === undefined ? {} : { id },
    ...title === undefined ? {} : { title },
    content,
    ...summary === undefined ? {} : { summary },
    ...typeof record.score === 'number' ? { score: record.score } : {},
    ...timestamp === undefined ? {} : { timestamp },
    ...sessionId === undefined ? {} : { session_id: sessionId },
    ...facts.length === 0 ? {} : { facts },
  }
}

/** Flatten a `/get` or `/search` payload into one ordered record list. */
function collect(data) {
  const groups = [
    ['episode', data?.episodes],
    ['profile', data?.profiles],
    ['agent_case', data?.agent_cases],
    ['agent_skill', data?.agent_skills],
  ]
  const items = []
  for (const [kind, records] of groups) {
    if (!Array.isArray(records)) continue
    for (const record of records) items.push(project(kind, record))
  }
  return items
}

/** One record as model-facing markdown. */
function renderRecord(item) {
  const head = [item.kind, item.title ?? item.id].filter((part) => typeof part === 'string' && part.length > 0).join(' · ')
  const meta = [
    item.score === undefined ? undefined : `score ${item.score.toFixed(3)}`,
    item.timestamp,
    item.session_id === undefined ? undefined : `session ${item.session_id}`,
  ].filter((part) => typeof part === 'string' && part.length > 0)
  const lines = [`- **${head}**${meta.length === 0 ? '' : ` (${meta.join(', ')})`}`, `  ${item.content.replace(/\s*\n\s*/gu, ' ')}`]
  if (Array.isArray(item.facts) && item.facts.length > 0) {
    for (const fact of item.facts) lines.push(`  - ${fact}`)
  }
  return lines.join('\n')
}

/** A record list as model-facing text with an explicit empty answer. */
function renderRecords(intro, items) {
  if (items.length === 0) return `${intro}\n\n没有命中任何记忆。`
  return `${intro}\n\n共 ${items.length} 条：\n${items.map(renderRecord).join('\n')}`
}

/** Shared output schema for the two read tools. */
const RECORD_LIST_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          id: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string', required: true },
          summary: { type: 'string' },
          score: { type: 'number' },
          timestamp: { type: 'string' },
          session_id: { type: 'string' },
          facts: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

function registerHealth(ctx, config, timeoutMs) {
  ctx.tools.register(defineTool({
    name: 'everos_health',
    description: '检查 EverOS 记忆服务是否在线，并返回服务版本与已启用的能力（llm / embed / rerank / multimodal_llm / parser）。连接失败或怀疑服务异常时先调用它。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          baseUrl: { type: 'string', required: true },
          status: { type: 'string' },
          version: { type: 'string' },
          capabilities: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `EverOS ${value.baseUrl} — ${value.ok ? '在线' : `异常（status=${value.status ?? 'unknown'}）`}`
          + `${value.version === undefined ? '' : `，版本 ${value.version}`}`
          + `${Array.isArray(value.capabilities) && value.capabilities.length > 0 ? `，能力：${value.capabilities.join(', ')}` : ''}`,
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const baseUrl = origin(config)
      const data = await request(config, '/health', undefined, exec.signal, 'GET')
      const status = text(data?.status)
      const capabilities = Object.entries(data?.capabilities ?? {})
        .filter(([, enabled]) => enabled === true)
        .map(([capability]) => capability)
      return {
        ok: status === 'ok',
        baseUrl,
        ...status.length === 0 ? {} : { status },
        ...text(data?.version).length === 0 ? {} : { version: text(data.version) },
        ...capabilities.length === 0 ? {} : { capabilities },
      }
    },
  }))
}

function registerWriteTools(ctx, config, timeoutMs) {
  ctx.tools.register(defineTool({
    name: 'everos_add_memories',
    description: '把一段对话消息写入 EverOS 的指定会话（POST /api/v2/memory/add）。消息先累积，之后由 EverOS 抽取为长期记忆（episode / profile 等）。当用户透露了值得长期保留的稳定事实（身份、偏好、长期目标、重要决定）时用它。',
    parameters: {
      messages: {
        type: 'array',
        required: true,
        description: '按时间顺序排列的消息；每条必须有 role 和 content，sender_id 与 timestamp 缺省时自动补齐。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            role: { type: 'string', required: true, description: "消息角色，例如 'user' 或 'assistant'。EverOS 要求该字段。" },
            content: { type: 'string', required: true, description: '消息正文。EverOS 要求该字段。' },
            sender_id: { type: 'string', description: '发送者 id；缺省时使用插件配置的 userId 或 agentId。EverOS 要求该字段非空。' },
            timestamp: { type: 'integer', description: 'Unix 秒级时间戳；缺省时用当前时间。EverOS 要求该字段。' },
          },
        },
      },
      session_id: { type: 'string', description: '会话 id；缺省时使用插件配置的 defaultSessionId。' },
      user_id: { type: 'string', description: '记忆归属的用户 id；缺省时使用插件配置的 userId。' },
      agent_id: { type: 'string', description: '记忆归属的 Agent id；给了它就只发 agent_id，不会同时发 user_id。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          messageCount: { type: 'integer', required: true },
          status: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已向 EverOS 会话 ${value.sessionId} 写入 ${value.messageCount} 条消息`
          + `${value.status === undefined ? '' : `（状态 ${value.status}）`}。记忆抽取可能异步完成，需要立即检索时先调用 everos_flush_memory。`,
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const messages = args.messages.map((message) => {
        const senderId = text(message.sender_id) || text(config.userId) || text(config.agentId)
        if (senderId.length === 0) {
          throw new Error('everos-memory: every message needs a sender_id; set userId in the plugin config or pass sender_id')
        }
        return {
          sender_id: senderId,
          role: message.role,
          timestamp: message.timestamp === undefined ? Math.floor(Date.now() / 1000) : message.timestamp,
          content: message.content,
        }
      })
      const scoped = sessionScope(config, args)
      if (scoped.session_id === undefined) throw new Error('everos-memory: no session id; set defaultSessionId in the plugin config or pass session_id')
      const body = { ...scoped, ...optionalOwner(config, args), messages }
      const data = await request(config, '/api/v2/memory/add', body, exec.signal)
      return {
        sessionId: scoped.session_id,
        messageCount: typeof data?.message_count === 'number' ? data.message_count : messages.length,
        ...text(data?.status).length === 0 ? {} : { status: text(data.status) },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'everos_flush_memory',
    description: '强制 EverOS 立即抽取指定会话中累积的消息，生成长期记忆（POST /api/v2/memory/flush）。写入后想马上检索到，就先调用它。',
    parameters: {
      session_id: { type: 'string', description: '会话 id；缺省时使用插件配置的 defaultSessionId。' },
      user_id: { type: 'string', description: '记忆归属的用户 id；缺省时使用插件配置的 userId。' },
      agent_id: { type: 'string', description: '记忆归属的 Agent id；给了它就只发 agent_id。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          status: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `EverOS 会话 ${value.sessionId} 抽取状态：${value.status ?? 'unknown'}` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const scoped = sessionScope(config, args)
      if (scoped.session_id === undefined) throw new Error('everos-memory: no session id; set defaultSessionId in the plugin config or pass session_id')
      const data = await request(config, '/api/v2/memory/flush', { ...scoped, ...optionalOwner(config, args) }, exec.signal)
      return {
        sessionId: scoped.session_id,
        ...text(data?.status).length === 0 ? {} : { status: text(data.status) },
      }
    },
  }))
}

function registerSearchTool(ctx, config, timeoutMs) {
  ctx.tools.register(defineTool({
    name: 'everos_search_memories',
    description: '在 EverOS 中长期记忆里做语义检索（POST /api/v2/memory/search）。回答涉及用户偏好、身份、历史决定或过往对话的问题前，先用它查一查，并只使用真正检索到的内容。',
    parameters: {
      query: { type: 'string', required: true, description: '检索问题或关键词，用自然语言描述想找的内容。' },
      method: { type: 'string', enum: SEARCH_METHODS, description: '检索方式；缺省使用插件配置的 defaultMethod（默认 hybrid）。' },
      top_k: { type: 'number', description: '返回条数上限；缺省使用插件配置的 searchTopK（默认 10）。' },
      include_profile: { type: 'boolean', description: '是否同时返回 profile 类记忆；缺省使用插件配置的 includeProfile。' },
      user_id: { type: 'string', description: '记忆归属的用户 id；缺省时使用插件配置的 userId。' },
      agent_id: { type: 'string', description: '记忆归属的 Agent id；给了它就只查 agent_id。' },
    },
    output: {
      schema: {
        ...RECORD_LIST_OUTPUT,
        properties: {
          ...RECORD_LIST_OUTPUT.properties,
          query: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderRecords(`EverOS 检索「${value.query}」的结果：`, value.items),
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const topK = args.top_k === undefined ? Math.trunc(config.searchTopK) : Math.trunc(args.top_k)
      if (!Number.isFinite(topK) || topK < 1) throw new Error('everos-memory: top_k must be a positive number')
      const method = text(args.method) || text(config.defaultMethod)
      const includeProfile = args.include_profile === undefined ? config.includeProfile : args.include_profile
      const body = {
        query: args.query,
        ...method.length === 0 ? {} : { method },
        top_k: topK,
        include_profile: includeProfile === true,
        ...partition(config),
        ...owner(config, args),
      }
      const data = await request(config, '/api/v2/memory/search', body, exec.signal)
      return { query: args.query, items: collect(data) }
    },
  }))
}

function registerGetTool(ctx, config, timeoutMs) {
  ctx.tools.register(defineTool({
    name: 'everos_get_memories',
    description: '按类型直接拉取 EverOS 记忆，不做语义检索（POST /api/v2/memory/get）。想按主题找内容时优先用 everos_search_memories。',
    parameters: {
      memory_type: { type: 'string', required: true, enum: MEMORY_TYPES, description: '记忆类型：episode（事件）、profile（画像）、agent_case、agent_skill。' },
      user_id: { type: 'string', description: '记忆归属的用户 id；缺省时使用插件配置的 userId。' },
      agent_id: { type: 'string', description: '记忆归属的 Agent id；给了它就只查 agent_id。' },
    },
    output: {
      schema: {
        ...RECORD_LIST_OUTPUT,
        properties: {
          ...RECORD_LIST_OUTPUT.properties,
          memoryType: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderRecords(`EverOS 中类型为 ${value.memoryType} 的记忆：`, value.items),
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const data = await request(config, '/api/v2/memory/get', {
        memory_type: args.memory_type,
        ...partition(config),
        ...optionalOwner(config, args),
      }, exec.signal)
      return { memoryType: args.memory_type, items: collect(data) }
    },
  }))
}

/**
 * Register the configured EverOS tools and their prompt guidance. Every
 * registration is effect-scoped, so disposing the plugin unregisters them.
 */
export function apply(ctx, config) {
  const timeoutMs = Math.max(1, Math.trunc(config.toolTimeoutMs))
  if (config.enableHealth) registerHealth(ctx, config, timeoutMs)
  if (config.enableWrite) registerWriteTools(ctx, config, timeoutMs)
  if (config.enableSearch) registerSearchTool(ctx, config, timeoutMs)
  if (config.enableGet) registerGetTool(ctx, config, timeoutMs)
  if (!config.promptGuidance) return
  const base = text(config.baseUrl)
  if (base.length === 0) return
  ctx.systemPrompt.section({
    name: 'tool:everos',
    order: 6000,
    text: ({ scope: agentScope }) => ctx.tools.get('everos_search_memories', agentScope) === undefined
      && ctx.tools.get('everos_add_memories', agentScope) === undefined
      ? ''
      : `你接入了 EverOS 长期记忆服务（${base}）。回答涉及用户身份、偏好、历史决定或过往对话的问题前，先用 everos_search_memories 检索相关记忆；只使用真正检索到的内容，不要臆造记忆。当用户透露值得长期保留的稳定事实时，用 everos_add_memories 写入，必要时再用 everos_flush_memory 触发抽取。`,
  })
}
