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
     * Browser-based fallback: click the activity link on the Rewards dashboard to trigger the RSC action.
     * Used when RequestVerificationToken is not available (Chinese/Next.js dashboard).
     */
    private async doUrlRewardBrowser(promotion: BasePromotion, page: Page) {
        const offerId = promotion.offerId
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)

        // Determine the URL to navigate to
        const destinationUrl =
            promotion.destinationUrl ||
            (promotion.attributes as Record<string, any>)?.destination ||
            ''

        if (!destinationUrl) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD-BROWSER',
                `No destination URL available | offerId=${offerId} | title="${promotion.title}"`
            )
            return
        }

        // Extract the form parameter from the destination URL to use as a unique selector
        const formMatch = destinationUrl.match(/[?&]form=([^&]+)/)
        const formParam = formMatch ? formMatch[1] : null

        this.bot.logger.info(
            this.bot.isMobile,
            'URL-REWARD-BROWSER',
            `Clicking activity on dashboard | offerId=${offerId} | title="${promotion.title}" | form=${formParam ?? 'none'}`
        )

        try {
            if (formParam) {
                // Find the link by its unique form parameter and click it
                const link = page.locator(`a[href*="${formParam}"]`).first()
                await link.click({ timeout: 15000 })
            } else {
                // Fallback: try to find by a portion of the query string
                const queryPart = destinationUrl.split('?')[1]?.slice(0, 50)
                if (queryPart) {
                    const link = page.locator(`a[href*="${queryPart}"]`).first()
                    await link.click({ timeout: 15000 })
                } else {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'URL-REWARD-BROWSER',
                        `No form param or query string to match | offerId=${offerId}`
                    )
                    return
                }
            }

            // Wait for the RSC action to process on the server
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))

            // Check points — the page stays on the dashboard (SPA behavior),
            // getCurrentPoints() fetches fresh data from the API
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

            // Fallback: try direct navigation to the destination URL
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
                        `Completed via fallback navigation | offerId=${offerId} | title="${promotion.title}" | gainedPoints=${this.gainedPoints} | newBalance=${newBalance}`,
                        'green'
                    )
                } else {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'URL-REWARD-BROWSER',
                        `No points gained via fallback navigation | offerId=${offerId} | title="${promotion.title}" | oldBalance=${this.oldBalance} | newBalance=${newBalance}`
                    )
                }
            } catch (fallbackError) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'URL-REWARD-BROWSER',
                    `Fallback navigation also failed | offerId=${offerId} | title="${promotion.title}" | message=${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
                )
            }
        } finally {
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
        }
    }
}
