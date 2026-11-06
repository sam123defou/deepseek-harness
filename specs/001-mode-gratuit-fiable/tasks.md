---

description: "Liste des tâches du mode gratuit fiable"
---

# Tasks: Mode gratuit fiable

**Input**: documents de `specs/001-mode-gratuit-fiable/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: inclus. La spec définit un test indépendant par user story, et le dépôt impose 100 % de
couverture par fichier, un test de composition réelle et un snapshot de session sans clé.

**Organization**: les tâches sont groupées par user story.

## Format: `[ID] [P?] [Story] Description`

- **[P]** : exécutable en parallèle (fichiers différents, aucune dépendance en attente)
- **[Story]** : user story de rattachement (US1, US2, US3)

Avant de commencer, lire `docs/architecture.md`, `docs/defensive-patterns.md`, `packages/AGENTS.md`
et `docs/testing.md`. `NOUVEAU` désigne un fichier à créer.

---

## Phase 1: Setup

**Purpose**: créer le package et le rendre résolvable dans le monorepo

- [X] T001 Créer `packages/llm/llm-free-mode/package.json`, `tsconfig.json` et `tsdown.config.ts` sur le modèle de `packages/llm/llm-retry/`, avec `@deepseek-ai/cordis` en peerDependency et dépendance de développement, sans export `./invariant` tant qu'aucune observation ne peut diverger
- [X] T002 Enregistrer le package dans l'agrégat tsconfig et lancer `pnpm install` puis `pnpm run gen-tsconfig-paths`, ce qui met à jour `tsconfig.base.json` et `pnpm-lock.yaml`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: types, configuration et point d'extension requis par toutes les stories

**⚠️ CRITICAL**: aucune story ne commence avant la fin de cette phase

- [X] T003 [P] Définir `FreeRoute`, `FailureCause`, `LlmFailoverEventData` et `Quota` dans `packages/llm/llm-free-mode/src/types.ts` selon `data-model.md`, sans code d'exécution, et déclarer `llm/failover` par fusion de `SessionEventMap`
- [X] T004 [P] Ajouter `llm/failover` à `packages/core/session/src/known-event-types.ts` et prévoir l'enveloppe `ignorable: true`, sans changer `SESSION_FORMAT_VERSION`
- [X] T005 [P] Déclarer l'événement scopé `agent/model-reroute` dans `packages/core/agent/src/runtime-types.ts`, avec JSDoc `@mode` et `@param`, selon `contracts/llm-failover-event.md`
- [X] T006 Lancer `pnpm run gen-scoped-events` pour régénérer `packages/core/scope/src/scoped-events.generated.ts` (dépend de T005)
- [X] T007 Écrire d'abord les cas de `agent/model-reroute` dans `packages/core/agent/tests/model-selection.spec.ts` : `current` et `assembled` valent la route, la notice de changement apparaît une seule fois à l'étape suivante, et aucune fausse notice n'est émise (dépend de T005)
- [X] T008 Implémenter le listener dans `installModelSelection` et la route de référence de la notice dans `packages/core/agent/src/model-selection.ts`, en vérifiant `session-controller`, ACP et headless (dépend de T007)
- [X] T009 Ajouter `streamIdleTimeoutMs(provider)` à `LlmAdapter` et `LlmRuntime` dans `packages/llm/llm/src/index.ts`, sur le modèle de la politique de retry, et l'implémenter dans `packages/llm/llm-pi-ai/src/adapter.ts`, à côté de `providerRetryPolicy`. Prouver dans `packages/llm/llm/tests/service.spec.ts` et les tests de `llm-pi-ai` que le minuteur couvre l'attente du premier fragment et produit `TIMEOUT`
- [X] T010 Écrire d'abord `packages/llm/llm-free-mode/tests/config.spec.ts` pour chaque code de `contracts/free-mode-config.md` : `FREE_MODE_EMPTY_LIST`, `FREE_MODE_PAID_ROUTE`, `FREE_MODE_UNCONFIRMED_ROUTE`, `FREE_MODE_ROUTE_UNUSABLE`, `FREE_MODE_UNBOUNDED_RETRY`, `FREE_MODE_DUPLICATE_ROUTE`, `FREE_MODE_TIMEOUT_TOO_LONG`, un modèle absent de `llm-pi-ai`, le refus de `reportOnly` dans la section de settings, ainsi que `FREE_MODE_ROUTE_UNUSABLE` converti en état de route avec `reportOnly: true` de composition
- [X] T011 Implémenter le schéma et `resolve()` dans `packages/llm/llm-free-mode/src/config.ts` avec les règles « une route OpenRouter finit par `:free` ou vaut `openrouter/free` », « le fournisseur existe et son identifiant se résout », « le modèle est configuré sur ce fournisseur », « la politique de retry du fournisseur n'est pas `always` », « `streamIdleTimeoutMs` du fournisseur ne dépasse pas `maxRouteIdleMs` » et « aucun doublon `provider` + `model` » (dépend de T003, T010, T009)
- [X] T012 Créer la classe `Service` `LlmFreeMode`, exportée par défaut, dans `packages/llm/llm-free-mode/src/index.ts`, sur le modèle de `AgentDefaultModelConfig`, à une différence près : `settings` figure dans son `inject` obligatoire, pour ne jamais démarrer sur la config de base inactive. Elle publie `ctx.freeMode` et installe la section `llm-free-mode:`. `enabled: false` conserve `routes` et n'active rien (dépend de T011)
- [X] T013 Monter la ligne `llm-free-mode` dans `packages/bundle/base/cordis.patch.yml` et ajouter la dépendance dans `packages/bundle/base/package.json`, puis prouver dans `packages/bundle/base/tests/` que le plugin monté sans section `llm-free-mode:` ne change aucune requête (dépend de T012)
- [X] T014 Ajouter le test HMR de `packages/llm/llm-free-mode/tests/lifecycle.spec.ts` : la libération du fiber retire chaque listener et chaque garde (dépend de T012)

**Checkpoint**: le plugin se charge, valide sa configuration et n'a encore aucun effet sur les requêtes

---

## Phase 3: User Story 1 - Terminer une tâche malgré un modèle saturé (Priority: P1) 🎯 MVP

**Goal**: la tâche se termine avec le modèle suivant, et chaque bascule est visible et journalisée

**Independent Test**: rendre le premier modèle indisponible, lancer une tâche courte et vérifier
qu'elle se termine avec le suivant

### Tests for User Story 1

> Écrire ces tests d'abord et vérifier qu'ils échouent.

- [X] T015 [P] [US1] Tester la table `FailureCause` et chaque décision dans `packages/llm/llm-free-mode/tests/failover.spec.ts`, y compris liste terminée, `maxFailoverMs` dépassé, `agent/model-reroute` sans listener, annulation pendant l'attente, une seule bascule pour `invalid-request`, abandon d'un fournisseur pour `quota-exhausted`, `credential-missing` et `auth-refused`, respect de SC-003 et SC-004 avec minuteurs simulés, et candidat non résoluble ignoré sans arrêter le tour
- [X] T016 [P] [US1] Tester `packages/llm/llm-free-mode/tests/quota.spec.ts` : `remaining` à zéro, quota restant, réponse invalide, échec réseau, et absence de la valeur de l'identifiant dans les erreurs
- [X] T017 [P] [US1] Écrire le test de composition réelle `packages/llm/llm-free-mode/tests/composition.spec.ts` via un `cordis.yml` de test et le Loader, avec `llm-retry` listé avant puis après `llm-free-mode` : dans les deux cas `llm-retry` épuise son budget avant la bascule, `request/header` et `llm/failover` sont journalisés, et une session relue montre chaque bascule
- [X] T018 [P] [US1] Créer le snapshot `snapshots/session/free-mode-failover/` sur le modèle de `snapshots/session/empty-response-retry/`, et ajouter à `packages/test-support/session-snapshot/` le support manquant pour simuler une erreur de modèle

### Implementation for User Story 1

- [X] T019 [P] [US1] Implémenter la lecture de `GET /api/v1/key` dans `packages/llm/llm-free-mode/src/quota.ts` : identifiant lu via `ctx.credentials`, réponse validée, `free_model_daily_requests` projeté vers `Quota`, et `state: 'unknown'` en cas d'échec
- [X] T020 [US1] Implémenter dans `packages/llm/llm-free-mode/src/failover.ts` la classification de `data-model.md`, close par `assertNever` : `saturated` et `unavailable` basculent, `rate-limited` bascule après délai, `invalid-request` bascule une seule fois par étape puis arrête, `quota-exhausted`, `credential-missing` et `auth-refused` abandonnent le fournisseur et passent à un autre, sinon arrêtent, `context-exceeded` exige une capacité plus grande (dépend de T019)
- [X] T021 [US1] Ajouter dans `packages/llm/llm-free-mode/src/failover.ts` la projection `llmFailover` (`tried`, `startedAt`, `excludedProviders` et `invalidRequestSwitched`, remis à zéro par `step/start` et `turn/end`) (dépend de T020)
- [X] T022 [US1] Brancher dans `packages/llm/llm-free-mode/src/index.ts` le listener `agent/request-error` : appeler `next()` d'abord et renvoyer sa décision si elle vaut `{ kind: 'retry' }`, sinon résoudre le candidat par `ctx.llm.resolveCallConfig()` en ignorant une route non résoluble, journaliser `llm/failover` avant l'attente annulable, émettre `agent/model-reroute`, puis renvoyer `{ kind: 'retry' }` (dépend de T008, T021)
- [X] T023 [US1] Écrire sur `stderr` chaque bascule et le modèle final dans `packages/bundle/headless/src/index.ts`, avec ses cas dans `packages/bundle/headless/tests/headless.spec.ts` (dépend de T022)
- [X] T024 [P] [US1] Afficher `llm/failover` dans `packages/client/ui-trajectory/src/client/trajectory-event-projection.ts`, avec le texte dans `packages/client/ui-trajectory/src/client/locales.ts` et les tests client du package (dépend de T004)
- [X] T025 [US1] Mettre à jour les sorties attendues `snapshots/sdk/` et `scripts/snapshots/python-sdk-single-exe/` pour `llm/failover` (dépend de T022). Aucune sortie attendue ne change : le plugin est inactif par défaut et ces sorties ne projettent pas les événements `llm/*`. `snapshots/sdk/` repasse sans modification ; les sorties Python n'ont pas été exécutées

**Checkpoint**: US1 est fonctionnelle et testable seule

---

## Phase 4: User Story 2 - Garantir l'absence de frais (Priority: P1)

**Goal**: aucune requête n'atteint une route payante, même avec une clé payante présente

**Independent Test**: laisser une clé payante disponible, provoquer des échecs et vérifier qu'aucune
requête n'atteint une route payante

### Tests for User Story 2

- [X] T026 [P] [US2] Tester dans `packages/llm/llm/tests/service.spec.ts` la garde de route par `prepareCall`, par `ctx.llm.stream()` direct et malgré un listener `llm/stream` qui court-circuite, sans aucun appel à l'adapter
- [X] T027 [P] [US2] Tester dans `packages/web/web/tests/web.spec.ts` le refus d'un provider `billed` avec `WEB_PROVIDER_REFUSED_FREE_MODE`, y compris sélection par `DSH_WEB_SEARCH_PROVIDER`
- [X] T028 [P] [US2] Écrire `packages/llm/llm-free-mode/tests/free-guarantee.spec.ts` en composition réelle : clé payante présente, tous les modèles en échec, compaction, titre et sous-agent inclus, et aucune requête hors liste (SC-002). Couvrir aussi le démarrage : aucune requête ne part avant l'activation de la garde, en headless comme via `session-controller`, en ajoutant l'attente de `loader.await()` à `packages/api/session-controller/src/` si elle manque. Couvrir enfin `enabled: false` : gardes retirées et `routes` conservé (FR-011)
- [X] T029 [P] [US2] Tester le refus d'un modèle hors liste avec son explication, et l'absence de `model/selection` journalisé, dans `packages/api/session-controller/tests/agent.host.spec.ts` et `packages/acp/acp/tests/model-control.spec.ts`
- [X] T030 [P] [US2] Créer le snapshot `snapshots/session/free-mode-all-routes-failed/` sur le modèle de `snapshots/session/empty-response-retry/`

### Implementation for User Story 2

- [X] T031 [US2] Ajouter `registerRouteGuard()` et `checkRoute()` à `LlmRuntime` dans `packages/llm/llm/src/index.ts`. Vérifier dans `prepareCall` et `adapterStream`, lever `LlmError` de code `FREE_MODE_ROUTE_REFUSED` et renvoyer le disposer (dépend de T026)
- [X] T032 [US2] Enregistrer dans `packages/llm/llm-free-mode/src/index.ts` la garde par liste d'autorisation, sans traiter `FREE_MODE_ROUTE_REFUSED` comme une cause de bascule (dépend de T031)
- [X] T033 [P] [US2] Ajouter `billing: 'free' | 'billed'` à `WebSearchProvider` et `registerSearchGuard()` dans `packages/web/web/src/types.ts` et `packages/web/web/src/index.ts`, vérifié dans l'opération de recherche (dépend de T027)
- [X] T034 [US2] Déclarer `billing: 'billed'` dans `packages/web/web-search-deepseek/src/provider.ts`, `packages/web/web-search-exa/src/` et `packages/web/web-search-perplexity/src/provider.ts`, puis mettre à jour tout autre implémenteur (dépend de T033)
- [X] T035 [US2] Enregistrer la garde web dans `packages/llm/llm-free-mode/src/index.ts` et vérifier le message model-visible de `packages/web/tool-web/src/search.ts`, avec texte épinglé en test (dépend de T033)
- [X] T036 [US2] Refuser avec explication un choix de modèle hors liste dans `packages/api/session-controller/src/commands.ts` et `packages/acp/acp/src/model-control.ts`, via `ctx.llm.checkRoute()` (dépend de T031, T029)

**Checkpoint**: US1 et US2 fonctionnent, et le mode gratuit est garanti

---

## Phase 5: User Story 3 - Comprendre l'état du mode gratuit (Priority: P2)

**Goal**: une commande indique si le mode gratuit est prêt, et un échec final nomme sa cause

**Independent Test**: retirer un identifiant et un modèle de la configuration, lancer le diagnostic et
vérifier que les deux problèmes sont signalés

### Tests for User Story 3

- [X] T037 [P] [US3] Tester `packages/bundle/free-check/tests/free-check.spec.ts` pour chaque état de `contracts/free-check-profile.md`, les codes de sortie `0`, `1` et `2`, le délai réseau et l'absence de toute valeur d'identifiant dans la sortie. Ajouter à `packages/llm/llm-free-mode/tests/failover.spec.ts` le message final de chaque cause, avec l'action à faire (US3 scénario 3)
- [X] T038 [P] [US3] Ajouter un smoke sur build dans `apps/cli/tests/profiles/free-check/keyless-smoke.e2e.ts`, sur le modèle de `apps/cli/tests/profiles/sdk/keyless-smoke.e2e.ts`, avec un identifiant manquant qui produit `credential-missing` et non un échec de démarrage
- [X] T039 [P] [US3] Écrire `packages/llm/llm-free-mode/tests/openrouter.e2e.ts` : appels réels à `GET /api/v1/key` et `GET /api/v1/models`, sans aucune génération, ignorés si `OPENROUTER_API_KEY` est absent, sur le modèle de `packages/llm/llm-pi-ai/tests/provider-apis.e2e.ts`

### Implementation for User Story 3

- [X] T040 [US3] Créer `packages/bundle/free-check/` (`package.json`, `cordis.patch.yml`, `src/index.ts`, `src/startup.ts`) sur le modèle de `packages/bundle/headless/`, avec l'option `--json` analysée par `parseCmdline` et `reportOnly: true` sur la ligne `llm-free-mode`
- [X] T041 [US3] Implémenter les vérifications dans `packages/bundle/free-check/src/index.ts` : identifiant via `ctx.credentials`, liste et tarifs via `GET /api/v1/models`, quota via `quota.ts`, et état `unknown` jamais présenté comme `ok`. Le délai réseau est un champ `Config` (dépend de T019, T040)
- [X] T042 [US3] Enregistrer le profil `free-check` dans `apps/cli/src/`, `apps/cli/package.json` et `apps/cli/composition.md` (dépend de T040)
- [X] T043 [US3] Faire apparaître dans le message final de `packages/llm/llm-free-mode/src/failover.ts` la distinction entre quota épuisé, saturation et identifiant manquant, avec l'action à faire, et l'afficher dans headless et le Web (dépend de T022)

**Checkpoint**: toutes les stories sont fonctionnelles

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: documentation, traçabilité et preuves finales

- [X] T044 [P] Rédiger `packages/llm/llm-free-mode/README.md`, `README.zh.md` et `README.i18n.yaml`, avec Model Experience et Known Limitations reprenant les quatre limites validées de `plan.md`
- [X] T045 [P] Mettre à jour `README.md` et `README.zh.md` de `packages/llm/`, `packages/llm/llm/`, `packages/web/web/`, `packages/bundle/` et `packages/bundle/headless/`
- [X] T046 [P] Ajouter `agent/model-reroute` et le mode gratuit à `docs/architecture.md`, `docs/architecture.zh.md`, `docs/subsystems/llm-streaming.md` et `docs/subsystems/llm-streaming.zh.md`
- [X] T047 Écrire l'Agent Note de décision sous `.agents/notes/` selon `.agents/notes/README.md`, en reprenant R1, R4, R5 et R9 de `research.md`
- [X] T048 Régénérer les catalogues avec `pnpm run gen-config-catalog`, ce qui met à jour `docs/config-catalog.md`
- [X] T049 Suivre `.agents/skills/dsh-pre-push-checks/SKILL.md` pour choisir les plus petites vérifications qui couvrent le diff, sans lancer la suite complète par défaut, et rapporter seulement les commandes exécutées
- [X] T050 Exécuter les scénarios de `specs/001-mode-gratuit-fiable/quickstart.md`, corriger les commandes qui ne fonctionnent pas, et confirmer le statut de `openrouter/free` dans `research.md`
- [ ] T051 Enregistrer un GIF du flux Web réel avec `record-browser-gif` pour la PR, car T024 change un comportement visible

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** : aucune dépendance
- **Foundational (Phase 2)** : dépend de Setup et bloque toutes les stories
- **US1 et US2** : dépendent de Foundational, et peuvent avancer en parallèle
- **US3** : dépend de Foundational et réutilise `quota.ts` (T019). T043 dépend aussi de T022.
- **Polish (Phase 6)** : dépend des stories retenues

### User Story Dependencies

- **US1** : aucune dépendance vers une autre story
- **US2** : aucune dépendance fonctionnelle vers US1. T032 et T035 touchent aussi `src/index.ts`, donc ces tâches ne se font pas en même temps que T022.
- **US3** : dépend de T019 et T022 pour T041 et T043 seulement

### Within Each User Story

- Tests d'abord, avec échec constaté avant l'implémentation
- Mécanisme générique avant le plugin qui l'utilise
- Plugin avant l'affichage

### Parallel Opportunities

- T003, T004 et T005 en phase 2
- T015 à T018, puis T019 et T024 pour US1
- T026 à T030, puis T033 en parallèle de T031 pour US2
- T037, T038 et T039 pour US3
- T044, T045 et T046 en phase finale

---

## Parallel Example: User Story 1

```bash
# Tests d'US1 ensemble :
Task: "Tester la table FailureCause dans packages/llm/llm-free-mode/tests/failover.spec.ts"
Task: "Tester la lecture du quota dans packages/llm/llm-free-mode/tests/quota.spec.ts"
Task: "Écrire le test de composition dans packages/llm/llm-free-mode/tests/composition.spec.ts"
Task: "Créer le snapshot snapshots/session/free-mode-failover/"
```

---

## Implementation Strategy

### MVP

Le MVP réunit US1 et US2, car les deux sont P1. US1 seule ne doit pas être utilisée avec une vraie clé
sans le patch actuel de `~/.dsh/cordis.patch.yml`, qui reste la seule protection contre les frais.

1. Terminer les phases 1 et 2.
2. Terminer US1, puis valider avec son test indépendant.
3. Terminer US2, puis valider SC-002.

### Incremental Delivery

1. Setup et Foundational
2. US1 : bascule
3. US2 : garantie d'absence de frais
4. US3 : diagnostic
5. Polish

---

## Notes

- La CI exige 100 % de couverture par fichier sur `packages/*/*/src`.
- Aucun commit ni push sans demande de l'utilisateur.
- La config réelle de `~/.dsh` ne change qu'à l'étape de validation, avec l'accord de l'utilisateur.
- Les tests réels consomment le quota de 50 requêtes par jour : les réserver à T050.
