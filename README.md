# app-code-bot

Bot Slack **AppCode** : on le mentionne (ou on lui écrit en message privé) avec une question sur l'application (avec des captures d'écran si besoin). Il lance un thread T3 Code sur le projet qui contient le code. L'agent lit le code dans des worktrees jetables, lance au besoin l'application en local pour en faire des captures, puis le bot poste la réponse et les captures dans le fil Slack, **sans jamais partager de code**.

```
Slack (Socket Mode) ──► app-code-bot (Bun, Docker) ──► T3 /mcp ──► agent Claude (full-access, worktrees jetables)
        ◄──── réponse + captures dans le fil, @auteur ◄──── captures lues sur le disque de la machine T3
```

Les décisions de conception sont dans [docs/SPEC.md](docs/SPEC.md).

## Installation (sur la machine qui héberge T3)

> L'agent tourne en `full-access` : la machine doit être dédiée, sans secret de prod, avec des identifiants git **en lecture seule** (voir la spec).

1. **App Slack.** Dans Slack → *Your Apps* → *Create New App* → *From a manifest*, collez [deploy/slack-app-manifest.yaml](deploy/slack-app-manifest.yaml) et installez l'app.
   - `SLACK_BOT_TOKEN` : *OAuth & Permissions* → *Bot User OAuth Token* (`xoxb-…`).
   - `SLACK_APP_TOKEN` : *Basic Information* → *App-Level Tokens* → jeton avec le scope `connections:write` (`xapp-…`).
   - Invitez `@AppCode` dans les canaux où il doit répondre, et dans le canal d'alertes (`SLACK_ADMIN_CHANNEL`).
   - App déjà installée avec une version antérieure du manifest : recollez-le (*App Manifest*) puis réinstallez l'app pour accorder `im:history` et ouvrir l'onglet *Messages*, sans quoi le bot ne reçoit pas les messages privés.
2. **Jeton racine T3.** Le bot s'en sert pour se fabriquer tout seul, chaque mois, un jeton `full-access` (flux OAuth approuvé par code d'appairage). Sur la machine T3 :
   ```sh
   t3 auth session issue --label app-code-bot-root --ttl 3650d --token-only \
     --scope access:write --scope orchestration:read --scope orchestration:operate \
     --scope settings:write --scope source-control:write
   ```
   C'est l'identifiant le plus sensible du système : il ne doit vivre que dans `.env` sur cette machine.
3. **Projet T3.** `T3_PROJECT_ID` est l'id ou le nom du projet T3 qui contient les dépôts de l'application (`t3 project list`).
4. **Captures.** Dans les réglages T3, activez l'accès navigateur pour les agents (*enableAgentBrowserAccess*). Créez le dossier `CAPTURES_DIR`, accessible en écriture par l'utilisateur qui fait tourner T3 : l'agent y dépose ses captures Playwright quand les outils navigateur de T3 échouent.
5. **Configuration et lancement.**
   ```sh
   cp .env.example .env   # puis remplir
   docker compose up -d --build
   docker compose logs -f
   ```

Mise à jour : `git pull && docker compose up -d --build`.

## Comportement

- Mention dans un canal → « 🔎 Je fouille le code… » dans le fil → remplacé par `@auteur <réponse>`, suivi des captures éventuelles (3 images et 1 vidéo au maximum). Les vidéos sont réencodées par le bot (ffmpeg) en H.264 1920x1080, 30 images/s, environ 8 Mbit/s.
- Les réponses s'adressent aux équipes support et sales : détaillées, sans vocabulaire technique. Elles se terminent par une proposition : « Si tu souhaites le détail technique, une vidéo ou des captures d'écran du parcours, indique-le-moi en me mentionnant dans ce fil. » (en message privé : « indique-le-moi dans ce fil »). Un message demandant le détail technique (« détail technique », « techniquement », « côté code »…) obtient une réponse qui cite fichiers, fonctions et branche. Une demande de capture ou de vidéo (message contenant « vidéo », « capture », « screenshot »…) n'a pas de limite de temps : l'agent doit construire et lancer toute la stack, et le bot prévient que ça peut prendre plusieurs minutes.
- Les images jointes au message (et, pour un nouveau thread, jusqu'à 5 images postées plus haut dans le fil) sont transmises à l'agent. Vidéos, PDF et images de plus de 10 Mo sont ignorés et signalés.
- Nouvelle mention dans le même fil → même thread T3 (contexte conservé), une question à la fois. Si ce thread n'existe plus, un nouveau est créé avec les 20 derniers messages du fil.
- Seuls les membres internes sont servis (pas d'invités, pas de Slack Connect). En message privé 1:1, inutile de le mentionner : chaque message est une question, et la réponse arrive dans un fil sous le message. Les invités et externes qui lui écrivent en privé n'ont aucune réponse ; les messages privés de groupe sont ignorés.
- Au-delà de `ANSWER_TIMEOUT_MS` (8 min), le run est interrompu et l'auteur invité à reformuler (sauf pour une demande de capture).
- Si l'agent reste bloqué à attendre une réponse humaine, le bot l'interrompt et lui dit de continuer seul (une fois), puis abandonne.
- Les blocs de code éventuels sont retirés de la réponse. Seuls les fichiers situés dans les dossiers de captures (T3 et `CAPTURES_DIR`) peuvent être publiés.
- Le thread T3 est clôturé (*settled*) après chaque réponse ; une nouvelle question le rouvre.
- Si le jeton T3 ne peut pas être renouvelé, une alerte est postée dans `SLACK_ADMIN_CHANNEL`.

Le prompt de l'agent est [prompts/system.md](prompts/system.md) (`{{CAPTURES_DIR}}` y est remplacé au démarrage). Il est monté dans le conteneur : après modification, `docker compose restart`.

## Développement

```sh
bun install
bun test             # tests
bun run typecheck
bun run lint         # oxlint + oxfmt (lint:ci en CI)
bun run db:generate  # après modification de src/db/schema.ts
```

| Variable | Défaut | Rôle |
|---|---|---|
| `SLACK_BOT_TOKEN` | — | Jeton du bot (`xoxb-…`) |
| `SLACK_APP_TOKEN` | — | Jeton Socket Mode (`xapp-…`) |
| `SLACK_ADMIN_CHANNEL` | — | Canal des alertes (facultatif) |
| `T3_URL` | `http://127.0.0.1:3773` | Serveur T3 |
| `T3_ROOT_TOKEN` | — | Jeton racine (voir étape 2) |
| `T3_PROJECT_ID` | — | Projet T3 du code (id ou nom) |
| `T3_PROVIDER_INSTANCE` | `claudeAgent` | Instance de provider T3 |
| `T3_MODEL` | `claude-sonnet-5-5` | Modèle |
| `T3_EFFORT` | `high` | Effort de raisonnement |
| `T3_USERDATA_DIR` | — | Dossier de données T3 (compose : monte `attachments/` et `browser-artifacts/`) |
| `CAPTURES_DIR` | — | Dossier des captures Playwright de l'agent |
| `ANSWER_TIMEOUT_MS` | `480000` | Délai maximum de réponse |
| `DB_PATH` | `/data/app-code-bot.sqlite` (Docker) | Base SQLite (fils Slack → threads T3, jeton T3) |
| `SYSTEM_PROMPT_PATH` | `./prompts/system.md` | Prompt de l'agent |
