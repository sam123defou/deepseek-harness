# Implementation Plan: Mode gratuit fiable

**Branch**: `001-mode-gratuit-fiable` | **Date**: 2026-11-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-mode-gratuit-fiable/spec.md`

## Summary

Le mode gratuit devient une politique appliquée par le harness, et non plus une simple
configuration utilisateur. Un nouveau plugin `dsh-llm-free-mode` porte la liste ordonnée des routes
gratuites, refuse toute autre route au moment du dispatch et bascule vers le modèle suivant après
l'épuisement des nouvelles tentatives de `dsh-llm-retry`.

La boucle n'est pas modifiée : `step()` rappelle déjà `prepareRequest()` après `{ kind: 'retry' }`,
ce qui permet de changer de route dans la même étape. Le quota journalier OpenRouter est lu sur
`GET /api/v1/key`, car le texte d'un 429 ne distingue pas la limite par minute de la limite par jour.
Le plugin est monté inactif dans `dsh-base`, comme `llm-pi-ai`, et s'active par `settings.yaml`. Un
profil `free-check` fournit le diagnostic. Détails et alternatives : [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript strict, ESM, Node `^22.19 || >=24`

**Primary Dependencies**: `@deepseek-ai/cordis`, `dsh-llm`, `dsh-llm-pi-ai`, `dsh-llm-retry`,
`dsh-agent`, `dsh-web`, `dsh-credentials`, `dsh-settings`, `@deepseek-ai/schemastery`

**Storage**: journal de session (nouvel événement `llm/failover`) et section `llm-free-mode:` de
`~/.dsh/settings.yaml`. Aucun changement SQLite ni `SESSION_FORMAT_VERSION`.

**Testing**: Vitest, composition réelle via Loader, snapshots de session sans clé, sorties attendues
des SDK TypeScript et Python, `pnpm run test:coverage` (100 % par fichier)

**Target Platform**: application `dsh` sur Linux, macOS et Windows

**Project Type**: monorepo de plugins Cordis (harness d'agent)

**Performance Goals**: bascule en moins de 60 s (SC-003), cause finale en moins de 2 min (SC-004),
diagnostic en moins de 15 s (SC-005)

**Constraints**: 20 requêtes par minute et 50 par jour sur les modèles `:free` en dessous de
10 crédits achetés. Aucune requête vers une route payante. Aucune valeur d'identifiant affichée.

**Scale/Scope**: un utilisateur, 12 routes OpenRouter et 2 routes Groq configurées aujourd'hui

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principe | Verdict | Élément du plan |
|---|---|---|
| I. Plugins et capability seams | OK | `agent-loop` inchangé. Écoute de `agent/request-error` et `agent/request`. Nouveau point d'extension `agent/model-reroute` documenté dans `docs/architecture.md`. |
| II. Intégrité de session | OK | Chaque route utilisée reste dans `request/header`. `llm/failover` est ajouté à `known-event-types.ts`, comme `llm/retry`, sans changement de format. La notice de changement de modèle reste journalisée. |
| III. Contrats et échecs visibles | OK | Config validée au chargement, `resolve()` explicite, valeurs réglables dans `Config`, `assertNever` sur la décision de bascule. |
| IV. Cycle de vie | OK | Gardes et listeners passent par `ctx.effect()` et `ctx.on()`, avec test de disposal. Lire `docs/defensive-patterns.md` avant l'implémentation. |
| V. Preuves | OK | Tests ciblés, test de composition réelle, snapshot sans clé, sorties SDK TS et Python, smoke sur build du profil `free-check`, e2e réel d'OpenRouter ignoré sans clé. La suite complète n'est pas lancée par défaut. |
| VI. Documentation | OK | README bilingues, `docs/architecture.md`, Agent Note dans la même PR. |
| VII. Secrets | OK | Identifiants lus par `ctx.credentials`, jamais journalisés ni affichés. |

Aucune violation. La vérification reste valide après la phase 1.

## Project Structure

### Documentation (this feature)

```text
specs/001-mode-gratuit-fiable/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── free-mode-config.md
│   ├── llm-failover-event.md
│   └── free-check-profile.md
└── tasks.md             # créé par /speckit-tasks
```

### Source Code (repository root)

```text
packages/llm/llm-free-mode/          # NOUVEAU : politique, bascule, quota, ctx.freeMode
├── src/{index,config,failover,quota,types}.ts
├── tests/
└── README.md, README.zh.md, README.i18n.yaml
packages/llm/llm/src/index.ts        # registerRouteGuard(), vérifié dans prepareCall et adapterStream ; providerAccess()
packages/llm/llm-pi-ai/src/          # providerAccess() par route
packages/bundle/base/                # ligne llm-free-mode inactive et dépendance du package
packages/web/web/src/                # registerSearchGuard(), champ billing des providers
packages/web/web-search-*/src/       # déclaration de billing sur chaque provider
packages/core/agent/src/             # événement agent/model-reroute, écouté par installModelSelection
packages/core/scope/src/             # régénération de scoped-events.generated.ts
packages/core/session/src/known-event-types.ts   # llm/failover
packages/bundle/free-check/          # NOUVEAU : profil de diagnostic
packages/bundle/headless/src/        # affichage du modèle et des bascules
packages/client/ui-*/                # affichage Web, texte dans les dictionnaires typés
docs/architecture.md, docs/subsystems/llm-streaming.md (+ .zh.md)
.agents/notes/                       # Agent Note de décision
snapshots/                           # session de bascule, sans clé
```

**Structure Decision**: un seul package `dsh-llm-free-mode`, car la politique, la bascule et le
quota évoluent ensemble et partagent la même liste de routes. La garde est un mécanisme générique de
`dsh-llm` et `dsh-web` : l'appliquer par listener de waterfall ne suffirait pas, car un autre listener
pourrait court-circuiter la chaîne avant elle.

## Hors périmètre

- Bascule pour les sous-agents, la compaction et les titres. Ces appels restent soumis à la garde,
  donc gratuits, mais échouent sans changer de route.
- Recherche web gratuite : en mode gratuit, `web_search` est indisponible et `web_fetch` reste actif.
- Toute connexion au chat web DeepSeek (FR-010).

## Limites validées

L'utilisateur a validé ces quatre limites le 2026-11-06 :

1. En mode gratuit, `web_search` est indisponible et `web_fetch` reste actif.
2. Les sous-agents, la compaction et les titres restent gratuits, mais ne basculent pas.
3. Un modèle devenu payant n'est repéré qu'au lancement de `free-check`.
4. Le modèle de remplacement reste actif pour la session, et une nouvelle session repart du début de
   la liste.

## Risques à lever pendant l'implémentation

1. Le minuteur `streamIdleTimeoutMs` doit couvrir l'attente du premier fragment et produire le code
   `TIMEOUT`. Un test doit le prouver, car les objectifs de délai en dépendent.
2. Le harnais de snapshot doit savoir simuler une erreur de modèle. S'il ne le sait pas, ce support
   fait partie de cette PR.
3. Le texte réel d'un 429 journalier n'a pas été observé : aucune décision n'en dépend.

## Complexity Tracking

Aucune violation à justifier.
