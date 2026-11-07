# Makao Online

Node.js 22+ multiplayer Polish Makao game.

## Run locally

```bash
npm start
```

Open http://localhost:3000 (or the `PORT` environment variable).

## New in this build

- Mobile-first Android-inspired interface and responsive game table.
- Editable player profiles: display name, avatar and short bio.
- Persistent player stats: rating, wins and games.
- Table appearance controls: felt colour, card-back pattern and card corner style. Preferences are stored in the browser.
- Visual design tokens and isolated `cardEl()` renderer to make replacing CSS cards with image assets straightforward.
- `/assets/` static route for future card/table graphics.
- SQLite schema migrations add profile fields to existing databases automatically.

## Graphics customization

See `assets/README.md`. The game logic in `makao.js` is not coupled to the visual theme settings.

## Deployment notes

Requires Node.js 22 or newer because it uses the built-in `node:sqlite` module. For production, attach persistent storage for `makao.db`; ephemeral hosting filesystems can lose account/profile/rating data after a restart or redeploy. The game uses Server-Sent Events for live updates, so the hosting provider must support long-lived HTTP responses.
