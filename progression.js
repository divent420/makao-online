'use strict';

const ACHIEVEMENTS = [
  ['first_game', 'First Steps', 'Complete your first match', '🎮', 20],
  ['first_win', 'First Victory', 'Win your first match', '🏆', 25],
  ['games_10', 'Regular Player', 'Complete 10 matches', '🃏', 40],
  ['wins_10', 'Winning Habit', 'Win 10 matches', '🥇', 60],
  ['streak_3', 'On a Roll', 'Win 3 matches in a row', '🔥', 50],
  ['ai_win', 'Practice Pays Off', 'Win a match against AI', '🤖', 25],
];

const DAILY_CHALLENGES = [
  { id: 'play_2', title: 'Table Time', description: 'Complete 2 matches', goal: 2, reward: 30, kind: 'play' },
  { id: 'win_1', title: 'Claim a Victory', description: 'Win 1 match', goal: 1, reward: 35, kind: 'win' },
  { id: 'ai_1', title: 'Practice Round', description: 'Complete 1 match against AI', goal: 1, reward: 20, kind: 'ai' },
];

function xpLevel(xp) {
  let level = 1;
  let remaining = Math.max(0, Number(xp) || 0);
  let needed = 100;
  while (remaining >= needed) {
    remaining -= needed;
    level++;
    needed = 100 + (level - 1) * 50;
  }
  return { level, xpIntoLevel: remaining, xpForNextLevel: needed };
}

