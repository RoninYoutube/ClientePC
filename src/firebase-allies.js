'use strict';

const { getApps, initializeApp } = require('firebase/app');
const { getAuth, inMemoryPersistence, setPersistence, signInAnonymously } = require('firebase/auth');
const { collection, doc, getDocs, getFirestore, limit, orderBy, query, serverTimestamp, setDoc } = require('firebase/firestore');

// Identifica la app Firebase; no es una credencial de administrador.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyC8KHLWlUJWkvnHICc4s_ZBuNWlJk04FBc',
  authDomain: 'ringtoss-allies.firebaseapp.com',
  projectId: 'ringtoss-allies',
  storageBucket: 'ringtoss-allies.firebasestorage.app',
  messagingSenderId: '889041039519',
  appId: '1:889041039519:web:974a5c8b26b87933d4b2aa'
};

let servicesPromise = null;

function normalizeGroupCode(value) {
  const groupCode = typeof value === 'string' ? value.trim() : '';
  if (!groupCode) return '';
  if (groupCode.length > 120 || groupCode.includes('/')) {
    throw new Error('El codigo de grupo Firebase no es valido');
  }
  return groupCode;
}

function normalizeAlly(raw) {
  if (raw?.kind) return null;
  const userId = String(raw?.userId || '').trim();
  if (!/^\d{6,10}$/.test(userId)) return null;
  return {
    userId,
    nickname: String(raw?.nickname || '').trim().slice(0, 80),
    side: raw?.side === 'enemy' ? 'enemy' : 'ally'
  };
}

function normalizeTelegramRecipient(raw) {
  const chatId = String(raw?.chatId || '').trim();
  if (!/^-?\d{5,20}$/.test(chatId)) return null;
  return { chatId };
}

function normalizeTelegramCommand(raw, id) {
  const chatId = String(raw?.chatId || '').trim();
  const text = String(raw?.text || '').trim();
  if (!/^-?\d{5,20}$/.test(chatId) || !text) return null;
  return { id: String(id), chatId, text };
}

async function getServices() {
  if (servicesPromise) return servicesPromise;
  servicesPromise = (async () => {
    const app = getApps()[0] || initializeApp(FIREBASE_CONFIG);
    const auth = getAuth(app);
    await setPersistence(auth, inMemoryPersistence);
    if (!auth.currentUser) await signInAnonymously(auth);
    return { db: getFirestore(app) };
  })().catch((err) => {
    servicesPromise = null;
    throw err;
  });
  return servicesPromise;
}

async function syncFirebaseAllies({ groupCode, ownAccounts }) {
  const cleanGroupCode = normalizeGroupCode(groupCode);
  if (!cleanGroupCode) return [];

  const { db } = await getServices();
  const alliesRef = collection(db, 'allyGroups', cleanGroupCode, 'allies');
  const snapshot = await getDocs(alliesRef);
  const alliesById = new Map();
  for (const entry of snapshot.docs) {
    const ally = normalizeAlly(entry.data());
    if (ally) alliesById.set(ally.userId, ally);
  }

  for (const rawAccount of ownAccounts || []) {
    const account = normalizeAlly(rawAccount);
    if (!account) continue;
    const remote = alliesById.get(account.userId);
    if (!remote || remote.nickname !== account.nickname || remote.side !== 'ally') {
      await setDoc(doc(alliesRef, account.userId), {
        ...account,
        side: 'ally',
        updatedAt: serverTimestamp()
      }, { merge: true });
      alliesById.set(account.userId, { ...account, side: 'ally' });
    }
  }

  return [...alliesById.values()];
}

async function setFirebaseAllyClassification({ groupCode, userId, nickname, side }) {
  const cleanGroupCode = normalizeGroupCode(groupCode);
  const person = normalizeAlly({ userId, nickname, side });
  if (!cleanGroupCode || !person) throw new Error('Clasificacion global invalida');

  const { db } = await getServices();
  const allyRef = doc(db, 'allyGroups', cleanGroupCode, 'allies', person.userId);
  await setDoc(allyRef, {
    ...person,
    updatedAt: serverTimestamp()
  }, { merge: true });
  return person;
}

async function syncFirebaseTelegram({ groupCode, chatId }) {
  const cleanGroupCode = normalizeGroupCode(groupCode);
  const recipient = normalizeTelegramRecipient({ chatId });
  if (!cleanGroupCode) return { recipients: [], commands: [] };

  const { db } = await getServices();
  const groupRef = doc(db, 'allyGroups', cleanGroupCode);
  const recipientsRef = collection(groupRef, 'telegramRecipients');
  if (recipient) {
    await setDoc(doc(recipientsRef, recipient.chatId), {
      ...recipient,
      updatedAt: serverTimestamp()
    }, { merge: true });
  }

  const [recipientsSnapshot, commandsSnapshot] = await Promise.all([
    getDocs(recipientsRef),
    getDocs(query(collection(groupRef, 'telegramCommands'), orderBy('createdAt', 'desc'), limit(100)))
  ]);

  return {
    recipients: recipientsSnapshot.docs
      .map((entry) => normalizeTelegramRecipient(entry.data()))
      .filter(Boolean),
    commands: commandsSnapshot.docs
      .map((entry) => normalizeTelegramCommand(entry.data(), entry.id))
      .filter(Boolean)
  };
}

async function queueFirebaseTelegramCommand({ groupCode, updateId, chatId, text }) {
  const cleanGroupCode = normalizeGroupCode(groupCode);
  const command = normalizeTelegramCommand({ chatId, text }, updateId);
  if (!cleanGroupCode || !/^\d{1,20}$/.test(String(updateId)) || !command) return;

  const { db } = await getServices();
  await setDoc(doc(db, 'allyGroups', cleanGroupCode, 'telegramCommands', String(updateId)), {
    ...command,
    createdAt: Date.now(),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

module.exports = {
  normalizeGroupCode,
  syncFirebaseAllies,
  setFirebaseAllyClassification,
  syncFirebaseTelegram,
  queueFirebaseTelegramCommand
};
