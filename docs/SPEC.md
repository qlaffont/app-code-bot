# AppCode : spécification

Issue d'une séance de questions/réponses de conception (10/11/2026), révisée le même jour pour les médias et l'isolation (Q33–Q47). Chaque décision est numérotée comme dans la séance.

## Flux

1. Quelqu'un mentionne `@AppCode` dans un canal Slack.
2. Le bot poste « 🔎 Je fouille le code… » dans le fil du message.
3. Il crée un thread T3 dans le projet `T3_PROJECT_ID` (ou reprend celui du fil Slack), avec le prompt `prompts/system.md`.
4. Il attend la fin du run, supprime le message de chargement, poste `@auteur <réponse>` puis les captures éventuelles, et clôture (*settle*) le thread T3.

Pas de N8N dans le circuit (Q1). Les questions sont traitées en parallèle, sans limite ni file d'attente (Q10 bis).

## Slack

- App dédiée « AppCode » (Q3), en **Socket Mode** avec `@slack/bolt` (Q2) : aucune URL publique. Manifest : `deploy/slack-app-manifest.yaml`.
- Scopes : `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `users:read`, et `channels:read`, `groups:read`, `im:read`, `mpim:read` pour connaître le type de conversation (`app_mention` ne le donne pas).
- **Accès** (Q4) : membres internes uniquement. Refus poli pour les invités (`is_restricted`, `is_ultra_restricted`), les utilisateurs externes (`is_stranger`, autre `team_id`, ou `user_not_found`) et les DM, y compris de groupe. Une panne Slack pendant la vérification donne un message d'erreur, pas un refus. Les bots sont ignorés. Pas de liste blanche : le bot répond dans les canaux où il est invité.
- **Fil** (Q26) : réponse dans le fil du message (`thread_ts` ou `ts`). Uniquement sur mention. Doublons d'événements ignorés (`event_id`). Les questions d'un même fil sont traitées l'une après l'autre (elles partagent le thread T3) ; des fils différents restent en parallèle.
- **Retour visuel** (Q7, Q7 bis) : message de chargement, supprimé à la fin ; réponse ou erreur postée en mentionnant l'auteur.
- **Mise en forme** (Q8) : blocs de code retirés, Markdown → mrkdwn, découpage au-delà de 3 500 caractères. Une réponse faite uniquement de code n'est pas publiée.
- Scopes `files:read` (images reçues) et `files:write` (captures publiées).

## Médias (Q33–Q37, Q45, Q46)

- **Reçus** : les images (png, jpeg, gif, webp, ≤ 10 Mo) jointes à la mention sont téléchargées, envoyées à T3 (`t3_attachment_prepare_upload` + POST signé) et jointes au lancement du thread ou à la question de suivi (`t3_thread_send_attachments`). Pour un nouveau thread dans un fil existant, jusqu'à 5 images postées plus haut dans le fil s'y ajoutent (8 pièces jointes au total). Vidéos, autres fichiers et images trop lourdes sont ignorés et signalés en fin de réponse (Q45 : pas de traitement des vidéos).
- **Envoyés** : l'agent termine sa réponse par des lignes `[[media: /chemin]]`. Le bot les retire du texte, lit les fichiers (3 images et 1 vidéo au maximum, 50 Mo par fichier) et les publie dans le fil. Seules les images et vidéos réellement situées (après résolution de `..` et des liens symboliques) dans `browser-artifacts/` de T3 ou dans `CAPTURES_DIR` peuvent l'être, plus les vidéos du dossier `attachments/` de T3 (enregistrements) : ce dossier contient aussi les pièces jointes de tous les utilisateurs, dont aucune image ne doit fuiter d'un fil à l'autre. Ces dossiers sont montés en lecture seule, aux mêmes chemins, dans le conteneur. Une image reçue que T3 n'accepte pas, ou au-delà de 8, est aussi signalée.
- Captures avec les outils navigateur de T3 (pré-autorisés pour l'agent, réglage *enableAgentBrowserAccess*), ou Playwright en repli vers `CAPTURES_DIR` : lors d'un essai sur Mac, `preview_snapshot` a expiré (navigateur lié à la fenêtre de l'app).

## T3

- Accès par l'endpoint MCP du serveur T3 (`/mcp`, Streamable HTTP) (Q14).
- **Jeton** (Q43 bis) : un jeton émis par `t3 auth session issue` reste limité à `approval-required` (vérifié : `runtime_mode_escalation_denied`). Le seul jeton `full-access` vient du flux OAuth, fixé à 30 jours sans rafraîchissement. Le bot détient donc un jeton racine de 10 ans (`T3_ROOT_TOKEN`, scopes `access:write` + les 4 scopes d'un client full-access) avec lequel il fabrique un code d'appairage (`/api/auth/pairing-token`) et déroule seul le flux OAuth (`register` → `decision` en `pairing-code`/`full-access` → `token`, PKCE). Le jeton obtenu est gardé en SQLite et renouvelé 5 jours avant expiration (vérifié avant chaque appel et toutes les 6 heures) ou dès qu'un appel est refusé (401). Si un renouvellement anticipé échoue, le jeton courant reste utilisé jusqu'à expiration ; une seule alerte part dans `SLACK_ADMIN_CHANNEL` par série d'échecs. Flux vérifié de bout en bout sur T3 0.1.8-nightly.20261109.
- Threads lancés en `runtimeMode: full-access` (Q41), plafonnés par `T3-Mode-Limit` ; modèle Sonnet 5.5, effort `high`, configurables (Q17).
- Titre : `Slack · <auteur> · <début de la question>` (Q18). Clôturé après chaque réponse ; un nouveau message le rouvre automatiquement.
- **Suivi** (Q6, Q26) : correspondance fil Slack → thread T3 en SQLite (Drizzle, `bun:sqlite`). Une nouvelle mention dans le fil est envoyée au même thread ; s'il n'existe plus (`thread_not_found` / `thread_not_sendable`), un nouveau thread est créé avec les 20 derniers messages du fil comme contexte.
- **Attente** : `t3_thread_wait` par tranches de 15 s, puis lecture de `pendingRequestCount`. En `full-access` il n'y a pas d'approbation, mais l'agent peut rester bloqué sur une question : le bot l'interrompt et lui dit, une fois, de continuer seul ; à la deuxième, il abandonne et l'explique dans Slack.
- **Délai** (Q9, Q32, Q38) : 8 min côté bot, 6 min annoncées à l'agent (marge pour nettoyer). Au-delà, le run est interrompu et l'auteur invité à reformuler ; le bot demande alors à l'agent, dans le même thread, de tout arrêter et nettoyer, et laisse le thread ouvert (non clôturé) pour inspection. Idem quand l'agent reste bloqué deux fois.

## Isolation plutôt que lecture seule (Q15 ter, Q35, Q36, Q41, Q42)

Lancer l'app pour les captures exige Bash (`docker`, `mvn`, `pnpm`), donc `full-access` : en `approval-required`, toute commande non auto-approuvée bloque le thread et T3 ne permet pas de répondre aux approbations via MCP (vérifié : `git log`/`show`/`grep` passent, `git fetch` et `git -C` bloquent). Aucune protection ne se règle au lancement d'un thread via MCP (seuls `effort`, `thinking`, `fastMode`, `ultracode`), et rien n'est déposé dans le projet T3. Les protections sont donc :

1. **Isolation** : l'agent travaille dans ses propres worktrees (`<dépôt>/.qa/<id>`, depuis `origin/<branche>` après `git fetch`), lance base, API et front sur des ports libres avec des noms uniques, peut modifier ces données locales, puis supprime tout avant de répondre.
2. **Le prompt** : pas de commit, pas de push, pas d'environnement déployé, rien hors de ses worktrees.
3. **La machine** (Q42) : dédiée, identifiants git en lecture seule (aucun push possible), aucun secret de prod/staging ni VPN, utilisateur système dédié.

Risque accepté : un membre interne pilote depuis Slack un agent qui a un shell complet sur cette machine (y compris par injection de prompt via un message ou une image).

## Code, environnements et stack locale (Q21–Q24, Q39, Q44, Q47)

Le bot ne gère aucune copie du code : il réutilise le projet T3 (dossier contenant les dépôts de l'application). Le prompt indique la branche (`main` par défaut ; `dev` → `dev`, `staging` → `staging`, `prod`/`demo` → `main`) et la procédure. Pour les captures, stack complète par question (Q47 a) : base en conteneur, API et front lancés depuis les worktrees selon les README / `CLAUDE.md` des dépôts, comptes de test de dev. Le prompt est générique ; les détails propres à une application (dépôts, commandes, comptes) s'ajoutent dans `prompts/system.md`. Mesure sur le projet de référence : voir « Mesures ».

## Réponses (Q3, Q25)

Langue de la question, ton amical (ni trop formel ni trop familier), 15 lignes maximum, fichiers et fonctions cités, aucun extrait de code, « je n'ai pas trouvé » plutôt qu'inventer.

## Déploiement et qualité (Q12, Q13, Q19, Q20, Q27, Q28)

- Machine Linux qui héberge T3 (≥ 0.1.8-nightly.20261109), Docker Engine, `network_mode: host`, `docker compose up -d --build`. Logs JSON sur stdout.
- CI GitHub Actions (runners `ubuntu-latest`, conteneur `oven/bun` pour lint et tests) : lint (`oxlint`, `oxfmt --check`, `tsc`), `bun test`, `docker build`, lint des titres de PR, TruffleHog.
- Tests aux interfaces convenues : `formatAnswer`, `checkAccess`, le gestionnaire de jeton, le lecteur de médias (confinement des chemins), et le gestionnaire de mentions de bout en bout avec un faux Slack et un faux T3 (base SQLite réelle en mémoire).

## Mesures

Démarrage de la stack complète du projet de référence (API Kotlin/Maven + Postgres, front Vite) depuis des worktrees neufs de `origin/main`, sur le Mac de dev (cache Maven `~/.m2` et store pnpm déjà remplis) : worktrees + Postgres 2 s, build Maven de l'API 74 s, `pnpm install` 80 s, front prêt à 84 s, **API prête à 124 s**. Le budget de 8 minutes laisse donc environ 5 minutes pour lire le code, capturer et nettoyer.

## Points à vérifier à la mise en service

- Que `preview_snapshot` fonctionne sur la machine cible (sinon l'agent passe par Playwright vers `CAPTURES_DIR`).
- Que la stack complète démarre dans le budget de 8 minutes sur la machine cible (cache Maven et pnpm froids au premier lancement) ; sinon passer au back partagé (Q47 b).
- Que le jeton racine fonctionne sur le serveur T3 de la machine cible.
