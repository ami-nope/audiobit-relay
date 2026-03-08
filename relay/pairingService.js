'use strict';

const { URL } = require('url');
const { createPairCode, createSessionId } = require('./utils');

function buildQrLink(baseUrl, sid, pairCode) {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('sid', sid);
    url.searchParams.set('code', pairCode);
    return url.toString();
  } catch (_) {
    return `${baseUrl}?sid=${encodeURIComponent(sid)}&code=${encodeURIComponent(pairCode)}`;
  }
}

function createSessionPairing(sessionManager, { sessionTtlMs, qrBaseUrl }) {
  let sid = '';
  do {
    sid = createSessionId();
  } while (sessionManager.hasSession(sid));

  let pairCode = '';
  let attempts = 0;
  do {
    pairCode = createPairCode();
    attempts += 1;
    if (attempts > 50) {
      throw new Error('Unable to allocate a unique pairing code.');
    }
  } while (sessionManager.isPairCodeInUse(pairCode));

  const createdAt = Date.now();
  const expiresAt = createdAt + sessionTtlMs;

  return {
    sid,
    pair_code: pairCode,
    created_at: createdAt,
    expires_at: expiresAt,
    qr_url: buildQrLink(qrBaseUrl, sid, pairCode)
  };
}

module.exports = {
  buildQrLink,
  createSessionPairing
};
