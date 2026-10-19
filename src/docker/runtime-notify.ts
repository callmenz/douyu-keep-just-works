import type { CookieStatusSummary, DockerConfig, PushChannelConfig, TaskRunRecord } from '../core/types'
import * as fs from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'
import axios from 'axios'
import { errorMessage } from '../core/errors'
import { getTaskConfig, getTaskLabel, isTaskEnabled, TASK_TYPES } from './task-metadata'
import { buildTaskRunSummary } from './runtime-task-summary'
import type { TaskType } from './task-metadata'

/**
 * 推送通道：自建 MagicPush 网关（POST {base}/api/push/{token}）。
 * 走 extraData.feishu.channelType=interactive_card 时 MagicPush 会把 card 原样投递给飞书群机器人，
 * 因此这里可以直接构造飞书卡片 2.0，而不用在本项目里管飞书 token。
 *
 * 主题色：斗鱼橙 #FF5D23（也是本项目 WebUI 的 accent 色系）。
 * 飞书卡片 header.template 只接受预设色名，没有自定义 hex，所以用最接近的 `orange`，
 * 正文里的强调再用 <font color='orange'> 加深。
 */
export const DOUYU_ORANGE = '#FF5D23'
const CARD_TEMPLATE = 'orange'
const NOTIFY_TIMEOUT_MS = 15000
const MAX_LOGS_PER_RUN = 40
const MAX_RUNS_PER_TASK = 30

interface MagicPushSettings {
  baseUrl: string
  token: string
  mode: 'card' | 'text'
  source: 'config' | 'env' | 'none'
}

let channelConfig: PushChannelConfig | null = null
let channelResolver: (() => PushChannelConfig | null | undefined) | null = null

/** 由 runtime 在配置加载/变更时注入；为空时回退到环境变量 */
export function setPushChannelConfig(config: PushChannelConfig | null | undefined): void {
  channelConfig = config ?? null
}

/**
 * 注入读取函数而不是快照值：渠道配置可能在任意时刻被 WebUI 改动，
 * 用 getter 可以保证每次推送都读到最新值（避免依赖 applyConfig 的调用时机）。
 */
export function setPushChannelResolver(resolver: (() => PushChannelConfig | null | undefined) | null): void {
  channelResolver = resolver
}

function currentChannelConfig(): PushChannelConfig | null {
  if (channelResolver) {
    return channelResolver() ?? null
  }
  return channelConfig
}

/** 当前生效的渠道来源，供 WebUI 展示 */
export function getPushChannelSource(): 'config' | 'env' | 'none' {
  const settings = readMagicPushSettings()
  return settings ? settings.source : 'none'
}

export function getPushChannelSettings(): { enabled: boolean, baseUrl: string, mode: 'card' | 'text', tokenSet: boolean, tokenPreview: string, source: 'config' | 'env' | 'none' } {
  const activeConfig = currentChannelConfig()
  const enabled = activeConfig ? activeConfig.enabled !== false : true
  const settings = readMagicPushSettings()
  if (!settings) {
    return { enabled, baseUrl: '', mode: 'card', tokenSet: false, tokenPreview: '', source: 'none' }
  }
  const token = settings.token
  return {
    enabled,
    baseUrl: settings.baseUrl,
    mode: settings.mode,
    tokenSet: Boolean(token),
    tokenPreview: token.length > 8 ? `${token.slice(0, 4)}****${token.slice(-4)}` : '****',
    source: settings.source,
  }
}

export interface CardTag {
  text: string
  color: string
}

export type CardElement = Record<string, unknown>

