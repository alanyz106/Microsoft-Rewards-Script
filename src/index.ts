import fs from 'fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import cluster, { Worker } from 'cluster'
import type { BrowserContext, Cookie, Page } from 'patchright'
import pkg from '../package.json'

import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

import Browser from './browser/Browser'
import BrowserFunc from './browser/BrowserFunc'
import BrowserUtils from './browser/BrowserUtils'

import { IpcLog, Logger } from './logging/Logger'
import Utils from './util/Utils'
import { loadAccounts, loadConfig } from './util/Load'
import { checkNodeVersion } from './util/Validator'
import { createShutdownHandler, runShutdownStep } from './util/Shutdown'

import { Login } from './browser/auth/Login'
import { Workers } from './functions/Workers'
import Activities from './functions/Activities'
import { SearchManager } from './functions/SearchManager'
import { isTransientNetworkError, NetworkRecovery } from './functions/NetworkRecovery'
import { diffTaskBreakdown, readTaskProgress } from './functions/TaskBreakdown'
import type { TaskBreakdown, TaskProgressSnapshot } from './functions/TaskBreakdown'
import { readMemberLevel } from './functions/MemberLevel'
import { getOrSetDayBaseline } from './util/PointsBaseline'
import type { MemberLevel } from './functions/MemberLevel'

import type { Account } from './interface/Account'
import AxiosClient from './util/Axios'
import { sendDiscord, flushDiscordQueue } from './logging/Discord'
import { sendNtfy, flushNtfyQueue } from './logging/Ntfy'
import { sendWxPusherSummary, flushWxPusherQueue } from './logging/WxPusher'
import type { AccountSummary } from './logging/WxPusher'
import type { DashboardData } from './interface/DashboardData'
import type { AppDashboardData } from './interface/AppDashBoardData'
import type { AppEarnablePoints } from './interface/Points'

// 账号分组 → mihomo 出口节点。运行期 require .dev/ 模块，主任务与查漏补缺共用一份配置。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeSwitch = require('../.dev/node-switch.js') as {
    ensureNodeForAccount: (email: string, log: (msg: string) => void) => Promise<{ node: string; group: string; changed: boolean }>
    getNow: (cfg: unknown, group?: string) => Promise<string | undefined>
    restore: (node: string | undefined, log: (msg: string) => void) => Promise<void>
    config: () => { enabled: boolean; selectorGroup: string; restoreOnExit?: boolean }
}

/** 分组模式要求 clusters=1：mihomo 只有一个全局出口，多进程并行会互相切节点串 IP。 */
function assertNodeSwitchSafe(configClusters: number): void {
    if (nodeSwitch.config().enabled && configClusters > 1) {
        throw new Error('[NODE] 分组节点模式与 clusters>1 不兼容：多个 worker 会互相切换同一个 mihomo 全局节点。请把 config.json 的 clusters 设为 1 或关闭 proxy-groups.json 的 enabled。')
    }
}


interface ExecutionContext {
    isMobile: boolean
    account: Account
}

interface BrowserSession {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

interface AccountStats {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    duration: number
    success: boolean
    error?: string
    /** 跑完了但没拿满（丢分）/ 没跑完（超时）：外层据此挑账号单独补跑 */
    incomplete?: boolean
    /** 本次运行该账号走的 mihomo 分组与出口节点（推送里展示，便于定位节点问题） */
    proxyGroup?: string
    proxyNode?: string
    /** 按任务类型拆分（桌面搜索/手机搜索/每日任务/其他活动/App/待领取），推送卡片用 */
    breakdown?: TaskBreakdown
    /** 会员等级（铜/银/金），卡片里显示在节点右边 */
    level?: MemberLevel
}

/**
 * 把本次运行结果写给外层脚本（.dev/run-daily.sh），JSON 一行。
 *
 * 用途是「主任务结束后、查漏补缺之前，把有问题的那几个号单独补跑一遍」：
 * 哪些号算有问题，只有进程内知道（超时、流程失败、跑完但丢分、余额没查到），
 * 外层 shell 从 stdout 里抠是抠不准的（2026-11-19 那一行 `Collected: +-1006`
 * 就是超时路径漏出来的僵尸日志）。所以这里结构化落盘。
 *
 * 仍然保留 `need_retry=`，兼容旧的「全部 < 200 分就整轮重跑」开关。
 */
function exportGithubOutput(stats: AccountStats[], retryOnLowPoints: boolean): void {
    const outputPath = process.env.GITHUB_OUTPUT
    if (!outputPath) return

    try {
        // 仅在配置开关打开时才参与「积分未满 200 就重跑」判定；关闭时恒为 false，外层脚本不会重跑
        const anyAccountBelow200 = retryOnLowPoints && stats.some(s => s.collectedPoints < 200)
        fs.appendFileSync(outputPath, `need_retry=${anyAccountBelow200 ? 'true' : 'false'}\n`)

        // 需要单独补跑的账号：失败（超时/流程异常）或跑完但没拿满
        const needRerun = stats
            .filter(s => !s.success || s.incomplete)
            .map(s => ({
                email: s.email,
                reason: s.error ?? (s.incomplete ? 'incomplete' : 'failed'),
                initialPoints: s.initialPoints,
                finalPoints: s.finalPoints,
                collectedPoints: s.collectedPoints,
                proxyGroup: s.proxyGroup,
                proxyNode: s.proxyNode
            }))
        fs.writeFileSync(
            `${outputPath}.rerun.json`,
            JSON.stringify({ at: new Date().toISOString(), runPoints: stats, needRerun }, null, 2) + '\n'
        )
    } catch {
        // ignore if not writable
    }
}

const executionContext = new AsyncLocalStorage<ExecutionContext>()

export function getCurrentContext(): ExecutionContext {
    const context = executionContext.getStore()
    if (!context) {
        return { isMobile: false, account: {} as Account }
    }
    return context
}

async function flushAllWebhooks(timeoutMs = 5000): Promise<void> {
    await Promise.allSettled([flushDiscordQueue(timeoutMs), flushNtfyQueue(timeoutMs), flushWxPusherQueue(timeoutMs)])
}

/** AccountStats → 推送用的 AccountSummary，两处汇总共用，避免字段漏映射 */
function toAccountSummaries(stats: AccountStats[]): AccountSummary[] {
    return stats.map(s => ({
        email: s.email,
        collectedPoints: s.collectedPoints,
        initialPoints: s.initialPoints,
        finalPoints: s.finalPoints,
        duration: s.duration,
        success: s.success,
        error: s.error,
        incomplete: s.incomplete,
        proxyGroup: s.proxyGroup,
        proxyNode: s.proxyNode,
        breakdown: s.breakdown,
        level: s.level
    }))
}

interface UserData {
    userName: string
    geoLocale: string
    langCode: string
    timezoneOffset: string
    initialPoints: number
    currentPoints: number
    gainedPoints: number
}

export class MicrosoftRewardsBot {
    public logger: Logger
    public config
    public utils: Utils
    public activities: Activities = new Activities(this)
    public browser: { func: BrowserFunc; utils: BrowserUtils }

