'use strict';

module.exports = Object.freeze({
  PORT: Number.parseInt(process.env.PORT || '8080', 10),
  SESSION_TTL_MS: Number.parseInt(process.env.SESSION_TTL_MS || String(5 * 60 * 1000), 10),
  HEARTBEAT_INTERVAL_MS: Number.parseInt(process.env.HEARTBEAT_INTERVAL_MS || '15000', 10),
  MAX_MESSAGE_BYTES: Number.parseInt(process.env.MAX_MESSAGE_BYTES || String(64 * 1024), 10),
  QR_BASE_URL: process.env.QR_BASE_URL || 'https://remote.audiobit.app/connect',
  WS_PATH: process.env.WS_PATH || '/ws'
});
