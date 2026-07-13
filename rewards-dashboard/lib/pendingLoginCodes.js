"use strict";

const TTL_MS = 60 * 1000;

class PendingLoginCodes {
  constructor() {
    this.entries = new Map(); // userName -> { userName, number, issuedAt }
  }

  add(userName, number, issuedAtIso) {
    this.entries.set(userName, { userName, number, issuedAt: issuedAtIso });
  }

  resolve(userName) {
    this.entries.delete(userName);
  }

  list() {
    const now = Date.now();
    const active = [];
    for (const [userName, entry] of this.entries) {
      const issuedMs = Date.parse(entry.issuedAt);
      const expiresAt = issuedMs + TTL_MS;
      if (Number.isNaN(issuedMs) || expiresAt <= now) {
        this.entries.delete(userName);
        continue;
      }
      active.push({
        userName: entry.userName,
        number: entry.number,
        issuedAt: entry.issuedAt,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    }
    return active;
  }
}

module.exports = { PendingLoginCodes, TTL_MS };
