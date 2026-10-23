'use strict';

let state = null;
const saveTimers = new Map();
const selectedPeople = new Map();
const selectedChatTargets = new Map();
const chatDrafts = new Map();
const openAccounts = new Set();
let chatMenuOpen = false;
const chatMenuScrolls = new Map();
let pendingRenderState = null;
let particleBackground = null;
const REPEL_STRENGTH = 0.004; // sube = más parejo, baja = más orgánico
const CRUISE_DAMPING = 0.02;  // qué tan rápido vuelve a su velocidad propia
let spacing = 70;             // se recalcula en resize()

const els = {
  globalStatus: document.getElementById('global-status'),
  addAccountBtn: document.getElementById('add-account-btn'),
  accounts: document.getElementById('accounts'),
  logTabs: document.getElementById('log-tabs'),
  log: document.getElementById('log'),
  chatComposer: document.getElementById('chat-composer'),
  particleBg: document.getElementById('particle-bg'),
  logDock: document.getElementById('log-dock'),
  logResizeHandle: document.getElementById('log-resize-handle'),
  globalConfigPopup: document.getElementById('globalConfigPopup'),
  globalConfigBody: document.getElementById('global-config-body'),
  globalAlliesView: document.getElementById('global-allies-view'),
  globalMixedList: document.getElementById('global-mixed-list'),
  globalAlliesList: document.getElementById('global-allies-list'),
  globalEnemiesList: document.getElementById('global-enemies-list'),
  createAccountPopup: document.getElementById('createAccountPopup'),
  supplierDrawer: document.getElementById('supplierDrawer'),
  supplierDrawerBackdrop: document.getElementById('supplierDrawerBackdrop'),
  supplierDrawerBody: document.getElementById('supplier-drawer-body')
};

// 'accounts' (vista normal de cards) o 'global-allies' (tab de Aliados Globales).
let viewMode = 'accounts';

// Vista interna del pop-up de configuración: 'menu' (los botones de siempre)
// o 'schedule' (la pantalla de "Programar conexión"). Cambiar esto NO toca
// viewMode ni la tab de fondo - es contenido propio del pop-up.
let popupView = 'menu';
let createAccountTargetId = null;
let selectingLog = false;
let draggingAccountId = null;

// Estado de la alarma de "Programar conexión". Vive solo en el renderer (no
// se persiste via IPC/settings.json), asi que se resetea si cerras la app
// entera - cerrar el pop-up o cambiar de tab no la afecta. Es recurrente:
// una vez que dispara, se re-arma para el dia siguiente a la misma hora.
let scheduleConnect = {
  enabled: false,
  time: '09:00',
  timerId: null,
  accountIds: [] // <-- Guardará los IDs de las cuentas seleccionadas
};

let scheduleDisconnect = {
  enabled: false,
  time: '23:00',
  timerId: null
};

function val(map, key) {
  return map[String(key)] ?? map[key];
}

async function invoke(name, ...args) {
  try {
    const nextState = await window.ringtoss[name](...args);
    if (nextState) render(nextState);
    return nextState;
  } catch (err) {
    appendLocalLog(`[UI] ${err.message}`);
    return null;
  }
}

function accountById(accountId) {
  return state.accounts.find((account) => account.id === accountId);
}

function debounceSave(accountId) {
  // Validar que accountId sea un string válido
  accountId = String(accountId).trim();
  if (!accountId || accountId === 'undefined' || accountId === 'null' || accountId === '[object Object]') {
    appendLocalLog(`[UI] [SAVE] ID inválido, ignorando: ${accountId}`);
    return;
  }

  clearTimeout(saveTimers.get(accountId));
  saveTimers.set(accountId, setTimeout(() => {
    const account = accountById(accountId);
    if (!account || !account.id) {
      appendLocalLog(`[UI] [SAVE] Cuenta no encontrada: ${accountId}`);
      return;
    }
    invoke('saveAccount', { accountId: account.id, label: account.label, settings: account.settings });
  }, 80));
}

function appendLocalLog(message) {
  const line = `${new Date().toLocaleTimeString()} ${message}`;
  if (!els.log.textContent) els.log.textContent = line;
  else els.log.textContent += `\n${line}`;
  els.log.scrollTop = els.log.scrollHeight;
}

let firstRender = true;

function render(nextState) {
  state = nextState;

  // Los mensajes WS actualizan el estado muy seguido. Mientras el usuario
  // copia texto o escribe, solo se refresca el log: recrear el resto del DOM
  // invalidaria la seleccion y los inputs con foco.
  if (shouldDeferFullRender()) {
    pendingRenderState = nextState;
    if (!hasTextSelectionInLog()) renderLog();
    return;
  }

  particleBackground?.setEnabled(state.visualEffects?.particlesEnabled !== false);
  if (firstRender && openAccounts.size === 0 && state.accounts[0]) {
    openAccounts.add(state.accounts[0].id);
    firstRender = false;
  }
  for (const account of state.accounts) {
    if (!selectedPeople.has(account.id)) selectedPeople.set(account.id, { id: null, side: null });
  }

  // Guardar scroll de la ventana principal
  const savedScrollY = window.scrollY;

  // Guardar elemento enfocado y su estado
  const focusedElement = document.activeElement;
  const focusIdentifier = focusedElement && focusedElement !== document.body 
    ? `${focusedElement.dataset?.accountId || ''}:${focusedElement.dataset?.field || focusedElement.id || ''}`
    : null;
  const focusedValue = focusedElement?.value;
  const canRestoreSelection = supportsTextSelection(focusedElement);
  const focusedSelectionStart = canRestoreSelection ? focusedElement.selectionStart : null;
  const focusedSelectionEnd = canRestoreSelection ? focusedElement.selectionEnd : null;

  renderGlobalStatus();
  renderAccounts();
  renderLogTabs();
  renderLog();
  renderChatComposer();
  renderGlobalAlliesView();
  renderSupplierDrawer();
  applyViewMode();

  // Restaurar scroll de la ventana principal
  if (savedScrollY > 0) window.scrollTo(0, savedScrollY);

  // Restaurar focus y estado del input
  if (focusIdentifier && focusedElement !== document.body) {
    const [accountId, field] = focusIdentifier.split(':');
    let targetElement = null;
    
    if (accountId && field) {
      targetElement = document.querySelector(`[data-account-id="${accountId}"][data-field="${field}"]`);
    } else if (!accountId && field) {
      targetElement = document.getElementById(field);
    }
    
    if (targetElement) {
      targetElement.focus();
      if (focusedValue !== undefined && targetElement.value !== focusedValue) {
        targetElement.value = focusedValue;
      }
      if (supportsTextSelection(targetElement) && focusedSelectionStart !== null && focusedSelectionEnd !== null) {
        targetElement.setSelectionRange(focusedSelectionStart, focusedSelectionEnd);
      }
    }
  }
}

function hasTextSelection() {
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) return true;

  const active = document.activeElement;
  return supportsTextSelection(active) && active.selectionStart !== active.selectionEnd;
}

function hasTextSelectionInLog() {
  const selection = window.getSelection();
  return Boolean(
    selection
    && selection.rangeCount > 0
    && !selection.isCollapsed
    && (els.log.contains(selection.anchorNode) || els.log.contains(selection.focusNode))
  );
}

function hasFocusedEditableElement() {
  const active = document.activeElement;
  return Boolean(active && active.matches && active.matches('input, textarea, select, [contenteditable="true"]'));
}

function shouldDeferFullRender() {
  return hasTextSelection() || hasFocusedEditableElement() || draggingAccountId;
}

function flushPendingRender() {
  if (!pendingRenderState || shouldDeferFullRender()) return;
  const nextState = pendingRenderState;
  pendingRenderState = null;
  render(nextState);
}

function supportsTextSelection(element) {
  if (!element || typeof element.setSelectionRange !== 'function') return false;
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName !== 'INPUT') return false;
  return ['text', 'password', 'search', 'tel', 'url', 'email'].includes(element.type);
}

function renderGlobalStatus() {
  const connected = state.accounts.filter((account) => account.runtime.connection.status === 'connected').length;
  els.globalStatus.innerHTML = `
    <span class="pill">${state.accounts.length} cuenta(s)</span>
    <span>${connected} conectada(s)</span>
    <span>Logs por cuenta abajo</span>
  `;
}

function renderAccounts() {
  // Guardar scroll de cada .people-list antes de destruir el DOM
  const scrollPositions = new Map();
  els.accounts.querySelectorAll('.people-list').forEach((list) => {
    const column = list.closest('.people-column');
    const panel = list.closest('.players-panel');
    const card = list.closest('[data-account-id]');
    if (!card) return;
    const accountId = card.dataset.accountId;
    const isAlly = column && column.querySelector('.column-title')?.textContent?.trim() === 'Aliados';
    const key = `${accountId}:${isAlly ? 'ally' : 'enemy'}`;
    if (list.scrollTop > 0) scrollPositions.set(key, list.scrollTop);
  });

  els.accounts.innerHTML = state.accounts.map(renderAccount).join('');

  // Restaurar scroll de cada .people-list
  if (scrollPositions.size > 0) {
    els.accounts.querySelectorAll('.people-list').forEach((list) => {
      const column = list.closest('.people-column');
      const card = list.closest('[data-account-id]');
      if (!card) return;
      const accountId = card.dataset.accountId;
      const isAlly = column && column.querySelector('.column-title')?.textContent?.trim() === 'Aliados';
      const key = `${accountId}:${isAlly ? 'ally' : 'enemy'}`;
      const saved = scrollPositions.get(key);
      if (saved !== undefined) list.scrollTop = saved;
    });
  }
}

