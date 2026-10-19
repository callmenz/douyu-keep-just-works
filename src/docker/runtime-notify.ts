import type { CookieStatusSummary, DockerConfig, PushChannelConfig, TaskRunRecord } from '../core/types'
import * as fs from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'
import axios from 'axios'
import { errorMessage } from '../core/errors'
import { getTaskConfig, getTaskLabel, isTaskEnabled, TASK_TYPES } from './task-metadata'
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

  try {
    const resp = await axios.post(url, {
      title: args.title.slice(0, 200),
      content: args.fallbackText,
      type: 'text',
      extraData: { feishu: { channelType: 'interactive_card', card } },
    }, { timeout: NOTIFY_TIMEOUT_MS })

    if (resp.data?.success !== false) {
      return { ok: true }
    }
    const message = String(resp.data?.message || '卡片被拒收')
    console.error(`[通知] 卡片推送失败，降级为文本: ${message}`)
  } catch (error: unknown) {
    console.error(`[通知] 卡片推送异常，降级为文本: ${errorMessage(error)}`)
  }

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
export function buildDailyReportCard(config: DockerConfig | null, cookieStatus?: CookieStatusSummary): { title: string, subtitle: string, tags: CardTag[], elements: CardElement[], fallbackText: string } {
  const enabledTasks = TASK_TYPES
    .map(type => ({ type, config: getTaskConfig(config, type) }))
    .filter(item => isTaskEnabled(item.config))

  const runs = getAllTodayRuns()
  const okCount = enabledTasks.filter(item => runs[item.type]?.ok).length
  const failCount = enabledTasks.filter(item => runs[item.type] && !runs[item.type]!.ok).length
  const idleCount = enabledTasks.length - okCount - failCount

  const today = shanghaiDayKey(new Date())
  const rows = enabledTasks.map((item) => {
    const record = runs[item.type]
    const status = statusLabel(record)
    return {
      task: getTaskLabel(item.type),
      schedule: item.config?.cron || '-',
      last_run: record ? formatTime(record.finishedAt) : '—',
      duration: record ? formatDuration(record) : '—',
      status: status.text,
      detail: lastLogLine(record),
    }
  })

  const elements: CardElement[] = [
    {
      tag: 'markdown',
      content: [
        `**📅 ${today}** · 已启用 **${enabledTasks.length}** 个任务`,
        `<font color='green'>成功 ${okCount}</font> · <font color='red'>失败 ${failCount}</font> · <font color='grey'>未执行 ${idleCount}</font>`,
      ].join('\n'),
    },
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
        { name: 'schedule', display_name: '计划', data_type: 'text' },
        { name: 'last_run', display_name: '最近执行', data_type: 'text' },
        { name: 'duration', display_name: '耗时', data_type: 'text' },
        { name: 'status', display_name: '结果', data_type: 'text' },
        { name: 'detail', display_name: '摘要', data_type: 'text' },
      ],
      rows,
    })
  } else {
    elements.push({ tag: 'markdown', content: '<font color=\'grey\'>当前没有已启用的任务</font>' })
  }

  // 登录状态：放在任务表之后，单独一段
  elements.push({ tag: 'hr' })
  elements.push(...buildCookieStatusElements(cookieStatus))

  const failed = enabledTasks.filter(item => runs[item.type] && !runs[item.type]!.ok)
  if (failed.length > 0) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: '**❌ 失败原因**' })
    for (const item of failed) {
      const record = runs[item.type]!
      elements.push({
        tag: 'markdown',
        content: `**${getTaskLabel(item.type)}**：<font color='red'>${(record.error || '未知错误').slice(0, 200)}</font>`,
      })
    }
  }

  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'markdown',
    content: `<font color='grey'>🤖 douyu-keep-just-works · 汇总时间 ${formatTime(new Date().toISOString())}</font>`,
  })

  const fallbackText = [
    `**斗鱼任务日报 ${today}**`,
    `已启用 ${enabledTasks.length} 个任务：成功 ${okCount} · 失败 ${failCount} · 未执行 ${idleCount}`,
    ...rows.map(row => `- ${row.task}（${row.schedule}）：${row.status} · ${row.last_run} · ${row.detail}`),
    '',
    cookieStatusText(cookieStatus),
  ].join('\n')

  return {
    title: '斗鱼任务日报',
    subtitle: `${today} · 已启用 ${enabledTasks.length} 个任务`,
    tags: [
      { text: failCount > 0 ? `❌ ${failCount} 个失败` : '✅ 全部正常', color: failCount > 0 ? 'red' : 'green' },
      cookieStatus && !cookieStatus.error && !cookieStatus.ltp0Present
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
export async function sendTaskRunCard(record: TaskRunRecord, trigger: 'manual' | 'scheduled'): Promise<{ ok: boolean, error?: string }> {
  const statusTag = record.ok
    ? { text: '✅ 执行成功', color: 'green' }
    : { text: '❌ 执行失败', color: 'red' }

  const logs = record.logs.slice(-10)
  const elements: CardElement[] = [
    {
      tag: 'markdown',
      content: [
        `**触发方式**：${trigger === 'manual' ? '手动执行' : '定时执行'}`,
        `**开始时间**：${formatTime(record.startedAt)}`,
        `**耗时**：${formatDuration(record)}`,
        `**结果**：${record.ok ? '<font color=\'green\'>成功</font>' : '<font color=\'red\'>失败</font>'}`,
      ].join('\n'),
    },
  ]

  if (!record.ok && record.error) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: `**错误**：<font color='red'>${record.error.slice(0, 300)}</font>` })
  }

  if (logs.length > 0) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: '**执行日志**' })
    elements.push({
      tag: 'markdown',
      content: logs.map(line => `- ${line.replace(/\|/g, '\\|')}`).join('\n'),
    })
  }

  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'markdown',
    content: `<font color='grey'>🤖 douyu-keep-just-works · ${formatTime(new Date().toISOString())}</font>`,
  })

  const fallbackText = [
    `**斗鱼 ${record.label}${record.ok ? '成功' : '失败'}**`,
    `触发方式：${trigger === 'manual' ? '手动执行' : '定时执行'}`,
    `开始：${formatTime(record.startedAt)} · 耗时 ${formatDuration(record)}`,
    ...(record.ok ? [] : [`错误：${record.error || '未知错误'}`]),
    ...(logs.length ? ['', '执行日志：', ...logs.map(line => `- ${line}`)] : []),
  ].join('\n')

  return await sendCard({
    title: `斗鱼 ${record.label}${record.ok ? '执行成功' : '执行失败'}`,
    subtitle: `${trigger === 'manual' ? '手动执行' : '定时执行'} · ${formatTime(record.finishedAt)}`,
    tags: [statusTag, { text: '单次任务', color: 'orange' }],
    elements,
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
