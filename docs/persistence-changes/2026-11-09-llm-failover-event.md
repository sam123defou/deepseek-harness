---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-llm-failover-event

English | [中文](2026-11-09-llm-failover-event.zh.md)

## Summary

Adds the llm/failover Session event, which records one free-mode route change or the end of the failover when no listed route remains.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid because no existing root changes. A reader built before this event refuses a log that contains it instead of reconstructing a Session without the route change. A current reader folds the event into the llmFailover projection; the event is not model-visible and carries no request content or credentials.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/llm-free-mode/tests/failover.spec.ts: 24 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
