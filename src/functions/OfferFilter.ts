/**
 * 「这个奖励项到底能不能拿到分」的判定 —— 卡片缺口统计与 Earnable 日志共用一份。
 *
 * 背景（2026-11-22）：推送卡片上「其他活动 还差 605」里，真正能做的只有 5 分，
 * 剩下 600 分全是结构上做不掉的项：500 分「装 Bing App」、50 分 Edge 引导、
 * 4 个 10 分 exploreonbing。用户看到的就是「还差几百分」这种假缺口。
 *
 * 判定依据是**本地实跑日志的统计**（2026-10-01 起 journald 全量，尝试次数 vs 进账次数），
 * 不是猜的。只剔除「从未进账且机制上就不可能」的家族；偶尔能成的（NFL 点击 1/217）
 * 一律保留 —— 宁可留下一个偶发缺口，也不能把真能拿的分从统计里删掉。
 *
 * ⚠️ 这里只做「减法」，不参与点击/执行：脚本仍然会去尝试这些项（有些家族以后
 * 可能被微软修好），只是**不再把它们的未完成分值算进缺口**。
 */

/** offerId / 标题里的特征 → 为什么拿不到分。顺序即匹配优先级 */
interface UnearnableRule {
    /** 名字用于日志，方便回溯是哪条规则砍掉的 */
    name: string
    match: (offerId: string, title: string) => boolean
    reason: string
}

const UNEARNABLE_RULES: UnearnableRule[] = [
    {
        name: 'exploreonbing',
        // ENUS_creditreport_exploreonbing_activation_Evergreen 等 40+ 个变体
        match: id => /exploreonbing/i.test(id),
        reason: 'exploreonbing 激活接口恒 400（历史 400+ 次尝试 0 进账）'
    },
    {
        name: 'bing-app-install',
        // WW_Rewards_offerlist_500_points_202503「Earn rewards anywhere with the Bing App」
        match: (id, title) =>
            /offerlist_\d+_points/i.test(id) || /earn rewards anywhere with the bing app/i.test(title),
        reason: '要求安装 Bing App 才算（网页端点击不计数）'
    },
    {
        name: 'edge-onboarding',
        // ENUS_Rewards_Onbrd45_Edge_PwdPrtct / _GenVal「Lock and key」等
        match: (id, title) => /Rewards_Onbrd\d+_Edge/i.test(id) || /^lock and key/i.test(title),
        reason: 'Edge 引导系列，页面无可用入口（历史 280+ 次尝试 0 进账）'
    },
    {
        name: 'store-lifecycle',
        // ZHHK_Lifecycle-Shop_and_Earn_reminder_D7「賺得更多點數」
        match: (id, title) => /lifecycle-?.*reminder/i.test(id) || /^shop and earn/i.test(title),
        reason: '需要在 Microsoft Store 真实下单才触发（历史 45 次尝试 0 进账）'
    },
    {
        name: 'welcome-tour',
        // Gamification_FRE_Offer6nonwindows「Take the tour」
        match: (id, title) => /FRE_Offer\d+(nonwindows|windows)?/i.test(id) || /^take the tour$/i.test(title),
        reason: '欢迎导览无主动入口'
    }
]

/**
 * 返回「拿不到分」的原因；能拿（或无法判定）时返回 undefined。
 *
 * 传 undefined 的字段安全：默认当作「不匹配」，宁可少剔除也不要误杀。
 */
export function unearnableOfferReason(offerId: string | undefined, title: string | undefined): string | undefined {
    const id = String(offerId ?? '')
    const t = String(title ?? '')
    for (const rule of UNEARNABLE_RULES) {
        if (rule.match(id, t)) return rule.reason
    }
    return undefined
}

/** 便捷布尔版，给不需要原因的调用方用 */
export function isEarnableOffer(offerId: string | undefined, title: string | undefined): boolean {
    return unearnableOfferReason(offerId, title) === undefined
}
