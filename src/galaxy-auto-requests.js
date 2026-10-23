'use strict';

const { getBrowserVersions, getUserPics, getBalance } = require('./galaxy-http');

const BALANCE_INTERVAL_MS = 10000;

// Dispara las peticiones HTTP "de fondo" que hace el cliente web real y que
// no dependen de que el usuario apriete un boton: versiones CSS/JS (una vez
// por sesion), avatares (roster inicial y cambios de apariencia puntuales) y
// saldo (cada 10s). No hace nada con las respuestas; alcanza con que el
// trafico exista. El arranque/parada del ciclo de vida lo maneja GalaxyClient
// (start() en AUTH OK, stop() en disconnect()).
class GalaxyAutoRequests {
  constructor({ log }) {
    this.log = log || (() => {});
    this.userId = null;
    this.passwordHash = null;
    this.proxy = undefined;
    this.browserVersionsSent = false;
    this.balanceTimer = null;
    this.balanceInFlight = false;
  }

  hasCredentials() {
    return Boolean(this.userId && this.passwordHash);
  }

  start({ userId, passwordHash, proxy }) {
    this.userId = userId;
    this.passwordHash = passwordHash;
    this.proxy = proxy;
    this.browserVersionsSent = false;
    this.fireBrowserVersionsOnce();
    this.scheduleBalance();
  }

  stop() {
    this.userId = null;
    this.passwordHash = null;
    this.browserVersionsSent = false;
    if (this.balanceTimer) {
      clearTimeout(this.balanceTimer);
      this.balanceTimer = null;
    }
  }

  fireBrowserVersionsOnce() {
    if (this.browserVersionsSent || !this.hasCredentials()) return;
    this.browserVersionsSent = true;
    getBrowserVersions({
      userId: this.userId,
      passwordHash: this.passwordHash,
      proxy: this.proxy,
      logger: (m) => this.log(m)
    }).catch((err) => this.log(`[Auto] Error versiones CSS/JS: ${err.message}`));
  }

  scheduleBalance() {
    if (this.balanceTimer) return;
    const tick = async () => {
      if (!this.hasCredentials()) {
        this.balanceTimer = null;
        return;
      }
      if (!this.balanceInFlight) {
        this.balanceInFlight = true;
        try {
          await getBalance({
            userId: this.userId,
            passwordHash: this.passwordHash,
            proxy: this.proxy,
            logger: (m) => this.log(m)
          });
        } catch (err) {
          this.log(`[Auto] Error saldo: ${err.message}`);
        } finally {
          this.balanceInFlight = false;
        }
      }
      this.balanceTimer = setTimeout(tick, BALANCE_INTERVAL_MS);
    };
    this.balanceTimer = setTimeout(tick, BALANCE_INTERVAL_MS);
  }

  requestAvatars(userIds) {
    if (!this.hasCredentials()) return;
    getUserPics({
      userId: this.userId,
      passwordHash: this.passwordHash,
      userIds,
      proxy: this.proxy,
      logger: (m) => this.log(m)
    }).catch((err) => this.log(`[Auto] Error avatares: ${err.message}`));
  }

  // Se llama con cada linea cruda del protocolo (la misma que recibe
  // GalaxyClient.handleMessage). Detecta 353 (roster), JOIN (usuario que
  // llega al planeta) y 880 (cambio de apariencia puntual) y dispara el
  // pedido de avatares correspondiente.
  handleRawMessage(msg) {
    if (!this.hasCredentials()) return;

    if (msg.includes('353 1 =')) {
      const ids = msg.match(/\d{6,10}/g);
      if (ids && ids.length > 0) this.requestAvatars(ids);
      return;
    }

    // JOIN NombreUsuario ID :planeta  →  pedir avatar del usuario que llega
    if (msg.startsWith('JOIN ')) {
      const tokens = msg.split(/\s+/);
      for (let i = 1; i < tokens.length; i++) {
        if (!/^\d{6,10}$/.test(tokens[i])) continue;
        const id = tokens[i];
        const name = (tokens[i - 1] || '').replace(/^[:\-=@]+/, '').trim();
        // Saltear la entrada del planeta en si (no es un usuario)
        if (!name || name.startsWith('RingToss*')) break;
        this.requestAvatars([id]);
        break;
      }
      return;
    }

    const viewChange = msg.match(/^880\s+(\d{6,10})\b/);
    if (viewChange) this.requestAvatars([viewChange[1]]);
  }
}

module.exports = { GalaxyAutoRequests };