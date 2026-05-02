const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * Все запросы к БД только через подготовленные выражения (.prepare().run/get/all).
 * Пользовательский текст передаётся только как bound-параметры — конкатенация в SQL не используется.
 */

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'bot.sqlite');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    allow_custom_answer INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS question_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL,
    option_id INTEGER,
    custom_text TEXT,
    user_id INTEGER NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    answered_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
    FOREIGN KEY (option_id) REFERENCES question_options(id) ON DELETE SET NULL,
    UNIQUE(question_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_responses_question ON responses(question_id);
  CREATE INDEX IF NOT EXISTS idx_options_question ON question_options(question_id);

  CREATE TABLE IF NOT EXISTS survey_completed (
    user_id INTEGER PRIMARY KEY,
    completed_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_revision INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS survey_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0
  );
`);

function migrateLegacySchema() {
  const qCols = db.prepare('PRAGMA table_info(questions)').all();
  if (!qCols.some((c) => c.name === 'allow_custom_answer')) {
    db.exec(
      'ALTER TABLE questions ADD COLUMN allow_custom_answer INTEGER NOT NULL DEFAULT 0'
    );
  }

  const rCols = db.prepare('PRAGMA table_info(responses)').all();
  if (rCols.length === 0) return;

  const optCol = rCols.find((c) => c.name === 'option_id');
  const hasCustomCol = rCols.some((c) => c.name === 'custom_text');
  const needsRebuild =
    !hasCustomCol || (optCol && Number(optCol.notnull) === 1);

  if (!needsRebuild) return;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
      CREATE TABLE responses_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question_id INTEGER NOT NULL,
        option_id INTEGER,
        custom_text TEXT,
        user_id INTEGER NOT NULL,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        answered_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
        FOREIGN KEY (option_id) REFERENCES question_options(id) ON DELETE SET NULL,
        UNIQUE(question_id, user_id)
      );
    `);

    db.exec(`
      INSERT INTO responses_migrated (
        id, question_id, option_id, custom_text, user_id, username, first_name, last_name, answered_at
      )
      SELECT id, question_id, option_id, NULL, user_id, username, first_name, last_name, answered_at
      FROM responses;
    `);

    db.exec('DROP TABLE responses; ALTER TABLE responses_migrated RENAME TO responses;');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_responses_question ON responses(question_id);'
    );
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

migrateLegacySchema();

function migrateSurveyRevisionSchema() {
  db.prepare(
    'INSERT OR IGNORE INTO survey_state (id, revision) VALUES (1, 0)'
  ).run();

  const cols = db.prepare('PRAGMA table_info(survey_completed)').all();
  if (!cols.some((c) => c.name === 'completed_revision')) {
    db.exec(
      'ALTER TABLE survey_completed ADD COLUMN completed_revision INTEGER NOT NULL DEFAULT 0'
    );
  }
}

migrateSurveyRevisionSchema();

/** У вопросов без вариантов всегда включаем свой текст */
function migrateTextOnlyQuestionsForceCustom() {
  db.exec(`
    UPDATE questions SET allow_custom_answer = 1
    WHERE id NOT IN (SELECT DISTINCT question_id FROM question_options)
  `);
}

migrateTextOnlyQuestionsForceCustom();

function getSurveyRevision() {
  const row = db.prepare('SELECT revision FROM survey_state WHERE id = 1').get();
  return row?.revision ?? 0;
}

function bumpSurveyRevision() {
  db.prepare(
    'UPDATE survey_state SET revision = revision + 1 WHERE id = 1'
  ).run();
}

function listQuestionsDesc() {
  return db
    .prepare(
      'SELECT id, text, allow_custom_answer, created_at FROM questions ORDER BY id DESC'
    )
    .all();
}

/** Порядок прохождения опроса: от старых к новым */
function listSurveyQuestionsAsc() {
  return db
    .prepare(
      `SELECT id, text, allow_custom_answer FROM questions
       ORDER BY id ASC`
    )
    .all();
}

