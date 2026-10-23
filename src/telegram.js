'use strict';

// El token se obtiene del entorno o de telegram-config.local.js, que no se versiona.
let TELEGRAM_BOT_TOKEN = String(process.env.GALAXY_TELEGRAM_BOT_TOKEN || '').trim();
try {
  const localConfig = require('./telegram-config.local');
  TELEGRAM_BOT_TOKEN ||= String(localConfig.TELEGRAM_BOT_TOKEN || '').trim();
} catch {
  // El archivo local es opcional para permitir clonar el proyecto sin credenciales.
}
const API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function callTelegram(method, payload = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('Falta configurar GALAXY_TELEGRAM_BOT_TOKEN o src/telegram-config.local.js');
  }
  const response = await fetch(`${API_BASE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.description || `Telegram devolvio HTTP ${response.status}`);
  }
  return body.result;
}

function normalizeChatId(value) {
  const chatId = String(value || '').trim();
  if (!chatId) return '';
  if (!/^-?\d{5,20}$/.test(chatId)) throw new Error('El chat_id de Telegram no es valido');
  return chatId;
}

async function sendTelegramMessage(chatId, text) {
  const cleanChatId = normalizeChatId(chatId);
  const cleanText = String(text || '').trim();
  if (!cleanChatId || !cleanText) return;
  await callTelegram('sendMessage', {
    chat_id: cleanChatId,
    text: cleanText.slice(0, 4096),
    disable_web_page_preview: true
  });
}

async function getTelegramUpdates(offset) {
  const payload = { timeout: 0, allowed_updates: ['message'] };
  if (Number.isInteger(offset) && offset > 0) payload.offset = offset;
  const updates = await callTelegram('getUpdates', payload);
  return Array.isArray(updates) ? updates : [];
}

module.exports = { normalizeChatId, sendTelegramMessage, getTelegramUpdates };
