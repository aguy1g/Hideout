# Hideout

Private text + voice chat for friends. Run: `npm install` then `npm start` (http://localhost:3000).

## Share it with friends (easiest)
Install cloudflared once (`brew install cloudflared` / `winget install Cloudflare.cloudflared`), then:

    npm run share

It starts the server and a free tunnel, prints a link, and makes a random invite code for new sign-ups
(`npm run share -- --open` turns the code off, or set SIGNUP_CODE yourself).

## Settings (environment variables)
PORT, DATA_DIR, SIGNUP_CODE, MAX_ACCOUNTS, MAX_ROOMS, ROOM_TTL_DAYS, TRUST_PROXY=1, TLS_KEY/TLS_CERT,
ADMIN_USERS=you,friend (usernames that get an Admin page: list and remove accounts and rooms, no message access).

## Backups
`npm run backup` saves the data folder to a .tgz. `npm run backup -- --restore file.tgz` restores it (stop the server first).

## Voice on strict networks (optional TURN relay)
Pick one:
- Cloudflare Realtime TURN: CF_TURN_KEY_ID + CF_TURN_API_TOKEN
- Your own coturn: TURN_URLS=turn:host:3478 + TURN_SECRET (or TURN_USERNAME + TURN_CREDENTIAL)

## What the server can and can't see
Can't: passphrases, message text, reactions, channel names, files, profiles, voice.
Can: usernames, room names, who messaged whom and when, file sizes. It also decides who is who and who owns a room.
Data lives in DATA_DIR (accounts, rooms with encrypted history, encrypted files). Back that folder up.

## Desktop app
`desktop/` is an Electron wrapper (tray, start on login, global push-to-talk via uiohook-napi, game status). `cd desktop && npm install && npm start`; installers via `npm run dist:win` / `dist:mac` or the GitHub workflow in `.github/workflows/desktop.yml`. See the top-level README section 4c.
