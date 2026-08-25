# 国内代理接入与配置说明

## 🎯 目标

通过国内代理（HTTP / HTTPS / SOCKS5）使 GitHub Actions 容器内的流量（包括无头浏览器与后台 API 请求）完全以国内 IP 访问 Microsoft Rewards 和 Bing，确保账号在最稳定的国区网络环境下运行。

---

## 🛠️ 配置方案

### 1. GitHub Actions 工作流（`.github/workflows/daily-run.yml`）
在 `Create accounts.json` 步骤中支持动态读取 Secrets 并提供默认国内代理回退：

```javascript
const proxyUrl = process.env['ACCOUNT_' + i + '_PROXY_URL'] || process.env['DEFAULT_PROXY_URL'] || 'http://47.95.206.224';
const proxyPort = parseInt(process.env['ACCOUNT_' + i + '_PROXY_PORT'] || process.env['DEFAULT_PROXY_PORT'] || '45001', 10);
const proxyUsername = process.env['ACCOUNT_' + i + '_PROXY_USERNAME'] || process.env['DEFAULT_PROXY_USERNAME'] || '';
const proxyPassword = process.env['ACCOUNT_' + i + '_PROXY_PASSWORD'] || process.env['DEFAULT_PROXY_PASSWORD'] || '';
const proxyAxiosRaw = process.env['ACCOUNT_' + i + '_PROXY_AXIOS'] || process.env['DEFAULT_PROXY_AXIOS'];
const proxyAxios = proxyAxiosRaw !== undefined ? proxyAxiosRaw === 'true' : Boolean(proxyUrl);
```

### 2. GitHub Secrets 环境变量（可选自定义配置）

| Secret 名称 | 示例值 | 说明 |
| :--- | :--- | :--- |
| `DEFAULT_PROXY_URL` | `http://47.95.206.224` | 全局默认代理服务器地址（默认已配置） |
| `DEFAULT_PROXY_PORT` | `45001` | 全局默认代理端口（默认已配置） |
| `ACCOUNT_1_PROXY_URL` | `http://47.95.206.224` | 账号一专属代理地址（覆盖默认） |
| `ACCOUNT_1_PROXY_PORT` | `45001` | 账号一专属代理端口 |
| `ACCOUNT_1_PROXY_USERNAME` | `user`（可选） | 代理认证用户名 |
| `ACCOUNT_1_PROXY_PASSWORD` | `pass`（可选） | 代理认证密码 |
| `ACCOUNT_1_PROXY_AXIOS` | `true`（可选） | 后台 Axios API 是否走代理 |

---

## 📌 项目代理架构与日志

- **浏览器层**（`src/browser/Browser.ts`）：自动解析 `account.proxy` 注入 Patchright 浏览器，并打印 `[BROWSER-PROXY]` 日志。
- **API 请求层**（`src/util/Axios.ts`）：分别分配 `HttpProxyAgent` (HTTP) 与 `HttpsProxyAgent` (HTTPS) 确保 TLS 隧道正常建立。
- **启动探针与日志**（`src/index.ts`）：每个账号启动时自动通过代理探测真实出口 IP 与归属地，并打印高亮日志：
  `[PROXY] Proxy active & verified! Outbound IP: 183.227.236.80 | Location: 中国 重庆市 | ISP: China Mobile communications corporation`
- **环境配合**：默认 `geoLocale: CN` 与 `langCode: zh-CN` 达成纯净国区环境。
