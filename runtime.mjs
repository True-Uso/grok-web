import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const running = new Map();

function dockerName(sessionId) {
  const id = String(sessionId || "").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 48);
  return `sc-${id || "app"}`;
}

export function isAppProject(cwd) {
  return Boolean(cwd) && existsSync(path.join(cwd, "Dockerfile"));
}

export function runtimeOf(sessionId) {
  return running.get(String(sessionId || "")) || null;
}

function friendlyDocker(err) {
  const msg = String(err?.message || err || "");
  if (/ENOENT|not recognized|not found/i.test(msg)) return "本机还没有 Docker。请先安装并打开 Docker Desktop。";
  if (/dockerDesktopLinuxEngine|cannot find the file|daemon|pipe/i.test(msg)) {
    return "Docker 还没开起来。请打开 Docker Desktop，等它就绪后再试。";
  }
  return msg.slice(0, 400);
}

function runDocker(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("Docker 操作超时。"));
    }, timeoutMs);
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(friendlyDocker(err)));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(friendlyDocker(stderr || stdout || `docker ${args[0]} 失败`)));
    });
  });
}

export async function dockerReady() {
  try {
    await runDocker(["info"], { timeoutMs: 8000 });
    return true;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function waitHttp(port, timeoutMs = 25000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error("应用启动超时。请确认 Docker 已打开，并且程序监听 8080 端口。"));
        return;
      }
      setTimeout(tick, 400);
    };
    tick();
  });
}

async function isUp(port) {
  try {
    await waitHttp(port, 1200);
    return true;
  } catch {
    return false;
  }
}

async function inspectHostPort(name) {
  try {
    const { stdout } = await runDocker(
      ["inspect", "-f", "{{(index (index .NetworkSettings.Ports \"8080/tcp\") 0).HostPort}}", name],
      { timeoutMs: 8000 },
    );
    return Number(String(stdout).trim()) || 0;
  } catch {
    return 0;
  }
}

const cookieJars = new Map();

export async function stopApp(sessionId) {
  const id = String(sessionId || "");
  const name = dockerName(id);
  running.delete(id);
  cookieJars.delete(id);
  try {
    await runDocker(["rm", "-f", name], { timeoutMs: 20000 });
  } catch {
    /* already gone */
  }
}

export async function ensureApp(sessionId, cwd, dataDir, { rebuild = false } = {}) {
  const id = String(sessionId || "");
  if (!isAppProject(cwd)) return null;
  const name = dockerName(id);
  const current = running.get(id);
  if (current && !rebuild && (await isUp(current.port))) return current;
  if (!rebuild) {
    const existingPort = await inspectHostPort(name);
    if (existingPort && (await isUp(existingPort))) {
      const rec = { sessionId: id, name, port: existingPort, dataDir };
      running.set(id, rec);
      return rec;
    }
  }
  if (!(await dockerReady())) {
    throw new Error("Docker 还没开起来。请打开 Docker Desktop，等鲸标稳定后再试。");
  }
  await mkdir(dataDir, { recursive: true });
  const image = `${name}:local`;
  await runDocker(["rm", "-f", name], { timeoutMs: 20000 }).catch(() => {});
  await new Promise((resolve, reject) => {
    const proc = spawn("docker", ["build", "-t", image, "."], { cwd, windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("构建应用超时。"));
    }, 240000);
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(friendlyDocker(err)));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(friendlyDocker(stderr || "构建应用失败")));
    });
  });
  const port = await freePort();
  await runDocker(
    [
      "run",
      "-d",
      "--name",
      name,
      "--memory",
      "512m",
      "--cpus",
      "1",
      "-p",
      `127.0.0.1:${port}:8080`,
      "-v",
      `${dataDir}:/data`,
      "-e",
      "PORT=8080",
      "-e",
      "DATABASE_PATH=/data/app.db",
      image,
    ],
    { timeoutMs: 30000 },
  );
  await waitHttp(port);
  const rec = { sessionId: id, name, image, port, dataDir };
  running.set(id, rec);
  return rec;
}

function previewPrefix(sessionId) {
  return `/preview-app/${encodeURIComponent(sessionId)}`;
}

