/**
 * dsh-plugin-team-group — host half.
 *
 * 团队群聊：角色卡 + 群组 + 导演发言规划器 + 逐角色执行引擎。
 * 架构对标 Operit2 character_cards/group-execution（contracts/planner/executor/transport），
 * 地基全用 dsh 宿主底层：
 *   - ctx.agents.create/resume + followup   每角色一个持久 agent 会话
 *   - ctx.agentPresets (resolve/mount)      预设=角色人格基底（一个角色一个 preset）
 *   - agentCtx.systemPrompt.section         角色卡 persona 增量段（照 dsh-persona row）
 *   - ctx.tools.register                    team_group_speak / team_group_plan_submit 两把工具
 *   - webServer.register                    /team-group REST + SSE 实时流
 *
 * 群聊时序（Operit 模式）：
 *   用户发言 → 持久化+广播 → 导演会话规划 {"rounds":[[{id,speak,focus}]]}
 *   → 逐轮逐成员 followup → 成员经 team_group_speak 回话 → SSE 推流 → 收尾。
 *   接收全事件驱动，无任何轮询。
 *
 * @module dsh-plugin-team-group
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-plugin-team-group'

const DEFAULTS = {
  stateDir: path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'team-group'),
  maxRounds: 3,
  memberTimeoutMs: 150_000,
  directorTimeoutMs: 90_000,
  historyLimit: 300,
  masterName: 'Master',
  // 大总管/管理员会话（拉人审批必须经他）：默认取渠道插件的 DM 目标私聊，
  // 也可在插件配置里直接指定 masterSessionId / masterSessionNames。
  masterSessionId: process.env.DSH_QQ_DM_TARGET ? `qq-dm-${process.env.DSH_QQ_DM_TARGET}` : '',
  // 渠道会话展示名（sessionId → 显示名），房间成员列表与发现接口使用。
  // 通过插件配置注入，例如：
  //   qqSessionNames: { "qq-dm-123456": "Owner DM", "qq-group-654321": "Main" }
  qqSessionNames: {},
}

const log = (...a) => console.log('[team-group]', ...a)

/* ── 状态 ─────────────────────────────────────────────── */
let CTX = null
let CFG = { ...DEFAULTS }
let cards = []
let rooms = []
let ready = false

/** 正在发言的成员归因表：sessionId → {roomId, cardId} */
const activeSpeakers = new Map()
/** 房间执行序列锁：roomId → true（同一房间串行，新消息排队） */
const busyRooms = new Map()
const sseClients = new Map()   // roomId -> Set<res>
const timers = []

function later(fn, ms) { const t = setTimeout(fn, ms); timers.push(t); return t }

/* ── 数据层 ───────────────────────────────────────────── */
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(CFG.stateDir, file), 'utf8')) } catch { return fallback }
}
function saveJson(file, value) {
  fs.mkdirSync(CFG.stateDir, { recursive: true })
  const full = path.join(CFG.stateDir, file)
  const tmp = full + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8')
  fs.renameSync(tmp, full)
}
function loadState() {
  cards = loadJson('cards.json', [])
  rooms = loadJson('rooms.json', [])
}
const saveCards = () => saveJson('cards.json', cards)
const saveRooms = () => saveJson('rooms.json', rooms)
const cardById = id => cards.find(c => c.id === id)
const roomById = id => rooms.find(r => r.id === id)

/* ── 服务探测（运行时，不进 inject 防不激活） ─────────── */
function svc(name) {
  try { const v = CTX[name]; if (v) return v } catch {}
  try { return CTX.get ? CTX.get(name) : undefined } catch { return undefined }
}

/* ── SSE ──────────────────────────────────────────────── */
function pushEvent(roomId, ev) {
  const e = { ts: Date.now(), roomId, ...ev }
  const set = sseClients.get(roomId)
  if (set) for (const res of set) { try { res.write(`data: ${JSON.stringify(e)}\n\n`) } catch {} }
}
function pushHistoryTail(room, entry) {
  room.history.push(entry)
  if (room.history.length > CFG.historyLimit) room.history.splice(0, room.history.length - CFG.historyLimit)
}

/* ── persona 注入（照 dsh-persona row 的挂法） ────────── */
function mountPersona(agentCtx, card) {
  if (!agentCtx || !agentCtx.systemPrompt || !card || !card.persona) return
  try {
    const text = String(card.persona).trim()
    if (!text) return
    const order = typeof agentCtx.systemPrompt.getSectionOrder === 'function'
      ? agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
      : 500
    agentCtx.systemPrompt.section({
      name: 'team-group:persona',
      order,
      text: `【你的团队角色（团队群聊插件注入，覆盖人格中的冲突部分）】\n${text}`,
    })
  } catch (e) {
    // resume 后重复挂载是常态（持久组合已带同名 section），静默即可
    if (!String(e.message).includes('already registered')) log('persona section failed:', e.message)
  }
}

/* ── 会话编排 ─────────────────────────────────────────── */
// 基底预设：运行时从 registry 取默认；取不到再落到 default
let DEFAULT_PRESET = 'default'
async function resolveDefaultPreset() {
  try {
    const presets = svc('agentPresets')
    if (presets && typeof presets.list === 'function') {
      const rows = await presets.list()
      if (Array.isArray(rows) && rows.length) {
        const def = rows.find(r => r.isDefault) || rows[0]
        if (def && def.id) DEFAULT_PRESET = def.id
      }
    }
  } catch {}
}

