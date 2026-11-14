import rebrowser, { BrowserContext } from 'patchright'
import { newInjectedContext } from 'fingerprint-injector'
import { BrowserFingerprintWithHeaders, FingerprintGenerator } from 'fingerprint-generator'

import type { MicrosoftRewardsBot } from '../index'
import { loadSessionData, saveFingerprintData } from '../util/Load'
import { UserAgentManager } from './UserAgent'

import type { Account, AccountProxy } from '../interface/Account'

/* Test Stuff
https://abrahamjuliot.github.io/creepjs/
https://botcheck.luminati.io/
https://fv.pro/
https://pixelscan.net/
https://www.browserscan.net/
*/

interface BrowserCreationResult {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

class Browser {
    private readonly bot: MicrosoftRewardsBot
    // 还活着的浏览器实例。正常路径上每个账号自己会关，这里登记只是为了在
    // 「单账号超时被放弃」时能一次性收尸（见 closeAllBrowsers）。
    private readonly liveBrowsers = new Set<rebrowser.Browser>()
    // 「清场」代数。超时放弃账号时自增，用来识别「清场之后才启动完成的幽灵浏览器」：
    // 超时正好卡在 launch 中间时，closeAllBrowsers 那一刻它还不在 liveBrowsers 里，
    // 不挡住就会留下一个没人管的 Chromium 吃内存。
    private cleanupEpoch = 0
    private static readonly BROWSER_ARGS = [
        '--no-sandbox',
        '--mute-audio',
        '--disable-setuid-sandbox',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        '--ignore-ssl-errors',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-web-authentication-ui',
        '--disable-external-intent-requests',
        '--disable-blink-features=Attestation',
        '--disable-features=WebAuthentication,PasswordManagerOnboarding,PasswordManager,EnablePasswordsAccountStorage,Passkeys,WebAuthenticationProxy,U2F',
        '--disable-save-password-bubble'
    ] as const

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    async createBrowser(account: Account): Promise<BrowserCreationResult> {
        const epochAtStart = this.cleanupEpoch
        let browser: rebrowser.Browser
        try {
            const proxyConfig = account.proxy.url
                ? {
                      server: this.formatProxyServer(account.proxy),
                      ...(account.proxy.username &&
                          account.proxy.password && {
                              username: account.proxy.username,
                              password: account.proxy.password
                          })
                  }
                : undefined

            if (proxyConfig) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'BROWSER-PROXY',
                    `Launching browser via proxy: ${proxyConfig.server}${proxyConfig.username ? ' (with auth)' : ''}`,
                    'cyan'
                )
            } else {
                this.bot.logger.info(this.bot.isMobile, 'BROWSER-PROXY', 'Launching browser directly (no proxy)')
            }

            browser = await rebrowser.chromium.launch({
                headless: this.bot.config.headless,
                ...(proxyConfig && { proxy: proxyConfig }),
                args: [...Browser.BROWSER_ARGS]
            })
            // 清场之后才启动完成的「幽灵浏览器」：直接关掉，别让它跟着下一个账号活
            if (epochAtStart !== this.cleanupEpoch) {
                await browser.close().catch(() => {})
                throw new Error('Browser launch raced with an account timeout; aborted')
            }
            this.liveBrowsers.add(browser)
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            this.bot.logger.error(this.bot.isMobile, 'BROWSER', `Launch failed: ${errorMessage}`)
            throw error
        }

