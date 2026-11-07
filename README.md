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

## New in this build (v1.5.0)

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
- Player progression: XP, levels, match-based streaks, achievements and daily challenges.
- Recent match history with opponents, match type, result and XP earned.
- Progression rewards are recorded transactionally with completed match records and are idempotent per player/game.
- Cosmetic shop with server-side coin wallets, purchases and equipped items.
- Cosmetic inventory includes premium card backs, table themes and avatar frames; cosmetics do not affect gameplay or rankings.
- Players earn 10 coins for completing a human match plus 5 for a win; AI matches award half.
- Cosmetic purchases are validated and debited atomically in SQLite. Real-money checkout is not enabled in this release.

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

The suite covers core game rules, AI decisions, XP thresholds, achievement unlocks, daily challenge rewards, streak tracking, progression-history idempotency, friend requests, blocking, reports, private invitations, weekly tournament registration, bracket progression and winner recording. An end-to-end smoke test also exercised authentication, live presence, friend requests, private-table invitation/acceptance, four-player cup registration and tournament match launch.

## Player progression

- Every completed human match grants XP. Casual AI practice grants less XP than player matches; AI games never affect Elo.
- Levels use increasing XP thresholds (100 XP for level 2, then +50 XP per subsequent level).
- Daily challenges reset at 00:00 UTC and award bonus XP once per challenge per day.
- Achievements unlock for first match, first win, 10 matches, 10 wins, a three-win streak and an AI victory.
- Player profiles show XP/level progress, streaks, daily challenges, achievements and the latest 20 matches.
- Existing databases are migrated additively; existing accounts and match records are retained.


## Cosmetic shop

- Open **Shop** from the top bar or mobile navigation.
- Coins are awarded automatically when a match finishes (10 for a human match, plus 5 for a win; AI practice earns half).
- Purchases and equipment are stored server-side and shared across devices.
- The initial catalog contains card backs, table themes and avatar frames.
- The shop currently uses earnable in-game coins only. No real-money payment provider, paid currency, or checkout is configured.
- The shop tables (`shop_wallets`, `cosmetics`, `user_cosmetics`, `user_equipped_cosmetics`) are created automatically and do not alter existing account or match data.


## Friends and community (v1.5.0)

- Friend requests by username, accept/decline, remove friends and online/offline presence.
- Invite friends to a waiting private table. Invitations expire after 10 minutes and are revalidated on acceptance.
- Block players to remove the friendship, cancel pending social invitations and prevent future friend requests, private invites and direct table joins. Blocked pairs are also excluded from Quick Match.
- Report players for harassment, cheating, offensive names, spam or other conduct. Reports are stored in SQLite for operator review; this build does not yet include a moderation dashboard or automated sanctions.

## Weekly Makao Cup

- A new four-player single-elimination cup is created automatically each Monday at 00:00 UTC.
- Players can register from the Social screen. The fourth registration creates registration-order semifinal matches (1 vs 4 and 2 vs 3).
- Either participant can launch their ready match when both players have left any other table. The opponent is placed into the same game automatically.
- Match winners advance to the final; the final winner is recorded as the tournament champion.
- Tournament games award normal casual progression and coins but do not change Elo.
- Brackets, match status and active tournament match metadata are stored in SQLite and active matches use the existing room snapshot recovery.


## Moderation and operations (v1.6.1)

- **The first account registered on a fresh database automatically becomes the administrator.** No Render environment variable is required. All later registrations are regular players. Admin access is tied to normal authenticated sessions; there is no shared admin password or public admin registration route.
- Administrators see **Admin** in the top bar and can review reports, mark them as reviewing, resolve or dismiss them, and attach a moderator note. The report queue is available only to authenticated administrator accounts.
- Player reports are limited to five per reporter in a rolling ten-minute window.
- `/health` returns a minimal service health response and process uptime for external monitoring.
- Gameplay actions are rate-limited to 24 requests per player per two-second window. The server remains authoritative for turn order, card ownership and legal moves.
- Existing databases are migrated additively: admin and report-review fields are added without deleting player or game data.

Do not expose the service publicly without HTTPS, secure hosting, regular database backups and a trusted administrator account. The health endpoint is intentionally minimal; this phase does not yet include external alerting, automated account suspensions, or a full anti-cheat analytics system.


### First administrator

On a brand-new database, the first successful registration is atomically assigned administrator privileges. The database insert itself checks whether any user exists, so concurrent registrations cannot both become administrators. On an existing database with no administrator, startup safely promotes the oldest existing account. If the database is empty, the first successful registration becomes administrator. Existing administrator assignments are preserved.


## Version 1.6.2 updates

- Finished games retain a read-only final board, including the last discard and game log, so a bot's winning move remains visible.
- Human tables support rematches: each participant votes, and a new game starts when every remaining table member agrees. Tournament matches are excluded; AI practice retains its Play again action.
- The admin panel includes a player directory with rating, match stats, join date and coin balance. Admins can grant 1–10,000 coins with a reason; each grant is recorded in an audit table.
- Shop and Customize are combined into one Customize & Shop screen, containing free local table settings and earnable cosmetic purchases/equipment.