    public mainMobilePage!: Page
    public mainDesktopPage!: Page

    public userData: UserData

    public rewardsVersion: 'legacy' | 'modern' = 'legacy'

    public accessToken = ''
    public requestToken = ''
    public cookies: { mobile: Cookie[]; desktop: Cookie[] }
    public fingerprint!: BrowserFingerprintWithHeaders

    private pointsCanCollect = 0

    private activeWorkers: number
    private exitedWorkers: number[]
    private browserFactory: Browser = new Browser(this)
    private accounts: Account[]
    private workers: Workers
    private login = new Login(this)
    private searchManager: SearchManager

    /**
     * 出网抖动兜底：节点中途连不上时按 2 分钟节奏探测，恢复后继续未完成的步骤。
     * 每个账号开始时 reset()，等待预算按账号计。
     */
    public networkRecovery: NetworkRecovery

    /**
     * 中断兜底用的进度快照。
     * 为什么需要：推送原本只在「所有账号跑完」时发一次，账号卡住/超时被杀时
     * 一条都发不出去，等同于静默失败。这里记录已完成账号，收到信号时可补发。
     */
    private completedStats: AccountStats[] = []
    private inProgressEmail: string | null = null
    private inProgressStartTime = 0
    /** 正在跑那个账号用的节点：中断推送时也要能标出来 */
    private inProgressProxyGroup: string | undefined
    private inProgressProxyNode: string | undefined

    /**
     * 正在跑的那个账号的实时进度：超时被放弃时用来「尽量把已到账的分查出来」。
     *
     * 为什么需要：2026-11-19 的 alanyz 卡了 90 分钟被硬超时收掉，超时分支直接把
     * initialPoints/finalPoints/collectedPoints 全写成 0，推送显示「0 → 0」，
     * 但那个号其实已经实打实到账 +110（手机侧活动全做完了）。这既误导用户，
     * 也把 RUN-END 的总分算少。这里的快照在超时那一刻尽力抢救真实余额。
     */
    private inProgressBalance = { initialPoints: 0, currentPoints: 0 }

    /**
     * 运行数据目录（data/）。积分日基线、锁文件都放这里，跨进程/跨重启持久。
     * 编译后 __dirname 是 <repo>/dist，其上一级即仓库根。
     */
    private dataDir(): string {
        // __dirname 在编译后是 <repo>/dist，上一层就是仓库根
        return process.env.REWARDS_DATA_DIR || require('path').join(__dirname, '..', 'data')
    }
    private inProgressCookies: Cookie[] = []
    private inProgressFingerprint: BrowserFingerprintWithHeaders | undefined
    private wxSummarySent = false

    public axios!: AxiosClient

    constructor() {
        this.userData = {
            userName: '',
            geoLocale: 'US',
            langCode: 'en',
            timezoneOffset: '60',
            initialPoints: 0,
            currentPoints: 0,
            gainedPoints: 0
        }
        this.logger = new Logger(this)
        this.accounts = []
        this.cookies = { mobile: [], desktop: [] }
        this.utils = new Utils()
        this.workers = new Workers(this)
        this.searchManager = new SearchManager(this)
        this.networkRecovery = new NetworkRecovery(this)
        this.browser = {
            func: new BrowserFunc(this),
            utils: new BrowserUtils(this)
        }
        this.config = loadConfig()
        this.activeWorkers = this.config.clusters
        this.exitedWorkers = []
    }

    get isMobile(): boolean {
        return getCurrentContext().isMobile
    }

    async initialize(): Promise<void> {
        this.accounts = loadAccounts()
    }

    async run(): Promise<void> {
        const totalAccounts = this.accounts.length
        const runStartTime = Date.now()

        assertNodeSwitchSafe(this.config.clusters)

        this.logger.info(
            'main',
            'RUN-START',
            `Starting Microsoft Rewards Script | v${pkg.version} | Accounts: ${totalAccounts} | Clusters: ${this.config.clusters}`
        )

        if (this.config.clusters > 1) {
            if (cluster.isPrimary) {
                await this.runMaster(runStartTime)
            } else {
                this.runWorker(runStartTime)
            }
        } else {
            await this.runTasks(this.accounts, runStartTime)
        }
    }

    private async runMaster(runStartTime: number): Promise<void> {
        void this.logger.info('main', 'CLUSTER-PRIMARY', `Primary process started | PID: ${process.pid}`)

        const rawChunks = this.utils.chunkArray(this.accounts, this.config.clusters)
        const accountChunks = rawChunks.filter(c => c && c.length > 0)
        this.activeWorkers = accountChunks.length

        const allAccountStats: AccountStats[] = []
        let hadWorkerFailure = false

        for (const chunk of accountChunks) {
            const worker = cluster.fork()
            worker.send?.({ chunk, runStartTime })

            worker.on('message', (msg: { __ipcLog?: IpcLog; __stats?: AccountStats[] }) => {
                if (msg.__stats) {
                    allAccountStats.push(...msg.__stats)
                }

                const log = msg.__ipcLog
                if (log && typeof log.content === 'string') {
                    const { webhook } = this.config
                    const { content, level } = log

                    // Webhooks, for later expansion?
                    if (webhook.discord?.enabled && webhook.discord.url) {
                        sendDiscord(webhook.discord.url, content, level)
                    }
                    if (webhook.ntfy?.enabled && webhook.ntfy.url) {
                        sendNtfy(webhook.ntfy, content, level)
                    }
                }
            })

            // Startup delay for clusters due to resource usage
            if (accountChunks.indexOf(chunk) !== accountChunks.length - 1) {
                await this.utils.wait(5000)
            }
        }

        const onWorkerExit = async (worker: Worker, code?: number, signal?: string): Promise<void> => {
            const { pid } = worker.process

            if (!pid || this.exitedWorkers.includes(pid)) {
                return
            }

            this.exitedWorkers.push(pid)
            this.activeWorkers -= 1

            // exit 0 = good, exit 1 = crash
            const failed = (code ?? 0) !== 0 || Boolean(signal)
            if (failed) {
                hadWorkerFailure = true
            }

            this.logger.warn(
                'main',
                'CLUSTER-WORKER-EXIT',
                `Worker ${pid} exit | Code: ${code ?? 'n/a'} | Signal: ${signal ?? 'n/a'} | Active workers: ${this.activeWorkers}`
            )

            if (this.activeWorkers <= 0) {
                const totalCollectedPoints = allAccountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
                const totalInitialPoints = allAccountStats.reduce((sum, s) => sum + s.initialPoints, 0)
                const totalFinalPoints = allAccountStats.reduce((sum, s) => sum + s.finalPoints, 0)
                const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

                this.logger.info(
                    'main',
                    'RUN-END',
                    `Completed all accounts | Accounts processed: ${allAccountStats.length} | Total points collected: +${totalCollectedPoints} | Old total: ${totalInitialPoints} → New total: ${totalFinalPoints} | Total runtime: ${totalDurationMinutes}min`,
                    'green'
                )

                const wxSummaryWorker = this.config.webhook.wxpusher
                if (wxSummaryWorker?.enabled) {
                    // 与单进程收尾一致：显式等推送落地再退出（详见下方单进程分支的注释）
                    const outcome = await runShutdownStep(
                        'WxPusher 汇总推送',
                        20_000,
                        () => sendWxPusherSummary(wxSummaryWorker, toAccountSummaries(allAccountStats)),
                        (msg: string) => this.logger.warn('main', 'WXPUSHER', msg)
                    )
                    this.logger.info('main', 'WXPUSHER', `汇总推送结果: ${outcome}`)
                }

                exportGithubOutput(allAccountStats, this.config.retryOnLowPoints)
                this.logLowPointAccounts(allAccountStats)

                await flushAllWebhooks(15_000)

                process.exit(hadWorkerFailure ? 1 : 0)
            }
        }

        cluster.on('exit', (worker, code, signal) => {
            void onWorkerExit(worker, code ?? undefined, signal ?? undefined)
        })

        cluster.on('disconnect', worker => {
            const pid = worker.process?.pid
            this.logger.warn('main', 'CLUSTER-WORKER-DISCONNECT', `Worker ${pid ?? '?'} disconnected`) // <-- Warning only
        })
    }