function sessionWorkDir() {
  const dir = path.join(CFG.stateDir, 'workspace')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function ensureMember(room, card) {
  const sessionId = `tg-${room.id}-${card.id}`
  const presets = svc('agentPresets')
  const presetId = card.presetId || DEFAULT_PRESET
  const handle = await ensureAgent(sessionId, presetId, modelSelection(card.model), async (agentCtx) => {
    try { if (presets && typeof presets.mount === 'function') await presets.mount(agentCtx, presetId) } catch (e) { log('preset mount failed:', e.message) }
    mountPersona(agentCtx, card)
  }, card)
  return handle
}

async function ensureDirector() {
  const presets = svc('agentPresets')
  return ensureAgent('tg-director', DEFAULT_PRESET, modelSelection(null), async (agentCtx) => {
    try { if (presets && typeof presets.mount === 'function') await presets.mount(agentCtx, DEFAULT_PRESET) } catch {}
    try {
      agentCtx.systemPrompt.section({
        name: 'team-group:director',
        order: 480,
        text: '【团队群聊导演】你是群聊发言规划器。收到规划请求时，只调用 team_group_plan_submit 工具提交 JSON 计划，不输出任何其他文字。',
      })
    } catch {}
  }, null)
}

/**
 * 活注册表直取 → create → 持久会话复活（create 撞 already exists 时 resume）。
 * resume 不再跑 setup：preset 已随持久组合存在，persona 增量段按 live.ctx 补挂
 * （照 dsh-channel-qq bridge 的 ensureConversation 恢复链）。
 */
async function ensureAgent(sessionId, presetId, selection, setupFn, card) {
  const agents = svc('agents')
  if (!agents) throw new Error('agents service unavailable')
  // bulk reattach 发布窗口内 agents.get() 可能给出半成品（ctx/id 未挂上），
  // 照 bridge 的做法：回查重试，残次品不外带（followup 会撞 enter 身份校验）。
  for (let probe = 0; probe < 4; probe++) {
    const live = agents.get(sessionId)
    if (live !== undefined && live.ctx !== undefined && live.id !== undefined) {
      if (card) mountPersona(live.ctx, card)
      if (setupFn && !card) await setupFn(live.ctx).catch(() => {})
      // agents.get() 返回裸 AgentLike；调用方需要 { agent } handle（照 bridge 的包装）
      return { agent: live }
    }
    if (live !== undefined) {
      log(`session ${sessionId} live but not ready (probe ${probe + 1}), waiting…`)
      await new Promise(r => setTimeout(r, 1200))
      continue
    }
    break
  }
  const createOpts = {
    sessionId,
    meta: { cwd: sessionWorkDir(), agentPreset: presetId },
    agentOptions: selection,
    setup: setupFn,
  }
  try {
    const handle = await agents.create(createOpts)
    log(`session created ${sessionId} preset=${presetId}`)
    return handle
  } catch (createError) {
    if (!String(createError).includes('already exists')) throw createError
    let lastError = createError
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // resume() 是独立 registry 方法；create 撞 already exists 后先回查活注册表
        //（bulk reattach 可能正在发布），再走 resume —— 照 bridge ensureConversation 恢复链。
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
        const liveAgain = agents.get(sessionId)
        if (liveAgain !== undefined && liveAgain.ctx !== undefined && liveAgain.id !== undefined) {
          if (card) mountPersona(liveAgain.ctx, card)
          else if (setupFn) await setupFn(liveAgain.ctx).catch(() => {})
          log(`session resumed ${sessionId} (retry ${attempt + 1}, live registry)`)
          return { agent: liveAgain }
        }
        // 会话型成员（QQ 老三窗等渠道会话）：create 撞 already exists 仍走 resume
        // 是错的——那个 identity 已被渠道插件持久化并可能占着写租约，registry
        // resume 会另铸 "session-N" 身份（enter 校验必炸）。此时若注册表里有活体，
        // 无论 ctx 挂没挂全都要等它；channel-qq 的恢复链会补全。
        if (liveAgain !== undefined) {
          log(`session ${sessionId} exists but not ready (retry ${attempt + 1}), waiting channel owner…`)
          continue
        }
        const handle = await agents.resume({ resumeSessionId: sessionId, agentOptions: selection, setup: setupFn })
        log(`session resumed ${sessionId} (persisted composition, retry ${attempt + 1})`)
        if (handle.agent.ctx !== undefined) {
          if (card) mountPersona(handle.agent.ctx, card)
          else if (setupFn) await setupFn(handle.agent.ctx).catch(() => {})
        }
        return handle
      } catch (e) { lastError = e; log(`resume retry ${attempt + 1} failed for ${sessionId}: ${e.message}`) }
    }
    throw lastError
  }
}

function modelSelection(model) {
  if (model && typeof model === 'object' && model.provider && model.model) {
    return { provider: String(model.provider), model: String(model.model) }
  }
  const dm = svc('agentDefaultModel')
  const cur = dm && typeof dm.currentSelection === 'function' ? dm.currentSelection() : null
  if (cur && cur.provider && cur.model) return { provider: cur.provider, model: cur.model, ...(cur.reasoningEffort ? {} : {}) }
  return { provider: 'deepseek', model: 'deepseek-chat' }
}

/* ── 工具 ─────────────────────────────────────────────── */
const toolDisposers = []
function registerTools() {
  // tools 服务是懒启动的：轮询等它就绪（插件 apply 时往往还没起）
  let tries = 0
  const attempt = () => {
    const tools = svc('tools')
    if (!tools || typeof tools.register !== 'function') {
      if (++tries <= 30) { setTimeout(attempt, 1000); return }
      log('tools service unavailable after 30s, giving up')
      return
    }
    doRegisterTools(tools)
  }
  setTimeout(attempt, 1500)
}

