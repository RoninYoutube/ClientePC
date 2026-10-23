'use strict';

const WebSocket = require('ws');
const { handleChq, makePcFlag, makeMobileToken, makeMobileSessionId } = require('./galaxy-auth');
const {
  getMyInventory,
  sendGifts,
  spinFortuneWheel,
  openFortuneWheelChest,
  requestRecoveryCode,
  setSidecarConfig
} = require('./galaxy-http');
const { GalaxyAutoRequests } = require('./galaxy-auto-requests');
const {
  createSidecarBridgeConnection,
  createTlsConnection,
  isProxyEnabled,
  normalizeProxySettings,
  proxyLabel
} = require('./proxy');

const WS_URL = 'wss://cs.mobstudio.ru:6672/';
const WS_HANDSHAKE_HEADERS = {
  Origin: 'https://galaxy.mobstudio.ru',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-GPC': '1'
};
const WS_IDENT = ':es IDENT 352 -2 4030 1 2 :GALA';
const WS_INACTIVITY_MS = 3 * 60 * 1000;
const MOBILE_HOST = 'cs.mobstudio.ru';
const MOBILE_PORT = 6671;
const MOBILE_PROFILE = {
  ident: ':es IDENT 449 -1 4030 1 2 :GALA',
  fwlistver: 'FWLISTVER 311',
  addons: 'ADDONS 252044 1',
  myaddons: 'MYADDONS 252044 1',
  phone: 'PHONE 411 842 1 2 bf1a63e79eb79e0d04d120e99f1e517a :SM-A805F 11 9.5.41'
};

class GalaxyClient {
  constructor({ log, onStatus, onLine, onIdentity, sidecar } = {}) {
    this.log = log;
    this.onStatus = onStatus || (() => {});
    this.onLine = onLine || (() => {});
    this.onIdentity = onIdentity || (() => {});
    this.socket = null;
    this.status = 'disconnected';
    this.password = '';
    this.challenge = null;
    this.userId = null;
    this.hash = null;
    this.nickname = null;
    this.loginMode = 'pc';
    this.transportMode = null;
    this.mobileToken = null;
    this.mobileSessionId = null;
    this.proxy = normalizeProxySettings();
    this.sidecarHost = (sidecar && sidecar.host) || '127.0.0.1';
    this.sidecarPort = (sidecar && sidecar.port) || 8791;
    // Propagar config del sidecar al modulo HTTP para que las peticiones
    // HTTP tambien pasen por el endpoint /http del sidecar (uTLS Chrome).
    setSidecarConfig({ host: this.sidecarHost, port: this.sidecarPort });
    this.connectSeq = 0;
    this.buffer = '';
    this.planetName = 'RingToss*2';
    this.authTimer = null;
    this.authResolve = null;
    this.authReject = null;
    this.autoRequests = new GalaxyAutoRequests({ log: (m) => this.log(m) });
    // manualDisconnect distingue "el usuario apreto Desconectar" (no
    // reconectar solo) de "el socket se cayo/el servidor cerro" (si
    // reconectar solo, a los 20s). Arranca en false: recien se pone true
    // cuando disconnect() se llama explicitamente con { manual: true }.
    this.manualDisconnect = false;
    this.reconnectTimer = null;
    this.inactivityTimer = null;
    this.recoveryCodeResolve = null;
    this.recoveryCodeReject = null;
    this.recoveryCodeTimer = null;
    // {id, nickname, passwordHash} de una cuenta recien creada por
    // registration_register, pendiente de su primer login (que salta
    // RECOVER/REGISTER e informa el trio directo via USER). Se consume una
    // sola vez en handleMessage y vuelve a null.
    this.freshAccount = null;
  }

  getSnapshot() {
    return {
      status: this.status,
      userId: this.userId,
      nickname: this.nickname,
      planetName: this.planetName,
      loginMode: this.loginMode
    };
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }

