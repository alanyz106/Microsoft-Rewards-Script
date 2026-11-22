import type { DashboardData } from '../interface/DashboardData'
import type { AppEarnablePoints } from '../interface/Points'
import { isEarnableOffer } from './OfferFilter'
import { resolveDailySetKey } from './DailySetBatch'

/**
 * 「按任务类型」的积分拆分（推送卡片用）
 *
 * 背景：卡片一直只有一个总分（+160），看不出这 160 分是搜索来的还是活动来的，
 * 更看不出「哪些部分还没做完」。这里把每日任务粗分成 6 类，每类记两个数：
 *   本次得分 = 开跑前「还差多少」- 收尾时「还差多少」
 *
 * 为什么用「还差多少」而不是「已得分」做快照：
 *   1. API 只在 counters / promotions 里给出 pointProgress（本类已得）与
 *      pointProgressMax（本类上限），两者相减就是缺口，跨天重置也只影响 progress；
 *   2. 主任务有可能是在「查漏补缺已经补过一部分」之后才跑的，此时 pointProgress
 *      不是 0，用缺口相减仍然算得准，用 progress 直接当得分就会重复计。
 *
 * 读不到收尾进度时（超时被放弃、接口抖动）不写死「得了 0 分」，而是保留开跑前的缺口
 * 并标 known=false，卡片上显示成「差N?」——宁可说「不知道」，也不能谎报「没拿到」。
 */

export type TaskCategoryKey =
    | 'desktopSearch'
    | 'mobileSearch'
    | 'dailySet'
    | 'morePromotions'
    | 'appTasks'
    | 'claimable'

interface TaskCategoryDefinition {
    key: TaskCategoryKey
    /** 卡片顶部汇总用的完整名称 */
    label: string
    /** 账号行里用的两字简称（手机宽度有限） */
    short: string
}

/**
 * 分类顺序即卡片上的顺序。刻意不细分到「第几个 quiz / 哪一条 urlreward」，
 * 也不单列 punch card（跨天累积的打卡卡长期未满，列出来只会制造噪音）。
 */
const TASK_CATEGORIES: TaskCategoryDefinition[] = [
    { key: 'desktopSearch', label: '桌面搜索', short: '桌面' },
    { key: 'mobileSearch', label: '手机搜索', short: '手机' },
    { key: 'dailySet', label: '每日任务', short: '每日' },
    { key: 'morePromotions', label: '其他活动', short: '其他' },
    { key: 'appTasks', label: 'App 签到/阅读', short: 'App' },
    { key: 'claimable', label: '待领取积分', short: '待领' }
]

/** 某一时刻各类型「还差多少分」。缺键 = 这一次没读到（不代表 0 分） */
export type TaskProgressSnapshot = Partial<Record<TaskCategoryKey, number>>

export interface TaskSlice {
    key: TaskCategoryKey
    label: string
    short: string
    /** 本次运行在这类任务上拿到的分 */
    earned: number
    /** 收尾时这类任务还差多少分 */
    remaining: number
    /** 开跑时这类任务一共还有多少分可拿 */
    available: number
    /** 收尾进度读到了没有；false 时 remaining 沿用开跑前的值 */
    known: boolean
}

export type TaskBreakdown = TaskSlice[]

interface ProgressLike {
    pointProgress?: number
    pointProgressMax?: number
}

/** 一组奖励项的缺口合计（上限 - 已得，负数按 0 处理） */
function sumMissing(list: ProgressLike[] | undefined): number {
    return (list ?? []).reduce(
        (sum, x) => sum + Math.max(0, Number(x?.pointProgressMax ?? 0) - Number(x?.pointProgress ?? 0)),
        0
    )
}

/**
 * 读一次「各任务类型还差多少分」。
 *
 * @param data      dashboard 数据（读不到就传 undefined，表示整份未知）
 * @param app       App 端剩余可得分（App 通道不可用时传 undefined，这一类按未知处理）
 * @param todayKey  今天该做的那批在 dailySetPromotions 里的键，形如 `11/20/2026`。
 *                  传 undefined 时由 resolveDailySetKey(data) 自动判定（按奖励市场日期），
 *                  避免调用方各自用服务器本地日期拼错批次。
 */
