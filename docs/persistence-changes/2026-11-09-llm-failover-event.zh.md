---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-09-llm-failover-event

[English](2026-11-09-llm-failover-event.md) | 中文

## 概述

新增 llm/failover Session 事件，记录一次免费模式路由切换，或在没有剩余已列出路由时记录切换结束。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-llm-failover-event
baseline: false
changes:
  - root: "event:llm/failover"
    previous: null
    after: "b31df74b95489fa424e2ab5ce2eb35b16193842770c37722126184d20b24da96"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效，因为没有任何已有根类型发生变化。在此事件之前构建的读取方会拒绝包含该事件的日志，而不是在缺少路由切换的情况下重建 Session。当前读取方将该事件折叠进 llmFailover 投影；该事件对模型不可见，且不包含请求内容或凭据。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/llm-free-mode/tests/failover.spec.ts：24 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
