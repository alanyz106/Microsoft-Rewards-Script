import type { DashboardData } from '../interface/DashboardData'

/**
 * 会员等级（铜牌 / 银牌 / 金牌），推送卡片里显示在节点信息右边
 *
 * ⚠️ 必须按 `activeLevel` 的 key 映射，不能按名称匹配：
 * 同一个人等级的名称会随账号语言变，实测同一份代码下
 *   美区账号（langCode=en）： "Member" / "Silver Member" / "Gold Member"
 *   HK 账号（语言 zh-HK）： "成員" / "銀級會員" / "金級會員"
 * 拿名称去匹配 "Gold" 在 HK 账号上会直接失配，等级就显示不出来。
 */

export type MemberLevel = 'bronze' | 'silver' | 'gold'

interface LevelStyle {
    level: MemberLevel
    /** 卡片上的两字简称 */
    label: string
    /** 徽章底色 + 文字色：铜/银/金各自有辨识度，又不刺眼 */
    bg: string
    fg: string
}

const LEVEL_STYLES: Record<MemberLevel, LevelStyle> = {
    bronze: { level: 'bronze', label: '铜牌', bg: '#fdf0e6', fg: '#a0522d' },
    silver: { level: 'silver', label: '银牌', bg: '#f1f3f5', fg: '#5c6b7a' },
    gold: { level: 'gold', label: '金牌', bg: '#fff8e1', fg: '#b8860b' }
}

/**
 * 接口里等级 key → 铜/银/金。
 * newLevel1=Member(铜) / newLevel2=Silver Member(银) / newLevel3=Gold Member(金)，
 * 2026-11-20 用 5 个账号实测确认（3 个 US 金牌、1 个 HK 银牌、HK 账号名称为繁体）。
 */
const LEVEL_BY_KEY: Record<string, MemberLevel> = {
    newLevel1: 'bronze',
    newLevel2: 'silver',
    newLevel3: 'gold'
}

/**
 * 从 dashboard 读会员等级。读不到返回 undefined（卡片上就不显示，绝不猜一个）。
 *
 * 兜底：key 不认识时按名称再试一次——万一微软将来换 key（如 newLevel4），
 * 至少还能靠 "Gold/Silver/Member"、"金級/銀級/成員" 认出来，而不是整块消失。
 */
export function readMemberLevel(data: DashboardData | undefined): MemberLevel | undefined {
    const info = data?.userStatus?.levelInfo
    if (!info) return undefined

    const byKey = LEVEL_BY_KEY[String(info.activeLevel ?? '')]
    if (byKey) return byKey

    // key 变了才走到这里：用 activeLevelName（或 levels[] 里 active 的那项）按关键词兜底
    const activeFromArray = (info.levels ?? []).find(l => l.active)?.name
    const name = String(info.activeLevelName ?? activeFromArray ?? '').toLowerCase()
    if (!name) return undefined
    if (/gold|金/.test(name)) return 'gold'
    if (/silver|銀|银/.test(name)) return 'silver'
    if (/member|成員|成员/.test(name)) return 'bronze'
    return undefined
}

/** 卡片上的等级徽章 HTML；等级未知时不渲染（返回空串，不占位置） */
export function memberBadgeHtml(level?: MemberLevel): string {
    if (!level) return ''
    const s = LEVEL_STYLES[level]
    return (
        `<span style="display:inline-block;margin-left:4px;padding:0 5px;border-radius:3px;` +
        `background:${s.bg};color:${s.fg};font-size:10px;font-weight:bold;white-space:nowrap;">${s.label}</span>`
    )
}