function rememberCookies(sessionId, headers) {
  const raw = headers["set-cookie"];
  if (!raw) return;
  const list = Array.isArray(raw) ? raw : [raw];
  const jar = cookieJars.get(sessionId) || new Map();
  for (const line of list) {
    const pair = String(line).split(";")[0];
    const cut = pair.indexOf("=");
    if (cut < 1) continue;
    const name = pair.slice(0, cut).trim();
    const value = pair.slice(cut + 1);
    if (!name) continue;
    if (/Max-Age=0/i.test(line) || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
  cookieJars.set(sessionId, jar);
}

function cookieHeader(sessionId) {
  const jar = cookieJars.get(sessionId);
  if (!jar?.size) return "";
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

export const HIDE_SCROLL_STYLE =
  `<style id="sc-hide-scroll">html,body,*{scrollbar-width:none!important;scrollbar-color:transparent transparent!important}*::-webkit-scrollbar,*::-webkit-scrollbar-button,*::-webkit-scrollbar-thumb,*::-webkit-scrollbar-track,*::-webkit-scrollbar-track-piece,*::-webkit-scrollbar-corner{display:none!important;width:0!important;height:0!important;background:transparent!important;border:none!important}</style>`;

export function injectHtmlChrome(html, extra = "") {
  const inject = HIDE_SCROLL_STYLE + extra;
  const src = String(html || "");
  return /<head[\s>]/i.test(src) ? src.replace(/<head[^>]*>/i, (m) => m + inject) : inject + src;
}

function fetchHook(prefix) {
  return `<script>(function(){var p=${JSON.stringify(prefix)};function w(u){if(typeof u!=="string")return u;if(!u||u.startsWith(p)||/^[a-z]+:/i.test(u)||u.startsWith("//")||u.startsWith("#")||u.startsWith("?"))return u;if(u.startsWith("/"))return p+u;return u;}var f=window.fetch;window.fetch=function(u,i){if(typeof Request!=="undefined"&&u instanceof Request)u=new Request(w(u.url),u);else u=w(u);return f.call(this,u,i);};var o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=w(u);return o.apply(this,arguments);};})();</script>`;
}

function rewriteLocation(sessionId, location, port) {
  try {
    const loc = new URL(String(location), `http://127.0.0.1:${port}`);
    if (loc.hostname !== "127.0.0.1" && loc.hostname !== "localhost") return location;
    return previewPrefix(sessionId) + loc.pathname + loc.search + loc.hash;
  } catch {
    return location;
  }
}

export function proxyApp(req, res, rec, sessionId, restPath, search) {
  const id = String(sessionId || "");
  const prefix = previewPrefix(id);
  const dest = `${restPath.startsWith("/") ? restPath : `/${restPath}`}${search || ""}`;
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === "host" || key === "connection" || key === "accept-encoding") continue;
    headers[key] = value;
  }
  headers.host = `127.0.0.1:${rec.port}`;
  const extra = cookieHeader(id);
  if (extra) headers.cookie = headers.cookie ? `${headers.cookie}; ${extra}` : extra;

  const upstream = http.request(
    { hostname: "127.0.0.1", port: rec.port, path: dest || "/", method: req.method, headers },
    (pres) => {
      rememberCookies(id, pres.headers);
      const out = {};
      for (const [key, value] of Object.entries(pres.headers)) {
        if (["x-frame-options", "content-security-policy", "content-encoding", "set-cookie", "transfer-encoding"].includes(key)) continue;
        out[key] = value;
      }
      if (pres.headers.location) out.location = rewriteLocation(id, pres.headers.location, rec.port);
      const type = String(pres.headers["content-type"] || "");
      if (type.includes("text/html")) {
        const chunks = [];
        pres.on("data", (chunk) => chunks.push(chunk));
        pres.on("end", () => {
          let html = Buffer.concat(chunks).toString("utf8");
          html = html.replace(/(href|src|action)=(["'])\/(?!\/)/gi, `$1=$2${prefix}/`);
          html = injectHtmlChrome(html, fetchHook(prefix));
          out["content-length"] = Buffer.byteLength(html);
          res.writeHead(pres.statusCode || 200, out);
          res.end(html);
        });
        return;
      }
      res.writeHead(pres.statusCode || 200, out);
      pres.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end("应用预览失败");
  });
  req.pipe(upstream);
}