    /** 开关 `retryOnLowPoints` 关闭时只记 info，不再给出「会重跑」的告警 */
    private logLowPointAccounts(stats: AccountStats[]): void {
        if (!this.config.retryOnLowPoints) {
            this.logger.info('main', 'RETRY-CHECK', 'retryOnLowPoints is disabled, skipping < 200 points retry check')
            return
        }

        const lowPointAccounts = stats.filter(s => s.collectedPoints < 200)
        if (lowPointAccounts.length > 0) {
            this.logger.warn(
                'main',
                'RETRY-CHECK',
                `${lowPointAccounts.length} account(s) gained < 200 points: ${lowPointAccounts.map(a => `${a.email} (+${a.collectedPoints})`).join(', ')}`
            )
        }
    }

    private runWorker(runStartTimeFromMaster?: number): void {
        void this.logger.info('main', 'CLUSTER-WORKER-START', `Worker spawned | PID: ${process.pid}`)

        process.on('message', async ({ chunk, runStartTime }: { chunk: Account[]; runStartTime: number }) => {
            void this.logger.info(
                'main',
                'CLUSTER-WORKER-TASK',
                `Worker ${process.pid} received ${chunk.length} accounts.`
            )

            try {
                const stats = await this.runTasks(chunk, runStartTime ?? runStartTimeFromMaster ?? Date.now())

                // Send and flush before exit
                if (process.send) {
                    process.send({ __stats: stats })
                }

                await flushAllWebhooks()
                process.exit(0)
            } catch (error) {
                this.logger.error(
                    'main',
                    'CLUSTER-WORKER-ERROR',
                    `Worker task crash: ${error instanceof Error ? error.message : String(error)}`
                )

                await flushAllWebhooks()
                process.exit(1)
            }
        })
    }

