"use strict";

const { EventEmitter } = require("node:events");

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

class EventHub extends EventEmitter {
  constructor({ client, replay = 300, bufferSize = 1500, log = () => { } }) {
    super();
    this.setMaxListeners(0);

    this.client = client;
    this.replay = replay;
    this.bufferSize = bufferSize;
    this.log = log;

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
    this.stopped = false;
  }

  start() {
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
    if (this.stopped || this.upstream) return;
    try {
      const { req, res } = await this.client.sse({
        replay: this.upstreamLastId == null ? this.replay : 0,
        lastEventId: this.upstreamLastId,
      });
      this.upstream = { req, res };
      this.connected = true;
      this.retryMs = 1000;
      this.lastUpstreamData = Date.now();
      this.log("info", "Control API event stream connected.");
      this.emit("open");

      let buf = "";
      res.on("data", (chunk) => {
        this.lastUpstreamData = Date.now();
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          this._handleFrame(frame);
        }
      });
      const onClose = () => {
        if (!this.connected) return;
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
      this.connected = false;
      this.upstream = null;
      this.emit("connect-error", err);
      this._scheduleReconnect();
    }
  }

  _dropUpstream() {
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
      const numericId = Number(id ?? payload.id);
      if (Number.isFinite(numericId)) {
        this.upstreamLastId =
          this.upstreamLastId == null
            ? numericId
            : Math.max(this.upstreamLastId, numericId);
      }
      this.emit("entry", payload); // server.js ingests this into SQLite
      this.broadcast("log", payload);
    } else if (event === "status" || event === "hello") {
      this.emit("status", payload);
    }
  }

  broadcast(event, payload) {
    const seq = ++this.seq;
    const frame = `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

    if (event !== "state") {
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