function getQuestion(questionId) {
  return db
    .prepare(
      'SELECT id, text, allow_custom_answer, created_at FROM questions WHERE id = ?'
    )
    .get(questionId);
}

function getOptions(questionId) {
  return db
    .prepare(
      'SELECT id, text, sort_order FROM question_options WHERE question_id = ? ORDER BY sort_order ASC, id ASC'
    )
    .all(questionId);
}

function createQuestion(text, optionTexts, allowCustomAnswer) {
  const texts = Array.isArray(optionTexts) ? optionTexts : [];
  const textOnly = texts.length === 0;
  const allow = textOnly ? 1 : allowCustomAnswer ? 1 : 0;
  const insertQ = db.prepare(
    'INSERT INTO questions (text, allow_custom_answer) VALUES (?, ?)'
  );
  const insertO = db.prepare(
    'INSERT INTO question_options (question_id, text, sort_order) VALUES (?, ?, ?)'
  );

  const tx = db.transaction(() => {
    const info = insertQ.run(text, allow);
    const qid = info.lastInsertRowid;
    texts.forEach((t, i) => insertO.run(qid, t.trim(), i));
    return Number(qid);
  });

  const newId = tx();
  bumpSurveyRevision();
  return newId;
}

function updateQuestionText(questionId, text) {
  db.prepare('UPDATE questions SET text = ? WHERE id = ?').run(text, questionId);
  bumpSurveyRevision();
}

function setAllowCustomAnswer(questionId, allowed) {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM question_options WHERE question_id = ?'
    )
    .get(questionId);
  const noOptions = Number(row?.n) === 0;
  const val = noOptions ? 1 : allowed ? 1 : 0;
  db.prepare('UPDATE questions SET allow_custom_answer = ? WHERE id = ?').run(
    val,
    questionId
  );
  bumpSurveyRevision();
}

function replaceQuestionOptions(questionId, optionTexts) {
  const delAnswers = db.prepare('DELETE FROM responses WHERE question_id = ?');
  const del = db.prepare('DELETE FROM question_options WHERE question_id = ?');
  const ins = db.prepare(
    'INSERT INTO question_options (question_id, text, sort_order) VALUES (?, ?, ?)'
  );

  const tx = db.transaction(() => {
    delAnswers.run(questionId);
    del.run(questionId);
    optionTexts.forEach((t, i) => ins.run(questionId, t.trim(), i));
  });
  tx();
  if (optionTexts.length === 0) {
    db.prepare('UPDATE questions SET allow_custom_answer = 1 WHERE id = ?').run(
      questionId
    );
  }
  bumpSurveyRevision();
}

function deleteQuestion(questionId) {
  db.prepare('DELETE FROM questions WHERE id = ?').run(questionId);
  bumpSurveyRevision();
}

function upsertResponseChoice(questionId, optionId, user) {
  const username = user.username ? String(user.username) : null;
  const firstName = user.first_name ? String(user.first_name) : null;
  const lastName = user.last_name ? String(user.last_name) : null;

  db.prepare(
    `
    INSERT INTO responses (question_id, option_id, custom_text, user_id, username, first_name, last_name)
    VALUES (@question_id, @option_id, NULL, @user_id, @username, @first_name, @last_name)
    ON CONFLICT(question_id, user_id) DO UPDATE SET
      option_id = excluded.option_id,
      custom_text = NULL,
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      answered_at = datetime('now')
    `
  ).run({
    question_id: questionId,
    option_id: optionId,
    user_id: user.id,
    username,
    first_name: firstName,
    last_name: lastName,
  });
}

