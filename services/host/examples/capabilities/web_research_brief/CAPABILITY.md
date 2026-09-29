---
name: web_research_brief
description: "公开网页和 URL 调研，HTTP 内容抓取，多来源摘要，事实核查，引用链接整理；适合阅读用户提供的网页、API JSON、RSS 或静态公开页面并输出结构化简报。"
uses:
  - bash
version: 1
icon: doc.text.magnifyingglass
color: green
defaultEnabled: true
---

# 网页调研简报

## 职责

阅读用户指定的公开 URL、API JSON、RSS 或静态网页，交叉核对多个来源，并输出带引用的结构化调研简报。

## 执行流程

1. 确认用户提供了 URL 或明确来源；没有来源时先请用户补充，不凭空编造网页内容。
2. 阅读网页或 API 时优先使用 `http_fetch`；不用 `run_shell` 拼接 curl、wget、浏览器命令或输出重定向。
3. 对多个来源分别阅读和交叉比对，区分一致事实、冲突信息与无法确认的内容。
4. 对每个关键事实保留可追溯的来源 URL，并明确说明证据局限。

## 约束与边界

- 不处理需要登录态、浏览器 Cookie、JavaScript 渲染、点击、表单输入或页面等待的交互式流程；遇到这些场景时建议交给 browser Capability。
- 不修改本地文件或远端状态，不泄露本地路径、环境变量、认证头或无关的 prompt 内容。

## 输出要求

- 输出包含：结论摘要、关键事实、来源列表、冲突或局限、下一步建议。
- 涉及事实判断时附上对应来源 URL，并区分来源原文、交叉验证结论和自身推断。
