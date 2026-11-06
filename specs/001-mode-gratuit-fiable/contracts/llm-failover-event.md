# Contrat : événement `llm/failover` et `agent/model-reroute`

## `llm/failover`

Événement de journal, absent de la surface du modèle. Il est ajouté avant le rejeu de l'étape.

```ts
interface LlmFailoverEventData {
  turn: number
  step: number
  from: { provider: string; model: string }
  /** Absent lorsque la bascule s'arrête. */
  to?: { provider: string; model: string }
  cause: FailureCause
  /** Code de l'échec d'origine, sans corps de requête ni identifiant. */
  failureCode: string
  /** Attente appliquée avant le rejeu, en millisecondes. */
  delayMs: number
}
```

Règles :

- le type est listé dans `known-event-types.ts`, comme `llm/retry`. `Session.append()` ne permet pas de poser `ignorable` : une version antérieure du harness refuse donc un journal qui contient cet événement ;
- `SESSION_FORMAT_VERSION` ne change pas ;
- un événement sans `to` précède toujours l'échec final du tour ;
- la cause finale est aussi affichée à l'utilisateur, avec l'action à faire.

## `agent/model-reroute`

Événement scopé à l'Agent, écouté par `installModelSelection`.

```ts
'agent/model-reroute'(
  this: Scoped<Agent>,
  payload: { agent: Agent; route: ModelSelection },
): boolean
```

Postconditions lorsque l'événement renvoie `true` :

- `selection.current` et `selection.assembled` valent `route` ;
- la tentative suivante de l'étape utilise `route` et journalise un `request/header` ;
- l'étape suivante reçoit la notice de changement de modèle, une seule fois.

Sans sélection installée, par exemple pour un sous-agent, aucun listener ne répond. La bascule
s'arrête alors et l'échec d'origine reste visible.

## Affichage (FR-005)

- headless : une ligne sur `stderr` par bascule, écrite après la réponse ;
- Web : une ligne dans la conversation, dérivée de `llm/failover`, avec texte dans les dictionnaires
  typés.