function upsertResponseCustom(questionId, customText, user) {
  const username = user.username ? String(user.username) : null;
  const firstName = user.first_name ? String(user.first_name) : null;
  const lastName = user.last_name ? String(user.last_name) : null;

  db.prepare(
    `
    INSERT INTO responses (question_id, option_id, custom_text, user_id, username, first_name, last_name)
    VALUES (@question_id, NULL, @custom_text, @user_id, @username, @first_name, @last_name)
    ON CONFLICT(question_id, user_id) DO UPDATE SET
      option_id = NULL,
      custom_text = excluded.custom_text,
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      answered_at = datetime('now')
    `
  ).run({
    question_id: questionId,
    custom_text: customText,
    user_id: user.id,
    username,
    first_name: firstName,
    last_name: lastName,
  });
}

/** Список ответивших по вопросу */
function listResponsesForQuestion(questionId) {
  return db
    .prepare(
      `
    SELECT r.user_id, r.username, r.first_name, r.last_name, r.answered_at,
           o.text AS option_text,
           r.custom_text AS custom_text
    FROM responses r
    LEFT JOIN question_options o ON o.id = r.option_id
    WHERE r.question_id = ?
    ORDER BY r.answered_at ASC
    `
    )
    .all(questionId);
}

function countDistinctRespondents() {
  const row = db.prepare(`SELECT COUNT(DISTINCT user_id) AS c FROM responses`).get();
  return Number(row?.c ?? 0);
}

/** Участники с временем последнего ответа; сортировка новые сверху */
function listRespondentSummariesPaged(page, pageSize) {
  const offset = page * pageSize;
  return db
    .prepare(
      `
      SELECT
        r.user_id AS user_id,
        MAX(r.answered_at) AS last_at,
        (SELECT r2.username FROM responses r2 WHERE r2.user_id = r.user_id ORDER BY r2.answered_at DESC LIMIT 1) AS username,
        (SELECT r2.first_name FROM responses r2 WHERE r2.user_id = r.user_id ORDER BY r2.answered_at DESC LIMIT 1) AS first_name,
        (SELECT r2.last_name FROM responses r2 WHERE r2.user_id = r.user_id ORDER BY r2.answered_at DESC LIMIT 1) AS last_name
      FROM responses r
      GROUP BY r.user_id
      ORDER BY last_at DESC
      LIMIT ? OFFSET ?
      `
    )
    .all(pageSize, offset);
}

/** Все ответы пользователя по вопросам */
function listResponsesForUser(userId) {
  return db
    .prepare(
      `
      SELECT r.question_id,
             q.text AS question_text,
             r.answered_at,
             o.text AS option_text,
             r.custom_text AS custom_text
      FROM responses r
      JOIN questions q ON q.id = r.question_id
      LEFT JOIN question_options o ON o.id = r.option_id
      WHERE r.user_id = ?
      ORDER BY q.id ASC
      `
    )
    .all(userId);
}

/** Профиль для заголовка (последняя запись ответа) */
function getRespondentProfile(userId) {
  return db
    .prepare(
      `
      SELECT username, first_name, last_name, answered_at
      FROM responses
      WHERE user_id = ?
      ORDER BY answered_at DESC
      LIMIT 1
      `
    )
    .get(userId);
}

function hasCompletedSurvey(userId) {
  const rev = getSurveyRevision();
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM survey_completed
       WHERE user_id = ? AND completed_revision = ?`
    )
    .get(userId, rev);
  return Boolean(row);
}

function markSurveyCompleted(userId) {
  const rev = getSurveyRevision();
  db.prepare(
    `INSERT INTO survey_completed (user_id, completed_revision) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       completed_revision = excluded.completed_revision,
       completed_at = datetime('now')`
  ).run(userId, rev);
}

module.exports = {
  db,
  listQuestionsDesc,
  listSurveyQuestionsAsc,
  getQuestion,
  getOptions,
  createQuestion,
  updateQuestionText,
  setAllowCustomAnswer,
  replaceQuestionOptions,
  deleteQuestion,
  upsertResponseChoice,
  upsertResponseCustom,
  listResponsesForQuestion,
  countDistinctRespondents,
  listRespondentSummariesPaged,
  listResponsesForUser,
  getRespondentProfile,
  hasCompletedSurvey,
  markSurveyCompleted,
};
