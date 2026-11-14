# CDS Sports Meet 2K26 — Results System

This package contains a premium live viewer, host control panel, and a WebSocket/HTTP backend with persistent scores and winners.

## Files
- `server.js` — HTTP + WebSocket backend, winner persistence, scores, participant API proxy/import.
- `viewer.html` — public live scoreboard, Hall of Champions, rotating winners screen, announcement overlay.
- `host.html` — admin console, cascading event/category/gender/school/participant selector, Excel import, winner edit/delete, score controls and CSV export.
- `participants-sample.xlsx` — copy of the supplied registration export for import/testing.

## Railway deployment
1. Put `server.js`, `package.json`, `package-lock.json` (regenerate with `npm install`), `viewer.html`, and `host.html` in one GitHub repository/root directory.
2. Set Railway start command to `npm start` (or let Railway detect it).
3. Add a Railway Volume to the service and mount it at `/data`.
4. Add environment variables:
   - `DATA_DIR=/data`
   - `ADMIN_TOKEN=` a long random secret (do not share it or commit it)
   - `PARTICIPANTS_API_URL=` optional exact JSON endpoint from the registration backend
   - `PARTICIPANTS_API_TOKEN=` optional bearer token if the registration API requires one
5. Deploy. Check `https://YOUR-RESULTS-DOMAIN/health` returns `{ "ok": true }`.
6. Open `https://YOUR-RESULTS-DOMAIN/host.html`, open **Data / Security Settings**, and enter the same `ADMIN_TOKEN`.
7. If live participant API integration is not configured, import `participants-sample.xlsx` using **Import Excel Participants**. The import is stored on the Railway volume and shared with the host after refresh.
8. Open `https://YOUR-RESULTS-DOMAIN/viewer.html` on the display computer/projector.

## Participant API contract
If the registration application can provide a JSON endpoint, configure `PARTICIPANTS_API_URL` on this results service. The endpoint should return either an array or `{ "participants": [...] }`. Each row should contain:
- `name` (or `Name`)
- `school` (or `School`)
- `event` as a string or `events` as an array
- `ageCategory` (or `Age Category`)
- `gender`
- optional `chest`, `photoUrl`

The backend proxies this endpoint from `/api/participants`, avoiding browser CORS when the host and registration service are on different origins. Do not configure an endpoint until its exact path and response schema have been verified. The supplied Excel workbook is the working fallback.

## Winner behaviour
- First time the archive appears: when the fifth winner is announced, the viewer shows Hall of Champions for 9 seconds.
- After that: the archive appears every 15 seconds for 9 seconds, returning to the scoreboard between rotations.
- Every new winner triggers a premium 6.5-second announcement overlay.
- Individual events display participant name + school; relay events display the school/team name only.
- Winners and scores are written to `state.json` after every change. Imported participant rows are written to `participants.json`.

## Important deployment/security notes
- A Railway Volume is required for durable JSON persistence. Without it, redeploys/restarts may lose data.
- Set `ADMIN_TOKEN` before exposing the host. If unset, admin WebSocket and import actions are unauthenticated (development-only).
- Host token is stored in that browser's local storage. Only use the host panel on a trusted admin device; clear site storage if the device is shared.
- Do not expose participant API credentials in HTML/JavaScript. Keep them in Railway environment variables.
- This package does not change the live registration website or its GitHub repository. Direct live registration integration requires the exact deployed API route/response schema; until verified, use the included Excel import.
- The original supplied WebSocket service URL is not hard-coded. Host and viewer connect to the same origin they are served from.

## Local test
```bash
npm install
# macOS/Linux:
ADMIN_TOKEN=local-test DATA_DIR=./data npm start
# Windows PowerShell:
$env:ADMIN_TOKEN="local-test"; $env:DATA_DIR="./data"; npm start
```
Open `http://localhost:3000/host.html` and `http://localhost:3000/viewer.html`.


## Viewer rotation and advertisements
- Before five winners: scoreboard (15s) → participant showcase (15s) → repeat.
- At five or more winners: scoreboard → all pages of Congratulations Winners (15s per page) → participant showcase → repeat.
- Score changes temporarily show the scoreboard for 5 seconds, then resume the interrupted screen timer.
- Winner announcements interrupt normal rotation. During an ad, announcements are queued and shown after the video completes.
- Place video files (`.mp4`, `.webm`, `.ogg`, `.mov`, `.m4v`) in an `ADVERTISEMENT` folder at the repository root. The host panel controls ads ON/OFF and the interval in minutes. Ad settings persist in `/data/settings.json`.
- Ensure the Railway deployment includes the `ADVERTISEMENT` directory.
