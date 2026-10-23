'use strict';

const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const { isProxyEnabled } = require('./proxy');

const GALAXY_HEADERS = {
  Origin: 'https://galaxy.mobstudio.ru',
  Referer: 'https://galaxy.mobstudio.ru/web/?desktop=1',
  Accept: '*/*',
  'x-galaxy-client-ver': '9.5',
  'x-galaxy-kbv': '352',
  'x-galaxy-lng': 'es',
  'x-galaxy-model': 'chrome 148.0.0.0',
  'x-galaxy-orientation': 'portrait',
  'x-galaxy-os-ver': '1',
  'x-galaxy-platform': 'web',
  'x-galaxy-scr-dpi': '1',
  'x-galaxy-scr-h': '801',
  'x-galaxy-scr-w': '700',
  'x-galaxy-user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
};

// Configuracion del sidecar Go: host/puerto donde escucha el endpoint /http.
// Se actualiza desde galaxy-client.js (o main.js) via setSidecarConfig().
let _sidecarHost = '127.0.0.1';
let _sidecarPort = 8791;

function setSidecarConfig({ host, port } = {}) {
  if (host) _sidecarHost = host;
  if (port) _sidecarPort = Number(port);
}

// Enruta una peticion HTTP a traves del endpoint /http del sidecar Go, que
// abre la conexion usando uTLS (mismo ClientHello Chrome que el bridge WS).
// La interfaz externa es la misma que antes: (urlStr, options, body?) => Promise<{body, headers, statusCode}>.
function requestFull(urlStr, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const cfg = options.proxy;
    const proxyEnabled = isProxyEnabled(cfg);

    // Armar el payload JSON para el sidecar
    const requestHeaders = {
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      ...(body != null
        ? {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        : {}),
      ...(options.headers || {})
    };

    const bodyBuf = body != null ? Buffer.from(body, 'utf8') : null;
    const payload = {
      method: options.method || 'GET',
      url: urlStr,
      headers: requestHeaders,
      body: bodyBuf ? bodyBuf.toString('base64') : ''
    };
    if (proxyEnabled) {
      payload.proxyHost = cfg.host;
      payload.proxyPort = cfg.port;
      if (cfg.username) payload.proxyUser = cfg.username;
      if (cfg.password) payload.proxyPass = cfg.password;
    }

    const payloadStr = JSON.stringify(payload);
    const payloadBuf = Buffer.from(payloadStr, 'utf8');

    const req = http.request(
      {
        hostname: _sidecarHost,
        port: _sidecarPort,
        path: '/http',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payloadBuf.length
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const responseText = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(responseText);
          } catch (e) {
            const preview = responseText.trim().slice(0, 300) || '<vacia>';
            reject(new Error(`Sidecar /http HTTP ${res.statusCode}: respuesta no JSON: ${preview}`));
            return;
          }
          if (parsed.error || res.statusCode >= 400) {
            reject(new Error(`Sidecar /http HTTP ${res.statusCode}: ${parsed.error || parsed.body || 'error desconocido'}`));
            return;
          }
          // El body viene en base64; descodificar y manejar compresion
          let rawBody = Buffer.from(parsed.body || '', 'base64');
          const encoding = ((parsed.headers && (
            parsed.headers['Content-Encoding'] ||
            parsed.headers['content-encoding']
          )) || []).join('').toLowerCase();
          const decompress = (buf, cb) => {
            if (encoding === 'gzip') zlib.gunzip(buf, cb);
            else if (encoding === 'deflate') zlib.inflate(buf, cb);
            else if (encoding === 'br') zlib.brotliDecompress(buf, cb);
            else cb(null, buf);
          };
          decompress(rawBody, (err, decompressed) => {
            if (err) {
              reject(new Error(`Sidecar /http: error descomprimiendo body: ${err.message}`));
              return;
            }
            // Aplanar headers (el sidecar los manda como { name: [v1,v2] })
            const flatHeaders = {};
            for (const [k, vs] of Object.entries(parsed.headers || {})) {
              flatHeaders[k.toLowerCase()] = Array.isArray(vs) ? vs[0] : vs;
            }
            resolve({
              body: decompressed.toString('utf8'),
              headers: flatHeaders,
              statusCode: parsed.statusCode
            });
          });
        });
        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.setTimeout(25000, () => {
      req.destroy();
      reject(new Error('HTTP timeout (sidecar)'));
    });
    req.write(payloadBuf);
    req.end();
  });
}