    /**
     * 进程被信号中断时补发一次汇总：已完成的账号照实报，正在跑的账号标为「未完成」。
     * 目的：宁可推送“部分完成 + 明确警告”，也不要像 2026-10-28 那样整天静默。
     */
    public async pushSummaryOnInterrupt(): Promise<void> {
        if (this.wxSummarySent) return // 正常收尾已经发过，避免重复推送
        this.wxSummarySent = true

        const wx = this.config?.webhook?.wxpusher
        if (!wx?.enabled) return

        const summaries = toAccountSummaries(this.completedStats)
        if (this.inProgressEmail) {
            summaries.push({
                email: this.inProgressEmail,
                collectedPoints: 0,
                initialPoints: 0,
                finalPoints: 0,
                duration: (Date.now() - this.inProgressStartTime) / 1000,
                success: false,
                error: '运行被中断',
                incomplete: true,
                proxyGroup: this.inProgressProxyGroup,
                proxyNode: this.inProgressProxyNode
            })
        }
        if (!summaries.length) {
            this.logger.warn('main', 'PROCESS', 'Interrupted before any account finished, nothing to push')
            return
        }

        this.logger.warn(
            'main',
            'PROCESS',
            `Pushing partial summary on interrupt | completed=${this.completedStats.length} | inProgress=${this.inProgressEmail ?? 'none'}`
        )
        try {
            await sendWxPusherSummary(wx, summaries, { interrupted: true })
        } catch (error) {
            this.logger.error('main', 'PROCESS', `Interrupted summary push failed: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    /**
     * 单账号硬超时（毫秒）。默认 60 分钟，可用环境变量 ACCOUNT_TIMEOUT_MINUTES 覆盖
     * （systemd 里就写 Environment=ACCOUNT_TIMEOUT_MINUTES=60，改完 daemon-reload）。
     *
     * 0 / 负数 / 非数字之外的第二个特例：设为 `0` 表示**禁用**（试运行/单账号补跑用）。
     * 为什么需要禁用：新号首跑必然多一次邮箱验证码或 2FA 人工环节（等待时间不可控），
     * 2026-11-23 试运行 miucocoty@foxmail.com 时手机侧阅读任务跑到 60 分钟被硬掐，
     * 桌面侧整段没跑，session 不完整。试运行本来就只跑一个号、外面还有 systemd 与
     * 编排脚本的锁，不需要「别饿死后面账号」那层保护，所以按需关掉更合理。
     *
     * 为什么必须有：2026-11-13 事故里，账号 2368652476 的 desktop「Bing 会话校验」
     * 卡在一个永不返回的 Playwright 调用上，而账号循环是裸的 `for … await Main()`
     * （没有任何超时），于是整个串行任务陪着空转 5h27m，直到 systemd 的上限
     * 把整个任务杀掉，后面 3 个账号当天一次都没跑（详见 memory/run.md）。
     *
     * 为什么 90 → 60（2026-11-23）：10 个号串行时 90min × 10 = 15h，本来就不符合
     * 「总要有个硬天花板」的初衷。当天两个号各白等 90 分钟，直接把第 10 个号挤到
     * systemd 的 10h 上限之外。正常账号 35–50 分钟，60 分钟仍有 1.2–1.7 倍余量，
     * 10 号最坏 10h，能装进 12h 预算（TimeoutStartSec=43200）。
     */
    private accountTimeoutMs(): number {
        const raw = (process.env.ACCOUNT_TIMEOUT_MINUTES ?? '60').trim()
        // 显式写 0 = 禁用单账号硬超时（试运行 / 单账号补跑）
        if (raw === '0') return 0
        const minutes = Number(raw)
        const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : 60
        return safe * 60_000
    }

    /**
     * 账号被硬超时放弃后，尽量把「已经到账多少分」查出来。
     *
     * 背景（2026-11-19）：alanyz@njust.edu.cn 卡在桌面搜索上 90 分钟被放弃，
     * 超时分支把三个分数字段全写 0，推送显示「0 → 0」；实际上这个号手机侧活动
     * 全部到账、真实余额 7911 → 8021（+110），查漏补缺当天还读到 8021 起步。
     *
     * 做法：超时那一刻浏览器已经被关掉，但账号的 cookie 与指纹还在内存里，
     * 所以直接用它们走一遍 API 查余额（不启动浏览器，十几秒就能出结果）。
     * 查不到就退回本地累计值（初始分 + 已记账的得分），仍然不再写死 0。
     */
    private async salvageBalanceAfterTimeout(account: Account): Promise<{
        initialPoints: number
        finalPoints: number
        collectedPoints: number
        source: 'api' | 'local' | 'unknown'
    }> {
        const { initialPoints, currentPoints } = this.inProgressBalance
        // 本进程内已经记账的得分（userData.gainedPoints 在每个活动入账时累加）
        const localGained = Number(this.userData.gainedPoints ?? 0)
        const localFinal = Math.max(currentPoints, initialPoints + localGained)

        const fallback = {
            initialPoints,
            finalPoints: localFinal,
            collectedPoints: Math.max(0, localFinal - initialPoints),
            source: initialPoints > 0 ? ('local' as const) : ('unknown' as const)
        }

        // 没有登录态快照（比如卡在登录那一步）就没法查，直接退回本地值
        if (!this.inProgressCookies.length) {
            if (initialPoints > 0 || localGained > 0) {
                this.logger.warn(
                    'main',
                    'TIMEOUT-SALVAGE',
                    `超时账号 ${account.email} 没有可用的登录态快照，按本地累计记账：${initialPoints} → ${localFinal}（+${fallback.collectedPoints}）`
                )
            }
            return fallback
        }

        this.logger.info(
            'main',
            'TIMEOUT-SALVAGE',
            `超时账号 ${account.email} 正在用已保存的登录态查真实余额（浏览器已关闭，走 API）…`
        )

        try {
            // 用独立的 axios 实例，避免污染本账号后续（已不会再跑）的 this.axios
            const axiosClient = new AxiosClient(account.proxy)
            const cookieHeader = this.browser.func.buildCookieHeader(this.inProgressCookies, ['bing.com'])

            const response = await axiosClient.requestForProbe({
                url: 'https://rewards.bing.com/api/getuserinfo?type=1',
                method: 'GET',
                timeout: 20000,
                headers: {
                    ...(this.inProgressFingerprint?.headers ?? {}),
                    Cookie: cookieHeader,
                    Referer: 'https://rewards.bing.com/',
                    Origin: 'https://rewards.bing.com'
                }
            })

            const availablePoints = response.data?.dashboard?.userStatus?.availablePoints
            if (typeof availablePoints === 'number') {
                const effectiveInitial = initialPoints > 0 ? initialPoints : Math.min(availablePoints, localFinal)
                const collected = Math.max(0, availablePoints - effectiveInitial)
                this.logger.info(
                    'main',
                    'TIMEOUT-SALVAGE',
                    `超时账号 ${account.email} 真实余额 = ${availablePoints}（记账 ${effectiveInitial} → ${availablePoints}，+${collected}）`,
                    'green'
                )
                return {
                    initialPoints: effectiveInitial,
                    finalPoints: availablePoints,
                    collectedPoints: collected,
                    source: 'api'
                }
            }

            this.logger.warn(
                'main',
                'TIMEOUT-SALVAGE',
                `超时账号 ${account.email} 的余额接口没有 availablePoints，按本地累计记账：${initialPoints} → ${localFinal}`
            )
            return fallback
        } catch (error) {
            this.logger.warn(
                'main',
                'TIMEOUT-SALVAGE',
                `超时账号 ${account.email} 余额查询失败（${error instanceof Error ? error.message : String(error)}），按本地累计记账：${initialPoints} → ${localFinal}（+${fallback.collectedPoints}）`
            )
            return fallback
        }
    }

    /**
     * 输出一行**机器可读**的账号终态结果，供外层脚本（.dev/rerun-failed.sh、
     * .dev/build-summary.js）可靠解析。
     *
     * 为什么需要（2026-11-25）：ACCOUNT-END 只在「正常收尾」时打，超时 / Flow failed /
     * ACCOUNT-ERROR 三条路径都不打它。而补跑恰恰最常走这三条路径，于是解析器匹配不到
     * `Completed account:` 就退回写死全 0，合并账单取 `max(主任务, 补跑)` 时 0 永远被吞，
     * 卡片上补跑成绩恒等于主任务那一行（2026-11-25 三个号 +10/+77/+109 全丢）。
     *
     * 这里不改变 ACCOUNT-END 的「成功」语义（它在别处被当作成功标志），
     * 只额外补一条与终态无关、带真实分数的记录行。
     */
    private logAccountResult(stat: AccountStats): void {
        this.logger.info(
            'main',
            'ACCOUNT-RESULT',
            JSON.stringify({
                email: stat.email,
                initialPoints: stat.initialPoints,
                finalPoints: stat.finalPoints,
                collectedPoints: stat.collectedPoints,
                duration: stat.duration,
                success: stat.success,
                incomplete: stat.incomplete ?? false,
                error: stat.error ?? null
            })
        )
    }

    private async runTasks(accounts: Account[], runStartTime: number): Promise<AccountStats[]> {
        const accountStats: AccountStats[] = []
        const accountTimeoutMs = this.accountTimeoutMs()
        const accountTimeoutDisabled = accountTimeoutMs <= 0
        this.logger.info('main', 'NETWORK-JITTER', this.networkRecovery.describe())
        if (accountTimeoutDisabled) {
            this.logger.warn(
                'main',
                'RUN-TIMEOUT',
                '单账号硬超时: 已禁用（ACCOUNT_TIMEOUT_MINUTES=0，试运行/单账号补跑模式，不会主动掐断账号）'
            )
        } else {
            this.logger.info(
                'main',
                'RUN-TIMEOUT',
                `单账号硬超时: ${Number((accountTimeoutMs / 60000).toFixed(1))} 分钟（超时放弃该账号、关掉它的浏览器，继续下一个）`
            )
        }
        // 分组模式：记下开跑前的全局节点，全部跑完后还原，避免人工补跑/试运行
        // 把 mihomo 的面板选中节点永久改掉（单账号补跑尤其容易留下意外状态）。
        let originalNode: string | undefined
        if (nodeSwitch.config().enabled) {
            try {
                originalNode = await nodeSwitch.getNow(nodeSwitch.config(), nodeSwitch.config().selectorGroup)
            } catch (e) {
                throw new Error(`[NODE] 读取当前节点失败: ${e instanceof Error ? e.message : String(e)}`)
            }
        }

        try {
        for (const account of accounts) {
            const accountStartTime = Date.now()
            const accountEmail = account.email
            this.userData.userName = this.utils.getEmailUsername(accountEmail)
            this.userData.timezoneOffset = String(-new Date().getTimezoneOffset())

            // 记录“正在跑谁”，中断时才能把它标成未完成
            this.inProgressEmail = accountEmail
            this.inProgressStartTime = accountStartTime
            this.inProgressProxyGroup = undefined
            this.inProgressProxyNode = undefined
            // 超时抢救用：每个账号开跑前清空上一个号的余额/登录态快照
            this.inProgressBalance = { initialPoints: 0, currentPoints: 0 }
            this.inProgressCookies = []
            this.inProgressFingerprint = undefined

            // 本账号实际使用的节点：切换成功后立刻记下，后面无论成功/失败/超时都带进推送
            let accountProxyGroup: string | undefined
            let accountProxyNode: string | undefined

            try {
                this.logger.info(
                    'main',
                    'ACCOUNT-START',
                    `Starting account: ${accountEmail} | geoLocale: ${account.geoLocale}`
                )

                // 出网抖动等待预算按账号计：上一个号把额度用完不影响下一个号
                this.networkRecovery.reset()

                // 每个账号开始前按分组切换 mihomo 出口节点（切换失败直接让本账号失败，
                // 绝不在错误节点下跑：MSA 对 IP 与登录态一致性敏感）。
                // 这样无论全量清单顺序、单账号补跑、SOP 试运行都自动用对节点。
                if (nodeSwitch.config().enabled) {
                    const r = await nodeSwitch.ensureNodeForAccount(accountEmail, (m: string) =>
                        this.logger.info('main', 'NODE', m)
                    )
                    accountProxyGroup = r.group
                    accountProxyNode = r.node
                    this.inProgressProxyGroup = r.group
                    this.inProgressProxyNode = r.node
                    this.logger.info(
                        'main',
                        'NODE',
                        `分组=${r.group} | 节点=${r.node} | ${accountEmail}`,
                        'cyan'
                    )
                }

                this.axios = new AxiosClient(account.proxy)
                await this.checkAndLogProxy(account)

                const ACCOUNT_TIMEOUT = Symbol('account-timeout')
                let timeoutHandle: NodeJS.Timeout | undefined
                const mobileFlow = this.Main(account).catch(error => {
                    void this.logger.error(
                        true,
                        'FLOW',
                        `Mobile flow failed for ${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                    )
                    return undefined
                })
                // 超时被禁用时不要挂 setTimeout(0)——那会立刻判定超时；直接等 Main 跑完
                const raced = accountTimeoutDisabled
                    ? await mobileFlow
                    : await Promise.race([
                          mobileFlow,
                          new Promise<typeof ACCOUNT_TIMEOUT>(resolve => {
                              timeoutHandle = setTimeout(() => resolve(ACCOUNT_TIMEOUT), accountTimeoutMs)
                          })
                      ])
                if (timeoutHandle) clearTimeout(timeoutHandle)

                // 超时：放弃这个账号，关掉它留下的浏览器，继续下一个 ——
                // 绝不能再让一个号把后面所有号的时间吃光（2026-11-13 事故）
                if (raced === ACCOUNT_TIMEOUT) {
                    const timeoutMinutes = Number((accountTimeoutMs / 60000).toFixed(1))
                    const timeoutSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
                    this.logger.error(
                        'main',
                        'ACCOUNT-TIMEOUT',
                        `${accountEmail} 超过 ${timeoutMinutes} 分钟没有返回，放弃该账号并继续下一个（多半是 Playwright 调用挂死）| Duration: ${timeoutSeconds}s`
                    )
                    await this.browserFactory.closeAllBrowsers(`account timeout: ${accountEmail}`).catch(() => {})

                    // 超时不等于 0 分：那个号可能已经把手机侧活动全做完了（2026-11-19 就 +110）。
                    // 先尽力查一次真实余额，查不到才退回本地累计值，绝不写死 0。
                    const salvaged = await this.salvageBalanceAfterTimeout(account)

                    const timeoutStat: AccountStats = {
                        email: accountEmail,
                        initialPoints: salvaged.initialPoints,
                        finalPoints: salvaged.finalPoints,
                        collectedPoints: salvaged.collectedPoints,
                        duration: parseFloat(timeoutSeconds),
                        success: false,
                        incomplete: true,
                        error: `timeout ${timeoutMinutes}min${salvaged.source === 'local' ? '（余额未查到，用本地累计）' : ''}`,
                        proxyGroup: accountProxyGroup,
                        proxyNode: accountProxyNode
                    }
                    accountStats.push(timeoutStat)
                    // 超时分支不会走到 ACCOUNT-END，补一条机器可读结果，否则外层补跑解析不到分数
                    this.logAccountResult(timeoutStat)
                    this.completedStats = [...accountStats]
                    this.inProgressEmail = null
                    this.inProgressProxyGroup = undefined
                    this.inProgressProxyNode = undefined
                    continue
                }

                const result:
                    | {
                          initialPoints: number
                          collectedPoints: number
                          searchIncomplete?: boolean
                          breakdown?: TaskBreakdown
                          level?: MemberLevel
                      }
                    | undefined = raced

                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)