function doRegisterTools(tools) {

  try {
    toolDisposers.push(tools.register({
      name: 'team_group_speak',
      description: '在团队群聊里以你的角色身份发言。收到【团队群聊】上下文并轮到你说话时，必须用本工具发言；一次发言一条，说完本轮即结束，不要复述本规则。',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'string', description: '群聊房间ID（上下文里给出，原样填）' },
          text: { type: 'string', description: '以你的角色身份要说的话' },
        },
        required: ['roomId', 'text'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v ?? { ok: true }) }] },
      async execute(args) {
        const a = args ?? {}
        const text = String(a.text ?? '').trim()
        if (!text) return { ok: false, error: 'empty text' }
        const room = roomById(String(a.roomId ?? ''))
        if (!room) return { ok: false, error: 'unknown room' }
        // 归因：调用中会话登记（含 QQ 会话成员），其次按卡片兜底
        let attribution = null
        for (const [sid, info] of activeSpeakers) {
          if (info.roomId === room.id) { attribution = info; break }
        }
        const card = attribution && attribution.type !== 'qq' ? cardById(attribution.cardId) : null
        const name = attribution ? (attribution.name || (card && card.name) || '成员') : '成员'
        const entry = {
          ts: Date.now(),
          from: 'card',
          cardId: card ? card.id : undefined,
          name,
          color: (card && card.color) || '#8fd8ff',
          avatar: (card && card.avatar) || '🔗',
          text: text.slice(0, 4000),
        }
        pushHistoryTail(room, entry)
        saveRooms()
        pushEvent(room.id, { type: 'speak', entry })
        return { ok: true }
      },
    }))
  } catch (e) { log('speak tool register failed:', e.message) }

  try {
    toolDisposers.push(tools.register({
      name: 'team_group_plan_submit',
      description: '团队群聊导演专用：提交发言规划 JSON。只在收到规划请求时调用一次。',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'string' },
          rounds: {
            type: 'array',
            description: '发言轮次数组，每轮是成员条目数组',
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: '成员卡片ID' },
                  speak: { type: 'boolean' },
                  focus: { type: 'string', description: '给该成员的针对性发言指示' },
                },
                required: ['id', 'speak'],
              },
            },
          },
        },
        required: ['roomId', 'rounds'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v ?? { ok: true }) }] },
      async execute(args) {
        const a = args ?? {}
        const room = roomById(String(a.roomId ?? ''))
        if (!room) return { ok: false, error: 'unknown room' }
        room.pendingPlan = { rounds: Array.isArray(a.rounds) ? a.rounds.slice(0, 6) : [], plannedAt: Date.now() }
        saveRooms()
        return { ok: true }
      },
    }))
  } catch (e) { log('plan tool register failed:', e.message) }

  try {
    toolDisposers.push(tools.register({
      name: 'team_group_create_room',
      description: '创建一个团队群聊（新房间）。当你想和若干团队成员单独开一个群讨论某事时使用。创建后返回 roomId，配合 team_group_speak 在群里说话（roomId 填新房间 id）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '群聊名称' },
          memberIds: { type: 'array', items: { type: 'string' }, description: '要拉进群的成员卡片ID列表（可省略，省略则建空群稍后拉人）' },
        },
        required: ['name'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      async execute(args) {
        const a = args ?? {}
        const name = String(a.name ?? '').trim().slice(0, 30)
        if (!name) return { ok: false, error: 'name required' }
        const ids = Array.isArray(a.memberIds) ? a.memberIds.map(String).filter(id => cardById(id)).slice(0, 8) : []
        const room = {
          id: 'room_' + Math.random().toString(36).slice(2, 9),
          name, members: ids, sessions: [], history: [], createdAt: Date.now(),
        }
        rooms.push(room); saveRooms()
        pushEvent(room.id, { type: 'system', text: `群聊「${name}」已创建${ids.length ? '，成员 ' + ids.length + ' 人' : ''}` })
        return { ok: true, roomId: room.id, name: room.name, members: room.members }
      },
    }))
  } catch (e) { log('create_room tool register failed:', e.message) }

  try {
    toolDisposers.push(tools.register({
      name: 'team_group_invite',
      description: '申请把成员拉进一个团队群聊。注意：拉人需要大总管（私聊会话）审批同意才会生效，提交后进入待审批状态，审批通过后成员才真正进房。',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'string', description: '群聊房间ID' },
          memberIds: { type: 'array', items: { type: 'string' }, description: '要拉进的成员：角色卡ID，或会话型成员对象 {type:"qq"|"feishu"|"session", sessionId, name}' },
        },
        required: ['roomId', 'memberIds'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      async execute(args) {
        const a = args ?? {}
        const room = roomById(String(a.roomId ?? ''))
        if (!room) return { ok: false, error: 'unknown room' }
        const raw = Array.isArray(a.memberIds) ? a.memberIds : []
        const refs = raw.map(m => memberRef(m)).filter(r => r.id)
        if (!refs.length) return { ok: false, error: 'memberIds required' }
        if (!Array.isArray(room.pendingInvites)) room.pendingInvites = []
        const invites = refs.map(r => ({
          id: 'inv_' + Math.random().toString(36).slice(2, 8),
          member: r.type === 'session'
            ? { type: 'session', sessionId: r.id, name: (raw.find(x => x && (x.id || x.sessionId) === r.id)?.name) || r.id }
            : { type: 'card', id: r.id, name: (cardById(r.id) || {}).name || r.id },
          by: 'member', ts: Date.now(),
        }))
        // 去掉重复申请
        const key = v => v.member.type + ':' + v.member.id
        const have = new Set(room.pendingInvites.map(key))
        const fresh = invites.filter(v => !have.has(key(v)))
        room.pendingInvites.push(...fresh)
        saveRooms()
        for (const v of fresh) pushEvent(room.id, { type: 'invite', invite: v })
        // 通知大总管（私聊会话）：他必须知情并审批
        notifyMaster(room, fresh)
        return { ok: true, pending: fresh.map(v => ({ inviteId: v.id, member: v.member })), note: '已提交，等待大总管审批' }
      },
    }))
  } catch (e) { log('invite tool register failed:', e.message) }

  try {
    toolDisposers.push(tools.register({
      name: 'team_group_approve',
      description: '大总管专用：审批拉人申请。approve=true 成员进房，false 拒绝。只有大总管（私聊会话）的审批有效。',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'string' },
          inviteId: { type: 'string', description: '待审批的邀请ID' },
          approve: { type: 'boolean' },
        },
        required: ['roomId', 'inviteId', 'approve'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      async execute(args) {
        const a = args ?? {}
        const room = roomById(String(a.roomId ?? ''))
        if (!room) return { ok: false, error: 'unknown room' }
        if (!Array.isArray(room.pendingInvites)) room.pendingInvites = []
        const idx = room.pendingInvites.findIndex(v => v.id === String(a.inviteId))
        if (idx < 0) return { ok: false, error: 'invite not found' }
        const inv = room.pendingInvites.splice(idx, 1)[0]
        saveRooms()
        if (a.approve === false) {
          const r = doApprove(room, String(a.inviteId), false)
          return r
        }
        const r = doApprove(room, String(a.inviteId), true)
        return r && r.ok ? { ok: true, approved: r.approved, members: room.members } : r
      },
    }))
  } catch (e) { log('approve tool register failed:', e.message) }

  try {
    toolDisposers.push(tools.register({
      name: 'team_group_convene',
      description: '召集团队群聊的一轮讨论：你的发言进房间后，由导演规划成员依次发言。支持跨群组、跨频道：roomIds 可传多个房间一次同喊（例如同时召集 QQ 小组和破甲小组）。任何会话（含 QQ 私聊）都可调用——私聊窗口是团队总指挥。',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'string', description: '目标房间ID（单个）' },
          roomIds: { type: 'array', items: { type: 'string' }, description: '多个房间ID（跨群组同喊；与 roomId 二选一，roomIds 优先）' },
          text: { type: 'string', description: '你说的话（作为发言进入房间，成员们将围绕它讨论）' },
        },
        required: ['text'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      async execute(args) {
        const a = args ?? {}
        const text = String(a.text ?? '').trim()
        if (!text) return { ok: false, error: 'text required' }
        const ids = Array.isArray(a.roomIds) && a.roomIds.length ? a.roomIds.map(String) : [String(a.roomId ?? '')]
        const done = [], missed = []
        for (const rid of ids) {
          const room = roomById(rid)
          if (!room) { missed.push(rid); continue }
          const entry = { ts: Date.now(), from: 'user', name: CFG.masterName, color: '#8fd8ff', avatar: '🐾', text: text.slice(0, 4000) }
          pushHistoryTail(room, entry)
          pushEvent(room.id, { type: 'user', entry })
          room.pendingSay = { text }
          later(() => { runSequence(room).catch(e => log('sequence failed:', e.message)) }, 0)
          done.push(room.id)
        }
        saveRooms()
        return { ok: done.length > 0, convened: done, missed, note: `已召集 ${done.length} 个房间` }
      },
    }))
  } catch (e) { log('convene tool register failed:', e.message) }

  try {
    toolDisposers.push(tools.register({
      name: 'team_group_ask',
      description: '点名某个团队成员单独回答一个问题（绕过导演，直达该成员）。可跨群组、跨频道点名任何房间里的成员（含 QQ/飞书等会话型成员）。适合只想听某一个成员的意见时使用。',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'string', description: '目标房间ID' },
          memberId: { type: 'string', description: '要问的成员（卡片ID或QQ会话成员ID）' },
          question: { type: 'string', description: '要问的问题' },
        },
        required: ['roomId', 'memberId', 'question'],
      },
      output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      async execute(args) {
        const a = args ?? {}
        const room = roomById(String(a.roomId ?? ''))
        if (!room) return { ok: false, error: 'unknown room' }
        const question = String(a.question ?? '').trim()
        if (!question) return { ok: false, error: 'question required' }
        const member = memberListFor(room).find(m => m.id === String(a.memberId))
        if (!member) return { ok: false, error: 'member not in room' }
        const entry = { ts: Date.now(), from: 'user', name: CFG.masterName, color: '#8fd8ff', avatar: '🐾', text: `（点名 @${member.name}）${question}` }
        pushHistoryTail(room, entry)
        saveRooms()
        pushEvent(room.id, { type: 'user', entry })
        room.pendingSay = { text: entry.text, only: member.id }
        later(() => { runSequence(room).catch(e => log('sequence failed:', e.message)) }, 0)
        return { ok: true, roomId: room.id, note: `已点名 ${member.name}` }
      },
    }))
  } catch (e) { log('ask tool register failed:', e.message) }

  log('team tools registered')
}

