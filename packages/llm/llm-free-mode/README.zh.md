---
description: "面向不能消耗额度的用户，以及路由守卫与故障切换维护者的免费模式策略说明。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-free-mode

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-llm-free-mode` 让 harness 只使用一份有序的免费模型路由列表。启用后，它在请求分发时拒绝其他所有路由，拒绝计费的网页搜索，并在请求重试结束后把失败的步骤移到列表中的下一条路由。`dsh-base` 以休眠状态挂载它，因此在 `llm-free-mode` 设置段写入 `enabled: true` 之前不会有任何变化。OpenRouter 的每日配额从密钥端点读取，因为限流响应不会指明耗尽的是哪一项限制。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 启用免费模式

在 home patch（`$DSH_HOME/cordis.patch.yml`，所有 profile 都会应用，包括 `free-check`）中设置 `llm-free-mode` 条目的 Config。列出的每个提供方还必须在 `llm-pi-ai` 条目中保持有界重试和较短的流超时：

```yaml
- id: llm-free-mode
  config:
    enabled: true
    rateLimitDelayMs: 5000
    maxFailoverMs: 55000
    maxRouteIdleMs: 20000
    networkTimeoutMs: 10000
    routes:
      - provider: openrouter
        model: google/gemma-4-31b-it:free
      - provider: groq
        model: llama-3.3-70b-versatile
        freeTierConfirmed: true

- id: llm-pi-ai
  config:
    providers:
      openrouter:
        streamIdleTimeoutMs: 20000
        retryPolicy:
          mode: normal
          maxRetries: 1
```

OpenRouter 路由必须以 `:free` 结尾或等于 `openrouter/free`。其他提供方需要 `freeTierConfirmed: true`，因为只有账户所有者能确认它不会计费。`enabled: false` 移除守卫和故障切换，并保留 `routes`。所有字段都是 volatile 字段，因此修改后无需重新加载即可生效；`settings.yaml` 中原有的 `llm-free-mode:` 段会被一次性导入该条目。

### 可以观察到什么

每次路由变更都会追加一个非 surface 的 `llm/failover` 事件，记录两条路由、原因、失败代码和等待时间。没有 `to` 的事件记录故障切换结束。`dsh --profile headless` 在回答之后把这些记录打印到 stderr，`dsh --profile free-check` 不发送模型请求即可报告每条路由和剩余配额。

### 失败与恢复

未通过校验的设置段会在启动时拒绝注册，之后的无效编辑保留最后一个有效值，因此免费模式不会自行关闭。需要其他插件的路由检查在第一个请求之前运行：路由未知、未配置、缺少凭据、使用 `retryPolicy.mode: always` 或超过 `maxRouteIdleMs` 时，该请求失败并给出处理方式。未列出的路由以 `FREE_MODE_ROUTE_REFUSED` 失败，计费的网页搜索以 `WEB_PROVIDER_REFUSED_FREE_MODE` 失败；两者都不会到达提供方。

| 原因 | 失败代码 | 效果 |
|---|---|---|
| `saturated` | `SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE` | 下一条路由 |
| `rate-limited` | `RATE_LIMIT`，且配额有剩余或未知 | 等待 `rateLimitDelayMs` 后切到下一条路由 |
| `unavailable` | `PI_AI_ERROR` | 下一条路由 |
| `invalid-request` | `INVALID_REQUEST` | 每条故障切换链只切换一次路由，然后停止 |
| `quota-exhausted` | `QUOTA`，或读取到的配额为零 | 离开该提供方，否则停止 |
| `credential-missing` | `MISSING_CREDENTIAL`、`INVALID_CREDENTIAL` | 离开该提供方，否则停止 |
| `auth-refused` | `AUTH` | 离开该提供方，否则停止 |
| `context-exceeded` | `CONTEXT_WINDOW_EXCEEDED` | 切到窗口更大的路由，否则停止 |
| `unknown` | 其他任何代码 | 下一条路由 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

路由守卫位于 `LlmRuntime`，而不是 `llm/stream` 监听器，因为其他监听器可能先结束这条链。故障切换监听 `agent/request-error` 并先委托下游，因此无论注册顺序如何，`dsh-llm-retry` 都会用完它的预算。随后它通过 `agent.model.select()` 记录下一条路由（追加 `model/selection`），并返回 `{ kind: 'next-step' }`。循环关闭失败的步骤，并在新路由上打开同一轮次的下一步；该步骤带有模型切换提示，并记录新的 `request/header`。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `LlmFreeMode` 服务：设置、守卫、故障切换监听器 |
| [`src/config.ts`](src/config.ts) | 设置 schema、自包含校验、路由检查 |
| [`src/failover.ts`](src/failover.ts) | 原因映射、候选路由、持久的逐步状态、消息 |
| [`src/quota.ts`](src/quota.ts) | OpenRouter 每日配额读取 |
| [`src/types.ts`](src/types.ts) | 浏览器安全的路由、原因与事件类型 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [免费模式决策](../../../.agents/notes/implemented/architecture/2026-11-06-free-mode-routes-and-failover.zh.md)
- [`dsh-llm-retry`](../llm-retry/README.zh.md)
- [`dsh-free-check`](../../bundle/free-check/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 免费模式路由

#### 模型看到什么

拒绝和故障切换记录都不会到达模型。路由变更后，下一步会携带一次现有的模型变更提示。重试的步骤复用已渲染的系统提示，因此在该步骤内 `{{model}}` 仍是之前的路由。

#### Token 影响

路由变更后，模型变更提示增加一条简短的用户角色消息。请求的其他内容不变。

#### KV Cache 影响

路由变更会开始新的请求前缀，因此不会复用之前路由的提供方 KV 缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 免费模式下网页搜索不可用：所有随附的搜索提供方都声明为 `billed`。`web_fetch` 保持可用。
- 子智能体、压缩和标题仍受路由守卫约束，但不会切换路由。
- 变为付费的模型只有在运行 `free-check` 时才会被发现。由 `prepareCall()` 抛出的失败（例如回合期间从配置中移除模型）会结束该回合。
- 替换路由在会话内保持选中；新会话从列表开头开始。
- 每分钟限制作用于账户，且无法与上游限制区分，因此切换路由可能无效；`maxFailoverMs` 约束这种情况。
- `sdk-minimal` 不组合 `dsh-base`，不在覆盖范围内。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

不发布 `./invariant`：守卫、故障切换状态和设置各自只从一个所有者读取，因此不存在可能产生分歧的独立观察。

</details>
