# Microsoft-Rewards-Script 项目规则

## 项目概述

Microsoft Rewards 自动化脚本项目，用于自动完成每日任务获取积分。

## 外部文件引用

当遇到以下文件引用时，请按需加载：

- `@rules/github-actions.md` — 推送到 v4 分支和触发 Actions 的方式
- `@rules/wxpusher.md` — 运行完成后中文 HTML 汇总推送
- `@rules/urlreward-fix.md` — 新面板 PUBL 链接不可点击（折叠面板/缺少 PUBL 参数）及三层兜底修复方案
- `@rules/proxy.md` — 国内代理（HTTP/HTTPS/SOCKS5）接入与 GitHub Actions Secrets 扩展计划

## 通用规则

- 使用 TypeScript
- Windows 环境，Python 命令优先使用 `python`
- 搜索时优先使用 DuckDuckGo MCP
