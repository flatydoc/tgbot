const http = require('http');

/** Слушаем до загрузки БД/бота, чтобы Railway healthcheck не ловил 503 */
function startHealthServer() {
  const parsed = Number(process.env.PORT);
  const port =
    Number.isFinite(parsed) && parsed > 0 ? parsed : 8080;
  http
    .createServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
    })
    .listen(port, '0.0.0.0', () => {
      console.log(
        `HTTP health http://0.0.0.0:${port} (PORT env=${process.env.PORT ?? 'unset → 8080'})`
      );
    });
}
startHealthServer();

const { Telegraf, session } = require('telegraf');
const { Markup } = require('telegraf');
const config = require('./config');
const db = require('./db');

const MAX_CUSTOM_ANSWER_LEN = 3500;
const MAX_BTN_LABEL = 64;
const TG_MESSAGE_MAX = 4096;
const SURVEY_SUMMARY_HEADER = 'Ваши ответы:\n\n';

/** Безопасное целое для id из callback (защита от мусора в колбэках). */
function safePositiveInt(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return n;
}

function truncateBtn(s, maxLen = MAX_BTN_LABEL) {
  const t = String(s).trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(0, maxLen - 1))}…`;
}

function answerDisplay(r) {
  if (r.custom_text) return r.custom_text;
  if (r.option_text) return r.option_text;
  return '—';
}

function participantLine(r) {
  const bits = [`id ${r.user_id}`];
  if (r.username) bits.push(`@${r.username}`);
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
  if (name) bits.push(name);
  const who = bits.join(' · ');
  return `• ${who}\n  ответ: ${answerDisplay(r)} (${r.answered_at})`;
}

function clearFlow(ctx) {
  ctx.session.flow = null;
  ctx.session.flowQuestionId = null;
  ctx.session.createDraft = {};
}

function clearSurvey(ctx) {
  ctx.session.surveyQueue = null;
  ctx.session.surveyIndex = 0;
  ctx.session.surveyActive = false;
  ctx.session.pendingFreeTextQuestionId = null;
}

function forgetSurveySummarySession(ctx) {
  ctx.session.surveySummaryMessageId = null;
  ctx.session.surveySummaryBody = null;
}

async function clearSurveySummaryMessage(ctx) {
  await tryDeleteMessage(ctx, ctx.session.surveySummaryMessageId);
  forgetSurveySummarySession(ctx);
}

/** После ответа: одно сообщение с вопросами и ответами (без кнопок), дальше редактируется */
async function appendSurveyAnswerBlock(ctx, questionId, answerLabel) {
  const chatId = chatIdFromCtx(ctx);
  const q = db.getQuestion(questionId);
  if (!q || !chatId) return;

  const block = `${q.text}\n→ ${answerLabel}\n\n`;
  const prev = ctx.session.surveySummaryBody;
  const raw = (prev == null ? SURVEY_SUMMARY_HEADER : prev) + block;
  let body = raw.trimEnd();
  if (body.length > TG_MESSAGE_MAX) {
    body = `${body.slice(0, TG_MESSAGE_MAX - 30)}\n… (сообщение обрезано)`;
  }

  if (ctx.session.surveySummaryMessageId == null) {
    const msg = await ctx.telegram.sendMessage(chatId, body);
    ctx.session.surveySummaryMessageId = msg.message_id;
    ctx.session.surveySummaryBody = body;
    return;
  }

  ctx.session.surveySummaryBody = body;
  try {
    await ctx.telegram.editMessageText(
      chatId,
      ctx.session.surveySummaryMessageId,
      undefined,
      body
    );
  } catch (_) {}
}

function clearAdminSurveyConflict(ctx) {
  ctx.session.pendingFreeTextQuestionId = null;
}

function assertCurrentSurveyQuestion(ctx, questionId) {
  const queue = ctx.session.surveyQueue;
  const idx = ctx.session.surveyIndex ?? 0;
  return Boolean(queue && idx < queue.length && queue[idx] === questionId);
}

function chatIdFromCtx(ctx) {
  return ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id ?? ctx.from?.id;
}

async function tryDeleteMessage(ctx, messageId) {
  if (messageId == null) return;
  const chatId = chatIdFromCtx(ctx);
  if (!chatId) return;
  try {
    await ctx.telegram.deleteMessage(chatId, messageId);
  } catch (_) {
    /* сообщение уже удалено или недоступно */
  }
}

async function clearSingletonMenuMessage(ctx) {
  await tryDeleteMessage(ctx, ctx.session.menuMessageId);
  ctx.session.menuMessageId = null;
}

async function clearSurveyPromptMessage(ctx) {
  await tryDeleteMessage(ctx, ctx.session.surveyQuestionMessageId);
  ctx.session.surveyQuestionMessageId = null;
}

async function clearAdminListMessages(ctx) {
  const ids = ctx.session.adminListMessageIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    ctx.session.adminListMessageIds = [];
    return;
  }
  for (const mid of ids) await tryDeleteMessage(ctx, mid);
  ctx.session.adminListMessageIds = [];
}

async function clearStatsReportMessages(ctx) {
  const ids = ctx.session.statsReportMessageIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    ctx.session.statsReportMessageIds = [];
    return;
  }
  for (const mid of ids) await tryDeleteMessage(ctx, mid);
  ctx.session.statsReportMessageIds = [];
}

/** Одно «главное» сообщение пользователя (меню / финал опроса и т.д.) */
async function presentHome(ctx, caption) {
  clearFlow(ctx);
  await clearAdminListMessages(ctx);
  await clearStatsReportMessages(ctx);
  await clearSurveySummaryMessage(ctx);
  await clearSurveyPromptMessage(ctx);
  clearSurvey(ctx);
  await clearSingletonMenuMessage(ctx);

  const id = ctx.from.id;
  let text = caption;
  if (text == null) {
    if (config.isAdmin(id)) text = 'Главное меню администратора.';
    else if (db.hasCompletedSurvey(id)) {
      text = 'Вы уже проходили опрос. Повторное участие недоступно.';
    } else text = 'Главное меню.';
  }
  const msg = await ctx.reply(text, homeKeyboard(id));
  ctx.session.menuMessageId = msg.message_id;
}

/** Одно сообщение с админ-панелью после действий вне списка вопросов */
async function replyAdminPanelSingleton(ctx, caption) {
  await clearSingletonMenuMessage(ctx);
  await clearAdminListMessages(ctx);
  await clearStatsReportMessages(ctx);
  const msg = await ctx.reply(caption, adminMenuKeyboard());
  ctx.session.menuMessageId = msg.message_id;
}

const CB_MAIN_MENU = 'nav:home';

function mainMenuButton() {
  return Markup.button.callback('🏠 Главное меню', CB_MAIN_MENU);
}

function userPollRepeatKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📋 Пройти опрос снова', 'user:polls')],
    [mainMenuButton()],
  ]);
}

/** Участник уже прошёл опрос — без кнопки повторного прохождения */
function surveyDoneKeyboard() {
  return Markup.inlineKeyboard([]);
}

/** Клавиатура «домой»: администратору — панель; участнику — опрос или только завершение */
function homeKeyboard(fromId) {
  if (config.isAdmin(fromId)) return adminMenuKeyboard();
  if (db.hasCompletedSurvey(fromId)) return surveyDoneKeyboard();
  return userPollRepeatKeyboard();
}

function adminMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Новый вопрос', 'admin:create')],
    [Markup.button.callback('📋 Все вопросы', 'admin:list')],
    [Markup.button.callback('📊 Кто как ответил', 'admin:stats')],
    [mainMenuButton()],
  ]);
}

/** textOnlyQuestion — без фиксированных вариантов: только ответ текстом, переключатель «свой ответ» скрыт */
function questionAdminKeyboard(questionId, allowCustom, textOnlyQuestion) {
  const rows = [
    [
      Markup.button.callback('✏️ Текст', `admin:eqt:${questionId}`),
      Markup.button.callback('📎 Варианты', `admin:eqo:${questionId}`),
    ],
  ];
  if (!textOnlyQuestion) {
    const customLabel = allowCustom ? '✏️ Свой ответ: да' : '✏️ Свой ответ: нет';
    rows.push([
      Markup.button.callback(customLabel, `admin:togglecust:${questionId}`),
    ]);
  }
  rows.push([Markup.button.callback('🗑 Удалить', `admin:qdel:${questionId}`)]);
  rows.push([Markup.button.callback('« Назад в меню', CB_MAIN_MENU)]);
  return Markup.inlineKeyboard(rows);
}

function voteKeyboard(questionId, options, allowCustom) {
  const rows = options.map((o) => [
    Markup.button.callback(truncateBtn(o.text, 60), `vote:${questionId}:${o.id}`),
  ]);
  if (allowCustom) {
    rows.push([Markup.button.callback('✏️ Свой ответ', `freevote:${questionId}`)]);
  }
  rows.push([mainMenuButton()]);
  return Markup.inlineKeyboard(rows);
}

async function sendAdminQuestionList(ctx, banner = null) {
  await clearSingletonMenuMessage(ctx);
  await clearAdminListMessages(ctx);
  await clearStatsReportMessages(ctx);

  const questions = db.listQuestionsDesc();
  if (questions.length === 0) {
    const msg = await ctx.reply(
      banner ? `${banner}\n\nВопросов пока нет.` : 'Вопросов пока нет.',
      adminMenuKeyboard()
    );
    ctx.session.menuMessageId = msg.message_id;
    return;
  }

  const introLine =
    banner != null
      ? `${banner}\n\nСписок вопросов (нажмите кнопку у нужного):`
      : 'Список вопросов (нажмите кнопку у нужного):';

  const ids = [];
  const intro = await ctx.reply(introLine);
  ids.push(intro.message_id);

  for (const q of questions) {
    const preview =
      q.text.length > 300 ? `${q.text.slice(0, 297)}…` : q.text;
    const textOnly = db.getOptions(q.id).length === 0;
    const body = textOnly ? `${preview}\n\n📝 Только свой текст` : preview;
    const card = await ctx.reply(
      body,
      questionAdminKeyboard(
        q.id,
        Boolean(Number(q.allow_custom_answer)),
        textOnly
      )
    );
    ids.push(card.message_id);
  }

  ctx.session.adminListMessageIds = ids;
  ctx.session.menuMessageId = null;
}

function buildSurveyQueue() {
  return db
    .listSurveyQuestionsAsc()
    .map((q) => q.id)
    .filter((id) => {
      const n = db.getOptions(id).length;
      return n >= 2 || n === 0;
    });
}

async function sendCurrentSurveyQuestion(ctx) {
  const chatId = chatIdFromCtx(ctx);
  const userId = ctx.from.id;
  const queue = ctx.session.surveyQueue;
  let idx = ctx.session.surveyIndex ?? 0;

  while (queue && idx < queue.length) {
    const qid = queue[idx];
    const q = db.getQuestion(qid);
    const options = db.getOptions(qid);
    if (!q) {
      idx += 1;
      ctx.session.surveyIndex = idx;
      continue;
    }

    if (options.length === 0) {
      if (!Number(q.allow_custom_answer)) {
        idx += 1;
        ctx.session.surveyIndex = idx;
        continue;
      }
      ctx.session.surveyIndex = idx;
      await clearSurveyPromptMessage(ctx);
      ctx.session.pendingFreeTextQuestionId = qid;
      const msg = await ctx.telegram.sendMessage(
        chatId,
        `${q.text}\n\nНапишите ответ одним сообщением.`,
        {
          reply_markup: Markup.inlineKeyboard([[mainMenuButton()]]).reply_markup,
        }
      );
      ctx.session.surveyQuestionMessageId = msg.message_id;
      return;
    }

    if (options.length === 1) {
      idx += 1;
      ctx.session.surveyIndex = idx;
      continue;
    }

    ctx.session.surveyIndex = idx;
    await clearSurveyPromptMessage(ctx);

    const msg = await ctx.telegram.sendMessage(chatId, q.text, {
      reply_markup: voteKeyboard(
        qid,
        options,
        Boolean(Number(q.allow_custom_answer))
      ).reply_markup,
    });
    ctx.session.surveyQuestionMessageId = msg.message_id;
    return;
  }

  await clearSurveyPromptMessage(ctx);
  forgetSurveySummarySession(ctx);
  clearSurvey(ctx);
  db.markSurveyCompleted(userId);
  const msg = await ctx.telegram.sendMessage(
    chatId,
    'Вы успешно прошли опрос. Спасибо!',
    {
      reply_markup: homeKeyboard(userId).reply_markup,
    }
  );
  ctx.session.menuMessageId = msg.message_id;
}

async function beginSurvey(ctx) {
  const userId = ctx.from.id;
  if (config.isAdmin(userId)) {
    await clearSingletonMenuMessage(ctx);
    await clearAdminListMessages(ctx);
    await clearStatsReportMessages(ctx);
    await clearSurveySummaryMessage(ctx);
    clearSurvey(ctx);
    await clearSurveyPromptMessage(ctx);
    const msg = await ctx.reply(
      'Опрос доступен только участникам. Управление вопросами — в админ-панели.',
      adminMenuKeyboard()
    );
    ctx.session.menuMessageId = msg.message_id;
    return;
  }

  await clearSingletonMenuMessage(ctx);
  await clearSurveyPromptMessage(ctx);
  await clearSurveySummaryMessage(ctx);
  clearSurvey(ctx);

  if (db.hasCompletedSurvey(userId)) {
    const msg = await ctx.reply(
      'Вы уже проходили опрос. Повторное участие недоступно.',
      homeKeyboard(userId)
    );
    ctx.session.menuMessageId = msg.message_id;
    return;
  }

  const queue = buildSurveyQueue();
  if (queue.length === 0) {
    const msg = await ctx.reply(
      'Пока нет доступных вопросов.',
      homeKeyboard(userId)
    );
    ctx.session.menuMessageId = msg.message_id;
    return;
  }
  ctx.session.surveyQueue = queue;
  ctx.session.surveyIndex = 0;
  ctx.session.surveyActive = true;
  ctx.session.pendingFreeTextQuestionId = null;
  await sendCurrentSurveyQuestion(ctx);
}

function parseOptionLines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

const bot = new Telegraf(config.botToken);

bot.use(
  session({
    defaultSession: () => ({
      flow: null,
      flowQuestionId: null,
      createDraft: {},
      surveyQueue: null,
      surveyIndex: 0,
      surveyActive: false,
      pendingFreeTextQuestionId: null,
      menuMessageId: null,
      surveyQuestionMessageId: null,
      surveySummaryMessageId: null,
      surveySummaryBody: null,
      adminListMessageIds: [],
      statsReportMessageIds: [],
    }),
  })
);

bot.start(async (ctx) => {
  clearFlow(ctx);

  const id = ctx.from.id;
  if (config.isAdmin(id)) {
    await presentHome(ctx, 'Привет! Вы администратор — панель управления ниже.');
    return;
  }

  await clearAdminListMessages(ctx);
  await clearStatsReportMessages(ctx);
  await clearSurveyPromptMessage(ctx);
  await clearSurveySummaryMessage(ctx);
  await clearSingletonMenuMessage(ctx);
  clearSurvey(ctx);

  if (db.hasCompletedSurvey(id)) {
    await presentHome(ctx, 'Привет! Вы уже проходили опрос. Повторное участие недоступно.');
    return;
  }

  const msg = await ctx.reply('Привет!', userPollRepeatKeyboard());
  ctx.session.menuMessageId = msg.message_id;
  await beginSurvey(ctx);
});

bot.command('cancel', async (ctx) => {
  await presentHome(ctx, 'Отменено.');
});

bot.action(CB_MAIN_MENU, async (ctx) => {
  await ctx.answerCbQuery();
  await presentHome(ctx);
});

bot.action('user:polls', async (ctx) => {
  clearFlow(ctx);
  if (config.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery();
    await replyAdminPanelSingleton(
      ctx,
      'Опрос проходят только участники. Для вас открыта админ-панель:'
    );
    return;
  }
  if (db.hasCompletedSurvey(ctx.from.id)) {
    await ctx.answerCbQuery({
      text: 'Вы уже проходили опрос. Повторное прохождение недоступно.',
      show_alert: true,
    });
    return;
  }
  await ctx.answerCbQuery();
  await beginSurvey(ctx);
});

bot.action('admin:menu', async (ctx) => {
  await ctx.answerCbQuery();
  if (!config.isAdmin(ctx.from.id)) {
    await ctx.reply('Нет доступа.');
    return;
  }
  clearAdminSurveyConflict(ctx);
  await presentHome(ctx, 'Админ-панель:');
});

bot.action('admin:create', async (ctx) => {
  await ctx.answerCbQuery();
  if (!config.isAdmin(ctx.from.id)) return;

  clearAdminSurveyConflict(ctx);
  await clearSingletonMenuMessage(ctx);
  await clearAdminListMessages(ctx);
  await clearStatsReportMessages(ctx);
  ctx.session.flow = 'create_q_text';
  ctx.session.createDraft = {};
  await ctx.reply('Введите текст нового вопроса.\n\nОтмена: /cancel');
});

bot.action('admin:list', async (ctx) => {
  await ctx.answerCbQuery();
  if (!config.isAdmin(ctx.from.id)) return;

  clearAdminSurveyConflict(ctx);
  await sendAdminQuestionList(ctx);
});

bot.action('admin:stats', async (ctx) => {
  await ctx.answerCbQuery();
  if (!config.isAdmin(ctx.from.id)) return;

  clearAdminSurveyConflict(ctx);
  await clearSingletonMenuMessage(ctx);
  await clearAdminListMessages(ctx);
  await clearStatsReportMessages(ctx);

  const questions = db.listQuestionsDesc();
  if (questions.length === 0) {
    await replyAdminPanelSingleton(ctx, 'Нет вопросов.');
    return;
  }

  const rows = questions.map((q) => [
    Markup.button.callback(truncateBtn(q.text), `admin:statq:${q.id}`),
  ]);
  rows.push([mainMenuButton()]);
  const msg = await ctx.reply(
    'Выберите вопрос, чтобы увидеть ответы пользователей:',
    Markup.inlineKeyboard(rows)
  );
  ctx.session.menuMessageId = msg.message_id;
});

bot.action(/^admin:statq:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!config.isAdmin(ctx.from.id)) return;

  const qid = safePositiveInt(ctx.match[1]);
  if (qid == null) return;

  const q = db.getQuestion(qid);
  if (!q) {
    await ctx.reply('Вопрос не найден.');
    return;
  }

  await clearSingletonMenuMessage(ctx);
  await clearStatsReportMessages(ctx);

  const list = db.listResponsesForQuestion(qid);
  const header = `Вопрос:\n${q.text}\n\nОтветило человек: ${list.length}\n`;

  if (list.length === 0) {
    const msg = await ctx.reply(`${header}\nПока никто не ответил.`, adminMenuKeyboard());
    ctx.session.menuMessageId = msg.message_id;
    ctx.session.statsReportMessageIds = [];
    return;
  }

  const chunks = [];
  let buf = header;
  for (const r of list) {
    const line = `${participantLine(r)}\n\n`;
    if (buf.length + line.length > 3500) {
      chunks.push(buf);
      buf = line;
    } else {
      buf += line;
    }
  }
  chunks.push(buf);

  const reportIds = [];
  for (let i = 0; i < chunks.length; i++) {
    const msg = await ctx.reply(
      chunks[i],
      i === chunks.length - 1 ? adminMenuKeyboard() : undefined
    );
    reportIds.push(msg.message_id);
  }
  ctx.session.statsReportMessageIds = reportIds;
  ctx.session.menuMessageId = reportIds[reportIds.length - 1];
});

bot.action(/^admin:togglecust:(\d+)$/, async (ctx) => {
  if (!config.isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery();
    return;
  }

  const qid = safePositiveInt(ctx.match[1]);
  if (qid == null) {
    await ctx.answerCbQuery();
    return;
  }

  const q = db.getQuestion(qid);
  if (!q) {
    await ctx.answerCbQuery();
    return;
  }

  const textOnly = db.getOptions(qid).length === 0;
  if (textOnly) {
    await ctx.answerCbQuery({
      text: 'Без вариантов ответ только текстом — выключить нельзя.',
      show_alert: true,
    });
    return;
  }

  const next = !Boolean(Number(q.allow_custom_answer));
  db.setAllowCustomAnswer(qid, next);
  const updated = db.getQuestion(qid);

  await ctx.answerCbQuery({
    text: next ? 'Свой ответ включён' : 'Свой ответ выключен',
  });

  const chatId = ctx.callbackQuery.message.chat.id;
  const mid = ctx.callbackQuery.message.message_id;
  try {
    await ctx.telegram.editMessageReplyMarkup(
      chatId,
      mid,
      undefined,
      questionAdminKeyboard(
        qid,
        Boolean(Number(updated.allow_custom_answer)),
        false
      ).reply_markup
    );
  } catch (_) {}
});

bot.action(/^admin:cust:([01])$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!config.isAdmin(ctx.from.id)) return;

  const draft = ctx.session.createDraft;
  if (!draft?.text || !Array.isArray(draft.options) || draft.options.length < 2) {
    await ctx.reply('Черновик вопроса устарел. Начните снова: «Новый вопрос».');
    return;
  }

  const allowCustom = ctx.match[1] === '1';
  const id = db.createQuestion(draft.text, draft.options, allowCustom);
  ctx.session.createDraft = {};
  await replyAdminPanelSingleton(ctx, `Вопрос #${id} создан.`);
});