                if (result) {
                    const collectedPoints = result.collectedPoints ?? 0
                    const accountInitialPoints = result.initialPoints ?? 0
                    const accountFinalPoints = accountInitialPoints + collectedPoints
                    const searchIncomplete = Boolean(result.searchIncomplete)

                    const successStat: AccountStats = {
                        email: accountEmail,
                        initialPoints: accountInitialPoints,
                        finalPoints: accountFinalPoints,
                        collectedPoints: collectedPoints,
                        duration: parseFloat(durationSeconds),
                        success: true,
                        // 跑完了但搜索分没拿满：外层在主任务后单独补跑这个号
                        incomplete: searchIncomplete || undefined,
                        proxyGroup: accountProxyGroup,
                        proxyNode: accountProxyNode,
                        breakdown: result.breakdown,
                        level: result.level
                    }
                    accountStats.push(successStat)

                    this.logger.info(
                        'main',
                        'ACCOUNT-END',
                        `Completed account: ${accountEmail} | Total: +${collectedPoints} | Old: ${accountInitialPoints} → New: ${accountFinalPoints} | Duration: ${durationSeconds}s${searchIncomplete ? ' | 搜索未满，待单独补跑' : ''}`,
                        searchIncomplete ? 'yellow' : 'green'
                    )
                    // 四条终态统一都有一条机器可读结果行（ACCOUNT-END 保持「成功」语义不变）
                    this.logAccountResult(successStat)
                } else {
                    // 流程失败（Main 抛错被吞成 undefined）：同样不能记 0 ——
                    // 已到账的手机侧活动分是实打实的（2026-11-17 / 11-19 同类事故）。
                    const salvaged = await this.salvageBalanceAfterTimeout(account)
                    const flowFailedStat: AccountStats = {
                        email: accountEmail,
                        initialPoints: salvaged.initialPoints,
                        finalPoints: salvaged.finalPoints,
                        collectedPoints: salvaged.collectedPoints,
                        duration: parseFloat(durationSeconds),
                        success: false,
                        error: 'Flow failed',
                        proxyGroup: accountProxyGroup,
                        proxyNode: accountProxyNode
                    }
                    accountStats.push(flowFailedStat)
                    // 同上：失败分支没有 ACCOUNT-END，补一条机器可读结果
                    this.logAccountResult(flowFailedStat)
                }
            } catch (error) {
                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
                this.logger.error(
                    'main',
                    'ACCOUNT-ERROR',
                    `${accountEmail}: ${error instanceof Error ? error.message : String(error)}`
                )

                const salvaged = await this.salvageBalanceAfterTimeout(account)
                const errorStat: AccountStats = {
                    email: accountEmail,
                    initialPoints: salvaged.initialPoints,
                    finalPoints: salvaged.finalPoints,
                    collectedPoints: salvaged.collectedPoints,
                    duration: parseFloat(durationSeconds),
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                    proxyGroup: accountProxyGroup,
                    proxyNode: accountProxyNode
                }
                accountStats.push(errorStat)
                // 同上：异常分支没有 ACCOUNT-END，补一条机器可读结果
                this.logAccountResult(errorStat)
            }