/* ── 会话型成员（跨频道）────────────────────────────── */
// 设计约束：会话型成员不是桥接——任何渠道会话（QQ 私聊/群、飞书、任意 dsh 会话）
// 的 agent 本身就是团队成员，收到房间上下文（followup）后调用团队工具发言。
// 成员形态：成员列表里既可以是角色卡 id（字符串），也可以是
// { type:'qq'|'feishu'|'session', sessionId, name } 会话型成员。
// 会话的 agent 由其所属渠道插件管理，这里只 resume 复用并注入房间参与说明。
// 私聊窗口（总指挥）可跨房间、跨频道喊话：convene 支持 roomIds 多房同喊。
const SESSION_TYPES = new Set(['qq', 'feishu', 'session'])

function memberRef(m) {
  if (typeof m === 'string') return { type: 'card', id: m }
  const t = (m && m.type) || 'card'
  return { type: SESSION_TYPES.has(t) ? 'session' : 'card', id: m && (m.id || m.sessionId), name: m && m.name }
}

async function ensureSessionMember(room, ref) {
  // ref 兼容两种形态：{id}（memberListFor 产出）与 {sessionId}（memberSpeak 传参）——
  // 此前只取 ref.id，memberSpeak 传的 sessionId 字段被读成 undefined，
  // create/resume 全部拿空身份（session-N 铸位 / observeSession 崩）。
  const sessionId = ref.id || ref.sessionId
  const displayName = ref.name || sessionId
  // 设计约束的交互激活路径：渠道会话归其宿主插件统合。正确入口是
  // sessionController.resolveAgent（Host 会话业务 API）：活体直回；冷会话走
  // sessionQuery.observeSession → agents.resume(persisted)——identity 始终是
  // 原 sessionId，绝不另铸 session-N。此前直接走 agents.create 才是病根：
  // claim() 见老三窗已有 turn 记录（不 blank）→ createMinted 铸新身份 → enter 校验炸。
  const controller = svc('sessionController')
  if (controller && typeof controller.resolveAgent === 'function') {
    const found = await controller.resolveAgent(sessionId)
    if ('error' in found) throw new Error(found.error?.message || String(found.error))
    const agent = found.agent
    if (agent?.ctx) mountMemberSection(agent.ctx, room, displayName)
    return { agent }
  }
  // 退化路径（无 controller 时）：活体直用；否则 registry resume
  const agents = svc('agents')
  if (!agents) throw new Error('agents service unavailable')
  const live = agents.get(sessionId)
  if (live !== undefined && live.ctx !== undefined) {
    mountMemberSection(live.ctx, room, displayName)
    return { agent: live }
  }
  const setupFn = async (agentCtx) => { mountMemberSection(agentCtx, room, displayName) }
  return agents.resume({ resumeSessionId: sessionId, agentOptions: modelSelection(null), setup: setupFn })
}

