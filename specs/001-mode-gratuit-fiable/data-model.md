# Data Model: Mode gratuit fiable

Les formats exacts sont dans [contracts/](contracts/).

## FreeRoute (Modèle gratuit)

| Champ | Type | Règle |
|---|---|---|
| `provider` | `string` | Route enregistrée dans `ctx.llm` |
| `model` | `string` | Modèle de cette route |
| `freeTierConfirmed` | `boolean?` | Obligatoire à `true` hors OpenRouter |

La capacité de contexte vient de `prepareCall()`. Elle n'est pas recopiée dans la config.

Validation au chargement, ou dès que `ctx.llm` peut résoudre la route :

- une route OpenRouter finit par `:free` ou vaut `openrouter/free` ;
- le fournisseur existe et son identifiant se résout ;
- le modèle est configuré sur ce fournisseur ;
- la politique de retry du fournisseur n'est pas `always` ;
- `streamIdleTimeoutMs` du fournisseur ne dépasse pas `maxRouteIdleMs` ;
- aucun doublon `provider` + `model`.

## FailoverList (Liste de bascule)

| Champ | Type | Règle |
|---|---|---|
| `enabled` | `boolean` | `false` conserve la liste et retire les gardes (FR-011) |
| `routes` | `FreeRoute[]` | Non vide lorsque `enabled` vaut `true`. L'ordre fixe la priorité. |
| `rateLimitDelayMs` | `number` | Attente avant la bascule après un `RATE_LIMIT` |
| `maxFailoverMs` | `number` | Durée maximale de la bascule dans une étape |
| `maxRouteIdleMs` | `number` | Valeur maximale acceptée pour `streamIdleTimeoutMs` |
| `networkTimeoutMs` | `number` | Limite de chaque lecture de quota ou de catalogue |

`reportOnly` n'appartient pas à cette section. C'est un champ `Config` de composition, réglé uniquement
par le profil `free-check` : une route inutilisable y devient un état au lieu de bloquer le chargement.

## FailoverState

Projection de session `llmFailover`, reconstruite depuis `llm/failover`.

| Champ | Type | Sens |
|---|---|---|
| `tried` | `RouteKey[]` | Routes quittées dans l'étape, remises à zéro par `step/start` et `turn/end` |
| `startedAt` | `number?` | Heure de la première bascule de l'étape, pour `maxFailoverMs` |
| `excludedProviders` | `string[]` | Fournisseurs abandonnés dans l'étape, pour quota ou identifiant |
| `invalidRequestSwitched` | `boolean` | Vrai après la seule bascule permise pour `invalid-request` |

```text
route active --échec bascule--> route suivante non essayée --succès--> route active
route active --échec terminal ou liste finie ou délai dépassé--> arrêt avec cause
```

## FailoverEvent (Événement de bascule)

Événement `llm/failover`, défini dans
[contracts/llm-failover-event.md](contracts/llm-failover-event.md). Il porte l'heure de l'enveloppe de
session, les routes concernées et la cause.

## FailureCause

Union fermée, terminée par `assertNever` :

| Cause | Origine | Effet |
|---|---|---|
| `saturated` | `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE` | Bascule |
| `rate-limited` | `RATE_LIMIT` avec quota restant ou inconnu | Bascule après délai |
| `unavailable` | `PI_AI_ERROR` | Bascule |
| `invalid-request` | `INVALID_REQUEST` | Une seule bascule par étape, puis arrêt, car la requête peut échouer partout |
| `quota-exhausted` | `QUOTA`, ou quota lu à zéro | Abandon du fournisseur, bascule vers un autre, sinon arrêt |
| `credential-missing` | `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL` | Abandon du fournisseur, bascule vers un autre, sinon arrêt |
| `auth-refused` | `AUTH`, qui regroupe 401 et 403, y compris une modération | Abandon du fournisseur, bascule vers un autre, sinon arrêt |
| `context-exceeded` | `CONTEXT_WINDOW_EXCEEDED` | Bascule vers une route de plus grande capacité, sinon arrêt |
| `unknown` | Tout autre code | Bascule |

`FREE_MODE_ROUTE_REFUSED` ne passe jamais par cette table : il arrête la requête.

`UNKNOWN_MODEL` et `INVALID_CONFIG` n'y passent pas non plus. `prepareCall()` les lève dans
`prepareRequest()`, hors de `agent/request-error`, et le tour s'arrête. La validation au chargement les
évite, et la bascule résout chaque candidat avant de le choisir.

Un modèle incapable d'utiliser les outils échoue vite avec `unavailable` ou `invalid-request`, et il
est ainsi ignoré.

## Quota

| Champ | Type | Sens |
|---|---|---|
| `provider` | `string` | Fournisseur interrogé |
| `used`, `limit`, `remaining` | `number?` | Valeurs de `free_model_daily_requests` |
| `state` | `'known' \| 'unknown'` | `unknown` pour un fournisseur sans lecture de quota ou une lecture échouée |

Le quota n'est pas stocké : il est lu à la demande.