function initialize(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS player_progress(
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      xp INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 1,
      total_games INTEGER NOT NULL DEFAULT 0, total_wins INTEGER NOT NULL DEFAULT 0,
      current_streak INTEGER NOT NULL DEFAULT 0, best_streak INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS achievements(
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
      icon TEXT NOT NULL, xp_reward INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS user_achievements(
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      achievement_id TEXT NOT NULL REFERENCES achievements(id), unlocked_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, achievement_id)
    );
    CREATE TABLE IF NOT EXISTS user_daily_challenges(
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day_key TEXT NOT NULL, challenge_id TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0, completed_at INTEGER,
      PRIMARY KEY(user_id, day_key, challenge_id)
    );
    CREATE TABLE IF NOT EXISTS user_match_history(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      played_at INTEGER NOT NULL, result TEXT NOT NULL, opponents TEXT NOT NULL,
      ranked INTEGER NOT NULL DEFAULT 0, ai_game INTEGER NOT NULL DEFAULT 0,
      xp_earned INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, game_id)
    );
  `);
  const insert = db.prepare('INSERT OR IGNORE INTO achievements(id,title,description,icon,xp_reward) VALUES(?,?,?,?,?)');
  for (const row of ACHIEVEMENTS) insert.run(...row);
}

function awardProgress(db, userId, gameId, won, aiGame, ranked, opponentNames, playedAt) {
  const alreadyRecorded = db.prepare('SELECT 1 AS found FROM user_match_history WHERE user_id=? AND game_id=?').get(userId, gameId);
  if (alreadyRecorded) return { duplicate: true, xpEarned: 0 };
  db.prepare('INSERT OR IGNORE INTO player_progress(user_id,updated) VALUES(?,?)').run(userId, playedAt);
  const progress = db.prepare('SELECT * FROM player_progress WHERE user_id=?').get(userId);
  const matchXp = aiGame ? (won ? 15 : 5) : (won ? 30 : 15);
  const totalGames = progress.total_games + 1;
  const totalWins = progress.total_wins + (won ? 1 : 0);
  const streak = won ? progress.current_streak + 1 : 0;
  const bestStreak = Math.max(progress.best_streak, streak);
  let earned = matchXp;
  db.prepare(`UPDATE player_progress SET xp=xp+?,total_games=?,total_wins=?,current_streak=?,best_streak=?,updated=? WHERE user_id=?`)
    .run(matchXp, totalGames, totalWins, streak, bestStreak, playedAt, userId);

  const dayKey = new Date(playedAt).toISOString().slice(0, 10);
  for (const challenge of DAILY_CHALLENGES) {
    db.prepare('INSERT OR IGNORE INTO user_daily_challenges(user_id,day_key,challenge_id,progress) VALUES(?,?,?,0)')
      .run(userId, dayKey, challenge.id);
    const row = db.prepare('SELECT progress,completed_at FROM user_daily_challenges WHERE user_id=? AND day_key=? AND challenge_id=?')
      .get(userId, dayKey, challenge.id);
    const applies = challenge.kind === 'play' || (challenge.kind === 'win' && won) || (challenge.kind === 'ai' && aiGame);
    if (!applies || row.completed_at) continue;
    const next = Math.min(challenge.goal, row.progress + 1);
    const completedAt = next >= challenge.goal ? playedAt : null;
    db.prepare('UPDATE user_daily_challenges SET progress=?,completed_at=? WHERE user_id=? AND day_key=? AND challenge_id=?')
      .run(next, completedAt, userId, dayKey, challenge.id);
    if (completedAt) {
      earned += challenge.reward;
      db.prepare('UPDATE player_progress SET xp=xp+?,updated=? WHERE user_id=?').run(challenge.reward, playedAt, userId);
    }
  }

  const unlocked = [];
  const checks = [
    ['first_game', totalGames >= 1], ['first_win', totalWins >= 1],
    ['games_10', totalGames >= 10], ['wins_10', totalWins >= 10],
    ['streak_3', bestStreak >= 3], ['ai_win', aiGame && won],
  ];
  for (const [achievementId, qualifies] of checks) {
    if (!qualifies) continue;
    const achievement = db.prepare('SELECT xp_reward,title,description,icon FROM achievements WHERE id=?').get(achievementId);
    const inserted = db.prepare('INSERT OR IGNORE INTO user_achievements(user_id,achievement_id,unlocked_at) VALUES(?,?,?)')
      .run(userId, achievementId, playedAt);
    if (Number(inserted.changes) > 0) {
      earned += achievement.xp_reward;
      db.prepare('UPDATE player_progress SET xp=xp+?,updated=? WHERE user_id=?').run(achievement.xp_reward, playedAt, userId);
      unlocked.push({ id: achievementId, title: achievement.title, description: achievement.description, icon: achievement.icon, xpReward: achievement.xp_reward });
    }
  }

  const xp = db.prepare('SELECT xp FROM player_progress WHERE user_id=?').get(userId).xp;
  const level = xpLevel(xp).level;
  db.prepare('UPDATE player_progress SET level=? WHERE user_id=?').run(level, userId);
  db.prepare(`INSERT OR IGNORE INTO user_match_history(user_id,game_id,played_at,result,opponents,ranked,ai_game,xp_earned)
    VALUES(?,?,?,?,?,?,?,?)`).run(userId, gameId, playedAt, won ? 'win' : 'loss', JSON.stringify(opponentNames), ranked ? 1 : 0, aiGame ? 1 : 0, earned);
  return { xpEarned: earned, totalXp: xp, level, unlocked };
}

function getProgression(db, userId, now = Date.now()) {
  db.prepare('INSERT OR IGNORE INTO player_progress(user_id,updated) VALUES(?,?)').run(userId, now);
  const progress = db.prepare('SELECT * FROM player_progress WHERE user_id=?').get(userId);
  const level = xpLevel(progress.xp);
  const achievements = db.prepare(`SELECT a.id,a.title,a.description,a.icon,a.xp_reward AS xpReward,ua.unlocked_at AS unlockedAt
    FROM achievements a LEFT JOIN user_achievements ua ON ua.achievement_id=a.id AND ua.user_id=? ORDER BY a.rowid`).all(userId);
  const dayKey = new Date(now).toISOString().slice(0, 10);
  const dailyChallenges = DAILY_CHALLENGES.map(c => {
    const row = db.prepare('SELECT progress,completed_at FROM user_daily_challenges WHERE user_id=? AND day_key=? AND challenge_id=?')
      .get(userId, dayKey, c.id);
    return { id: c.id, title: c.title, description: c.description, goal: c.goal, reward: c.reward,
      progress: row?.progress || 0, completed: !!row?.completed_at };
  });
  const history = db.prepare(`SELECT h.game_id AS gameId,h.played_at AS playedAt,h.result,h.opponents,h.ranked,h.ai_game AS aiGame,h.xp_earned AS xpEarned
    FROM user_match_history h WHERE h.user_id=? ORDER BY h.played_at DESC,h.id DESC LIMIT 20`).all(userId)
    .map(row => ({ ...row, opponents: JSON.parse(row.opponents), ranked: !!row.ranked, aiGame: !!row.aiGame }));
  return {
    progress: { xp: progress.xp, level: level.level, xpIntoLevel: level.xpIntoLevel, xpForNextLevel: level.xpForNextLevel,
      totalGames: progress.total_games, totalWins: progress.total_wins, currentStreak: progress.current_streak, bestStreak: progress.best_streak },
    achievements, dailyChallenges, history,
  };
}

module.exports = { ACHIEVEMENTS, DAILY_CHALLENGES, xpLevel, initialize, awardProgress, getProgression };
