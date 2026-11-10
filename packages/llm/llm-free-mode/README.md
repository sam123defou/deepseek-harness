---
description: "The free-mode policy for users who must not spend credit and maintainers of route guards and failover."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-free-mode

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-free-mode` keeps a harness on an ordered list of free model routes. While enabled it refuses every other route when a request is dispatched, refuses billed web search, and moves a failed step to the next listed route after request retries end. `dsh-base` mounts it dormant, so nothing changes until the `llm-free-mode` settings section sets `enabled: true`. The daily OpenRouter quota is read from the key endpoint because a rate-limit response does not name the exhausted limit.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Enable free mode

Set the `llm-free-mode` entry's Config in the home patch, `$DSH_HOME/cordis.patch.yml`, which every profile applies, including `free-check`. Each listed provider must also keep bounded retries and a short stream timeout in the `llm-pi-ai` entry, and list each route's model under `models`: without a listed model, `free-check` cannot read the provider's catalog or quota and reports them `unknown`, although requests still run.

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
        models:
          - id: google/gemma-4-31b-it:free
            contextWindow: 262144
```

An OpenRouter route must end in `:free` or be `openrouter/free`. Any other provider needs `freeTierConfirmed: true`, because only the account owner can confirm that it does not bill. `enabled: false` removes the guards and the failover and keeps `routes`. Every field is volatile, so an edit applies without a reload, and a former `llm-free-mode:` section of `settings.yaml` is imported into this entry once.

### What you can observe

Each route change appends a non-surface `llm/failover` event with both routes, the cause, the failure code, and the wait. An event without `to` records the end of the failover. `dsh --profile headless` prints these records on stderr after the answer, and `dsh --profile free-check` reports each route and the remaining quota without a model request.

### Failures and recovery

A section that fails validation rejects registration at startup, and a later invalid edit keeps the last valid value, so free mode does not switch itself off. Route checks that need other plugins run before the first request: a route that is unknown, not configured, without a credential, on `retryPolicy.mode: always`, or above `maxRouteIdleMs` fails that request with its action. An unlisted route fails with `FREE_MODE_ROUTE_REFUSED`, and billed web search fails with `WEB_PROVIDER_REFUSED_FREE_MODE`; neither reaches the provider.

| Cause | Failure codes | Effect |
|---|---|---|
| `saturated` | `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE` | Next route |
| `rate-limited` | `RATE_LIMIT` with quota left or unknown | Next route after `rateLimitDelayMs` |
| `unavailable` | `PI_AI_ERROR` | Next route |
| `invalid-request` | `INVALID_REQUEST` | One route change per failover chain, then stop |
| `quota-exhausted` | `QUOTA`, or a quota read of zero | Leave the provider, otherwise stop |
| `credential-missing` | `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL` | Leave the provider, otherwise stop |
| `auth-refused` | `AUTH` | Leave the provider, otherwise stop |
| `context-exceeded` | `CONTEXT_WINDOW_EXCEEDED` | Next route with a larger window, otherwise stop |
| `unknown` | Any other code | Next route |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The route guard lives in `LlmRuntime`, not in an `llm/stream` listener, because another listener can end that chain first. The failover listens to `agent/request-error` and delegates first, so `dsh-llm-retry` finishes its budget whatever the registration order. It then records the next route with `agent.model.select()`, which appends `model/selection`, and returns `{ kind: 'next-step' }`. The loop closes the failed step and opens the next step of the same turn on the new route; that step carries the model-switch notice and logs the new `request/header`.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `LlmFreeMode` service: settings, guards, failover listener |
| [`src/config.ts`](src/config.ts) | Settings schema, self-contained validation, route checks |
| [`src/failover.ts`](src/failover.ts) | Cause mapping, candidates, durable per-step state, messages |
| [`src/quota.ts`](src/quota.ts) | OpenRouter daily quota read |
| [`src/types.ts`](src/types.ts) | Browser-safe route, cause, and event types |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Free-mode decision](../../../.agents/notes/implemented/architecture/2026-11-06-free-mode-routes-and-failover.md)
- [`dsh-llm-retry`](../llm-retry/README.md)
- [`dsh-free-check`](../../bundle/free-check/README.md)

-----

<a id="model-experience"></a>
## Model Experience

### Free-mode routing

#### What the model sees

Refusals and failover records never reach the model. After a route change, the following step carries the existing model-change notice once. The retried step reuses its rendered system prompt, so `{{model}}` still names the previous route during that step.

#### Token effect

The model-change notice adds one short user-role message after a route change. Nothing else changes the request.

#### KV Cache effect

A route change starts a new request prefix, so provider KV cache from the previous route is not reused.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Web search is unavailable in free mode: every shipped search provider is declared `billed`. `web_fetch` stays active.
- Subagents, compaction, and titles stay under the route guard but do not change route.
- A model that became paid is detected only when `free-check` runs. A failure raised by `prepareCall()`, such as a model removed from the configuration during a turn, ends that turn.
- The replacement route stays selected for the session; a new session starts at the head of the list.
- A per-minute limit applies to the account and cannot be told apart from an upstream limit, so a route change may not help; `maxFailoverMs` bounds that case.
- `sdk-minimal` does not compose `dsh-base` and is not covered.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published. Guards, failover state, and settings are read from one owner each, so no independent observations can diverge.

</details>
