<!--
Sync Impact Report
- Changement de version : modèle vierge → 1.0.0 (première adoption)
- Principes modifiés : aucun (les cinq emplacements du modèle sont remplis, deux principes ajoutés)
- Sections ajoutées :
  - I. Architecture par plugins et capability seams
  - II. Intégrité des données de session
  - III. Contrats explicites et échecs visibles
  - IV. Cycle de vie maîtrisé
  - V. Preuves adaptées à la surface modifiée
  - VI. Documentation et traçabilité
  - VII. Secrets et sandbox
  - Contraintes techniques
  - Processus de développement
  - Governance
- Sections supprimées : aucune
- Modèles à vérifier : aucun modifié ; plan-template.md, spec-template.md et tasks-template.md
  lisent cette constitution à l'exécution
- TODO différés : aucun
- Source : AGENTS.md, relu le 2026-11-05 (dernier commit local daté du 2026-09-09)
-->

# DeepSeek Harness Constitution

## Core Principles

### I. Architecture par plugins et capability seams

- Tout nouveau comportement DOIT passer par un point d'extension documenté. Une modification de
  `agent-loop` DOIT mettre à jour `docs/architecture.md`.
- Une capability seam DOIT comprendre les rôles Service Definition, Service Provider et Consumer.
  Ces rôles ne sont séparés que s'ils évoluent indépendamment.
- Seuls les profils `dsh` lancent les applications Node prises en charge. Les bins de packages,
  les démos et les échappements argv du SDK public sont interdits.
- Une dépendance maintenue DOIT être préférée à du code écrit à la main lorsqu'elle supprime
  réellement du code et des tests à maintenir.

Justification : le harness est entièrement composé de plugins Cordis, et chaque comportement doit
rester remplaçable sans modifier la boucle de l'agent.

### II. Intégrité des données de session

- Tout ce qui atteint une requête au modèle DOIT pouvoir être reconstruit depuis le journal de
  session. Une nouvelle entrée visible par le modèle DOIT avoir son événement de session.
- Une migration adjacente PEUT ajouter un successeur nommé par version. Elle NE DOIT JAMAIS
  déplacer, écraser ou supprimer une génération déjà committée.
- Seuls les changements de format structurels incrémentent `SESSION_FORMAT_VERSION`. SQLite
  utilise un `SCHEMA_VERSION` monotone.
- Les API publiques sont pré-stables : tout changement DOIT mettre à jour chaque consommateur.

Justification : les sessions publiées sont des données durables, et le journal est la seule source
qui permet de reconstruire ce que le modèle a reçu.

### III. Contrats explicites et échecs visibles

- Aux frontières de packages, la valeur par défaut DOIT être une étape explicite
  `resolve(request): Spec`, jamais un `?? default` caché dans `run()`.
- Les choix qui varient selon le déploiement DOIVENT être des champs `Config` validés et modifiables
  depuis `cordis.yml`. Les constantes de protocole, spécifications externes et invariants de
  sécurité restent fixes.
- Une mauvaise configuration DOIT échouer de façon visible au chargement, ou au plus tôt lorsqu'elle
  peut être résolue. Un élément référencé manquant NE DOIT JAMAIS être ignoré en silence.
- Les identifiants opaques qui traversent une frontière DOIVENT être typés avec `Branded<B>`.
- Le code DOIT compiler avec `strict: true` et `noImplicitAny`. Chaque `any` restant DOIT expliquer
  pourquoi le typage plus précis est impossible.
- La validation à l'exécution DOIT se limiter aux frontières de parseur ou de configuration, aux
  files d'attente, au JSON du modèle ou des outils, et aux frontières durables, de fichier, de
  worker, de processus et de réseau. Les appels typés dans un même processus font confiance à
  TypeScript.
- Les unions fermées DOIVENT se terminer par `assertNever`. Les unions extensibles par fusion
  DOIVENT aboutir à un cas par défaut documenté.

Justification : une erreur détectée tôt et nommée coûte moins cher qu'un repli silencieux dans un
système composé de nombreux plugins.

### IV. Cycle de vie maîtrisé

- Toute contribution DOIT passer par `ctx.effect()` ou `ctx.on()`. Le `register()` d'un registre
  DOIT renvoyer le disposer.
- Un listener waterfall DOIT appeler `next()` pour déléguer, sauf s'il interrompt volontairement
  la chaîne.
- `docs/defensive-patterns.md` DOIT être lu avant tout travail sur le cycle de vie, la concurrence,
  les sous-processus ou la libération des ressources.
- Un `catch` vide DOIT nommer ce qu'il ignore et pourquoi rien d'autre ne peut l'atteindre. Son
  `try` DOIT se limiter à une instruction.

Justification : le déchargement des plugins n'est fiable que si chaque ressource a un propriétaire
et une libération définis.

### V. Preuves adaptées à la surface modifiée

- La preuve DOIT correspondre à la surface modifiée : tests de comportement ciblés, snapshots des
  sorties modèle et utilisateur, `doc-sync` pour la documentation, smoke tests sur build pour les
  chemins publiés, e2e avec la vraie API pour les providers.
- Tout changement non trivial visible par le modèle ou l'utilisateur du produit DOIT mettre à jour
  un snapshot de session enregistrée sans clé.
