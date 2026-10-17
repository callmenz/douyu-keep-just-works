import { CronJob } from 'cron'
import type { DockerConfig } from '../core/types'
import { DOCKER_TIMEZONE } from './runtime-constants'
import { buildCookieStatus } from './runtime-cookie-status'
import { sendDailyReport } from './runtime-notify'

const REPORT_JOB_NAME = '每日推送汇总'

interface DockerReportSchedulerDeps {
  getConfig: () => DockerConfig | null
  getConfigPath: () => string
  logSystem: (message: string) => void
}

function formatScheduleForLog(iso?: string): string {
  if (!iso) {
    return '-'
  }
  return iso.replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 19)
}

/**
 * 「推送设置」的调度器：按配置里的 cron 每天推一次当日任务汇总。
 * 与业务任务调度器分开，避免影响任务锁与状态缓存。
 */
export class DockerReportScheduler {
  private job: CronJob | null = null
  private cron = ''
  private enabled = false

  constructor(private readonly deps: DockerReportSchedulerDeps) {}

  getNextRun(): string | undefined {
    return this.job?.nextDate()?.toISO() ?? undefined
  }

  reconcile(config: DockerConfig | null): void {
    const next = config?.pushReport
    const enabled = Boolean(next?.enabled)
    const cron = next?.cron || ''

    if (!enabled) {
      if (this.job) {
        this.stop()
        this.deps.logSystem(`推送汇总已停用`)
      }
      this.enabled = false
      this.cron = cron
      return
    }

    if (this.job && this.cron === cron) {
      this.enabled = true
      return
    }

    this.stop()
    this.enabled = true
    this.cron = cron

    try {
      this.job = new CronJob(cron, () => {
        void this.run()
      }, null, false, DOCKER_TIMEZONE)
      this.job.start()
      this.deps.logSystem(`${REPORT_JOB_NAME}已启动, cron: ${cron}, 下次执行: ${formatScheduleForLog(this.job.nextDate()?.toISO() ?? undefined)}`)
    } catch (error: unknown) {
      this.job = null
      this.deps.logSystem(`${REPORT_JOB_NAME}启动失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async run(): Promise<void> {
    const config = this.deps.getConfig()
    this.deps.logSystem(`${REPORT_JOB_NAME}开始推送`)
    const cookieStatus = buildCookieStatus(config, this.deps.getConfigPath())
    const result = await sendDailyReport(config, cookieStatus)
    if (result.ok) {
      this.deps.logSystem(`${REPORT_JOB_NAME}推送完成`)
    } else {
      this.deps.logSystem(`${REPORT_JOB_NAME}推送失败: ${result.error || '未知错误'}`)
    }
  }

  stop(): void {
    if (this.job) {
      this.job.stop()
      this.job = null
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }
}
