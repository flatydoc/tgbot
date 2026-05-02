require('dotenv').config();

const raw = process.env.ADMIN_IDS || '';
const adminIds = raw
  .split(',')
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n));

if (!process.env.BOT_TOKEN) {
  console.error('Задайте BOT_TOKEN в .env');
  process.exit(1);
}

if (adminIds.length === 0) {
  console.warn(
    'ADMIN_IDS пуст — ни у кого не будет прав администратора. Укажите id через запятую в .env'
  );
}

function isAdmin(userId) {
  return adminIds.includes(userId);
}

module.exports = {
  botToken: process.env.BOT_TOKEN,
  adminIds,
  isAdmin,
};
