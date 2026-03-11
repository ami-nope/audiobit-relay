'use strict';

class ActivityLog {
  constructor({ maxPerSession = 200, maxTotal = 2000 } = {}) {
    this.maxPerSession = maxPerSession;
    this.maxTotal = maxTotal;
    this.events = [];
    this.bySid = new Map();
  }

  record(event) {
    if (!event || typeof event !== 'object') {
      return null;
    }

    const sid = typeof event.sid === 'string' ? event.sid : null;
    const entry = {
      id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: Number.isFinite(event.ts) ? event.ts : Date.now(),
      sid,
      type: typeof event.type === 'string' ? event.type : 'event',
      role: typeof event.role === 'string' ? event.role : null,
      device_id: typeof event.device_id === 'string' ? event.device_id : null,
      device_name: typeof event.device_name === 'string' ? event.device_name : null,
      message: typeof event.message === 'string' ? event.message : null,
      detail: event.detail && typeof event.detail === 'object' ? event.detail : null
    };

    this.events.push(entry);
    if (this.events.length > this.maxTotal) {
      this.events.splice(0, this.events.length - this.maxTotal);
    }

    if (sid) {
      const list = this.bySid.get(sid) || [];
      list.push(entry);
      if (list.length > this.maxPerSession) {
        list.splice(0, list.length - this.maxPerSession);
      }
      this.bySid.set(sid, list);
    }

    return entry;
  }

  getBySid(sid, { limit = 200 } = {}) {
    if (typeof sid !== 'string' || !sid.trim()) {
      return [];
    }
    const list = this.bySid.get(sid) || [];
    if (limit <= 0) {
      return [];
    }
    return list.slice(-limit);
  }
}

module.exports = ActivityLog;
