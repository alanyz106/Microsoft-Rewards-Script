import type { Page } from 'patchright'
import type { BasePromotion } from '../../../interface/DashboardData'
import { Workers } from '../../Workers'

/**
 * Quest / Punch Card 子任务处理器（modern 仪表盘专用）。
 *
 * 关键事实（2026-10-26 实测，详见 memory/troubleshooting.md §11）：
 * Quest 子任务的 destinationUrl **直接导航过去不算完成**，必须在
 * `https://rewards.bing.com/earn/quest/<questId>` 详情页里**点击**对应链接，
 * 进度才会 +1（点击会开新标签页并带上 `rdr=1&rdrig=<hex>` 参数）。
 *
 * 旧的三层兜底（PUBL 链接 / #dailyset 链接 / 直接导航）全部只在
 * dashboard、earn 页上找链接，而 Quest 子任务在这两个页面上没有独立链接，
 * 因此永远拿不到分 —— 这是独立于浏览器崩溃的缺陷。
 */
export class QuestActivity extends Workers {
    /** 本次点击后的结果，供上层决定是否继续走旧的兜底路径 */
    public async doQuestActivity(promotion: BasePromotion, page: Page, questId: string): Promise<QuestOutcome> {
        const title = (promotion.title ?? '').trim()
        if (!questId || !title) return 'notfound'

        const questUrl = `https://rewards.bing.com/earn/quest/${questId}`

        try {
            const before = await this.readQuestState(questId, promotion.offerId)

            this.bot.logger.info(
                this.bot.isMobile,
                'QUEST-ACTIVITY',
                `Processing | offerId=${promotion.offerId} | title="${title}" | quest=${questId} | progress=${before.progress}/${before.max} | childComplete=${before.childComplete}`
            )

            if (before.childComplete) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'QUEST-ACTIVITY',
                    `Already complete, skipping | offerId=${promotion.offerId}`
                )
                return 'done'
            }

            await page.goto(questUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
            await this.bot.utils.wait(3000)

            const target = await this.findTaskLink(page, title)
            if (!target) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'QUEST-ACTIVITY',
                    `No matching task link on quest page | offerId=${promotion.offerId} | title="${title}"`
                )
                return 'notfound'
            }

            if (target.disabled) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'QUEST-ACTIVITY',
                    `Task is locked (needs previous day / 24h cooldown), skipping | offerId=${promotion.offerId} | title="${title}"`
                )
                return 'disabled'
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'QUEST-ACTIVITY',
                `Clicking task link | offerId=${promotion.offerId} | ariaLabel="${target.ariaLabel}"`
            )

            const tabsBefore = page.context().pages().length
            await target.locator.click({ timeout: 10000 })
            await this.bot.utils.wait(6000)
            await this.closeExtraTabs(page, tabsBefore)

            const after = await this.readQuestState(questId, promotion.offerId)
            const progressed = after.childComplete || after.progress > before.progress

            if (progressed) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'QUEST-ACTIVITY',
                    `Completed | offerId=${promotion.offerId} | title="${title}" | progress=${after.progress}/${after.max}`,
                    'green'
                )
                return 'done'
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                'QUEST-ACTIVITY',
                `Clicked but no progress | offerId=${promotion.offerId} | title="${title}" | progress=${after.progress}/${after.max}`
            )
            return 'notfound'
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'QUEST-ACTIVITY',
                `Error | offerId=${promotion.offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
            return 'notfound'
        } finally {
            // 让下一个活动能像以前一样在 rewards 页上找链接
            if (!page.isClosed()) {
                await page.goto(this.bot.config.baseURL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                await this.bot.utils.wait(2000)
            }
        }
    }

    /**
     * 在 Quest 详情页按标题匹配活动链接。
     *
     * 新版页面有两种形态：
     *  - 已完成 / 可用：`<a aria-label="Search costumes, Find your Halloween look with Bing" href=...>`
     *  - 未解锁：`<span role="link" aria-disabled="true" aria-label="Explore gift picks, ...">`
     * 两者 aria-label 都是「按钮文案, 任务标题」，因此用「包含任务标题」来匹配最稳。
     */
    private async findTaskLink(
        page: Page,
        title: string
    ): Promise<{ locator: ReturnType<Page['locator']>; ariaLabel: string; disabled: boolean } | null> {
        const candidates = page.locator('a[aria-label], [role="link"][aria-label]')
        const count = await candidates.count()
        const titleLower = title.toLowerCase()

        let disabledMatch: { locator: ReturnType<Page['locator']>; ariaLabel: string; disabled: boolean } | null = null

        for (let i = 0; i < count; i++) {
            const node = candidates.nth(i)
            const ariaLabel = ((await node.getAttribute('aria-label')) ?? '').trim()
            if (!ariaLabel) continue
            if (!ariaLabel.toLowerCase().includes(titleLower)) continue

            const disabled = (await node.getAttribute('aria-disabled')) === 'true'
            if (!disabled) {
                return { locator: node, ariaLabel, disabled: false }
            }
            // 记住第一个「锁住」的匹配，方便上层输出更准确的原因
            if (!disabledMatch) disabledMatch = { locator: node, ariaLabel, disabled: true }
        }

        return disabledMatch
    }

    /** 读取某个 Quest 的当前进度（父卡片进度 + 指定子项是否已完成） */
    private async readQuestState(
        questId: string,
        offerId: string
    ): Promise<{ progress: number; max: number; childComplete: boolean }> {
        try {
            const data = await this.bot.browser.func.getDashboardData()
            const card = data.punchCards?.find(x => x.name === questId)
            if (!card) return { progress: 0, max: 0, childComplete: false }

            const child = card.childPromotions?.find(c => c.offerId === offerId)

            return {
                progress: card.parentPromotion?.pointProgress ?? 0,
                max: card.parentPromotion?.pointProgressMax ?? 0,
                childComplete: Boolean(child?.complete)
            }
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'QUEST-ACTIVITY',
                `Failed to read quest state | quest=${questId} | message=${error instanceof Error ? error.message : String(error)}`
            )
            return { progress: 0, max: 0, childComplete: false }
        }
    }

    /** 点击任务链接会开新标签页，这里把它关掉，只留主页面 */
    private async closeExtraTabs(page: Page, tabsBefore: number) {
        try {
            const context = page.context()
            const pages = context.pages()
            if (pages.length <= tabsBefore) return

            const extras = pages.filter(p => p !== page)
            for (const extra of extras) {
                await extra.close().catch(() => {})
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'QUEST-ACTIVITY',
                `Closed ${extras.length} extra tab(s) opened by the quest click`
            )
        } catch {
            // 关标签失败不影响主线，下一个活动会自己导航
        }
    }
}

export type QuestOutcome = 'done' | 'disabled' | 'notfound'
