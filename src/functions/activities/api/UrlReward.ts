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
     * Browser-based fallback: click uncompleted activity links on the Rewards page
     * to trigger the RSC action. Used when RequestVerificationToken is not available
     * (Chinese/Next.js dashboard).
     */
    private async doUrlRewardBrowser(promotion: BasePromotion, page: Page) {
        const offerId = promotion.offerId
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(
            this.bot.isMobile,
            'URL-REWARD-BROWSER',
            `Looking for uncompleted activities on current page | offerId=${offerId} | title="${promotion.title}"`
        )

        try {
            // Find all uncompleted activity links on the current page
            // These are <a> tags pointing to Bing search with rewards tracking,
            // showing "+N" text (uncompleted) rather than "已完成" (completed)
            const activityLinks = page.locator('a[href*="PUBL=RewardsDO"]')
            const linkCount = await activityLinks.count()

            if (linkCount === 0) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD-BROWSER',
                    `No activity links found on current page | offerId=${offerId}`
                )
                return
            }

            let clicked = false
            for (let i = 0; i < linkCount; i++) {
                const link = activityLinks.nth(i)
                const linkText = await link.innerText()

                // Only click links that are not yet completed
                if (!linkText.includes('已完成')) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'URL-REWARD-BROWSER',
                        `Clicking activity link | offerId=${offerId} | text="${linkText.trim().slice(0, 80)}"`
                    )

                    await link.click({ timeout: 15000 })
                    clicked = true
                    break
                }
            }

            if (!clicked) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD-BROWSER',
                    `All activity links already completed on current page | offerId=${offerId}`
                )
                return
            }

            // Wait for the RSC action to process on the server
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))

            // Check points
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
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD-BROWSER',
                    `No points gained via dashboard click | offerId=${offerId} | title="${promotion.title}" | oldBalance=${this.oldBalance} | newBalance=${newBalance}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'URL-REWARD-BROWSER',
                `Dashboard click error | offerId=${offerId} | title="${promotion.title}" | message=${error instanceof Error ? error.message : String(error)}`
            )

            // Fallback: navigate to the destination URL directly
            const destinationUrl =
                promotion.destinationUrl ||
                (promotion.attributes as Record<string, any>)?.destination ||
                ''

            if (!destinationUrl) return

            this.bot.logger.info(
                this.bot.isMobile,
                'URL-REWARD-BROWSER',
                `Falling back to direct navigation | offerId=${offerId}`
            )

            try {
                await page.goto(destinationUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
                await page.goto(this.bot.config.baseURL, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {})
                await this.bot.utils.wait(3000)

                const newBalance = await this.bot.browser.func.getCurrentPoints()
                this.gainedPoints = newBalance - this.oldBalance

                if (this.gainedPoints > 0) {
                    this.bot.userData.currentPoints = newBalance
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints

                    this.bot.logger.info(
                        this.bot.isMobile,
                        'URL-REWARD-BROWSER',
                        `Completed via fallback navigation | offerId=${offerId} | gainedPoints=${this.gainedPoints}`,
                        'green'
                    )
                }
            } catch (fallbackError) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'URL-REWARD-BROWSER',
                    `Fallback navigation also failed | offerId=${offerId} | message=${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
                )
            }
        } finally {
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
        }
    }
}
