'use strict';

const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { GalaxyClient } = require('./src/galaxy-client');
const { createAccount, getInventoryOf, sendGifts, setSidecarConfig } = require('./src/galaxy-http');
const {
  normalizeGroupCode,
  syncFirebaseAllies,
  setFirebaseAllyClassification,
  syncFirebaseTelegram,
  queueFirebaseTelegramCommand
} = require('./src/firebase-allies');
const { getTelegramUpdates, normalizeChatId, sendTelegramMessage } = require('./src/telegram');
const {
  RING_ORDER,
  RINGS,
  SPIKE_ACTIONS,
  createDefaultSettings,
  normalizeSettings,
  RingtossBot
} = require('./src/ringtoss-bot');

// BlueStacks necesita la GPU integrada para el juego. Esta interfaz puede
// renderizarse por software, liberando esa GPU para el emulador.
app.disableHardwareAcceleration();

const GIFT_ITEM_IDS = ['1', '4', '5', '8', '9', '10', '12', '13', '22'];
const AUTO_INVENTORY_GIFT_EXCLUDED_IDS = ['14', '15', '16', '22', '23'];
const AUTO_INVENTORY_GIFT_INTERVAL_MS = 60 * 60 * 1000;
const SIDECAR_PORT = 8791;
const DEFAULT_SHARED_ALLIES_GROUP_CODE = '4dde745d-60e0-49da-ac94-d63111bc1b6d';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let DATA_DIR;
let SETTINGS_FILE;

let win = null;
let appSettings = null;
let sidecarProcess = null;
let sidecarReady = Promise.resolve();
const runtimes = new Map();
let sharedAlliesTimer = null;
let sharedAlliesSyncing = false;
let sharedAlliesLastSyncAt = null;
let sharedAlliesLastError = null;
let sharedAlliesCache = [];
let telegramTimer = null;
let telegramSyncing = false;
let telegramLastSyncAt = null;
let telegramLastError = null;
let telegramRecipients = [];
let telegramCommands = [];
const recentPublicTelegramMessages = new Set();

