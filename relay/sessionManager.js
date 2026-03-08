'use strict';

const { closeWs, isWsOpen } = require('./utils');

class SessionManager {
  constructor({ sessionTtlMs }) {
    this.sessionTtlMs = sessionTtlMs;
    this.sessions = new Map();
    this.socketMeta = new WeakMap();
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
      expires_at: expiresAt
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

  registerPc(sid, ws) {
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
    this.socketMeta.set(ws, { sid, role: 'pc' });
    return { ok: true, session };
  }

  registerRemote(sid, pairCode, ws) {
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

    session.remote_conns.add(ws);
    this.socketMeta.set(ws, { sid, role: 'remote' });
    return { ok: true, session };
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
    }

    if (!session.pc_conn && session.remote_conns.size === 0 && session.expires_at <= Date.now()) {
      this.sessions.delete(meta.sid);
    }

    return { ...meta, session };
  }

  cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sid, session] of this.sessions.entries()) {
      if (session.pc_conn || session.expires_at > now) {
        continue;
      }

      for (const remoteWs of session.remote_conns) {
        this.socketMeta.delete(remoteWs);
        closeWs(remoteWs, 4001, 'session_expired');
      }
      this.sessions.delete(sid);
    }
  }
}

module.exports = SessionManager;