function mountMemberSection(agentCtx, room, displayName) {
  if (!agentCtx || !agentCtx.systemPrompt) return
  try {
    const order = typeof agentCtx.systemPrompt.getSectionOrder === 'function'
      ? agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
      : 500
    agentCtx.systemPrompt.section({
      name: `team-group:member-${room.id}`,
      order,
      text: `【团队群聊参与说明】你同时是团队群聊「${room.name}」（roomId=${room.id}）的成员「${displayName}」。收到带【团队群聊】标头的消息时，用 team_group_speak 工具（roomId=${room.id}）发言，只发一条；你也可以用 team_group_convene / team_group_ask 跨房间、跨频道召集或点名其他成员；其余时刻照常处理你原本的事务，本说明不影响你的原有人格与规则。`,
    })
  } catch (e) {
    if (!String(e.message).includes('already registered')) log('member section failed:', e.message)
  }
}

/** 审批：大总管（工具）与 Web UI 共用 */
function doApprove(room, inviteId, approve) {
  if (!Array.isArray(room.pendingInvites)) room.pendingInvites = []
  const idx = room.pendingInvites.findIndex(v => v.id === inviteId)
  if (idx < 0) return { ok: false, error: 'invite not found' }
  const inv = room.pendingInvites.splice(idx, 1)[0]
  saveRooms()
  if (!approve) {
    pushEvent(room.id, { type: 'system', text: `拉人申请已驳回：${inv.member.name}` })
    return { ok: true, approved: false, member: inv.member }
  }
  const m = inv.member.type === 'session'
    ? { type: 'session', sessionId: inv.member.id, name: inv.member.name }
    : inv.member.id
  room.members = [...new Set([...(room.members || []), m])].slice(0, 8)
  saveRooms()
  pushEvent(room.id, { type: 'system', text: `大总管已批准，新成员加入：${inv.member.name}` })
  return { ok: true, approved: true, member: inv.member, members: room.members }
}

/** 拉人申请通知大总管（私聊会话）：他必须知情并审批 */
async function notifyMaster(room, invites) {
  const sid = CFG.masterSessionId
  if (!sid) { log('no masterSessionId, skip notify'); return }
  try {
    const agents = svc('agents')
    if (!agents) return
    const live = agents.get(sid)
    const handle = live !== undefined ? { agent: live } : await agents.resume({ resumeSessionId: sid }).catch(() => null)
    if (!handle || !handle.agent) { log('master session unavailable:', sid); return }
    const lines = invites.map(v => `- inviteId: ${v.id}，成员：${v.member.name}（${v.member.type === 'session' ? '会话型 ' + v.member.id : '角色卡'}）`)
    const text = [
      `【团队群聊 · 拉人审批】房间「${room.name}」（roomId=${room.id}）收到拉人申请：`,
      ...lines,
      `你是大总管。同意请调 team_group_approve（roomId="${room.id}"，approve=true），拒绝则 approve=false。不处理也可，申请会保留在房间里。`,
    ].join('\n')
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const msg = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'team-group', form: 'message' } })
    handle.agent.followup(msg)
    log('master notified,', invites.length, 'invites')
  } catch (e) { log('notify master failed:', e.message) }
}

/* ── 执行引擎 ─────────────────────────────────────────── */
function recentTranscript(room, limit = 20) {
  return room.history.slice(-limit).map(e => {
    const who = e.from === 'user' ? '用户' : e.from === 'system' ? '系统' : e.name
    return `- ${who}：${String(e.text).slice(0, 500)}`
  }).join('\n')
}

function memberListFor(room) {
  // 混合成员：角色卡（字符串 id）+ 会话型成员（任意渠道：qq/feishu/session）
  const out = []
  for (const m of room.members) {
    const ref = memberRef(m)
    if (ref.type === 'session') {
      out.push({ id: ref.id, type: 'session', name: ref.name || ref.id, avatar: '🔗', brief: '会话成员（跨频道）' })
      continue
    }
    const c = cardById(ref.id)
    if (c) out.push({ id: c.id, type: 'card', name: c.name, avatar: c.avatar || '🙂', brief: String(c.persona || '').slice(0, 120) })
  }
  return out
}