bot.action(/^admin:eqt:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!config.isAdmin(ctx.from.id)) return;

  clearAdminSurveyConflict(ctx);
  await clearSingletonMenuMessage(ctx);
  await clearAdminListMessages(ctx);
  await clearStatsReportMessages(ctx);

  const qid = safePositiveInt(ctx.match[1]);
  if (qid == null) return;

  if (!db.getQuestion(qid)) {
    await ctx.reply('Вопрос не найден.');
    return;
  }

  ctx.session.flow = 'edit_q_text';
  ctx.session.flowQuestionId = qid;
  await ctx.reply('Пришлите новый текст вопроса.\n\nОтмена: /cancel');
});

bot.action(/^admin:eqo:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!config.isAdmin(ctx.from.id)) return;

  clearAdminSurveyConflict(ctx);
  await clearSingletonMenuMessage(ctx);
  await clearAdminListMessages(ctx);
  await clearStatsReportMessages(ctx);

  const qid = safePositiveInt(ctx.match[1]);
  if (qid == null) return;

  if (!db.getQuestion(qid)) {
    await ctx.reply('Вопрос не найден.');
    return;
  }

  ctx.session.flow = 'edit_q_opts';
  ctx.session.flowQuestionId = qid;
  await ctx.reply(
    'Новые варианты — каждый с новой строки (минимум 2).\n\nЧтобы убрать все варианты и оставить только свой текст участника, отправьте одну строку: `-` или «нет».\n\nПосле сохранения ответы по вопросу будут сброшены.\n\nОтмена: /cancel'
  );
});

