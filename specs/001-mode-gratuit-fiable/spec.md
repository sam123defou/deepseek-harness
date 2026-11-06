# Feature Specification: Mode gratuit fiable

**Feature Branch**: `001-mode-gratuit-fiable` (nom réservé, aucune branche créée)

**Created**: 2026-11-05

**Status**: Draft

**Input**: User description: "configurer deepseek-harness pour qu'il fonctionne avec des modèles gratuits, regarder si possible de connecter avec DeepSeek chat gratuit"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Terminer une tâche malgré un modèle saturé (Priority: P1)

L'utilisateur lance une tâche. Si le modèle gratuit choisi est saturé ou indisponible, le harness
passe à un autre modèle gratuit et termine la tâche, sans intervention.

**Why this priority**: c'est le blocage constaté aujourd'hui. La configuration gratuite existe,
mais une tâche échoue dès que le modèle par défaut est saturé, alors que d'autres modèles gratuits
sont configurés.

**Independent Test**: rendre le premier modèle de la liste indisponible, lancer une tâche courte et
vérifier qu'elle se termine avec le modèle suivant.

**Acceptance Scenarios**:

1. **Given** un premier modèle saturé et un deuxième disponible, **When** l'utilisateur lance une
   tâche, **Then** la tâche se termine avec le deuxième modèle.
2. **Given** une bascule effectuée, **When** la tâche se termine, **Then** l'utilisateur voit quel
   modèle a répondu et pourquoi le premier a été quitté.
3. **Given** une session interrompue puis relue, **When** l'historique est consulté, **Then** chaque
   changement de modèle y apparaît.

---

### User Story 2 - Garantir l'absence de frais (Priority: P1)

L'utilisateur active le mode gratuit et a la certitude qu'aucune action ne consomme de crédit
payant, même si une clé payante reste présente sur sa machine.

**Why this priority**: le budget de l'utilisateur impose le gratuit. Une seule requête payante non
voulue rompt cette promesse.

**Independent Test**: laisser une clé payante disponible, exécuter des tâches avec échecs provoqués
et vérifier qu'aucune requête n'atteint une route payante.

**Acceptance Scenarios**:

1. **Given** le mode gratuit actif et une clé payante présente, **When** tous les modèles gratuits
   échouent, **Then** la tâche s'arrête sans appeler de route payante.
2. **Given** le mode gratuit actif, **When** l'utilisateur choisit un modèle payant, **Then** le
   choix est refusé avec une explication.
3. **Given** le mode gratuit actif, **When** l'agent utilise la recherche web, **Then** aucun service
   de recherche facturé n'est appelé.

---

### User Story 3 - Comprendre l'état du mode gratuit (Priority: P2)

L'utilisateur peut vérifier en une commande si son mode gratuit est prêt : identifiants présents,
modèles encore proposés et quota restant lorsqu'il est connu.

**Why this priority**: les modèles gratuits changent sans préavis et les quotas sont faibles.
L'utilisateur doit distinguer une panne passagère d'un problème de configuration.

**Independent Test**: retirer un identifiant et un modèle de la configuration, lancer le diagnostic
et vérifier que les deux problèmes sont signalés.

**Acceptance Scenarios**:

1. **Given** un fournisseur configuré sans identifiant, **When** le diagnostic est lancé, **Then** ce
   fournisseur est signalé comme inutilisable, avec l'action à faire.
2. **Given** un modèle configuré qui n'est plus proposé, **When** le diagnostic est lancé, **Then** ce
   modèle est signalé comme retiré.
3. **Given** tous les modèles en échec, **When** la tâche s'arrête, **Then** le message distingue
   quota épuisé, saturation passagère et identifiant manquant.

---

### Edge Cases

- Tous les modèles gratuits sont saturés : la tâche s'arrête avec un message clair, sans boucle
  infinie et sans consommer le quota restant inutilement.
- Le quota journalier du compte est épuisé : les routes de ce compte sont abandonnées dès ce
  constat, car elles partagent ce quota. La bascule continue seulement vers un autre fournisseur.
- Un modèle gratuit disparaît pendant une tâche : il est traité comme indisponible.
- Une bascule survient au milieu d'une tâche longue : le contexte déjà échangé est conservé, ou la
  tâche s'arrête s'il dépasse la capacité de tous les modèles restants.