  connect({ password, planetName, proxy, freshAccount, loginMode } = {}) {
    this.freshAccount = freshAccount || null;
    if (this.freshAccount) {
      // Con freshAccount, el login no usa RECOVER en absoluto (ver
      // handleMessage/HAAAPSI); this.password queda vacio a proposito.
      this.password = '';
    } else {
      if (password) this.password = password;
      if (!this.password) throw new Error('Falta password/RECOVER');
    }
    if (planetName) this.planetName = planetName;
    if (proxy !== undefined) {
      this.proxy = normalizeProxySettings(proxy);
    }
    // Una reconexion automatica no pasa loginMode: conserva el de la sesion
    // anterior. Solo un nuevo click en Conectar aplica el switch de la UI.
    const nextLoginMode = loginMode === undefined
      ? this.loginMode
      : loginMode === 'mobile' ? 'mobile' : 'pc';

    // Cualquier connect() explicito (manual o automatico) cancela una
    // reconexion programada pendiente (ya no hace falta, estamos por
    // conectar ahora mismo) y vuelve a habilitar la reconexion automatica
    // para el futuro, por si ESTA conexion tambien se cae sola despues.
    this.clearReconnectTimer();
    this.clearInactivityTimer();
    this.manualDisconnect = false;

    this.disconnect({ quiet: true });
    this.loginMode = nextLoginMode;
    this.transportMode = null;
    this.buffer = '';
    this.challenge = null;
    this.mobileToken = null;
    this.mobileSessionId = null;
    this.setStatus('connecting');
    this.log(`[Conexion] Iniciando sesion ${this.loginMode === 'mobile' ? 'movil' : 'PC'}`);
    if (isProxyEnabled(this.proxy)) this.log(`[Proxy] Usando ${proxyLabel(this.proxy)}`);

    const seq = ++this.connectSeq;

    return new Promise((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
      this.authTimer = setTimeout(() => {
        this.rejectAuth(new Error('Timeout de autenticacion'));
      }, 25000);

      if (this.loginMode === 'mobile') this.openMobileConnection(seq);
      else this.openPcConnection(seq);
    });
  }

  openPcConnection(seq) {
    let socket;
    try {
      socket = createSidecarBridgeConnection({
        sidecarHost: this.sidecarHost,
        sidecarPort: this.sidecarPort,
        targetUrl: WS_URL,
        proxy: this.proxy,
        headers: WS_HANDSHAKE_HEADERS
      });
    } catch (err) {
      this.handleConnectionError(seq, err);
      return;
    }

    socket.on('message', (chunk) => {
      if (seq !== this.connectSeq) return;
      this.refreshInactivityTimer(seq);
      this.handleData(chunk);
    });
    socket.on('close', () => this.handleConnectionClose(seq));
    socket.once('error', (err) => this.handleConnectionError(seq, err));
    socket.once('open', () => {
      if (seq !== this.connectSeq) {
        socket.terminate();
        return;
      }
      this.socket = socket;
      this.transportMode = 'pc';
      this.log('[Conexion] WS conectado');
      this.refreshInactivityTimer(seq);
      this.send(WS_IDENT);
    });
  }

  openMobileConnection(seq) {
    createTlsConnection({
      host: MOBILE_HOST,
      port: MOBILE_PORT,
      rejectUnauthorized: false,
      proxy: this.proxy
    })
      .then((socket) => {
        socket.on('data', (chunk) => {
          if (seq !== this.connectSeq) return;
          this.refreshInactivityTimer(seq);
          this.handleData(chunk);
        });
        socket.on('close', () => this.handleConnectionClose(seq));
        socket.on('error', (err) => this.handleConnectionError(seq, err));
        socket.once('secureConnect', () => {
          if (seq !== this.connectSeq) {
            socket.destroy();
            return;
          }
          this.socket = socket;
          this.transportMode = 'mobile';
          this.log('[Conexion] TLS movil conectado');
          this.refreshInactivityTimer(seq);
        });
      })
      .catch((err) => this.handleConnectionError(seq, err));
  }

  handleConnectionClose(seq) {
    if (seq !== this.connectSeq) return;
    this.clearInactivityTimer();
    this.autoRequests.stop();
    this.socket = null;
    this.transportMode = null;
    this.setStatus('disconnected');
    this.log('[Conexion] Socket cerrado');
    if (!this.manualDisconnect) this.scheduleReconnect();
  }

  handleConnectionError(seq, err) {
    if (seq !== this.connectSeq) return;
    this.autoRequests.stop();
    this.log(`[Conexion] Error: ${err.message}`);
    this.setStatus('error');
    this.rejectAuth(err);
  }