bot.action(/^admin:qdel:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!config.isAdmin(ctx.from.id)) return;

  const qid = safePositiveInt(ctx.match[1]);
  if (qid == null) return;

  await ctx.reply(
    'Подтвердите удаление вопроса и всех ответов пользователей:',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Да, удалить', `admin:qdely:${qid}`),
        Markup.button.callback('Отмена', 'admin:list'),
      ],
      [mainMenuButton()],
    ])
  );
});

bot.action(/^admin:qdely:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!config.isAdmin(ctx.from.id)) return;

  const qid = safePositiveInt(ctx.match[1]);
  if (qid == null) return;

  db.deleteQuestion(qid);
  await sendAdminQuestionList(ctx, 'Вопрос удалён.');
});

bot.action(/^freevote:(\d+)$/, async (ctx) => {
  const qid = safePositiveInt(ctx.match[1]);
  if (qid == null) {
    await ctx.answerCbQuery();
    return;
  }

  if (!assertCurrentSurveyQuestion(ctx, qid)) {
    await ctx.answerCbQuery({
      text: 'Ответьте на текущий вопрос из последнего сообщения бота.',
    });
    return;
  }

  const q = db.getQuestion(qid);
  if (!q || !Number(q.allow_custom_answer)) {
    await ctx.answerCbQuery({ text: 'Для этого вопроса свой ответ недоступен.' });
    return;
  }

  await ctx.answerCbQuery();
  ctx.session.pendingFreeTextQuestionId = qid;
  await clearSurveyPromptMessage(ctx);

  const prompt = await ctx.reply(
    'Напишите ваш ответ одним сообщением.',
    Markup.inlineKeyboard([[mainMenuButton()]])
  );
  ctx.session.surveyQuestionMessageId = prompt.message_id;
});

