import type { MicrosoftRewardsBot } from '../index'

/**
 * 出网抖动兜底（2026-11-18 新增）
 *
 * 背景：2026-11-17 的定时任务里，账号 Angescocoty 在 17:56–18:05 遇到节点 TLS 抖动：
 * 桌面搜索拿 0/90，末尾查余额又抛错，整号被记成失败（已到账的 115 分也没进汇总）。
 * 这类抖动通常几分钟就过去，直接判失败既丢分又误导上报。
 *
 * 策略：一旦识别为「出网抖动」（TLS 断连 / 连接重置 / 连接超时 / 代理连不上 等），
 * 不立刻放弃，而是每 2 分钟探测一次节点（走账号自己的代理访问 bing），
 * 恢复后由调用方把没做完的步骤继续做完。探测与重试的总等待有预算上限，
 * 用尽仍不通才按原错误失败，避免节点整晚不通时把主任务拖死。
 *
 * 可调环境变量：
 *   NETWORK_PROBE_INTERVAL_SECONDS   探测间隔，默认 120（2 分钟）
 *   NETWORK_RECOVERY_MAX_MINUTES     每账号累计等待预算，默认 30；设为 0 关闭兜底
 */

const DEFAULT_INTERVAL_MS = 120_000
const DEFAULT_BUDGET_MS = 30 * 60_000

function probeIntervalMs(): number {
    const raw = process.env.NETWORK_PROBE_INTERVAL_SECONDS
    if (raw === undefined) return DEFAULT_INTERVAL_MS
    const seconds = Number(raw)
    // 低于 5 秒会变成忙等，没意义
    return Number.isFinite(seconds) && seconds >= 5 ? seconds * 1000 : DEFAULT_INTERVAL_MS
}

function recoveryBudgetMs(): number {
    const raw = process.env.NETWORK_RECOVERY_MAX_MINUTES
    if (raw === undefined) return DEFAULT_BUDGET_MS
    const minutes = Number(raw)
    // 0 = 关闭兜底；负数/NaN 视为配置错误，退回默认值
    if (Number.isFinite(minutes) && minutes >= 0) return minutes * 60_000
    return DEFAULT_BUDGET_MS
}

/** 把 error 及其 cause 链上的 message/code 拼成一个小写文本，便于统一匹配 */
function errorText(error: unknown, depth = 0): string {
    if (error === null || error === undefined || depth > 3) return ''
    if (typeof error === 'string') return error
    if (error instanceof Error) {
        const code = (error as NodeJS.ErrnoException).code
        const cause = (error as Error & { cause?: unknown }).cause
        return `${error.name} ${error.message} ${code ?? ''} ${errorText(cause, depth + 1)}`
    }
    try {
        return JSON.stringify(error)
    } catch {
        return String(error)
    }
}

/**
 * 是否是「等一会儿可能自己好」的出网错误。
 *
 * 刻意不收：浏览器已关闭（`has been closed`）、HTTP 4xx/5xx（服务端拒绝）、
 * 页面元素超时（`locator.waitFor: Timeout ...`）——这些等多久都不会因为节点恢复而变好。
 */
export function isTransientNetworkError(error: unknown): boolean {
    const text = errorText(error).toLowerCase()
    if (!text) return false

    // 浏览器/页面已死属于另一类问题（见 troubleshooting §9），不要用恢复等待去拖时间
    if (
        text.includes('has been closed') ||
        text.includes('target closed') ||
        text.includes('browser has been disconnected') ||
        text.includes('page closed')
    ) {
        return false
    }

    const patterns = [
        // Node / axios / OpenSSL
        'client network socket disconnected',
        'socket hang up',
        'econnreset',
        'etimedout',
        'econnrefused',
        'epipe',
        'enetunreach',
        'ehostunreach',
        'eai_again',
        'enotfound',
        'tls connection',
        // axios 的超时文案是 "timeout of 8000ms exceeded"；
        // Playwright 的 locator 超时是 "Timeout 15000ms exceeded"，故意不匹配
        'timeout of ',
        // Chromium / Playwright 的网络错误页
        'net::err_connection_closed',
        'net::err_connection_reset',
        'net::err_connection_refused',
        'net::err_connection_timed_out',
        'net::err_connection_aborted',
        'net::err_timed_out',
        'net::err_internet_disconnected',
        'net::err_network_changed',
        'net::err_proxy_connection_failed',
        'net::err_tunnel_connection_failed',
        'net::err_empty_response',
        'net::err_socket_not_connected',
        'net::err_name_not_resolved',
        // 导航级超时（不是 locator/selector 超时）
        'page.goto: timeout',
        'navigation timeout'
    ]

    return patterns.some(p => text.includes(p))
}

interface ProbeResult {
    ok: boolean
    detail: string
}

export class NetworkRecovery {
    private remainingMs: number