            // 该账号已出结果（成功或失败），快照进中断兜底列表，并清空“正在跑”标记
            this.completedStats = [...accountStats]
            this.inProgressEmail = null
            this.inProgressProxyGroup = undefined
            this.inProgressProxyNode = undefined
        }
        } finally {
            // 全部账号跑完（或异常中断）都还原到开跑前的节点
            await nodeSwitch.restore(originalNode, (m: string) => this.logger.info('main', 'NODE', m))
        }

        if (this.config.clusters <= 1 && cluster.isPrimary) {
            const totalCollectedPoints = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
            const totalInitialPoints = accountStats.reduce((sum, s) => sum + s.initialPoints, 0)
            const totalFinalPoints = accountStats.reduce((sum, s) => sum + s.finalPoints, 0)
            const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

            this.logger.info(
                'main',
                'RUN-END',
                `Completed all accounts | Accounts processed: ${accountStats.length} | Total points collected: +${totalCollectedPoints} | Old total: ${totalInitialPoints} → New total: ${totalFinalPoints} | Total runtime: ${totalDurationMinutes}min`,
                'green'
            )

            const wxSummary = this.config.webhook.wxpusher
            if (wxSummary?.enabled) {
                // 正常收尾即视为已推送，防止随后的 SIGTERM/beforeExit 再补发一次
                this.wxSummarySent = true
                // 单独补跑（.dev/rerun-failed.sh）时由外层统一推一张合并卡片，
                // 这里的单号卡片只会造成「一天收好几条、还互相矛盾」的重复推送。
                if (process.env.SUPPRESS_SUMMARY_PUSH === '1') {
                    this.logger.info('main', 'WXPUSHER', `SUPPRESS_SUMMARY_PUSH=1，本次不推送（由外层合并推送）`)
                } else {
                    // 2026-11-23：这里原来是「不 await，直接靠 flushAllWebhooks() 冲队列」，
                    // 而 flushAllWebhooks 的上限只有 5s —— 推送慢一点（节点抖动、WxPusher 慢）
                    // 就会在 process.exit(0) 时被丢掉，日志里连一行 [WxPusher] 都不留。
                    // 现在显式 await 到 HTTP 真正返回（内部 10s axios 超时兜底），并记录结果。
                    const outcome = await runShutdownStep(
                        'WxPusher 汇总推送',
                        20_000,
                        () => sendWxPusherSummary(wxSummary, toAccountSummaries(accountStats)),
                        (msg: string) => this.logger.warn('main', 'WXPUSHER', msg)
                    )
                    this.logger.info('main', 'WXPUSHER', `汇总推送结果: ${outcome}`)
                }
            }

            exportGithubOutput(accountStats, this.config.retryOnLowPoints)
            this.logLowPointAccounts(accountStats)

            await flushAllWebhooks(15_000)
            process.exit(0)
        }

        return accountStats
    }

    private async checkAndLogProxy(account: Account): Promise<void> {
        const { url, port, username } = account.proxy
        if (!url) {
            this.logger.info('main', 'PROXY', 'No proxy configured for this account (using direct connection)', 'yellow')
            return
        }

        const proxyDisplay = `${url}:${port}${username ? ' (with auth)' : ''}`
        this.logger.info('main', 'PROXY', `Testing proxy connection: ${proxyDisplay}...`)

        try {
            const response = await this.axios.request(
                {
                    url: 'http://ip-api.com/json/?lang=zh-CN',
                    method: 'GET',
                    timeout: 8000
                },
                false
            )

            const data = response.data
            if (data && data.status === 'success') {
                const country = data.country || data.countryCode || ''
                const region = data.regionName || data.region || ''
                const city = data.city || ''
                const isp = data.isp || ''
                const queryIp = data.query || ''
                this.logger.info(
                    'main',
                    'PROXY',
                    `Proxy active & verified! Outbound IP: ${queryIp} | Location: ${country} ${region} ${city} | ISP: ${isp}`,
                    'green'
                )
            } else {
                this.logger.info(
                    'main',
                    'PROXY',
                    `Proxy connected! Response: ${JSON.stringify(data).slice(0, 100)}`,
                    'cyan'
                )
            }
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error)
            this.logger.warn('main', 'PROXY', `Proxy probe test failed: ${errMsg} (will continue execution)`)

            // 账号开跑前节点就不通时，先等它恢复，别急着重启一个注定失败的浏览器会话。
            // 探测走 bing（probeOnce）：如果只是 ip-api 挂了而 rewards 可达，第一次探测就会直接放行。
            // 只对「出网抖动」等待；代理认证错误之类的配置问题不在恢复范围内。
            if (isTransientNetworkError(error)) {
                // 只等 15 分钟：节点整晚不通时不能让每个账号都在起跑线干等 30 分钟
                await this.networkRecovery.waitForProxy('ACCOUNT-PROXY', 15 * 60_000)
            }
        }
    }

    async Main(account: Account): Promise<{
        initialPoints: number
        collectedPoints: number
        /** 搜索分没搜完（卡住/停滞放弃）：账号算「跑完但没拿满」，外层会挑它单独补跑 */
        searchIncomplete?: boolean
        /** 按任务类型的积分拆分（推送卡片用），读数失败时为 undefined */
        breakdown?: TaskBreakdown
        /** 会员等级（铜/银/金），卡片里显示在节点右边；读不到时 undefined */
        level?: MemberLevel
    }> {
        const accountEmail = account.email
        this.logger.info('main', 'FLOW', `Starting session for ${accountEmail}`)

        let mobileSession: BrowserSession | null = null
        let mobileContextClosed = false

        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                mobileSession = await this.browserFactory.createBrowser(account)
                const initialContext: BrowserContext = mobileSession.context
                this.mainMobilePage = await initialContext.newPage()

                this.logger.info('main', 'BROWSER', `Mobile Browser started | ${accountEmail}`)

                await this.login.login(this.mainMobilePage, account)

                try {
                    this.accessToken = await this.login.getAppAccessToken(this.mainMobilePage, accountEmail)
                } catch (error) {
                    this.logger.error(
                        'main',
                        'FLOW',
                        `Failed to get mobile access token: ${error instanceof Error ? error.message : String(error)}`
                    )
                }

                const initialCookies = await this.browser.func.safeGetCookies(initialContext, this.cookies.mobile)
                this.cookies.mobile = initialCookies.cookies
                this.fingerprint = mobileSession.fingerprint

                // 超时抢救用的快照：登录态 + 指纹拿到后立刻留一份，
                // 万一这个号卡在后面的 Playwright 调用上被硬超时收掉，
                // 还能用这份 cookie 直接打 API 查真实余额（见 salvageBalanceAfterTimeout）。
                this.inProgressCookies = initialCookies.cookies
                this.inProgressFingerprint = mobileSession.fingerprint

                const data: DashboardData = await this.browser.func.getDashboardData()

                let appData: AppDashboardData | undefined
                let appChannelAvailable = true
                try {
                    appData = await this.browser.func.getAppDashboardData()
                } catch (error) {
                    appChannelAvailable = false
                    this.logger.warn(
                        'main',
                        'APP-CHANNEL',
                        `App/mobile API unavailable (${error instanceof Error ? error.message : String(error)}) — skipping app-only activities, browser/desktop will continue`
                    )
                }

                // Set geo
                this.userData.geoLocale =
                    account.geoLocale === 'auto' ? data.userProfile.attributes.country : account.geoLocale.toLowerCase()
                if (this.userData.geoLocale.length > 2) {
                    this.logger.warn(
                        'main',
                        'GEO-LOCALE',
                        `The provided geoLocale is longer than 2 (${this.userData.geoLocale} | auto=${account.geoLocale === 'auto'}), this is likely invalid and can cause errors!`
                    )
                }

                this.userData.initialPoints = data.userStatus.availablePoints
                this.userData.currentPoints = data.userStatus.availablePoints
                // 本次运行开跑时的余额（只用于日志/本地累计兜底）
                const runStartPoints = this.userData.initialPoints ?? 0
                // 记账起点用「当天基线」而不是「本次开跑余额」：
                //   同一天里一个号可能被跑多次（服务被杀后自动重启、补跑、查漏补缺），
                //   每次都从「本次开跑余额」起算的话，前面几轮挣的分会被算进起点而消失
                //   （2026-11-24：第一轮挣 1260 分，第二轮从 19578 起算只记 +80）。
                const initialPoints = getOrSetDayBaseline(this.dataDir(), accountEmail, runStartPoints)
                if (initialPoints !== runStartPoints) {
                    this.logger.info(
                        'main',
                        'POINTS-BASELINE',
                        `当天基线 ${initialPoints}（本次开跑 ${runStartPoints}，已累计 +${Math.max(0, runStartPoints - initialPoints)}）| ${accountEmail}`
                    )
                }
                // 超时抢救的兜底基线：起点同样是当天基线，保证与最终账单口径一致
                this.inProgressBalance = { initialPoints, currentPoints: runStartPoints }

                const browserEarnable = await this.browser.func.getBrowserEarnablePoints()

                let appEarnable = { readToEarn: 0, checkIn: 0, totalEarnablePoints: 0 }
                if (appChannelAvailable) {
                    try {
                        appEarnable = await this.browser.func.getAppEarnablePoints()
                    } catch (error) {
                        appChannelAvailable = false
                        this.logger.warn(
                            'main',
                            'APP-CHANNEL',
                            `App earnable-points API unavailable (${error instanceof Error ? error.message : String(error)}) — skipping app-only activities`
                        )
                    }
                }

                this.pointsCanCollect = browserEarnable.mobileSearchPoints + (appEarnable?.totalEarnablePoints ?? 0)

                this.logger.info(
                    'main',
                    'POINTS',
                    `Earnable today | Mobile: ${this.pointsCanCollect} | Browser: ${
                        browserEarnable.mobileSearchPoints
                    } | App: ${appEarnable?.totalEarnablePoints ?? 0} | ${accountEmail} | locale: ${this.userData.geoLocale}`
                )

                // 按任务类型拆分的「开跑前」基准：这一刻每类任务还差多少分。
                // 必须在任何活动开始前拍，之后收尾再拍一次，两者相减就是本次各类拿到多少。
                // 日期键交给 readTaskProgress 内部按「奖励市场本地日期」判定；
                // 别再传 this.utils.getFormattedDate()（那是服务器本地日期，美国区账号会错一天）
                const taskProgressBefore: TaskProgressSnapshot | undefined = readTaskProgress(
                    data,
                    appChannelAvailable ? appEarnable : undefined
                )

                // 会员等级（铜/银/金）：开跑时的 dashboard 里就有，不用额外请求。
                // 按 key 映射而非名称——名称会随账号语言变成 "Gold Member" / "金級會員"。
                const memberLevel = readMemberLevel(data)
                if (memberLevel) {
                    this.logger.info(
                        'main',
                        'MEMBER-LEVEL',
                        `会员等级=${memberLevel} | activeLevel=${data.userStatus.levelInfo?.activeLevel} | ${accountEmail}`
                    )
                }

                // Ensure streak protection is true if enabled
                if (this.config.ensureStreakProtection) {
                    await this.browser.func.ensureStreakProtection()
                }
                if (this.config.workers.doClaimBonusPoints) await this.workers.doClaimBonusPoints(data)
                if (this.config.workers.doAppPromotions && appChannelAvailable && appData)
                    await this.workers.doAppPromotions(appData)
                if (this.config.workers.doDailySet) await this.workers.doDailySet(data, this.mainMobilePage)
                if (this.config.workers.doSpecialPromotions) await this.workers.doSpecialPromotions(data)
                if (this.config.workers.doMorePromotions) await this.workers.doMorePromotions(data, this.mainMobilePage)
                if (this.config.workers.doDailyCheckIn && appChannelAvailable) await this.activities.doDailyCheckIn()
                if (this.config.workers.doReadToEarn && appChannelAvailable) await this.activities.doReadToEarn()
                if (this.config.workers.doPunchCards) await this.workers.doPunchCards(data, this.mainMobilePage)

                const searchPoints = await this.browser.func.getSearchPoints()
                const missingSearchPoints = this.browser.func.missingSearchPoints(searchPoints, true)

                // 浏览器可能已经崩溃：这里绝不能抛错，否则整个账号会被判 0 分（含已到账的活动分）。
                const latestCookies = await this.browser.func.safeGetCookies(initialContext, this.cookies.mobile)
                this.cookies.mobile = latestCookies.cookies
                const mobileBrowserAlive = latestCookies.ok

                if (!mobileBrowserAlive) {
                    this.logger.warn(
                        'main',
                        'FLOW',
                        `Mobile browser is no longer alive for ${accountEmail} — skipping mobile work, continuing with desktop/API`
                    )
                }

                const { mobilePoints, desktopPoints } = await this.searchManager.doSearches(
                    data,
                    missingSearchPoints,
                    mobileSession,
                    account,
                    accountEmail,
                    mobileBrowserAlive
                )

                mobileContextClosed = true

                this.userData.gainedPoints = mobilePoints + desktopPoints

                // 搜索到底搜满没有：再读一次计数器来判断，不靠「有没有抛错」猜。
                // 2026-11-19 的 alanyz 就是卡在查不到分值上、最后 earned=0 却一路「成功」走到
                // ACCOUNT-END，外层完全看不出这个号丢了 100 分搜索分。
                //
                // 同一次仪表盘数据顺便拍「收尾快照」，供推送里的任务细分相减（少一次请求）。
                let searchIncomplete = false
                let taskProgressAfter: TaskProgressSnapshot | undefined
                try {
                    const finalDashboard = await this.browser.func.getDashboardData()
                    const afterMissing = this.browser.func.missingSearchPoints(finalDashboard.userStatus.counters, false)
                    const stillMissing =
                        (this.config.workers.doDesktopSearch
                            ? afterMissing.desktopPoints + afterMissing.edgePoints
                            : 0) + (this.config.workers.doMobileSearch ? afterMissing.mobilePoints : 0)

                    if (stillMissing > 0) {
                        searchIncomplete = true
                        this.logger.warn(
                            'main',
                            'FLOW',
                            `搜索没搜满：还差 ${stillMissing} 分（桌面 ${afterMissing.desktopPoints} / Edge ${afterMissing.edgePoints} / 手机 ${afterMissing.mobilePoints}）| 本账号将标记为「未拿满」，主任务后单独补跑 | ${accountEmail}`
                        )
                    }

                    // App 端剩余可得分也要重读一次，否则「App 签到/阅读」这一行永远算不出拿到多少；
                    // 读不到就让它缺键，卡片显示「差N?」而不是谎报 0。
                    let appAfter: AppEarnablePoints | undefined
                    if (appChannelAvailable) {
                        try {
                            appAfter = await this.browser.func.getAppEarnablePoints()
                        } catch (error) {
                            this.logger.debug(
                                'main',
                                'FLOW',
                                `App 进度复核失败（细分里该行标为未知）：${error instanceof Error ? error.message : String(error)}`
                            )
                        }
                    }
                    taskProgressAfter = readTaskProgress(finalDashboard, appAfter)
                } catch (error) {
                    this.logger.debug(
                        'main',
                        'FLOW',
                        `搜索缺口复核失败（不影响账号结果）：${error instanceof Error ? error.message : String(error)}`
                    )
                }

                // 末尾记账同样受出网抖动影响（2026-11-17 就是这一行抛错把整号记成失败的）。
                // 先用恢复兜底重试；预算内仍查不到时退回本地累计值，绝不把已到账的分记成 0。
                let finalPoints: number
                try {
                    finalPoints = await this.networkRecovery.run('FLOW-FINAL-POINTS', () =>
                        this.browser.func.getCurrentPoints()
                    )
                } catch (error) {
                    if (!isTransientNetworkError(error)) throw error

                    const localPoints = Math.max(
                        Number(this.userData.currentPoints ?? 0),
                        runStartPoints + Number(this.userData.gainedPoints ?? 0)
                    )
                    this.logger.warn(
                        'main',
                        'FLOW-FINAL-POINTS',
                        `余额查询在恢复预算内仍未成功，改用本地累计余额记分：${localPoints}（真实值可能略高）| message=${
                            error instanceof Error ? error.message : String(error)
                        }`
                    )
                    finalPoints = localPoints
                }
                const collectedPoints = finalPoints - initialPoints

                // 任务细分：前后两次「还差多少」相减，得到各类拿到的分与仍缺的部分。
                // 这行是 JSON：外层（.dev/rerun-failed.sh）补跑后要靠它把细分带进合并卡片，
                // 光靠人读的可读文本没法可靠解析。
                const breakdown = diffTaskBreakdown(taskProgressBefore, taskProgressAfter)
                if (breakdown) {
                    this.logger.info(
                        'main',
                        'TASK-BREAKDOWN',
                        JSON.stringify({ email: accountEmail, slices: breakdown })
                    )
                }

                // 终值也是超时抢救的兜底基线，留着给外层核对
                this.inProgressBalance = { initialPoints, currentPoints: finalPoints }

                this.logger.info(
                    'main',
                    'FLOW',
                    `Collected: +${collectedPoints} | Mobile: +${mobilePoints} | Desktop: +${desktopPoints} | ${accountEmail}`
                )

                return {
                    initialPoints,
                    collectedPoints: collectedPoints || 0,
                    searchIncomplete,
                    breakdown,
                    level: memberLevel
                }
            })
        } finally {
            if (mobileSession && !mobileContextClosed) {
                try {
                    await executionContext.run({ isMobile: true, account }, async () => {
                        await this.browser.func.closeBrowser(mobileSession!.context, accountEmail)
                    })
                } catch {}
            }
        }
    }
}

