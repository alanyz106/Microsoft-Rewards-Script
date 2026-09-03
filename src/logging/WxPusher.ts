import axios, { AxiosRequestConfig } from 'axios'
import PQueue from 'p-queue'
import type { WebhookWxPusherConfig } from '../interface/Config'

const WXPUSHER_API = 'https://wxpusher.zjiecode.com/api/send/message'

const wxpusherQueue = new PQueue({
    interval: 1000,
    intervalCap: 2,
    carryoverConcurrencyCount: true
})

export interface AccountSummary {
    email: string
    collectedPoints: number
    initialPoints: number
    finalPoints: number
    duration: number
    success: boolean
    error?: string
}

async function sendRaw(config: WebhookWxPusherConfig, content: string, contentType: 1 | 2 | 3): Promise<void> {
    if (!config?.enabled || !config.appToken || !config.uids?.length) {
        // Why log a skip: a silent no-op here is indistinguishable from a
        // successful push when reading CI logs. Make the branch observable.
        console.log(
            `[WxPusher] Skipped: enabled=${!!config?.enabled} ` +
                `appTokenSet=${!!config?.appToken} uidCount=${config?.uids?.length ?? 0}`
        )
        return
    }

    const request: AxiosRequestConfig = {
        method: 'POST',
        url: WXPUSHER_API,
        headers: { 'Content-Type': 'application/json' },
        data: {
            appToken: config.appToken,
            content: content,
            contentType: contentType,
            uids: config.uids
        },
        timeout: 10000
    }

    await wxpusherQueue.add(async () => {
        try {
            const res = await axios(request)
            // WxPusher signals business-level failure inside a 200 response:
            // { code: 1000 } is the only true success. Log it so a green HTTP
            // status can't mask a rejected (e.g. bad appToken/uid) message.
            const body = res?.data
            const code = body?.code
            const ok = code === 1000
            console.log(
                `[WxPusher] ${ok ? 'Sent' : 'REJECTED'} | http=${res?.status} ` +
                    `code=${code ?? 'n/a'} msg=${body?.msg ?? 'n/a'} ` +
                    `uids=${config.uids.length} bytes=${Buffer.byteLength(content)}`
            )
            if (!ok) console.log(`[WxPusher] Response body: ${JSON.stringify(body)}`)
        } catch (err: any) {
            const status = err?.response?.status
            if (status === 429) {
                console.log(`[WxPusher] Rate limited (429), message dropped`)
                return
            }
            console.log(
                `[WxPusher] FAILED | status=${status ?? 'n/a'} ` +
                    `err=${err?.message ?? err} ` +
                    `body=${JSON.stringify(err?.response?.data ?? null)}`
            )
        }
    })
}

export async function sendWxPusherSummary(
    config: WebhookWxPusherConfig,
    accounts: AccountSummary[]
): Promise<void> {
    if (!config?.enabled || !config.appToken || !config.uids?.length) return

    const totalCollected = accounts.reduce((sum, a) => sum + a.collectedPoints, 0)
    const totalFinal = accounts.reduce((sum, a) => sum + a.finalPoints, 0)
    const totalDuration = accounts.reduce((sum, a) => sum + a.duration, 0)
    const successCount = accounts.filter(a => a.success).length
    const failCount = accounts.filter(a => !a.success).length
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })

    const accountRows = accounts
        .map(
            a => `
        <tr>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;${a.success ? '' : 'color:#e74c3c;'}">${a.email}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;${a.success ? 'color:#27ae60;' : 'color:#e74c3c;'}">${a.success ? '+' + a.collectedPoints : '失败'}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;">${a.initialPoints} → ${a.finalPoints}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;">${(a.duration / 60).toFixed(1)}分</td>
        </tr>`
        )
        .join('')

    const html = `
    <div style="font-family:'Microsoft YaHei',sans-serif;max-width:600px;margin:0 auto;background:#f5f7fa;padding:20px;">
        <div style="background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:20px;border-radius:12px 12px 0 0;text-align:center;">
            <h2 style="margin:0;font-size:20px;">Microsoft Rewards 运行报告</h2>
            <p style="margin:8px 0 0;opacity:0.9;font-size:13px;">${now}</p>
        </div>
        <div style="background:#fff;padding:20px;border-radius:0 0 12px 12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
            <div style="display:flex;justify-content:space-between;margin-bottom:20px;text-align:center;">
                <div style="flex:1;padding:10px;background:#f0f9ff;border-radius:8px;margin:0 4px;">
                    <div style="font-size:24px;font-weight:bold;color:#667eea;">${totalCollected}</div>
                    <div style="font-size:12px;color:#666;">获得点数</div>
                </div>
                <div style="flex:1;padding:10px;background:#f0fdf4;border-radius:8px;margin:0 4px;">
                    <div style="font-size:24px;font-weight:bold;color:#27ae60;">${totalFinal}</div>
                    <div style="font-size:12px;color:#666;">总点数</div>
                </div>
                <div style="flex:1;padding:10px;background:#fff7ed;border-radius:8px;margin:0 4px;">
                    <div style="font-size:24px;font-weight:bold;color:#f39c12;">${(totalDuration / 60).toFixed(1)}</div>
                    <div style="font-size:12px;color:#666;">耗时(分)</div>
                </div>
            </div>
            <div style="font-size:14px;color:#333;margin-bottom:12px;">
                账号: <b>${accounts.length}</b> 个 | 成功: <b style="color:#27ae60;">${successCount}</b> | 失败: <b style="color:#e74c3c;">${failCount}</b>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
                <thead>
                    <tr style="background:#f8f9fa;">
                        <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #dee2e6;">账号</th>
                        <th style="padding:8px 10px;text-align:center;border-bottom:2px solid #dee2e6;">获得</th>
                        <th style="padding:8px 10px;text-align:center;border-bottom:2px solid #dee2e6;">点数变化</th>
                        <th style="padding:8px 10px;text-align:center;border-bottom:2px solid #dee2e6;">耗时</th>
                    </tr>
                </thead>
                <tbody>
                    ${accountRows}
                </tbody>
            </table>
        </div>
    </div>`

    await sendRaw(config, html, 2)
}

export async function flushWxPusherQueue(timeoutMs = 5000): Promise<void> {
    await Promise.race([
        (async () => {
            await wxpusherQueue.onIdle()
        })(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('wxpusher flush timeout')), timeoutMs))
    ]).catch(() => {})
}
