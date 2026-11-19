"use strict";

const { EventHub } = require("./eventHub");

class MultiEventHub {
  constructor({ replay = 300, bufferSize = 1500, log = () => {} } = {}) {
    this.replay = replay;
    this.log = log;
    this.fanout = new EventHub({ client: null, bufferSize, log });
    this.servers = new Map();
  }

  addServer(serverId, client, { sanitize = (payload) => payload } = {}) {
    if (typeof serverId !== "string" || !serverId)
      throw new Error("A valid server ID is required.");
    if (this.servers.has(serverId))
      throw new Error("The server already has an event stream.");
    const hub = new EventHub({
      client,
      replay: this.replay,
      log: this.log,
      sanitize,
      forward: (event, payload) => {
        this.fanout.broadcast(event, { ...payload, serverId });
      },
    });
    this.servers.set(serverId, hub);
    return hub;
  }

  removeServer(serverId) {
    const hub = this.servers.get(serverId);
    if (!hub) return false;
    this.servers.delete(serverId);
    hub.stop();
    return true;
  }

  broadcast(event, payload) {
    this.fanout.broadcast(event, payload);
  }

  addClient(req, res, snapshot, connections = null) {
    this.fanout.addClient(req, res, snapshot);
    if (connections)
      res.write(`event: connections\ndata: ${JSON.stringify({ connections })}\n\n`);
  }

  stop() {
    for (const id of this.servers.keys()) this.removeServer(id);
    this.fanout.stop();
  }
}

module.exports = { MultiEventHub };