export { executionContext }

async function main(): Promise<void> {
    // Check before doing anything
    checkNodeVersion()
    const rewardsBot = new MicrosoftRewardsBot()

    /**
     * 统一的收尾流程：补发一次「部分完成」汇总 → 冲掉 webhook 队列 → 退出。
     * 具体实现与「只跑一次」的守卫在 `util/Shutdown.ts`（那里可单测，见该文件注释）。
     *
     * 2026-11-23 主任务卡片丢失的修复要点：
     *   1. 收尾**只跑一次**：systemd 在 TimeoutStartSec 到点后会补发信号，旧实现里
     *      第二个 SIGTERM 会立刻 `process.exit(143)`，把第一个信号里正在飞的推送掐断。
     *   2. 每步都有硬上限（25s + 10s = 35s），配合 unit 里的 `TimeoutStopSec=60`，
     *      保证不会被 SIGKILL 掉、日志里一定留下推送结果。
     */
    const shutdown = createShutdownHandler({
        pushSummary: () => rewardsBot.pushSummaryOnInterrupt(),
        flushQueues: () => flushAllWebhooks(),
        log: (msg: string) => rewardsBot.logger.warn('main', 'PROCESS', msg),
        exit: (code: number) => process.exit(code)
    })

    process.on('beforeExit', () => {
        void flushAllWebhooks()
    })
    process.on('SIGINT', () => void shutdown('SIGINT', 130))
    process.on('SIGTERM', () => void shutdown('SIGTERM', 143))
    process.on('uncaughtException', (error: unknown) => {
        rewardsBot.logger.error('main', 'UNCAUGHT-EXCEPTION', error as Error)
        void shutdown('UNCAUGHT-EXCEPTION', 1)
    })
    process.on('unhandledRejection', (reason: unknown) => {
        rewardsBot.logger.error('main', 'UNHANDLED-REJECTION', reason as Error)
        void shutdown('UNHANDLED-REJECTION', 1)
    })

    try {
        await rewardsBot.initialize()
        await rewardsBot.run()
    } catch (error) {
        rewardsBot.logger.error('main', 'MAIN-ERROR', error as Error)
    }
}

main().catch(async error => {
    const tmpBot = new MicrosoftRewardsBot()
    tmpBot.logger.error('main', 'MAIN-ERROR', error as Error)
    await flushAllWebhooks()
    process.exit(1)
})
