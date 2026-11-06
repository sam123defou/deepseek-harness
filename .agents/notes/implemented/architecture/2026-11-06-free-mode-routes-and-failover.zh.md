# Agent Note: 免费模式路由与故障切换

Status: implemented

[English](2026-11-06-free-mode-routes-and-failover.md) | 中文

## Problem

不能消耗额度的用户只能手动禁用付费适配器。这样付费路由仍可经 `llm-pi-ai` 到达，而且默认免费模型一旦饱和任务就会失败，即使已配置其他免费模型。

## Decision

`dsh-llm-free-mode` 在 `llm-free-mode` 设置段中保存有序的允许列表。`dsh-base` 按 `llm-pi-ai` 的方式以休眠状态挂载它，因为指向不存在条目的用户补丁行只会发出警告，保护会在没有错误的情况下缺失。

拒绝在 `LlmRuntime.prepareCall()` 和 `adapterStream()` 中通过 `registerRouteGuard()` 执行，在 `WebRuntime.search()` 中通过 `registerSearchGuard()` 执行。`llm/stream` 监听器不算强制执行，因为其他监听器可能先结束这条链。

故障切换使用现有的 `agent/request-error` waterfall 和 `{ kind: 'retry' }`，因为 `step()` 在每次尝试时都会重新运行 `prepareRequest()`。`agent-loop` 不变。选择引用是每个入口点私有的，因此由新的 `agent/model-reroute` 事件到达它；单纯的 `agent/request` 监听器会让选择与已记录的请求头不一致，并产生错误的模型变更提示。监听器先委托下游，使结果不依赖注册顺序，因为行顺序没有加载语义。

每日限制从 `GET /api/v1/key` 读取，因为 429 响应体不区分分钟限制和每日限制，而 pi-ai 会丢弃响应头。

`llm/failover` 是已知的必需事件类型。`Session.append()` 无法设置 `ignorable`，该事件与 `llm/retry` 保持一致。

## Alternatives considered

**在 `RequestErrorAction` 中加入路由。** 这会为一个使用方修改循环。

**解析 429 文本。** 每日限制的措辞没有文档记录，也从未在本地会话中观察到。

**在 `llm/stream` 监听器中强制流超时。** `next()` 不接受信号，因此被阻塞的请求会继续。插件改为拒绝 `streamIdleTimeoutMs` 超过 `maxRouteIdleMs` 的提供方。

## Consequences

免费模式下网页搜索不可用。子智能体、压缩和标题仍受守卫约束但不切换路由。`prepareCall()` 失败会结束回合，因为它运行在 `agent/request-error` 之外；路由检查和候选解析让这种情况很少发生。路由切换会像 `llm/retry` 一样在 Web 客户端丢弃被放弃的尝试；切换停止时，部分输出保留在轮次错误旁。`session-controller` 和 ACP 在组合 Agent 前等待 Loader，因此启动期间到达的请求不会在路由守卫存在之前运行。
