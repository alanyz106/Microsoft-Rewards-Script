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
    /** 账号还没跑完就被中断（systemd 超时 / 信号），不算成功也不算失败 */
    incomplete?: boolean
    /** 本次运行该账号走的 mihomo 分组与出口节点（卡片里显示在邮箱下方） */
    proxyGroup?: string
    proxyNode?: string
}

export interface SummaryOptions {
    /** 这份汇总是进程被中断（如 systemd 超时收到 SIGTERM）时发出的 */
    interrupted?: boolean
    /**
     * 卡片抬头。缺省为「Microsoft Rewards 运行报告」（日常主任务原样文案），
     * 查漏补缺（gapfill）传自己的标题以区分两份推送。不传则与改动前完全一致。
     */
    title?: string
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

/**
 * 节点名太长（如「🇺🇲 美国Y01 | IEPL | x1.5」），推送卡片在手机上放不下，
 * 只取竖线前的「地区 + 编号」部分；并去掉前面的国旗 emoji——群里/桌面端缺彩色 emoji 字体时
 * 会显示成方框，节点本身已经带了地区名，国旗不是必须的。取不到就原样返回。
 */
function shortNodeName(node?: string): string | undefined {
    if (!node) return undefined
    const short = node
        .split('|')[0]
        ?.trim()
        .replace(/^[^\p{L}\p{N}]+/u, '')
    return short || node
}

/** 邮箱下方的节点小字：`美国1 · 🇺🇲 美国Y01`；没有节点信息就不占位置 */
function nodeSubline(account: AccountSummary): string {
    const node = shortNodeName(account.proxyNode)
    if (!node) return ''
    const group = account.proxyGroup?.trim()
    const text = group ? `${group} · ${node}` : node
    return `<div style="font-size:11px;color:#8a94a6;margin-top:2px;font-weight:normal;">${text}</div>`
}

export async function sendWxPusherSummary(
    config: WebhookWxPusherConfig,
    accounts: AccountSummary[],
    options: SummaryOptions = {}
): Promise<void> {
    if (!config?.enabled || !config.appToken || !config.uids?.length) return
    // 空数组说明一个账号都没跑完，没什么可报的
    if (!accounts.length) return

    await sendRaw(config, buildSummaryHtml(accounts, options), 2)
}

/**
 * 生成汇总卡片的 HTML（与发送解耦，便于单测）。
 * 每个账号在邮箱下面多显示一行「分组 · 节点」，方便一眼看出哪个号走了哪个出口。
 */
export function buildSummaryHtml(
    accounts: AccountSummary[],
    options: SummaryOptions = {},
    now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
): string {
    const totalCollected = accounts.reduce((sum, a) => sum + a.collectedPoints, 0)
    const totalFinal = accounts.reduce((sum, a) => sum + a.finalPoints, 0)
    const totalDuration = accounts.reduce((sum, a) => sum + a.duration, 0)
    const successCount = accounts.filter(a => a.success && !a.incomplete).length
    const failCount = accounts.filter(a => !a.success && !a.incomplete).length
    const incompleteCount = accounts.filter(a => a.incomplete).length

    const accountRows = accounts
        .map(a => {
            const label = a.incomplete ? '未完成' : a.success ? `+${a.collectedPoints}` : '失败'
            const gainedColor = a.incomplete ? 'color:#f39c12;' : a.success ? 'color:#27ae60;' : 'color:#e74c3c;'
            const emailColor = a.incomplete || !a.success ? 'color:#e74c3c;' : ''
            const balance = a.incomplete && !a.initialPoints ? '—' : `${a.initialPoints} → ${a.finalPoints}`
            return `
        <tr>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;${emailColor}"><div>${a.email}</div>${nodeSubline(a)}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;${gainedColor}">${label}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;">${balance}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;">${(a.duration / 60).toFixed(1)}分</td>
        </tr>`
        })
        .join('')

    // 被中断时明确告知，避免「收到了推送=一切正常」的误读
    const interruptedBanner = options.interrupted
        ? `<div style="background:#fff7ed;border-left:4px solid #f39c12;padding:10px 12px;border-radius:6px;margin-bottom:14px;font-size:13px;color:#8a5a00;">
                <b>⚠️ 本次运行被中断</b>（进程收到终止信号），以下为中断前已完成的账号。${incompleteCount ? `另有 <b>${incompleteCount}</b> 个账号未跑完。` : ''}
            </div>`
        : ''

    const html = `
    <div style="font-family:'Microsoft YaHei',sans-serif;max-width:600px;margin:0 auto;background:#f5f7fa;padding:20px;">
        <div style="background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:20px;border-radius:12px 12px 0 0;text-align:center;">
            <h2 style="margin:0;font-size:20px;">${options.title ?? 'Microsoft Rewards 运行报告'}</h2>
            <p style="margin:8px 0 0;opacity:0.9;font-size:13px;">${now}</p>
        </div>
        <div style="background:#fff;padding:20px;border-radius:0 0 12px 12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
            ${interruptedBanner}
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
                账号: <b>${accounts.length}</b> 个 | 成功: <b style="color:#27ae60;">${successCount}</b> | 失败: <b style="color:#e74c3c;">${failCount}</b>${incompleteCount ? ` | 未完成: <b style="color:#f39c12;">${incompleteCount}</b>` : ''}
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

    return html
}

export async function flushWxPusherQueue(timeoutMs = 5000): Promise<void> {
    await Promise.race([
        (async () => {
            await wxpusherQueue.onIdle()
        })(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('wxpusher flush timeout')), timeoutMs))
    ]).catch(() => {})
}