function renderAccount(account) {
  const status = account.runtime.connection.status || 'disconnected';
  const wheelAvailable = account.runtime.connection.loginMode === 'pc';
  const identity = account.bot.userId ? `${account.bot.nickname || '-'} (${account.bot.userId})` : 'Sin sesion';
  const open = openAccounts.has(account.id) ? 'open' : '';

  return `
    <details class="account-card" data-account-id="${account.id}" ${open}>
      <summary class="account-summary">
        <span class="account-drag-handle" draggable="true" title="Arrastrar para reordenar cuentas">&gt;</span>
        <span class="account-name">${escapeHtml(account.label)}</span>
        <span class="pill ${status === 'connected' ? 'connected' : ''} ${status === 'error' ? 'error' : ''}">${status}</span>
        <span>${escapeHtml(identity)}</span>
        <span>Planeta: ${escapeHtml(account.bot.currentPlanetName || account.settings.planetName || '-')}</span>
        <span>ID: ${account.bot.gameId || '-'}</span>
        <span class="summary-spacer"></span>
        <button type="button" class="btn-remove summary-remove" data-action="remove-account" data-account-id="${account.id}" ${state.accounts.length <= 1 ? 'disabled' : ''}>Quitar</button>
      </summary>

      <div class="account-body">
        <section class="panel compact connection-panel">
          <div class="panel-title">Cuenta</div>
          <div class="account-form-grid">
            <label>
              Nombre
              <input type="text" data-account-id="${account.id}" data-field="label" value="${escapeAttr(account.label)}" spellcheck="false">
            </label>
            <label class="recover-field">
              Codigo / RECOVER
              <input type="text" data-account-id="${account.id}" data-field="recoverPassword" value="${escapeAttr(account.settings.recoverPassword || '')}" spellcheck="false" autocomplete="off">
            </label>
            <label>
              Planeta
              <input type="text" data-account-id="${account.id}" data-field="planetName" value="${escapeAttr(account.settings.planetName)}" spellcheck="false">
            </label>
            <label class="switch inline-switch">
              <input type="checkbox" data-account-id="${account.id}" data-field="botEnabled" ${account.settings.botEnabled ? 'checked' : ''}>
              <span>Bot activo</span>
            </label>
            <div class="button-row">
              <button type="button" class="btn-create" data-action="open-create-account" data-account-id="${account.id}">Crear</button>
              <button type="button" class="btn-connect" data-action="connect" data-account-id="${account.id}">Conectar</button>
              <button type="button" class="btn-disconnect" data-action="disconnect" data-account-id="${account.id}">Desconectar</button>
              <button type="button" class="btn-fly" data-action="fly" data-account-id="${account.id}">Volar</button>
              <label class="switch inline-switch" title="Solo define el modo del próximo login">
                <input type="checkbox" data-account-id="${account.id}" data-field="loginMode" ${account.settings.loginMode === 'mobile' ? 'checked' : ''}>
                <span>Móvil</span>
              </label>
            </div>
          </div>
          <div class="proxy-grid">
            <label class="switch inline-switch proxy-toggle">
              <input type="checkbox" data-account-id="${account.id}" data-field="proxyEnabled" ${account.settings.proxy?.enabled ? 'checked' : ''}>
              <span>Proxy HTTP</span>
            </label>
            <label>
              IP / Host
              <input type="text" data-account-id="${account.id}" data-field="proxyHost" value="${escapeAttr(account.settings.proxy?.host || '')}" spellcheck="false">
            </label>
            <label>
              Puerto
              <input type="text" inputmode="numeric" data-account-id="${account.id}" data-field="proxyPort" value="${escapeAttr(account.settings.proxy?.port || '')}" spellcheck="false">
            </label>
            <label>
              User
              <input type="text" data-account-id="${account.id}" data-field="proxyUsername" value="${escapeAttr(account.settings.proxy?.username || '')}" spellcheck="false" autocomplete="off">
            </label>
            <label>
              Password
              <input type="text" data-account-id="${account.id}" data-field="proxyPassword" value="${escapeAttr(account.settings.proxy?.password || '')}" autocomplete="off">
            </label>
            <div class="device-hint">Login ${account.settings.loginMode === 'mobile' ? 'móvil' : 'PC (Chrome web)'} | ${account.settings.loginMode === 'mobile' ? 'Solo juego; regalos requieren PC' : 'Sesión HTTP compartida para juego y regalos'}</div>
          </div>
        </section>

        <section class="ring-grid">${renderRings(account)}</section>

        <section class="account-lower-grid">
          <section class="panel">
            <div class="panel-title">Postes</div>
            <div class="postes">${renderPostes(account)}</div>
          </section>

          <section class="panel gift-panel">
            <div class="panel-title">Regalos</div>
            <label>
              ID destino
              <input type="text" inputmode="numeric" data-account-id="${account.id}" data-field="giftTarget" value="${escapeAttr(account.settings.giftTarget)}" spellcheck="false">
            </label>
            <label class="check-line">
              <input type="checkbox" data-account-id="${account.id}" data-field="giftAnonymous" ${account.settings.giftAnonymous ? 'checked' : ''}>
              <span>Anonimo</span>
            </label>
            <label class="check-line">
              <input type="checkbox" data-account-id="${account.id}" data-field="autoInventoryGiftEnabled" ${account.settings.autoInventoryGiftEnabled ? 'checked' : ''}>
              <span>Auto-enviar cada hora (rueda + inventario)</span>
            </label>
            <button type="button" class="btn-gift" data-action="send-gift" data-account-id="${account.id}" ${account.runtime.giftRunning || account.runtime.autoInventoryGiftRunning ? 'disabled' : ''}>
              ${account.runtime.giftRunning ? 'Enviando...' : account.runtime.autoInventoryGiftRunning ? 'Proceso automático...' : 'Enviar inventario'}
            </button>
            <div class="hint">Items: ${state.shared.giftItemIds.join(', ')}</div>
            <div class="hint">Auto: todos salvo 14, 15, 16, 22 y 23</div>
            <button type="button" class="btn-gift" data-action="spin-wheel" data-account-id="${account.id}" ${account.runtime.wheelRunning || account.runtime.autoInventoryGiftRunning || !wheelAvailable ? 'disabled' : ''}>
              ${account.runtime.wheelRunning ? 'Girando...' : account.runtime.autoInventoryGiftRunning ? 'Proceso automático...' : 'Girar rueda gratis'}
            </button>
          </section>

          <section class="panel players-panel">
            <div class="panel-title">Jugadores</div>
            ${renderPeople(account)}
          </section>
        </section>
      </div>
    </details>
  `;
}

function renderRings(account) {
  return state.shared.ringOrder.map((key) => {
    const ring = state.shared.rings[key];
    const config = account.settings.rings[key];
    const stackRows = [0, 1, 2, 3].map((stack) => {
      const stackConfig = config.stacks[String(stack)];
      return `
        <tr>
          <td>
            <label class="check-line">
              <input type="checkbox" data-account-id="${account.id}" data-ring="${key}" data-stack="${stack}" data-field="stack-enabled" ${stackConfig.enabled ? 'checked' : ''}>
              <span>Anillo ${stack + 1}</span>
            </label>
          </td>
          <td>
            <div class="spike-options">
              ${spikeRadio(account.id, key, stack, 'none', 'Sin', stackConfig.spike)}
              ${spikeRadio(account.id, key, stack, 'titanium', 'Titanio', stackConfig.spike)}
              ${spikeRadio(account.id, key, stack, 'diamond', 'Diamante', stackConfig.spike)}
            </div>
          </td>
        </tr>
      `;
    }).join('');

    return `
      <article class="ring-card">
        <div class="ring-header">
          <div class="ring-title">
            <span class="swatch" style="background:${ring.color}"></span>
            <span>${ring.label}</span>
          </div>
          <label class="check-line">
            <input type="checkbox" data-account-id="${account.id}" data-ring="${key}" data-field="ring-enabled" ${config.enabled ? 'checked' : ''}>
            <span>Usar</span>
          </label>
        </div>
        <div class="directive-grid">
          <label class="check-line">
            <input type="checkbox" data-account-id="${account.id}" data-ring="${key}" data-field="primary-titanium" ${config.primary.titanium ? 'checked' : ''}>
            <span>Responder titanio con titanio</span>
          </label>
          <label class="check-line">
            <input type="checkbox" data-account-id="${account.id}" data-ring="${key}" data-field="primary-diamond" ${config.primary.diamond ? 'checked' : ''}>
            <span>Responder diamante con diamante</span>
          </label>
          ${key === 'gold' ? `
            <label class="check-line">
              <input type="checkbox" data-account-id="${account.id}" data-ring="${key}" data-field="primary-diamond-except-fourth" ${config.primary.diamondExceptFourth ? 'checked' : ''}>
              <span>Responder diamante con diamante (excepto anillo 4)</span>
            </label>
          ` : ''}
        </div>
        <table class="stack-table">
          <thead>
            <tr>
              <th>Cuando</th>
              <th>Espinas secundarias</th>
            </tr>
          </thead>
          <tbody>${stackRows}</tbody>
        </table>
      </article>
    `;
  }).join('');
}