function makeAccountId() {
  return `acc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function createAccountRecord(input = {}, index = 0) {
  const settingsInput = input.settings || input;
  return {
    id: typeof input.id === 'string' && input.id ? input.id : makeAccountId(),
    label: typeof input.label === 'string' && input.label.trim()
      ? input.label.trim()
      : `Cuenta ${index + 1}`,
    // Guardamos permanentemente el userId en la tarjeta de la cuenta si ya se conoce
    userId: typeof input.userId === 'string' && input.userId.trim() ? input.userId.trim() : null,
    settings: normalizeSettings(settingsInput)
  };
}

function normalizeOwnAccounts(raw) {
  if (!Array.isArray(raw)) return [];
  const byId = new Map();
  for (const entry of raw) {
    const userId = typeof entry?.userId === 'string' ? entry.userId.trim() : '';
    if (!userId) continue;
    const nickname = typeof entry?.nickname === 'string' ? entry.nickname.trim() : '';
    byId.set(userId, { userId, nickname });
  }
  return [...byId.values()];
}

const DEFAULT_SUPPLIER_ITEMS = [
  { itemId: '15', threshold: 10, sendAmount: 25 },
  { itemId: '16', threshold: 10, sendAmount: 25 },
  { itemId: '17', threshold: 3, sendAmount: 5 }
];

function normalizeVisualEffects(raw) {
  return {
    particlesEnabled: raw?.particlesEnabled !== false
  };
}

function normalizeSupplierSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  let items = [];

  // Si ya cuenta con el formato nuevo de múltiples ítems
  if (Array.isArray(src.items)) {
    items = src.items.map((item) => {
      const itemId = typeof item?.itemId === 'string' ? item.itemId.trim() : String(item?.itemId || '').trim();
      const threshold = Number.isFinite(Number(item?.threshold)) && Number(item?.threshold) >= 0
        ? Math.floor(Number(item.threshold))
        : 5;
      const sendAmount = Number.isFinite(Number(item?.sendAmount)) && Number(item?.sendAmount) > 0
        ? Math.floor(Number(item.sendAmount))
        : 10;
      return { itemId, threshold, sendAmount };
    }); // <--- AQUÍ: Eliminamos el .filter(item => item.itemId) para permitir filas vacías
  }

  // Compatibilidad hacia atrás: si tiene el formato antiguo de itemIds planos, lo migramos automáticamente
  if (items.length === 0) {
    if (Array.isArray(src.itemIds)) {
      const legacyThreshold = Number.isFinite(Number(src.threshold)) ? Math.floor(src.threshold) : 5;
      const legacySendAmount = Number.isFinite(Number(src.sendAmount)) ? Math.floor(src.sendAmount) : 10;
      items = src.itemIds.map(id => ({
        itemId: String(id).trim(),
        threshold: legacyThreshold,
        sendAmount: legacySendAmount
      })).filter(item => item.itemId);
    } else {
      items = DEFAULT_SUPPLIER_ITEMS;
    }
  }

  const intervalMinutes = Number.isFinite(Number(src.intervalMinutes)) && Number(src.intervalMinutes) > 0
    ? Math.floor(Number(src.intervalMinutes))
    : 10;

  return {
    enabled: Boolean(src.enabled),
    supplierAccountId: typeof src.supplierAccountId === 'string' ? src.supplierAccountId : null,
    items,
    intervalMinutes
  };
}

function normalizeSharedAlliesSettings(raw) {
  try {
    const hasSavedCode = raw && Object.prototype.hasOwnProperty.call(raw, 'groupCode');
    return { groupCode: normalizeGroupCode(hasSavedCode ? raw.groupCode : DEFAULT_SHARED_ALLIES_GROUP_CODE) };
  } catch {
    return { groupCode: '' };
  }
}

function normalizeTelegramNickname(value) {
  return String(value || '').trim().replace(/^@/, '').slice(0, 80);
}

function normalizeTelegramBans(raw) {
  if (!Array.isArray(raw)) return [];
  const byNickname = new Map();
  for (const value of raw) {
    const nickname = normalizeTelegramNickname(value);
    if (nickname) byNickname.set(nickname.toLocaleLowerCase(), nickname);
  }
  return [...byNickname.values()];
}

function normalizeTelegramExternalAccountId(value) {
  const id = String(value || '').trim();
  return /^\d{6,10}$/.test(id) ? id : '';
}

function normalizeTelegramSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  let chatId = '';
  try {
    chatId = normalizeChatId(src.chatId);
  } catch {
    chatId = '';
  }
  return {
    chatId,
    externalAccountId: normalizeTelegramExternalAccountId(src.externalAccountId),
    lastUpdateId: Number.isInteger(src.lastUpdateId) && src.lastUpdateId > 0 ? src.lastUpdateId : 0,
    processedCommandIds: Array.isArray(src.processedCommandIds)
      ? src.processedCommandIds.map(String).slice(-200)
      : [],
    bannedNicknames: normalizeTelegramBans(src.bannedNicknames)
  };
}

function createDefaultAppSettings() {
  const account = createAccountRecord({ label: 'Cuenta 1', settings: createDefaultSettings() }, 0);
  return {
    logMode: 'debug',
    activeLogAccountId: account.id,
    accounts: [account],
    ownAccounts: [],
    visualEffects: normalizeVisualEffects(),
    supplier: normalizeSupplierSettings(),
    sharedAllies: normalizeSharedAlliesSettings(),
    telegram: normalizeTelegramSettings()
  };
}

function normalizeAppSettings(raw) {
  if (!raw || typeof raw !== 'object') return createDefaultAppSettings();

  if (Array.isArray(raw.accounts)) {
    const accounts = raw.accounts.map((account, index) => createAccountRecord(account, index));
    if (accounts.length === 0) accounts.push(createAccountRecord({ label: 'Cuenta 1' }, 0));
    const activeLogAccountId = accounts.some((account) => account.id === raw.activeLogAccountId)
      ? raw.activeLogAccountId
      : accounts[0].id;
    return {
      logMode: raw.logMode === 'chat' ? 'chat' : 'debug',
      activeLogAccountId,
      accounts,
      ownAccounts: normalizeOwnAccounts(raw.ownAccounts),
      visualEffects: normalizeVisualEffects(raw.visualEffects),
      supplier: normalizeSupplierSettings(raw.supplier),
      sharedAllies: normalizeSharedAlliesSettings(raw.sharedAllies),
      telegram: normalizeTelegramSettings(raw.telegram)
    };
  }

  const migrated = createAccountRecord({ label: 'Cuenta 1', settings: raw }, 0);
  return {
    logMode: 'debug',
    activeLogAccountId: migrated.id,
    accounts: [migrated],
    ownAccounts: [],
    visualEffects: normalizeVisualEffects(raw.visualEffects),
    supplier: normalizeSupplierSettings(),
    sharedAllies: normalizeSharedAlliesSettings(raw.sharedAllies),
    telegram: normalizeTelegramSettings(raw.telegram)
  };
}

function loadAppSettings() {
  try {
    return normalizeAppSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch {
    return createDefaultAppSettings();
  }
}

function saveAppSettings() {
  try {
    if (fs.existsSync(DATA_DIR)) {
      const stat = fs.statSync(DATA_DIR);
      if (!stat.isDirectory()) {
        throw new Error('data existe pero no es un directorio');
      }
    } else {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(appSettings, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error('[SAVE ERROR]', err.message);
    throw err;
  }
}

function getAccount(accountId) {
  return appSettings.accounts.find((account) => account.id === accountId);
}

// Registro persistente (a nivel app, no por cuenta) de "estos son los
// userId de mis propias cuentas". Se va llenando solo, cada vez que una
// cuenta hace login por primera vez, y sobrevive a reinicios via
// settings.json. Es la base para que una cuenta nueva se marque como
// aliada de todas las demas (y de si misma) sin que el usuario la agregue
// a mano en Aliados Globales.
function registerOwnAccount(userId, nickname) {
  if (!userId) return;
  const existing = appSettings.ownAccounts.find((entry) => entry.userId === userId);
  if (existing) {
    if (nickname && existing.nickname !== nickname) {
      existing.nickname = nickname;
      saveAppSettings();
    }
  } else {
    appSettings.ownAccounts.push({ userId, nickname: nickname || '' });
    saveAppSettings();
  }
  propagateOwnAllies();
  syncSharedAllies().catch(() => {});
}

// Le avisa a TODOS los bots activos (incluido el que recien se identifico)
// que todos los userId conocidos de cuentas propias son aliados. Si un bot
// ya tiene a esa persona visible en su roster actual, la reclasifica ya
// mismo; si no, queda marcada en persistedAllies para cuando aparezca.
function propagateOwnAllies() {
  for (const runtime of runtimes.values()) {
    for (const { userId, nickname } of appSettings.ownAccounts) {
      runtime.bot.markKnownAlly(userId, nickname);
    }
  }
}

function propagateSharedAllies() {
  const ownAccountIds = new Set(appSettings.ownAccounts.map(({ userId }) => userId));
  for (const runtime of runtimes.values()) {
    for (const { userId, nickname, side } of sharedAlliesCache) {
      // Las cuentas propias siempre conservan la prioridad de aliado.
      const resolvedSide = ownAccountIds.has(userId) ? 'ally' : side;
      const alreadyAllied = runtime.bot.persistedAllies.has(userId);
      const markedEnemy = runtime.bot.persistedEnemies.has(userId);
      if (resolvedSide === 'ally' && (!alreadyAllied || markedEnemy)) {
        runtime.bot.markKnownAlly(userId, nickname);
      } else if (resolvedSide === 'enemy' && (alreadyAllied || !markedEnemy)) {
        runtime.bot.markKnownEnemy(userId, nickname);
      }
    }
  }
}

async function syncSharedAllies() {
  const groupCode = appSettings?.sharedAllies?.groupCode;
  if (!groupCode || sharedAlliesSyncing) return;

  sharedAlliesSyncing = true;
  sharedAlliesLastError = null;
  emitState();
  try {
    sharedAlliesCache = await syncFirebaseAllies({
      groupCode,
      ownAccounts: appSettings.ownAccounts
    });
    propagateSharedAllies();
    sharedAlliesLastSyncAt = new Date().toISOString();
  } catch (err) {
    sharedAlliesLastError = err.message;
    console.error('[FIREBASE ALLIES]', err.message);
  } finally {
    sharedAlliesSyncing = false;
    emitState();
  }
}

function restartSharedAlliesSync() {
  clearInterval(sharedAlliesTimer);
  sharedAlliesTimer = null;
  if (!appSettings?.sharedAllies?.groupCode) return;

  syncSharedAllies().catch(() => {});
  sharedAlliesTimer = setInterval(() => syncSharedAllies().catch(() => {}), 60 * 1000);
}

async function setSharedGlobalClassification({ userId, nickname, side }) {
  const groupCode = appSettings?.sharedAllies?.groupCode;
  if (!groupCode) throw new Error('Falta el codigo de aliados compartidos');
  const cleanId = String(userId || '').trim();
  const cleanSide = side === 'enemy' ? 'enemy' : side === 'ally' ? 'ally' : '';
  if (!/^\d{6,10}$/.test(cleanId) || !cleanSide) throw new Error('Persona o columna invalida');
  if (appSettings.ownAccounts.some((account) => account.userId === cleanId) && cleanSide === 'enemy') {
    throw new Error('Una cuenta propia no puede marcarse como enemiga global');
  }

  const person = await setFirebaseAllyClassification({
    groupCode,
    userId: cleanId,
    nickname: String(nickname || '').trim(),
    side: cleanSide
  });
  const existingIndex = sharedAlliesCache.findIndex((entry) => entry.userId === person.userId);
  if (existingIndex === -1) sharedAlliesCache.push(person);
  else sharedAlliesCache[existingIndex] = person;
  propagateSharedAllies();
  sharedAlliesLastSyncAt = new Date().toISOString();
  emitState();
}

function rememberTelegramId(settingKey, id) {
  const current = appSettings.telegram[settingKey];
  if (current.includes(id)) return false;
  appSettings.telegram[settingKey] = [...current, id].slice(-200);
  saveAppSettings();
  return true;
}

function isTelegramSenderBanned(senderName) {
  const nickname = normalizeTelegramNickname(senderName).toLocaleLowerCase();
  return Boolean(nickname && appSettings.telegram.bannedNicknames.some(
    (entry) => entry.toLocaleLowerCase() === nickname
  ));
}

function setTelegramBan(nickname, banned) {
  const cleanNickname = normalizeTelegramNickname(nickname);
  if (!cleanNickname) throw new Error('Falta el nickname');
  const key = cleanNickname.toLocaleLowerCase();
  const current = appSettings.telegram.bannedNicknames;
  const exists = current.some((entry) => entry.toLocaleLowerCase() === key);
  if (banned && !exists) {
    appSettings.telegram.bannedNicknames = [...current, cleanNickname];
  } else if (!banned && exists) {
    appSettings.telegram.bannedNicknames = current.filter((entry) => entry.toLocaleLowerCase() !== key);
  }
  saveAppSettings();
  return { nickname: cleanNickname, changed: banned ? !exists : exists };
}

function telegramMessageForChat(runtime, chat) {
  const nickname = runtime.client.nickname || runtime.bot.nickname || runtime.account.label;
  if (chat.isExternalTarget) {
    return `Mensaje privado para ID ${chat.targetId} (recibido en ${nickname})\n${chat.senderName}: ${chat.text}`;
  }
  if (chat.isPublic) return `Chat público en ${nickname}\n${chat.senderName}: ${chat.text}`;
  return `Mensaje privado en ${nickname}\n${chat.senderName}: ${chat.text}`;
}

function shouldNotifyTelegram(chat) {
  const senderNickname = normalizeTelegramNickname(chat.senderName).toLocaleLowerCase();
  if (senderNickname.startsWith('user')) return false;
  if (isTelegramSenderBanned(chat.senderName)) return false;
  if (!chat.isPublic) return true;
  const normalized = String(chat.text || '').toLocaleLowerCase('ru-RU');
  if (normalized.includes('меняю') || normalized.includes('ищу')) return false;

  // Algunos anuncios rusos mezclan alfabetos para intentar evadir filtros.
  const lookalikeMap = {
    3: 'з', a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м',
    o: 'о', p: 'р', t: 'т', x: 'х', y: 'у'
  };
  const compact = normalized
    .replace(/[3abcehkmoptxy]/g, (letter) => lookalikeMap[letter])
    .replace(/[^a-zа-яё0-9]/g, '');
  const isKnownSiteSpam = compact.includes('заходитенанашсайт')
    && compact.includes('покупайтевыгодно');
  return !isKnownSiteSpam;
}

function sendTelegramToLocal(text) {
  const chatId = appSettings?.telegram?.chatId;
  if (!chatId) return Promise.resolve();
  return sendTelegramMessage(chatId, text);
}

function recordTelegramError(context, err) {
  telegramLastError = err.message;
  console.error(`[${context}]`, err.message);
  emitState();
}

async function notifyTelegram(runtime, chat) {
  if (!shouldNotifyTelegram(chat)) return;
  const message = telegramMessageForChat(runtime, chat);
  if (!chat.isPublic && !chat.isExternalTarget) {
    await sendTelegramToLocal(message);
    return;
  }

  // Varias cuentas propias pueden recibir el mismo WS. La primera notifica y
  // las demás lo omiten, tanto para chats públicos como para el ID adicional.
  const key = `${chat.senderId}|${chat.targetId}|${chat.text}`;
  if (recentPublicTelegramMessages.has(key)) return;
  recentPublicTelegramMessages.add(key);
  setTimeout(() => recentPublicTelegramMessages.delete(key), 60 * 1000);
  await sendTelegramToLocal(message);
}

function parseTelegramChatCommand(text) {
  const match = String(text || '').trim().match(/^\/chat(?:@\w+)?\s+(\S+)\s+(.+)$/i);
  if (!match) return null;
  const body = match[2].trim();
  const direct = body.match(/^@(\S+)\s+(.+)$/);
  return {
    nickname: match[1],
    recipientNickname: direct ? direct[1] : '',
    text: direct ? direct[2].trim() : body
  };
}

function parseTelegramBanCommand(text) {
  const match = String(text || '').trim().match(/^\/(ban|unban)(?:@\w+)?\s+(\S+)$/i);
  if (!match) return null;
  return { banned: match[1].toLocaleLowerCase() === 'ban', nickname: match[2] };
}

function sendChatFromRuntime(runtime, { recipientId = '0', recipientName = '', text }) {
  const cleanText = String(text || '').trim();
  if (!cleanText) throw new Error('Mensaje vacio');
  if (runtime.client.status !== 'connected') throw new Error('La cuenta no esta conectada');

  const targetId = recipientId ? String(recipientId) : '0';
  const targetName = recipientName ? String(recipientName) : '';
  const isPublic = targetId === '0';
  const body = isPublic ? cleanText : `${targetName}, ${cleanText}`;
  runtime.client.send(`T ${targetId} 1`);
  setTimeout(() => {
    if (runtime.client.status !== 'connected') return;
    runtime.client.send(`PRIVMSG 0 ${targetId} :${body}`);
    const selfName = runtime.client.nickname || runtime.bot.nickname || 'Yo';
    pushRuntimeLog(runtime, `${selfName}: ${body}`, 'chat');
    emitState();
  }, 180);
}

function processTelegramCommands(commands) {
  for (const command of commands) {
    if (appSettings.telegram.processedCommandIds.includes(command.id)) continue;
    const parsed = parseTelegramChatCommand(command.text);
    if (parsed) {
      const targetNickname = parsed.nickname.toLocaleLowerCase();
      const runtime = [...runtimes.values()].find((entry) =>
        (entry.client.nickname || entry.bot.nickname || '').toLocaleLowerCase() === targetNickname
      );
      if (runtime) {
        try {
          let recipient = null;
          if (parsed.recipientNickname) {
            const recipientNickname = parsed.recipientNickname.toLocaleLowerCase();
            recipient = [...runtime.bot.people.values()].find((person) =>
              String(person.name || '').toLocaleLowerCase() === recipientNickname
            );
            if (!recipient) {
              throw new Error(`@${parsed.recipientNickname} no esta visible en este planeta`);
            }
          }
          sendChatFromRuntime(runtime, {
            recipientId: recipient?.id || '0',
            recipientName: recipient?.name || '',
            text: parsed.text
          });
          pushRuntimeLog(runtime, `[Telegram] Chat enviado por comando de ${command.chatId}`, 'debug');
        } catch (err) {
          pushRuntimeLog(runtime, `[Telegram] No se pudo enviar: ${err.message}`, 'debug');
          sendTelegramMessage(command.chatId, `No se pudo enviar desde ${parsed.nickname}: ${err.message}`)
            .catch((sendErr) => recordTelegramError('TELEGRAM', sendErr));
        }
      }
    }
    rememberTelegramId('processedCommandIds', command.id);
  }
}

async function syncTelegram() {
  const groupCode = appSettings?.sharedAllies?.groupCode;
  const chatId = appSettings?.telegram?.chatId;
  if (!groupCode || telegramSyncing) return;

  telegramSyncing = true;
  telegramLastError = null;
  emitState();
  try {
    const synced = await syncFirebaseTelegram({ groupCode, chatId });
    telegramRecipients = synced.recipients;
    telegramCommands = synced.commands;
    processTelegramCommands(telegramCommands);
    telegramLastSyncAt = new Date().toISOString();
  } catch (err) {
    telegramLastError = err.message;
    console.error('[FIREBASE TELEGRAM]', err.message);
  } finally {
    telegramSyncing = false;
    emitState();
  }
}

async function pollTelegramCommands() {
  const ownChatId = appSettings?.telegram?.chatId;
  if (!ownChatId) return;
  try {
    const updates = await getTelegramUpdates(appSettings.telegram.lastUpdateId + 1);
    for (const update of updates) {
      if (Number.isInteger(update?.update_id)) {
        appSettings.telegram.lastUpdateId = Math.max(appSettings.telegram.lastUpdateId, update.update_id);
      }
      const message = update?.message;
      const chatId = String(message?.chat?.id || '');
      const text = String(message?.text || '').trim();
      const authorized = chatId === ownChatId || telegramRecipients.some((entry) => entry.chatId === chatId);
      if (!authorized) continue;

      const banCommand = parseTelegramBanCommand(text);
      if (banCommand) {
        // Los bloqueos son locales: solo los puede cambiar el dueño de esta PC.
        if (chatId === ownChatId) {
          const result = setTelegramBan(banCommand.nickname, banCommand.banned);
          const action = banCommand.banned ? 'silenciado' : 'quitado del silencio';
          const suffix = result.changed ? '' : ' (sin cambios)';
          sendTelegramToLocal(`${result.nickname}: ${action}${suffix}`)
            .catch((err) => recordTelegramError('TELEGRAM', err));
        }
        continue;
      }

      if (!parseTelegramChatCommand(text)) continue;

      const command = { id: String(update.update_id), chatId, text };
      processTelegramCommands([command]);
      const groupCode = appSettings?.sharedAllies?.groupCode;
      if (groupCode) await queueFirebaseTelegramCommand({ groupCode, updateId: update.update_id, chatId, text });
    }
    saveAppSettings();
  } catch (err) {
    telegramLastError = err.message;
    console.error('[TELEGRAM POLL]', err.message);
    emitState();
  }
}

function restartTelegramSync() {
  clearInterval(telegramTimer);
  telegramTimer = null;
  if (!appSettings?.sharedAllies?.groupCode && !appSettings?.telegram?.chatId) return;
  if (appSettings?.sharedAllies?.groupCode) syncTelegram().catch(() => {});
  telegramTimer = setInterval(() => {
    if (appSettings?.sharedAllies?.groupCode) syncTelegram().catch(() => {});
    pollTelegramCommands().catch(() => {});
  }, 5000);
  pollTelegramCommands().catch(() => {});
}

function ensureRuntime(accountId) {
  const account = getAccount(accountId);
  if (!account) throw new Error('Cuenta no encontrada');

  const existing = runtimes.get(accountId);
  if (existing) {
    existing.account = account;
    return existing;
  }

  const runtime = {
    account,
    password: '',
    giftRunning: false,
    wheelRunning: false,
    autoInventoryGiftRunning: false,
    autoInventoryGiftTimer: null,
    registering: false,
    logs: [],
    client: null,
    bot: null
  };

  const accountLog = (message) => {
    pushRuntimeLog(runtime, message, 'debug');
    emitState();
  };

  runtime.client = new GalaxyClient({
    log: accountLog,
    sidecar: { port: SIDECAR_PORT },
    onStatus: emitState,
    onLine: (line) => {
      runtime.bot.handleMessage(line);
      emitState();
    },
    onIdentity: (userId, nickname) => {
      runtime.bot.setIdentity(userId, nickname);
      registerOwnAccount(userId, nickname);
      
      // ENLACE ESTÁTICO: Guardamos el userId directamente en la tarjeta de la cuenta
      const acc = getAccount(accountId);
      if (acc && acc.userId !== userId) {
        acc.userId = userId;
        saveAppSettings();
      }
      emitState();
    }
  });

  runtime.bot = new RingtossBot({
    settings: account.settings,
    send: (message) => runtime.client.send(message),
    log: accountLog,
    stateChanged: emitState,
    isAdditionalChatTarget: (targetId) =>
      normalizeTelegramExternalAccountId(appSettings.telegram.externalAccountId) === String(targetId),
    onPersist: ({ persistedAllies, persistedEnemies }) => {
      account.settings.persistedAllies = persistedAllies;
      account.settings.persistedEnemies = persistedEnemies;
      saveAppSettings();
    },
    onChat: (chat) => {
      pushRuntimeLog(runtime, `${chat.senderName}: ${chat.text}`, 'chat');
      notifyTelegram(runtime, chat).catch((err) => recordTelegramError('TELEGRAM', err));
      emitState();
    }
  });

  runtimes.set(accountId, runtime);
  restartAutoInventoryGiftTimer(runtime);
  propagateOwnAllies();
  propagateSharedAllies();
  return runtime;
}

function getSidecarPath() {
  const exeName = process.platform === 'win32' ? 'galaxy-sidecar.exe' : 'galaxy-sidecar';
  if (app.isPackaged) return path.join(process.resourcesPath, 'go-sidecar', exeName);
  return path.join(__dirname, 'go-sidecar', exeName);
}

function startSidecar() {
  const sidecarPath = getSidecarPath();
  sidecarReady = new Promise((resolve, reject) => {
    if (!fs.existsSync(sidecarPath)) {
      reject(new Error(`No se encontro el sidecar: ${sidecarPath}`));
      return;
    }

    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else {
        // Propagar config del sidecar al modulo HTTP en cuanto este listo,
        // antes de cualquier createAccount() o peticion HTTP en vuelo.
        setSidecarConfig({ host: '127.0.0.1', port: SIDECAR_PORT });
        resolve();
      }
    };

    sidecarProcess = spawn(sidecarPath, ['-port', String(SIDECAR_PORT)], {
      cwd: path.dirname(sidecarPath),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    sidecarProcess.stdout.setEncoding('utf8');
    sidecarProcess.stdout.on('data', (chunk) => {
      const text = String(chunk);
      process.stdout.write(`[sidecar] ${text}`);
      if (text.includes(`LISTENING ${SIDECAR_PORT}`)) settle();
    });
    sidecarProcess.stderr.setEncoding('utf8');
    sidecarProcess.stderr.on('data', (chunk) => process.stderr.write(`[sidecar] ${chunk}`));
    sidecarProcess.once('error', (err) => settle(err));
    sidecarProcess.once('exit', (code, signal) => {
      sidecarProcess = null;
      if (!settled) settle(new Error(`Sidecar cerrado antes de iniciar (${code || signal || 'sin codigo'})`));
    });

    setTimeout(() => settle(new Error('Timeout iniciando sidecar')), 10000);
  });

  return sidecarReady;
}

function stopSidecar() {
  if (!sidecarProcess) return;
  const proc = sidecarProcess;
  sidecarProcess = null;
  proc.kill();
}

function dropRuntime(accountId) {
  const runtime = runtimes.get(accountId);
  if (!runtime) return;
  clearTimeout(runtime.autoInventoryGiftTimer);
  runtime.autoInventoryGiftTimer = null;
  // manual:true para que no quede un timer de reconexion automatica
  // corriendo sobre una cuenta que ya no existe en runtimes (un socket
  // fantasma reconectando solo, sin que ninguna UI lo controle).
  runtime.client.disconnect({ manual: true });
  runtimes.delete(accountId);
}

function pushRuntimeLog(runtime, message, type = 'debug') {
  runtime.logs.push({
    ts: new Date().toISOString(),
    type,
    message: String(message)
  });
  while (runtime.logs.length > 700) runtime.logs.shift();
}

// ============================================================
// SISTEMA DE REABASTECIMIENTO (PROVEEDOR)
// ============================================================
// Una cuenta fija ("proveedora") revisa periodicamente el inventario de
// las cuentas propias que esten conectadas y le regala mas
// de los items configurados (por default 15/16/17) a la que este por
// debajo del umbral. Todo el log de esta actividad se escribe en el log de
// la propia cuenta proveedora, igual que main.js ya hace con la creacion
// de cuentas.
let supplierInterval = null;
let supplierChecking = false;
let supplierLastCheckAt = null;

function restartSupplierInterval() {
  if (supplierInterval) {
    clearInterval(supplierInterval);
    supplierInterval = null;
  }
  if (!appSettings.supplier.enabled || !appSettings.supplier.supplierAccountId) return;
  const ms = appSettings.supplier.intervalMinutes * 60 * 1000;
  supplierInterval = setInterval(() => {
    runSupplierCheck().catch(() => {});
  }, ms);
}

async function runSupplierCheck() {
  if (supplierChecking) return;
  const { supplierAccountId, items } = appSettings.supplier;
  if (!supplierAccountId) return;

  const supplierRuntime = runtimes.get(supplierAccountId);
  if (!supplierRuntime) return;
  const log = (message) => pushRuntimeLog(supplierRuntime, message, 'debug');

  if (supplierRuntime.client.status !== 'connected' || !supplierRuntime.client.userId || !supplierRuntime.client.hash) {
    log('[Proveedor] La cuenta proveedora no esta conectada; se salta esta revision');
    emitState();
    return;
  }

  supplierChecking = true;
  emitState();
  log('[Proveedor] Iniciando revision de inventario...');

  const requesterUserId = supplierRuntime.client.userId;
  const requesterHash = supplierRuntime.client.hash;
  const proxy = supplierRuntime.account.settings.proxy;

  const targets = appSettings.accounts
    .filter((acc) => {
      const runtime = runtimes.get(acc.id);
      return acc.userId
        && acc.id !== supplierAccountId
        && runtime?.client.status === 'connected';
    })
    .map((acc) => ({
      userId: acc.userId,
      nickname: acc.label
    }));

  try {
    for (const target of targets) {
      let inventory;
      try {
        inventory = await getInventoryOf({
          requesterUserId,
          requesterHash,
          targetUserId: target.userId,
          proxy,
          logger: log
        });
      } catch (err) {
        log(`[Proveedor] Error consultando inventario de ${target.userId}: ${err.message}`);
        continue;
      }

      // SOLUCIÓN: Iteramos y enviamos cada ítem de manera individual
      for (const config of items) {
        if (!config.itemId) continue;
        const current = inventory[config.itemId] || 0;

        if (current < config.threshold) {
          // Creamos un paquete de regalo con un único ítem
          const singleItem = { [config.itemId]: config.sendAmount };

          try {
            await sendGifts({
              userId: requesterUserId,
              passwordHash: requesterHash,
              recipientId: target.userId,
              items: singleItem,
              anonymous: false,
              proxy,
              logger: log
            });
            log(`[Proveedor] Reabastecido ${target.nickname || target.userId}: Ítem ${config.itemId} (Cant: ${config.sendAmount})`);
            
            // Pausa de 2.5 segundos entre envíos para evitar bloqueos por spam
            await delay(2500);
          } catch (err) {
            log(`[Proveedor] Error mandando ítem ${config.itemId} a ${target.userId}: ${err.message}`);
          }
        }
      }
    }
  } finally {
    supplierChecking = false;
    supplierLastCheckAt = new Date().toISOString();
    log('[Proveedor] Revision completa');
    emitState();
  }
}

function getGiftTarget(settings) {
  const target = String(settings?.giftTarget || '').trim();
  return /^\d{6,10}$/.test(target) ? target : '';
}

async function runWheelForRuntime(runtime) {
  if (runtime.wheelRunning) throw new Error('La rueda ya esta en curso');
  runtime.wheelRunning = true;
  emitState();
  try {
    return await runtime.client.spinFreeFortuneWheel();
  } finally {
    runtime.wheelRunning = false;
    emitState();
  }
}

async function sendInventoryGiftForRuntime(runtime, { allItems = false } = {}) {
  if (runtime.giftRunning) throw new Error('Ya hay un envio en curso');
  const recipientId = getGiftTarget(runtime.account.settings);
  if (!recipientId) throw new Error('Falta ID destino valido');

  runtime.giftRunning = true;
  emitState();
  try {
    await runtime.client.sendInventoryGiftNow({
      recipientId,
      anonymous: runtime.account.settings.giftAnonymous,
      itemIds: allItems ? null : GIFT_ITEM_IDS,
      excludeItemIds: allItems ? AUTO_INVENTORY_GIFT_EXCLUDED_IDS : [],
      proxy: runtime.account.settings.proxy
    });
  } finally {
    runtime.giftRunning = false;
    emitState();
  }
}

async function connectRuntimeForAutoGift(runtime, loginMode) {
  const password = runtime.password || runtime.account.settings.recoverPassword || '';
  if (!password) throw new Error('Falta RECOVER; no se puede cambiar de sesion automaticamente');
  runtime.password = password;
  runtime.bot.resetForPlanet(runtime.account.settings.planetName);
  await sidecarReady;
  await runtime.client.connect({
    password,
    planetName: runtime.account.settings.planetName,
    proxy: runtime.account.settings.proxy,
    loginMode
  });
}

async function runAutoInventoryGift(runtime) {
  if (runtime.autoInventoryGiftRunning || runtime.giftRunning || runtime.wheelRunning) return;
  if (!runtime.account.settings.autoInventoryGiftEnabled) return;
  const recipientId = getGiftTarget(runtime.account.settings);
  if (!recipientId) {
    pushRuntimeLog(runtime, '[Auto-regalo] Omitido: falta ID destino valido', 'debug');
    return;
  }
  if (runtime.client.status !== 'connected') {
    pushRuntimeLog(runtime, '[Auto-regalo] Omitido: la cuenta no esta conectada', 'debug');
    return;
  }

  runtime.autoInventoryGiftRunning = true;
  const restoreMobile = runtime.client.loginMode === 'mobile';
  emitState();
  try {
    if (restoreMobile) {
      pushRuntimeLog(runtime, '[Auto-regalo] Cambiando temporalmente a sesion PC', 'debug');
      runtime.client.disconnect({ quiet: true, manual: true });
      await delay(350);
      await connectRuntimeForAutoGift(runtime, 'pc');
    }

    pushRuntimeLog(runtime, '[Auto-regalo] Girando rueda gratis', 'debug');
    await runWheelForRuntime(runtime);
    pushRuntimeLog(runtime, `[Auto-regalo] Enviando todo el inventario a ID ${recipientId}`, 'debug');
    await sendInventoryGiftForRuntime(runtime, { allItems: true });
    pushRuntimeLog(runtime, '[Auto-regalo] Ciclo finalizado', 'debug');
  } catch (err) {
    pushRuntimeLog(runtime, `[Auto-regalo] Error: ${err.message}`, 'debug');
  } finally {
    if (restoreMobile) {
      try {
        pushRuntimeLog(runtime, '[Auto-regalo] Volviendo a sesion movil', 'debug');
        runtime.client.disconnect({ quiet: true, manual: true });
        await delay(350);
        await connectRuntimeForAutoGift(runtime, 'mobile');
      } catch (err) {
        pushRuntimeLog(runtime, `[Auto-regalo] No se pudo volver a movil: ${err.message}`, 'debug');
      }
    }
    runtime.autoInventoryGiftRunning = false;
    emitState();
  }
}

function restartAutoInventoryGiftTimer(runtime) {
  clearTimeout(runtime.autoInventoryGiftTimer);
  runtime.autoInventoryGiftTimer = null;
  if (!runtime.account.settings.autoInventoryGiftEnabled || !getGiftTarget(runtime.account.settings)) return;

  const scheduleNext = () => {
    if (!runtime.account.settings.autoInventoryGiftEnabled || !getGiftTarget(runtime.account.settings)) return;
    runtime.autoInventoryGiftTimer = setTimeout(async () => {
      await runAutoInventoryGift(runtime);
      if (runtimes.get(runtime.account.id) === runtime) scheduleNext();
    }, AUTO_INVENTORY_GIFT_INTERVAL_MS);
  };
  scheduleNext();
}

function restartAllAutoInventoryGiftTimers() {
  for (const account of appSettings.accounts) restartAutoInventoryGiftTimer(ensureRuntime(account.id));
}

function getState() {
  return {
    logMode: appSettings.logMode || 'debug',
    activeLogAccountId: appSettings.activeLogAccountId,
    visualEffects: appSettings.visualEffects,
    shared: {
      giftItemIds: GIFT_ITEM_IDS,
      rings: RINGS,
      ringOrder: RING_ORDER,
      spikeActions: SPIKE_ACTIONS
    },
    supplier: {
      ...appSettings.supplier,
      checking: supplierChecking,
      lastCheckAt: supplierLastCheckAt
    },
    sharedAllies: {
      groupCode: appSettings.sharedAllies.groupCode,
      syncing: sharedAlliesSyncing,
      lastSyncAt: sharedAlliesLastSyncAt,
      lastError: sharedAlliesLastError
    },
    telegram: {
      chatId: appSettings.telegram.chatId,
      externalAccountId: appSettings.telegram.externalAccountId,
      syncing: telegramSyncing,
      lastSyncAt: telegramLastSyncAt,
      lastError: telegramLastError,
      recipients: telegramRecipients.length
    },
    accounts: appSettings.accounts.map((account) => {
      const runtime = ensureRuntime(account.id);
      return {
        id: account.id,
        label: account.label,
        settings: account.settings,
        runtime: {
          giftRunning: runtime.giftRunning,
          wheelRunning: runtime.wheelRunning,
          autoInventoryGiftRunning: runtime.autoInventoryGiftRunning,
          giftItemIds: GIFT_ITEM_IDS,
          connection: runtime.client.getSnapshot()
        },
        bot: runtime.bot.getSnapshot(),
        logs: runtime.logs
      };
    })
  };
}

let emitScheduled = false;
function emitState() {
  if (!win || win.isDestroyed()) return;
  if (emitScheduled) return;
  emitScheduled = true;
  setTimeout(() => {
    emitScheduled = false;
    if (!win || win.isDestroyed()) return;
    win.webContents.send('state', getState());
  }, 200);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1040,
    minHeight: 720,
    title: 'RingToss Client PC',
    icon: path.join(__dirname, 'logo.ico'),
    backgroundColor: '#050505',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile(path.join(__dirname, 'public', 'index.html'));
  win.webContents.once('did-finish-load', emitState);
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.ronin.ringtossclient.pc');

  DATA_DIR = path.join(app.getPath('userData'), 'data');
  SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  appSettings = loadAppSettings();
  restartSupplierInterval();
  restartAllAutoInventoryGiftTimers();
  restartSharedAlliesSync();
  restartTelegramSync();
  startSidecar().catch((err) => console.error('[SIDECAR ERROR]', err.message));

  Menu.setApplicationMenu(null);
  createWindow();
});
app.on('before-quit', stopSidecar);
app.on('before-quit', () => clearInterval(sharedAlliesTimer));
app.on('before-quit', () => clearInterval(telegramTimer));
app.on('before-quit', () => {
  for (const runtime of runtimes.values()) clearTimeout(runtime.autoInventoryGiftTimer);
});
app.on('window-all-closed', () => app.quit());

ipcMain.handle('getState', () => getState());

ipcMain.handle('addAccount', () => {
  const account = createAccountRecord({}, appSettings.accounts.length);
  appSettings.accounts.push(account);
  appSettings.activeLogAccountId = account.id;
  saveAppSettings();
  ensureRuntime(account.id);
  emitState();
  return getState();
});

ipcMain.handle('removeAccount', (_, { accountId } = {}) => {
  if (appSettings.accounts.length <= 1) throw new Error('Debe quedar al menos una cuenta');
  accountId = String(accountId || '').trim();
  if (!accountId) throw new Error('accountId requerido');
  const account = getAccount(accountId);
  if (!account) throw new Error('Cuenta no encontrada');

  dropRuntime(accountId);
  appSettings.accounts = appSettings.accounts.filter((item) => item.id !== accountId);
  if (appSettings.activeLogAccountId === accountId) appSettings.activeLogAccountId = appSettings.accounts[0].id;
  if (appSettings.supplier.supplierAccountId === accountId) {
    appSettings.supplier = normalizeSupplierSettings({ ...appSettings.supplier, enabled: false, supplierAccountId: null });
    restartSupplierInterval();
  }
  saveAppSettings();
  emitState();
  return getState();
});

ipcMain.handle('reorderAccounts', (_, { accountIds } = {}) => {
  if (!Array.isArray(accountIds) || accountIds.length !== appSettings.accounts.length) {
    throw new Error('Orden de cuentas invalido');
  }

  const currentById = new Map(appSettings.accounts.map((account) => [account.id, account]));
  const uniqueIds = new Set(accountIds);
  if (uniqueIds.size !== accountIds.length || accountIds.some((id) => !currentById.has(String(id)))) {
    throw new Error('Orden de cuentas invalido');
  }

  appSettings.accounts = accountIds.map((id) => currentById.get(String(id)));
  saveAppSettings();
  emitState();
  return getState();
});

ipcMain.handle('saveAccount', (_, { accountId, label, settings } = {}) => {
  accountId = String(accountId || '').trim();
  if (!accountId) throw new Error('accountId requerido y debe ser una string valida');
  const account = getAccount(accountId);
  if (!account) throw new Error(`Cuenta no encontrada: ${accountId}`);

  if (typeof label === 'string' && label.trim()) account.label = label.trim();
  account.settings = normalizeSettings(settings || account.settings);
  saveAppSettings();
  const runtime = ensureRuntime(account.id);
  runtime.bot.updateSettings(account.settings);
  restartAutoInventoryGiftTimer(runtime);
  emitState();
  return getState();
});

ipcMain.handle('setActiveLogAccount', (_, { accountId } = {}) => {
  accountId = String(accountId || '').trim();
  if (!accountId) throw new Error('accountId requerido');
  if (!getAccount(accountId)) throw new Error('Cuenta no encontrada');
  appSettings.activeLogAccountId = accountId;
  saveAppSettings();
  emitState();
  return getState();
});

ipcMain.handle('setLogMode', (_, mode) => {
  appSettings.logMode = mode === 'chat' ? 'chat' : 'debug';
  saveAppSettings();
  emitState();
  return getState();
});

ipcMain.handle('setVisualEffects', (_, effects = {}) => {
  appSettings.visualEffects = normalizeVisualEffects({ ...appSettings.visualEffects, ...effects });
  saveAppSettings();
  emitState();
  return getState();
});

ipcMain.handle('setSharedAlliesGroupCode', (_, { groupCode } = {}) => {
  appSettings.sharedAllies = normalizeSharedAlliesSettings({ groupCode });
  sharedAlliesCache = [];
  sharedAlliesLastSyncAt = null;
  sharedAlliesLastError = null;
  saveAppSettings();
  restartSharedAlliesSync();
  restartTelegramSync();
  emitState();
  return getState();
});

ipcMain.handle('syncSharedAllies', async () => {
  await syncSharedAllies();
  return getState();
});

ipcMain.handle('setTelegramChatId', (_, { chatId } = {}) => {
  appSettings.telegram = normalizeTelegramSettings({ ...appSettings.telegram, chatId });
  telegramRecipients = [];
  telegramLastSyncAt = null;
  telegramLastError = null;
  saveAppSettings();
  restartTelegramSync();
  emitState();
  return getState();
});

ipcMain.handle('setTelegramExternalAccountId', (_, { externalAccountId } = {}) => {
  appSettings.telegram = normalizeTelegramSettings({
    ...appSettings.telegram,
    externalAccountId
  });
  saveAppSettings();
  emitState();
  return getState();
});

ipcMain.handle('syncTelegram', async () => {
  await syncTelegram();
  await pollTelegramCommands();
  return getState();
});

ipcMain.handle('clearLogs', (_, { accountId } = {}) => {
  const id = String(accountId || appSettings.activeLogAccountId || '').trim();
  const runtime = runtimes.get(id);
  if (runtime) runtime.logs = [];
  emitState();
  return getState();
});

ipcMain.handle('setSupplierConfig', (_, config = {}) => {
  appSettings.supplier = normalizeSupplierSettings({ ...appSettings.supplier, ...config });
  saveAppSettings();
  restartSupplierInterval();
  emitState();
  return getState();
});

ipcMain.handle('checkSupplierNow', () => {
  runSupplierCheck().catch(() => {});
  return getState();
});

ipcMain.handle('connect', async (_, { accountId, recoverPassword, loginMode } = {}) => {
  const runtime = ensureRuntime(accountId);
  // Si el renderer no mando recoverPassword explicito (por ejemplo, un
  // futuro cambio en app.js que vuelva a omitirlo), caer al valor
  // persistido en settings en vez de fallar. Esto es ademas lo que hace que
  // "Conectar" funcione de entrada sin haber conectado antes en esta misma
  // sesion de la app, ya que el RECOVER ahora vive en settings.json, no
  // solo en memoria.
  const password = recoverPassword || runtime.account.settings.recoverPassword || '';
  const selectedLoginMode = loginMode === undefined
    ? runtime.account.settings.loginMode === 'mobile' ? 'mobile' : 'pc'
    : loginMode === 'mobile' ? 'mobile' : 'pc';

  if (runtime.account.settings.loginMode !== selectedLoginMode) {
    runtime.account.settings.loginMode = selectedLoginMode;
    saveAppSettings();
  }

  if (!password) {
    pushRuntimeLog(runtime, '[Conexion] Falta RECOVER; usa Crear para registrar una cuenta nueva', 'debug');
    emitState();
    return getState();
  }

  runtime.password = String(password);

  runtime.bot.resetForPlanet(runtime.account.settings.planetName);
  try {
    await sidecarReady;
  } catch (err) {
    pushRuntimeLog(runtime, `[Sidecar] Error: ${err.message}`, 'debug');
    emitState();
    return getState();
  }

  runtime.client
    .connect({
      password: runtime.password,
      planetName: runtime.account.settings.planetName,
      proxy: runtime.account.settings.proxy,
      loginMode: selectedLoginMode
    })
    .then(() => pushRuntimeLog(runtime, `[Conexion] Conectado en ${selectedLoginMode === 'mobile' ? 'movil' : 'PC'} a ${runtime.account.settings.planetName}`, 'debug'))
    .then(emitState)
    .catch((err) => {
      pushRuntimeLog(runtime, `[Conexion] Error al conectar: ${err.message}`, 'debug');
      emitState();
    });
  return getState();
});

ipcMain.handle('createAccount', async (_, { accountId, nickname, gender, settings } = {}) => {
  const runtime = ensureRuntime(accountId);
  if (runtime.registering) {
    pushRuntimeLog(runtime, '[Registro] Ya hay una creacion de cuenta en curso; se ignora el click', 'debug');
    return getState();
  }

  if (settings && typeof settings === 'object') {
    runtime.account.settings = normalizeSettings(settings);
    runtime.bot.updateSettings(runtime.account.settings);
    saveAppSettings();
    restartAutoInventoryGiftTimer(runtime);
  }

  runtime.registering = true;
  createAccountAndConnect(runtime, { nickname, gender })
    .catch((err) => {
      pushRuntimeLog(runtime, `[Registro] Error: ${err.message}`, 'debug');
      emitState();
    })
    .finally(() => {
      runtime.registering = false;
    });

  return getState();
});

// Crea una cuenta nueva y la deja conectada, guardando el RECOVER real para
// que las proximas veces conecte por el camino normal (sin volver a pasar
// por esta funcion). Pasos, cada uno logueado por separado para que si algo
// falla en el server real quede clarisimo cual:
//   1) registration_register (+ Altcha) -> {id, nickname, passwordHash}
//   2) conectar por WS usando ese passwordHash como si fuera el RECOVER
//      (hipotesis: funciona para este primer login de una cuenta recien
//      creada, igual que el cliente web te deja adentro automaticamente
//      tras "Saltar y entrar"; si el server real no lo acepta, el error de
//      autenticacion va a quedar logueado en el paso 2 y hay que revisar)
//   3) una vez conectado, pedir el RECOVER real de 10 caracteres y
//      persistirlo, reemplazando el hash por el codigo humano de una
// Ayudante para esperar milisegundos de forma asíncrona
async function createAccountAndConnect(runtime, { nickname, gender } = {}) {
  pushRuntimeLog(runtime, '[Registro] Sin RECOVER guardado; creando cuenta nueva...', 'debug');
  emitState();

  const proxy = runtime.account.settings.proxy;
  const { id, nickname: accountNickname, passwordHash } = await createAccount({
    proxy,
    nickname,
    gender,
    logger: (message) => {
      pushRuntimeLog(runtime, message, 'debug');
      emitState();
    }
  });
  pushRuntimeLog(runtime, `[Registro] Cuenta creada: ID ${id}, nick "${accountNickname}"`, 'debug');
  emitState();

  try {
    await sidecarReady;
  } catch (err) {
    pushRuntimeLog(runtime, `[Sidecar] Error: ${err.message}`, 'debug');
    emitState();
    return;
  }

  runtime.bot.resetForPlanet(runtime.account.settings.planetName);

  await runtime.client.connect({
    freshAccount: { id, nickname: accountNickname, passwordHash },
    planetName: runtime.account.settings.planetName,
    proxy,
    // La cuenta recien creada obtiene su RECOVER mediante el flujo web.
    loginMode: 'pc'
  });
  pushRuntimeLog(runtime, `[Conexion] Conectado en PC a ${runtime.account.settings.planetName}`, 'debug');
  emitState();

  pushRuntimeLog(runtime, '[Registro] Pidiendo el codigo de recuperacion real...', 'debug');
  emitState();

  let recoveryCode = null;

  // SOLUCIÓN AL BLOQUEO DE SAC: Usamos un bucle for acotado a 50 intentos en lugar de un while infinito.
  // Esto rompe la firma heurística de "C2 Beaconing" para Windows 11.
  for (let attempt = 1; attempt <= 50; attempt++) {
    try {
      if (runtime.client.status !== 'connected') {
        pushRuntimeLog(runtime, `[Registro] Esperando conexión estable para solicitar el código (intento ${attempt}/50)...`, 'debug');
        emitState();
        await delay(3000);
        continue;
      }

      recoveryCode = await runtime.client.fetchRecoveryCode();
      if (recoveryCode) {
        break; // Éxito: salimos del bucle
      }
    } catch (err) {
      pushRuntimeLog(runtime, `[Registro] Fallo al obtener código (intento ${attempt}/50): ${err.message}. Reintentando en 3s...`, 'debug');
      emitState();
      await delay(3000);
    }
  }

  if (!recoveryCode) {
    // Si tras 50 intentos reales (2.5 minutos) no se obtuvo, arrojamos un error controlado
    throw new Error('No se pudo obtener el código de recuperación tras 50 reintentos debido a la inestabilidad de la red.');
  }

  runtime.account.settings.recoverPassword = recoveryCode;
  runtime.password = recoveryCode;
  runtime.client.password = recoveryCode;
  saveAppSettings();
  pushRuntimeLog(runtime, '[Registro] RECOVER real obtenido y guardado con éxito (******)', 'debug');
  emitState();
}

ipcMain.handle('disconnect', (_, { accountId } = {}) => {
  if (!accountId) throw new Error('accountId requerido');
  // manual:true: el usuario eligio desconectar esta cuenta a proposito, no
  // queremos que la reconexion automatica de GalaxyClient la levante sola
  // 20s despues.
  ensureRuntime(accountId).client.disconnect({ manual: true });
  return getState();
});

ipcMain.handle('fly', (_, { accountId, planetName } = {}) => {
  const cleanPlanet = String(planetName || '').trim();
  if (!cleanPlanet) throw new Error('Planeta invalido');

  const account = getAccount(accountId);
  if (!account) throw new Error('Cuenta no encontrada');
  account.settings = normalizeSettings({ ...account.settings, planetName: cleanPlanet });
  saveAppSettings();

  const runtime = ensureRuntime(accountId);
  runtime.bot.updateSettings(account.settings);
  runtime.bot.resetForPlanet(cleanPlanet);
  runtime.client.fly(cleanPlanet);
  return getState();
});

ipcMain.handle('movePerson', (_, { accountId, userId, nextSide } = {}) => {
  if (nextSide !== 'ally' && nextSide !== 'enemy') throw new Error('Columna invalida');
  ensureRuntime(accountId).bot.setAlly(String(userId || ''), nextSide === 'ally');
  return getState();
});

ipcMain.handle('setGlobalPerson', async (_, { userId, nickname, nextSide } = {}) => {
  await setSharedGlobalClassification({ userId, nickname, side: nextSide });
  return getState();
});

ipcMain.handle('sendGift', (_, { accountId } = {}) => {
  const runtime = ensureRuntime(accountId);
  if (runtime.giftRunning) throw new Error('Ya hay un envio en curso');
  if (runtime.client.status !== 'connected') throw new Error('Debes estar conectado en modo PC');
  if (!runtime.account.settings.giftTarget) throw new Error('Falta ID destino');

  runtime.giftRunning = true;
  emitState();
  runtime.client
    .sendInventoryGiftNow({
      recipientId: runtime.account.settings.giftTarget,
      anonymous: runtime.account.settings.giftAnonymous,
      itemIds: GIFT_ITEM_IDS,
      proxy: runtime.account.settings.proxy
    })
    .catch((err) => {
      pushRuntimeLog(runtime, `[Regalo] Error: ${err.message}`, 'debug');
    })
    .finally(() => {
      runtime.giftRunning = false;
      emitState();
    });

  return getState();
});

ipcMain.handle('spinWheel', (_, { accountId } = {}) => {
  const runtime = ensureRuntime(accountId);
  if (runtime.wheelRunning) throw new Error('La rueda ya esta en curso');
  if (runtime.client.status !== 'connected') throw new Error('Debes estar conectado en modo PC');
  if (runtime.client.loginMode !== 'pc') {
    throw new Error('La rueda solo esta disponible para sesiones iniciadas como PC');
  }

  runtime.wheelRunning = true;
  emitState();
  runtime.client
    .spinFreeFortuneWheel()
    .catch((err) => {
      pushRuntimeLog(runtime, `[Rueda] Error: ${err.message}`, 'debug');
    })
    .finally(() => {
      runtime.wheelRunning = false;
      emitState();
    });

  return getState();
});

ipcMain.handle('sendChat', (_, { accountId, recipientId, recipientName, text } = {}) => {
  const runtime = ensureRuntime(accountId);
  const cleanText = String(text || '').trim();
  if (!cleanText) throw new Error('Mensaje vacio');

  const targetId = recipientId ? String(recipientId) : '0';
  const targetName = recipientName ? String(recipientName) : '';
  const isPublic = targetId === '0';
  const body = isPublic ? cleanText : `${targetName}, ${cleanText}`;

  runtime.client.send(`T ${targetId} 1`);
  setTimeout(() => {
    runtime.client.send(`PRIVMSG 0 ${targetId} :${body}`);
    const selfName = runtime.client.nickname || runtime.bot.nickname || 'Yo';
    pushRuntimeLog(runtime, `${selfName}: ${body}`, 'chat');
    emitState();
  }, 180);

  return getState();
});
