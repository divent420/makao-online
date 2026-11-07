# Makao Online

Node.js 22+ multiplayer Polish Makao game.

## Run locally

```bash
npm start
```

Run the automated game-engine and AI tests:

```bash
npm test
```

Open http://localhost:3000 (or the `PORT` environment variable).

## New in this build

- Mobile-first Android-inspired interface and responsive game table.
- Editable player profiles: display name, avatar and short bio.
- Public read-only player profiles, accessible from leaderboard entries, room members and opponents at the game table.
- Context-aware Back navigation: returns to the active lobby, room or game without leaving the table.
- Persistent player stats: rating, wins and games.
- Table appearance controls: felt colour, card-back pattern and card corner style. Preferences are stored in the browser.
- Visual design tokens and isolated `cardEl()` renderer to make replacing CSS cards with image assets straightforward.
- `/assets/` static route for future card/table graphics.
- SQLite schema migrations add profile fields to existing databases automatically.
- Active lobby and game snapshots are saved in SQLite and restored after a server restart. Turn deadlines are preserved; disconnected players receive the normal reconnect grace period.
- Quick Match pairs online players by Elo, widening the rating window as they wait.
- Solo practice supports one to three rule-based AI opponents with easy, normal and hard difficulty. AI matches are casual and do not change Elo or ranked player statistics.
- AI decisions are isolated in `ai.js` and all moves are validated by the existing Makao engine.
- AI practice supports rematches without returning to the lobby.

## Updating an existing deployment

1. Back up your current project and `makao.db`.
2. Replace the application files with this build and commit/push the changes to GitHub.
3. Keep the existing database file; new tables are created automatically for active-room recovery, without deleting existing accounts, ratings or match records.
4. Render will redeploy automatically if GitHub auto-deploy is enabled.

## Graphics customization

See `assets/README.md`. The game logic in `makao.js` is not coupled to the visual theme settings.

## Deployment notes

Requires Node.js 22 or newer because it uses the built-in `node:sqlite` module. For production, attach persistent storage for `makao.db`; ephemeral hosting filesystems can lose account/profile/rating data and active-game snapshots after a restart or redeploy. The game uses Server-Sent Events for live updates, so the hosting provider must support long-lived HTTP responses.

## Quick Match and AI practice

- **Quick Match** is a two-player ranked queue. It matches currently connected players with the closest rating and gradually widens the rating range while they wait. The queue is in memory and is cleared when the server restarts.
- **Play vs AI** starts a casual one-to-four-player table (you plus one to three bots). Choose Easy, Normal or Hard. AI matches are saved as match records but do not affect Elo, wins or ranked game totals.
- AI opponents use a rule-based decision module (`ai.js`). The server applies every bot action through `makao.js`, the same authoritative rules engine used for human actions.
- Completed AI games offer a rematch button.

## Current test coverage

```bash
npm test
```

The suite covers core game rules and AI decisions. The release was also smoke-tested with two authenticated users entering Quick Match and a third user starting a game with two AI opponents; an AI turn was observed automatically.