function spikeRadio(accountId, ring, stack, value, label, current) {
  return `
    <label>
      <input type="radio" name="${accountId}-${ring}-${stack}-spike" data-account-id="${accountId}" data-ring="${ring}" data-stack="${stack}" data-field="stack-spike" value="${value}" ${current === value ? 'checked' : ''}>
      <span>${label}</span>
    </label>
  `;
}

function renderPostes(account) {
  const people = new Map(account.bot.people.map((person) => [person.id, person]));
  return [1, 2, 3].map((poste) => {
    const lastUser = val(account.bot.lastUser, poste);
    const person = lastUser ? people.get(lastUser) : null;
    const userLabel = person ? `${person.name} (${person.id})` : lastUser || '-';
    const stack = val(account.bot.posteState, poste);
    const spikes = val(account.bot.hasSpikes, poste);
    const diamond = val(account.bot.hasDiamond, poste);
    return `
      <div class="poste">
        <strong>Poste ${poste}</strong>
        <span>Stack: ${stack === null ? '?' : stack}</span>
        <span>Ultimo: ${escapeHtml(userLabel)}</span>
        <span class="muted">Titanio: ${spikes ? 'si' : 'no'} | Diamante: ${diamond ? 'si' : 'no'}</span>
      </div>
    `;
  }).join('');
}

function renderPeople(account) {
  const selected = selectedPeople.get(account.id) || { id: null, side: null };
  const selectedStillExists = account.bot.people.some(
    (person) => person.id === selected.id && (person.ally ? 'ally' : 'enemy') === selected.side
  );
  if (!selectedStillExists) selectedPeople.set(account.id, { id: null, side: null });

  const enemies = account.bot.people.filter((person) => !person.ally);
  const allies = account.bot.people.filter((person) => person.ally);
  const newEnemies = account.settings.newPlayersAreEnemies !== false;
  return `
    <div class="new-player-rule">
      <span>Jugadores nuevos entran como enemigos</span>
      <label class="rule-switch ${newEnemies ? 'enemy' : 'ally'}">
        <input type="checkbox" data-account-id="${account.id}" data-field="newPlayersAreEnemies" ${newEnemies ? 'checked' : ''}>
        <span></span>
      </label>
    </div>
    <div class="allies-board">
      <div class="people-column">
        <div class="column-title">Enemigos</div>
        <div class="people-list">${peopleRows(account.id, enemies, 'enemy')}</div>
      </div>
      <div class="move-column">
        <button type="button" class="secondary move-btn" data-action="move-person" data-account-id="${account.id}" ${selectedPeople.get(account.id).id ? '' : 'disabled'}>&lt;---&gt;</button>
      </div>
      <div class="people-column">
        <div class="column-title">Aliados</div>
        <div class="people-list">${peopleRows(account.id, allies, 'ally')}</div>
      </div>
    </div>
  `;
}

function peopleRows(accountId, people, side) {
  const selected = selectedPeople.get(accountId) || { id: null, side: null };
  if (people.length === 0) return '<button type="button" class="person empty" disabled>-</button>';
  return people.map((person) => {
    const isSelected = selected.id === person.id && selected.side === side;
    return `
      <button type="button" class="person ${isSelected ? 'selected' : ''}" data-action="select-person" data-account-id="${accountId}" data-user-id="${person.id}" data-side="${side}">
        <span class="person-name">${escapeHtml(person.name)}</span>
        <span class="person-id">${person.id}</span>
      </button>
    `;
  }).join('');
}

function renderLogTabs() {
  const activeId = state.activeLogAccountId || state.accounts[0]?.id;
  const tabs = state.accounts.map((account) => {
    const status = account.runtime.connection.status || 'disconnected';
    return `
      <button type="button" class="log-tab ${account.id === activeId ? 'active' : ''}" data-action="log-tab" data-account-id="${account.id}">
        <span class="tab-dot ${status}"></span>
        ${escapeHtml(account.label)}
      </button>
    `;
  }).join('');
  const logMode = state.logMode === 'chat' ? 'chat' : 'debug';
  els.logTabs.innerHTML = `
    <div class="log-tab-list">${tabs}</div>
    <button type="button" class="btn-clear-log" data-action="clear-log" data-account-id="${activeId}">Clear</button>
    <div class="mode-segmented ${logMode}">
      <button type="button" data-action="set-log-mode" data-mode="debug">Modo Debug</button>
      <button type="button" data-action="set-log-mode" data-mode="chat">Modo Chat</button>
    </div>
  `;
}

function renderLog() {
  if (selectingLog) return;
  const activeId = state.activeLogAccountId || state.accounts[0]?.id;
  const account = accountById(activeId) || state.accounts[0];
  const logMode = state.logMode === 'chat' ? 'chat' : 'debug';
  const sourceLogs = logMode === 'chat'
    ? (account?.logs || []).filter((line) => line.type === 'chat')
    : (account?.logs || []).filter((line) => line.type !== 'chat');
  const lines = sourceLogs
    .slice(-320)
    .map((line) => {
      if (logMode === 'chat') return `[${formatChatDate(line.ts)}]  ${line.message}`;
      return `${new Date(line.ts).toLocaleTimeString()} ${line.message}`;
    })
    .join('\n');
  const log = els.log;
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  const savedScrollTop = log.scrollTop;

  log.textContent = lines;

  if (atBottom) {
    // Estaba al fondo → seguir al fondo
    log.scrollTop = log.scrollHeight;
  } else {
    // Estaba scrolleado hacia arriba → las líneas nuevas aparecen abajo,
    // sin desplazar lo que el usuario está leyendo o copiando.
    log.scrollTop = savedScrollTop;
  }
}

function renderChatComposer() {
  const existingMenu = els.chatComposer.querySelector('.recipient-menu');
  if (existingMenu) {
    chatMenuScrolls.set(existingMenu.dataset.accountId || 'active', existingMenu.scrollTop);
  }

  const activeId = state.activeLogAccountId || state.accounts[0]?.id;
  const account = accountById(activeId);
  if (!account || state.logMode !== 'chat') {
    els.chatComposer.innerHTML = '';
    els.chatComposer.classList.remove('visible');
    return;
  }

  const selected = selectedChatTargets.get(activeId) || { recipientId: '0', recipientName: '' };
  const people = account.bot.people || [];
  const draft = chatDrafts.get(activeId) || '';
  els.chatComposer.classList.add('visible');
  els.chatComposer.innerHTML = `
    <div class="recipient-wrap">
      ${chatMenuOpen ? `
        <div class="recipient-menu" data-account-id="${activeId}">
          <button type="button" data-action="chat-recipient" data-account-id="${activeId}" data-recipient-id="0" data-recipient-name="">Sin destinatario</button>
          ${people.map((person) => `
            <button type="button" data-action="chat-recipient" data-account-id="${activeId}" data-recipient-id="${person.id}" data-recipient-name="${escapeAttr(person.name)}">
              ${escapeHtml(person.name)} <span>${person.id}</span>
            </button>
          `).join('')}
        </div>
      ` : ''}
      <button type="button" class="recipient-btn" data-action="chat-recipient-toggle" data-account-id="${activeId}">
        ID: ${selected.recipientId && selected.recipientId !== '0' ? selected.recipientId : '-'} <span>^</span>
      </button>
    </div>
    <input type="text" id="chat-input" value="${escapeAttr(draft)}" placeholder="Escribir mensaje..." autocomplete="off">
    <button type="button" class="chat-send-btn" data-action="chat-send" data-account-id="${activeId}">Enviar</button>
  `;

  const menu = els.chatComposer.querySelector('.recipient-menu');
  if (menu) {
    menu.scrollTop = chatMenuScrolls.get(activeId) || 0;
    menu.addEventListener('scroll', () => {
      chatMenuScrolls.set(activeId, menu.scrollTop);
    }, { passive: true });
  }
}
// ============================================================
// CONFIGURACIÓN GLOBAL (POP-UP, ALIADOS GLOBALES, CONTROLES MASIVOS)
// ============================================================
//
// Todo lo de esta seccion son funciones puras de datos + render. Los clicks
// (abrir/cerrar popup, conectar/desconectar/auto-enviar todas, entrar/salir
// de la tab de Aliados Globales, mover una persona de columna) se manejan
// todos en handleClick() via data-action, igual que el resto de la UI. No
// hay listeners propios aca: el renderer no tiene acceso directo a
// RingtossBot/GalaxyClient (esos viven en el proceso main), asi que toda
// accion real pasa por invoke(...) -> window.ringtoss.* -> IPC -> main.js.

function openGlobalConfig() {
  popupView = 'menu';
  renderGlobalConfigPopup();
  els.globalConfigPopup.style.display = 'block';
}

function closeGlobalConfig() {
  els.globalConfigPopup.style.display = 'none';
}

