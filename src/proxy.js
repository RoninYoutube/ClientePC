'use strict';

const https = require('https');
const net = require('net');
const tls = require('tls');
const WebSocket = require('ws');

function normalizeProxySettings(input) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    enabled: Boolean(src.enabled),
    host: typeof src.host === 'string' ? src.host.trim() : '',
    port: typeof src.port === 'string' || typeof src.port === 'number'
      ? String(src.port).trim()
      : '',
    username: typeof src.username === 'string' ? src.username.trim() : '',
    password: typeof src.password === 'string' ? src.password : ''
  };
}

function isProxyEnabled(input) {
  const proxy = normalizeProxySettings(input);
  const port = Number(proxy.port);
  return Boolean(proxy.enabled && proxy.host && Number.isInteger(port) && port > 0 && port <= 65535);
}

function proxyLabel(input) {
  const proxy = normalizeProxySettings(input);
  return isProxyEnabled(proxy) ? `${proxy.host}:${proxy.port}` : 'sin proxy';
}

function proxyAuthHeader(proxy) {
  if (!proxy.username && !proxy.password) return '';
  return `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`, 'utf8').toString('base64')}`;
}

function connectHttpProxyTunnel({ proxy, targetHost, targetPort, timeout = 15000 }) {
  const cfg = normalizeProxySettings(proxy);
  if (!isProxyEnabled(cfg)) throw new Error('Proxy incompleto o desactivado');

  return new Promise((resolve, reject) => {
    let settled = false;
    let response = Buffer.alloc(0);
    const socket = net.connect({ host: cfg.host, port: Number(cfg.port) });

    const done = (err, result) => {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.setTimeout(0);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve(result);
      }
    };

    const onError = (err) => done(err);

    function onData(chunk) {
      response = Buffer.concat([response, chunk]);
      const marker = response.indexOf('\r\n\r\n');
      if (marker === -1) return;

      const header = response.slice(0, marker).toString('latin1');
      const rest = response.slice(marker + 4);
      const firstLine = header.split(/\r?\n/, 1)[0] || '';
      const status = firstLine.match(/\s(\d{3})\s/);
      const statusCode = status ? Number(status[1]) : 0;

      if (statusCode !== 200) {
        done(new Error(`Proxy CONNECT rechazo ${targetHost}:${targetPort} (${firstLine || 'sin respuesta'})`));
        return;
      }

      if (rest.length > 0) socket.unshift(rest);
      done(null, socket);
    }

    socket.setTimeout(timeout, () => {
      done(new Error(`Proxy timeout ${cfg.host}:${cfg.port}`));
    });

    socket.on('error', onError);
    socket.on('data', onData);
    socket.once('connect', () => {
      const headers = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        'Connection: Keep-Alive',
        'Proxy-Connection: Keep-Alive'
      ];
      const auth = proxyAuthHeader(cfg);
      if (auth) headers.push(`Proxy-Authorization: ${auth}`);
      socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    });
  });
}

class HttpsProxyConnectAgent extends https.Agent {
  constructor(proxy) {
    super({ keepAlive: false });
    this.proxy = normalizeProxySettings(proxy);
  }

  createConnection(options, callback) {
    const targetHost = options.hostname || options.host;
    const targetPort = Number(options.port) || 443;
    let finished = false;

    const done = (err, socket) => {
      if (finished) return;
      finished = true;
      if (callback) callback(err, socket);
    };

    connectHttpProxyTunnel({
      proxy: this.proxy,
      targetHost,
      targetPort
    })
      .then((plainSocket) => {
        const secureSocket = tls.connect({
          ...options,
          socket: plainSocket,
          servername: options.servername || targetHost
        });
        secureSocket.once('secureConnect', () => done(null, secureSocket));
        secureSocket.once('error', (err) => done(err));
      })
      .catch((err) => done(err));
  }
}

// Reemplaza al antiguo connectTls (TCP+TLS crudo). La sesion "pc" real es la
// version web (galaxy.mobstudio.ru), que habla el protocolo por un WebSocket
// (wss://cs.mobstudio.ru:6672/), no por un socket TCP directo. El agente de
// proxy (HttpsProxyConnectAgent) se reutiliza tal cual: 'ws' lo usa igual que
// cualquier https.Agent para tunelizar el handshake WS a traves del proxy.
//
// Devuelve el socket de forma SINCRONICA (como hacia tls.connect() en el
// codigo original) para que el que llama pueda enganchar sus listeners
// (message/close/error) antes de que el handshake termine. Si en cambio se
// esperara una Promise que resuelve en 'open' antes de devolver el socket,
// un servidor que manda datos apenas completa el handshake podria emitir
// 'open' y el primer 'message' de forma sincrona en el mismo tick, y el
// listener externo llegaria tarde a engancharse (mensaje perdido).
function createWebSocketConnection({ url, headers = {}, proxy } = {}) {
  const cfg = normalizeProxySettings(proxy);
  const agent = isProxyEnabled(cfg) ? new HttpsProxyConnectAgent(cfg) : undefined;

  return new WebSocket(url, {
    headers,
    agent,
    perMessageDeflate: true,
    rejectUnauthorized: false
  });
}

// DESPUÉS
// Arma la URL local del sidecar Go (ver main.go: bridgeHandler / parseProxyFromQuery).
// El tunel de proxy y el ClientHello uTLS los resuelve el sidecar; esta conexion
// local es siempre ws:// plano en loopback, nunca necesita agente de proxy propio.
function buildSidecarBridgeUrl({ sidecarHost = '127.0.0.1', sidecarPort, targetUrl, proxy, headers } = {}) {
  if (!sidecarPort) throw new Error('Falta sidecarPort para conectar via sidecar');
  const cfg = normalizeProxySettings(proxy);
  const params = new URLSearchParams({ target: targetUrl });
  if (headers && typeof headers === 'object' && Object.keys(headers).length > 0) {
    params.set('headers', JSON.stringify(headers));
  }
  if (isProxyEnabled(cfg)) {
    params.set('proxyHost', cfg.host);
    params.set('proxyPort', cfg.port);
    if (cfg.username) params.set('proxyUser', cfg.username);
    if (cfg.password) params.set('proxyPass', cfg.password);
  }
  return `ws://${sidecarHost}:${sidecarPort}/bridge?${params.toString()}`;
}

// Reemplaza a createWebSocketConnection para el socket de juego: en vez de
// conectar directo contra el server real (TLS nativo de Node, delata el
// binario), conecta contra el bridge del sidecar Go, que hace el handshake
// real con un ClientHello clonado de Chrome (uTLS) y reenvia los frames 1:1.
function createSidecarBridgeConnection({ sidecarHost, sidecarPort, targetUrl, proxy, headers } = {}) {
  const url = buildSidecarBridgeUrl({ sidecarHost, sidecarPort, targetUrl, proxy, headers });
  return new WebSocket(url, { perMessageDeflate: false });
}

function createTlsConnection({ host, port, rejectUnauthorized = false, proxy } = {}) {
  if (!isProxyEnabled(proxy)) {
    return Promise.resolve(tls.connect({ host, port, rejectUnauthorized }));
  }

  return connectHttpProxyTunnel({ proxy, targetHost: host, targetPort: port })
    .then((plainSocket) => tls.connect({
      socket: plainSocket,
      servername: host,
      rejectUnauthorized
    }));
}

module.exports = {
  HttpsProxyConnectAgent,
  createWebSocketConnection,
  createSidecarBridgeConnection,
  createTlsConnection,
  isProxyEnabled,
  normalizeProxySettings,
  proxyLabel
};
