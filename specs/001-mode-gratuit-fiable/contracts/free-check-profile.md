# Contrat : profil `free-check`

```sh
dsh --profile free-check [--json]
```

Le profil compose `dsh-base` et règle `reportOnly: true` sur la ligne `llm-free-mode`. Un identifiant
manquant devient donc un état de route, sans bloquer le diagnostic.

Le diagnostic n'envoie aucune requête de génération, donc il ne consomme pas le quota de modèles
gratuits. Il n'affiche jamais la valeur d'un identifiant.

## Vérifications

| Vérification | Source | État en échec |
|---|---|---|
| Identifiant présent | `ctx.credentials`, sans lire la valeur à l'écran | `credential-missing` |
| Modèle configuré dans `llm-pi-ai` | `ctx.llm.resolveCallConfig()` | `model-not-configured` |
| Modèle encore proposé | `GET /api/v1/models` | `model-withdrawn` |
| Modèle toujours gratuit | Tarifs de `GET /api/v1/models` | `model-now-paid` |
| Quota restant | `free_model_daily_requests` de `GET /api/v1/key` | `quota-exhausted` |

Un fournisseur sans liste de modèles ni lecture de quota renvoie l'état `unknown`, jamais `ok`.

## Sortie `--json`

```json
{
  "enabled": true,
  "ready": false,
  "routes": [
    { "provider": "openrouter", "model": "google/gemma-4-31b-it:free", "state": "ok" },
    {
      "provider": "groq",
      "model": "llama-3.3-70b-versatile",
      "state": "credential-missing",
      "action": "Définir GROQ_API_KEY"
    }
  ],
  "quota": [
    { "provider": "openrouter", "state": "known", "used": 12, "limit": 50, "remaining": 38 }
  ]
}
```

## Codes de sortie

| Code | Sens |
|---|---|
| `0` | Au moins une route `ok`, sans route payante |
| `1` | Aucune route utilisable, ou une route `model-now-paid` |
| `2` | Échec du diagnostic lui-même |

Une section invalide arrête le profil au démarrage, avec une erreur nommée et un code non nul.

Les appels réseau sont limités par `networkTimeoutMs` (10 s par défaut) et lancés en parallèle.