async function runSequence(room) {
  if (busyRooms.get(room.id)) { room.queued = true; return }
  busyRooms.set(room.id, true)
  try {
    while (true) {
      const task = room.pendingSay
      room.pendingSay = null
      if (!task) break
      await executeSay(room, task.text, task.only)
      if (!room.queued) break
      room.queued = false
    }
  } finally {
    busyRooms.delete(room.id)
  }
}

async function withTimeout(promise, ms, label) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(label + ' timeout')), ms) }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

/** 单成员发言（点名模式与轮次共用）：followup + 等待 team_group_speak 落账 */
async function memberSpeak(room, member, focus) {
  const before = room.history.length
  const speakerKey = member.type === 'session' ? member.id : `tg-${room.id}-${member.id}`
  try {
    activeSpeakers.set(speakerKey, { roomId: room.id, cardId: member.id, name: member.name, type: member.type })
    const agentHandle = member.type === 'session'
      ? await ensureSessionMember(room, { type: 'session', sessionId: member.id, name: member.name })
      : await ensureMember(room, cardById(member.id))
    const identityLine = member.type === 'session'
      ? `你的身份：${member.name}（会话成员，通过你原本的会话跨频道参与团队群聊）`
      : `你的身份：${member.name}${cardById(member.id) && cardById(member.id).persona ? '（' + String(cardById(member.id).persona).slice(0, 160) + '）' : ''}`
    const ctxMsg = [
      `【团队群聊 · 房间「${room.name}」】`,
      identityLine,
      '【最近群聊】',
      recentTranscript(room, 14) || '（空）',
      `【本轮指示】${focus}`,
      `【发言规则】立即调用 team_group_speak 工具（roomId 填 "${room.id}"），以「${member.name}」的身份发言。只发一条，发完本轮即结束；不要用其他任何工具，不要输出工具以外的文字。`,
    ].join('\n')
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const msg = createUserMessage({ content: [{ type: 'text', text: ctxMsg }], source: { kind: 'team-group', form: 'message' } })
    agentHandle.agent.followup(msg)
    const started = Date.now()
    while (room.history.length === before && Date.now() - started < CFG.memberTimeoutMs) {
      await new Promise(r => setTimeout(r, 400))
    }
    if (room.history.length === before) {
      pushEvent(room.id, { type: 'system', text: `${member.name} 超时未发言` })
    }
  } finally {
    activeSpeakers.delete(speakerKey)
  }
}

async function executeSay(room, text, only) {
  const members = memberListFor(room)
  if (!members.length) {
    pushEvent(room.id, { type: 'system', text: '群聊没有成员，先添加角色卡。' })
    return
  }

  // 点名模式：跳过导演，直达指定成员
  if (only) {
    const member = members.find(m => m.id === only)
    if (!member) {
      pushEvent(room.id, { type: 'system', text: '点名成员不在房间里。' })
      return
    }
    pushEvent(room.id, { type: 'speaking', cardId: member.id, name: member.name })
    try {
      await memberSpeak(room, member, `点名提问：${text}`)
    } catch (e) {
      log(`member ${member.id} speak failed:`, e.message)
      pushEvent(room.id, { type: 'system', text: `${member.name} 发言失败：${e.message.slice(0, 80)}` })
    }
    pushEvent(room.id, { type: 'done' })
    return
  }

  // 1) 导演规划
  pushEvent(room.id, { type: 'planning', text: '导演规划中…' })
  const director = await ensureDirector()
  room.pendingPlan = null
  const planPrompt = [
    `【团队群聊 · 房间「${room.name}」】`,
    '成员列表：',
    ...members.map(m => `- id: ${m.id}, 名: ${m.name}, 简介: ${m.brief || '（无）'}`),
    '【最近群聊】',
    recentTranscript(room) || '（空）',
    `【用户新消息】\n${text}`,
    '请规划哪些成员发言、按什么顺序、分几轮。只调用 team_group_plan_submit 工具（roomId 填 "' + room.id + '"），不要输出其他文字。',
    '规则：简单回应单轮单人；讨论可多轮让成员互相讨论；最多 ' + CFG.maxRounds + ' 轮；没人该说话返回空轮 {"rounds":[[]]}；只用给出的成员 id；给每个发言成员写一句 focus 指示。',
  ].join('\n')

  let plan = null
  try {
    activeSpeakers.set('tg-director', { roomId: room.id, cardId: '__director__' })
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const msg = createUserMessage({
      content: [{ type: 'text', text: planPrompt }],
      source: { kind: 'team-group', form: 'message' },
    })
    director.agent.followup(msg)
    const started = Date.now()
    while (!room.pendingPlan && Date.now() - started < CFG.directorTimeoutMs) {
      await new Promise(r => setTimeout(r, 400))
    }
    plan = room.pendingPlan
    if (!plan) throw new Error('director timeout')
  } catch (e) {
    log('plan failed:', e.message)
    // 规划失败降级：全员单轮
    plan = { rounds: [members.map(m => ({ id: m.id, speak: true, focus: '回应用户' }))] }
  } finally {
    activeSpeakers.delete('tg-director')
  }

  // 清理计划：只留合法成员、speak!==false
  const validIds = new Set(members.map(m => m.id))
  const rounds = (plan.rounds || [])
    .map(r => (Array.isArray(r) ? r : []).filter(e => e && validIds.has(String(e.id)) && e.speak !== false))
    .filter(r => r.length > 0)
    .slice(0, CFG.maxRounds)

  pushEvent(room.id, { type: 'plan', rounds: rounds.map(r => r.map(e => ({ id: e.id, name: (cardById(e.id) || {}).name, focus: e.focus }))) })

  // 2) 逐轮逐成员执行
  for (let ri = 0; ri < rounds.length; ri++) {
    const round = rounds[ri]
    pushEvent(room.id, { type: 'round', index: ri + 1, total: rounds.length })
    for (const entry of round) {
      const member = members.find(m => m.id === entry.id)
      if (!member) continue
      pushEvent(room.id, { type: 'speaking', cardId: member.id, name: member.name })
      try {
        await memberSpeak(room, member, entry.focus || '自然回应最新消息')
      } catch (e) {
        log(`member ${member.id} speak failed:`, e.message)
        pushEvent(room.id, { type: 'system', text: `${member.name} 发言失败：${e.message.slice(0, 80)}` })
      }
    }
  }

  pushEvent(room.id, { type: 'done' })
}

