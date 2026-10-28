# Sakuya's Haunted Cauldron

**English** · [Türkçe](README_TR.md)

A lightweight cauldron overlay for OBS, played through Twitch chat. Viewers type `!throw` to drop an emoji into the cauldron; at 100%, the configured odds select a **reward or punishment vote**. The winning outcome stays visible until a streamer or moderator completes it with `!done`.

## How it works

1. A viewer types `!throw`; their emoji drops into the cauldron and the percentage goes up. The personal cooldown defaults to 180 seconds, plus a shared 5-second cooldown between any two throws.
2. At 100%, the configured odds choose a reward or punishment type and the matching 30-second vote begins.
3. Chat votes by typing `1`–`5` (one vote per person). Ties are broken randomly; if no one votes, one of the five options is selected randomly.
4. The winning reward or punishment remains in a persistent active card until a streamer/moderator uses `!done`. Multi-game/task outcomes decrement their remaining count each time.
5. The cauldron resets only after its animation and the vote have both completed.

Architecture: one Twitch chat connection and a local HTTP server in Node.js; the overlay receives events over Server-Sent Events (SSE). No external AI, WebGL or image processing. The server only listens on `127.0.0.1` and is never exposed to your network.

## 1. Install Node.js

1. Install **Node.js 22 LTS** on Windows: [https://nodejs.org/](https://nodejs.org/)
2. Extract the project into a folder.
3. Run `install.bat`. It creates the `.env` file and installs the required packages.
4. Open `.env` in Notepad.

## 2. Twitch app and OAuth

The app signs in locally instead of asking you to paste a token anywhere. It requests two scopes:

- `chat:read`: to read `!throw` commands and votes.
- `chat:edit`: so the bot can post the vote start, the result and cooldown notices.

The bot writes as the account you connect. If you want messages to come from a separate bot account, sign in with that account in step 6.

1. Create a Twitch Developer application at [https://dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps).
2. Add this OAuth Redirect URL **exactly**: `http://localhost:3131/auth/callback`
3. If asked for a Client Type, choose **Confidential**, then copy the Client ID and Client Secret.
4. Fill in `.env`:

   ```
   TWITCH_CLIENT_ID=YOUR_CLIENT_ID
   TWITCH_CLIENT_SECRET=YOUR_CLIENT_SECRET
   TWITCH_CHANNEL=yourchannelname
   ```

   `TWITCH_CHANNEL` is the channel you stream on: the part of the URL after `twitch.tv/`, without `@`. You can leave the other settings as they are.
5. Run `start.bat`.
6. Open `http://127.0.0.1:3131/setup` in your browser and click **Connect Twitch account**. Approve both `chat:read` and `chat:edit`.
7. A local `tokens.json` file is created. Never share it, zip it or commit it; `.gitignore` already excludes it.

The redirect URL must match the Developer Console exactly. If you connected earlier with `chat:read` only, the terminal will warn about `chat:edit`; reconnect from `/setup`.

## 3. Test the overlay

With the app running, open:

`http://127.0.0.1:3131/overlay?test=1`

The test panel in the top-left has:

- **Test !throw**: throws as a fake viewer. Ten clicks fill the cauldron and start the vote.
- **Start vote**: opens the vote panel without filling the cauldron.
- **Test vote**: casts a random vote as a fake viewer.
- **Reset**: empties the cauldron and cancels any open vote.

The buttons are hidden on the normal OBS URL (without `?test=1`).

## 4. Add to OBS

1. Start the Node.js server with `start.bat`.
2. OBS → Sources → **+** → **Browser**.
3. URL: `http://127.0.0.1:3131/overlay`
4. Width: `1920`, Height: `1080`.
5. The background is transparent. The Node.js window must stay open for the Browser Source to work.

If the overlay is refreshed mid-vote, the panel picks up where it left off.

## 5. Chat commands

| Command | What it does |
| --- | --- |
| `!throw` | Throws a gift box (🎁); a 5% golden throw adds triple fill by default. |
| `!done` | Streamer/mod completes one active reward or punishment step; the final completion removes the card and plays confetti. |
| `!punish <text>` | Submit a punishment suggestion for moderator approval, e.g. `!punish Pistol Only | games=1`. |
| `!reward <text>` | Submit a reward suggestion for moderator approval. |
| `!approve <id>` / `!reject <id>` | Moderator approves or rejects a pending suggestion. |
| `!suggestions` | Moderator lists pending suggestions. |
| `!throw dragon`, `!throw pizza` | Throws the emoji matching the word (English keywords). |
| `!throw kedi`, `!throw cadı` | Turkish shortcuts: kedi, köpek, fare, hayalet, balkabağı, yarasa, örümcek, cadı, hediye, pizza, kalp, ejderha, kurukafa. |
| `!throw 🎃` | Throws the emoji you typed. |
| `1` … `5` | Votes while a vote is open (one vote per person). |

If nothing matches, 🎁 drops.

### Emoji filter

The server checks the emoji against a blocklist before it reaches the screen. A blocked emoji still counts as a throw but a 🎁 drops instead. The default blocklist is 🍆 🍑 💦 🖕 🔞 👅 💉 💊 🚬. Add your own by listing them in `BLOCKED_EMOJIS` in `.env` (e.g. `BLOCKED_EMOJIS=🔫🍺`), or edit `DEFAULT_BLOCKED_EMOJIS` in `server.js` to change the defaults.

### Cooldowns and notices

- The same person must wait `THROW_COOLDOWN_SECONDS` (default 180 s) between throws.
- There is also a shared `GLOBAL_COOLDOWN_SECONDS` (default 5 s) between any two throws.
- When someone hits their personal cooldown, the bot tells them how long is left ("you can throw again in 1m 55s"). To keep chat clean it speaks at most once per 30 s per person and once per 3 s per channel, and stays silent for the shared cooldown. Set `COOLDOWN_NOTICES=false` to turn notices off.

## 6. Punishment list

The five punishments live in the `PUNISHMENTS` list in `server.js`. You can change the texts; if you change the number of options from 5, also update the "1–5" chat message and the vote check.

## 7. `.env` settings

| Setting | Default | Description |
| --- | --- | --- |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | – | Twitch Developer app credentials. |
| `TWITCH_CHANNEL` | – | Channel you stream on. |
| `PORT` | `3131` | Local server port. If you change it, change the OAuth Redirect URL too. |
| `FILL_PER_THROW` | `10` | How much each valid `!throw` adds (10 = full after 10 throws). |

| `THROW_COOLDOWN_SECONDS` | `180` | Wait between one person's throws (3 minutes). |
| `GLOBAL_COOLDOWN_SECONDS` | `5` | Shared wait between any two throws. |
| `COOLDOWN_NOTICES` | `true` | Whether the bot posts cooldown notices. |
| `VOTE_SECONDS` | `30` | Reward or punishment vote length (5–300 s). |
| `REWARD_CHANCE` | `50` | Chance (%) that a full cauldron starts a reward vote; remaining chance starts punishment. |
| `GOLDEN_THROW_CHANCE` | `5` | Golden throw chance (%). |
| `GOLDEN_THROW_MULTIPLIER` | `3` | Fill multiplier for golden throws. |
| `CAULDRON_COOLING_PER_MINUTE` | `1` | Percentage points lost per idle minute; `0` disables cooling. |
| `BLOCKED_EMOJIS` | empty | Extra blocked emojis on top of the defaults. |

Note: `USER_COOLDOWN_SECONDS` and `HOST` from older versions are no longer used and can be removed.

## Files

- `server.js`: local web server, Twitch OAuth, chat connection, `!throw`, emoji filter, cooldowns, voting and SSE events.
- `public/index.html`: overlay markup and layers (cauldron, vote panel, test panel).
- `public/style.css`: transparent overlay, cauldron and vote panel styles, animations.
- `public/app.js`: receives server events, drops emojis, updates the percentage and the vote panel.
- `public/assets/`: cauldron GIFs (`cauldron-idle`, `cauldron-add`, `reward`, `punishment`).
- `community-data.json`: local approved community rewards/punishments, pending suggestions, and active outcomes; excluded from version control.
- `.env`: local secrets and settings (not committed).
- `tokens.json`: OAuth tokens (not committed).

## Behavior notes

- `REWARD_CHANCE` chooses the outcome type; the default is 50% reward and 50% punishment. Both types use the same five-option voting flow and persistent active-result lifecycle.
- Active outcomes remain visible until `!done` is used. Suggestion suffixes such as `games=3`, `rounds=2`, or `tasks=4` store a remaining count.
- The overlay reports animation completion at `/api/animation/complete`; the cauldron resets when both the animation and vote are complete.
- Golden throws and per-minute cooling are configurable. Cooling pauses during a round completion and voting.
- Viewer suggestions enter the voting catalog only after moderator approval.

## Security note

The Client Secret and `tokens.json` are private credentials. Do not paste them in chat, screenshots, GitHub or anywhere else. If something breaks, share the error message without the secret values.
