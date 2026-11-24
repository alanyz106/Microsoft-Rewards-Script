import fs from 'fs'
import path from 'path'

/**
 * 积分日基线（day baseline）
 *
 * 解决什么问题
 * ------------
 * 同一天里一个账号可能被跑很多次：
 *   - 服务被杀后自动重启（2026-11-24 06:36 apt-daily-upgrade → needrestart 把服务
 *     一起重启，11 个号被完整跑了两轮）
 *   - 主任务 → 补跑 → 查漏补缺
 *   - 人工单号补跑
 *
 * 每次运行都只会说「本次运行 +N」，而且起点是「本次开跑时读到的余额」。
 * 于是：
 *   第一轮 00:09 开跑 18318 → 01:09 到 19578（挣 1260），但超时只记「未完成」
 *   第二轮 06:36 开跑读到 19578，跑完 19658 → 记「+80」
 *   最终账单只剩 +80，第一轮那 1260 分凭空消失。
 *
 * 做法
 * ----
 * 以「积分日」为单位，为每个账号记住当天**第一次**读到的余额（baseline），
 * 之后无论跑几次，都用「当前余额 - baseline」作为当天真实涨幅。
 *
 * 积分日边界
 * ----------
 * 微软积分日按太平洋时间 0 点重置。北京时间 16:00 = PST 0:00，
 * 所以把时间减去 16 小时后取日期，就得到积分日 key（与 memory 里记的重置时刻一致）。
 *
 * 落盘位置：data/points-baseline.json，跨进程/跨重启都有效。
 */

const TZ_OFFSET_HOURS = 16 // 北京时间减 16h 得到「积分日」的日期

/** 当前积分日 key（YYYY-MM-DD），按太平洋时间 0 点切日 */
export function currentRewardDay(now = new Date()): string {
    const shifted = new Date(now.getTime() - TZ_OFFSET_HOURS * 3600 * 1000)
    const y = shifted.getFullYear()
    const m = String(shifted.getMonth() + 1).padStart(2, '0')
    const d = String(shifted.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

interface BaselineStore {
    day: string
    accounts: Record<string, number>
}

function storePath(dataDir: string): string {
    return path.join(dataDir, 'points-baseline.json')
}

function readStore(dataDir: string): BaselineStore {
    const file = storePath(dataDir)
    const day = currentRewardDay()
    try {
        if (fs.existsSync(file)) {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as BaselineStore
            // 跨积分日自动作废：新的一天从新基线开始
            if (parsed && parsed.day === day && parsed.accounts) return parsed
        }
    } catch {
        /* 读失败就当没有，重新建 */
    }
    return { day, accounts: {} }
}

/**
 * 取当天基线；没有就记录当前余额作为基线。
 * @returns 当天基线值（= 今天第一次见到的余额）
 */
export function getOrSetDayBaseline(dataDir: string, email: string, currentBalance: number): number {
    const store = readStore(dataDir)
    const key = email.toLowerCase()
    const existing = store.accounts[key]
    if (typeof existing === 'number' && Number.isFinite(existing)) return existing

    store.accounts[key] = currentBalance
    try {
        fs.mkdirSync(dataDir, { recursive: true })
        fs.writeFileSync(storePath(dataDir), JSON.stringify(store, null, 2) + '\n')
    } catch {
        /* 写不了也不影响本次运行，最多下次仍然按旧逻辑 */
    }
    return currentBalance
}

/** 只读：拿当天基线（没有就返回 undefined），给汇总/补跑脚本用 */
export function peekDayBaseline(dataDir: string, email: string): number | undefined {
    const store = readStore(dataDir)
    const v = store.accounts[email.toLowerCase()]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