/* ── HTTP ─────────────────────────────────────────────── */
function uiDir() {
  return path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'ui')
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}
function readBody(req) {
  return new Promise(r => {
    let b = ''
    req.on('data', d => { b += d; if (b.length > 1e6) req.destroy() })
    req.on('end', () => { try { r(JSON.parse(b || '{}')) } catch { r({}) } })
  })
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

function registerHttp(webCtx) {
  webCtx.webServer.register({
    kind: 'prefix',
    path: '/team-group',
    handler: async (req, res) => {
      if (!ready) return sendJson(res, 503, { error: 'loading' })
      const url = new URL(req.url, 'http://127.0.0.1')
      const p = url.pathname
      const seg = p.split('/').filter(Boolean) // ['team-group', ...]

      // SSE：/team-group/api/rooms/:id/events
      if (p.endsWith('/events') && seg[2] === 'rooms' && seg[3]) {
        const room = roomById(seg[3])
        if (!room) return sendJson(res, 404, { error: 'no room' })
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache', connection: 'keep-alive',
          'access-control-allow-origin': '*',
        })
        res.write(`data: ${JSON.stringify({ type: 'hello', roomId: room.id })}\n\n`)
        if (!sseClients.has(room.id)) sseClients.set(room.id, new Set())
        sseClients.get(room.id).add(res)
        const ka = setInterval(() => { try { res.write(': ka\n\n') } catch {} }, 15000)
        req.on('close', () => { clearInterval(ka); sseClients.get(room.id)?.delete(res) })
        return
      }

      // 动态资源清单：QQ 老三窗（channel-qq 管理的会话=角色，私聊=大总管）
      if (p === '/team-group/api/qq-sessions' && req.method === 'GET') {
        const names = CFG.qqSessionNames || {}
        const out = []
        try {
          const sdir = path.join(os.homedir(), '.dsh', 'sessions')
          for (const enc of fs.readdirSync(sdir)) {
            const dir = path.join(sdir, enc)
            let st
            try { st = fs.statSync(dir) } catch { continue }
            if (!st.isDirectory()) continue
            for (const sid of fs.readdirSync(dir)) {
              if (!/^qq-(dm|group)-/.test(sid)) continue
              out.push({ id: sid, name: names[sid] || sid, master: sid === CFG.masterSessionId })
            }
          }
        } catch (e) { log('qq-sessions scan failed:', e.message) }
        return sendJson(res, 200, { sessions: out })
      }

      // 动态资源清单：头像模板（ui/avatars/*.{png,svg}，png 优先）+ 可用预设（registry.list）
      if (p === '/team-group/api/avatars' && req.method === 'GET') {
        const dir = path.join(uiDir(), 'avatars')
        const byId = new Map()
        try {
          for (const f of fs.readdirSync(dir)) {
            const m = f.match(/^(.+)\.(png|svg)$/)
            if (!m) continue
            const id = m[1]
            const prev = byId.get(id)
            // png 优先；同类后到覆盖（保持文件名字典序稳定）
            if (!prev || (m[2] === 'png' && prev.ext !== 'png')) byId.set(id, { id, ext: m[2], src: `avatars/${f}` })
            else if (prev.ext === m[2]) byId.set(id, { id, ext: m[2], src: `avatars/${f}` })
          }
        } catch {}
        const avatars = [...byId.values()].map(v => ({ id: v.id, src: v.src }))
        return sendJson(res, 200, { avatars })
      }
      if (p === '/team-group/api/presets' && req.method === 'GET') {
        try {
          const presets = svc('agentPresets')
          if (presets && typeof presets.list === 'function') {
            const rows = await presets.list()
            return sendJson(res, 200, { presets: rows.map(r => ({ id: r.id, name: r.name || r.id, isDefault: !!r.isDefault })) })
          }
        } catch {}
        return sendJson(res, 200, { presets: [{ id: DEFAULT_PRESET, name: DEFAULT_PRESET, isDefault: true }] })
      }

      // 角色卡
      if (p === '/team-group/api/cards' && req.method === 'GET') {
        return sendJson(res, 200, { cards: cards.map(c => ({ ...c, persona: String(c.persona || '').slice(0, 400) })) })
      }
      if (p === '/team-group/api/cards' && req.method === 'POST') {
        const b = await readBody(req)
        const card = {
          id: 'card_' + Math.random().toString(36).slice(2, 9),
          name: String(b.name || '新角色').slice(0, 24),
          avatar: String(b.avatar || '🙂').slice(0, 4),
          color: /^#[0-9a-fA-F]{6}$/.test(b.color || '') ? b.color : '#8fd8ff',
          presetId: String(b.presetId || DEFAULT_PRESET),
          persona: String(b.persona || '').slice(0, 2000),
          model: b.model && b.model.provider ? { provider: String(b.model.provider), model: String(b.model.model) } : null,
          createdAt: Date.now(),
        }
        cards.push(card); saveCards()
        return sendJson(res, 200, { card })
      }
      if (seg[2] === 'cards' && seg[3] && req.method === 'DELETE') {
        cards = cards.filter(c => c.id !== seg[3]); saveCards()
        return sendJson(res, 200, { ok: true })
      }

      // 房间
      if (p === '/team-group/api/rooms' && req.method === 'GET') {
        return sendJson(res, 200, { rooms: rooms.map(r => ({ id: r.id, name: r.name, members: r.members, count: r.history.length })) })
      }
      if (p === '/team-group/api/rooms' && req.method === 'POST') {
        const b = await readBody(req)
        // 混合成员：角色卡 id（字符串）+ QQ 会话成员（{type:'qq',...} 对象）
        const rawMembers = Array.isArray(b.members) ? b.members : []
        const members = rawMembers
          .map(m => (typeof m === 'string' && cardById(m)) ? m
            : (m && typeof m === 'object' && m.type === 'qq' && m.sessionId)
              ? { type: 'qq', sessionId: String(m.sessionId).slice(0, 80), name: String(m.name || m.sessionId).slice(0, 24) }
              : null)
          .filter(Boolean).slice(0, 8)
        const room = {
          id: 'room_' + Math.random().toString(36).slice(2, 9),
          name: String(b.name || '新群聊').slice(0, 30),
          members,
          sessions: Array.isArray(b.sessions) ? b.sessions.map(s => String(s).slice(0, 80)).slice(0, 20) : [],
          history: [],
          createdAt: Date.now(),
        }
        rooms.push(room); saveRooms()
        return sendJson(res, 200, { room: { id: room.id, name: room.name, members: room.members, sessions: room.sessions } })
      }
      if (seg[2] === 'rooms' && seg[3] && seg[4] === 'sessions' && req.method === 'POST') {
        const room = roomById(seg[3])
        if (!room) return sendJson(res, 404, { error: 'no room' })
        const b = await readBody(req)
        room.sessions = Array.isArray(b.sessions) ? b.sessions.map(s => String(s).slice(0, 80)).slice(0, 20) : []
        saveRooms()
        return sendJson(res, 200, { sessions: room.sessions })
      }
      if (seg[2] === 'rooms' && seg[3] && seg[4] === 'history' && req.method === 'GET') {
        const room = roomById(seg[3])
        return room ? sendJson(res, 200, { history: room.history.slice(-120) }) : sendJson(res, 404, { error: 'no room' })
      }
      // 待审批清单 + 审批（Web UI 直接批=管理员批）
      if (seg[2] === 'rooms' && seg[3] && seg[4] === 'invites' && req.method === 'GET') {
        const room = roomById(seg[3])
        return room ? sendJson(res, 200, { invites: room.pendingInvites || [] }) : sendJson(res, 404, { error: 'no room' })
      }
      if (seg[2] === 'rooms' && seg[3] && seg[4] === 'approve' && req.method === 'POST') {
        const room = roomById(seg[3])
        if (!room) return sendJson(res, 404, { error: 'no room' })
        const b = await readBody(req)
        const r = doApprove(room, String(b.inviteId ?? ''), !!b.approve)
        return sendJson(res, r.ok ? 200 : 400, r)
      }
      if (seg[2] === 'rooms' && seg[3] && seg[4] === 'say' && req.method === 'POST') {
        const room = roomById(seg[3])
        if (!room) return sendJson(res, 404, { error: 'no room' })
        const b = await readBody(req)
        const text = String(b.text ?? '').trim()
        if (!text) return sendJson(res, 400, { error: 'empty' })
        const entry = { ts: Date.now(), from: 'user', name: CFG.masterName, color: '#ff7ad9', avatar: '🫡', text: text.slice(0, 4000) }
        pushHistoryTail(room, entry)
        saveRooms()
        pushEvent(room.id, { type: 'user', entry })
        room.pendingSay = { text }
        later(() => { runSequence(room).catch(e => log('sequence failed:', e.message)) }, 0)
        return sendJson(res, 200, { ok: true })
      }
      if (seg[2] === 'rooms' && seg[3] && req.method === 'DELETE') {
        rooms = rooms.filter(r => r.id !== seg[3]); saveRooms()
        return sendJson(res, 200, { ok: true })
      }

      // 静态
      const rel = p === '/team-group' || p === '/team-group/' ? 'index.html' : p.replace('/team-group/', '')
      const target = path.join(uiDir(), rel)
      if (!path.resolve(target).startsWith(path.resolve(uiDir()))) return sendJson(res, 403, { error: 'forbidden' })
      try {
        const buf = fs.readFileSync(target)
        res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' })
        res.end(buf)
      } catch { sendJson(res, 404, { error: 'not found', path: rel }) }
    },
  })
  log('mounted at /team-group')
}