function openCreateAccount(accountId) {
  createAccountTargetId = String(accountId || '').trim();
  if (!createAccountTargetId || !els.createAccountPopup) return;
  els.createAccountPopup.style.display = 'flex';
  const nickInput = document.getElementById('create-account-nick');
  const genderToggle = document.getElementById('create-account-gender');
  if (nickInput) nickInput.value = '';
  if (genderToggle) genderToggle.checked = false;
  setTimeout(() => nickInput?.focus(), 0);
}

function closeCreateAccount() {
  createAccountTargetId = null;
  if (els.createAccountPopup) els.createAccountPopup.style.display = 'none';
}

function submitCreateAccount() {
  if (!createAccountTargetId) return;
  const nickInput = document.getElementById('create-account-nick');
  const genderToggle = document.getElementById('create-account-gender');
  const account = accountById(createAccountTargetId);
  const nickname = nickInput ? nickInput.value.trim() : '';
  const gender = genderToggle?.checked ? 1 : 0;
  invoke('createAccount', {
    accountId: createAccountTargetId,
    nickname,
    gender,
    settings: account?.settings
  });
  closeCreateAccount();
}

// Dispara lo mismo que el botón "Conectar" de cada card, para todas las
// cuentas existentes en ese momento. La comparten el click manual de
// "Conectar todas" y el disparo automático de la alarma programada.
function connectAllAccounts() {
  if (!state || !Array.isArray(state.accounts)) return;
  for (const acc of state.accounts) {
    invoke('connect', {
      accountId: acc.id,
      recoverPassword: acc.settings.recoverPassword || '',
      loginMode: acc.settings.loginMode
    });
  }
}

function disconnectAllAccounts() {
  if (!state || !Array.isArray(state.accounts)) return;
  for (const acc of state.accounts) {
    invoke('disconnect', { accountId: acc.id });
  }
}

function renderGlobalConfigPopup() {
  if (!els.globalConfigBody) return;
  els.globalConfigBody.innerHTML =
    popupView === 'schedule-connect' ? renderScheduleConnectView()
      : popupView === 'schedule-disconnect' ? renderScheduleDisconnectView()
        : renderGlobalConfigMenu();
}

function renderGlobalConfigMenu() {
  const scheduleLabel = scheduleConnect.enabled
    ? `Programar conexión (activado, ${escapeHtml(scheduleConnect.time)})`
    : 'Programar conexión';
  const disconnectLabel = scheduleDisconnect.enabled
    ? `Programar desconexión (activado, ${escapeHtml(scheduleDisconnect.time)})`
    : 'Programar desconexión';
  const sharedAllies = state.sharedAllies || {};
  const telegram = state.telegram || {};
  const sharedStatus = sharedAllies.syncing
    ? 'Sincronizando aliados...'
    : sharedAllies.lastError
      ? `Error: ${sharedAllies.lastError}`
      : sharedAllies.lastSyncAt
        ? `Actualizado: ${formatChatDate(sharedAllies.lastSyncAt)}`
        : 'Pendiente de sincronizar';
  return `
    <div class="config-section">
      <button type="button" data-action="connect-all">Conectar todas</button>
      <button type="button" data-action="disconnect-all">Desconectar todas</button>
      <button type="button" data-action="auto-send-all">Auto-Enviar Todo</button>
      <button type="button" class="secondary" data-action="open-schedule-connect">${scheduleLabel}</button>
      <button type="button" class="secondary" data-action="open-schedule-disconnect">${disconnectLabel}</button>
      <button type="button" class="secondary" data-action="open-global-allies">Aliados Globales</button>
      <div class="supplier-field">
        <label>Chat ID de Telegram</label>
        <input type="text" id="telegram-chat-id" value="${escapeAttr(telegram.chatId || '')}" inputmode="numeric" spellcheck="false" autocomplete="off" placeholder="Ej.: 8290543575">
        <div class="hint">${escapeHtml(telegram.lastError ? `Error: ${telegram.lastError}` : telegram.lastSyncAt ? `Telegram actualizado: ${formatChatDate(telegram.lastSyncAt)}` : 'Usá tu propio chat_id en cada PC')}</div>
        <button type="button" class="secondary" data-action="save-telegram-chat-id">Guardar Telegram</button>
      </div>
      <div class="supplier-field">
        <label>ID adicional para mensajes de Telegram</label>
        <input type="text" id="telegram-external-account-id" value="${escapeAttr(telegram.externalAccountId || '')}" inputmode="numeric" spellcheck="false" autocomplete="off" placeholder="ID de cuenta en el mismo planeta">
        <div class="hint">También notifica mensajes dirigidos a este ID, si alguna cuenta abierta recibe ese PRIVMSG.</div>
        <button type="button" class="secondary" data-action="save-telegram-external-account-id">Guardar ID adicional</button>
      </div>
      <div class="supplier-field">
        <label>Código de aliados compartidos</label>
        <input type="text" id="shared-allies-group-code" value="${escapeAttr(sharedAllies.groupCode || '')}" spellcheck="false" autocomplete="off">
        <div class="hint">${escapeHtml(sharedStatus)}</div>
        <button type="button" class="secondary" data-action="save-shared-allies-group">Guardar y sincronizar</button>
        <button type="button" class="secondary" data-action="sync-shared-allies" ${sharedAllies.syncing || !sharedAllies.groupCode ? 'disabled' : ''}>Sincronizar ahora</button>
      </div>
      <label class="check-line">
        <input type="checkbox" id="particles-enabled-toggle" ${state.visualEffects?.particlesEnabled !== false ? 'checked' : ''}>
        <span>Partículas de fondo</span>
      </label>
    </div>
  `;
}

function renderSupplierDrawer() {
  if (!els.supplierDrawerBody) return;
  const s = state.supplier || {};
  const items = s.items || [];
  const accountOptions = state.accounts
    .map((acc) => `<option value="${escapeAttr(acc.id)}" ${s.supplierAccountId === acc.id ? 'selected' : ''}>${escapeHtml(acc.label)}</option>`)
    .join('');

  let statusText;
  let statusClass = 'supplier-status';
  if (s.checking) {
    statusText = 'Revisando ahora...';
    statusClass += ' checking';
  } else if (s.lastCheckAt) {
    statusText = `Última revisión: ${formatChatDate(s.lastCheckAt)}`;
  } else {
    statusText = 'Todavía no se hizo ninguna revisión';
  }

  // Generamos dinámicamente las filas de los ítems monitoreados
  const itemsHtml = items.map((item, index) => {
    return `
      <div class="supplier-item-row" data-index="${index}">
        <input type="text" class="supplier-item-id" value="${escapeAttr(item.itemId)}" placeholder="ID Ítem" title="ID del ítem">
        <input type="number" class="supplier-item-threshold" min="0" value="${escapeAttr(item.threshold)}" placeholder="Umbral" title="Umbral mínimo">
        <input type="number" class="supplier-item-send" min="1" value="${escapeAttr(item.sendAmount)}" placeholder="Cant." title="Cantidad a enviar">
        <button type="button" class="btn-remove mini-supplier-remove" data-action="remove-supplier-item" data-index="${index}" title="Eliminar ítem">✕</button>
      </div>
    `;
  }).join('');

  els.supplierDrawerBody.innerHTML = `
    <div class="supplier-field">
      <label>Cuenta proveedora</label>
      <select id="supplier-account-select">
        <option value="">-- Elegir cuenta --</option>
        ${accountOptions}
      </select>
    </div>

    <div class="new-player-rule">
      <span>Activado</span>
      <label class="rule-switch ${s.enabled ? 'on' : 'off'}">
        <input type="checkbox" id="supplier-enabled-toggle" ${s.enabled ? 'checked' : ''}>
        <span></span>
      </label>
    </div>

    <div class="supplier-field">
      <label>Ítems a monitorear</label>
      <div class="supplier-items-container">
        <div class="supplier-items-header">
          <span>ID Ítem</span>
          <span>Umbral</span>
          <span>Envío</span>
          <span></span>
        </div>
        <div id="supplier-items-list">
          ${itemsHtml}
        </div>
        <button type="button" class="secondary" data-action="add-supplier-item" style="margin-top: 8px; width: 100%; min-height: 28px;">+ Agregar ítem</button>
      </div>
    </div>

    <div class="supplier-field">
      <label>Revisar cada (minutos)</label>
      <input type="number" id="supplier-interval-input" min="1" value="${escapeAttr(s.intervalMinutes)}">
    </div>

    <div class="${statusClass}">${escapeHtml(statusText)}</div>

    <button type="button" data-action="check-supplier-now" ${s.checking ? 'disabled' : ''}>
      ${s.checking ? 'Revisando...' : 'Revisar ahora'}
    </button>
  `;
}