function requestText(urlStr, options = {}, body = null) {
  return requestFull(urlStr, options, body).then((r) => r.body);
}

// El navegador real decodifica ciertos headers de respuesta (como
// x-reg-nick) con decodeURIComponent(escape(valor)); en Node, un header con
// bytes UTF-8 llega ya interpretado como latin1/binary, asi que el
// equivalente es reinterpretar esos mismos bytes como UTF-8.
function decodeHeaderUtf8(value) {
  if (value == null) return null;
  try {
    return Buffer.from(String(value), 'latin1').toString('utf8');
  } catch {
    return value;
  }
}

function httpGet(url, headers = {}, proxy) {
  return requestText(url, { method: 'GET', headers, proxy });
}

function httpPost(url, postBody, headers = {}, proxy) {
  return requestText(url, { method: 'POST', headers, proxy }, postBody);
}

const SERVICES_BASE = 'https://galaxy.mobstudio.ru/services/';
const BROWSER_BASE = 'https://galaxy.mobstudio.ru/clients/api/v1/browser';

function buildFormBody(fields) {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value == null ? '' : String(value))}`)
    .join('&');
}

function buildAuthQuery({ userId, passwordHash }) {
  return `userID=${encodeURIComponent(userId)}&password=${encodeURIComponent(passwordHash)}`;
}

// Peticiones automaticas (no disparadas por boton) que replican trafico del
// cliente web real. No se hace nada con la respuesta; alcanza con que la
// peticion exista.

async function getBrowserVersions({ userId, passwordHash, proxy, logger }) {
  const auth = buildAuthQuery({ userId, passwordHash });
  const url = `${BROWSER_BASE}?${auth}&usercur=${userId}&random=${Math.random()}&ajax=1`;
  await httpGet(url, GALAXY_HEADERS, proxy);
  logger('[Auto] Versiones CSS/JS solicitadas');
}

async function getUserPics({ userId, passwordHash, userIds, proxy, logger }) {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).map(String).filter(Boolean);
  if (ids.length === 0) return;
  const auth = buildAuthQuery({ userId, passwordHash });
  const url = `${SERVICES_BASE}?a=user_pics_ajax&users_ids=${ids.join(',')}&${auth}&random=${Math.random()}&ajax=1`;
  await httpGet(url, GALAXY_HEADERS, proxy);
  logger(`[Auto] Avatares solicitados: ${ids.join(', ')}`);
}

async function getBalance({ userId, passwordHash, proxy, logger }) {
  const auth = buildAuthQuery({ userId, passwordHash });
  const url = `${SERVICES_BASE}?a=pay_get_balance&${auth}&usercur=${userId}&random=${Math.random()}&ajax=1`;
  await httpGet(url, GALAXY_HEADERS, proxy);
  logger('[Auto] Saldo solicitado');
}

// Parsea el HTML de show_inventory a {itemId: cantidad}. Compartido entre
// getMyInventory (inventario propio, en modo regalo) y getInventoryOf
// (inventario de OTRA cuenta, para el sistema de reabastecimiento).
function parseInventoryHtml(html) {
  const inventory = {};
  const itemRx = /data-type="(\d+)"[\s\S]*?class="s__game_item[^"]*"[\s\S]*?<div class="s__count">(\d+)<\/div>/g;
  let match;
  while ((match = itemRx.exec(html)) !== null) {
    inventory[match[1]] = parseInt(match[2], 10);
  }

  if (Object.keys(inventory).length === 0) {
    const altRx = /class="s__game_item[^"]*"[^>]*data-type="(\d+)"[\s\S]*?<div class="s__count">(\d+)<\/div>/g;
    while ((match = altRx.exec(html)) !== null) {
      inventory[match[1]] = parseInt(match[2], 10);
    }
  }

  return inventory;
}

function summarizeGiftError(response) {
  return String(response || '')
    // La respuesta puede incluir una URL con userID/password. Nunca debe ir al log.
    .replace(/(password=)[^&"'\s<]+/gi, '$1***')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot);/gi, (_, entity) => ({
      nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"'
    })[entity.toLowerCase()])
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220) || 'El servidor rechazó el regalo sin detallar el motivo';
}

function extractVisibleGiftError(response) {
  const html = String(response || '');
  // El HTML normal de Galaxy contiene la palabra "error" dentro de CSS y
  // scripts. Solo se considera rechazo un bloque visible marcado como error.
  const match = html.match(
    /<(?:div|p|span)[^>]*(?:class|id)=["'][^"']*(?:s_?error|error-message|alert-danger|alert-error)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|p|span)>/i
  );
  return match ? summarizeGiftError(match[1]) : null;
}

async function getMyInventory({ userId, passwordHash, proxy, logger }) {
  const base = 'https://galaxy.mobstudio.ru/services/';
  const auth = `userID=${encodeURIComponent(userId)}&password=${encodeURIComponent(passwordHash)}`;
  const r = () => Math.random();

  await httpGet(`${base}?a=pay_get_balance&${auth}&usercur=${userId}&random=${r()}&ajax=1`, GALAXY_HEADERS, proxy);
  const html = await httpGet(`${base}?${auth}&a=show_inventory&usercur=${userId}&random=${r()}`, GALAXY_HEADERS, proxy);

  const inventory = parseInventoryHtml(html);
  logger(`[Inventario] ${Object.keys(inventory).length} tipos encontrados`);
  return inventory;
}

// Inventario de OTRA cuenta (no la que esta autenticada), usado por el
// sistema de reabastecimiento: la cuenta "proveedora" (requesterUserId/
// requesterHash) consulta cuanto tiene una cuenta objetivo. A diferencia de
// getMyInventory, hace falta un paso extra (whois) para "entrar" al perfil
// de esa otra cuenta antes de poder pedir su inventario.
async function getInventoryOf({ requesterUserId, requesterHash, targetUserId, proxy, logger }) {
  const base = 'https://galaxy.mobstudio.ru/services/';
  const auth = `userID=${encodeURIComponent(requesterUserId)}&password=${encodeURIComponent(requesterHash)}`;
  const r = () => Math.random();

  await httpGet(`${base}?a=pay_get_balance&${auth}&usercur=${requesterUserId}&random=${r()}&ajax=1`, GALAXY_HEADERS, proxy);
  await httpGet(`${base}?${auth}&a=whois&usercur=${targetUserId}&random=${r()}`, GALAXY_HEADERS, proxy);
  const html = await httpGet(`${base}?${auth}&a=show_inventory&usercur=${targetUserId}&random=${r()}`, GALAXY_HEADERS, proxy);

  const inventory = parseInventoryHtml(html);
  logger(`[Proveedor] Inventario de ID ${targetUserId}: ${Object.keys(inventory).length} tipos encontrados`);
  return inventory;
}

async function sendGifts({ userId, passwordHash, recipientId, items, anonymous, proxy, logger }) {
  if (Object.keys(items).length === 0) throw new Error('No hay items para enviar');

  const totalCount = Object.values(items).reduce((total, count) => total + count, 0);
  const base = 'https://galaxy.mobstudio.ru/services/';
  const auth = `userID=${encodeURIComponent(userId)}&password=${encodeURIComponent(passwordHash)}`;
  const r = () => Math.random();

  await httpGet(`${base}?a=pay_get_balance&${auth}&usercur=${userId}&random=${r()}&ajax=1`, GALAXY_HEADERS, proxy);
  await httpGet(
    `${base}?${auth}&a=show_inventory&usercur=${userId}&present_for_user=${recipientId}&mode=present&random=${r()}`,
    GALAXY_HEADERS,
    proxy
  );

  const bodyParts = [
    `userID=${encodeURIComponent(userId)}`,
    `password=${encodeURIComponent(passwordHash)}`,
    'a=present_make',
    `usercur=${encodeURIComponent(recipientId)}`,
    'confirm=1',
    `random=${r()}`,
    'search_field=',
    `count=${totalCount}`,
    `give_anonymous=${anonymous ? 1 : 0}`,
    'jad_PartID=25',
    'jad_userID=null',
    'jad_DeviceId=',
    'jad_locale=es'
  ];

  for (const [id, qty] of Object.entries(items)) {
    bodyParts.push(`inventory_items%5B${encodeURIComponent(id)}%5D=${encodeURIComponent(qty)}`);
  }

  logger(`[Regalo] Enviando ${totalCount} item(s) a ID ${recipientId}`);
  const result = await httpPost(
    `${base}?${auth}&a=present_make&usercur=${recipientId}&confirm=1&random=${r()}`,
    bodyParts.join('&'),
    GALAXY_HEADERS,
    proxy
  );

  const visibleError = extractVisibleGiftError(result);
  if (visibleError) {
    const detail = visibleError;
    logger(`[Regalo] Respuesta con error: ${detail}`);
    throw new Error(`El servidor rechazó el regalo: ${detail}`);
  }
  logger('[Regalo] Respuesta OK del servidor');
  return result;
}

// La rueda usa el mismo endpoint /services y la misma huella HTTP web que
// los regalos. El sidecar conserva esa huella incluso cuando hay proxy.
const FORTUNE_WHEEL_REFERER =
  'https://galaxy.mobstudio.ru/web/assets/index.html?20&page_action=wheel_of_fortune_index&p=25';

function parseFortuneWheelResponse(raw, action) {
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') {
      throw new Error('respuesta JSON vacia');
    }
    return data;
  } catch (err) {
    throw new Error(`Respuesta invalida de la rueda (${action}): ${err.message}`);
  }
}

async function postFortuneWheel({ userId, passwordHash, action, wheelType, chestType, proxy }) {
  const auth = buildAuthQuery({ userId, passwordHash });
  const body = {
    a: action,
    ajax: 1
  };
  if (wheelType != null) body.wheelType = wheelType;
  if (chestType != null) body.chestType = chestType;

  const raw = await httpPost(
    `${SERVICES_BASE}?&${auth}&query_rand=${Math.random()}`,
    buildFormBody(body),
    { ...GALAXY_HEADERS, Referer: FORTUNE_WHEEL_REFERER },
    proxy
  );
  return parseFortuneWheelResponse(raw, action);
}

function spinFortuneWheel({ userId, passwordHash, proxy }) {
  return postFortuneWheel({
    userId,
    passwordHash,
    action: 'wheel_of_fortune_spin',
    wheelType: 3,
    proxy
  });
}

function openFortuneWheelChest({ userId, passwordHash, chestType, proxy }) {
  return postFortuneWheel({
    userId,
    passwordHash,
    action: 'wheel_of_fortune_chest_open',
    chestType,
    proxy
  });
}

// ============================================================
// CREACION DE CUENTA (boton "Conectar" con RECOVER vacio)
// ============================================================
// Replica el flujo de "Crear Personaje" -> "Saltar y entrar" del cliente
// web: pedir la pagina de registro (para leer 'numa', un valor opaco que el
// server ya trae puesto ahi), resolver el desafio Altcha (proof-of-work
// publico), y mandar el POST que crea la cuenta. La respuesta trae el ID,
// nickname y un hash de sesion (NO el RECOVER de 10 caracteres humano) en
// los headers x-reg-id/x-reg-nick/x-reg-pass.
//
// Valores fijos que copia el cliente web en cada creacion de cuenta
// (jad_PartID=25 ya se usaba en sendGifts; el resto son especificos de
// esta pantalla, capturados de Network):
// Pares fijos de (head, body) para cada genero.
// Se elige un par al azar en cada llamada a createAccount().
const SKIN_PAIRS = {
  // gender 0: hombre
  male: [
    { head: 112018, body: 238 },
    { head: 115316, body: 230 },
    { head: 116141, body: 261 },
    { head: 108008, body: 246 },
    { head: 8010,   body: 257 },
    { head: 114802, body: 234 },
    { head: 9478,   body: 229 },
    { head: 118174, body: 243 },
    { head: 112979, body: 224 },
    { head: 7,      body: 259 },
    { head: 9501,   body: 253 },
    { head: 113603, body: 245 },
    { head: 116136, body: 231 },
    { head: 100408, body: 249 },
    { head: 5564,   body: 244 },
    { head: 113090, body: 258 },
    { head: 259,    body: 233 },
    { head: 110742, body: 239 },
    { head: 115241, body: 236 },
    { head: 111135, body: 235 },
    { head: 9302,   body: 254 },
    { head: 7932,   body: 252 },
    { head: 5949,   body: 228 },
    { head: 5021,   body: 227 },
    { head: 117712, body: 255 }
  ],
  // gender 1: mujer
  female: [
    { head: 115038, body: 216 },
    { head: 112351, body: 208 },
    { head: 111934, body: 218 },
    { head: 113439, body: 193 },
    { head: 113252, body: 195 },
    { head: 115183, body: 215 },
    { head: 113442, body: 217 },
    { head: 111360, body: 211 },
    { head: 116391, body: 177 },
    { head: 118374, body: 191 },
    { head: 117618, body: 181 },
    { head: 9903,   body: 176 },
    { head: 118388, body: 204 },
    { head: 6668,   body: 189 },
    { head: 117148, body: 196 },
    { head: 101716, body: 198 },
    { head: 116407, body: 197 },
    { head: 117499, body: 222 },
    { head: 113019, body: 220 },
    { head: 116412, body: 212 },
    { head: 113032, body: 214 },
    { head: 113805, body: 210 },
    { head: 7618,   body: 188 },
    { head: 117098, body: 194 },
    { head: 111668, body: 221 }
  ]
};

function pickRandomSkin() {
  // Elegir genero al azar (0 = hombre, 1 = mujer)
  const gender = Math.floor(Math.random() * 2);
  return pickRandomSkinForGender(gender);
}

function pickRandomSkinForGender(inputGender) {
  const gender = Number(inputGender) === 1 ? 1 : 0;
  const pairs = gender === 0 ? SKIN_PAIRS.male : SKIN_PAIRS.female;
  const pair = pairs[Math.floor(Math.random() * pairs.length)];
  return { gender, head: pair.head, body: pair.body };
}

async function fetchRegistrationPage({ proxy, logger }) {
  const url = `${SERVICES_BASE}?a=user_reg&random=${Math.random()}`;
  const html = await httpGet(url, GALAXY_HEADERS, proxy);
  logger('[Registro] Pagina de registro obtenida');
  return html;
}

function extractNuma(html) {
  const match = html.match(/name=["']numa["'][^>]*value=["']([^"']+)["']/i)
    || html.match(/value=["']([^"']+)["'][^>]*name=["']numa["']/i);
  if (!match) throw new Error('No se encontro el campo numa en la pagina de registro');
  return match[1];
}

async function fetchAltchaChallenge({ proxy, logger }) {
  const url = `${SERVICES_BASE}?a=altcha_create_challenge&random=${Math.random()}`;
  const raw = await httpGet(url, GALAXY_HEADERS, proxy);
  const challenge = JSON.parse(raw);
  logger('[Registro] Desafio Altcha obtenido');
  return challenge;
}

// Fuerza bruta del proof-of-work de Altcha: buscar 'number' tal que
// SHA-256(salt + number) === challenge. El server ya manda salt/challenge/
// signature resueltos de su lado; el cliente solo aporta el 'number' (y
// 'took', cuanto tardo en encontrarlo).
function solveAltchaChallenge({ algorithm, challenge, salt, maxnumber }) {
  if (String(algorithm || 'SHA-256').toUpperCase() !== 'SHA-256') {
    throw new Error(`Algoritmo Altcha no soportado: ${algorithm}`);
  }
  const cap = Number(maxnumber) > 0 ? Number(maxnumber) : 1000000;
  const startedAt = Date.now();
  for (let number = 0; number <= cap; number++) {
    const hash = crypto.createHash('sha256').update(`${salt}${number}`).digest('hex');
    if (hash === challenge) {
      return { number, took: Date.now() - startedAt };
    }
  }
  throw new Error(`No se pudo resolver el desafio Altcha (rango 0..${cap} agotado)`);
}

async function solveAltcha({ proxy, logger }) {
  const challengeData = await fetchAltchaChallenge({ proxy, logger });
  const { number, took } = solveAltchaChallenge(challengeData);
  logger(`[Registro] Altcha resuelto en ${took}ms (number=${number})`);
  const payload = {
    algorithm: challengeData.algorithm,
    challenge: challengeData.challenge,
    number,
    salt: challengeData.salt,
    signature: challengeData.signature,
    took
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

async function sendRegistrationEvent({ numa, proxy, logger }) {
  const queryRand = Math.random();
  const url = `${SERVICES_BASE}?&userID=NaN&password=null&query_rand=${queryRand}`;
  const body = buildFormBody({
    a: 'registration_event',
    numa,
    type: 5,
    data: '',
    time: Math.floor(Date.now() / 1000),
    ajax: 1
  });
  await httpPost(url, body, GALAXY_HEADERS, proxy);
  logger('[Registro] Evento de registro enviado');
}

async function checkRegistrationNick({ nickname, proxy, logger }) {
  if (!nickname) return;
  const queryRand = Math.random();
  const url = `${SERVICES_BASE}?&userID=NaN&password=null&query_rand=${queryRand}`;
  const body = buildFormBody({
    a: 'registration_check_nick',
    nick: nickname,
    ajax: 1
  });
  const result = await httpPost(url, body, GALAXY_HEADERS, proxy);
  logger(`[Registro] Nick chequeado: ${nickname}`);
  return result;
}

// Crea una cuenta nueva ("Crear Personaje" -> disfraz default -> "Saltar y
// entrar", con nick opcional). Devuelve {id, nickname,
// passwordHash}: passwordHash es el hash de sesion de 32 caracteres (el
// mismo tipo de valor que ya usan getBalance/sendGifts/etc como
// passwordHash), NO el RECOVER humano de 10 caracteres -- ese se pide
// aparte con requestRecoveryCode() una vez conectado por WS.
async function createAccount({ proxy, logger, nickname, gender } = {}) {
  const log = logger || (() => {});
  const cleanNickname = typeof nickname === 'string' ? nickname.trim() : '';
  const html = await fetchRegistrationPage({ proxy, logger: log });
  const numa = extractNuma(html);
  if (cleanNickname) {
    await sendRegistrationEvent({ numa, proxy, logger: log });
    await checkRegistrationNick({ nickname: cleanNickname, proxy, logger: log });
  }
  const altcha = await solveAltcha({ proxy, logger: log });

  const skin = gender === undefined || gender === null || gender === ''
    ? pickRandomSkin()
    : pickRandomSkinForGender(gender);
  const bodyParts = [
    'gender=' + encodeURIComponent(skin.gender),
    'nick=' + encodeURIComponent(cleanNickname),
    'altcha=' + encodeURIComponent(altcha),
    'head=' + encodeURIComponent(skin.head),
    'body=' + encodeURIComponent(skin.body),
    'numa=' + encodeURIComponent(numa),
    'defaultHeadbodyPair=1',
    'jad_PartID=25',
    'jad_userID=null',
    'jad_DeviceId=',
    'jad_locale=es',
    'jad_advertisingId=',
    'recovery_code='
  ];

  const url = `${SERVICES_BASE}?userID=0&password=&a=registration_register&age_confirmed=1&random=${Math.random()}`;
  log('[Registro] Creando cuenta nueva...');
  const { headers } = await requestFull(url, { method: 'POST', headers: GALAXY_HEADERS, proxy }, bodyParts.join('&'));

  const id = headers['x-reg-id'];
  const accountNickname = decodeHeaderUtf8(headers['x-reg-nick']);
  const passwordHash = headers['x-reg-pass'];
  if (!id || !accountNickname || !passwordHash) {
    throw new Error('El server no devolvio x-reg-id/x-reg-nick/x-reg-pass; no se pudo crear la cuenta');
  }
  log(`[Registro] Cuenta creada: ID ${id}, nick ${accountNickname}`);
  return { id, nickname: accountNickname, passwordHash };
}

// Dispara el pedido del RECOVER real (10 caracteres) para la cuenta YA
// CONECTADA por WS. Esto solo avisa al server "quiero ver mi codigo"; el
// codigo en si llega despues como un push por el WebSocket ya abierto
// (linea SERV_JS_IN show_recovery_code :{"code":"..."}), lo maneja
// GalaxyClient, no esta funcion.
async function requestRecoveryCode({ userId, passwordHash, proxy, logger }) {
  const auth = buildAuthQuery({ userId, passwordHash });
  const url = `${SERVICES_BASE}?${auth}&a=user_settings_code_show&usercur=${userId}&random=${Math.random()}&ajax=1`;
  await httpPost(url, '', GALAXY_HEADERS, proxy);
  logger('[Registro] Codigo de recuperacion solicitado');
}

module.exports = {
  GALAXY_HEADERS,
  setSidecarConfig,
  getMyInventory,
  getInventoryOf,
  sendGifts,
  spinFortuneWheel,
  openFortuneWheelChest,
  getBrowserVersions,
  getUserPics,
  getBalance,
  createAccount,
  requestRecoveryCode
};
