'use strict';

const { normalizeProxySettings } = require('./proxy');

const RINGS = {
  gold: {
    key: 'gold',
    label: 'Anillo de Oro',
    poste: 3,
    action: 10415,
    color: '#d69a16'
  },
  silver: {
    key: 'silver',
    label: 'Anillo de Plata',
    poste: 2,
    action: 10414,
    color: '#96a0ad'
  },
  bronze: {
    key: 'bronze',
    label: 'Anillo de Bronce',
    poste: 1,
    action: 10413,
    color: '#a45f32'
  }
};

const RING_ORDER = ['gold', 'silver', 'bronze'];
const POSTE_TO_RING = {
  1: 'bronze',
  2: 'silver',
  3: 'gold'
};

const SPIKE_ACTIONS = {
  titanium: {
    on: 14968,
    off: 14969,
    label: 'Titanio'
  },
  diamond: {
    on: 17108,
    off: 17109,
    label: 'Diamante'
  }
};

const VALID_SPIKES = new Set(['none', 'titanium', 'diamond']);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeStackConfig(enabled = false) {
  return {
    enabled,
    spike: 'none'
  };
}

function makeRingConfig(enabled = false, enabledStacks = []) {
  const stacks = {};
  for (let stack = 0; stack <= 3; stack++) {
    stacks[String(stack)] = makeStackConfig(enabledStacks.includes(stack));
  }
  return {
    enabled,
    primary: {
      titanium: false,
      diamond: false,
      diamondExceptFourth: false
    },
    stacks
  };
}

function createDefaultSettings() {
  return {
    botEnabled: false,
    recoverPassword: '',
    loginMode: 'pc',
    proxy: normalizeProxySettings(),
    newPlayersAreEnemies: true,
    planetName: 'RingToss*2',
    giftTarget: '',
    giftAnonymous: true,
    autoInventoryGiftEnabled: false,
    persistedAllies: [],
    persistedEnemies: [],
    rings: {
      gold: makeRingConfig(true, [0, 1, 2, 3]),
      silver: makeRingConfig(false, []),
      bronze: makeRingConfig(false, [])
    }
  };
}

function normalizeSettings(input) {
  const defaults = createDefaultSettings();
  const src = input && typeof input === 'object' ? input : {};
  const out = {
    ...defaults,
    ...src,
    botEnabled: Boolean(src.botEnabled),
    recoverPassword: typeof src.recoverPassword === 'string' ? src.recoverPassword : '',
    loginMode: src.loginMode === 'mobile' ? 'mobile' : 'pc',
    proxy: normalizeProxySettings(src.proxy),
    newPlayersAreEnemies: src.newPlayersAreEnemies !== false,
    planetName: typeof src.planetName === 'string' && src.planetName.trim()
      ? src.planetName.trim()
      : defaults.planetName,
    giftTarget: typeof src.giftTarget === 'string' ? src.giftTarget.trim() : '',
    giftAnonymous: src.giftAnonymous !== false,
    autoInventoryGiftEnabled: Boolean(src.autoInventoryGiftEnabled),
    persistedAllies: Array.isArray(src.persistedAllies) ? src.persistedAllies.filter((id) => typeof id === 'string') : [],
    persistedEnemies: Array.isArray(src.persistedEnemies) ? src.persistedEnemies.filter((id) => typeof id === 'string') : [],
    rings: {}
  };

  for (const key of RING_ORDER) {
    const ringSrc = src.rings && typeof src.rings === 'object' ? src.rings[key] : null;
    const ringDefault = defaults.rings[key];
    const ring = {
      enabled: ringSrc ? Boolean(ringSrc.enabled) : ringDefault.enabled,
      primary: {
        titanium: Boolean(ringSrc && ringSrc.primary && ringSrc.primary.titanium),
        diamond: Boolean(ringSrc && ringSrc.primary && ringSrc.primary.diamond),
        diamondExceptFourth: Boolean(ringSrc && ringSrc.primary && ringSrc.primary.diamondExceptFourth)
      },
      stacks: {}
    };

    for (let stack = 0; stack <= 3; stack++) {
      const stackKey = String(stack);
      const stackSrc = ringSrc && ringSrc.stacks ? ringSrc.stacks[stackKey] : null;
      const spike = stackSrc && VALID_SPIKES.has(stackSrc.spike) ? stackSrc.spike : 'none';
      ring.stacks[stackKey] = {
        enabled: Boolean(stackSrc && stackSrc.enabled),
        spike
      };
    }
    out.rings[key] = ring;
  }

  // Config vieja persistida (de antes de unificar el login en pc) puede
  // traer este campo colgado; se limpia explicitamente porque el spread de
  // src de arriba lo dejaria pasar tal cual, sin validar.
  delete out.deviceProfileIndex;

  return out;
}