    constructor(
        private bot: MicrosoftRewardsBot,
        private readonly intervalMs: number = probeIntervalMs(),
        private readonly budgetMs: number = recoveryBudgetMs()
    ) {
        this.remainingMs = budgetMs
    }

    get enabled(): boolean {
        return this.budgetMs > 0
    }

    /** 启动时打一行配置摘要，方便从 journal 判断兜底到底有没有生效 */
    describe(): string {
        if (!this.enabled) {
            return '出网抖动兜底: 已关闭（NETWORK_RECOVERY_MAX_MINUTES=0）'
        }
        return `出网抖动兜底: 每 ${Math.round(this.intervalMs / 1000)}s 探测一次节点，每账号等待预算 ${Math.round(
            this.budgetMs / 60000
        )} 分钟`
    }

    /** 每个账号开始时重置等待预算（预算按账号计，避免一个坏节点把后面账号的额度吃光） */
    reset(): void {
        this.remainingMs = this.budgetMs
    }

    /**
     * 探测节点直到恢复、达到本轮上限，或账号预算用尽。
     * @param capMs 本轮最多等多久（不传 = 用完账号剩余预算）。账号开跑前用较小上限，
     *              避免「节点整晚不通」时每个账号都先干等 30 分钟。
     * @returns true = 已恢复；false = 关闭/预算用尽/仍不通
     */
    async waitForProxy(label: string, capMs?: number): Promise<boolean> {
        if (!this.enabled || this.remainingMs <= 0) return false

        const startedAt = Date.now()
        const cap = capMs && capMs > 0 ? Math.min(capMs, this.remainingMs) : this.remainingMs
        const deadline = startedAt + cap
        let attempt = 0

        while (Date.now() < deadline) {
            attempt++
            const probe = await this.probeOnce()

            if (probe.ok) {
                const waitedSeconds = Math.round((Date.now() - startedAt) / 1000)
                this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - startedAt))
                this.bot.logger.info(
                    'main',
                    'NETWORK-RECOVERY',
                    `${label}：节点可达（探测 ${attempt} 次，用时 ${waitedSeconds}s）| ${probe.detail}`,
                    'green'
                )
                return true
            }

            const remainSeconds = Math.max(0, Math.ceil((this.remainingMs - (Date.now() - startedAt)) / 1000))
            this.bot.logger.warn(
                'main',
                'NETWORK-RECOVERY',
                `${label}：节点仍不可用，${Math.round(this.intervalMs / 1000)}s 后重探 | attempt=${attempt} | ${probe.detail} | 剩余预算 ${remainSeconds}s`
            )

            const sleepMs = Math.min(this.intervalMs, deadline - Date.now())
            if (sleepMs <= 0) break
            await this.bot.utils.wait(sleepMs)
        }

        this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - startedAt))

        if (this.remainingMs <= 0) {
            this.bot.logger.error(
                'main',
                'NETWORK-RECOVERY',
                `${label}：等待预算已用尽（${Math.round(this.budgetMs / 60000)} 分钟），恢复失败，按原错误继续`
            )
        } else {
            this.bot.logger.warn(
                'main',
                'NETWORK-RECOVERY',
                `${label}：本轮等待上限（${Math.round(cap / 60000)} 分钟）已到，节点仍未恢复，先按原流程继续`
            )
        }
        return false
    }

    /**
     * 执行一个可能受出网抖动影响的步骤：失败且判定为抖动时，等节点恢复后重试。
     * 最多 3 次尝试，总等待受 `remainingMs` 预算限制。
     */
    async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
        if (!this.enabled) return fn()

        const maxAttempts = 3
        let lastError: unknown

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await fn()
            } catch (error) {
                lastError = error
                if (!isTransientNetworkError(error)) throw error

                const message = error instanceof Error ? error.message : String(error)
                this.bot.logger.warn(
                    'main',
                    'NETWORK-JITTER',
                    `${label} 遇到出网抖动（第 ${attempt}/${maxAttempts} 次）：${message}；先不放弃，等待节点恢复`
                )

                const recovered = await this.waitForProxy(label)
                if (!recovered) throw error

                this.bot.logger.info('main', 'NETWORK-JITTER', `${label}：节点已恢复，继续未完成的步骤`)
            }
        }

        throw lastError instanceof Error ? lastError : new Error(String(lastError))
    }

    /**
     * 单次探测：用账号自己的代理出口访问 bing。
     * 只要拿到任何 HTTP 响应（含 403/302）就说明 TLS 链路通了，故 validateStatus 恒真。
     */
    private async probeOnce(): Promise<ProbeResult> {
        try {
            const response = await this.bot.axios.requestForProbe({
                url: 'https://www.bing.com/',
                method: 'GET',
                timeout: 15000,
                validateStatus: () => true
            })
            return { ok: true, detail: `HTTP ${response.status}` }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { ok: false, detail: message.slice(0, 160) }
        }
    }
}