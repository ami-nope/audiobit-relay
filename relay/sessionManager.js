'use strict';

const { closeWs, isWsOpen } = require('./utils');

function sanitizeDeviceValue(value, maxLength = 160) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.slice(0, maxLength);
}

class SessionManager {
  constructor({ sessionTtlMs }) {
    this.sessionTtlMs = sessionTtlMs;
    this.sessions = new Map();
    this.socketMeta = new WeakMap();
    this.remoteDeviceIndex = new Map();
  }

  createSession({ sid, pairCode, createdAt, expiresAt }) {
    const session = {
      pc_conn: null,
      remote_conns: new Set(),
      pair_code: pairCode,
      last_state: null,
      last_state_raw: null,
      last_rev: 0,
      created_at: createdAt,
      expires_at: expiresAt,
      cmd_queue: []
    };
    this.sessions.set(sid, session);
    return session;
  }

  getSession(sid) {
    return this.sessions.get(sid) || null;
  }

  hasSession(sid) {
    return this.sessions.has(sid);
  }

  getSessionCount() {
    return this.sessions.size;
  }

  isPairCodeInUse(pairCode) {
    for (const session of this.sessions.values()) {
      if (session.pair_code === pairCode) {
        return true;
      }
    }
    return false;
  }

  isSessionExpired(session) {
    return !session.pc_conn && session.expires_at <= Date.now();
  }

  pruneStaleRemotes(session) {
    const staleSockets = [];
    for (const remoteWs of session.remote_conns) {
      if (isWsOpen(remoteWs)) {
        continue;
      }
      staleSockets.push(remoteWs);
    }

    for (const staleWs of staleSockets) {
      const staleMeta = this.getSocketMeta(staleWs);
      if (staleMeta && staleMeta.role === 'remote' && staleMeta.device_id) {
        const deviceRef = this.remoteDeviceIndex.get(staleMeta.device_id);
        if (deviceRef && deviceRef.ws === staleWs) {
          this.remoteDeviceIndex.delete(staleMeta.device_id);
        }
      }
      session.remote_conns.delete(staleWs);
      this.socketMeta.delete(staleWs);
    }
  }

  registerPc(sid, ws, pcIdentity = {}) {
    const session = this.getSession(sid);
    if (!session) {
      return { ok: false, code: 'session_not_found', message: 'Session does not exist.' };
    }

    if (this.isSessionExpired(session)) {
      return { ok: false, code: 'session_expired', message: 'Session has expired.' };
    }

    if (session.pc_conn && !isWsOpen(session.pc_conn)) {
      session.pc_conn = null;
    }

    if (session.pc_conn && session.pc_conn !== ws) {
      return { ok: false, code: 'pc_already_connected', message: 'A PC is already connected.' };
    }

    session.pc_conn = ws;
    session.expires_at = Number.MAX_SAFE_INTEGER;
    this.socketMeta.set(ws, {
      sid,
      role: 'pc',
      device_name: sanitizeDeviceValue(pcIdentity.device_name, 128) || 'PC',
      connection_type: sanitizeDeviceValue(pcIdentity.connection_type, 64) || 'websocket',
      ip: sanitizeDeviceValue(pcIdentity.ip, 128) || null,
      user_agent: sanitizeDeviceValue(pcIdentity.user_agent, 256) || null,
      connected_at: Date.now()
    });
    return { ok: true, session };
  }

