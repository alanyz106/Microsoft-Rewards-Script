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

---

## 🛡️ 后备代理源与优质节点筛选规则（站大爷经验）

### 1. 当前已验证的优质长效节点

| 节点 Host | 端口组 | 协议 | 存活时长 | 真实出口网络 | 延迟 | 状态 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `47.95.206.224` | `45001` (默认), `45003`, `45004`, `45005` | HTTPS | >10天 | 中国移动 重庆家宽 (AS9808) | ~1.1s | **主力默认** |
| `122.246.3.12` | `17981` | HTTPS | >47天 | 中国电信 浙江金华宽带 | ~780ms | 备用 |
| `119.188.131.55` | `17981` | HTTPS | >48天 | 中国联通 山东宽带 | ~910ms | 备用 |

### 2. 免费代理池筛选黄金法则（用于自动或手动获取后备 IP）

普通公开免费代理（如 80/8080/6379 端口）不支持 TLS 1.3 隧道，访问 Bing/Rewards 会 100% 报 `SSLError`。若要获取可用节点，必须严格遵守以下过滤规则：

1. **协议必须为 HTTPS**（`protocol_type=4`）或 SOCKS5（`protocol_type=3`）；
2. **匿名度必须为高匿**（`level_type=1`）；
3. **存活时长必须长效**（`alive_type >= 4`，优先选择存活数天以上的节点）；
4. **探针强制复核**：获取后必须以 `https://cn.bing.com` 发送 TLS 握手测试，状态码 200 且响应 < 3 秒方可接入。

### 3. 站大爷后备 API 提取模板

- **API 端点**：`http://open.zdaye.com/FreeProxy/Get/`
- **推荐请求参数**：`dalu=1&protocol_type=4&level_type=1&alive_type=4&return_type=3`
- **注意**：GitHub Actions Runner 频繁更换 IP 可能触发提取端 IP 锁（错误码 `12012`），若遇限制可直接从网页版 `https://www.zdaye.com/free/` 爬取带 `HTTPS` + `高匿` 标签的节点。