  disconnect({ quiet = false, manual = false } = {}) {
    if (manual) {
      this.manualDisconnect = true;
      this.clearReconnectTimer();
    }
    this.clearAuthWait();
    this.clearInactivityTimer();
    this.connectSeq++;
    this.autoRequests.stop();
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    const transportMode = this.transportMode;
    this.transportMode = null;
    if (transportMode === 'mobile') {
      try {
        socket.write('QUIT\r\n');
      } catch {
        // Ignore close races.
      }
      socket.destroy();
    } else if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send('QUIT\r\n');
      } catch {
        // Ignore close races.
      }
      socket.close();
    } else {
      socket.terminate();
    }
    if (!quiet) this.log('[Conexion] Desconectando');
    this.setStatus('disconnected');
  }

  scheduleReconnect() {
    this.clearReconnectTimer();
    this.log('[Conexion] Reconexion automatica en 20s');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.log('[Conexion] Intentando reconexion automatica');
      try {
        this.connect().catch((err) => {
          this.log(`[Conexion] Reconexion automatica fallida: ${err.message}`);
        });
      } catch (err) {
        this.log(`[Conexion] Reconexion automatica fallida: ${err.message}`);
      }
    }, 20000);
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  refreshInactivityTimer(seq) {
    this.clearInactivityTimer();
    this.inactivityTimer = setTimeout(() => {
      this.inactivityTimer = null;
      if (seq !== this.connectSeq || this.manualDisconnect || !this.socket) return;
      this.log('[Conexion] Sin mensajes WS por 3 minutos; reconectando');
      this.socket.terminate();
    }, WS_INACTIVITY_MS);
  }

  clearInactivityTimer() {
    if (!this.inactivityTimer) return;
    clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
  }

  send(msg) {
    const mobileSocket = this.transportMode === 'mobile';
    const isOpen = mobileSocket
      ? this.socket && !this.socket.destroyed
      : this.socket && this.socket.readyState === WebSocket.OPEN;
    if (!isOpen) {
      this.log(`[Socket] No conectado; no se envio: ${this.maskOutgoing(msg)}`);
      return;
    }
    this.log(`-> ${this.maskOutgoing(msg)}`);
    if (mobileSocket) this.socket.write(`${msg}\r\n`);
    else this.socket.send(`${msg}\r\n`);
  }

  fly(planetName) {
    if (!planetName || !planetName.trim()) throw new Error('Planeta invalido');
    this.planetName = planetName.trim();
    this.send(`JOIN ${this.planetName}`);
    this.log(`[Volar] -> ${this.planetName}`);
  }

  maskOutgoing(msg) {
    if (msg.startsWith('RECOVER ')) return 'RECOVER ******';
    return msg;
  }

  handleData(chunk) {
    this.buffer += chunk.toString('utf8');
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (this.shouldLogIncoming(trimmed)) this.log(`<- ${trimmed}`);
      this.handleMessage(trimmed);
    }
  }

  shouldLogIncoming(msg) {
    return !(
      msg.startsWith('VIEW_SCRIPT') ||
      msg.startsWith('ADD_VIEW') ||
      msg.startsWith('PRIVMSG')
    );
  }

  handleMessage(msg) {
    if (msg.startsWith('HAAAPSI')) {
      this.challenge = msg.split(' ')[1];
      if (this.freshAccount) {
        // Cuenta recien creada por registration_register: el handshake NO
        // pasa por RECOVER/REGISTER en absoluto. Se salta directo a USER
        // con el id/hash/nick que ya nos devolvio el registro (confirmado
        // capturando el WS real de un login asi). Se consume una sola vez;
        // si esta MISMA conexion se cae y reconecta mas adelante, ya va a
        // tener un RECOVER real guardado y usa el camino normal.
        const fresh = this.freshAccount;
        this.freshAccount = null;
        this.userId = fresh.id;
        this.hash = fresh.passwordHash;
        this.nickname = fresh.nickname;
        this.sendUserAuth('cuenta nueva');
      } else {
        if (this.loginMode === 'mobile') {
          this.mobileToken = makeMobileToken(this.challenge);
          this.mobileSessionId = makeMobileSessionId();
          this.send(MOBILE_PROFILE.ident);
        }
        this.send(`RECOVER ${this.password}`);
      }
      return;
    }

    if (msg.startsWith('REGISTER')) {
      const parts = msg.split(' ');
      this.userId = parts[1];
      this.hash = parts[2];
      this.nickname = parts[3];
      this.sendUserAuth('REGISTER');
      return;
    }

    if (msg.startsWith('999 :AUTH OK')) {
      this.setStatus('connected');
      if (this.loginMode === 'mobile') {
        this.send(MOBILE_PROFILE.fwlistver);
        this.send(MOBILE_PROFILE.addons);
        this.send(MOBILE_PROFILE.myaddons);
        this.send(MOBILE_PROFILE.phone);
        this.send('DEVICE_SETTINGS 1');
        this.send(`JOIN ${this.planetName}`);
      } else {
        this.send('FWLISTVER 0');
        this.send('ADDONS 0');
        this.send('MYADDONS 0');
        this.send('PHONE 1600 900 0 2 :chrome 148.0.0.0');
        this.send('JOIN');
      }
      this.resolveAuth();
      if (this.loginMode === 'pc') {
        this.autoRequests.start({
          userId: this.userId,
          passwordHash: this.hash,
          proxy: this.proxy
        });
      }
      return;
    }

    if (msg.startsWith('CHQ ')) {
      this.send(handleChq(msg));
      return;
    }

    if (msg === 'PING') {
      this.send('PONG');
      return;
    }

    // Empuje asincronico del server con datos para "paginas" embebidas del
    // cliente web (el mismo canal que usa la pantalla de Ajustes ->
    // Seguridad para mostrar el RECOVER real). Formato IRC-style:
    // SERV_JS_IN <observerName> :<json>
    if (msg.startsWith('SERV_JS_IN')) {
      const m = msg.match(/^SERV_JS_IN\s+(\S+)\s+:(.*)$/);
      if (m && m[1] === 'show_recovery_code') {
        let code = null;
        try {
          code = JSON.parse(m[2]).code || null;
        } catch {
          // Contenido inesperado; se maneja como "no llego codigo" abajo.
        }
        if (code) this.resolveRecoveryCode(code);
        else this.rejectRecoveryCode(new Error('Respuesta de show_recovery_code sin codigo'));
      }
      return;
    }

    if (this.loginMode === 'pc') this.autoRequests.handleRawMessage(msg);
    this.onLine(msg);
  }

  // Compartido entre el login normal (via REGISTER, tras RECOVER) y el de
  // una cuenta recien creada (via freshAccount, sin RECOVER): en ambos
  // casos, una vez que this.userId/hash/nickname estan seteados, el ultimo
  // paso es identico: avisar onIdentity y mandar USER con el flag derivado
  // del challenge.
  sendUserAuth(via) {
    this.onIdentity(this.userId, this.nickname);
    this.log(`[Sesion] ${via} userId=${this.userId} nick=${this.nickname || '-'}`);
    if (this.loginMode === 'mobile') {
      this.send(`USER ${this.userId} ${this.hash} ${this.nickname} ${this.mobileToken} ${this.mobileSessionId}`);
    } else {
      this.send(`USER ${this.userId} ${this.hash} ${this.nickname} ${makePcFlag(this.challenge)}`);
    }
  }

  resolveAuth() {
    const resolve = this.authResolve;
    this.clearAuthWait();
    if (resolve) resolve(this.getSnapshot());
  }

  rejectAuth(err) {
    const reject = this.authReject;
    this.clearAuthWait();
    if (reject) reject(err);
  }

  clearAuthWait() {
    clearTimeout(this.authTimer);
    this.authTimer = null;
    this.authResolve = null;
    this.authReject = null;
  }

  async sendInventoryGiftNow({ recipientId, anonymous, itemIds, excludeItemIds = [], proxy }) {
    if (this.loginMode !== 'pc') {
      throw new Error('Enviar inventario requiere conectar esta cuenta en modo PC');
    }
    if (this.status !== 'connected' || !this.userId || !this.hash) {
      throw new Error('No hay sesion activa; inicia sesion antes de enviar regalos');
    }
    if (!recipientId || !recipientId.trim()) throw new Error('Falta ID destino');
    const proxyToUse = proxy ? normalizeProxySettings(proxy) : this.proxy;

    const inventory = await getMyInventory({
      userId: this.userId,
      passwordHash: this.hash,
      proxy: proxyToUse,
      logger: (message) => this.log(message)
    });

    const allowed = Array.isArray(itemIds) ? new Set(itemIds.map(String)) : null;
    const excluded = new Set((excludeItemIds || []).map(String));
    const items = {};
    for (const [itemId, count] of Object.entries(inventory)) {
      const id = String(itemId);
      if ((!allowed || allowed.has(id)) && !excluded.has(id) && count > 0) items[itemId] = count;
    }

    if (Object.keys(items).length === 0) {
      this.log('[Regalo] No hay items seleccionados en inventario');
      return;
    }

    await sendGifts({
      userId: this.userId,
      passwordHash: this.hash,
      recipientId: recipientId.trim(),
      items,
      anonymous,
      proxy: proxyToUse,
      logger: (message) => this.log(message)
    });
  }

  async spinFreeFortuneWheel() {
    if (this.loginMode !== 'pc') {
      throw new Error('La rueda requiere conectar esta cuenta en modo PC');
    }
    if (this.status !== 'connected' || !this.userId || !this.hash) {
      throw new Error('No hay sesion activa; inicia sesion antes de usar la rueda');
    }

    const maxSpins = 1000;
    let spins = 0;
    let openedChests = 0;
    this.log('[Rueda] Iniciando giros gratuitos...');

    while (spins < maxSpins) {
      const result = await spinFortuneWheel({
        userId: this.userId,
        passwordHash: this.hash,
        proxy: this.proxy
      });
      spins += 1;

      // Abrir los cofres que este giro haya completado antes de seguir.
      for (const [chestType, chest] of Object.entries(result.chests || {})) {
        const isDone = chest && (chest.isDone === true || chest.isDone === 1 || chest.isDone === 'true');
        if (!isDone) continue;

        await openFortuneWheelChest({
          userId: this.userId,
          passwordHash: this.hash,
          chestType,
          proxy: this.proxy
        });
        openedChests += 1;
        this.log(`[Rueda] Cofre ${chestType} abierto`);
      }

      // La respuesta del ultimo giro gratuito conserva el texto con (1).
      // Se detiene ahi para no iniciar un giro que el servidor pueda cobrar.
      const freeText = String(result.freePremiumText || result.freeText || '');
      const match = freeText.match(/gratuitamente\s*\((\d+)\)/i);
      const remaining = match ? Number(match[1]) : 0;
      if (!Number.isFinite(remaining) || remaining <= 1) {
        this.log(`[Rueda] Finalizada: ${spins} giro(s), ${openedChests} cofre(s) abierto(s)`);
        return { spins, openedChests };
      }
    }

    throw new Error(`La rueda supero el limite de seguridad de ${maxSpins} giros`);
  }

  // Pide el RECOVER real (10 caracteres) de la cuenta ya conectada. El POST
  // solo dispara el pedido; el codigo en si llega despues como un push por
  // este mismo WebSocket (ver 'SERV_JS_IN' en handleMessage), asi que esto
  // devuelve una promesa que se resuelve cuando esa linea llega, o rechaza
  // si pasan 15s sin respuesta.
  async fetchRecoveryCode() {
    if (this.status !== 'connected' || !this.userId || !this.hash) {
      throw new Error('No hay sesion activa; conecta antes de pedir el codigo de recuperacion');
    }
    if (this.recoveryCodeResolve) {
      throw new Error('Ya hay un pedido de codigo de recuperacion en curso');
    }

    return new Promise((resolve, reject) => {
      this.recoveryCodeResolve = resolve;
      this.recoveryCodeReject = reject;
      this.recoveryCodeTimer = setTimeout(() => {
        this.rejectRecoveryCode(new Error('Timeout esperando el codigo de recuperacion'));
      }, 15000);

      requestRecoveryCode({
        userId: this.userId,
        passwordHash: this.hash,
        proxy: this.proxy,
        logger: (message) => this.log(message)
      }).catch((err) => this.rejectRecoveryCode(err));
    });
  }

  resolveRecoveryCode(code) {
    const resolve = this.recoveryCodeResolve;
    this.clearRecoveryCodeWait();
    if (resolve) resolve(code);
  }

  rejectRecoveryCode(err) {
    const reject = this.recoveryCodeReject;
    this.clearRecoveryCodeWait();
    if (reject) reject(err);
  }

  clearRecoveryCodeWait() {
    clearTimeout(this.recoveryCodeTimer);
    this.recoveryCodeTimer = null;
    this.recoveryCodeResolve = null;
    this.recoveryCodeReject = null;
  }
}

module.exports = {
  GalaxyClient
};
