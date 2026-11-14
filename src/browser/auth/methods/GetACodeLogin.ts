import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'
import fs from 'fs'
import { getErrorMessage, getSubtitleMessage, promptInput } from './LoginUtils'

export class CodeLogin {
    private readonly textInputSelector = '[data-testid="codeInputWrapper"]'
    private readonly secondairyInputSelector = 'input[id="otc-confirmation-input"], input[name="otc"]'
    private readonly maxManualSeconds = 60
    private readonly maxManualAttempts = 5
    // 可选：无人值守试运行时，由外部把微软邮箱验证码写入该文件（不设置则完全走原来的 stdin 交互）
    private readonly codeFile = (process.env.MS_REWARDS_EMAIL_CODE_FILE ?? '').trim()
    private readonly codeFileWaitSeconds = Math.max(
        60,
        Number(process.env.MS_REWARDS_EMAIL_CODE_TIMEOUT ?? 900) || 900
    )

    constructor(private bot: MicrosoftRewardsBot) {}

    /**
     * 从文件读取 6 位邮箱验证码。读到后删除文件（消费一次），等待期间写 .waiting 标记便于外部监控。
     * 不在日志里回显验证码内容。
     */
    private async readCodeFromFile(attempt: number): Promise<string | null> {
        const file = this.codeFile
        const marker = file + '.waiting'
        const deadline = Date.now() + this.codeFileWaitSeconds * 1000
        try {
            fs.writeFileSync(
                marker,
                JSON.stringify({ attempt, since: new Date().toISOString(), waitSeconds: this.codeFileWaitSeconds }) + '\n'
            )
        } catch {
            // 标记文件写不了也不影响读取
        }
        this.bot.logger.info(
            this.bot.isMobile,
            'LOGIN-CODE',
            `WAITING_FOR_EMAIL_CODE | attempt ${attempt} | file=${file} | timeout=${this.codeFileWaitSeconds}s`
        )

        while (Date.now() < deadline) {
            try {
                const raw = fs.readFileSync(file, 'utf8').trim()
                const matched = /\d{6}/.exec(raw)?.[0]
                if (matched) {
                    try {
                        fs.unlinkSync(file)
                    } catch {
                        // 读到了就用，删除失败不阻断
                    }
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', 'Read 6-digit code from file (file consumed)')
                    try {
                        fs.unlinkSync(marker)
                    } catch {
                        // ignore
                    }
                    return matched
                }
            } catch {
                // 文件尚未出现
            }
            await new Promise(resolve => setTimeout(resolve, 1000))
        }

        try {
            fs.unlinkSync(marker)
        } catch {
            // ignore
        }
        return null
    }

    private async fillCode(page: Page, code: string): Promise<boolean> {
        try {
            const visibleInput = await page
                .waitForSelector(this.textInputSelector, { state: 'visible', timeout: 500 })
                .catch(() => null)

            if (visibleInput) {
                await page.keyboard.type(code, { delay: 50 })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', 'Filled code input (6 digits)')
                return true
            }

            const secondairyInput = await page.$(this.secondairyInputSelector)
            if (secondairyInput) {
                await page.keyboard.type(code, { delay: 50 })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', 'Filled code input (6 digits)')
                return true
            }

            this.bot.logger.warn(this.bot.isMobile, 'LOGIN-CODE', 'No code input field found')
            return false
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-CODE',
                `Failed to fill code input: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    async handle(page: Page): Promise<void> {
        try {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', 'Code login authentication requested')

            const emailMessage = await getSubtitleMessage(page)
            if (emailMessage) {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', `Page message: "${emailMessage}"`)
            } else {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-CODE', 'Unable to retrieve email code destination')
            }

            for (let attempt = 1; attempt <= this.maxManualAttempts; attempt++) {
                const code = this.codeFile
                    ? await this.readCodeFromFile(attempt)
                    : await promptInput({
                          question: `Enter the 6-digit code (waiting ${this.maxManualSeconds}s): `,
                          timeoutSeconds: this.maxManualSeconds,
                          validate: code => /^\d{6}$/.test(code)
                      })

                if (!code || !/^\d{6}$/.test(code)) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-CODE',
                        `Invalid or missing code (attempt ${attempt}/${this.maxManualAttempts}) | input length=${code?.length}`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Manual code input failed or timed out')
                    }
                    continue
                }

                const filled = await this.fillCode(page, code)
                if (!filled) {
                    this.bot.logger.error(
                        this.bot.isMobile,
                        'LOGIN-CODE',
                        `Unable to fill code input (attempt ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Code input field not found')
                    }
                    continue
                }

                await this.bot.utils.wait(500)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

                // Check if wrong code was entered
                const errorMessage = await getErrorMessage(page)
                if (errorMessage) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-CODE',
                        `Incorrect code: ${errorMessage} (attempt ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error(`Maximum attempts reached: ${errorMessage}`)
                    }

                    // Clear the input field before retrying
                    const inputToClear = await page.$(this.textInputSelector).catch(() => null)
                    if (inputToClear) {
                        await inputToClear.click()
                        await page.keyboard.press('Control+A')
                        await page.keyboard.press('Backspace')
                    }
                    continue
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', 'Code authentication completed successfully')
                return
            }

            throw new Error(`Code input failed after ${this.maxManualAttempts} attempts`)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-CODE',
                `Error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }
}
