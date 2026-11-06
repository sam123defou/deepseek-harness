# Quickstart: valider le mode gratuit

Ce guide prouve le comportement de bout en bout. Les formats sont dans [contracts/](contracts/).

## Prérequis

- `pnpm install` et `pnpm run build` terminés.
- `OPENROUTER_API_KEY` disponible pour les étapes réelles.
- Section `llm-free-mode:` ajoutée à `~/.dsh/settings.yaml`, voir
  [free-mode-config.md](contracts/free-mode-config.md).
- `retryPolicy` d'OpenRouter réglé sur `{ mode: normal, maxRetries: 1 }`, et `streamIdleTimeoutMs` sur
  `20000`.

Les étapes réelles consomment le quota de 50 requêtes par jour. Commencer par les preuves sans clé.

## Preuves sans clé

```sh
pnpm exec vitest run packages/llm/llm-free-mode
pnpm exec vitest run packages/llm/llm packages/web/web packages/core/agent
pnpm run test:snapshot -t free-mode
```

Résultats attendus :

| Scénario | Résultat |
|---|---|
| Premier modèle en `SERVER`, deuxième disponible | Tâche terminée et `llm/failover` journalisé (US1) |
| Session relue | Chaque bascule apparaît dans l'historique (US1) |
| Tous les modèles en échec, clé payante présente | Arrêt et aucun appel à une route hors liste (US2, SC-002) |
| Route hors liste demandée | `FREE_MODE_ROUTE_REFUSED` et aucune requête réseau (US2) |
| `web_search` avec un provider `billed` | `WEB_PROVIDER_REFUSED_FREE_MODE` (US2) |
| Quota lu à zéro après un `RATE_LIMIT` | Routes du fournisseur abandonnées avec `quota-exhausted`, arrêt si aucun autre fournisseur ne reste (FR-003) |
| Modèle bloqué sans réponse | Bascule dans le délai de SC-003, cause finale dans celui de SC-004 |
| Liste vide, route payante, modèle non configuré, retry `always`, délai trop long | Échec au démarrage (FR-008) |
| `enabled: false` | Gardes retirées et `routes` conservé (FR-011) |

## Diagnostic réel

```sh
pnpm dsh --profile free-check
pnpm dsh --profile free-check --json
```

Attendu : réponse en moins de 15 secondes et quota OpenRouter affiché. Retirer temporairement une
référence d'identifiant et ajouter un slug inexistant : les deux problèmes sont signalés, et aucune
valeur d'identifiant n'apparaît.

## Bascule réelle

Placer en tête de `routes` un slug `:free` retiré du catalogue, en l'ajoutant aussi à `models` dans
`llm-pi-ai:`, et régler `api: openai-completions` sur le fournisseur `openrouter`, car un slug absent du
catalogue installé n'hérite d'aucune API. Sans ces ajouts, le démarrage échoue avec
`FREE_MODE_ROUTE_UNUSABLE`. Puis lancer :

```sh
pnpm dsh --profile headless "Réponds uniquement : ok"
```

Attendu : une ligne de bascule sur `stderr`, puis la réponse du modèle suivant, le tout en moins de
60 secondes.

## Sortie du mode gratuit

Mettre `enabled: false` et relancer `free-check`. Attendu : le mode est signalé inactif et `routes`
reste intact dans `settings.yaml`.

## Portes avant push

Utiliser `dsh-pre-push-checks` pour choisir les commandes, sans lancer la suite complète. Les preuves
attendues sont la couverture des packages touchés, les snapshots de cette fonctionnalité, les sorties
attendues des SDK TypeScript et Python, et `pnpm run doc-sync`.
