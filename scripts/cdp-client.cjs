// 稳定的 CDP 客户端：基于 http.get 拿目标列表 + 手写最小 WebSocket（带掩码、
// 分帧、握手边界处理），并把握手残留字节正确并入帧缓冲。
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const fs = require("node:fs");

const CDP = "http://127.0.0.1:9222";

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(b));
        } catch (e) {
          reject(new Error(`非 JSON 响应 (${url}): ${b.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("连接 CDP 超时")));
  });
}

class WS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = Number(u.port || 80);
    this.path = u.pathname + (u.search || "");
    this.buf = Buffer.alloc(0);
    this.handshakeDone = false;
    this.onMsg = () => {};
    this.onClose = () => {};
  }
  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      this.sock = net.connect(this.port, this.host, () => {
        this.sock.setNoDelay(true);
        this.sock.write(
          `GET ${this.path} HTTP/1.1\r\n` +
            `Host: ${this.host}:${this.port}\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\n` +
            `Sec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      let handshake = Buffer.alloc(0);
      const onData = (d) => {
        if (!this.handshakeDone) {
          handshake = Buffer.concat([handshake, d]);
          const s = handshake.toString("latin1");
          const idx = s.indexOf("\r\n\r\n");
          if (idx === -1) return;
          if (!/101/.test(s.slice(0, 20))) {
            return reject(new Error("WebSocket 握手失败: " + s.slice(0, 200)));
          }
          const consumed = Buffer.byteLength(s.slice(0, idx + 4), "latin1");
          const rest = handshake.slice(consumed);
          handshake = Buffer.alloc(0);
          this.handshakeDone = true;
          if (rest.length) {
            this.buf = Buffer.concat([this.buf, rest]);
            this.drain();
          }
          resolve();
          return;
        }
        this.buf = Buffer.concat([this.buf, d]);
        this.drain();
      };
      this.sock.on("data", onData);
      this.sock.on("error", reject);
      this.sock.on("close", () => this.onClose());
    });
  }
  drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const opcode = b0 & 0x0f;
      const b1 = this.buf[1];
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (masked) off += 4; // 服务端不掩码，防御性处理
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      if (opcode === 1) {
        // 文本帧
        let text;
        try {
          text = payload.toString("utf8");
        } catch {
          continue;
        }
        this.onMsg(text);
      } else if (opcode === 8) {
        this.close();
        return;
      }
      // ping/pong/continuation 忽略
    }
  }
  send(obj) {
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  close() {
    try {
      this.sock.end();
    } catch {
      /* ignore */
    }
  }
}

class CDPClient {
  constructor(pageUrlPart) {
    this.pageUrlPart = pageUrlPart;
  }
  async attach() {
    const targets = await getJson(`${CDP}/json/list`);
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new Error(`CDP 无可用目标（app 是否已启动并带 --remote-debugging-port=9222？）`);
    }
    const page = targets.find((t) => t.type === "page" && (!this.pageUrlPart || t.url.includes(this.pageUrlPart)));
    if (!page) throw new Error("找不到 page 目标，现有: " + JSON.stringify(targets.map((t) => ({ type: t.type, url: t.url }))));
    this.ws = new WS(page.webSocketDebuggerUrl);
    await this.ws.connect();
    this.id = 0;
    this.pending = new Map();
    this.ws.onMsg((raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message + " " + JSON.stringify(m.error.data ?? "")));
        else resolve(m.result);
      }
    });
    await this.call("Runtime.enable");
    await this.call("Page.enable");
    return this;
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send({ id, method, params });
    });
  }
  async eval(expression, { awaitPromise = true, timeoutMs = 20000 } = {}) {
    const r = await Promise.race([
      this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("eval 超时: " + expression.slice(0, 60))), timeoutMs)),
    ]);
    if (r.exceptionDetails) {
      throw new Error(
        "页面执行异常: " +
          (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text) +
          " | " +
          expression.slice(0, 120),
      );
    }
    return r.result.value;
  }
  detach() {
    this.ws?.close();
  }
}

module.exports = { CDPClient, getJson, WS };

if (require.main === module) {
  (async () => {
    const c = await new CDPClient("index.html").attach();
    console.log("已连接页面:", await c.eval("location.href", { awaitPromise: false }));
    c.detach();
  })().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
