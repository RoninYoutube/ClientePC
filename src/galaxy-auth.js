'use strict';

const crypto = require('crypto');

const MOBILE_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MOBILE_SEED = '5itndg36hj';
const MOBILE_TABLE = [28, 30, 28, 29, 28, 29, 26, 26, 28, 26, 26, 28, 27, 27, 29, 30, 27, 27, 13, 28, 28, 17, 26, 28, 26, 24, 33, 29, 28, 28, 28, 28, 27, 29, 27, 28, 29, 29, 29, 30, 29, 29, 28, 30, 28, 29, 28, 28, 29, 30, 18];

function mobileInt(value) { return value | 0; }

function mobileLong(value) {
  value = ((value % (2n ** 64n)) + 2n ** 64n) % (2n ** 64n);
  return value >= 2n ** 63n ? value - 2n ** 64n : value;
}

function mobileIntFromLong(value) {
  return mobileInt(Number(mobileLong(value) & 0xffffffffn) | 0);
}

function mutateMobileToken(chars, values) {
  let changes = 1;
  for (let index = 0; index < values.length * 4; index++) {
    const current = index % values.length;
    const target = Math.abs(mobileInt(mobileInt(Math.imul(index, values[current])) + values[current])) % values.length;
    const currentChar = chars[current].charCodeAt(0);
    const targetChar = chars[target].charCodeAt(0);
    if (Math.abs(currentChar - targetChar) > values.length + MOBILE_TABLE[Math.abs(values.length % 51)]) {
      const middle = Math.trunc((current + target) / 2);
      values[middle] = mobileInt(values[middle] + 1);
      values[current] = mobileInt(values[current] + targetChar);
      values[target] = mobileInt(values[target] + currentChar);
      changes++;
    }
  }
  return changes;
}

function buildMobileTokenChars(rounds, chars, seed, values, offset) {
  const text = chars.join('');
  for (let index = 0; index < text.length; index++) {
    let value = mobileInt(values[index] + (text.charCodeAt(index) | offset));
    values[index] = value;
    value = mobileInt(Number(mobileLong(BigInt(rounds) + seed + BigInt(value)) & 0xffffffffn) | 0);
    values[index] = value;
    offset = mobileInt(offset + value);
    value = mobileInt(value + 94736404);
    values[index] = value;
    chars[index] = MOBILE_CHARSET.charAt(Math.abs(value % 62));
  }
}

// Equivalente a m8460a() de la APK: construye el primer token del login movil.
function makeMobileToken(challenge) {
  let seed = mobileLong(8167260239830188540n);
  for (let index = 0; index < challenge.length; index++) {
    seed = mobileLong(seed + mobileLong(BigInt(challenge.charCodeAt(index)) * 8167260239830188032n));
  }

  let multiplier = 1n;
  let current = seed;
  for (let index = 9; index >= 0; index--) {
    const value = BigInt(MOBILE_CHARSET.indexOf(MOBILE_SEED.charAt(index)) + 1);
    current = mobileLong(current + mobileLong(value * multiplier) + 94736404n);
    multiplier = mobileLong(multiplier * 63n);
  }

  const values = new Array(10);
  const chars = MOBILE_SEED.split('');
  values[0] = mobileIntFromLong((current + current + 94736404n) * current);
  for (let index = 1; index < 10; index++) {
    values[index] = mobileIntFromLong((BigInt(index) + current + BigInt(values[index - 1])) * current);
  }
  buildMobileTokenChars(10, chars, current, values, mutateMobileToken(chars, values));
  return chars.join('');
}

function makeMobileSessionId() {
  let result = '';
  for (let index = 0; index < 16; index++) {
    result += MOBILE_CHARSET.charAt(Math.floor(Math.random() * MOBILE_CHARSET.length));
  }
  return result;
}

class ZaF {
  constructor(timeLo, timeHi) {
    this.c = timeLo | 0;
    this.d = timeHi | 0;
    this.e = 0;
    this.f = 0;
    this.g = ~timeLo | 0;
    this.h = ((timeLo << 10) ^ (timeHi >>> 4)) | 0;
    if ((this.c | this.d | this.e | this.f | this.g | this.h) === 0) {
      throw new Error('ZaF invalid zero state');
    }
    for (let i = 0; i < 64; i++) this.b();
  }

  b() {
    let v0 = this.c | 0;
    v0 = (v0 ^ (v0 >>> 2)) | 0;
    this.c = this.d;
    this.d = this.e;
    this.e = this.f;
    this.f = this.g;
    const v1 = this.g | 0;
    v0 = (v0 ^ (v0 << 1)) | 0;
    v0 = (v0 ^ v1) | 0;
    v0 = (v0 ^ (v1 << 4)) | 0;
    this.g = v0;
    this.h = (this.h + 0x587c5) | 0;
    return (v0 + this.h) | 0;
  }

  bounded(bound) {
    return Math.abs(this.b()) % (bound + 1);
  }
}

function processChq(params) {
  const combined = params[0];
  const n1 = parseInt(params[1], 10);
  const n3 = parseInt(params[3], 10);
  const len = combined.length;
  const baseSub1 = combined.substring(len - n1 - n3, len - n3);
  const baseSub2 = combined.substring(0, len - n1 - n3);
  const baseSub3 = combined.substring(len - n3);
  const decoded12 = Buffer.from(baseSub1 + baseSub2, 'base64').toString('utf8');
  const decoded3 = Buffer.from(baseSub3, 'base64').toString('utf8');
  const parts = decoded12.split('+');
  const now = BigInt(Date.now());
  const timeLo = Number(now & 0xffffffffn) | 0;
  const timeHi = Number((now >> 32n) & 0xffffffffn) | 0;
  const rng = new ZaF(timeLo, timeHi);
  const rb = rng.bounded(0x7ffffffe) + 1;
  const rc = rng.bounded(0x7ffffffe) + 1;
  const rng3 = rng.bounded(99) + 1;
  const rng4 = rng.bounded(99) + 1;
  const s0 = `${decoded3}${parts[0]}${rc}${decoded3}`;
  const s1 = `${decoded3}${parts[1]}${rb}${decoded3}`;
  const chosen = rng3 >= 50 ? s0 : s1;
  const hash = crypto.createHash('sha1').update(Buffer.from(chosen, 'utf8')).digest();
  return { a: hash.toString('base64'), b: rb, c: rc, d: rng3, e: rng4 };
}

function handleChq(rawMessage) {
  const tokens = rawMessage.trim().split(' ');
  tokens.shift();
  const tde = processChq(tokens);
  return `CHR ${tde.a} ${tde.b} ${tde.c} ${tde.d} ${tde.e}`;
}

function makePcFlag(challenge) {
  const hashMd5 = crypto.createHash('md5').update(challenge).digest('hex');
  const chars = hashMd5.split('').reverse().join('').substring(3, 8);
  let flag = '';
  for (let i = 0; i < chars.length; i++) flag += `0${chars[i]}`;
  return flag;
}

module.exports = {
  handleChq,
  makePcFlag,
  makeMobileToken,
  makeMobileSessionId
};