function initialPosteMap(value) {
  return { 1: value, 2: value, 3: value };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class RingtossBot {
  constructor({ settings, send, log, stateChanged, onChat, onPersist, isAdditionalChatTarget }) {
    this.settings = normalizeSettings(settings);
    this.send = send;
    this.log = log;
    this.onChat = onChat || (() => { });
    this.isAdditionalChatTarget = isAdditionalChatTarget || (() => false);
    this.stateChanged = stateChanged || (() => { });
    this.onPersist = onPersist || (() => { });
    this.userId = null;
    this.nickname = null;
    this.currentPlanetName = this.settings.planetName;
    this.gameId = null;
    this.people = new Map();
    this.allies = new Set();
    this.persistedAllies = new Set(this.settings.persistedAllies);
    this.persistedEnemies = new Set(this.settings.persistedEnemies);
    this.resetGameState();
  }

  updateSettings(settings) {
    this.settings = normalizeSettings(settings);
    this.currentPlanetName = this.settings.planetName;
    this.persistedAllies = new Set(this.settings.persistedAllies);
    this.persistedEnemies = new Set(this.settings.persistedEnemies);
    this.stateChanged();
  }

  setIdentity(userId, nickname) {
    this.userId = userId || null;
    this.nickname = nickname || null;
    this.stateChanged();
  }

  resetForPlanet(planetName) {
    this.currentPlanetName = planetName || this.settings.planetName;
    this.gameId = null;
    this.people.clear();
    this.allies.clear();
    this.resetGameState();
    this.log(`[RingToss] Entrando a ${this.currentPlanetName}; aliados dinamicos reseteados`);
    this.stateChanged();
  }

  resetGameState() {
    this.posteState = initialPosteMap(null);
    this.lastUser = initialPosteMap(null);
    this.hasSpikes = initialPosteMap(false);
    this.hasDiamond = initialPosteMap(false);
    this.unknownGoFlags = initialPosteMap(0);
    this.pendingUser = null;
    this.threatQueue = [];
    this.lastGoFlagTs = 0;
    this.actionInProgress = false;
    this.activeSpike = null;
    this.pendingAction = null;
    clearTimeout(this.pendingActionTimer);
    this.pendingActionTimer = null;
    // En el constructor de RingtossBot, después de this.pendingActionTimer = null;
    this.distractionIntervals = []; // Array de { start, end } en ms absolutos
    this.reactionMean = 800;        // 0.8 segundos en ms
    this.reactionStd = 150;         // 150ms de desviación típica
    this.reactionMin = 310;
    this.reactionMax = 1140;
    this.generateDistractions();    // Genera los intervalos al iniciar
  }
  generateDistractions() {
  // Limpia intervalos anteriores
  this.distractionIntervals = [];
  
  // Número de distracciones: 1 o 2 (aleatorio)
  const numDistractions = 1 + Math.floor(Math.random() * 2);
  
  // Duración total de la sesión simulada: 11 horas (39600000 ms)
  const sessionDuration = 11 * 3600 * 1000;
  
  // Hora actual como referencia (timestamp de inicio de sesión)
  const now = Date.now();
  
  for (let i = 0; i < numDistractions; i++) {
    // Duración aleatoria entre 1m43s y 8m27s (103000 a 507000 ms)
    const duration = 103000 + Math.random() * 404000;
    
    // Tiempo de inicio aleatorio dentro de la sesión, pero que quepa la duración
    const maxStart = sessionDuration - duration;
    const startOffset = Math.random() * maxStart;
    
    // Añadir al array
    this.distractionIntervals.push({
      start: now + startOffset,
      end: now + startOffset + duration
    });
  }
  
  // Ordenar por tiempo de inicio (opcional)
  this.distractionIntervals.sort((a, b) => a.start - b.start);
  
  this.log(`[Distracciones] Programadas ${this.distractionIntervals.length} distracciones: ` +
    this.distractionIntervals.map(d => 
      `${new Date(d.start).toLocaleTimeString()} - ${new Date(d.end).toLocaleTimeString()}`
    ).join(', '));
}

  getSnapshot() {
    const people = [...this.people.values()].sort((a, b) => {
      const nameCompare = a.name.localeCompare(b.name);
      return nameCompare || a.id.localeCompare(b.id);
    });

    return {
      userId: this.userId,
      nickname: this.nickname,
      currentPlanetName: this.currentPlanetName,
      gameId: this.gameId,
      posteState: { ...this.posteState },
      lastUser: { ...this.lastUser },
      hasSpikes: { ...this.hasSpikes },
      hasDiamond: { ...this.hasDiamond },
      activeSpike: this.activeSpike,
      actionInProgress: this.actionInProgress,
      people,
      allies: [...this.allies],
      threatQueue: this.threatQueue.map((item) => ({ ...item }))
    };
  }

  setAlly(userId, checked) {
    if (!this.people.has(userId)) return;
    if (checked) {
      this.persistedAllies.add(userId);
      this.persistedEnemies.delete(userId);
      this.allies.add(userId);
    } else {
      this.persistedEnemies.add(userId);
      this.persistedAllies.delete(userId);
      this.allies.delete(userId);
    }
    const person = this.people.get(userId);
    this.people.set(userId, { ...person, ally: Boolean(checked) });
    this.log(`[Aliados] ${person.name} (${userId}) ${checked ? 'agregado' : 'quitado'}`);
    this.onPersist({
      persistedAllies: [...this.persistedAllies],
      persistedEnemies: [...this.persistedEnemies]
    });
    this.stateChanged();
  }

  // A diferencia de setAlly, no requiere que la persona ya este visible en
  // el roster actual (this.people): la marca en persistedAllies igual, para
  // que la PROXIMA vez que aparezca (JOIN, roster inicial, etc.) upsertPerson
  // ya la clasifique como aliada de entrada. Si ya esta visible ahora mismo,
  // ademas la actualiza al toque. Pensado para cuentas propias: main.js la
  // usa para propagar el userId de cada cuenta como aliado en todas las
  // demas (y en si misma) apenas se identifica, sin esperar a que el
  // usuario la mueva a mano en Aliados Globales.
  markKnownAlly(id, name) {
    if (!id) return;
    this.persistedAllies.add(id);
    this.persistedEnemies.delete(id);
    const existing = this.people.get(id);
    if (existing) {
      this.people.set(id, { ...existing, name: name || existing.name, ally: true });
      this.allies.add(id);
    }
    this.onPersist({
      persistedAllies: [...this.persistedAllies],
      persistedEnemies: [...this.persistedEnemies]
    });
    this.stateChanged();
  }

  markKnownEnemy(id, name) {
    if (!id) return;
    this.persistedEnemies.add(id);
    this.persistedAllies.delete(id);
    const existing = this.people.get(id);
    if (existing) {
      this.people.set(id, { ...existing, name: name || existing.name, ally: false });
      this.allies.delete(id);
    }
    this.onPersist({
      persistedAllies: [...this.persistedAllies],
      persistedEnemies: [...this.persistedEnemies]
    });
    this.stateChanged();
  }

  isAlly(userId) {
    return Boolean(userId && (userId === this.userId || this.allies.has(userId)));
  }

  isEnemy(userId) {
    return Boolean(userId && !this.isAlly(userId));
  }

  handleMessage(raw) {
    const msg = String(raw);
    this.extractGameId(msg);
    this.handleRosterMessage(msg);
    this.handleChatMessage(msg);
    this.handleActionMessage(msg);
    this.handleAddView(msg);
    this.handleRemoveView(msg);
    this.handleGoFlag(msg);
  }

  handleChatMessage(msg) {
    const match = msg.match(/^PRIVMSG\s+(\d{6,10})\s+1\s+(\d{1,10})\s+:(.*)$/);
    if (!match) return;

    const senderId = match[1];
    const targetId = match[2];
    const text = match[3] || '';
    // Galaxy suele dejar seleccionado el planeta RingToss. Ese tag no es un
    // privado a otra persona: se procesa como un mensaje al aire.
    const isPublic = targetId === '0' || (this.gameId && targetId === this.gameId);
    const isDirectToMe = this.userId && targetId === this.userId;
    const isExternalTarget = !isPublic && !isDirectToMe && this.isAdditionalChatTarget(targetId);
    if (!isPublic && !isDirectToMe && !isExternalTarget) return;
    if (isDirectToMe && this.nickname && !text.startsWith(`${this.nickname},`)) return;

    const sender = this.people.get(senderId);
    this.onChat({
      senderId,
      senderName: sender ? sender.name : `ID:${senderId}`,
      targetId,
      text,
      isPublic,
      isExternalTarget
    });
  }

  extractGameId(msg) {
    // No intentar extraer gameId de mensajes 353 — los IDs ahí son de usuarios, no del juego
    if (msg.includes('353 1 =')) return;

    const go = msg.match(/ADD_VIEW\s+0\s+(\d{6,10})\s+20\s+1;rt\/go-flag/);
    if (go) {
      this.setGameId(go[1], 'go-flag');
      return;
    }

    const rtView = msg.match(/(?:ADD_VIEW|REMOVE_VIEW)\s+0\s+(\d{6,10})\b.*\brt\//);
    if (rtView) {
      this.setGameId(rtView[1], 'view');
      return;
    }

    if (!this.currentPlanetName) return;
    const escaped = escapeRegExp(this.currentPlanetName);
    const nameThenId = new RegExp(`\\b${escaped}\\b[^\\r\\n]{0,80}?\\b(\\d{6,10})\\b`).exec(msg);
    if (nameThenId) {
      this.setGameId(nameThenId[1], 'planet-name');
      return;
    }

    const idThenName = new RegExp(`\\b(\\d{6,10})\\b[^\\r\\n]{0,80}?\\b${escaped}\\b`).exec(msg);
    if (idThenName) this.setGameId(idThenName[1], 'planet-name');
  }

  setGameId(id, source) {
    if (!id || this.gameId === id) return;
    this.gameId = id;
    this.log(`[RingToss] ID detectado para ${this.currentPlanetName}: ${id} (${source})`);
    this.stateChanged();
  }

  handleRosterMessage(msg) {
    if (msg.includes('353 1 =')) {
      const found = [];
      const skipped = [];
      const tokens = msg.split(/\s+/);
      for (let i = 0; i < tokens.length; i++) {
        if (!/^\d{6,10}$/.test(tokens[i])) continue;
        const id = tokens[i];
        let name = i > 0 ? tokens[i - 1].replace(/^[:\-=@]+/, '').trim() : '';
        if ((!name || /^\d+$/.test(name)) && i > 1) {
          name = tokens[i - 2].replace(/^[:\-=@]+/, '').trim();
        }
        // Entrada del planeta: extraer su gameId y saltear
        if (name.startsWith('RingToss*')) {
          this.setGameId(id, '353-planet');
          continue;
        }
        if (!name) {
          skipped.push(id);
          name = `Jugador_${id}`;
        }
        this.upsertPerson(id, name, !this.settings.newPlayersAreEnemies);
        found.push(`${name} (${id})`);
      }
      if (found.length > 0) this.log(`[Usuarios] Lista inicial: ${found.length} persona(s)`);
      if (skipped.length > 0) this.log(`[Usuarios] ⚠️ ${skipped.length} sin nombre: ${skipped.join(', ')}`);
      return;
    }

    if (msg.startsWith('JOIN ')) {
      const tokens = msg.split(/\s+/);
      for (let i = 1; i < tokens.length; i++) {
        if (!/^\d{6,10}$/.test(tokens[i])) continue;
        const id = tokens[i];
        const name = (tokens[i - 1] || '').replace(/^[:\-=@]+/, '').trim();
        if (name && !name.startsWith('RingToss*')) {
          this.upsertPerson(id, name, !this.settings.newPlayersAreEnemies);
          this.log(`[Usuarios] Entra ${name} (${id})`);
        }
        break;
      }
      return;
    }

    const part = msg.match(/^(?:PART|QUIT)\s+(\d{6,10})\b/);
    if (part) this.removePerson(part[1]);
  }

  upsertPerson(id, name, defaultAlly) {
    const existing = this.people.get(id);
    let ally;
    if (existing) {
      // Persona ya presente: conservar su clasificacion actual
      ally = existing.ally;
    } else if (this.persistedAllies.has(id)) {
      // Clasificacion persistida: aliado
      ally = true;
    } else if (this.persistedEnemies.has(id)) {
      // Clasificacion persistida: enemigo
      ally = false;
    } else {
      // Sin clasificacion previa: usar el default
      ally = Boolean(defaultAlly);
    }
    this.people.set(id, { id, name, ally });
    if (ally) this.allies.add(id);
    else this.allies.delete(id);
    this.stateChanged();
  }

  removePerson(id) {
    const person = this.people.get(id);
    this.people.delete(id);
    this.allies.delete(id);
    if (person) this.log(`[Usuarios] Sale ${person.name} (${id})`);
    this.stateChanged();
  }

  handleActionMessage(msg) {
    if (!/^ACTION\b/.test(msg)) return;
    const normalized = msg
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const isActualThrow =
      normalized.includes('lanzo anillo de') ||
      /\bthrew\b/.test(normalized) ||
      msg.includes('брос');
    if (!isActualThrow) return;
    const isThrow = /lanz|throw|брос/i.test(msg);
    void isThrow;

    const m = msg.match(/^ACTION\s+\d+\s+(\d{6,10})\b/);
    if (m) this.pendingUser = m[1];

    // CORRECCIÓN: Manejo inteligente del desbloqueo si hay una acción en curso
    if (this.pendingAction) {
      if (this.nickname && msg.includes(`:${this.nickname}`)) {
        // Flujo normal: Nuestro propio tiro fue confirmado por el servidor
        const pending = this.pendingAction;
        this.clearPendingAction();
        this.actionInProgress = false;
        this.log(`[RingToss] Lanzamiento confirmado: ${RINGS[pending.ringKey].label}`);
      } else {
        // SOLUCIÓN: Si otra persona lanzó, nuestro tiro preparado fue anulado.
        // Destrabamos el bot inmediatamente para estar listos en el próximo go-flag.
        const pending = this.pendingAction;
        this.clearPendingAction();
        this.actionInProgress = false;
        const nameMatch = msg.match(/:([^\s]+)/);
        const throwerName = nameMatch ? nameMatch[1] : (m ? m[1] : 'Otro jugador');
        this.log(`[RingToss] Lanzamiento anulado: ${throwerName} se adelantó`);
      }
    }

    if (this.activeSpike) {
      this.deactivateSpikeSoon(this.activeSpike);
    }

    this.stateChanged();
  }

  handleAddView(msg) {
    const mv = msg.match(/ADD_VIEW\s+0\s+(\d{6,10})\b.*\b4([123])([1-4])\b/);
    if (!mv) return;
    const viewGameId = mv[1];
    if (this.gameId && viewGameId !== this.gameId) return;
    this.setGameId(viewGameId, 'add-view');

    const poste = Number(mv[2]);
    if (poste >= 1 && poste <= 3) this.unknownGoFlags[poste] = 0;
    if (!this.pendingUser) return;

    const incomingUser = this.pendingUser;
    const incomingSpikes = msg.includes('spikes') && !msg.includes('diamond');
    const incomingDiamond = msg.includes('diamond');
    const prevStack = this.posteState[poste] ?? 0;
    const hadSpikes = this.hasSpikes[poste] === true;
    let stackIncreased = false;

    if (incomingDiamond) {
      this.posteState[poste] = Math.min(prevStack + 1, 4);
      this.hasDiamond[poste] = true;
      this.hasSpikes[poste] = false;
      this.lastUser[poste] = incomingUser;
      stackIncreased = true;
    } else if (incomingSpikes && hadSpikes) {
      this.posteState[poste] = Math.min(prevStack + 1, 4);
      // Si el que tiró con espinas es enemigo, conservar hasSpikes=true para
      // que chooseSpikeMode pueda responder con titanio en el go-flag.
      // Si es aliado, las espinas se cancelan (no responder con titanio sobre el aliado).
      this.hasSpikes[poste] = this.isEnemy(incomingUser);
      this.lastUser[poste] = incomingUser;
      stackIncreased = true;
    } else if (incomingSpikes && !hadSpikes) {
      this.posteState[poste] = Math.min(prevStack + 1, 4);
      this.hasSpikes[poste] = true;
      this.lastUser[poste] = incomingUser;
      stackIncreased = true;
    } else if (!incomingSpikes && !hadSpikes) {
      this.posteState[poste] = Math.min(prevStack + 1, 4);
      this.hasSpikes[poste] = false;
      this.lastUser[poste] = incomingUser;
      stackIncreased = true;
    } else if (!incomingSpikes && hadSpikes) {
      this.hasSpikes[poste] = false;
      stackIncreased = false;
    }

    if (stackIncreased) {
      // Igual que en el script de referencia: una amenaza es "enemigo tira
      // en cualquier stack" O "el stack llega a 3" (sin importar aliado o
      // enemigo, porque en 3 el siguiente tiro completa el poste y hay que
      // reaccionar sea quien sea). Un diamante en el tope excluye la
      // amenaza porque no se puede responder salvo con diamante propio
      // (eso lo maneja chooseSpikeMode/makeDecisionForPoste, no la cola).
      const isThreat = (this.isEnemy(incomingUser) || this.posteState[poste] === 3) && !this.hasDiamond[poste];
      if (isThreat) this.addOrReorderThreat(poste);
      else this.removeThreat(poste);
    }

    this.pendingUser = null;
    this.stateChanged();
  }

  handleRemoveView(msg) {
    const rm = msg.match(/REMOVE_VIEW\s+0\s+(\d{6,10})\b/);
    if (!rm) return;
    const viewGameId = rm[1];
    if (this.gameId && viewGameId !== this.gameId) return;
    this.setGameId(viewGameId, 'remove-view');

    if (msg.includes('431') && msg.includes('432')) this.resetPoste(3);
    if (msg.includes('421') && msg.includes('422')) this.resetPoste(2);
    if (msg.includes('411') && msg.includes('412')) this.resetPoste(1);
    this.stateChanged();
  }

  resetPoste(poste) {
    this.posteState[poste] = 0;
    this.lastUser[poste] = null;
    this.hasSpikes[poste] = false;
    this.hasDiamond[poste] = false;
    this.unknownGoFlags[poste] = 0;
    this.removeThreat(poste);
    this.log(`[RingToss] Poste ${poste} limpio`);
  }

  handleGoFlag(msg) {
  const go = msg.match(/ADD_VIEW\s+0\s+(\d{6,10})\s+20\s+1;rt\/go-flag/);
  if (!go) return;
  this.setGameId(go[1], 'go-flag');

  const now = Date.now();
  if (now - this.lastGoFlagTs < 250) return;
  this.lastGoFlagTs = now;

  for (let poste = 1; poste <= 3; poste++) {
    if (this.posteState[poste] !== null) {
      this.unknownGoFlags[poste] = 0;
      continue;
    }
    this.unknownGoFlags[poste]++;
    if (this.unknownGoFlags[poste] >= 4) {
      this.posteState[poste] = 0;
      this.lastUser[poste] = null;
      this.hasSpikes[poste] = false;
      this.hasDiamond[poste] = false;
      this.log(`[RingToss] Asumiendo poste ${poste} vacio tras 4 go-flags sin estado`);
    }
  }

  // Si el bot está desactivado o distraído, no hacer nada
  if (!this.settings.botEnabled || this.isDistracted()) {
    if (this.isDistracted()) {
      this.log('[RingToss] Distraído - ignorando go-flag');
    }
    return;
  }

  const decision = this.decideThrow();
  this.logDecision(decision);

  if (decision.action === 'throw') {
    const reactionMs = this.getReactionDelay();
    this.log(`[RingToss] Reacción en ${reactionMs}ms`);
    setTimeout(async () => {
      await this.performThrow(decision);
    }, reactionMs);
  }
}

  addOrReorderThreat(poste) {
    this.removeThreat(poste);
    this.threatQueue.push({ poste, createdAt: Date.now() });
  }

  removeThreat(poste) {
    this.threatQueue = this.threatQueue.filter((item) => item.poste !== poste);
  }

  decideThrow({ ignoreInProgress = false } = {}) {
    if (!ignoreInProgress && this.actionInProgress) return { action: 'ignore', reason: 'accion en progreso' };
    if (!this.gameId) return { action: 'ignore', reason: 'sin ID RingToss' };

    for (const threat of this.threatQueue) {
      const decision = this.makeDecisionForPoste(threat.poste, 'amenaza');
      if (decision) return decision;
    }

    for (const stack of [3, 2, 1]) {
      for (const ringKey of RING_ORDER) {
        const poste = RINGS[ringKey].poste;
        if (this.posteState[poste] !== stack) continue;
        if (stack === 3 || this.isEnemy(this.lastUser[poste])) {
          const decision = this.makeDecisionForPoste(poste, `stack ${stack}`);
          if (decision) return decision;
        }
      }
    }

    // Prioridad física de juego: Bronce (1) -> Plata (2) -> Oro (3)
          const emptyPostPriority = ['bronze', 'silver', 'gold'];
          for (const ringKey of emptyPostPriority) {
            const poste = RINGS[ringKey].poste;
            if (this.posteState[poste] !== 0) continue;
            const decision = this.makeDecisionForPoste(poste, 'poste vacio');
            if (decision) return decision;
          }

    return { action: 'ignore', reason: 'sin regla aplicable' };
  }

  makeDecisionForPoste(poste, reason) {
    const ringKey = POSTE_TO_RING[poste];
    const ringMeta = RINGS[ringKey];
    const ringCfg = this.settings.rings[ringKey];
    const stack = this.posteState[poste];
    
    if (!ringCfg || !ringCfg.enabled) return null;
    if (stack === null || stack < 0 || stack > 3) return null;

    // MEDIDA DE SEGURIDAD CONTRA SOBRETIROS (Anillo 1 / Stack 0):
    if (stack === 0) {
      // Para tirar en el Poste 1 (Bronce), el Poste 2 (Plata) también debe estar vacío.
      if (poste === 1 && this.posteState[2] !== 0) {
        return null; 
      }
      // Para tirar en el Poste 2 (Plata), el Poste 3 (Oro) también debe estar vacío.
      if (poste === 2 && this.posteState[3] !== 0) {
        return null;
      }
    }

    const stackCfg = ringCfg.stacks[String(stack)];
    if (!stackCfg || !stackCfg.enabled) return null;

    const spike = this.chooseSpikeMode(ringCfg, poste, stackCfg, stack);
    if (spike === null) return null;

    return {
      action: 'throw',
      ringKey,
      ringLabel: ringMeta.label,
      actionCode: ringMeta.action,
      poste,
      stack,
      spike,
      reason
    };
  }

  chooseSpikeMode(ringCfg, poste, stackCfg, stack) {
    const topUser = this.lastUser[poste];
    const enemyTop = this.isEnemy(topUser);

    if (this.hasDiamond[poste]) {
      const respondsWithDiamond = ringCfg.primary.diamond
        || (poste === RINGS.gold.poste && ringCfg.primary.diamondExceptFourth && stack < 3);
      if (enemyTop && respondsWithDiamond) return 'diamond';
      return null;
    }

    if (this.hasSpikes[poste]) {
      if (stack === 3) return 'titanium';
      if (enemyTop && ringCfg.primary.titanium) return 'titanium';
      return 'none';
    }

    return stackCfg.spike || 'none';
  }

  logDecision(decision) {
    const summary =
      `p1=${this.posteState[1]}/u=${this.lastUser[1] || '-'} ` +
      `p2=${this.posteState[2]}/u=${this.lastUser[2] || '-'} ` +
      `p3=${this.posteState[3]}/u=${this.lastUser[3] || '-'}`;

    if (decision.action !== 'throw') {
      this.log(`[RingToss][GO] ${summary}; ignorar (${decision.reason})`);
      return;
    }

    this.log(
      `[RingToss][GO] ${summary}; tirar ${decision.ringLabel} ` +
      `como Anillo ${decision.stack + 1}, spike=${decision.spike}, motivo=${decision.reason}`
    );
  }

  async performThrow(decision) {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    this.pendingAction = decision;
    this.stateChanged();

    try {
      if (decision.spike !== 'none') {
        await this.activateSpike(decision.spike);
        await wait(280 + Math.random() * 180);
      }

      // Entre que se decidio este tiro y este punto pasaron el delay de
      // reaccion humanizada (310-1140ms) y, si hubo espinas, otros
      // 280-460ms mas: en ese tiempo el poste pudo vaciarse o cambiar de
      // stack. En vez de abortar el turno, se vuelve a decidir con el
      // estado ACTUAL (misma logica que en el go-flag) y se tira lo que
      // realmente corresponda ahora. ignoreInProgress:true porque
      // actionInProgress ya esta en true (lo pusimos arriba); sin eso,
      // decideThrow() se auto-bloquearia y siempre devolveria "ignorar".
      const freshDecision = this.decideThrow({ ignoreInProgress: true });

      if (freshDecision.action !== 'throw') {
        this.log(`[RingToss] Tiro cancelado: ya no hay ninguna regla aplicable (${freshDecision.reason})`);
        this.clearPendingAction();
        this.actionInProgress = false;
        if (this.activeSpike) this.deactivateSpikeSoon(this.activeSpike);
        this.stateChanged();
        return;
      }

      if (freshDecision.poste !== decision.poste || freshDecision.stack !== decision.stack) {
        this.log(
          `[RingToss] Redecidido antes de tirar: poste ${decision.poste} ya no aplica, ` +
          `se tira ${freshDecision.ringLabel} en poste ${freshDecision.poste} en su lugar (${freshDecision.reason})`
        );
      }

      // Si la espina que corresponde ahora es distinta a la que ya
      // activamos para la decision vieja, hay que cambiarla antes de
      // tirar. Es una espera mas, pero acotada a este unico caso: no se
      // vuelve a redecidir en loop despues de esto.
      if (freshDecision.spike !== this.activeSpike) {
        if (freshDecision.spike !== 'none') {
          await this.activateSpike(freshDecision.spike);
          await wait(280 + Math.random() * 180);
        } else if (this.activeSpike) {
          this.deactivateSpikeSoon(this.activeSpike);
        }
      }

      decision = freshDecision;
      this.pendingAction = decision;
      this.send(`ACTION ${decision.actionCode} ${this.gameId}`);
      this.log(`[RingToss] Intentando ${decision.ringLabel} en poste ${decision.poste}`);
      this.pendingActionTimer = setTimeout(() => {
        if (!this.pendingAction) return;
        this.log(`[RingToss] Sin confirmacion del servidor para ${decision.ringLabel}`);
        this.clearPendingAction();
        this.actionInProgress = false;
        if (this.activeSpike) this.deactivateSpikeSoon(this.activeSpike);
        this.stateChanged();
      }, 15000);
    } catch (err) {
      this.log(`[RingToss] Error al tirar: ${err.message}`);
      this.clearPendingAction();
      this.actionInProgress = false;
      this.stateChanged();
    }
  }

  async activateSpike(mode) {
    const spike = SPIKE_ACTIONS[mode];
    if (!spike) return;
    if (this.activeSpike && this.activeSpike !== mode) {
      this.send(`ACTION ${SPIKE_ACTIONS[this.activeSpike].off} ${this.gameId}`);
      this.activeSpike = null;
      await wait(220);
    }
    if (this.activeSpike === mode) return;
    this.send(`ACTION ${spike.on} ${this.gameId}`);
    this.activeSpike = mode;
    this.log(`[RingToss] Activando espinas de ${spike.label}`);
    this.stateChanged();
  }

  deactivateSpikeSoon(mode) {
    const spike = SPIKE_ACTIONS[mode];
    if (!spike || this.activeSpike !== mode) return;
    setTimeout(() => {
      if (this.activeSpike !== mode) return;
      this.send(`ACTION ${spike.off} ${this.gameId}`);
      this.log(`[RingToss] Desactivando espinas de ${spike.label}`);
      this.activeSpike = null;
      this.stateChanged();
    }, 250 + Math.random() * 150);
  }

  clearPendingAction() {
    clearTimeout(this.pendingActionTimer);
    this.pendingActionTimer = null;
    this.pendingAction = null;
  }
  isDistracted() {
  const now = Date.now();
  for (const interval of this.distractionIntervals) {
    if (now >= interval.start && now <= interval.end) {
      return true;
    }
  }
  return false;
}
// Box-Muller transform para generar distribución normal
gaussianRandom(mean, std) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return mean + std * z;
}

getReactionDelay() {
  let delay = this.gaussianRandom(this.reactionMean, this.reactionStd);
  // Recortar al rango permitido
  delay = Math.max(this.reactionMin, Math.min(this.reactionMax, delay));
  return Math.round(delay);
}
}

module.exports = {
  RINGS,
  RING_ORDER,
  SPIKE_ACTIONS,
  createDefaultSettings,
  normalizeSettings,
  RingtossBot
};
