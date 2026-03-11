'use strict';

const { URL } = require('url');
const { createPairCode, createSessionId } = require('./utils');

const SID_PATTERN = /^[A-Za-z0-9]{10}$/;
const PAIR_CODE_PATTERN = /^\d{6}$/;

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

function createSessionPairing(
  sessionManager,
  { sessionTtlMs, qrBaseUrl, requestedSid = '', requestedPairCode = '' }
) {
  const trimmedSid = typeof requestedSid === 'string' ? requestedSid.trim() : '';
  const trimmedPairCode = typeof requestedPairCode === 'string' ? requestedPairCode.trim() : '';

  let sid = '';
  if (trimmedSid) {
    if (!SID_PATTERN.test(trimmedSid)) {
      throw new Error('sid must be 10 alphanumeric characters.');
    }
    if (sessionManager.hasSession(trimmedSid)) {
      throw new Error('sid is already in use.');
    }
    sid = trimmedSid;
  } else {
    do {
      sid = createSessionId();
    } while (sessionManager.hasSession(sid));
  }

  let pairCode = '';
  if (trimmedPairCode) {
    if (!PAIR_CODE_PATTERN.test(trimmedPairCode)) {
      throw new Error('pair_code must be a 6-digit string.');
    }
    if (sessionManager.isPairCodeInUse(trimmedPairCode)) {
      throw new Error('pair_code is already in use.');
    }
    pairCode = trimmedPairCode;
  } else {
    let attempts = 0;
    do {
      pairCode = createPairCode();
      attempts += 1;
      if (attempts > 50) {
        throw new Error('Unable to allocate a unique pairing code.');
      }
    } while (sessionManager.isPairCodeInUse(pairCode));
  }

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
