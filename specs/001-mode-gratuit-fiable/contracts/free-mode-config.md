# Contrat : configuration du mode gratuit

## Montage

`packages/bundle/base/cordis.patch.yml` monte la ligne `llm-free-mode`, et `dsh-base` dépend du package.
Le plugin reste inactif tant que `enabled` ne vaut pas `true`, comme `llm-pi-ai` sans route. Aucun patch
utilisateur n'est nécessaire. Le profil `sdk-minimal` ne compose pas `dsh-base` et n'est pas couvert.

`settings` est une injection obligatoire du plugin : il ne démarre pas sur sa config de base, où le
mode gratuit serait inactif.

## Section `llm-free-mode:` de `settings.yaml`

```yaml
llm-free-mode:
  enabled: true
  rateLimitDelayMs: 5000
  maxFailoverMs: 55000
  maxRouteIdleMs: 20000
  routes:
    - provider: openrouter
      model: google/gemma-4-31b-it:free
    - provider: openrouter
      model: nvidia/nemotron-3.5-lightning:free
    - provider: groq
      model: llama-3.3-70b-versatile
      freeTierConfirmed: true
```

La route `groq` de cet exemple suppose que `GROQ_API_KEY` est fourni.

Chaque fournisseur listé doit aussi respecter ces réglages de `llm-pi-ai:` :

```yaml
llm-pi-ai:
  providers:
    openrouter:
      streamIdleTimeoutMs: 20000
      retryPolicy:
        mode: normal
        maxRetries: 1
```

Le calcul de ces valeurs est dans [research.md](../research.md), section R11.

## Erreurs de configuration

Chaque erreur nomme la route et l'action attendue. Une erreur autonome bloque le démarrage et, pour
une modification en direct, refuse l'écriture avec `settings-rejected`. Une vérification qui dépend d'un
autre plugin (`FREE_MODE_ROUTE_UNUSABLE`, `FREE_MODE_UNBOUNDED_RETRY`, `FREE_MODE_TIMEOUT_TOO_LONG`) a lieu
avant la première requête et fait échouer chaque requête tant que le problème reste. Une édition externe invalide
conserve la dernière valeur valide, donc le mode gratuit reste actif.

`reportOnly` est un champ de composition, réglé par le profil `free-check`. Il est refusé dans la
section `llm-free-mode:` de `settings.yaml`. Avec `reportOnly: true`, `FREE_MODE_ROUTE_UNUSABLE` devient
un état de route et ne bloque pas le chargement. Les autres erreurs restent bloquantes.

| Cas | Code |
|---|---|
| `routes` vide avec `enabled: true` | `FREE_MODE_EMPTY_LIST` |
| Route OpenRouter sans `:free`, hors `openrouter/free` | `FREE_MODE_PAID_ROUTE` |
| Autre fournisseur sans `freeTierConfirmed: true` | `FREE_MODE_UNCONFIRMED_ROUTE` |
| Fournisseur inconnu, modèle non configuré ou identifiant absent | `FREE_MODE_ROUTE_UNUSABLE` |
| `retryPolicy.mode: always` sur un fournisseur listé | `FREE_MODE_UNBOUNDED_RETRY` |
| Route en double | `FREE_MODE_DUPLICATE_ROUTE` |
| `streamIdleTimeoutMs` supérieur à `maxRouteIdleMs` | `FREE_MODE_TIMEOUT_TOO_LONG` |

## Refus à l'exécution

| Situation | Résultat |
|---|---|
| Requête LLM vers une route hors liste | `LlmError` de code `FREE_MODE_ROUTE_REFUSED`, sans requête réseau |
| Choix d'un modèle hors liste par l'utilisateur | Même refus, avec une explication |
| `web_search` avec un provider `billed` | `WebError` de code `WEB_PROVIDER_REFUSED_FREE_MODE` |

## Sortie du mode gratuit

`enabled: false` retire les gardes et la bascule, et conserve `routes`.
