"use strict";

const { EventEmitter } = require("node:events");

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

class EventHub extends EventEmitter {
  constructor({ client, replay = 300, bufferSize = 1500, log = () => { }, forward = null, sanitize = (value) => value }) {
    super();
    this.setMaxListeners(0);

    this.client = client;
    this.replay = replay;
    this.bufferSize = bufferSize;
    this.log = log;
    this.forward = forward;
    this.sanitize = sanitize;

    this.clients = new Set();
    this.buffer = []; // [{ seq, event, data }]
    this.seq = 0;

    this.connected = false;
    this.upstream = null; // { req, res }
    this.upstreamLastId = null; // last log id we saw from the API
    this.retryMs = 1000;
    this.retryTimer = null;
    this.watchdog = null;
    this.lastUpstreamData = 0;
    this.stopped = true;
    this.connecting = false;
    this.connectAbort = null;
    this.generation = 0;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._connect();
    this.watchdog = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastUpstreamData > 45000) {
        this.log(
          "warn",
          "No data from the Control API event stream for 45s — reconnecting.",
        );
        this._dropUpstream();
        this._scheduleReconnect();
      }
    }, 15000);
    if (this.watchdog.unref) this.watchdog.unref();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.watchdog);
    this._dropUpstream();
    for (const res of this.clients) {
      if (!res.writableEnded) res.end();
    }
    this.clients.clear();
  }

  markUpstreamRestarted() {
    this.upstreamLastId = null;
    this.broadcast("reset", { at: new Date().toISOString() });
    this._dropUpstream();
    this._scheduleReconnect(250);
  }

  // ---- upstream ---------------------------------------------------------

  async _connect() {
    if (this.stopped || this.upstream || this.connecting) return;
    const generation = ++this.generation;
    this.connecting = true;
    const controller = new AbortController();
    this.connectAbort = controller;
    try {
      const { req, res } = await this.client.sse({
        replay: this.upstreamLastId == null ? this.replay : 0,
        lastEventId: this.upstreamLastId,
        signal: controller.signal,
      });
      if (this.stopped || generation !== this.generation) {
        req.destroy();
        return;
      }
      this.upstream = { req, res };
      this.connected = true;
      this.retryMs = 1000;
      this.lastUpstreamData = Date.now();
      this.log("info", "Control API event stream connected.");
      this.emit("open");

      let buf = "";
      res.on("data", (chunk) => {
        if (generation !== this.generation) return;
        this.lastUpstreamData = Date.now();
        buf += chunk;
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buf))) {
          const frame = buf.slice(0, boundary.index);
          buf = buf.slice(boundary.index + boundary[0].length);
          this._handleFrame(frame);
        }
      });
      const onClose = () => {
        if (generation !== this.generation || !this.connected) return;
        this.connected = false;
        this.upstream = null;
        this.emit("close");
        if (!this.stopped) {
          this.log("warn", "Control API event stream closed — reconnecting.");
          this._scheduleReconnect();
        }
      };
      res.on("end", onClose);
      res.on("close", onClose);
      res.on("error", onClose);
    } catch (err) {
      if (this.stopped || generation !== this.generation) return;
      this.connected = false;
      this.upstream = null;
      this.emit("connect-error", err);
      this._scheduleReconnect();
    } finally {
      if (generation === this.generation) {
        this.connecting = false;
        this.connectAbort = null;
      }
    }
  }

  _dropUpstream() {
    this.generation++;
    this.connecting = false;
    if (this.connectAbort) this.connectAbort.abort();
    this.connectAbort = null;
    this.connected = false;
    if (this.upstream) {
      try {
        this.upstream.req.destroy();
      } catch {
        /* already gone */
      }
      this.upstream = null;
    }
  }

  _scheduleReconnect(delayMs = null) {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    const delay = delayMs ?? this.retryMs;
    this.retryTimer = setTimeout(() => this._connect(), delay);
    if (this.retryTimer.unref) this.retryTimer.unref();
    if (delayMs == null) this.retryMs = Math.min(this.retryMs * 2, 15000);
  }

  _handleFrame(frame) {
    let event = "message";
    let data = "";
    let id = null;

    for (const rawLine of frame.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "id") id = value;
      else if (field === "data") data += (data ? "\n" : "") + value;
    }
    if (!data) return;

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }

    if (event === "log") {
      const rawId = id ?? payload.id;
      const numericId = rawId == null ? NaN : Number(rawId);
      if (Number.isFinite(numericId)) {
        if (this.upstreamLastId != null && numericId <= this.upstreamLastId) return;
      }
      try {
        payload = this.sanitize(payload);
      } catch {
        this.log("warn", "Could not sanitize an upstream event.");
        return;
      }
      if (Number.isFinite(numericId)) this.upstreamLastId = numericId;
      this.emit("entry", payload); // server.js ingests this into SQLite
      this.broadcast("log", payload);
    } else if (event === "status" || event === "hello") {
      try {
        payload = this.sanitize(payload);
      } catch {
        this.log("warn", "Could not sanitize an upstream event.");
        return;
      }
      this.emit("status", payload);
    }
  }

  broadcast(event, payload) {
    const seq = ++this.seq;
    const frame = `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

    if (event !== "state" && event !== "connections") {
      this.buffer.push({ seq, frame });
      if (this.buffer.length > this.bufferSize) this.buffer.shift();
    }

    for (const res of this.clients) {
      if (res.writableEnded) {
        this.clients.delete(res);
        continue;
      }
      res.write(frame);
    }
    if (this.forward) this.forward(event, payload);
  }

  addClient(req, res, snapshot) {
    res.writeHead(200, SSE_HEADERS);
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    if (res.socket) {
      res.socket.setNoDelay(true);
      res.socket.setTimeout(0);
    }
    res.write("retry: 3000\n\n");

    const headerId = Number(req.headers["last-event-id"]);
    const resumeFrom =
      Number.isFinite(headerId) && headerId > 0 && headerId <= this.seq
        ? headerId
        : null;

    res.write(`event: state\ndata: ${JSON.stringify(snapshot)}\n\n`);

    for (const item of this.buffer) {
      if (resumeFrom != null && item.seq <= resumeFrom) continue;
      res.write(item.frame);
    }

    this.clients.add(res);

    const ping = setInterval(() => {
      if (res.writableEnded) return;
      res.write(": ping\n\n");
    }, 20000);
    if (ping.unref) ping.unref();

    const cleanup = () => {
      clearInterval(ping);
      this.clients.delete(res);
      if (!res.writableEnded) res.end();
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
  }

  get stats() {
    return {
      connected: this.connected,
      clients: this.clients.size,
      buffered: this.buffer.length,
      upstreamLastId: this.upstreamLastId,
    };
  }
}

module.exports = { EventHub };