- Le modèle de remplacement ne sait pas utiliser les outils demandés : il est ignoré.
- Un modèle gratuit devient payant : le diagnostic le signale, et l'utilisateur le retire de la
  liste.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Le système MUST permettre de définir une liste ordonnée de modèles gratuits.
- **FR-002**: Le système MUST passer au modèle suivant de la liste lorsqu'un modèle est saturé ou
  indisponible, après un nombre limité de nouvelles tentatives.
- **FR-003**: Le système MUST abandonner les routes d'un compte dont le quota est épuisé, arrêter
  la bascule lorsqu'aucune route ne reste, puis indiquer la cause.
- **FR-004**: Le système MUST enregistrer chaque bascule dans l'historique de session, avec le modèle
  quitté, le modèle choisi et la raison.
- **FR-005**: Le système MUST afficher à l'utilisateur le modèle qui a produit la réponse.
- **FR-006**: En mode gratuit, le système MUST refuser toute route payante, y compris lorsqu'une clé
  payante est disponible.
- **FR-007**: Le mode gratuit MUST couvrir tous les usages facturables du harness, dont la génération
  de texte et la recherche web.
- **FR-008**: Une configuration incohérente MUST échouer de façon visible au démarrage, par exemple
  une liste vide, un modèle payant dans la liste ou un fournisseur sans identifiant.
- **FR-009**: Les utilisateurs MUST pouvoir lancer un diagnostic du mode gratuit qui n'affiche jamais
  la valeur d'un identifiant, y compris lorsqu'un identifiant manquant bloquerait le démarrage normal.
- **FR-010**: Le système MUST NOT se connecter au chat web gratuit de DeepSeek ni automatiser son
  interface. Seuls les accès API proposés par les fournisseurs sont pris en charge.
- **FR-011**: Le système MUST permettre de quitter le mode gratuit par un choix explicite de
  l'utilisateur, sans perdre sa configuration.

### Key Entities

- **Modèle gratuit** : modèle utilisable sans frais, avec fournisseur, ordre de priorité, capacité
  de contexte, prise en charge des outils et état de disponibilité.
- **Liste de bascule** : ensemble ordonné de modèles gratuits essayés pour une tâche.
- **Événement de bascule** : trace d'un changement de modèle, avec heure, modèles concernés et cause.
- **Quota** : limite d'usage du compte chez un fournisseur, connue ou non du système.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Lorsqu'au moins un modèle de la liste est disponible, 95 % des tâches courtes se
  terminent sans intervention de l'utilisateur.
- **SC-002**: Aucune requête n'atteint une route payante sur l'ensemble des scénarios de test du
  mode gratuit, y compris lorsque tous les modèles échouent.
- **SC-003**: La bascule vers un modèle disponible aboutit en moins de 60 secondes.
- **SC-004**: Lorsque tout échoue, l'utilisateur reçoit la cause exacte en moins de 2 minutes.
- **SC-005**: Le diagnostic signale 100 % des identifiants manquants et des modèles retirés de la
  liste en moins de 15 secondes.

## Assumptions

- L'utilisateur est seul sur son poste, avec un PC modeste : aucun modèle local lourd n'est prévu.
- Le fournisseur principal reste OpenRouter, déjà configuré et doté d'un identifiant. Groq reste
  optionnel tant que `GROQ_API_KEY` n'est pas fourni.
- Le quota gratuit OpenRouter est faible, environ 50 requêtes par jour et 20 par minute selon des
  sources tierces à confirmer. La bascule ne peut donc pas garantir une disponibilité continue.
- Aucun modèle DeepSeek gratuit ne figure au catalogue OpenRouter consulté le 2026-11-05.
- La page de tarifs officielle de l'API DeepSeek ne documente aucun palier gratuit.
- L'accès automatisé au chat web DeepSeek est exclu : les conditions d'utilisation lues le
  2026-11-05 visent les robots et l'ingénierie inverse, et prévoient la suspension du compte.
- Le modèle de remplacement peut donner une qualité différente : ce risque est accepté et affiché.
- La configuration gratuite déjà présente dans `~/.dsh` sert de point de départ.
