import type { DashboardData } from '../interface/DashboardData'

/**
 * 决定「Daily Set 该做哪一批」——不再用服务器本地日期拍脑袋拼键。
 *
 * 背景（2026-11-22）：8 个美国区账号每日任务天天记 0 分，卡片显示「每日任务 差30」。
 * 实测发现脚本提交的是**明天那批**：
 *
 *   北京时间 11/22 00:13（= 太平洋 11/21 08:13）时，
 *   接口里是  11/21/2026（3/3 已完成）+ 11/22/2026（0/3，明天）
 *   脚本却拿 getFormattedDate()（服务器本地的北京日期）拼出 11/22 → 提交明天那批。
 *
 * 服务端对「还没到日子」的批次返回 `code:0` + `p:0`：HTTP 200、不报错、不标重复，
 * 就是不给分 —— 静默失败，所以日志里看起来像「点了但没加分」。
 * 对照组：同一账号提交 11/21 的 Child1 → `p:10` 立刻到账。
 *
 * 为什么不能用「服务器本地日期」：Rewards 的积分日按**账号所在奖励市场**的本地日期算，
 * 不是看服务器时区。实测三例都能对上：
 *   - 美国区（primaryEarningCountryName 为空）→ 太平洋日期 11/21
 *   - 中国大陆（cn）→ 北京日期 11/22
 *   - 香港（hk）→ 香港日期 11/22
 *
 * 所以键 = 「该账号奖励市场本地日期」，本模块负责把它算出来；算不出来时才退回接口键。
 */

/** 取不到市场时用的默认时区：Rewards 传统结算时区（太平洋时间） */
const DEFAULT_MARKET_TIME_ZONE = 'America/Los_Angeles'

/** 奖励市场国家码 → 该市场结算用的时区。默认太平洋（Rewards 传统结算时区） */
const MARKET_TIME_ZONES: Record<string, string> = {
    us: DEFAULT_MARKET_TIME_ZONE,
    ca: DEFAULT_MARKET_TIME_ZONE,
    mx: 'America/Mexico_City',
    br: 'America/Sao_Paulo',
    cn: 'Asia/Shanghai',
    hk: 'Asia/Hong_Kong',
    tw: 'Asia/Taipei',
    sg: 'Asia/Singapore',
    jp: 'Asia/Tokyo',
    kr: 'Asia/Seoul',
    in: 'Asia/Kolkata',
    au: 'Australia/Sydney',
    nz: 'Pacific/Auckland',
    gb: 'Europe/London',
    uk: 'Europe/London',
    de: 'Europe/Berlin',
    fr: 'Europe/Paris',
    it: 'Europe/Rome',
    es: 'Europe/Madrid',
    nl: 'Europe/Amsterdam'
}

/** 接口里 `dailySetPromotions` 的键形如 `11/22/2026`（M/D/YYYY） */
const DATE_KEY_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

/** 把 M/D/YYYY 解析成可比较的数字（YYYYMMDD）；格式不对返回 null */
export function parseDailySetKey(key: string): number | null {
    const m = DATE_KEY_PATTERN.exec(String(key ?? '').trim())
    if (!m) return null
    const [, month, day, year] = m
    return Number(year) * 10000 + Number(month) * 100 + Number(day)
}

/** 取某个时区「此刻」的日期，返回 YYYYMMDD 数字，与 parseDailySetKey 同量纲 */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): number | null {
    try {
        // en-CA 输出 YYYY-MM-DD，直接拼数字即可，避免自己算时区偏移
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(now)
        const [y, m, d] = parts.split('-').map(Number)
        if (!y || !m || !d) return null
        return y * 10000 + m * 100 + d
    } catch {
        return null
    }
}

/** 按账号的奖励市场解析时区；国家码缺失或没收录时退回太平洋 */
export function marketTimeZone(primaryEarningCountryName: string | null | undefined): string {
    const code = String(primaryEarningCountryName ?? '')
        .trim()
        .toLowerCase()
    return MARKET_TIME_ZONES[code] ?? DEFAULT_MARKET_TIME_ZONE
}

/**
 * 从接口给出的键里挑「当前该做的那一批」。
 *
 * 优先精确命中 targetKey（市场本地日期）；没有这个键时退一步：取不晚于 targetKey 的
 * 最近一个键（接口偶尔只下发「今天+明天」，或跨日瞬间只给一个）；再没有就取最早的键。
 * 绝不返回 undefined —— 调用方需要「至少做一批」而不是「什么都别做」。
 */
export function pickDailySetKey(keys: string[], targetKey: number | null): string | undefined {
    const byDate: { key: string; date: number }[] = []
    for (const k of keys) {
        const date = parseDailySetKey(k)
        if (date !== null) byDate.push({ key: k, date })
    }
    if (!byDate.length) return undefined

    if (targetKey !== null) {
        const exact = byDate.find(x => x.date === targetKey)
        if (exact) return exact.key

        const notAfter = byDate.filter(x => x.date <= targetKey).sort((a, b) => b.date - a.date)
        const fallback = notAfter[0]
        if (fallback) return fallback.key
    }

    return byDate.sort((a, b) => a.date - b.date)[0]?.key
}

/**
 * 解析「这个账号今天该做哪一批 Daily Set」，返回接口里的日期键（如 `11/21/2026`）。
 *
 * @param data dashboard 数据（只用到 dailySetPromotions 与 userStatus.primaryEarningCountryName）
 * @param now  当前时刻，测试可注入
 */
export function resolveDailySetKey(data: DashboardData | undefined, now: Date = new Date()): string {
    const keys = Object.keys(data?.dailySetPromotions ?? {})
    const country = data?.userStatus?.primaryEarningCountryName
    const timeZone = marketTimeZone(country)
    const target = todayInTimeZone(timeZone, now)

    const picked = pickDailySetKey(keys, target)
    // 兜底：连键都没有时仍返回市场本地日期，让日志/调用方有个具体值可看
    if (picked) return picked
    if (target !== null) {
        const y = Math.floor(target / 10000)
        const m = Math.floor((target % 10000) / 100)
        const d = target % 100
        return `${m}/${d}/${y}`
    }
    return ''
}