/** webServer 就绪后再挂 HTTP（照 dsh-plugin-starmap 的 inject/effect 模式） */
function mountHttp(ctx) {
  try {
    ctx.inject(['webServer'], (webCtx) => {
      ctx.effect(() => registerHttp(webCtx), 'team-group: http routes')
    })
  } catch (e) { log('inject webServer failed:', e.message) }
}

/* ── 入口 ─────────────────────────────────────────────── */
export function apply(ctx, rawConfig) {
  CTX = ctx
  for (const k of Object.keys(DEFAULTS)) {
    const v = rawConfig && rawConfig[k]
    if (v === undefined || v === null) continue
    if (typeof v === 'object' && k === 'qqSessionNames') CFG[k] = { ...v }
    else if (typeof v !== 'object') CFG[k] = v
  }
  loadState()
  ready = true
  registerTools()
  resolveDefaultPreset()
  mountHttp(ctx)
  // sessionController 与 tools 一样晚起：等它就绪（resolveAgent 是 QQ 会话成员
  // 的唯一正确激活路径——identity 永远保持原 sessionId，不铸 session-N）。
  ctx.inject(['sessionController'], () => {
    log('sessionController acquired, session-member path armed')
  })
  log('ready, cards=' + cards.length + ' rooms=' + rooms.length)
}

export default apply
