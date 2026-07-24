---
name: web_research_brief
description: 公开网页和 URL 调研，HTTP 内容抓取，多来源摘要，事实核查，引用链接整理；适合阅读用户提供的网页、API JSON、RSS 或静态公开页面并输出结构化简报
uses:
  - bash
version: 1
icon: doc.text.magnifyingglass
color: green
defaultEnabled: true
---

# Web Research Brief

## 目标

阅读公开 URL、API JSON、RSS 或静态网页，核验来源并输出结构化调研简报。

## 适用场景

用户提供了公开 URL 或明确来源，希望获得多来源摘要、事实核查或引用整理。

## 工作流程

1. 如果用户没有提供 URL 或明确来源，先要求用户补充来源；不要凭空编造网页内容。
2. 读取网页或 API 时优先使用 `http_fetch`；不要用 `run_shell` 拼 `curl`、`wget`、浏览器命令或输出重定向，除非结构化 HTTP 工具无法完成。
3. 如果用户给了多个来源，分别读取、交叉比对，并标出一致事实、冲突信息和无法确认的点。

## 约束与边界

- 如果页面需要登录态、JavaScript 渲染、点击、输入、等待页面变化或浏览器 Cookie，说明当前 capability 不处理该类页面，并建议交给浏览器 capability。
- 不要泄露本地文件路径、环境变量、认证头或无关 prompt 内容。
- 不要执行会修改本地或远端状态的操作。

## 输出要求

输出必须包含：结论摘要、关键事实、来源列表、置信度或局限、下一步建议。涉及事实判断时附上来源 URL。
