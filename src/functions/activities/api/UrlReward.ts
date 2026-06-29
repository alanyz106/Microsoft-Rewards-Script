import type { AxiosRequestConfig } from 'axios'
import type { Page } from 'patchright'
import type { BasePromotion } from '../../../interface/DashboardData'
import { Workers } from '../../Workers'

export class UrlReward extends Workers {
    private cookieHeader: string = ''

    private fingerprintHeader: { [x: string]: string } = {}

    private gainedPoints: number = 0

    private oldBalance: number = this.bot.userData.currentPoints

    public async doUrlReward(promotion: BasePromotion, page?: Page) {
        if (!this.bot.requestToken && this.bot.rewardsVersion === 'legacy') {
            // 当 requestToken 不可用时，尝试用浏览器直接导航到活动页面
            if (page) {
                await this.doUrlRewardBrowser(promotion, page)
                return
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                'Skipping: Request token not available, this activity requires it!'
            )
            return
        }

        // Fallback to API-based reward when requestToken is available
        const offerId = promotion.offerId

        this.bot.logger.info(
            this.bot.isMobile,
            'URL-REWARD',
            `Starting UrlReward | offerId=${offerId} | geo=${this.bot.userData.geoLocale} | oldBalance=${this.oldBalance}`
        )

        try {
            this.cookieHeader = this.bot.browser.func.buildCookieHeader(
                this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop,
                ['bing.com', 'live.com', 'microsoftonline.com']
            )

            const fingerprintHeaders = { ...this.bot.fingerprint.headers }
            delete fingerprintHeaders['Cookie']
            delete fingerprintHeaders['cookie']
            this.fingerprintHeader = fingerprintHeaders

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Prepared UrlReward headers | offerId=${offerId} | cookieLength=${this.cookieHeader.length} | fingerprintHeaderKeys=${Object.keys(this.fingerprintHeader).length}`
            )

            const formData = new URLSearchParams({
                id: offerId,
                hash: promotion.hash,
                timeZone: this.bot.userData.timezoneOffset,
                activityAmount: '1',
                dbs: '0',
                form: '',
                type: '',
                __RequestVerificationToken: this.bot.requestToken
            })

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Prepared UrlReward form data | offerId=${offerId} | hash=${promotion.hash} | timeZone=${this.bot.userData.timezoneOffset} | activityAmount=1`
            )

            const request: AxiosRequestConfig = {
                url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest',
                method: 'POST',
                headers: {
                    ...(this.bot.fingerprint?.headers ?? {}),
                    Cookie: this.cookieHeader,
                    Referer: 'https://rewards.bing.com/',
                    Origin: 'https://rewards.bing.com'
                },
                data: formData
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Sending UrlReward request | offerId=${offerId} | url=${request.url}`
            )

            const response = await this.bot.axios.request(request)

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Received UrlReward response | offerId=${offerId} | status=${response.status}`
            )

            const newBalance = await this.bot.browser.func.getCurrentPoints()
            this.gainedPoints = newBalance - this.oldBalance

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Balance delta after UrlReward | offerId=${offerId} | oldBalance=${this.oldBalance} | newBalance=${newBalance} | gainedPoints=${this.gainedPoints}`
            )

            if (this.gainedPoints > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints

                this.bot.logger.info(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `Completed UrlReward | offerId=${offerId} | status=${response.status} | gainedPoints=${this.gainedPoints} | newBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `Failed UrlReward with no points | offerId=${offerId} | status=${response.status} | oldBalance=${this.oldBalance} | newBalance=${newBalance}`
                )
            }

            this.bot.logger.debug(this.bot.isMobile, 'URL-REWARD', `Waiting after UrlReward | offerId=${offerId}`)

            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'URL-REWARD',
                `Error in doUrlReward | offerId=${promotion.offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    /**
     * Browser-based fallback: click uncompleted activity links on the Rewards page,
     * falling back to direct destinationUrl navigation if links are not clickable.
     * Used when RequestVerificationToken is not available (Chinese/Next.js dashboard).
     *
     * Two strategies:
     *  1. Click PUBL links (fast, but fails if links are in a collapsed Disclosure panel)
     *  2. Navigate directly to destinationUrl (reliable fallback for mobile/collapsed UIs)
     */
    private async doUrlRewardBrowser(promotion: BasePromotion, page: Page) {
        const offerId = promotion.offerId
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)

        // Resolve the destination URL once (used by fallback and final navigation)
        const destinationUrl =
            promotion.destinationUrl ||
            (promotion.attributes as Record<string, any>)?.destination ||
            ''

        this.bot.logger.info(
            this.bot.isMobile,
            'URL-REWARD-BROWSER',
            `Processing | offerId=${offerId} | title="${promotion.title}" | hasDestinationUrl=${!!destinationUrl}`
        )

        try {
            // Navigate to baseURL if the current page is not the rewards dashboard or earn page
            // (e.g. after a previous activity's click navigated to bing.com/search)
            const currentUrl = page.url()
            if (
                currentUrl &&
                !currentUrl.includes('rewards.bing.com')
            ) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'URL-REWARD-BROWSER',
                    `Navigating back to rewards page from ${currentUrl} | offerId=${offerId}`
                )
                await page.goto(this.bot.config.baseURL, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {})
                await this.bot.utils.wait(3000)
            }

            // First try: click PUBL links on the dashboard/earn page
            // Use a short timeout so invisible links (collapsed Disclosure panels) fail fast
            const activityLinks = page.locator('a[href*="PUBL=RewardsDO"]')
            const linkCount = await activityLinks.count()

            if (linkCount > 0) {
                let clicked = false
                for (let i = 0; i < linkCount; i++) {
                    const link = activityLinks.nth(i)
                    const linkText = await link.innerText()

                    if (!linkText.includes('已完成')) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'URL-REWARD-BROWSER',
                            `Attempting PUBL click | offerId=${offerId} | text="${linkText.trim().slice(0, 80)}"`
                        )

                        try {
                            await link.click({ timeout: 5000 })
                            clicked = true
                            break
                        } catch (clickError) {
                            // Playwright click failed (element not visible on mobile).
                            // Try programmatic click via evaluate as fallback
                            this.bot.logger.debug(
                                this.bot.isMobile,
                                'URL-REWARD-BROWSER',
                                `PUBL click timeout, trying evaluate click | offerId=${offerId}`
                            )

                            try {
                                const href = await link.getAttribute('href')
                                if (href) {
                                    await page.evaluate((url) => {
                                        window.location.href = url
                                    }, href)
                                    clicked = true
                                    break
                                }
                            } catch (evalError) {
                                this.bot.logger.debug(
                                    this.bot.isMobile,
                                    'URL-REWARD-BROWSER',
                                    `Evaluate click also failed | offerId=${offerId} | message=${evalError instanceof Error ? evalError.message : String(evalError)}`
                                )
                            }
                            break // Exit loop, fall back to direct navigation
                        }
                    }
                }

                if (clicked) {
                    // Wait for the RSC action to process on the server
                    await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))

                    const newBalance = await this.bot.browser.func.getCurrentPoints()
                    this.gainedPoints = newBalance - this.oldBalance

                    if (this.gainedPoints > 0) {
                        this.bot.userData.currentPoints = newBalance
                        this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints

                        this.bot.logger.info(
                            this.bot.isMobile,
                            'URL-REWARD-BROWSER',
                            `Completed via dashboard click | offerId=${offerId} | title="${promotion.title}" | gainedPoints=${this.gainedPoints} | newBalance=${newBalance}`,
                            'green'
                        )
                        return
                    }

                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'URL-REWARD-BROWSER',
                        `No points gained via dashboard click | offerId=${offerId} | title="${promotion.title}"`
                    )
                }
            } else {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'URL-REWARD-BROWSER',
                    `No PUBL links found, falling back to direct navigation | offerId=${offerId}`
                )
            }

            // Second try: navigate directly to the destination URL
            if (!destinationUrl) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD-BROWSER',
                    `No destinationUrl available | offerId=${offerId} | skipping`
                )
                return
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'URL-REWARD-BROWSER',
                `Navigating to destinationUrl | offerId=${offerId}`
            )

            await page.goto(destinationUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))

            const newBalance = await this.bot.browser.func.getCurrentPoints()
            this.gainedPoints = newBalance - this.oldBalance

            if (this.gainedPoints > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints

                this.bot.logger.info(
                    this.bot.isMobile,
                    'URL-REWARD-BROWSER',
                    `Completed via direct navigation | offerId=${offerId} | title="${promotion.title}" | gainedPoints=${this.gainedPoints}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD-BROWSER',
                    `No points gained via direct navigation | offerId=${offerId} | title="${promotion.title}"`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'URL-REWARD-BROWSER',
                `Unexpected error | offerId=${offerId} | title="${promotion.title}" | message=${error instanceof Error ? error.message : String(error)}`
            )

            // Last resort: try direct navigation from the catch block too
            if (destinationUrl) {
                try {
                    await page.goto(destinationUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
                    await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
                    const newBalance = await this.bot.browser.func.getCurrentPoints()
                    this.gainedPoints = newBalance - this.oldBalance
                    if (this.gainedPoints > 0) {
                        this.bot.userData.currentPoints = newBalance
                        this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'URL-REWARD-BROWSER',
                            `Completed via emergency navigation | offerId=${offerId} | gainedPoints=${this.gainedPoints}`,
                            'green'
                        )
                    }
                } catch {
                    // Nothing more we can do
                }
            }
        } finally {
            // Navigate back to the rewards page so the next activity can find links
            await page.goto(this.bot.config.baseURL, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {})
            await this.bot.utils.wait(3000)
        }
    }
}
