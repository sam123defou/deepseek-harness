# Agent Note: Free-mode routes and failover

Status: implemented

English | [中文](2026-11-06-free-mode-routes-and-failover.zh.md)

## Problem

A user who must not spend credit could only disable paid adapters by hand. That left paid routes reachable through `llm-pi-ai`, and a task failed as soon as the default free model was saturated, even with other free models configured.

## Decision

`dsh-llm-free-mode` holds an ordered allowlist in volatile fields of its own `llm-free-mode` entry Config, so live edits apply without a reload and the former `settings.yaml` section is imported into that entry once. `dsh-base` mounts it dormant, following `llm-pi-ai`, because a user patch row that targets an absent entry only warns and the protection would be missing without an error.

The refusal runs in `LlmRuntime.prepareCall()` and `adapterStream()` through `registerRouteGuard()`, and in `WebRuntime.search()` through `registerSearchGuard()`. An `llm/stream` listener would not be enforcement, because another listener can end the chain first.

The failover uses the `agent/request-error` waterfall and its `{ kind: 'next-step' }` action. A step fixes its model selection before the first request, and `agent/request` refuses a provider or model change, so the failover records the next route with `agent.model.select()` and the loop continues the turn in a new step that snapshots the selection again. The durable `model/selection` event keeps the route change and the model-switch notice reconstructable from the log. Because each route change opens a new step, the `llmFailover` projection resets on `assistant/message` and `turn/end`, not on `step/start`; otherwise every new step would forget the routes already tried. The listener delegates first, which makes the result independent of registration order, since row order carries no load semantics.

The daily limit is read from `GET /api/v1/key`, because the 429 body does not separate the minute limit from the day limit and pi-ai flattens response headers away.

`llm/failover` is a known required event type. `Session.append()` has no way to set `ignorable`, and the event follows `llm/retry`.

## Alternatives considered

**Add a route to `RequestErrorAction`.** This changes the loop for one consumer.

**Parse the 429 text.** The daily wording is undocumented and was never observed in local sessions.

**Enforce a stream timeout in an `llm/stream` listener.** `next()` takes no signal, so the blocked request would continue. The plugin instead refuses a provider whose `streamIdleTimeoutMs` exceeds `maxRouteIdleMs`.

## Consequences

Web search is unavailable in free mode. Subagents, compaction, and titles stay guarded but do not change route. A `prepareCall()` failure ends the turn, because it runs outside `agent/request-error`; route checks and candidate resolution keep that case rare. A route change discards the abandoned attempt in the Web client, as `llm/retry` does; a failover stop keeps the partial output beside the Turn error. `session-controller` and ACP wait for the Loader before composing an Agent, so a request that arrives during startup cannot run before the route guard exists.