export function readTaskProgress(
    data: DashboardData | undefined,
    app: AppEarnablePoints | undefined,
    todayKey?: string
): TaskProgressSnapshot | undefined {
    if (!data) return undefined

    const snapshot: TaskProgressSnapshot = {}
    const counters = data.userStatus?.counters

    // 桌面搜索：pcSearch 里通常两个计数器（Bing 桌面 + Edge），合计成一个类型
    if (counters?.pcSearch) snapshot.desktopSearch = sumMissing(counters.pcSearch)
    if (counters?.mobileSearch) snapshot.mobileSearch = sumMissing(counters.mobileSearch)

    // 每日任务（Daily Set）：接口同时给今天和明天的键，只认「奖励市场今天」那一批
    if (data.dailySetPromotions) {
        const key = todayKey ?? resolveDailySetKey(data)
        snapshot.dailySet = sumMissing(data.dailySetPromotions[key])
    }

    // 其他活动（quiz / urlreward）：与 getBrowserEarnablePoints 同一套过滤条件，
    // 否则卡片上的「今天还有多少分」会和日志里的 Earnable today 对不上。
    // 另外剔掉「结构上拿不到分」的家族（exploreonbing / Bing App 500 / Edge 引导…），
    // 否则「还差 605」里有 600 分是永远填不上的，卡片等于在虚报缺口。
    const seen = new Set<string>()
    let promoMissing = 0
    for (const p of [...(data.morePromotions ?? []), ...(data.morePromotionsWithoutPromotionalItems ?? [])]) {
        if (!p) continue
        const id = String(p.offerId ?? '')
        if (id) {
            if (seen.has(id)) continue
            seen.add(id)
        }
        if (!['quiz', 'urlreward'].includes(String(p.promotionType ?? ''))) continue
        if (p.exclusiveLockedFeatureStatus === 'locked') continue
        if (!isEarnableOffer(p.offerId, p.title)) continue
        promoMissing += Math.max(0, Number(p.pointProgressMax ?? 0) - Number(p.pointProgress ?? 0))
    }
    snapshot.morePromotions = promoMissing

    // 待领取积分：始终按数值记录（哪怕 0）。这里不能「有才记」——
    // 开跑前 50 分、领取后 banner 消失，收尾那次就会缺键而被当成「没读到」，
    // 结果白白少算这 50 分。记 0 才能正确相减。
    const claimable = Number(data.pointClaimBannerPromotion?.attributes?.claimable_points ?? 0)
    snapshot.claimable = Number.isFinite(claimable) ? Math.max(0, claimable) : 0

    // App 端：签到 + 阅读都只剩「还能拿多少」，只能靠前后相减算本次得分
    if (app) {
        snapshot.appTasks = Math.max(0, Number(app.readToEarn ?? 0)) + Math.max(0, Number(app.checkIn ?? 0))
    }

    return snapshot
}

/**
 * 前后两次快照相减，生成卡片用的拆分。
 *
 * @param before 开跑前的缺口（必填；没有它就无法归因，直接不显示明细）
 * @param after  收尾时的缺口（超时/读失败时没有，此时 earned=0 且 known=false）
 */
export function diffTaskBreakdown(
    before: TaskProgressSnapshot | undefined,
    after?: TaskProgressSnapshot
): TaskBreakdown | undefined {
    if (!before) return undefined

    const slices: TaskBreakdown = []
    for (const def of TASK_CATEGORIES) {
        const start = before[def.key]
        // 开跑前就没读到这一类（例如 App 通道不可用）：不猜，直接不列
        if (start === undefined) continue

        const available = Math.max(0, Math.round(start))
        // 今天本来就没有这类任务：不占卡片空间
        if (available <= 0) continue

        const end = after?.[def.key]
        const known = end !== undefined
        const remaining = end === undefined ? available : Math.max(0, Math.round(end))
        const earned = known ? Math.max(0, available - remaining) : 0

        slices.push({ ...def, earned, remaining, available, known })
    }

    return slices.length ? slices : undefined
}