function renderScheduleConnectView() {
  const nextLabel = scheduleConnect.enabled
    ? formatScheduleNext(nextOccurrence(scheduleConnect.time))
    : 'Sin programar';

  // Generamos los checkboxes de las cuentas actuales
  const accountsHtml = state.accounts.map((acc) => {
    const isChecked = scheduleConnect.accountIds.includes(acc.id);
    return `
      <label class="check-line" style="margin-bottom: 5px; justify-content: flex-start; display: flex;">
        <input type="checkbox" class="schedule-acc-checkbox" data-account-id="${acc.id}" ${isChecked ? 'checked' : ''}>
        <span style="font-size: 12px; margin-left: 6px;">${escapeHtml(acc.label)}</span>
      </label>
    `;
  }).join('');

  return `
    <div class="config-section schedule-connect">
      <button type="button" class="secondary btn-back" data-action="schedule-back">&larr; Volver</button>
      <h4>Programar conexión</h4>
      <p class="muted">A la hora elegida se conectarán automáticamente las cuentas marcadas.</p>
      
      <label class="schedule-time-row" style="margin-bottom: 12px;">
        <span>Hora</span>
        <input type="time" id="schedule-time-input" value="${escapeAttr(scheduleConnect.time)}">
      </label>
      
      <div class="supplier-field" style="margin-bottom: 12px; text-align: left;">
        <label style="margin-bottom: 5px; font-weight: bold;">Cuentas a conectar:</label>
        <div style="max-height: 120px; overflow-y: auto; border: 1px solid var(--line-soft); padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.3);">
          ${accountsHtml || '<span class="muted" style="font-size:11px;">No hay cuentas agregadas</span>'}
        </div>
      </div>

      <div class="new-player-rule" style="margin-bottom: 10px;">
        <span>Activado</span>
        <label class="rule-switch ${scheduleConnect.enabled ? 'on' : 'off'}">
          <input type="checkbox" id="schedule-enabled-toggle" ${scheduleConnect.enabled ? 'checked' : ''}>
          <span></span>
        </label>
      </div>
      <p class="schedule-next muted" style="font-size:11px;">${escapeHtml(nextLabel)}</p>
    </div>
  `;
}

function renderScheduleDisconnectView() {
  const nextLabel = scheduleDisconnect.enabled
    ? formatScheduleNext(nextOccurrence(scheduleDisconnect.time), 'desconexión')
    : 'Sin programar';

  return `
    <div class="config-section">
      <h4>Programar desconexión</h4>
      <p class="muted">A la hora elegida se desconectarán todas las cuentas de juego.</p>
      <label class="schedule-time-row" style="margin-bottom: 12px;">
        <span>Hora</span>
        <input type="time" id="schedule-disconnect-time-input" value="${escapeAttr(scheduleDisconnect.time)}">
      </label>
      <div class="new-player-rule" style="margin-bottom: 10px;">
        <span>Activado</span>
        <label class="rule-switch ${scheduleDisconnect.enabled ? 'on' : 'off'}">
          <input type="checkbox" id="schedule-disconnect-enabled-toggle" ${scheduleDisconnect.enabled ? 'checked' : ''}>
          <span></span>
        </label>
      </div>
      <p class="schedule-next muted" style="font-size:11px;">${escapeHtml(nextLabel)}</p>
    </div>
  `;
}

// Proxima ocurrencia de "HH:MM" desde ahora: hoy si todavia no paso, si no
// mañana. No usa segundos (input type=time trabaja en minutos).
function nextOccurrence(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map((n) => parseInt(n, 10) || 0);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

function formatScheduleNext(date, action = 'conexión') {
  const now = new Date();
  const isToday = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const two = (v) => String(v).padStart(2, '0');
  const hhmm = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return `Próxima ${action} automática: ${isToday ? 'hoy' : 'mañana'} a las ${hhmm}`;
}

function clearScheduledConnectTimer() {
  if (scheduleConnect.timerId) {
    clearTimeout(scheduleConnect.timerId);
    scheduleConnect.timerId = null;
  }
}

function armScheduledConnect() {
  clearScheduledConnectTimer();
  if (!scheduleConnect.enabled) {
    renderGlobalConfigPopup();
    return;
  }
  const next = nextOccurrence(scheduleConnect.time);
  const delay = next.getTime() - Date.now();
  scheduleConnect.timerId = setTimeout(() => {
    connectAllAccounts();
    armScheduledConnect(); // recurrente: se re-arma para el dia siguiente
  }, Math.max(0, delay));
  renderGlobalConfigPopup();
}

function clearScheduledDisconnectTimer() {
  if (!scheduleDisconnect.timerId) return;
  clearTimeout(scheduleDisconnect.timerId);
  scheduleDisconnect.timerId = null;
}

function armScheduledDisconnect() {
  clearScheduledDisconnectTimer();
  if (!scheduleDisconnect.enabled) {
    renderGlobalConfigPopup();
    return;
  }
  const next = nextOccurrence(scheduleDisconnect.time);
  const delay = next.getTime() - Date.now();
  scheduleDisconnect.timerId = setTimeout(() => {
    disconnectAllAccounts();
    armScheduledDisconnect();
  }, Math.max(0, delay));
  renderGlobalConfigPopup();
}

function applyViewMode() {
  const showingAllies = viewMode === 'global-allies';
  els.accounts.style.display = showingAllies ? 'none' : '';
  els.globalAlliesView.style.display = showingAllies ? '' : 'none';
}

// Junta los IDs de account.bot.people de todas las cuentas (ya deduplicados
// por cuenta) en un solo roster global, sin repetir IDs que aparezcan en mas
// de una cuenta. Si dos cuentas ven al mismo ID con distinto ally (una lo
// tiene de aliado, otra de enemigo), esa persona es "Mixed": no hay forma de
// saber desde esta vista cual de las dos cuentas "tiene razon".
function computeGlobalRoster() {
  const byId = new Map();
  if (state && Array.isArray(state.accounts)) {
    for (const account of state.accounts) {
      for (const person of account.bot.people || []) {
        let entry = byId.get(person.id);
        if (!entry) {
          entry = { id: person.id, name: person.name, allyStates: new Set(), accountIds: [] };
          byId.set(person.id, entry);
        }
        entry.allyStates.add(Boolean(person.ally));
        entry.accountIds.push(account.id);
        if (person.name) entry.name = person.name;
      }
    }
  }

  const mixed = [];
  const allies = [];
  const enemies = [];
  for (const entry of byId.values()) {
    const person = { id: entry.id, name: entry.name, accountIds: entry.accountIds };
    if (entry.allyStates.size > 1) mixed.push(person);
    else if (entry.allyStates.has(true)) allies.push(person);
    else enemies.push(person);
  }

  const byName = (a, b) => (a.name || '').localeCompare(b.name || '') || String(a.id).localeCompare(String(b.id));
  mixed.sort(byName);
  allies.sort(byName);
  enemies.sort(byName);
  return { mixed, allies, enemies };
}

// Mueve una persona a Aliados o Enemigos aplicando el cambio en TODAS las
// cuentas que la tengan en su roster (asi es como se resuelve un "Mixed": se
// hace que todas coincidan). Nunca hay un "mover a Mixed" - no existe ese
// action en ningun lado de la UI.
function moveGlobalPerson(personId, nextSide) {
  if (nextSide !== 'ally' && nextSide !== 'enemy') return;
  const { mixed, allies, enemies } = computeGlobalRoster();
  const person = [...mixed, ...allies, ...enemies].find((p) => p.id === personId);
  if (!person) return;
  invoke('setGlobalPerson', { userId: personId, nickname: person.name, nextSide });
}

function globalPersonRow(person, column) {
  // No se ofrece el boton hacia la propia columna (ej: alguien ya unanime
  // como aliado no necesita un boton "-> Aliados").
  const toAlly = column !== 'allies';
  const toEnemy = column !== 'enemies';
  return `
    <div class="person global-person">
      <span class="person-name">${escapeHtml(person.name)}</span>
      <span class="person-id">${person.id}</span>
      <span class="global-person-actions">
        ${toAlly ? `<button type="button" class="mini-btn ally" data-action="move-global-person" data-person-id="${person.id}" data-next-side="ally">&rarr; Aliados</button>` : ''}
        ${toEnemy ? `<button type="button" class="mini-btn enemy" data-action="move-global-person" data-person-id="${person.id}" data-next-side="enemy">&rarr; Enemigos</button>` : ''}
      </span>
    </div>
  `;
}

function globalPersonRows(people, column) {
  if (people.length === 0) return '<div class="person empty">-</div>';
  return people.map((person) => globalPersonRow(person, column)).join('');
}

function renderGlobalAlliesView() {
  if (!els.globalMixedList) return;
  const { mixed, allies, enemies } = computeGlobalRoster();
  els.globalMixedList.innerHTML = globalPersonRows(mixed, 'mixed');
  els.globalAlliesList.innerHTML = globalPersonRows(allies, 'allies');
  els.globalEnemiesList.innerHTML = globalPersonRows(enemies, 'enemies');
}

function formatChatDate(ts) {
  const date = new Date(ts);
  const two = (value) => String(value).padStart(2, '0');
  return `${two(date.getDate())}-${two(date.getMonth() + 1)}-${String(date.getFullYear()).slice(-2)} | ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function initParticles() {
  const canvas = els.particleBg;
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let dpr = 1;
  let particles = [];
  let links = [];
  let animationFrame = null;
  let enabled = true;

// Distancia "comoda": por debajo de esto no se tira de nada.
  const COMFORT_DIST = 170;
  // Si una union se estira mas alla de esto, se da por rota y se reemplaza.
  const BREAK_DIST = 420;
  // Distancia mínima: por debajo de esto las partículas se REPELEN.
  const MIN_DIST = 70; 

  // Fuerza maxima del "elastico" por cuadro.
  const PULL_MAX = 0.006;
  const PULL_STRENGTH = 0.00002;
  
  // Fuerza máxima y fuerza del "empuje" para separarlas.
  const PUSH_MAX = 0.008;
  const PUSH_STRENGTH = 0.0001;

  // Velocidad maxima permitida (evita que el elastico acelere sin limite).
  const MAX_SPEED = 0.9;
  // Cuadros que tarda una union nueva en aparecer del todo (fade-in).
  const FADE_FRAMES = 90;

  function targetCount() {
    return window.innerWidth < 800 ? 68 : 140;
  }

  function makeParticle() {
    const speed = 0.12 + Math.random() * 0.34;
    const angle = Math.random() * Math.PI * 2;
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      base: speed,
      r: 1.2 + Math.random() * 2.3
    };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Vaciamos el array para construir la estructura de cero
    particles = [];

    // EL MARCO ESTRUCTURAL: Nodos de anclaje fijos en los bordes
    const MARGIN = 40; // Pixeles de distancia desde el borde
    const STEPS = 8;   // Puntos de anclaje por cada lado de la pantalla
    
    for (let i = 0; i <= STEPS; i++) {
      const tX = (width / STEPS) * i;
      const tY = (height / STEPS) * i;
      
      // Arriba y Abajo
      particles.push({ x: tX, y: MARGIN, vx: 0, vy: 0, r: 2, isFrame: true });
      particles.push({ x: tX, y: height - MARGIN, vx: 0, vy: 0, r: 2, isFrame: true });
      
      // Izquierda y Derecha (sin duplicar las esquinas)
      if (i > 0 && i < STEPS) {
        particles.push({ x: MARGIN, y: tY, vx: 0, vy: 0, r: 2, isFrame: true });
        particles.push({ x: width - MARGIN, y: tY, vx: 0, vy: 0, r: 2, isFrame: true });
      }
    }

    // Rellenamos el resto del espacio con partículas flotantes
    const count = targetCount();
    while (particles.length < count + (STEPS * 4)) {
      particles.push(makeParticle());
    }
    spacing = Math.sqrt((width * height) / count);
    rebuildLinks();
  }

  function linkedPartners(index) {
    const partners = new Set();
    for (const link of links) {
      if (link.a === index) partners.add(link.b);
      else if (link.b === index) partners.add(link.a);
    }
    return partners;
  }

  function nearestFreePartner(index, exclude) {
    let best = -1;
    let bestDist = Infinity;
    for (let j = 0; j < particles.length; j++) {
      // Ignorar si es la misma partícula o si ya es un compañero actual
      if (j === index || exclude.has(j)) continue;
      
      // NUEVO: Limitar el número máximo de enlaces por partícula.
      // Si la candidata ya tiene 5 o más conexiones, se rechaza.
      if (linkedPartners(j).size >= 5) continue;

      const dx = particles[j].x - particles[index].x;
      const dy = particles[j].y - particles[index].y;
      const dist = dx * dx + dy * dy;
      
      if (dist < bestDist) {
        bestDist = dist;
        best = j;
      }
    }
    return best;
  }

  function rebuildLinks() {
    const seen = new Set();
    links = [];
    for (let i = 0; i < particles.length; i++) {
      const nearest = particles
        .map((particle, index) => {
          const dx = particle.x - particles[i].x;
          const dy = particle.y - particles[i].y;
          return { index, dist: dx * dx + dy * dy };
        })
        .filter((item) => item.index !== i)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 3);

      for (const item of nearest) {
        const a = Math.min(i, item.index);
        const b = Math.max(i, item.index);
        const key = `${a}:${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ a, b, age: FADE_FRAMES });
      }
    }
  }

  // Tira suavemente de las dos particulas de cada union cuando se alejan
  // demasiado (como si estuvieran atadas por un elastico), y si aun asi la
  // union se estira mas alla de BREAK_DIST, la reemplaza por una vecina
  // libre puntual (con fade-in), en vez de recalcular toda la red de golpe.
  // Repulsión suave entre TODAS las partículas libres. Fuerza 0 en el borde
