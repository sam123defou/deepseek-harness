# Research: Mode gratuit fiable

Sources : code du dépôt sur `b2e3b2a012`, config `~/.dsh` lue avec secrets masqués, et pages
OpenRouter `api-reference/limits` et `api-reference/errors` lues le 2026-11-05.

## R1. Changer de modèle dans une étape

**Decision**: écouter `agent/request-error` et renvoyer `{ kind: 'retry' }` après avoir changé la
sélection. `agent-loop` n'est pas modifié.

**Rationale**: `step()` rappelle `prepareRequest()` à chaque tentative, donc `agent/request` est
réévalué. Un changement de route produit un `request/header` de raison `change`, ce qui respecte
« model-visible ⟺ logged ».

Limite du mécanisme : seul un échec de flux atteint `agent/request-error`. `prepareRequest()` s'exécute
hors de ce chemin, donc une erreur de `prepareCall()` comme `UNKNOWN_MODEL` ou `INVALID_CONFIG` termine
le tour. Le plugin valide donc ses routes au chargement et résout chaque candidat par
`ctx.llm.resolveCallConfig()` avant de basculer. `MISSING_CREDENTIAL` est levé dans le flux et reste
couvert par la bascule.

**Alternatives considered**: étendre `RequestErrorAction` avec une route (modifie la boucle) ;
abandonner le tour et le relancer (perd la continuité de la tâche).

## R2. Atteindre la sélection de modèle

**Decision**: ajouter l'événement scopé `agent/model-reroute`, écouté par `installModelSelection`.
Il met à jour `current` et `assembled` et signale s'il a été appliqué.

**Rationale**: le `ModelSelectionRef` est privé à chaque point d'entrée (session-controller, ACP,
headless). Un simple listener `agent/request` serait incohérent : à l'étape suivante, `agent/pre-step`
comparerait l'ancienne sélection au dernier en-tête et annoncerait un faux changement de modèle.

`decision.messages` n'est admis qu'à la première tentative. La notice de changement est donc ajoutée
à l'étape suivante, en mémorisant la route de référence dans la sélection.

