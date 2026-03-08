'use strict';

const SUPPORTED_TYPES = new Set([
  'hello_pc',
  'hello_remote',
  'hello_ok',
  'session_status',
  'state',
  'lvl',
  'devices',
  'cmd',
  'cmd_result',
  'ping',
  'pong',
  'resync',
  'err'
]);

const ROLE_ALLOWED_TYPES = Object.freeze({
  pc: new Set(['state', 'lvl', 'devices', 'cmd_result', 'session_status', 'ping', 'pong']),
  remote: new Set(['cmd', 'resync', 'ping', 'pong'])
});

function fail(code, message) {
  return {
    ok: false,
    code,
    message
  };
}

function createProtocolValidator({ maxMessageBytes }) {
  function validateIncomingMessage(rawMessage) {
    if (typeof rawMessage !== 'string') {
      return fail('invalid_payload', 'Only text JSON payloads are supported.');
    }

    if (Buffer.byteLength(rawMessage, 'utf8') > maxMessageBytes) {
      return fail('payload_too_large', 'Message exceeds maximum size.');
    }

    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch (_) {
      return fail('invalid_json', 'Message is not valid JSON.');
    }

    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return fail('invalid_message', 'Message root must be an object.');
    }

    if (typeof message.t !== 'string' || message.t.length === 0) {
      return fail('missing_type', 'Message type "t" is required.');
    }

    if (!SUPPORTED_TYPES.has(message.t)) {
      return fail('unsupported_type', `Unsupported message type "${message.t}".`);
    }

    if (message.t === 'hello_pc') {
      if (typeof message.sid !== 'string' || !message.sid.trim()) {
        return fail('invalid_sid', 'hello_pc requires sid.');
      }
    }

    if (message.t === 'hello_remote') {
      if (typeof message.sid !== 'string' || !message.sid.trim()) {
        return fail('invalid_sid', 'hello_remote requires sid.');
      }
      if (typeof message.pair_code !== 'string' || !/^\d{6}$/.test(message.pair_code)) {
        return fail('invalid_pair_code', 'hello_remote requires a 6-digit pair_code.');
      }
    }

    return {
      ok: true,
      message
    };
  }

  function isTypeAllowedForRole(role, messageType) {
    const allowed = ROLE_ALLOWED_TYPES[role];
    if (!allowed) {
      return false;
    }
    return allowed.has(messageType);
  }

  return {
    isTypeAllowedForRole,
    validateIncomingMessage
  };
}

module.exports = {
  createProtocolValidator
};