function readMagicPushSettings(): MagicPushSettings | null {
  // 界面里配的渠道优先，其次环境变量；两边都没配则视为未配置
  const fromConfig = currentChannelConfig()
  if (fromConfig && fromConfig.enabled !== false) {
    const baseUrl = (fromConfig.baseUrl || '').trim().replace(/\/+$/, '')
    const token = (fromConfig.token || '').trim()
    if (baseUrl && token) {
      return { baseUrl, token, mode: fromConfig.mode === 'text' ? 'text' : 'card', source: 'config' }
    }
  }

  const baseUrl = (process.env.MAGICPUSH_URL || '').trim().replace(/\/+$/, '')
  const token = (process.env.MAGICPUSH_TOKEN || '').trim()
  if (!baseUrl || !token) {
    return null
  }
  return { baseUrl, token, mode: 'card', source: 'env' }
}

export function isMagicPushEnabled(): boolean {
  return readMagicPushSettings() !== null
}

// ---------------------------------------------------------------- 任务运行记录

const runHistory: Map<string, TaskRunRecord[]> = new Map()

/** 任务运行历史保留天数 */
export const RUN_HISTORY_DAYS = 30
let runHistoryPath: string | null = null

function nowIso(): string {
  return new Date().toISOString()
}

function persistRunHistory(): void {
  if (!runHistoryPath) {
    return
  }
  const records: TaskRunRecord[] = []
  for (const list of runHistory.values()) {
    records.push(...list)
  }
  records.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
  try {
    const tmp = `${runHistoryPath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, records }, null, 2), { encoding: 'utf-8', mode: 0o600 })
    // 本卷（btrfs+trimacl）新建文件默认 0000，写模式参数不生效，必须显式 chmod 后再改名
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, runHistoryPath)
    try {
      fs.chmodSync(runHistoryPath, 0o600)
    } catch {
      // 某些挂载点不支持 chmod
    }
  } catch {
    // 落盘失败不影响任务本身，只是重启后日报会缺历史
  }
}

/**
 * 初始化任务历史存储：读回 run-history.json，丢弃超过 RUN_HISTORY_DAYS 的记录。
 * 容器重启后日报仍能拿到当天已执行过的任务，而不是一片「未执行」。
 */
export function initRunHistory(configDir: string): void {
  runHistoryPath = path.join(configDir, 'run-history.json')
  let raw: string
  try {
    raw = fs.readFileSync(runHistoryPath, 'utf-8')
  } catch {
    return
  }
  let parsed: { records?: unknown }
  try {
    parsed = JSON.parse(raw) as { records?: unknown }
  } catch {
    return
  }
  if (!Array.isArray(parsed.records)) {
    return
  }
  const cutoff = new Date(Date.now() - (RUN_HISTORY_DAYS - 1) * 24 * 60 * 60 * 1000)
  const cutoffKey = shanghaiDayKey(cutoff)
  for (const item of parsed.records as TaskRunRecord[]) {
    if (!item || typeof item.type !== 'string' || typeof item.finishedAt !== 'string') {
      continue
    }
    if (shanghaiDayKey(item.finishedAt) < cutoffKey) {
      continue
    }
    const list = runHistory.get(item.type) || []
    list.push(item)
    runHistory.set(item.type, list)
  }
  for (const [type, list] of runHistory) {
    list.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
    runHistory.set(type, list.slice(-MAX_RUNS_PER_TASK))
  }
  // 读回时就把过期记录从磁盘抹掉，避免文件无限增长
  persistRunHistory()
}

/** 记录一次任务执行结果（不再单独推送，只进当日汇总） */
export function recordTaskRun(args: {
  type: TaskType
  ok: boolean
  startedAt: string
  error?: unknown
  logs: string[]
}): TaskRunRecord {
  const record: TaskRunRecord = {
    type: args.type,
    label: getTaskLabel(args.type),
    startedAt: args.startedAt,
    finishedAt: nowIso(),
    ok: args.ok,
    error: args.error === undefined ? undefined : errorMessage(args.error),
    logs: args.logs.slice(-MAX_LOGS_PER_RUN),
  }
  const list = runHistory.get(args.type) || []
  list.push(record)
  if (list.length > MAX_RUNS_PER_TASK) {
    list.shift()
  }
  runHistory.set(args.type, list)
  persistRunHistory()
  return record
}

/** 上海时区的日期键（YYYY-MM-DD） */
function shanghaiDayKey(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/** 取某任务今天最后一次执行记录 */
export function getTodayLastRun(type: string): TaskRunRecord | undefined {
  const today = shanghaiDayKey(new Date())
  const list = runHistory.get(type) || []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (shanghaiDayKey(list[i].finishedAt) === today) {
      return list[i]
    }
  }
  return undefined
}

export function getAllTodayRuns(): Record<string, TaskRunRecord | undefined> {
  return TASK_TYPES.reduce<Record<string, TaskRunRecord | undefined>>((acc, type) => {
    acc[type] = getTodayLastRun(type)
    return acc
  }, {})
}

export function clearRunHistory(): void {
  runHistory.clear()
  if (runHistoryPath) {
    try {
      fs.rmSync(runHistoryPath, { force: true })
    } catch {
      // 忽略
    }
  }
}

// ---------------------------------------------------------------- 卡片构造

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

function formatDuration(record: TaskRunRecord): string {
  const ms = new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) {
    return '-'
  }
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`
}

function buildCard(options: {
  title: string
  subtitle?: string
  tags?: CardTag[]
  elements: CardElement[]
}): Record<string, unknown> {
  const header: Record<string, unknown> = {
    title: { tag: 'plain_text', content: options.title.slice(0, 100) },
    template: CARD_TEMPLATE,
  }
  if (options.subtitle) {
    header.subtitle = { tag: 'plain_text', content: options.subtitle.slice(0, 80) }
  }
  if (options.tags?.length) {
    header.text_tag_list = options.tags.slice(0, 3).map(tag => ({
      tag: 'text_tag',
      text: { tag: 'plain_text', content: tag.text },
      color: tag.color,
    }))
  }
  return {
    schema: '2.0',
    header,
    body: { elements: options.elements },
  }
}

/**
 * 推送一张飞书卡片。卡片被拒（400 / 业务失败）时自动降级成 markdown 文本，
 * 保证通知不丢。
 */
export async function sendCard(args: {
  title: string
  subtitle?: string
  tags?: CardTag[]
  elements: CardElement[]
  /** 首选卡片被拒时的第二版元素（例如去掉折叠面板），仍然失败才降级成文本 */
  retryElements?: CardElement[]
  fallbackText: string
}): Promise<{ ok: boolean, error?: string }> {
  const settings = readMagicPushSettings()
  if (!settings) {
    return { ok: false, error: '未配置 MAGICPUSH_URL / MAGICPUSH_TOKEN' }
  }

  const url = `${settings.baseUrl}/api/push/${encodeURIComponent(settings.token)}`
  const card = buildCard(args)

  if (settings.mode === 'text') {
    return await sendText(url, args.title, args.fallbackText)
  }

  const attempts: Array<{ elements: CardElement[], label: string }> = [
    { elements: args.elements, label: '完整卡片' },
    ...(args.retryElements ? [{ elements: args.retryElements, label: '简化卡片' }] : []),
  ]

  for (const attempt of attempts) {
    const payload = attempt.label === '完整卡片' && attempts.length > 1
      ? card
      : buildCard({ title: args.title, subtitle: args.subtitle, tags: args.tags, elements: attempt.elements })

    try {
      const resp = await axios.post(url, {
        title: args.title.slice(0, 200),
        content: args.fallbackText,
        type: 'text',
        extraData: { feishu: { channelType: 'interactive_card', card: payload } },
      }, { timeout: NOTIFY_TIMEOUT_MS })

      if (resp.data?.success !== false) {
        return { ok: true }
      }
      const message = String(resp.data?.message || '卡片被拒收')
      console.error(`[通知] ${attempt.label}推送被拒: ${message}`)
    } catch (error: unknown) {
      console.error(`[通知] ${attempt.label}推送异常: ${errorMessage(error)}`)
    }
  }

  console.error('[通知] 卡片全部失败，降级为文本')

  try {
    const resp = await axios.post(url, {
      title: args.title.slice(0, 200),
      content: args.fallbackText,
      type: 'markdown',
    }, { timeout: NOTIFY_TIMEOUT_MS })
    if (resp.data?.success === false) {
      return { ok: false, error: String(resp.data?.message || '推送失败') }
    }
    return { ok: true }
  } catch (error: unknown) {
    return { ok: false, error: errorMessage(error) }
  }
}

// ---------------------------------------------------------------- 登录态区块

function cookieStatusRows(status: CookieStatusSummary): Array<{ item: string, state: string, detail: string }> {
  const rows: Array<{ item: string, state: string, detail: string }> = []

  rows.push({
    item: 'LTP0 长效凭证',
    state: status.ltp0Present ? '正常' : '缺失',
    detail: status.ltp0Present ? '可自动续期' : '需要重新扫码登录',
  })

  rows.push({
    item: '主站登录态',
    state: status.mainReady ? '正常' : '不完整',
    detail: status.mainReady ? 'acf_* 字段齐全' : `缺少 ${status.mainMissingKeys.join(', ')}`,
  })

  rows.push({
    item: '鱼吧登录态',
    state: status.yubaReady ? '正常' : '不完整',
    detail: status.yubaReady ? '可用于鱼吧签到' : `缺少 ${status.yubaMissingKeys.join(', ')}`,
  })

  rows.push({
    item: 'Cookie 数量',
    state: String(status.cookieCount),
    detail: status.source === 'cookieCloud' ? '来源 CookieCloud' : '来源本地扫码快照',
  })

  return rows
}

/** 构造「登录状态」卡片元素（表格 + 更新时间脚注） */
export function buildCookieStatusElements(status: CookieStatusSummary | undefined): CardElement[] {
  if (!status) {
    return [
      { tag: 'markdown', content: '**🍪 登录状态**\n<font color=\'grey\'>未获取到登录态信息</font>' },
    ]
  }

  if (status.error) {
    return [
      { tag: 'markdown', content: '**🍪 登录状态**' },
      { tag: 'markdown', content: `<font color='red'>读取失败：${status.error.slice(0, 120)}</font>` },
    ]
  }

  const healthy = status.ltp0Present && status.mainReady
  const elements: CardElement[] = [
    {
      tag: 'markdown',
      content: healthy
        ? `**🍪 登录状态** · <font color='green'>✅ 正常</font>`
        : `**🍪 登录状态** · <font color='red'>⚠️ 需要处理</font>`,
    },
    {
      tag: 'table',
      page_size: 5,
      row_height: 'low',
      header_style: { background_style: 'orange', bold: true, text_align: 'left' },
      columns: [
        { name: 'item', display_name: '项目', data_type: 'text' },
        { name: 'state', display_name: '状态', data_type: 'text' },
        { name: 'detail', display_name: '说明', data_type: 'text' },
      ],
      rows: cookieStatusRows(status),
    },
  ]

  if (status.updatedAt) {
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>快照更新：${formatTime(status.updatedAt)}</font>`,
    })
  }

  return elements
}

function cookieStatusText(status: CookieStatusSummary | undefined): string {
  if (!status) {
    return '登录状态：未获取'
  }
  if (status.error) {
    return `登录状态：读取失败（${status.error}）`
  }
  return [
    `登录状态：LTP0 ${status.ltp0Present ? '正常' : '缺失'} · 主站 ${status.mainReady ? '正常' : '不完整'} · 鱼吧 ${status.yubaReady ? '正常' : '不完整'}`,
    `Cookie 数量 ${status.cookieCount}${status.updatedAt ? ` · 快照更新 ${formatTime(status.updatedAt)}` : ''}`,
  ].join('；')
}

async function sendText(url: string, title: string, content: string): Promise<{ ok: boolean, error?: string }> {
  try {
    const resp = await axios.post(url, {
      title: title.slice(0, 200),
      content,
      type: 'markdown',
    }, { timeout: NOTIFY_TIMEOUT_MS })
    if (resp.data?.success === false) {
      return { ok: false, error: String(resp.data?.message || '推送失败') }
    }
    return { ok: true }
  } catch (error: unknown) {
    return { ok: false, error: errorMessage(error) }
  }
}

// ---------------------------------------------------------------- 每日汇总

function statusLabel(record: TaskRunRecord | undefined): { text: string, color: string } {
  if (!record) {
    return { text: '今日未执行', color: 'grey' }
  }
  return record.ok ? { text: '成功', color: 'green' } : { text: '失败', color: 'red' }
}

function lastLogLine(record: TaskRunRecord | undefined): string {
  if (!record) {
    return '—'
  }
  const line = record.logs[record.logs.length - 1]
  return line ? line.replace(/\|/g, '\\|').slice(0, 60) : '—'
}

/** 构造「今日任务执行汇总」卡片 */
/** 只有时间（HH:mm），日报里表头已经写了「执行」，日期是摘要行 */
function formatClock(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '—'
  }
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

/**
 * 登录类失败的特征词。斗鱼失效时的报错文案在不同链路不一样
 * （cookie 缺失、LTP0 过期、safeAuth 续期失败、接口 401、CSRF/Gee 风控），
 * 这里做宽松匹配，宁可多报一次「疑似失效」也不要漏报。
 */
const LOGIN_FAILURE_PATTERN = /登录|登陆|cookie|Cookie|LTP0|扫码|acf_|dy_auth|凭证|未授权|401/

function isLoginFailure(record: TaskRunRecord | undefined): boolean {
  if (!record || record.ok) {
    return false
  }
  return LOGIN_FAILURE_PATTERN.test(record.error || '')
}

/**
 * 日报顶部的登录态健康条（单行）。
 *
 * 为什么不能写「剩余 N 天」：`LTP0` 不是 JWT，斗鱼也不下发带有效期的字段，
 * 本地无法算出过期时间。所以只报告能证实的东西——结构完整性 + 今天是否真的
 * 因为登录失败过。任何一个任务因登录类错误失败，就按「已失效」报，不粉饰。
 */
export function buildCookieHealthLine(
  status: CookieStatusSummary | undefined,
  options: { failedRecords: TaskRunRecord[], yubaEnabled: boolean },
): string {
  if (!status) {
    return '🔑 <font color=\'grey\'>Cookie 状态未知</font>'
  }

  const loginFailures = options.failedRecords.filter(record => isLoginFailure(record)).length

  if (status.error) {
    return `🔑 <font color='red'>Cookie 已失效 ❌ · ${status.error.slice(0, 60)} · 请到 WebUI 扫码</font>`
  }

  if (loginFailures > 0) {
    return `🔑 <font color='red'>Cookie 已失效 ❌ · ${loginFailures} 个任务因登录失败 · 请到 WebUI 扫码</font>`
  }

  if (!status.ltp0Present) {
    return '🔑 <font color=\'red\'>Cookie 疑似失效 ⚠️ · 缺少 LTP0 长效凭证 · 无法自动续期</font>'
  }

  if (!status.mainReady) {
    const missing = status.mainMissingKeys.slice(0, 3).join('、') || '未知字段'
    return `🔑 <font color='red'>Cookie 字段不全 ⚠️ · 缺少 ${missing} · 建议重新扫码</font>`
  }

  if (options.yubaEnabled && !status.yubaReady) {
    const missing = status.yubaMissingKeys.slice(0, 3).join('、') || '未知字段'
    return `🔑 主站 <font color='green'>有效</font> · 鱼吧缺 ${missing}`
  }

  return '🔑 Cookie <font color=\'green\'>有效</font> · LTP0 正常 · 主站齐全'
}

/**
 * 日报卡片（2026-10-19 定稿，用户选定 B-2）。
 *
 * 版式：登录态健康条置顶 → 3 列任务表（任务/执行/结果）→ 底部一行统计。
 * 登录态放第一行的理由：Cookie 失效是唯一会让所有任务一起挂的故障，
 * 置顶能一眼分清「任务真的没问题」和「全都因为没登录而失败」。
 *
 * 相比旧版删掉了「计划(cron)」「耗时」「摘要(日志末行)」三列：
 * cron 表达式在手机上会把列宽撑开，日志末行经常是半句废话。
 * 结果列改用 buildTaskRunSummary() 抽出的结构化结论。
 */
export function buildDailyReportCard(config: DockerConfig | null, cookieStatus?: CookieStatusSummary): { title: string, subtitle: string, tags: CardTag[], elements: CardElement[], fallbackText: string } {
  const enabledTasks = TASK_TYPES
    .map(type => ({ type, config: getTaskConfig(config, type) }))
    .filter(item => isTaskEnabled(item.config))

  const runs = getAllTodayRuns()
  const okCount = enabledTasks.filter(item => runs[item.type]?.ok).length
  const failCount = enabledTasks.filter(item => runs[item.type] && !runs[item.type]!.ok).length
  const idleCount = enabledTasks.length - okCount - failCount
  const failedRecords = enabledTasks.map(item => runs[item.type]).filter((item): item is TaskRunRecord => Boolean(item && !item.ok))

  const today = shanghaiDayKey(new Date())
  const yubaEnabled = enabledTasks.some(item => item.type === 'yubaCheckIn')

  const rows = enabledTasks.map((item) => {
    const record = runs[item.type]
    if (!record) {
      return { task: getTaskLabel(item.type), when: '—', result: '⚪ 未执行' }
    }
    const summary = buildTaskRunSummary(record)
    const icon = record.ok ? '✅' : '❌'
    return {
      task: getTaskLabel(item.type),
      when: formatClock(record.finishedAt),
      result: `${icon} ${summary.headline.slice(0, 40)}`,
    }
  })

  const healthLine = buildCookieHealthLine(cookieStatus, { failedRecords, yubaEnabled })
  const loginBroken = failedRecords.filter(record => isLoginFailure(record)).length > 0
    || Boolean(cookieStatus && (cookieStatus.error || !cookieStatus.ltp0Present || !cookieStatus.mainReady))

  const elements: CardElement[] = [
    { tag: 'markdown', content: healthLine },
    { tag: 'hr' },
  ]

  if (rows.length > 0) {
    elements.push({
      tag: 'table',
      page_size: 10,
      row_height: 'low',
      header_style: { background_style: 'orange', bold: true, text_align: 'left' },
      columns: [
        { name: 'task', display_name: '任务', data_type: 'text' },
        { name: 'when', display_name: '执行', data_type: 'text' },
        { name: 'result', display_name: '结果', data_type: 'text' },
      ],
      rows,
    })
  } else {
    elements.push({ tag: 'markdown', content: '<font color=\'grey\'>当前没有已启用的任务</font>' })
  }

  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'markdown',
    content: `${enabledTasks.length} 个任务 · <font color='green'>成功 ${okCount}</font>`
      + ` · <font color='red'>失败 ${failCount}</font>`
      + ` · <font color='grey'>未执行 ${idleCount}</font>`,
  })

  if (failedRecords.length > 0) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: '**❌ 失败原因**' })
    for (const item of enabledTasks) {
      const record = runs[item.type]
      if (!record || record.ok) {
        continue
      }
      elements.push({
        tag: 'markdown',
        content: `**${getTaskLabel(item.type)}**：<font color='red'>${(record.error || '未知错误').slice(0, 200)}</font>`,
      })
    }
  }

  const healthText = healthLine.replace(/<[^>]+>/g, '')

  const fallbackText = [
    `**斗鱼任务日报 ${today}**`,
    healthText,
    ...rows.map(row => `- ${row.task}（${row.when}）：${row.result}`),
    '',
    `${enabledTasks.length} 个任务：成功 ${okCount} · 失败 ${failCount} · 未执行 ${idleCount}`,
    ...(failedRecords.length
      ? ['', '失败原因：', ...enabledTasks
          .filter(item => runs[item.type] && !runs[item.type]!.ok)
          .map(item => `- ${getTaskLabel(item.type)}：${runs[item.type]!.error || '未知错误'}`)]
      : []),
  ].join('\n')

  return {
    title: '斗鱼任务日报',
    subtitle: `${today} · 已启用 ${enabledTasks.length} 个任务`,
    tags: [
      { text: failCount > 0 ? `❌ ${failCount} 个失败` : '✅ 全部正常', color: failCount > 0 ? 'red' : 'green' },
      loginBroken
        ? { text: '🔑 登录态异常', color: 'red' }
        : { text: '每日汇总', color: 'orange' },
    ],
    elements,
    fallbackText,
  }
}

/** 立即推送一次今日汇总 */
export async function sendDailyReport(config: DockerConfig | null, cookieStatus?: CookieStatusSummary): Promise<{ ok: boolean, error?: string }> {
  const report = buildDailyReportCard(config, cookieStatus)
  return await sendCard({
    title: report.title,
    subtitle: report.subtitle,
    tags: report.tags,
    elements: report.elements,
    fallbackText: report.fallbackText,
  })
}

// ---------------------------------------------------------------- 单次任务结果

/** 手动触发任务后即时推送的执行结果卡片 */
/** 一条日志转 markdown 列表项，管道符要转义否则会被当成表格分隔 */
function logBullet(line: string): string {
  return `- ${line.replace(/\|/g, '\\|')}`
}

/**
 * 可折叠面板（飞书卡片 2.0 collapsible_panel）。
 * 完整日志默认收起，只有想看细节时才展开——避免卡片一屏全是日志。
 */
function collapsibleLogs(logs: string[], title: string): CardElement {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: `**${title}**` },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: logs.map(logBullet).join('\n') }],
  }
}

/** 关键数据表：只放一眼要看的信息，字段抽不到就不出现 */
function summaryTable(rows: Array<{ item: string, value: string }>): CardElement {
  return {
    tag: 'table',
    page_size: 8,
    row_height: 'low',
    header_style: { background_style: 'orange', bold: true, text_align: 'left' },
    columns: [
      { name: 'item', display_name: '项目', data_type: 'text' },
      { name: 'value', display_name: '内容', data_type: 'text' },
    ],
    rows,
  }
}

/**
 * 单次任务结果卡片。
 *
 * 模板（用户 2026-10-19 选定）：
 * - 成功：关键数据表 + 全部日志收进折叠面板，卡片常态只有 5-7 行
 * - 失败：错误原因 + 末尾 3 条日志（平铺，不用折叠），排错时不用再点一下
 */
export async function sendTaskRunCard(record: TaskRunRecord, trigger: 'manual' | 'scheduled'): Promise<{ ok: boolean, error?: string }> {
  const summary = buildTaskRunSummary(record)
  const statusTag = record.ok
    ? { text: '✅ 执行成功', color: 'green' }
    : { text: '❌ 执行失败', color: 'red' }

  const rows = [
    ...summary.rows,
    { item: '耗时', value: formatDuration(record) },
    { item: '开始', value: formatTime(record.startedAt) },
  ]

  const elements: CardElement[] = [summaryTable(rows)]

  if (record.ok) {
    if (record.logs.length > 0) {
      elements.push(collapsibleLogs(record.logs, `执行日志（${record.logs.length} 条）`))
    }
  } else {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'markdown',
      content: `**错误**：<font color='red'>${(record.error || '未知错误').slice(0, 300)}</font>`,
    })
    const tail = record.logs.slice(-3)
    if (tail.length > 0) {
      elements.push({ tag: 'markdown', content: `**最后 ${tail.length} 条日志**` })
      elements.push({ tag: 'markdown', content: tail.map(logBullet).join('\n') })
    }
  }

  // 折叠面板被飞书拒绝时的退路：关键数据表 + 首尾各 2 条日志（平铺）
  const plainLogs = record.logs.length > 4
    ? [...record.logs.slice(0, 2), `…中间省略 ${record.logs.length - 4} 条…`, ...record.logs.slice(-2)]
    : record.logs
  const retryElements: CardElement[] = [
    summaryTable(rows),
    ...(plainLogs.length > 0
      ? [{ tag: 'markdown', content: '**执行日志**' }, { tag: 'markdown', content: plainLogs.map(logBullet).join('\n') }]
      : []),
  ]

  const fallbackText = [
    `**斗鱼 ${record.label}${record.ok ? '成功' : '失败'}**`,
    `触发方式：${trigger === 'manual' ? '手动执行' : '定时执行'}`,
    summary.headline,
    `耗时 ${formatDuration(record)}`,
    ...(record.ok ? [] : [`错误：${record.error || '未知错误'}`]),
  ].join('\n')

  return await sendCard({
    title: `斗鱼 ${record.label}${record.ok ? '执行成功' : '执行失败'}`,
    subtitle: `${trigger === 'manual' ? '手动执行' : '定时执行'} · ${formatTime(record.finishedAt)}`,
    tags: [statusTag, { text: '单次任务', color: 'orange' }],
    elements,
    retryElements,
    fallbackText,
  })
}

/** 渠道连通性测试 */
export async function sendTestCard(): Promise<{ ok: boolean, error?: string }> {
  const settings = readMagicPushSettings()
  if (!settings) {
    return { ok: false, error: '未配置推送渠道（地址或令牌为空）' }
  }
  return await sendCard({
    title: '斗鱼保活 · 推送测试',
    subtitle: `渠道来源：${settings.source === 'config' ? '界面配置' : '环境变量'}`,
    tags: [{ text: '🔔 测试消息', color: 'orange' }],
    elements: [
      { tag: 'markdown', content: '**这是一条测试推送**' },
      {
        tag: 'markdown',
        content: [
          `- 网关地址：${settings.baseUrl}`,
          `- 消息模式：${settings.mode === 'card' ? '飞书交互卡片' : 'Markdown 文本'}`,
          '- 收到本条说明渠道配置可用',
        ].join('\n'),
      },
    ],
    fallbackText: `**斗鱼保活 · 推送测试**\n网关 ${settings.baseUrl}，模式 ${settings.mode}。收到本条说明渠道配置可用。`,
  })
}

// ---------------------------------------------------------------- 登录类提醒

export async function notifyLoginRequired(port: string | number): Promise<void> {
  await sendCard({
    title: '斗鱼保活任务需要登录',
    subtitle: '未检测到登录凭证',
    tags: [{ text: '⚠️ 需要处理', color: 'orange' }],
    elements: [
      { tag: 'markdown', content: '**状态**：未检测到斗鱼登录凭证，已启用的任务不会执行' },
      { tag: 'hr' },
      { tag: 'markdown', content: `**处理**：打开 <font color='orange'>http://<NAS-IP>:${port}</font> 使用斗鱼 App 扫码登录` },
      { tag: 'markdown', content: '<font color=\'grey\'>登录后任务会自动恢复运行，无需重启容器。</font>' },
    ],
    fallbackText: `**斗鱼保活任务需要登录**\n未检测到登录凭证，已启用任务不会执行。\n请打开 http://<NAS-IP>:${port} 扫码登录。`,
  })
}

export async function notifyLoginSuccess(): Promise<void> {
  await sendCard({
    title: '斗鱼扫码登录成功',
    subtitle: '登录快照已保存',
    tags: [{ text: '✅ 已登录', color: 'green' }],
    elements: [
      { tag: 'markdown', content: '**状态**：主站登录态已保存，任务可自动执行' },
      { tag: 'markdown', content: '<font color=\'grey\'>凭证由 safeAuth 自动续期；失效时会再次提醒。</font>' },
    ],
    fallbackText: '**斗鱼扫码登录成功**\n主站登录态已保存，后续任务可自动执行。',
  })
}
