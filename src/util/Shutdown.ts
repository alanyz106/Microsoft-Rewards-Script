/**
 * 进程收尾（被 systemd / Ctrl-C 中断时）用的两个小工具：一次性守卫 + 带硬上限的等待。
 *
 * 单独成文件的原因：`src/index.ts` 里的信号处理器没法直接单测（跑它就等于真跑账号），
 * 而这两段逻辑恰恰是最容易写错、错了又最难复现的部分（事故发生在凌晨、没人盯着）。
 */

export type ShutdownStepOutcome = 'done' | 'failed' | 'timeout'

/**
 * 在硬上限内等待一个收尾动作，**永不向外抛错**。
 *
 * 为什么要硬上限：收尾动作是网络 I/O（WxPusher），节点抖动时可能一直挂着；
 * 而 systemd 在 TimeoutStopSec（默认 90s）之后会 SIGKILL，届时日志里什么都留不下。
 * 宁可主动放弃、记一条超时，也不要让进程被动被杀成「静默失败」。
 */
export async function runShutdownStep(
    label: string,
    ms: number,
    task: () => Promise<void>,
    log: (msg: string) => void = console.log
): Promise<ShutdownStepOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<ShutdownStepOutcome>(resolve => {
        timer = setTimeout(() => resolve('timeout'), ms)
    })

    /** 把 task 化成一个「永不 reject、只返回结果」的 Promise，避免超时后才失败变成 unhandled rejection */
    const attempt: Promise<ShutdownStepOutcome> = task().then(
        (): ShutdownStepOutcome => 'done',
        (error: unknown): ShutdownStepOutcome => {
            log(`[shutdown] ${label} 失败: ${error instanceof Error ? error.message : String(error)}`)
            return 'failed'
        }
    )

    try {
        const outcome = await Promise.race([attempt, deadline])
        if (outcome === 'timeout') log(`[shutdown] ${label} 超过 ${ms}ms 未完成，放弃等待`)
        return outcome
    } finally {
        if (timer) clearTimeout(timer)
    }
}

export interface ShutdownGuard {
    /** 第一个调用者返回 true（由它负责跑完整收尾并退出）；其余一律 false。 */
    enter(): boolean
    /** 已经有收尾流程在跑了吗（给测试与日志用）。 */
    readonly started: boolean
}

/**
 * 「收尾只能有一份」的守卫。
 *
 * 事故背景（2026-11-23）：systemd 因 TimeoutStartSec 到点发出 SIGTERM 后，
 * 2 秒内又补发了第二个 SIGTERM。旧实现里每个信号都完整跑一遍
 * `pushSummaryOnInterrupt() → flushAllWebhooks() → process.exit()`：
 * 第二个信号进来时 `wxSummarySent` 已被第一个置 true，push 立刻 return，
 * 于是马上 `process.exit(143)`，把第一个信号里**正在飞**的 WxPusher 请求掐断。
 * 当天主任务卡片就是这么丢的 —— 日志里只有 `Pushing partial summary on interrupt`，
 * 后面没有任何 `[WxPusher] Sent/FAILED` 行。
 */
export function createShutdownGuard(): ShutdownGuard {
    let started = false
    return {
        enter(): boolean {
            if (started) return false
            started = true
            return true
        },
        get started(): boolean {
            return started
        }
    }
}

export interface ShutdownHandlerDeps {
    /** 补发「部分完成」汇总（已是网络 I/O，可能慢或挂住） */
    pushSummary: () => Promise<void>
    /** 冲掉各 webhook 队列 */
    flushQueues: () => Promise<void>
    /** 结构化日志（走项目自己的 logger） */
    log: (msg: string) => void
    /** 退出进程；抽出来是为了能单测，生产环境传 process.exit */
    exit: (code: number) => void
    /** 中断汇总推送的硬上限，默认 25s */
    pushTimeoutMs?: number
    /** 队列冲刷的硬上限，默认 10s */
    flushTimeoutMs?: number
}

/**
 * 生成信号处理器用的收尾函数：**同一个进程里只真正执行一次**。
 *
 * 这是 2026-11-23 事故的修复本体。当天时间线：
 *   10:29:26 systemd「start operation timed out. Terminating.」→ 发 SIGTERM
 *   10:29:28 node「Pushing partial summary on interrupt | completed=9」
 *   10:29:30 node「SIGTERM received, flushing and exiting...」（systemd 补发的第二个）
 *   10:29:42 systemd 判定 timeout，进程消失
 * 日志里**没有任何 `[WxPusher] Sent/FAILED`** —— 请求还在飞，就被第二个信号里的
 * `process.exit(143)` 掐断了。现在第二个信号只会打一行「重复信号，忽略」。
 *
 * 返回的这个函数本身不会抛错：任何一步失败/超时都只是记日志，然后照常退出。
 */
export function createShutdownHandler(deps: ShutdownHandlerDeps): (signal: string, code: number) => Promise<void> {
    const guard = createShutdownGuard()
    const pushTimeoutMs = deps.pushTimeoutMs ?? 25_000
    const flushTimeoutMs = deps.flushTimeoutMs ?? 10_000

    return async function shutdown(signal: string, code: number): Promise<void> {
        if (!guard.enter()) {
            deps.log(`[shutdown] ${signal} 重复信号，已有收尾流程在跑，忽略（不改退出码）`)
            return
        }
        deps.log(`[shutdown] ${signal} received, flushing and exiting...`)
        const pushOutcome = await runShutdownStep('中断汇总推送', pushTimeoutMs, deps.pushSummary, deps.log)
        await runShutdownStep('webhook 队列冲刷', flushTimeoutMs, deps.flushQueues, deps.log)
        deps.log(`[shutdown] 收尾完成（推送=${pushOutcome}），退出码 ${code}`)
        deps.exit(code)
    }
}
