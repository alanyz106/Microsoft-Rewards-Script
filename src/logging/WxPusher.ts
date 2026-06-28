import axios, { AxiosRequestConfig } from 'axios'
import PQueue from 'p-queue'
import type { WebhookWxPusherConfig } from '../interface/Config'
import type { LogLevel } from './Logger'

const WXPUSHER_API = 'https://wxpusher.zjiecode.com/api/send/message'

const wxpusherQueue = new PQueue({
    interval: 1000,
    intervalCap: 2,
    carryoverConcurrencyCount: true
})

export async function sendWxPusher(config: WebhookWxPusherConfig, content: string, level: LogLevel): Promise<void> {
    if (!config?.enabled || !config.appToken || !config.uids?.length) return

    const contentType = config.contentType ?? 1

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
            await axios(request)
        } catch (err: any) {
            const status = err?.response?.status
            if (status === 429) return
        }
    })
}

export async function flushWxPusherQueue(timeoutMs = 5000): Promise<void> {
    await Promise.race([
        (async () => {
            await wxpusherQueue.onIdle()
        })(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('wxpusher flush timeout')), timeoutMs))
    ]).catch(() => {})
}