**Alternatives considered**: `WeakMap` exportée par `dsh-agent` (état global caché) ; exposer le
ref sur `Agent` (élargit l'API pour un seul Consumer).

## R3. Ordre avec `dsh-llm-retry`

**Decision**: le listener de `dsh-llm-free-mode` appelle `next()` en premier et ne bascule que si le
résultat n'est pas `{ kind: 'retry' }`. Le résultat ne dépend donc pas de l'ordre d'enregistrement.

**Rationale**: `packages/bundle/base/cordis.patch.yml` indique que l'ordre des lignes n'a aucun effet
sur le chargement, donc aucune décision ne peut s'appuyer dessus. Le budget de retry est indexé par fournisseur et politique, et
non par modèle : une fois épuisé dans l'étape, les modèles suivants du même fournisseur basculent sans
nouvelle tentative. Cela limite la consommation du quota.

Le mode `always` de `retryPolicy` n'appelle jamais de fin de tentatives. Il est donc refusé au
chargement pour toute route de la liste. Le défaut de 5 retries coûterait jusqu'à 6 requêtes par
modèle : la config recommandée utilise `maxRetries: 1`.

**Alternatives considered**: remplacer `dsh-llm-retry` en mode gratuit (duplique backoff et
journalisation).

## R4. Distinguer quota, limite par minute et saturation

**Decision**: après un `RATE_LIMIT` sur OpenRouter, lire `GET /api/v1/key`.
`free_model_daily_requests.remaining === 0` abandonne les routes de ce fournisseur avec la cause
`quota-exhausted`, et la bascule ne continue que vers un autre fournisseur. Sinon elle continue après `rateLimitDelayMs`. Si la lecture échoue, la cause reste « inconnue » et la
bascule continue dans la limite de `maxFailoverMs`.

**Rationale**: `classifyPiAiError` travaille sur du texte, car pi-ai aplatit les erreurs. `LlmFailure`
n'a ni en-têtes ni `metadata`, et le chemin pi-ai ne renseigne pas `status`. L'exemple documenté d'un
429 est `Rate limit exceeded` : `isQuotaExceededError` ne le reconnaît pas, donc une limite journalière
sort en `RATE_LIMIT`. OpenRouter documente que le corps d'erreur ne distingue pas minute et jour.

Limite acceptée : la limite de 20 par minute porte sur le compte, et rien ne la distingue d'un 429 du
fournisseur amont. Changer de modèle peut donc ne pas aider. `maxFailoverMs` borne ce cas.

**Alternatives considered**: analyser le texte du 429 (format non documenté, jamais observé dans
`~/.dsh/sessions`) ; corriger pi-ai pour remonter les en-têtes (dépendance amont, marqueur `XXX`
existant dans `stream.ts`).

## R5. Où refuser une route payante

**Decision**: ajouter `ctx.llm.registerRouteGuard(guard)` à `LlmRuntime`, vérifié dans `prepareCall`
et dans `adapterStream`. Le refus lève `LlmError` de code `FREE_MODE_ROUTE_REFUSED`.

**Rationale**: la boucle, la compaction, les titres et les sous-agents convergent vers `adapterStream`.
`packages/AGENTS.md` impose d'appliquer une décision dans l'opération qui la prend, et un listener de
`llm/stream` peut être court-circuité. La garde fonctionne par liste d'autorisation : une route non
listée est refusée, même gratuite, et `FREE_MODE_ROUTE_REFUSED` n'est jamais une cause de bascule
vers une route hors liste.

**Alternatives considered**: désactiver `llm-deepseek` par patch, solution actuelle (ne protège pas
d'une route payante via `llm-pi-ai`) ; lire le coût pi-ai (le harness l'ignore et `replay.ts` le met
à zéro).

## R6. Établir qu'une route est gratuite

**Decision**: une route OpenRouter doit finir par `:free` ou valoir `openrouter/free`. Tout autre
fournisseur exige `freeTierConfirmed: true`. `free-check` compare ensuite avec les tarifs de
`GET /api/v1/models`, et un tarif non nul rend la route inutilisable au diagnostic.

**Rationale**: le suffixe est le critère documenté par OpenRouter. Groq ne porte aucun marqueur par
modèle : sa gratuité dépend du compte, et seul l'utilisateur peut l'affirmer.

Limite acceptée : un passage au payant n'est détecté qu'au lancement de `free-check`. Pour un slug
`:free`, un retrait produit une erreur et non une facturation. Le routeur `openrouter/free` est
accepté d'après son nom et son tarif, à reconfirmer à l'implémentation.

**Alternatives considered**: appel réseau à chaque démarrage (ralentit le lancement et rend le
chargement dépendant du réseau).

## R7. Recherche web

**Decision**: chaque `WebSearchProvider` déclare `billing: 'free' | 'billed'`. `ctx.web` reçoit
`registerSearchGuard()`, vérifié dans son opération de recherche. Les trois providers existants
déclarent `billed`.

**Rationale**: `web-search-deepseek` est déjà désactivé dans le patch utilisateur, mais Exa, Perplexity
ou `DSH_WEB_SEARCH_PROVIDER` peuvent être réactivés. Aucun provider gratuit n'existe aujourd'hui, donc
`web_search` renvoie une erreur explicite et `web_fetch` reste disponible.

**Alternatives considered**: ajouter un moteur gratuit (hors spec, à traiter séparément).

## R8. Diagnostic

**Decision**: nouveau profil `free-check`, lancé par `dsh --profile free-check`. Il compose `dsh-base`
et règle `reportOnly: true` sur la ligne `llm-free-mode`.

**Rationale**: seuls les profils `dsh` lancent des applications Node. Le pattern existe dans
`packages/bundle/headless`. Sans `reportOnly`, l'identifiant manquant que le diagnostic doit signaler
bloquerait son propre démarrage (FR-008). La découverte de `llm-pi-ai` ne convient pas : pour une route du catalogue
installé, elle répond depuis le catalogue sans réseau et ne détecterait pas un modèle retiré. Le
diagnostic appelle donc directement `GET /api/v1/models` et `GET /api/v1/key`.

**Alternatives considered**: drapeau sur le profil `headless` (mélange deux applications) ; bin de
package (interdit).

## R9. Persistance de la bascule

**Decision**: le modèle de remplacement reste actif pour la session. Une nouvelle session repart du
début de la liste. Un choix explicite de l'utilisateur remplace la route courante.

**Rationale**: réessayer le premier modèle à chaque tour consomme un quota faible. Dans
session-controller, `current` relit déjà le dernier en-tête journalisé, ce qui conserve la route.
Dans headless, `current` est un champ simple : `agent/model-reroute` le met à jour.

**Alternatives considered**: revenir au premier modèle à chaque tour.

## R10. Mise en place

**Decision**: `dsh-base` monte le plugin, inactif tant que `llm-free-mode.enabled` ne vaut pas `true`
dans `settings.yaml`. `dsh-base` dépend du package. Aucun patch utilisateur n'est nécessaire.

**Rationale**: `llm-pi-ai` suit déjà ce modèle : monté sans route, il s'active par les settings. Un
patch utilisateur serait fragile : une ligne hors `insert` qui vise une entrée absente produit
seulement un avertissement, et la protection manquerait sans erreur. Une section invalide rejette
l'enregistrement au démarrage, et une édition invalide conserve la dernière valeur valide : le mode
gratuit ne se désactive donc pas par erreur. `settings` est une injection obligatoire, car `installSection`
retombe sinon sur la config de base, où le mode est inactif. Headless attend `loader.await()` avant de
créer un Agent ; `session-controller` n'y fait pas référence, et ce démarrage reste à prouver. FR-011 est couvert par `enabled: false`, qui conserve la
liste. `sdk-minimal` ne compose pas `dsh-base` et reste hors de ce mode.

**Alternatives considered**: ligne `insert` dans `~/.dsh/cordis.patch.yml` (échec silencieux possible,
et résolution du package non garantie).

Le patch actuel définit `groq/llama-3.1-8b-instant` comme modèle de repli alors qu'aucune clé Groq
n'existe. Avec FR-008, cette incohérence échouera au démarrage si la route figure dans la liste.

## R11. Respecter les délais de bascule

**Decision**: le plugin refuse au chargement une route dont `streamIdleTimeoutMs` dépasse
`maxRouteIdleMs`. `ctx.llm.providerAccess(provider)` expose cette valeur, sur le modèle de la
politique de retry. Valeurs recommandées : `streamIdleTimeoutMs: 20000`, `maxRouteIdleMs: 20000` et
`maxFailoverMs: 55000`.

**Rationale**: le défaut de 300 s retarderait la bascule d'un modèle bloqué de 5 minutes, alors que
`maxFailoverMs` n'agit qu'après un échec. Pire cas avec ces valeurs : 20 s, un retry, 20 s, soit
environ 41 s avant la première bascule, donc SC-003 tient si le modèle suivant répond en moins de
19 s. Pour SC-004, 41 s, 55 s et un dernier délai de 20 s donnent environ 116 s.

Limite acceptée : un modèle lent à produire son premier fragment peut être quitté à tort. La valeur
reste réglable.

**Alternatives considered**: listener `llm/stream` avec minuteur (`next()` ne permet pas de transmettre
un signal d'annulation, et la requête bloquée continuerait).

## Faits confirmés pour la spec

- Les 50 requêtes par jour et 20 par minute sont confirmées par la documentation officielle. Le
  plafond passe à 1000 par jour après 10 crédits achetés au total.
- Créer d'autres comptes ou clés ne change pas les limites, d'après OpenRouter.
- Un solde négatif peut produire des erreurs même sur les modèles gratuits. Le code exact n'est pas
  documenté, et ce cas sort donc en cause `unknown`.
- Aucune erreur `RATE_LIMIT` ou `QUOTA` n'a été trouvée en texte clair dans `~/.dsh/sessions`. Le
  blocage cité par la spec n'est donc pas vérifié par les journaux locaux.