// del radio y máxima cuando se tocan. O(n²), ~10k pares por cuadro con 140.
function repelAll() {
  const R = spacing * 1.1;
  const R2 = R * R;
  for (let i = 0; i < particles.length; i++) {
    const a = particles[i];
    if (a.isFrame) continue;
    for (let j = i + 1; j < particles.length; j++) {
      const b = particles[j];
      if (b.isFrame) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= R2 || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const f = (1 - d / R) * REPEL_STRENGTH;
      const nx = dx / d;
      const ny = dy / d;
      a.vx -= nx * f; a.vy -= ny * f;
      b.vx += nx * f; b.vy += ny * f;
    }
  }
}
  function maintainLinks() {
    for (const link of links) {
      const p1 = particles[link.a];
      const p2 = particles[link.b];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;

      const nx = dx / dist;
      const ny = dy / dist;

      if (dist > BREAK_DIST) {
        const exclude = linkedPartners(link.a);
        exclude.add(link.a);
        const replacement = nearestFreePartner(link.a, exclude);
        if (replacement !== -1) {
          link.b = replacement;
          link.age = 0;
        }
        continue;
      }

      if (dist > COMFORT_DIST) {
        const pull = Math.min(PULL_MAX, (dist - COMFORT_DIST) * PULL_STRENGTH);
        // Solo altera la velocidad si NO es una partícula del marco
        if (!p1.isFrame) { p1.vx += nx * pull; p1.vy += ny * pull; }
        if (!p2.isFrame) { p2.vx -= nx * pull; p2.vy -= ny * pull; }
      } else if (dist < MIN_DIST) {
        const push = Math.min(PUSH_MAX, (MIN_DIST - dist) * PUSH_STRENGTH);
        if (!p1.isFrame) { p1.vx -= nx * push; p1.vy -= ny * push; }
        if (!p2.isFrame) { p2.vx += nx * push; p2.vy += ny * push; }
      }

      if (link.age < FADE_FRAMES) link.age++;
    }
  }

  function step() {
    if (!enabled) return;
    ctx.clearRect(0, 0, width, height);

    maintainLinks();
repelAll();

for (const particle of particles) {
  if (particle.isFrame) continue;
  let speed = Math.hypot(particle.vx, particle.vy) || 0.0001;

  // Tiende suavemente a su velocidad propia (evita que se frenen o se disparen)
  const k = 1 + (particle.base / speed - 1) * CRUISE_DAMPING;
  particle.vx *= k;
  particle.vy *= k;
  speed *= k;

  if (speed > MAX_SPEED) {
    particle.vx = (particle.vx / speed) * MAX_SPEED;
    particle.vy = (particle.vy / speed) * MAX_SPEED;
  }
  particle.x += particle.vx;
  particle.y += particle.vy;
      if (particle.x < -20) particle.x = width + 20;
      if (particle.x > width + 20) particle.x = -20;
      if (particle.y < -20) particle.y = height + 20;
      if (particle.y > height + 20) particle.y = -20;
    }

    ctx.lineWidth = 1;
    for (const link of links) {
      const p1 = particles[link.a];
      const p2 = particles[link.b];
      const dx = p1.x - p2.x;
      const dy = p1.y - p2.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const distAlpha = Math.max(0, Math.min(0.5, 1 - dist / BREAK_DIST));
      const fadeAlpha = Math.min(1, link.age / FADE_FRAMES);
      const alpha = distAlpha * fadeAlpha;
      if (alpha <= 0.01) continue;
      ctx.strokeStyle = `rgba(255, 211, 68, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }

    for (const particle of particles) {
      ctx.fillStyle = 'rgba(255, 220, 54, 1)';
      ctx.shadowBlur = 14;
      ctx.shadowColor = 'rgba(255, 203, 32, 0.85)';
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    animationFrame = requestAnimationFrame(step);
  }

  window.addEventListener('resize', () => {
    if (enabled) resize();
  });
  resize();
  animationFrame = requestAnimationFrame(step);

  return {
    setEnabled(nextEnabled) {
      nextEnabled = Boolean(nextEnabled);
      if (enabled === nextEnabled) return;
      enabled = nextEnabled;
      canvas.style.display = enabled ? '' : 'none';
      if (!enabled) {
        if (animationFrame) cancelAnimationFrame(animationFrame);
        animationFrame = null;
        ctx.clearRect(0, 0, width, height);
        return;
      }
      resize();
      animationFrame = requestAnimationFrame(step);
    }
  };
}

function handleInput(event) {
  const input = event.target;
  let accountId = input.dataset.accountId;
  if (!accountId) return;
  
  // Sanitizar accountId
  accountId = String(accountId).trim();
  if (!accountId) return;

  const account = accountById(accountId);
  if (!account) {
    appendLocalLog(`[UI] [INPUT] Cuenta no encontrada para ID: ${accountId}`);
    return;
  }
  const field = input.dataset.field;
  const ring = input.dataset.ring;

  const isTextField = [
    'label',
    'recoverPassword',
    'planetName',
    'giftTarget',
    'proxyHost',
    'proxyPort',
    'proxyUsername',
    'proxyPassword'
  ].includes(field);
  if (!account.settings.proxy) {
    account.settings.proxy = { enabled: false, host: '', port: '', username: '', password: '' };
  }

  if (field === 'label') account.label = input.value.trim() || account.label;
  else if (field === 'recoverPassword') account.settings.recoverPassword = input.value;
  else if (field === 'loginMode') account.settings.loginMode = input.checked ? 'mobile' : 'pc';
  else if (field === 'planetName') account.settings.planetName = input.value.trim() || 'RingToss*2';
  else if (field === 'giftTarget') account.settings.giftTarget = input.value.trim();
  else if (field === 'proxyEnabled') account.settings.proxy.enabled = input.checked;
  else if (field === 'proxyHost') account.settings.proxy.host = input.value.trim();
  else if (field === 'proxyPort') account.settings.proxy.port = input.value.trim();
  else if (field === 'proxyUsername') account.settings.proxy.username = input.value.trim();
  else if (field === 'proxyPassword') account.settings.proxy.password = input.value;
  else if (field === 'giftAnonymous') account.settings.giftAnonymous = input.checked;
  else if (field === 'autoInventoryGiftEnabled') account.settings.autoInventoryGiftEnabled = input.checked;
  else if (field === 'botEnabled') account.settings.botEnabled = input.checked;
  else if (field === 'newPlayersAreEnemies') account.settings.newPlayersAreEnemies = input.checked;
  else if (field === 'ring-enabled') account.settings.rings[ring].enabled = input.checked;
  else if (field === 'primary-titanium') account.settings.rings[ring].primary.titanium = input.checked;
  else if (field === 'primary-diamond') {
    account.settings.rings[ring].primary.diamond = input.checked;
    if (input.checked && ring === 'gold') account.settings.rings[ring].primary.diamondExceptFourth = false;
  }
  else if (field === 'primary-diamond-except-fourth' && ring === 'gold') {
    account.settings.rings[ring].primary.diamondExceptFourth = input.checked;
    if (input.checked) account.settings.rings[ring].primary.diamond = false;
  }
  else if (field === 'stack-enabled') account.settings.rings[ring].stacks[input.dataset.stack].enabled = input.checked;
  else if (field === 'stack-spike') account.settings.rings[ring].stacks[input.dataset.stack].spike = input.value;
  else return;

  // Los inputs de texto usan debounce (para no guardar en cada letra).
  // Los checkboxes y radios guardan inmediatamente: así el servidor tiene el
  // estado actualizado antes de que el próximo render pueda revertir el cambio.
  if (isTextField) {
    debounceSave(accountId);
  } else {
    invoke('saveAccount', { accountId: account.id, label: account.label, settings: account.settings });
  }
}

function handleClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  let accountId = target.dataset.accountId;
  if (accountId) accountId = String(accountId).trim();
  
  const action = target.dataset.action;
  if (action === 'remove-account' || action === 'set-log-mode' || action.startsWith('chat-')) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (action === 'connect') {
    const account = accountById(accountId);
    invoke('connect', {
      accountId,
      recoverPassword: account?.settings.recoverPassword || '',
      loginMode: account?.settings.loginMode
    });
  }
  else if (action === 'open-create-account') openCreateAccount(accountId);
  else if (action === 'close-create-account') closeCreateAccount();
  else if (action === 'submit-create-account') submitCreateAccount();
  else if (action === 'disconnect') invoke('disconnect', { accountId });
  else if (action === 'fly') {
    const account = accountById(accountId);
    if (!account) return;
    invoke('fly', { accountId, planetName: account.settings.planetName });
  } else if (action === 'send-gift') invoke('sendGift', { accountId });
  else if (action === 'spin-wheel') invoke('spinWheel', { accountId });
  else if (action === 'remove-account') invoke('removeAccount', { accountId });
  else if (action === 'select-person') {
    selectedPeople.set(accountId, { id: target.dataset.userId, side: target.dataset.side });
    renderAccounts();
  } else if (action === 'move-person') {
    const selected = selectedPeople.get(accountId);
    if (!selected?.id) return;
    const nextSide = selected.side === 'enemy' ? 'ally' : 'enemy';
    selectedPeople.set(accountId, { id: null, side: null });
    invoke('movePerson', { accountId, userId: selected.id, nextSide });
  } else if (action === 'log-tab') invoke('setActiveLogAccount', { accountId });
  else if (action === 'set-log-mode') invoke('setLogMode', target.dataset.mode === 'chat' ? 'chat' : 'debug');
  else if (action === 'clear-log') invoke('clearLogs', { accountId });
  else if (action === 'chat-recipient-toggle') {
    chatMenuOpen = !chatMenuOpen;
    renderChatComposer();
  } else if (action === 'chat-recipient') {
    selectedChatTargets.set(accountId, {
      recipientId: target.dataset.recipientId || '0',
      recipientName: target.dataset.recipientName || ''
    });
    chatMenuOpen = false;
    renderChatComposer();
  } else if (action === 'chat-send') {
    const input = document.getElementById('chat-input');
    const text = input ? input.value.trim() : '';
    if (!text) return;
    const recipient = selectedChatTargets.get(accountId) || { recipientId: '0', recipientName: '' };
    chatDrafts.set(accountId, '');
    chatMenuOpen = false;
    invoke('sendChat', { accountId, recipientId: recipient.recipientId, recipientName: recipient.recipientName, text });
    renderChatComposer();
  } else if (action === 'open-global-config') {
    openGlobalConfig();
  } else if (action === 'close-global-config') {
    closeGlobalConfig();
  } else if (action === 'connect-all') {
    connectAllAccounts();
    closeGlobalConfig();
  } else if (action === 'disconnect-all') {
    disconnectAllAccounts();
    closeGlobalConfig();
  } else if (action === 'auto-send-all') {
    for (const acc of state.accounts) {
      acc.settings.botEnabled = true;
      invoke('saveAccount', { accountId: acc.id, label: acc.label, settings: acc.settings });
    }
    closeGlobalConfig();
  } else if (action === 'open-schedule-connect') {
    popupView = 'schedule-connect';
    renderGlobalConfigPopup();
  } else if (action === 'open-schedule-disconnect') {
    popupView = 'schedule-disconnect';
    renderGlobalConfigPopup();
  } else if (action === 'schedule-back') {
    popupView = 'menu';
    renderGlobalConfigPopup();
  } else if (action === 'open-global-allies') {
    closeGlobalConfig();
    viewMode = 'global-allies';
    renderGlobalAlliesView();
    applyViewMode();
  } else if (action === 'save-shared-allies-group') {
    const input = document.getElementById('shared-allies-group-code');
    invoke('setSharedAlliesGroupCode', { groupCode: input?.value || '' });
  } else if (action === 'save-telegram-chat-id') {
    const input = document.getElementById('telegram-chat-id');
    invoke('setTelegramChatId', { chatId: input?.value || '' });
  } else if (action === 'save-telegram-external-account-id') {
    const input = document.getElementById('telegram-external-account-id');
    invoke('setTelegramExternalAccountId', { externalAccountId: input?.value || '' });
  } else if (action === 'sync-shared-allies') {
    invoke('syncSharedAllies');
  } else if (action === 'global-allies-back') {
    viewMode = 'accounts';
    applyViewMode();
  } else if (action === 'move-global-person') {
    moveGlobalPerson(target.dataset.personId, target.dataset.nextSide);
  } else if (action === 'open-supplier-drawer') {
    openSupplierDrawer();
  } else if (action === 'close-supplier-drawer') {
    closeSupplierDrawer();
  } else if (action === 'check-supplier-now') {
    invoke('checkSupplierNow');
  } else if (action === 'add-supplier-item') {
    const items = [...(state.supplier.items || [])];
    items.push({ itemId: '', threshold: 5, sendAmount: 10 });
    invoke('setSupplierConfig', { ...state.supplier, items });
  } else if (action === 'remove-supplier-item') {
    const index = Number(target.dataset.index);
    const items = [...(state.supplier.items || [])];
    items.splice(index, 1);
    invoke('setSupplierConfig', { ...state.supplier, items });
  }
}

function openSupplierDrawer() {
  renderSupplierDrawer();
  els.supplierDrawer.classList.add('open');
  els.supplierDrawer.setAttribute('aria-hidden', 'false');
  els.supplierDrawerBackdrop.classList.add('open');
}

function closeSupplierDrawer() {
  els.supplierDrawer.classList.remove('open');
  els.supplierDrawer.setAttribute('aria-hidden', 'true');
  els.supplierDrawerBackdrop.classList.remove('open');
}

function saveSupplierItemsFromUi() {
  const rows = els.supplierDrawer.querySelectorAll('.supplier-item-row');
  const items = [];
  rows.forEach((row) => {
    const itemId = row.querySelector('.supplier-item-id').value.trim();
    const threshold = Number(row.querySelector('.supplier-item-threshold').value) || 0;
    const sendAmount = Number(row.querySelector('.supplier-item-send').value) || 1;
    
    // Eliminamos la condición 'if (itemId)' para permitir enviar la fila vacía
    // mientras el usuario la está editando.
    items.push({ itemId, threshold, sendAmount });
  });
  invoke('setSupplierConfig', { ...state.supplier, items });
}

function handleToggle(event) {
  const details = event.target.closest('details.account-card');
  if (!details) return;
  if (details.open) openAccounts.add(details.dataset.accountId);
  else openAccounts.delete(details.dataset.accountId);
}

function clearAccountDragClasses() {
  els.accounts.querySelectorAll('.account-card.dragging, .account-card.drag-over').forEach((card) => {
    card.classList.remove('dragging', 'drag-over');
  });
}

function getAccountOrderFromDom() {
  return [...els.accounts.querySelectorAll('.account-card')].map((card) => card.dataset.accountId);
}

function initAccountDragReorder() {
  els.accounts.addEventListener('click', (event) => {
    if (event.target.closest('.account-drag-handle')) {
      // El asa esta dentro de summary: un click sin arrastre no debe abrir/cerrar.
      event.preventDefault();
    }
  });

  els.accounts.addEventListener('dragstart', (event) => {
    const handle = event.target.closest('.account-drag-handle');
    const card = handle?.closest('.account-card');
    if (!card) return;

    draggingAccountId = card.dataset.accountId;
    card.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggingAccountId);
  });

  els.accounts.addEventListener('dragover', (event) => {
    if (!draggingAccountId) return;
    const target = event.target.closest('.account-card');
    const source = els.accounts.querySelector(`.account-card[data-account-id="${draggingAccountId}"]`);
    if (!target || !source || target === source) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearAccountDragClasses();
    source.classList.add('dragging');
    target.classList.add('drag-over');

    const targetBox = target.getBoundingClientRect();
    const insertAfter = event.clientY > targetBox.top + targetBox.height / 2;
    els.accounts.insertBefore(source, insertAfter ? target.nextSibling : target);
  });

  els.accounts.addEventListener('drop', (event) => {
    if (!draggingAccountId) return;
    event.preventDefault();
    const accountIds = getAccountOrderFromDom();
    const changed = accountIds.some((id, index) => id !== state.accounts[index]?.id);
    clearAccountDragClasses();
    draggingAccountId = null;
    if (changed) invoke('reorderAccounts', { accountIds });
    else flushPendingRender();
  });

  els.accounts.addEventListener('dragend', () => {
    clearAccountDragClasses();
    if (!draggingAccountId) return;
    draggingAccountId = null;
    flushPendingRender();
  });
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(text) {
  return escapeHtml(text).replaceAll('\n', '&#10;');
}
function initLogResize() {
  const dock = els.logDock;
  const handle = els.logResizeHandle;
  if (!dock || !handle) return;

  // Usar la altura CSS por defecto como techo máximo (evita medir antes del primer render)
  const MAX_HEIGHT = 480;
  const MIN_HEIGHT = 72;
  const DEFAULT_HEIGHT = 196;

  // Asegurarse de que el dock parta con la altura por defecto
  if (!dock.style.height) dock.style.height = `${DEFAULT_HEIGHT}px`;

  let dragging = false;
  let startY = 0;
  let startHeight = 0;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startHeight = dock.offsetHeight;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // Arrastrar hacia arriba (delta negativo) agranda el panel
    const delta = e.clientY - startY;
    const newHeight = startHeight - delta;
    const clamped = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, newHeight));
    dock.style.height = `${clamped}px`;
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  });

  // Ctrl+L — ocultar/mostrar toda la consola de logs
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      dock.classList.toggle('log-dock--hidden');
    }
  });
}

async function boot() {
  particleBackground = initParticles();
  initLogResize();
  document.addEventListener('selectionchange', flushPendingRender);
  document.addEventListener('focusout', () => {
    // Esperar a que el navegador actualice document.activeElement antes de
    // decidir si puede aplicar el estado pendiente.
    setTimeout(flushPendingRender, 0);
  });
  if (!window.ringtoss) {
    appendLocalLog('[UI] Esta pantalla debe abrirse desde Electron.');
    return;
  }

  els.addAccountBtn.addEventListener('click', () => invoke('addAccount'));
  initAccountDragReorder();
  els.accounts.addEventListener('input', handleInput);
  els.accounts.addEventListener('change', handleInput);
  els.accounts.addEventListener('dblclick', (event) => {
    const person = event.target.closest('[data-action="select-person"]');
    if (!person) return;
    const accountId = person.dataset.accountId;
    const userId = person.dataset.userId;
    const side = person.dataset.side;
    selectedPeople.set(accountId, { id: userId, side });
    const nextSide = side === 'enemy' ? 'ally' : 'enemy';
    invoke('movePerson', { accountId, userId, nextSide });
  });
  els.accounts.addEventListener('toggle', handleToggle, true);
  els.accounts.addEventListener('keydown', (event) => {
    if (event.target.dataset?.field !== 'planetName' || event.key !== 'Enter') return;
    event.preventDefault();
    const accountId = event.target.dataset.accountId;
    const newPlanet = event.target.value.trim();
    if (!accountId || !newPlanet) return;
    invoke('fly', { accountId, planetName: newPlanet });
  });
  els.log.addEventListener('mousedown', () => {
    selectingLog = true;
  });
  document.addEventListener('mouseup', () => {
    if (!selectingLog) return;
    selectingLog = false;
  });
  // Un solo listener delegado a nivel document: cubre #accounts, los tabs de
  // log, el chat, el popup de config global y la vista de Aliados Globales
  // (estas dos ultimas viven fuera de #accounts, por eso antes sus botones
  // no reaccionaban a los clicks).
  document.addEventListener('click', handleClick);
  document.addEventListener('click', (event) => {
    if (event.target === els.globalConfigPopup) closeGlobalConfig();
    if (event.target === els.createAccountPopup) closeCreateAccount();
  });
  document.addEventListener('keydown', (event) => {
    if (!els.createAccountPopup || els.createAccountPopup.style.display === 'none') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeCreateAccount();
    }
    if (event.key === 'Enter' && event.target?.id === 'create-account-nick') {
      event.preventDefault();
      submitCreateAccount();
    }
  });
  els.globalConfigPopup.addEventListener('change', (event) => {
    // NUEVO: Capturar cuando marcan/desmarcan una cuenta para programar
    if (event.target.classList.contains('schedule-acc-checkbox')) {
      const accountId = event.target.dataset.accountId;
      if (event.target.checked) {
        if (!scheduleConnect.accountIds.includes(accountId)) {
          scheduleConnect.accountIds.push(accountId);
        }
      } else {
        scheduleConnect.accountIds = scheduleConnect.accountIds.filter(id => id !== accountId);
      }
      renderGlobalConfigPopup();
      return;
    }

    if (event.target.id === 'schedule-time-input') {
      scheduleConnect.time = event.target.value || scheduleConnect.time;
      if (scheduleConnect.enabled) armScheduledConnect();
      else renderGlobalConfigPopup();
    } else if (event.target.id === 'schedule-enabled-toggle') {
      scheduleConnect.enabled = event.target.checked;
      if (scheduleConnect.enabled) armScheduledConnect();
      else {
        clearScheduledConnectTimer();
        renderGlobalConfigPopup();
      }
    } else if (event.target.id === 'schedule-disconnect-time-input') {
      scheduleDisconnect.time = event.target.value || scheduleDisconnect.time;
      if (scheduleDisconnect.enabled) armScheduledDisconnect();
      else renderGlobalConfigPopup();
    } else if (event.target.id === 'schedule-disconnect-enabled-toggle') {
      scheduleDisconnect.enabled = event.target.checked;
      if (scheduleDisconnect.enabled) armScheduledDisconnect();
      else {
        clearScheduledDisconnectTimer();
        renderGlobalConfigPopup();
      }
    } else if (event.target.id === 'particles-enabled-toggle') {
      particleBackground?.setEnabled(event.target.checked);
      invoke('setVisualEffects', { particlesEnabled: event.target.checked });
    }
  });
  els.supplierDrawer.addEventListener('change', (event) => {
    const id = event.target.id;
    
    // Si el cambio proviene de uno de los inputs de la cuadrícula de ítems
    if (event.target.classList.contains('supplier-item-id') || 
        event.target.classList.contains('supplier-item-threshold') || 
        event.target.classList.contains('supplier-item-send')) {
      saveSupplierItemsFromUi();
      return;
    }

    const fieldMap = {
      'supplier-account-select': 'supplierAccountId',
      'supplier-enabled-toggle': 'enabled',
      'supplier-interval-input': 'intervalMinutes'
    };
    const field = fieldMap[id];
    if (!field) return;

    let value;
    if (field === 'enabled') value = event.target.checked;
    else if (field === 'intervalMinutes') value = Number(event.target.value);
    else value = event.target.value || null;

    invoke('setSupplierConfig', { ...state.supplier, [field]: value });
  });
  els.chatComposer.addEventListener('input', (event) => {
    if (event.target.id !== 'chat-input') return;
    const activeId = state.activeLogAccountId || state.accounts[0]?.id;
    if (activeId) chatDrafts.set(activeId, event.target.value);
  });
  els.chatComposer.addEventListener('keydown', (event) => {
    if (event.target.id !== 'chat-input' || event.key !== 'Enter') return;
    event.preventDefault();
    const activeId = state.activeLogAccountId || state.accounts[0]?.id;
    const text = event.target.value.trim();
    if (!activeId || !text) return;
    const recipient = selectedChatTargets.get(activeId) || { recipientId: '0', recipientName: '' };
    chatDrafts.set(activeId, '');
    chatMenuOpen = false;
    invoke('sendChat', { accountId: activeId, recipientId: recipient.recipientId, recipientName: recipient.recipientName, text });
    renderChatComposer();
  });

  const initial = await invoke('getState');
  if (initial) render(initial);
  window.ringtoss.onState(render);
}

boot();