        try {
            const sessionData = await loadSessionData(
                this.bot.config.sessionPath,
                account.email,
                account.saveFingerprint,
                this.bot.isMobile
            )

            const fingerprint = sessionData.fingerprint ?? (await this.generateFingerprint(this.bot.isMobile))

            const context = await newInjectedContext(browser as any, {
                fingerprint,
                newContextOptions: {
                    permissions: [],
                    ignoreHTTPSErrors: true
                }
            })

            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'credentials', {
                    value: {
                        create: () => Promise.reject(new Error('WebAuthn disabled')),
                        get: () => Promise.reject(new Error('WebAuthn disabled'))
                    }
                })
            })

            context.setDefaultTimeout(this.bot.utils.stringToNumber(this.bot.config?.globalTimeout ?? 30000))

            // ---- 生命周期探针 ----
            // 浏览器/上下文异常退出时，playwright 不会把原因告诉我们，只会让后续调用报
            // "Target page, context or browser has been closed"。挂上这些监听后，
            // 日志里能直接看到「什么时候、以什么原因」断的，避免再出现无从查证的 12 分钟空转。
            const accountLabel = account.email
            const platformLabel = this.bot.isMobile ? 'mobile' : 'desktop'
            let closingIntentionally = false

            browser.on('disconnected', () => {
                this.liveBrowsers.delete(browser)
                if (closingIntentionally) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'BROWSER-DISCONNECTED',
                        `Browser disconnected (expected) | ${accountLabel} | ${platformLabel}`
                    )
                    return
                }
                let browserPid = 'unknown'
                try {
                    browserPid = String((browser as any)?.process?.()?.pid ?? 'unknown')
                } catch {
                    // browser.process() 在某些情况下会抛错，忽略
                }
                this.bot.logger.error(
                    this.bot.isMobile,
                    'BROWSER-DISCONNECTED',
                    `Browser disconnected unexpectedly | ${accountLabel} | ${platformLabel} | pid=${browserPid}`
                )
            })

            context.on('close', () => {
                if (closingIntentionally) return
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CONTEXT-CLOSED',
                    `Browser context closed unexpectedly | ${accountLabel} | ${platformLabel}`
                )
            })

            // 记录「我们是主动关闭的」，避免把正常收尾误报成异常
            const originalClose = context.close.bind(context)
            ;(context as any).close = async (...args: any[]) => {
                closingIntentionally = true
                return originalClose(...args)
            }
            const originalBrowserClose = browser.close.bind(browser)
            ;(browser as any).close = async (...args: any[]) => {
                closingIntentionally = true
                return originalBrowserClose(...args)
            }

            await context.addCookies(sessionData.cookies)

            if (
                (account.saveFingerprint.mobile && this.bot.isMobile) ||
                (account.saveFingerprint.desktop && !this.bot.isMobile)
            ) {
                await saveFingerprintData(this.bot.config.sessionPath, account.email, this.bot.isMobile, fingerprint)
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'BROWSER',
                `Created browser with User-Agent: "${fingerprint.fingerprint.navigator.userAgent}"`
            )
            this.bot.logger.debug(this.bot.isMobile, 'BROWSER-FINGERPRINT', JSON.stringify(fingerprint))

            return { context: context as unknown as BrowserContext, fingerprint }
        } catch (error) {
            await browser.close().catch(() => {})
            throw error
        }
    }

    /**
     * 强制关掉所有还活着的浏览器。
     *
     * 只在「单账号超时被放弃」这种异常路径调用：那个卡死的账号已经把浏览器搞到
     * 不响应了，单靠 Promise 超时只是让循环继续，Chromium 还在占内存（本机 1.8G，
     * 两个实例就会进 swap）。这里一并收尸，保证下一个账号拿到干净环境。
     * 每个 close 再套 15s 上限，避免连关闭动作本身也挂住。
     */
    async closeAllBrowsers(reason: string): Promise<void> {
        this.cleanupEpoch++
        const browsers = [...this.liveBrowsers]
        this.liveBrowsers.clear()
        if (!browsers.length) return

        this.bot.logger.warn('main', 'BROWSER-CLEANUP', `Closing ${browsers.length} live browser(s) | ${reason}`)
        await Promise.allSettled(
            browsers.map(async b => {
                await Promise.race([
                    b.close().catch(() => {}),
                    new Promise<void>(resolve => setTimeout(resolve, 15000))
                ])
            })
        )
    }

    private formatProxyServer(proxy: AccountProxy): string {
        try {
            const urlObj = new URL(proxy.url)
            const protocol = urlObj.protocol.replace(':', '')
            return `${protocol}://${urlObj.hostname}:${proxy.port}`
        } catch {
            return `${proxy.url}:${proxy.port}`
        }
    }

    async generateFingerprint(isMobile: boolean) {
        const fingerPrintData = new FingerprintGenerator().getFingerprint({
            devices: isMobile ? ['mobile'] : ['desktop'],
            operatingSystems: isMobile ? ['android', 'ios'] : ['windows', 'linux'],
            browsers: [{ name: 'edge' }]
        })

        const userAgentManager = new UserAgentManager(this.bot)
        const updatedFingerPrintData = await userAgentManager.updateFingerprintUserAgent(fingerPrintData, isMobile)

        return updatedFingerPrintData
    }
}

export default Browser