- Les changements de `agent-loop`, du cycle de vie de session et de `SessionEventMap` DOIVENT mettre
  à jour les sorties attendues des SDK TypeScript et Python dans la même PR.
- La porte de couverture CI est `pnpm run test:coverage`, avec 100 % par fichier sur
  `packages/*/*/src`, et non `pnpm run test`.
- La suite complète NE DOIT PAS être lancée par défaut en local. Elle reste réservée à une demande
  explicite, au diagnostic CI ou à un changement réellement global au dépôt.
- Les tests décrivent le comportement. Un test obsolète change avec le comportement, et la PR
  explique pourquoi. Les fixtures se corrigent, pas les normaliseurs.

Justification : la CI possède la couverture exhaustive et la matrice de plateformes, tandis que le
travail local doit apporter la preuve la plus pertinente.

### VI. Documentation et traçabilité

- La documentation DOIT accompagner chaque changement de code : README et contrats JSDoc concernés
  sont mis à jour ensemble.
- Chaque module et export DOIT avoir un JSDoc concis sur son contrat non évident. Les exports de
  type fonction DOIVENT inclure `@param` et `@returns`.
- Tout changement non trivial DOIT inclure une Agent Note dans la même PR. Les notes archivées sont
  figées et NE DOIVENT PAS servir d'autorité actuelle.
- Les commentaires et la documentation DOIVENT énoncer des faits complets et concrets, sans
  métaphore, sans récit du raisonnement et sans répéter le code.
- Un invariant vérifiable mécaniquement DOIT être branché sur une porte exécutée au niveau racine,
  avec la preuve que chaque chemin d'acceptation modifié rejette un cas invalide.

Justification : `AGENTS.md` et `docs/AGENTS.md` imposent une documentation de l'état courant, avec
un seul emplacement par fait.

### VII. Secrets et sandbox

- Aucun identifiant NE DOIT être committé. `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` et `.env`
  suivent la politique de `docs/testing.md`.
- Une commande bloquée par la sandbox PEUT être relancée à l'identique avec l'élévation la plus
  étroite, uniquement sur preuve d'un blocage par la sandbox. Les échecs de test et la sandbox du
  produit NE DOIVENT JAMAIS être contournés.

Justification : le harness exécute des commandes pour un agent, donc ses protections ne peuvent pas
dépendre d'exceptions informelles.

## Contraintes techniques

- Environnement : espaces de travail pnpm, Node `^22.19 || >=24`, ESM partout avec
  `"type": "module"`.
- Packages : chaque package npm se nomme `@deepseek-ai/dsh-<name>`, et `@deepseek-ai/cordis` est
  une peerDependency et une dépendance de développement de chaque package du harness.
- Imports : noms de packages entre packages, et extension `.ts` dans les imports relatifs locaux.
- Plans de compilation : les portes statiques et les tests résolvent les imports vers `src` et
  passent sur un arbre propre. Une porte qui consomme `lib/` DOIT déclarer cette dépendance.
- `vendor/` : les packages sont des copies figées, mises à jour uniquement par la procédure de
  `vendor/README.md`, suivie de `pnpm run test && pnpm run build`.
- `cordis.yml` : `!!js` (jamais `!js`) est autorisé uniquement sous `config` et `disabled`.
- Interface client : le texte produit passe par des dictionnaires typés, et
  `verify-client-ui-i18n` rejette le texte codé en dur.

## Processus de développement

- Avant un push, les vérifications pertinentes DOIVENT passer par `dsh-pre-push-checks`, et seules
  les commandes réellement exécutées sont rapportées.
- Après `gh stack sync`, la validation DOIT être immédiate. Aucune fusion n'a lieu avant la réussite
  des vérifications.
- Les changements indépendants DOIVENT être séparés, et un défaut DOIT être corrigé dans la PR qui
  l'a introduit avant sa propagation.
- Les réécritures d'historique DOIVENT utiliser `--force-with-lease`, jamais `--force` seul.
- Chaque PR porte un seul label `kind/*`, tous les labels `area/*` pertinents et le type d'issue
  natif.
- Les fichiers se terminent par exactement un saut de ligne.
- La couverture unitaire, e2e et snapshot DOIT être planifiée pour les capability seams, les chemins
  de cycle de vie et les sorties de transcription.
- `dsh-translate-docs` ne s'exécute que sur demande explicite de l'utilisateur.

## Governance

- `AGENTS.md` reste la source d'autorité du dépôt. Cette constitution en résume les règles pour les
  commandes Spec Kit. En cas de contradiction, `AGENTS.md` prévaut et cette constitution DOIT être
  corrigée.
- Une modification de cette constitution DOIT indiquer sa raison et les principes touchés, puis
  mettre à jour la version et la date de dernière modification.
- Versionnage : MAJEUR pour le retrait ou la redéfinition incompatible d'un principe, MINEUR pour un
  ajout ou un élargissement important, CORRECTIF pour une clarification sans effet sur le sens.
- Conformité : chaque plan issu de `/speckit-plan` DOIT vérifier ces principes. Toute exception
  DOIT être justifiée dans le plan, avec l'alternative plus simple qui a été écartée.
- Les règles détaillées d'exécution se trouvent dans `AGENTS.md`, `docs/AGENTS.md`,
  `packages/AGENTS.md` et `docs/testing.md`.

**Version**: 1.0.0 | **Ratified**: 2026-11-05 | **Last Amended**: 2026-11-05
