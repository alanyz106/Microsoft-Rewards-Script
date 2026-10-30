import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'
import type {
    DashboardData,
    PunchCard,
    BasePromotion,
    FindClippyPromotion,
    PurplePromotionalItem
} from '../interface/DashboardData'
import type { AppDashboardData } from '../interface/AppDashBoardData'

export class Workers {
    public bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    public async doDailySet(data: DashboardData, page: Page) {
        const todayKey = this.bot.utils.getFormattedDate()
        const todayData = data.dailySetPromotions[todayKey]

        const activitiesUncompleted = todayData?.filter(x => !x?.complete && x.pointProgressMax > 0) ?? []

        if (!activitiesUncompleted.length) {
            this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have already been completed')
            return
        }

        this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'Started solving "Daily Set" items')

        await this.solveActivities(activitiesUncompleted, page)

        this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have been completed')
    }

    public async doMorePromotions(data: DashboardData, page: Page) {
        const morePromotions: BasePromotion[] = [
            ...new Map(
                [...(data.morePromotions ?? []), ...(data.morePromotionsWithoutPromotionalItems ?? [])]
                    .filter(Boolean)
                    .map(p => [p.offerId, p as BasePromotion] as const)
            ).values()
        ]

        const activitiesUncompleted: BasePromotion[] =
            morePromotions?.filter(x => {
                if (x.complete) return false
                if (x.pointProgressMax <= 0) return false
                if (x.exclusiveLockedFeatureStatus === 'locked') return false
                if (!x.promotionType) return false

                return true
            }) ?? []

        if (!activitiesUncompleted.length) {
            this.bot.logger.info(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                'All "More Promotion" items have already been completed'
            )
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'MORE-PROMOTIONS',
            `Started solving ${activitiesUncompleted.length} "More Promotions" items`
        )

        // Navigate to the earn page so activity links are present in the DOM for clicking
        this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', 'Navigating to /earn page')
        await page.goto('https://rewards.bing.com/earn', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
        await this.bot.utils.wait(3000)

        await this.solveActivities(activitiesUncompleted, page)

        this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', 'All "More Promotion" items have been completed')
    }

    public async doAppPromotions(data: AppDashboardData) {
        const appRewards = data.response.promotions.filter(x => {
            if (x.attributes['complete']?.toLowerCase() !== 'false') return false
            if (!x.attributes['offerid']) return false
            if (!x.attributes['type']) return false
            if (x.attributes['type'] !== 'sapphire') return false

            return true
        })

        if (!appRewards.length) {
            this.bot.logger.info(
                this.bot.isMobile,
                'APP-PROMOTIONS',
                'All "App Promotions" items have already been completed'
            )
            return
        }

        for (const reward of appRewards) {
            await this.bot.activities.doAppReward(reward)
            // A delay between completing each activity
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
        }

        this.bot.logger.info(this.bot.isMobile, 'APP-PROMOTIONS', 'All "App Promotions" items have been completed')
    }

    public async doSpecialPromotions(data: DashboardData) {
        const specialPromotions: PurplePromotionalItem[] = [
            ...new Map(
                [...(data.promotionalItems ?? [])]
                    .filter(Boolean)
                    .map(p => [p.offerId, p as PurplePromotionalItem] as const)
            ).values()
        ]

        const supportedPromotions = ['ww_banner_optin_2x']

        const specialPromotionsUncompleted: PurplePromotionalItem[] =
            specialPromotions?.filter(x => {
                if (x.complete) return false
                if (x.exclusiveLockedFeatureStatus === 'locked') return false
                if (!x.promotionType) return false

                const offerId = (x.offerId ?? '').toLowerCase()
                return supportedPromotions.some(s => offerId.includes(s))
            }) ?? []

        for (const activity of specialPromotionsUncompleted) {
            try {
                const type = activity.promotionType?.toLowerCase() ?? ''
                const name = activity.name?.toLowerCase() ?? ''
                const offerId = (activity as PurplePromotionalItem).offerId

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SPECIAL-ACTIVITY',
                    `Processing activity | title="${activity.title}" | offerId=${offerId} | type=${type}"`
                )

                switch (type) {
                    // UrlReward
                    case 'urlreward': {
                        // Special "Double Search Points" activation
                        if (name.includes('ww_banner_optin_2x')) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Found activity type "Double Search Points" | title="${activity.title}" | offerId=${offerId}`
                            )

                            await this.bot.activities.doDoubleSearchPoints(activity)
                        }
                        break
                    }

                    // Unsupported types
                    default: {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'SPECIAL-ACTIVITY',
                            `Skipped activity "${activity.title}" | offerId=${offerId} | Reason: Unsupported type "${activity.promotionType}"`
                        )
                        break
                    }
                }
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'SPECIAL-ACTIVITY',
                    `Error while solving activity "${activity.title}" | message=${error instanceof Error ? error.message : String(error)}`
                )
            }
        }

        this.bot.logger.info(this.bot.isMobile, 'SPECIAL-ACTIVITY', 'All "Special Activites" items have been completed')
    }

    public async doClaimBonusPoints(data: DashboardData) {
        const pointsActivity = data.pointClaimBannerPromotion

        if (!pointsActivity) {
            this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'No claim bonus points banner found')
            return
        }

        if (pointsActivity.complete) {
            this.bot.logger.info(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `Bonus points have already been claimed | offerId=${pointsActivity.offerId}`
            )
            return
        }

        await this.bot.activities.doClaimBonusPoints()

        this.bot.logger.info(
            this.bot.isMobile,
            'CLAIM-BONUS-POINTS',
            `Bonus points have been claimed | title="${pointsActivity.title}" | offerId=${pointsActivity.offerId}`
        )
    }

    public async doPunchCards(data: DashboardData, page: Page) {
        const punchCards =
            data.punchCards?.filter(
                x => !x.parentPromotion?.complete && (x.parentPromotion?.pointProgressMax ?? 0) > 0
            ) ?? []

        // 按卡片逐个处理：Quest 子任务必须知道自己属于哪张卡片，
        // 才能在 /earn/quest/<questId> 详情页里点链接（详见 troubleshooting.md §11）
        const cardsPending = punchCards.filter(card =>
            (card.childPromotions ?? []).some(x => {
                if (x.complete) return false
                if (x.exclusiveLockedFeatureStatus === 'locked') return false
                if (!x.promotionType) return false

                return true
            })
        )

        if (!cardsPending.length) {
            this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'All "Punch Card" items have already been completed')
            return
        }

        for (const card of cardsPending) {
            const activitiesUncompleted: BasePromotion[] = (card.childPromotions ?? []).filter(x => {
                if (x.complete) return false
                if (x.exclusiveLockedFeatureStatus === 'locked') return false
                if (!x.promotionType) return false

                return true
            })

            this.bot.logger.info(
                this.bot.isMobile,
                'PUNCHCARD',
                `Started solving ${activitiesUncompleted.length} "Punch Card" items | quest=${card.name} | title="${card.parentPromotion?.title ?? ''}" | progress=${card.parentPromotion?.pointProgress}/${card.parentPromotion?.pointProgressMax}`
            )

            await this.solveActivities(activitiesUncompleted, page, card)
        }

        this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'All "Punch Card" items have been completed')
    }

    private async solveActivities(activities: BasePromotion[], page: Page, punchCard?: PunchCard) {
        for (const activity of activities) {
            // 浏览器已关闭时继续逐个尝试只会白等（每次 goto 都要等到超时），直接中止整批
            if (page.isClosed()) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'ACTIVITY',
                    `Aborting remaining ${activities.length} activities: browser/page was closed unexpectedly | next="${activity.title}" | offerId=${activity.offerId}`
                )
                break
            }

            try {
                const type = activity.promotionType?.toLowerCase() ?? ''
                const name = activity.name?.toLowerCase() ?? ''
                const offerId = (activity as BasePromotion).offerId
                const destinationUrl = activity.destinationUrl?.toLowerCase() ?? ''

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'ACTIVITY',
                    `Processing activity | title="${activity.title}" | offerId=${offerId} | type=${type} | punchCard="${punchCard?.parentPromotion?.title ?? 'none'}"`
                )

                switch (type) {
                    // Quiz-like activities (Poll / regular quiz variants)
                    case 'quiz': {
                        const basePromotion = activity as BasePromotion

                        // Poll (usually 10 points, pollscenarioid in URL)
                        if (activity.pointProgressMax === 10 && destinationUrl.includes('pollscenarioid')) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Found activity type "Poll" | title="${activity.title}" | offerId=${offerId}`
                            )

                            //await this.bot.activities.doPoll(basePromotion)
                            break
                        }

                        // All other quizzes handled via Quiz API
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'ACTIVITY',
                            `Found activity type "Quiz" | title="${activity.title}" | offerId=${offerId}`
                        )

                        await this.bot.activities.doQuiz(basePromotion)
                        break
                    }

                    // UrlReward
                    case 'urlreward': {
                        const basePromotion = activity as BasePromotion

                        // Search on Bing are subtypes of "urlreward"
                        if (name.includes('exploreonbing')) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Found activity type "SearchOnBing" | title="${activity.title}" | offerId=${offerId}`
                            )

                            await this.bot.activities.doSearchOnBing(basePromotion, page)
                        } else if (punchCard) {
                            // Quest / Punch Card 子任务：必须在 quest 详情页里点击链接，
                            // 直接导航 destinationUrl 或点 dashboard 链接都无效（§11）。
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Found activity type "QuestActivity" | title="${activity.title}" | offerId=${offerId} | quest=${punchCard.name}`
                            )

                            const outcome = await this.bot.activities.doQuestActivity(
                                basePromotion,
                                page,
                                punchCard.name
                            )

                            // Quest 点击没成功（链接锁住 / 页面上找不到）时，退回旧的三层兜底，
                            // 至少不要让 More Promotions 那套逻辑白丢。
                            if (outcome === 'notfound') {
                                await this.bot.activities.doUrlReward(basePromotion, page)
                            }
                        } else {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Found activity type "UrlReward" | title="${activity.title}" | offerId=${offerId}`
                            )

                            await this.bot.activities.doUrlReward(basePromotion, page)
                        }
                        break
                    }

                    // Find Clippy specific promotion type
                    case 'findclippy': {
                        const clippyPromotion = activity as unknown as FindClippyPromotion

                        this.bot.logger.info(
                            this.bot.isMobile,
                            'ACTIVITY',
                            `Found activity type "FindClippy" | title="${activity.title}" | offerId=${offerId}`
                        )

                        await this.bot.activities.doFindClippy(clippyPromotion)
                        break
                    }

                    // Unsupported types
                    default: {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'ACTIVITY',
                            `Skipped activity "${activity.title}" | offerId=${offerId} | Reason: Unsupported type "${activity.promotionType}"`
                        )
                        break
                    }
                }

                // Cooldown
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'ACTIVITY',
                    `Error while solving activity "${activity.title}" | message=${error instanceof Error ? error.message : String(error)}`
                )

                // 浏览器/页面已关闭：立即终止，不再逐个空转
                if (this.bot.browser.func.isBrowserClosedError(error) || page.isClosed()) {
                    this.bot.logger.error(
                        this.bot.isMobile,
                        'ACTIVITY',
                        `Aborting remaining activities: browser was closed unexpectedly | after="${activity.title}"`
                    )
                    break
                }
            }
        }
    }
}