bot.action(/^vote:(\d+):(\d+)$/, async (ctx) => {
  const questionId = safePositiveInt(ctx.match[1]);
  const optionId = safePositiveInt(ctx.match[2]);
  if (questionId == null || optionId == null) {
    await ctx.answerCbQuery();
    return;
  }

  if (!assertCurrentSurveyQuestion(ctx, questionId)) {
    await ctx.answerCbQuery({
      text: 'Ответьте на текущий вопрос из последнего сообщения бота.',
    });
    return;
  }

  const q = db.getQuestion(questionId);
  const options = db.getOptions(questionId);
  const opt = options.find((o) => o.id === optionId);
  if (!q || !opt) {
    await ctx.answerCbQuery({ text: 'Этот вариант больше недоступен.' });
    return;
  }

  await ctx.answerCbQuery();

  db.upsertResponseChoice(questionId, optionId, ctx.from);
  ctx.session.pendingFreeTextQuestionId = null;

  await appendSurveyAnswerBlock(ctx, questionId, opt.text);

  const idx = ctx.session.surveyIndex ?? 0;
  ctx.session.surveyIndex = idx + 1;
  await sendCurrentSurveyQuestion(ctx);
});

bot.on('text', async (ctx, next) => {
  const text = ctx.message.text;
  const flow = ctx.session.flow;

  const adminTextFlows = ['create_q_text', 'create_q_opts', 'edit_q_text', 'edit_q_opts'];
  const adminTypingSurveyBlocked =
    flow &&
    config.isAdmin(ctx.from.id) &&
    adminTextFlows.includes(flow);

  const pendingQid = ctx.session.pendingFreeTextQuestionId;
  if (pendingQid != null && !adminTypingSurveyBlocked) {
    const queue = ctx.session.surveyQueue;
    const idx = ctx.session.surveyIndex ?? 0;
    if (!queue || idx >= queue.length || queue[idx] !== pendingQid) {
      ctx.session.pendingFreeTextQuestionId = null;
      return next();
    }

    const q = db.getQuestion(pendingQid);
    if (!q || !Number(q.allow_custom_answer)) {
      ctx.session.pendingFreeTextQuestionId = null;
      return next();
    }

    const trimmed = String(text).trim();
    if (!trimmed) {
      await ctx.reply('Ответ не может быть пустым. Напишите текст.');
      return;
    }

    const answerText = trimmed.slice(0, MAX_CUSTOM_ANSWER_LEN);
    db.upsertResponseCustom(pendingQid, answerText, ctx.from);
    ctx.session.pendingFreeTextQuestionId = null;

    await appendSurveyAnswerBlock(ctx, pendingQid, answerText);

    ctx.session.surveyIndex = idx + 1;
    await sendCurrentSurveyQuestion(ctx);
    return;
  }

  if (!flow) return next();

  if (!config.isAdmin(ctx.from.id)) {
    clearFlow(ctx);
    return next();
  }

  if (flow === 'create_q_text') {
    ctx.session.createDraft.text = text;
    ctx.session.flow = 'create_q_opts';
    await ctx.reply(
      'Варианты ответов — каждый с новой строки (минимум 2).\n\nЕсли вариантов быть не должно (только свой текст участника), отправьте одну строку: `-` или «нет».\n\nОтмена: /cancel'
    );
    return;
  }

  if (flow === 'create_q_opts') {
    const qtext = ctx.session.createDraft.text;
    const opts = parseOptionLines(text);
    const textOnlyInput =
      opts.length === 1 &&
      (opts[0] === '-' || opts[0].toLowerCase() === 'нет');

    if (textOnlyInput) {
      const id = db.createQuestion(qtext, [], true);
      clearFlow(ctx);
      ctx.session.createDraft = {};
      await replyAdminPanelSingleton(ctx, `Вопрос #${id} создан (только ответ текстом).`);
      return;
    }

    if (opts.length < 2) {
      await ctx.reply(
        'Нужно минимум два варианта (каждый с новой строки) или одна строка `-` / «нет» для вопроса только со своим текстом.\n\nОтмена: /cancel'
      );
      return;
    }
    ctx.session.createDraft.options = opts;
    ctx.session.flow = null;
    await ctx.reply(
      'Разрешить пользователям вводить свой ответ помимо кнопок?',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('Да', 'admin:cust:1'),
          Markup.button.callback('Нет', 'admin:cust:0'),
        ],
        [mainMenuButton()],
      ])
    );
    return;
  }

  if (flow === 'edit_q_text') {
    const qid = ctx.session.flowQuestionId;
    db.updateQuestionText(qid, text);
    clearFlow(ctx);
    await sendAdminQuestionList(ctx, 'Текст вопроса обновлён.');
    return;
  }

  if (flow === 'edit_q_opts') {
    const qid = ctx.session.flowQuestionId;
    const opts = parseOptionLines(text);
    const textOnlyInput =
      opts.length === 1 &&
      (opts[0] === '-' || opts[0].toLowerCase() === 'нет');

    if (textOnlyInput) {
      db.replaceQuestionOptions(qid, []);
      clearFlow(ctx);
      await sendAdminQuestionList(
        ctx,
        'Варианты убраны: только ответ текстом (отключить нельзя). Сохранённые ответы пользователей удалены.'
      );
      return;
    }

    if (opts.length < 2) {
      await ctx.reply(
        'Нужно минимум два варианта или одна строка `-` / «нет» для режима только своего текста. Попробуйте ещё раз.'
      );
      return;
    }
    db.replaceQuestionOptions(qid, opts);
    clearFlow(ctx);
    await sendAdminQuestionList(
      ctx,
      'Варианты ответов обновлены. Ранее сохранённые ответы по этому вопросу удалены.'
    );
    return;
  }

  return next();
});

bot.catch((err, ctx) => {
  console.error('Ошибка бота:', err);
  if (ctx?.reply) ctx.reply('Произошла ошибка. Попробуйте /start').catch(() => {});
});

bot
  .launch()
  .then(() => {
    console.log('Бот запущен');
  })
  .catch((err) => {
    console.error('Не удалось запустить Telegram-бота (проверьте BOT_TOKEN):', err);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
