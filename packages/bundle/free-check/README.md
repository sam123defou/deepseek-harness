---
description: "The free-mode diagnostic for users checking credentials, listed models, and remaining quota."
kind: "package-bundle"
---

# @deepseek-ai/dsh-free-check

English | [中文](README.zh.md)

## Summary

`dsh --profile free-check` reports whether free mode can run: credentials, listed models, prices, and the daily quota when the provider publishes it. It sends no model request, so it uses no free-model quota, and it never prints a credential value.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

```sh
dsh --profile free-check
dsh --profile free-check --json
```

Each route ends in one state: `ok`, `unknown`, `model-withdrawn`, `model-now-paid`, `credential-missing`, `model-not-configured`, `provider-unknown`, `unbounded-retry`, or `timeout-too-long`. A provider without a readable catalog stays `unknown`, never `ok`.

The command exits `0` when free mode is ready or disabled, `1` when no route is usable or a route became paid, and `2` when the diagnostic itself fails. A free-mode Config that fails validation stops the profile at startup with a labelled error.

The diagnostic sends no model request, so a missing credential is reported instead of stopping the command. Free-mode settings in the home patch apply to this profile too.

-----

<a id="model-experience"></a>
## Model Experience

None, as the diagnostic sends no model request and registers nothing model-facing.

#### KV Cache effect

The profile adds nothing to any request prefix, because it sends no request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Catalog and quota reads exist for OpenRouter endpoints only; other providers report `unknown`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published. The command computes one report and exits, so no independent observations can diverge.

</details>
