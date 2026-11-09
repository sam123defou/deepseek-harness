---
description: "面向用户的免费模式诊断，用于检查凭据、列出的模型和剩余配额。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-free-check

[English](README.md) | 中文

## 概述

`dsh --profile free-check` 报告免费模式能否运行：凭据、列出的模型、价格，以及提供方公开时的每日配额。它不发送模型请求，因此不消耗免费模型配额，也绝不打印凭据值。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

```sh
dsh --profile free-check
dsh --profile free-check --json
```

每条路由最终处于一种状态：`ok`、`unknown`、`model-withdrawn`、`model-now-paid`、`credential-missing`、`model-not-configured`、`provider-unknown`、`unbounded-retry` 或 `timeout-too-long`。无法读取目录的提供方保持 `unknown`，绝不显示为 `ok`。

免费模式就绪或已禁用时命令以 `0` 退出，没有可用路由或有路由变为付费时以 `1` 退出，诊断本身失败时以 `2` 退出。未通过校验的免费模式 Config 会在启动时以带标签的错误停止该 profile。

诊断不发送模型请求，因此缺失的凭据会被报告，而不会中止命令。home patch 中的免费模式设置同样作用于该 profile。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该诊断不发送模型请求，也不注册任何面向模型的内容。

#### KV Cache 影响

该 profile 不向任何请求前缀添加内容，因为它不发送请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 目录和配额读取仅支持 OpenRouter 端点；其他提供方报告 `unknown`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

不发布 `./invariant`：该命令计算一份报告后退出，因此不存在可能产生分歧的独立观察。

</details>