  registerRemote(sid, pairCode, ws, remoteIdentity = {}) {
    const session = this.getSession(sid);
    if (!session) {
      return { ok: false, code: 'session_not_found', message: 'Session does not exist.' };
    }

    if (this.isSessionExpired(session)) {
      return { ok: false, code: 'session_expired', message: 'Session has expired.' };
    }

    if (session.pair_code !== pairCode) {
      return { ok: false, code: 'pair_code_invalid', message: 'Pairing code is invalid.' };
    }

    this.pruneStaleRemotes(session);

    const generatedDeviceId = `remote_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const deviceId = sanitizeDeviceValue(remoteIdentity.device_id, 128) || generatedDeviceId;
    const indexedDevice = this.remoteDeviceIndex.get(deviceId);
    if (indexedDevice && indexedDevice.ws !== ws) {
      if (!isWsOpen(indexedDevice.ws)) {
        this.remoteDeviceIndex.delete(deviceId);
      } else if (indexedDevice.sid !== sid) {
        return {
          ok: false,
          code: 'device_bound_to_other_session',
          message: 'This device is already connected to another session.'
        };
      } else {
        return {
          ok: false,
          code: 'device_already_connected',
          message: 'This device is already connected to this session.'
        };
      }
    }

    const remoteMeta = {
      sid,
      role: 'remote',
      device_id: deviceId,
      device_name: sanitizeDeviceValue(remoteIdentity.device_name, 128) || 'Unknown device',
      device_location: sanitizeDeviceValue(remoteIdentity.device_location, 128) || null,
      connection_type: sanitizeDeviceValue(remoteIdentity.connection_type, 64) || 'websocket',
      ip: sanitizeDeviceValue(remoteIdentity.ip, 128) || null,
      user_agent: sanitizeDeviceValue(remoteIdentity.user_agent, 256) || null,
      connected_at: Date.now()
    };

    session.remote_conns.add(ws);
    this.socketMeta.set(ws, remoteMeta);
    this.remoteDeviceIndex.set(deviceId, { sid, ws });
    return { ok: true, session, remoteMeta };
  }

  getSocketMeta(ws) {
    return this.socketMeta.get(ws) || null;
  }

  clearSocketMeta(ws) {
    this.socketMeta.delete(ws);
  }

  cacheState(sid, statePayload, rawMessage) {
    const session = this.getSession(sid);
    if (!session) {
      return;
    }

    const incomingRev = statePayload && Number.isFinite(statePayload.rev) ? statePayload.rev : null;
    session.last_rev = incomingRev === null ? session.last_rev + 1 : incomingRev;
    session.last_state = statePayload;
    session.last_state_raw = rawMessage;
  }

  getCachedStateRaw(sid) {
    const session = this.getSession(sid);
    if (!session) {
      return null;
    }
    return session.last_state_raw;
  }

  enqueueCommand(sid, ws, rawMessage) {
    const session = this.getSession(sid);
    if (!session) {
      return null;
    }
    const entry = { ws, rawMessage, enqueuedAt: Date.now() };
    session.cmd_queue.push(entry);
    const position = session.cmd_queue.length;
    return { position, shouldForwardNow: position === 1 };
  }

  dequeueCommand(sid) {
    const session = this.getSession(sid);
    if (!session || session.cmd_queue.length === 0) {
      return null;
    }
    session.cmd_queue.shift();
    return session.cmd_queue.length > 0 ? session.cmd_queue[0] : null;
  }

  peekCommand(sid) {
    const session = this.getSession(sid);
    if (!session || session.cmd_queue.length === 0) {
      return null;
    }
    return session.cmd_queue[0];
  }

  getQueueLength(sid) {
    const session = this.getSession(sid);
    if (!session) {
      return 0;
    }
    return session.cmd_queue.length;
  }

  removeCommandsBySocket(sid, ws) {
    const session = this.getSession(sid);
    if (!session) {
      return { removedCount: 0, wasHead: false };
    }
    const wasHead = session.cmd_queue.length > 0 && session.cmd_queue[0].ws === ws;
    const before = session.cmd_queue.length;
    session.cmd_queue = session.cmd_queue.filter(entry => entry.ws !== ws);
    return { removedCount: before - session.cmd_queue.length, wasHead };
  }

  removeSocket(ws) {
    const meta = this.getSocketMeta(ws);
    if (!meta) {
      return null;
    }

    const session = this.getSession(meta.sid);
    this.socketMeta.delete(ws);

    if (!session) {
      return { ...meta, session: null };
    }

    if (meta.role === 'pc') {
      if (session.pc_conn === ws) {
        session.pc_conn = null;
        session.expires_at = Date.now() + this.sessionTtlMs;
      }
    } else if (meta.role === 'remote') {
      session.remote_conns.delete(ws);
      if (meta.device_id) {
        const deviceRef = this.remoteDeviceIndex.get(meta.device_id);
        if (deviceRef && deviceRef.ws === ws) {
          this.remoteDeviceIndex.delete(meta.device_id);
        }
      }
      this.removeCommandsBySocket(meta.sid, ws);
    }

    if (!session.pc_conn && session.remote_conns.size === 0 && session.expires_at <= Date.now()) {
      this.sessions.delete(meta.sid);
    }

    return { ...meta, session };
  }

  findRemoteSocket(sid, deviceId) {
    const session = this.getSession(sid);
    if (!session) {
      return null;
    }

    this.pruneStaleRemotes(session);
    if (deviceId) {
      const wantedId = sanitizeDeviceValue(deviceId, 128);
      for (const remoteWs of session.remote_conns) {
        const meta = this.getSocketMeta(remoteWs);
        if (meta && meta.role === 'remote' && meta.device_id === wantedId) {
          return remoteWs;
        }
      }
      return null;
    }

    for (const remoteWs of session.remote_conns) {
      return remoteWs;
    }
    return null;
  }

  terminateSession(sid, { remoteCloseCode = 4002, remoteCloseReason = 'session_terminated' } = {}) {
    const session = this.getSession(sid);
    if (!session) {
      return null;
    }

    if (session.pc_conn) {
      this.socketMeta.delete(session.pc_conn);
      session.pc_conn = null;
    }

    for (const remoteWs of session.remote_conns) {
      const meta = this.getSocketMeta(remoteWs);
      if (meta && meta.role === 'remote' && meta.device_id) {
        const deviceRef = this.remoteDeviceIndex.get(meta.device_id);
        if (deviceRef && deviceRef.ws === remoteWs) {
          this.remoteDeviceIndex.delete(meta.device_id);
        }
      }

      this.socketMeta.delete(remoteWs);
      closeWs(remoteWs, remoteCloseCode, remoteCloseReason);
    }

    session.remote_conns.clear();
    session.cmd_queue = [];
    this.sessions.delete(sid);
    return session;
  }

  cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sid, session] of this.sessions.entries()) {
      if (session.pc_conn || session.expires_at > now) {
        continue;
      }

      for (const remoteWs of session.remote_conns) {
        const remoteMeta = this.getSocketMeta(remoteWs);
        if (remoteMeta && remoteMeta.role === 'remote' && remoteMeta.device_id) {
          const deviceRef = this.remoteDeviceIndex.get(remoteMeta.device_id);
          if (deviceRef && deviceRef.ws === remoteWs) {
            this.remoteDeviceIndex.delete(remoteMeta.device_id);
          }
        }
        this.socketMeta.delete(remoteWs);
        closeWs(remoteWs, 4001, 'session_expired');
      }
      this.sessions.delete(sid);
    }
  }

  getLiveSnapshot() {
    const sessions = [];
    for (const [sid, session] of this.sessions.entries()) {
      this.pruneStaleRemotes(session);

      if (session.pc_conn && !isWsOpen(session.pc_conn)) {
        session.pc_conn = null;
      }

      const pcMeta = session.pc_conn ? this.getSocketMeta(session.pc_conn) : null;
      const remotes = [];
      for (const remoteWs of session.remote_conns) {
        const meta = this.getSocketMeta(remoteWs);
        if (meta && meta.role === 'remote' && isWsOpen(remoteWs)) {
          remotes.push({
            sid: meta.sid,
            role: meta.role,
            device_id: meta.device_id || null,
            device_name: meta.device_name || null,
            device_location: meta.device_location || null,
            connection_type: meta.connection_type || 'websocket',
            ip: meta.ip || null,
            user_agent: meta.user_agent || null,
            connected_at: meta.connected_at || null
          });
        }
      }

      sessions.push({
        sid,
        created_at: session.created_at,
        expires_at: session.expires_at,
        pc: pcMeta
          ? {
              sid: pcMeta.sid,
              role: pcMeta.role,
              device_name: pcMeta.device_name || 'PC',
              connection_type: pcMeta.connection_type || 'websocket',
              ip: pcMeta.ip || null,
              user_agent: pcMeta.user_agent || null,
              connected_at: pcMeta.connected_at || null
            }
          : null,
        remotes
      });
    }
    return sessions;
  }
}

module.exports = SessionManager;
