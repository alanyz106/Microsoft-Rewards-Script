import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import axiosRetry from 'axios-retry'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { URL } from 'url'
import type { AccountProxy } from '../interface/Account'

class AxiosClient {
    private instance: AxiosInstance
    private probeInstance: AxiosInstance
    private account: AccountProxy

    constructor(account: AccountProxy) {
        this.account = account

        this.instance = axios.create({
            timeout: 20000
        })

        // 探测专用实例：不做 axios-retry。
        // 出网抖动恢复时要的是「此刻通不通」的快速判断，如果沿用带 5 次退避重试的实例，
        // 单次探测可能拖到 1 分钟以上，2 分钟一次的探测节奏就名存实亡了。
        this.probeInstance = axios.create({
            timeout: 15000
        })

        if (this.account.url && this.account.proxyAxios) {
            const { httpAgent, httpsAgent } = this.getAgentsForProxy(this.account)
            this.instance.defaults.httpAgent = httpAgent
            this.instance.defaults.httpsAgent = httpsAgent
            this.probeInstance.defaults.httpAgent = httpAgent
            this.probeInstance.defaults.httpsAgent = httpsAgent
        }

        axiosRetry(this.instance, {
            retries: 5,
            retryDelay: axiosRetry.exponentialDelay,
            shouldResetTimeout: true,
            retryCondition: error => {
                if (axiosRetry.isNetworkError(error)) return true
                if (!error.response) return true

                const status = error.response.status
                return status === 429 || (status >= 500 && status <= 599)
            }
        })
    }

    private getAgentsForProxy(
        proxyConfig: AccountProxy
    ): { httpAgent: HttpProxyAgent<string> | HttpsProxyAgent<string> | SocksProxyAgent; httpsAgent: HttpsProxyAgent<string> | SocksProxyAgent } {
        const { url: baseUrl, port, username, password } = proxyConfig

        let urlObj: URL
        try {
            urlObj = new URL(baseUrl)
        } catch {
            try {
                urlObj = new URL(`http://${baseUrl}`)
            } catch {
                throw new Error(`Invalid proxy URL format: ${baseUrl}`)
            }
        }

        const protocol = urlObj.protocol.toLowerCase()
        let proxyUrl: string

        if (username && password) {
            urlObj.username = encodeURIComponent(username)
            urlObj.password = encodeURIComponent(password)
            urlObj.port = port.toString()
            proxyUrl = urlObj.toString()
        } else {
            proxyUrl = `${protocol}//${urlObj.hostname}:${port}`
        }

        switch (protocol) {
            case 'http:':
                return {
                    httpAgent: new HttpProxyAgent(proxyUrl),
                    httpsAgent: new HttpsProxyAgent(proxyUrl)
                }
            case 'https:':
                return {
                    httpAgent: new HttpsProxyAgent(proxyUrl),
                    httpsAgent: new HttpsProxyAgent(proxyUrl)
                }
            case 'socks4:':
            case 'socks5:': {
                const socksAgent = new SocksProxyAgent(proxyUrl)
                return {
                    httpAgent: socksAgent,
                    httpsAgent: socksAgent
                }
            }
            default:
                throw new Error(`Unsupported proxy protocol: ${protocol}. Only HTTP(S) and SOCKS4/5 are supported!`)
        }
    }

    public async request(config: AxiosRequestConfig, bypassProxy = false): Promise<AxiosResponse> {
        if (bypassProxy) {
            const bypassInstance = axios.create()
            axiosRetry(bypassInstance, {
                retries: 3,
                retryDelay: axiosRetry.exponentialDelay
            })
            return bypassInstance.request(config)
        }

        return this.instance.request(config)
    }

    /**
     * 单次探测请求：走同一个账号代理，但不带重试。
     * 仅供出网抖动恢复逻辑判断「节点此刻是否已恢复」，不要用于业务请求。
     */
    public async requestForProbe(config: AxiosRequestConfig): Promise<AxiosResponse> {
        return this.probeInstance.request(config)
    }
}

export default AxiosClient
