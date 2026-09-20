import { createServer } from "node:http";
import { readFile, writeFile, readdir, stat, mkdir, cp, rm } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { openStore } from "./store.mjs";
import { zipDirectory, safeZipName } from "./zip.mjs";
import { dockerReady, ensureApp, injectHtmlChrome, isAppProject, proxyApp, runtimeOf, stopApp } from "./runtime.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const TOKEN_FILE = path.join(ROOT, ".token");
const ENV_FILE = path.join(ROOT, ".env");
const HOST = process.env.GROK_WEB_HOST || "127.0.0.1";
const PORT = Number(process.env.GROK_WEB_PORT || 8787);
const DEFAULT_CWD = path.resolve(process.env.GROK_WEB_CWD || path.join(ROOT, "workspace"));
const WORKSPACES = path.resolve(path.join(ROOT, "workspaces"));
const INDEX_FILE = path.join(ROOT, "sessions.json");
const SAVES = path.resolve(process.env.GROK_WEB_SAVES || path.join(ROOT, "saves"));
const DATA = path.resolve(path.join(ROOT, "data"));
const USERS_DIR = path.join(DATA, "users");
const PUBLISHED = path.join(DATA, "published");
const AUTH_COOKIE = "sc";
const store = openStore(path.join(DATA, "app.sqlite"));
{
  const name = process.env.SC_BOOTSTRAP_USER || "admin";
  const pass = process.env.SC_BOOTSTRAP_PASS || "coding123";
  try {
    const user = store.ensureUser(name, pass);
    console.log("preset account", user.username);
  } catch (err) {
    console.error("preset account failed:", err.message);
  }
}
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  ".next",
  "__pycache__",
]);
const HIDDEN_FILES = new Set(["AGENTS.md"]);
const ALLOWED_MODELS = ["deepseek-flash", "deepseek-v4-pro"];
const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_DEEPSEEK_BASE = "https://api.deepseek.com/v1";
const AGENT_HOME = path.resolve(process.env.GROK_WEB_AGENT_HOME || path.join(DATA, "agent-home"));
const GROK_ALIAS_MODELS = ["grok-4.6", "grok-4.5", "grok-4", "grok-3", "grok-2"];
const AGENTS_MD = `# 语言与回复规则

本产品只面向中国大陆、完全没有编程基础的用户。

对用户可见的回复必须是好懂的简体中文。

硬性要求：
- 禁止把思考过程、计划草稿、逐步推理写进给用户看的回复。
- 禁止英文段落、日文、中英日夹杂。不要出现 I'll、Let me、Now I'll、The file is、コードは。
- 文件名、代码、命令可以保留英文，但前后说明必须是中文。
- 做完后用三四句中文说清楚：做成了什么、现在可以怎么用、关键按钮或默认账号在哪里。可以分点，但不要写成工作汇报。
- 不要只丢一句「已经处理好了」就结束。
- 不要向用户说 write、read_file 这些内部操作有没有成功，也不要汇报你读了哪些文件、准备怎么改。
- 工具调用的细节留给系统。

## 做什么用哪种形态

小游戏、展示页、不需要存数据的小工具：
- 只写一个能打开的 html，写完立刻停。
- 不要写测试、verify、Playwright 或额外脚本。

学生管理、进销存、登记、登录、后台、要存数据或多人用的系统：
- 必须做成能在容器里跑的真实应用，不要只写一个 html。
- 用 Node.js（当前只支持这一种）。
- 程序监听 0.0.0.0:8080（或环境变量 PORT）。
- 数据库用 SQLite，文件路径必须是环境变量 DATABASE_PATH，默认 /data/app.db。
- 页面和接口都从这个端口提供。fetch 和表单用站点根路径，例如 /api/students，不要写 localhost。
- 不要设置 X-Frame-Options，不要用 CSP frame-ancestors 禁止嵌入，不要检测 iframe 后跳走或清空页面。
- 必须提供 Dockerfile：基于 node:22-alpine，暴露 8080，启动命令跑你的服务。
- 写 .dockerignore，忽略 node_modules。
- 写完能启动即可，不要为了打磨反复改十几轮。
`;

function pickAllowOption(options, mode) {
  const list = Array.isArray(options) ? options : [];
  const blob = (opt) =>
    `${opt.optionId || ""} ${opt.id || ""} ${opt.kind || ""} ${opt.name || ""}`.toLowerCase();
  const preferAlways = mode === "yolo";
  let best = null;
  let bestScore = 0;
  for (const opt of list) {
    const t = blob(opt);
    const deny = /reject|deny|cancel|refuse|拒绝/.test(t);
    const allow = /allow|approve|accept|yes|同意|允许|放行/.test(t);
    if (deny && !allow) continue;
    let score = 0;
    if (allow) score = 2;
    if (preferAlways && /always|allow_always|allow-always/.test(t)) score = 4;
    if (!preferAlways && /once|allow_once|allow-once/.test(t) && allow) score = 4;
    if (score > bestScore) {
      best = opt;
      bestScore = score;
    }
  }
  return best?.optionId || best?.id || (preferAlways ? "allow-always" : "allow-once");
}

async function ensureAgentsMd(dir) {
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "AGENTS.md"), AGENTS_MD, "utf8");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function loadToken() {
  if (process.env.GROK_WEB_TOKEN) return process.env.GROK_WEB_TOKEN;
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  return randomBytes(9).toString("base64url");
}

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(ENV_FILE);
if (process.env.DEEPSEEK_API_KEY && !process.env.XAI_API_KEY) {
  process.env.XAI_API_KEY = process.env.DEEPSEEK_API_KEY;
}

function deepseekBase() {
  return String(process.env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE).replace(/\/+$/, "");
}

function parseEnvFile(file) {
  const map = new Map();
  if (!existsSync(file)) return map;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    map.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return map;
}

async function writeEnvFile(updates) {
  const map = parseEnvFile(ENV_FILE);
  for (const [key, value] of Object.entries(updates)) {
    if (value == null || value === "") continue;
    map.set(key, String(value).replace(/\r?\n/g, ""));
  }
  const body = [...map.entries()].map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  await writeFile(ENV_FILE, body, "utf8");
}

function normalizeBaseUrl(value) {
  let url = String(value || "").trim();
  if (!url) url = DEFAULT_DEEPSEEK_BASE;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("bad");
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "") || parsed.origin;
  } catch {
    throw new Error("Base URL 格式不对，请填 https://api.deepseek.com/v1 这样的地址。");
  }
}

function publicProvider() {
  const key = process.env.DEEPSEEK_API_KEY || process.env.XAI_API_KEY || "";
  const hint = key.length > 8 ? `${key.slice(0, 3)}···${key.slice(-4)}` : "";
  return {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: deepseekBase(),
    keyConfigured: Boolean(key),
    keyHint: hint,
    format: "Chat Completions (/chat/completions)",
    models: [
      { id: "deepseek-flash", name: "DeepSeek Flash", hint: "默认，响应更快" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", hint: "更强一些" },
    ],
  };
}

const TOKEN = loadToken();
if (!existsSync(TOKEN_FILE) && !process.env.GROK_WEB_TOKEN) {
  await writeFile(TOKEN_FILE, TOKEN, "utf8");
}

function tomlStringList(values) {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function modelToml(id, apiModel, name) {
  return `[model.${id}]
model = ${JSON.stringify(apiModel)}
base_url = ${JSON.stringify(deepseekBase())}
name = ${JSON.stringify(name)}
api_backend = "chat_completions"
env_key = "DEEPSEEK_API_KEY"
context_window = 64000
max_completion_tokens = 8192
supports_reasoning_effort = false
reasoning_efforts = []
`;
}

function agentConfigToml() {
  const aliases = GROK_ALIAS_MODELS.map((id) => modelToml(id, DEFAULT_MODEL, "DeepSeek Flash")).join("\n");
  return `[cli]
auto_update = false

[endpoints]
models_base_url = ${JSON.stringify(deepseekBase())}

[models]
default = ${JSON.stringify(DEFAULT_MODEL)}
allowed_models = ${tomlStringList(ALLOWED_MODELS)}
hidden_models = ${tomlStringList(GROK_ALIAS_MODELS)}
web_search = ${JSON.stringify(DEFAULT_MODEL)}
session_summary = ${JSON.stringify(DEFAULT_MODEL)}
image_description = ${JSON.stringify(DEFAULT_MODEL)}
prompt_suggestion = ${JSON.stringify(DEFAULT_MODEL)}

[compat.claude]
skills = false
agents = false
hooks = false
mcps = false
rules = false

[compat.cursor]
skills = false
agents = false
hooks = false
mcps = false
rules = false

[compat.codex]
skills = false

[skills]
ignore = ${tomlStringList(skillIgnorePaths())}

[workflows]
enabled = false

[ui]
fork_secondary_model = ${JSON.stringify(DEFAULT_MODEL)}
yolo = true

${modelToml("deepseek-flash", "deepseek-flash", "DeepSeek Flash")}
${modelToml("deepseek-v4-pro", "deepseek-v4-pro", "DeepSeek V4 Pro")}
${aliases}
`;
}

function skillIgnorePaths() {
  const home = os.homedir();
  return [
    path.join(home, ".agents"),
    path.join(home, ".claude"),
    path.join(home, ".cursor"),
    path.join(home, ".codex"),
    path.join(AGENT_HOME, "bundled", "skills"),
  ];
}

function grokAgentEnv() {
  const key = process.env.DEEPSEEK_API_KEY || process.env.XAI_API_KEY || "";
  const parsed = path.parse(AGENT_HOME);
  return {
    ...process.env,
    GROK_HOME: AGENT_HOME,
    HOME: AGENT_HOME,
    USERPROFILE: AGENT_HOME,
    HOMEDRIVE: parsed.root.replace(/[\\/]+$/, "") || process.env.HOMEDRIVE,
    HOMEPATH: `\\${AGENT_HOME.slice(parsed.root.length).replace(/\//g, "\\")}`,
    GROK_DEFAULT_MODEL: DEFAULT_MODEL,
    GROK_MODELS_BASE_URL: deepseekBase(),
    GROK_WEB_SEARCH_MODEL: DEFAULT_MODEL,
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_CURSOR_SKILLS_ENABLED: "false",
    GROK_CLAUDE_SKILLS_ENABLED: "false",
    GROK_CURSOR_AGENTS_ENABLED: "false",
    GROK_CLAUDE_AGENTS_ENABLED: "false",
    GROK_CURSOR_HOOKS_ENABLED: "false",
    GROK_CLAUDE_HOOKS_ENABLED: "false",
    GROK_CURSOR_MCPS_ENABLED: "false",
    GROK_CLAUDE_MCPS_ENABLED: "false",
    GROK_CURSOR_RULES_ENABLED: "false",
    GROK_CLAUDE_RULES_ENABLED: "false",
    GROK_WORKFLOWS: "0",
    GROK_CONFIG: JSON.stringify({
      models: {
        default: DEFAULT_MODEL,
        allowed_models: ALLOWED_MODELS,
        hidden_models: GROK_ALIAS_MODELS,
        web_search: DEFAULT_MODEL,
        session_summary: DEFAULT_MODEL,
      },
    }),
    DEEPSEEK_API_KEY: key,
    XAI_API_KEY: process.env.XAI_API_KEY || key,
  };
}

function unwrapConfigValue(value) {
  if (value && typeof value === "object" && "value" in value) return value.value;
  return value;
}

function sanitizeConfigOptions(options) {
  if (!Array.isArray(options)) return options;
  return options.map((opt) => {
    const id = opt?.configId || opt?.id;
    if (id !== "model") return opt;
    const current = String(unwrapConfigValue(opt.currentValue || opt.value) || "");
    const next = ALLOWED_MODELS.includes(current) ? current : DEFAULT_MODEL;
    const choices = ALLOWED_MODELS.map((model) => ({ id: model, name: model }));
    return {
      ...opt,
      options: choices,
      allowedValues: choices,
      currentValue: { value: next },
      value: { value: next },
    };
  });
}

function publicSession(session) {
  if (!session || typeof session !== "object") return session;
  return {
    ...session,
    configOptions: sanitizeConfigOptions(session.configOptions),
  };
}

async function migrateOwnedGrokSessions() {
  const oldRoot = path.join(os.homedir(), ".grok", "sessions");
  const newRoot = path.join(AGENT_HOME, "sessions");
  if (path.resolve(oldRoot) === path.resolve(newRoot) || !existsSync(oldRoot)) return;
  const wanted = new Set(store.listAllSessionIds());
  if (!wanted.size) return;
  let groups;
  try {
    groups = await readdir(oldRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const groupDir = path.join(oldRoot, group.name);
    let kids;
    try {
      kids = await readdir(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const kid of kids) {
      if (!kid.isDirectory() || !wanted.has(kid.name)) continue;
      const destGroup = path.join(newRoot, group.name);
      const dest = path.join(destGroup, kid.name);
      if (existsSync(dest)) continue;
      await mkdir(destGroup, { recursive: true });
      await cp(path.join(groupDir, kid.name), dest, { recursive: true });
      const cwdFile = path.join(groupDir, ".cwd");
      const destCwd = path.join(destGroup, ".cwd");
      if (existsSync(cwdFile) && !existsSync(destCwd)) await cp(cwdFile, destCwd);
    }
  }
}

async function ensureAgentHome() {
  await mkdir(AGENT_HOME, { recursive: true });
  await mkdir(path.join(AGENT_HOME, "skills"), { recursive: true });
  await mkdir(path.join(AGENT_HOME, ".agents", "skills"), { recursive: true });
  await writeFile(path.join(AGENT_HOME, "config.toml"), agentConfigToml(), "utf8");
  await migrateOwnedGrokSessions();
}

await mkdir(DEFAULT_CWD, { recursive: true });
await mkdir(WORKSPACES, { recursive: true });
await mkdir(SAVES, { recursive: true });
await mkdir(USERS_DIR, { recursive: true });
await mkdir(PUBLISHED, { recursive: true });
await ensureAgentHome();
await ensureAgentsMd(DEFAULT_CWD);
try {
  const dirs = await readdir(WORKSPACES, { withFileTypes: true });
  for (const item of dirs) {
    if (item.isDirectory() && item.name.startsWith("s-")) {
      await ensureAgentsMd(path.join(WORKSPACES, item.name));
    }
  }
} catch {
  /* ignore */
}
const workspaceReadme = path.join(DEFAULT_CWD, "README.md");
if (!existsSync(workspaceReadme)) {
  await writeFile(
    workspaceReadme,
    `# Grok Web workspace

This folder is the in-server project the agent edits. The web UI does not attach to folders on your computer.

Ask Grok to create files here; they will show up in the Files / Preview panes.
`,
    "utf8",
  );
}

class Acp {
  constructor() {
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.sessions = new Map();
    this.listeners = new Set();
    this.permWaiters = new Map();
    this.permModes = new Map();
    this.respawning = false;
    this.caps = {};
    this.cancelled = new Set();
    this.lastCwd = DEFAULT_CWD;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(msg) {
    for (const fn of this.listeners) fn(msg);
  }

  start() {
    const grok = process.env.GROK_BIN || "grok";
    this.proc = spawn(grok, ["agent", "--model", DEFAULT_MODEL, "stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: grokAgentEnv(),
    });
    console.log("agent home", AGENT_HOME, "model", DEFAULT_MODEL, "endpoint", deepseekBase());
    this.proc.on("exit", (code, signal) => {
      this.ready = false;
      const err = `grok agent exited (${signal || code})`;
      for (const [, p] of this.pending) p.reject(new Error(err));
      this.pending.clear();
      if (!this.respawning) this.emit({ type: "error", message: err });
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      const line = String(chunk).trim();
      if (line) console.error("[grok]", line.slice(0, 500));
      if (/supported API model names|you passed grok/i.test(line)) {
        this.failPrompts("当前接口只支持 deepseek-flash。已经帮你改好了，请再发一次。");
      }
    });
    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.onLine(line));
  }

  onLine(line) {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      console.error("[acp] bad line", text.slice(0, 200));
      return;
    }
    if (msg.method && msg.id !== undefined && !Object.hasOwn(msg, "result") && !Object.hasOwn(msg, "error")) {
      this.onRequest(msg);
      return;
    }
    if (msg.method && msg.id === undefined) {
      this.onNote(msg);
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else pending.resolve(msg.result);
  }

  onNote(msg) {
    if (msg.method === "session/update") {
      const sessionId = msg.params?.sessionId;
      if (sessionId && this.cancelled.has(sessionId)) return;
      this.emit({ type: "update", sessionId, update: msg.params?.update });
      const loc = firstLocation(msg.params?.update);
      if (loc) {
        const rel = toSessionRel(this.sessions.get(sessionId)?.cwd, loc);
        if (rel) this.emit({ type: "hint_file", sessionId, path: rel });
      }
    }
  }

  permModeOf(sessionId) {
    return this.permModes.get(sessionId) || "yolo";
  }

  setPermMode(sessionId, mode) {
    if (!sessionId) return;
    if (["confirm", "auto", "yolo"].includes(mode)) this.permModes.set(sessionId, mode);
  }

  async onRequest(msg) {
    if (msg.method === "session/request_permission") {
      const sessionId = msg.params?.sessionId;
      const mode = this.permModeOf(sessionId);
      if (mode === "yolo" || mode === "auto") {
        const optionId = pickAllowOption(msg.params?.options, mode);
        this.reply(msg.id, { outcome: { outcome: "selected", optionId } });
        return;
      }
      const requestId = String(msg.id);
      this.emit({
        type: "permission",
        requestId,
        sessionId,
        params: msg.params,
      });
      try {
        const outcome = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("permission timed out")), 5 * 60 * 1000);
          this.permWaiters.set(requestId, {
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
        });
        this.reply(msg.id, { outcome });
      } catch {
        this.reply(msg.id, { outcome: { outcome: "cancelled" } });
      } finally {
        this.permWaiters.delete(requestId);
      }
      return;
    }
    if (msg.method === "fs/read_text_file") {
      try {
        const file = sandboxFile(msg.params?.path, msg.params?.sessionId);
        const content = await readFile(file, "utf8");
        this.reply(msg.id, { content });
      } catch (err) {
        this.replyError(msg.id, publicError(err));
      }
      return;
    }
    this.replyError(msg.id, `unsupported client method ${msg.method}`);
  }

  resolvePermission(requestId, outcome) {
    const waiter = this.permWaiters.get(String(requestId));
    if (!waiter) return false;
    waiter.resolve(outcome);
    return true;
  }

  send(obj) {
    if (!this.proc?.stdin.writable) throw new Error("grok agent is not running");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  reply(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  replyError(id, message) {
    this.send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
  }

  failPrompts(message) {
    for (const [id, pending] of this.pending) {
      if (pending.method !== "session/prompt") continue;
      this.pending.delete(id);
      pending.reject(new Error(message));
      if (pending.sessionId) {
        try {
          this.notify("session/cancel", { sessionId: pending.sessionId });
        } catch {}
      }
    }
  }

  pickModel(value) {
    const model = String(value || "").trim();
    if (ALLOWED_MODELS.includes(model)) return model;
    if (model === "deepseek" || model === "deepseek-chat") return "deepseek-flash";
    if (model === "deepseek-reasoner") return "deepseek-v4-pro";
    return DEFAULT_MODEL;
  }

  async ensureSessionModel(sessionId, wanted, { force = false } = {}) {
    const model = this.pickModel(wanted || this.sessions.get(sessionId)?.model);
    const rec = this.sessions.get(sessionId);
    if (!force && rec?.model === model) return model;
    try {
      await this.setConfig(sessionId, "model", model);
    } catch (err) {
      console.error("set model", err.message);
    }
    if (rec) rec.model = model;
    else this.sessions.set(sessionId, { model });
    return model;
  }

  request(method, params, timeoutMs = 120000) {
    if (method === "session/prompt") timeoutMs = Math.max(timeoutMs, 10 * 60 * 1000);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        method,
        sessionId: params?.sessionId,
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

    async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "super-coding", title: "Super Coding", version: "0.1.0" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        terminal: false,
      },
    });
    this.ready = true;
    this.caps = result || {};
    const methods = result?.authMethods || [];
    const ids = methods.map((m) => m.id).filter(Boolean);
    console.log("auth methods", ids.join(",") || "(none)");
    const order = ["xai.api_key", ...ids.filter((id) => id !== "grok.com")];
    const seen = new Set();
    let authed = false;
    for (const id of order) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      try {
        await this.request("authenticate", { methodId: id }, 8000);
        console.log("authenticated via", id);
        authed = true;
        break;
      } catch (err) {
        console.error("authenticate", id, err.message);
      }
    }
    if (!authed) {
      console.error("No non-interactive auth. Put DEEPSEEK_API_KEY in grok-web/.env or paste it in the UI.");
    }
    return result;
  }

  async applyModelKey(value, extra = {}) {
    const incoming = String(value || "").trim().replace(/\r?\n/g, "");
    const keepKey = process.env.DEEPSEEK_API_KEY || process.env.XAI_API_KEY || "";
    const key = incoming || keepKey;
    if (!key) throw new Error("请先填写 DeepSeek API Key。");
    process.env.DEEPSEEK_API_KEY = key;
    process.env.XAI_API_KEY = key;
    process.env.DEEPSEEK_BASE_URL = normalizeBaseUrl(extra.baseUrl || process.env.DEEPSEEK_BASE_URL);
    await writeEnvFile({
      DEEPSEEK_API_KEY: key,
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
    });
    await this.respawn();
  }

  async respawn() {
    this.respawning = true;
    if (this.proc && !this.proc.killed) this.proc.kill();
    await new Promise((r) => setTimeout(r, 400));
    this.pending.clear();
    this.sessions.clear();
    this.start();
    await this.initialize();
    this.respawning = false;
    this.emit({ type: "ready", cwd: DEFAULT_CWD, ready: this.ready });
  }

  ext(method, params) {
    return this.request("ext_method", { method, params });
  }

  async newSession(cwd) {
    const result = await this.request("session/new", {
      cwd,
      mcpServers: [],
      _meta: { yoloMode: true },
    });
    const sessionId = result.sessionId;
    this.sessions.set(sessionId, {
      cwd,
      title: "New session",
      modes: result.modes,
      configOptions: sanitizeConfigOptions(result.configOptions),
    });
    if (!this.permModes.has(sessionId)) this.permModes.set(sessionId, "yolo");
    this.lastCwd = cwd;
    await this.ensureSessionModel(sessionId, DEFAULT_MODEL, { force: true });
    return publicSession({ ...result, cwd });
  }

  async renameSession(sessionId, title, cwd) {
    return this.ext("x.ai/session/rename", {
      sessionId,
      title,
      cwd,
    });
  }

  setMode(sessionId, modeId) {
    return this.request("session/set_mode", { sessionId, modeId });
  }

  setConfig(sessionId, configId, value) {
    const next = configId === "model" ? this.pickModel(value) : value;
    return this.request("session/set_config_option", {
      sessionId,
      configId,
      value: { value: next },
    }).catch((err) => {
      if (/invalid params/i.test(err.message) && (configId === "model" || configId === "reasoning_effort")) {
        return null;
      }
      throw err;
    });
  }

  async loadSession(sessionId, cwd) {
    const prev = this.sessions.get(sessionId);
    this.sessions.set(sessionId, { cwd, title: prev?.title || sessionId });
    this.lastCwd = cwd;
    const result = await this.request("session/load", {
      sessionId,
      cwd,
      mcpServers: [],
    });
    if (!this.permModes.has(sessionId)) this.permModes.set(sessionId, "yolo");
    await this.ensureSessionModel(sessionId, this.sessions.get(sessionId)?.model || DEFAULT_MODEL, {
      force: true,
    });
    return publicSession({ ...result, sessionId, cwd });
  }

  async listSessions(cwd) {
    try {
      const std = await this.request("session/list", { cwd });
      if (Array.isArray(std?.sessions)) return std.sessions;
    } catch (err) {
      console.error("session/list", err.message);
    }
    try {
      const result = await this.ext("x.ai/session/list", {
        cwd,
        limit: 80,
        allowRelax: true,
        headless: "exclude",
      });
      return result?.sessions || [];
    } catch (err) {
      console.error("x.ai/session/list", err.message);
      return [];
    }
  }

  prompt(sessionId, text) {
    return this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  cancel(sessionId) {
    this.cancelled.add(sessionId);
    try {
      this.notify("session/cancel", { sessionId });
    } catch (err) {
      console.error("session/cancel", err.message);
    }
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId && pending.method === "session/prompt") {
        this.pending.delete(id);
        pending.reject(new Error("cancelled"));
      }
    }
    for (const [, waiter] of this.permWaiters) {
      try {
        waiter.resolve({ outcome: "cancelled" });
      } catch {}
    }
  }
}

function firstLocation(update) {
  if (!update) return null;
  const locs = update.locations;
  if (Array.isArray(locs) && locs[0]?.path) return locs[0].path;
  const input = update.rawInput || update._meta?.rawInput;
  if (input?.path) return input.path;
  return null;
}

function sandboxRoots() {
  return [USERS_DIR, PUBLISHED, WORKSPACES, SAVES, DEFAULT_CWD];
}

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function inAppSandbox(target) {
  const resolved = path.resolve(target);
  return sandboxRoots().some((root) => isInside(root, resolved));
}

function toSessionRel(cwd, loc) {
  if (!loc) return "";
  const raw = String(loc);
  if (!cwd) return raw.replaceAll("\\", "/");
  try {
    const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);
    const rel = path.relative(cwd, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return "";
    return rel.replaceAll("\\", "/");
  } catch {
    return "";
  }
}

function toRelPath(root, target) {
  const raw = String(target || ".");
  const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("outside sandbox");
  return rel || ".";
}

function sandboxFile(target, sessionId) {
  const cwd = (sessionId && acp.sessions.get(sessionId)?.cwd) || acp.lastCwd || DEFAULT_CWD;
  const raw = String(target || "");
  const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);
  if (!inAppSandbox(resolved)) throw new Error("outside sandbox");
  return resolved;
}

function publicError(err) {
  const msg = String(err?.message || err || "出错了");
  if (/timed out/i.test(msg)) return "这次做得有点久，已经停了。请再发一次。";
  if (/supported API model|you passed grok|只支持 deepseek/i.test(msg)) {
    return "当前只能用 deepseek-flash。已经帮你改好了，请再发一次。";
  }
  if (/outside sandbox|outside the session/i.test(msg)) return "不能访问工作区以外的文件。";
  if (/path not found/i.test(msg)) return "找不到这次对话。";
  if (/ENOENT|no such file/i.test(msg)) return "工作区里没有这个文件。";
  if (/EACCES|EPERM|permission denied/i.test(msg)) return "没有权限访问这个文件。";
  if (/docker/i.test(msg)) return msg.slice(0, 180);
  return msg
    .replace(/[A-Za-z]:\\[^\s'"]+/g, "工作区文件")
    .replace(/\/(?:Users|home)\/[^\s'"]+/g, "工作区文件")
    .slice(0, 180);
}

function confine(root, target) {
  const resolved = path.resolve(root, target);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path is outside the session workspace");
  }
  if (!inAppSandbox(resolved)) throw new Error("outside sandbox");
  return resolved;
}

async function listTree(root, rel = ".", depth = 2) {
  const dir = confine(root, rel);
  const entries = [];
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return entries;
  }
  items.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const item of items) {
    if (item.name.startsWith(".") && item.name !== ".gitignore") continue;
    if (SKIP_DIRS.has(item.name) || HIDDEN_FILES.has(item.name)) continue;
    const base = String(rel || ".").replaceAll("\\", "/").replace(/^\.\/?$/, "");
    const childRel = [base, item.name].filter(Boolean).join("/");
    const row = {
      name: item.name,
      path: childRel,
      kind: item.isDirectory() ? "dir" : "file",
    };
    if (item.isDirectory() && depth > 1) {
      row.children = await listTree(root, childRel, depth - 1);
    }
    entries.push(row);
    if (entries.length >= 400) break;
  }
  return entries;
}

async function readWorkspaceFile(root, rel) {
  const file = confine(root, rel);
  const info = await stat(file);
  if (info.isDirectory()) throw new Error("not a file");
  if (info.size > 400_000) throw new Error("file is larger than 400KB");
  const buf = await readFile(file);
  if (buf.includes(0)) {
    return { path: rel, binary: true, size: info.size, content: "" };
  }
  return { path: rel, binary: false, size: info.size, content: buf.toString("utf8") };
}

function safeSessionId(id) {
  const s = String(id || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
  if (!s || s === "." || s === "..") throw new Error("invalid session id");
  return s;
}

function sessionCwd(sessionId, userId) {
  if (userId) return path.join(USERS_DIR, String(userId), "projects", safeSessionId(sessionId));
  return path.join(WORKSPACES, safeSessionId(sessionId));
}

function sessionSavesDir(sessionId) {
  const project = store.projectBySession(sessionId);
  if (project) return path.join(USERS_DIR, String(project.userId), "saves", safeSessionId(sessionId));
  return path.join(SAVES, safeSessionId(sessionId));
}

function userFromRequest(req) {
  const token = parseCookie(req.headers.cookie || "")[AUTH_COOKIE];
  return store.userByToken(token);
}

function requireProject(user, sessionId) {
  const project = store.projectBySession(sessionId);
  if (!user || !project || project.userId !== user.id) throw new Error("找不到这个项目。");
  return project;
}

function setAuthCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`,
  );
}

function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function makeSlug() {
  return randomBytes(4).toString("hex");
}

function publicOrigin(req) {
  const host = req.headers.host || `${HOST}:${PORT}`;
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${host}`;
}

function publishUrl(req, slug) {
  return `${publicOrigin(req)}/p/${slug}/`;
}

function appPublicUrl(req, port) {
  const host = String(req?.headers?.host || `${HOST}:${PORT}`).split(":")[0];
  const proto = req?.headers?.["x-forwarded-proto"] || "http";
  return `${proto}://${host}:${port}/`;
}

function volumeDir(userId, sessionId) {
  return path.join(USERS_DIR, String(userId), "volumes", String(sessionId));
}

async function syncRuntime(user, sessionId, send, { rebuild = false } = {}) {
  const cwd = await resolveSessionCwd(sessionId, { create: true });
  if (!isAppProject(cwd)) {
    send({ type: "runtime", sessionId, kind: "static" });
    return null;
  }
  send({ type: "runtime", sessionId, kind: "app", status: "building" });
  try {
    const rec = await ensureApp(sessionId, cwd, volumeDir(user.id, sessionId), { rebuild });
    send({ type: "runtime", sessionId, kind: "app", status: "ready", port: rec.port });
    return rec;
  } catch (err) {
    send({
      type: "runtime",
      sessionId,
      kind: "app",
      status: "error",
      message: publicError(err),
    });
    return null;
  }
}

function sessionHeadFile(sessionId) {
  return path.join(sessionSavesDir(sessionId), "HEAD");
}

async function readHead(sessionId) {
  try {
    return (await readFile(sessionHeadFile(sessionId), "utf8")).trim();
  } catch {
    return "";
  }
}

async function writeHead(sessionId, id) {
  const dir = sessionSavesDir(sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(sessionHeadFile(sessionId), String(id || ""), "utf8");
}

function withParents(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const chrono = [...rows].sort((a, b) =>
    String(a.createdAt || a.id).localeCompare(String(b.createdAt || b.id)),
  );
  return rows.map((row) => {
    if (row.parentId && byId.has(row.parentId)) return row;
    const i = chrono.findIndex((item) => item.id === row.id);
    return { ...row, parentId: i > 0 ? chrono[i - 1].id : null };
  });
}

async function listVersions(sessionId) {
  if (!sessionId) return [];
  const dir = sessionSavesDir(sessionId);
  let ids = [];
  try {
    ids = await readdir(dir);
  } catch {
    return [];
  }
  const rows = [];
  for (const id of ids) {
    try {
      const folder = path.join(dir, id);
      const info = await stat(folder);
      if (!info.isDirectory()) continue;
      const raw = await readFile(path.join(folder, "meta.json"), "utf8");
      rows.push(JSON.parse(raw));
    } catch {
      /* skip broken snapshot */
    }
  }
  rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return withParents(rows);
}

async function versionsPayload(sessionId) {
  const versions = await listVersions(sessionId);
  const head = (await readHead(sessionId)) || versions[0]?.id || "";
  return { versions, head };
}

async function saveVersion(sessionId, note) {
  const cwd = await resolveSessionCwd(sessionId);
  const id = `v-${Date.now()}`;
  const dest = path.join(sessionSavesDir(sessionId), id);
  let parentId = await readHead(sessionId);
  if (!parentId) {
    const existing = await listVersions(sessionId);
    parentId = existing[0]?.id || null;
  }
  await copyWorkspace(cwd, path.join(dest, "files"));
  const meta = {
    id,
    parentId: parentId || null,
    note: String(note || "").trim() || `存档 ${new Date().toLocaleString()}`,
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(dest, "meta.json"), JSON.stringify(meta, null, 2));
  await writeHead(sessionId, id);
  return meta;
}

async function restoreVersion(sessionId, id) {
  const cwd = await resolveSessionCwd(sessionId);
  const root = sessionSavesDir(sessionId);
  const src = path.join(root, String(id || ""), "files");
  if (!src.startsWith(root)) throw new Error("invalid version");
  const info = await stat(src);
  if (!info.isDirectory()) throw new Error("存档不存在");
  await emptyDir(cwd);
  await copyWorkspace(src, cwd);
  await ensureAgentsMd(cwd);
  await writeHead(sessionId, id);
}

async function deleteVersion(sessionId, id) {
  const root = sessionSavesDir(sessionId);
  const dest = path.join(root, String(id || ""));
  if (!dest.startsWith(root)) throw new Error("invalid version");
  const versions = await listVersions(sessionId);
  const doomed = versions.find((row) => row.id === id);
  const parentId = doomed?.parentId || null;
  for (const row of versions) {
    if (row.parentId !== id) continue;
    const next = { ...row, parentId };
    await writeFile(path.join(root, row.id, "meta.json"), JSON.stringify(next, null, 2));
  }
  const head = await readHead(sessionId);
  if (head === id) await writeHead(sessionId, parentId || "");
  await rm(dest, { recursive: true, force: true });
}

async function readIndex() {
  try {
    const raw = JSON.parse(await readFile(INDEX_FILE, "utf8"));
    if (Array.isArray(raw?.sessions)) return raw.sessions;
    if (Array.isArray(raw)) return raw;
  } catch {
    /* first run */
  }
  return [];
}

async function writeIndex(sessions) {
  await writeFile(INDEX_FILE, JSON.stringify({ sessions }, null, 2));
}

async function upsertIndex(entry) {
  const sessions = await readIndex();
  const i = sessions.findIndex((s) => s.sessionId === entry.sessionId);
  const next = {
    ...(i >= 0 ? sessions[i] : {}),
    sessionId: entry.sessionId,
    title: entry.title || (i >= 0 ? sessions[i].title : "新对话"),
    cwd: entry.cwd || (i >= 0 ? sessions[i].cwd : sessionCwd(entry.sessionId)),
    updatedAt: entry.updatedAt || new Date().toISOString(),
  };
  if (entry.titleManual != null) next.titleManual = Boolean(entry.titleManual);
  if (i >= 0) sessions[i] = next;
  else sessions.unshift(next);
  sessions.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  await writeIndex(sessions);
  return next;
}

function isIsolatedCwd(cwd) {
  if (!cwd) return false;
  const rel = path.relative(WORKSPACES, path.resolve(cwd));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function grokSessionsRoot() {
  return path.join(AGENT_HOME, "sessions");
}

function grokSessionRoots() {
  return uniquePaths([grokSessionsRoot(), path.join(os.homedir(), ".grok", "sessions")]);
}

function decodeGrokCwdName(name) {
  try {
    return decodeURIComponent(String(name || ""));
  } catch {
    return "";
  }
}

function uniquePaths(paths) {
  const out = [];
  const seen = new Set();
  for (const raw of paths) {
    if (!raw) continue;
    const resolved = path.resolve(raw);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

async function grokSessionCwdMap() {
  const map = new Map();
  for (const root of grokSessionRoots()) {
    let groups;
    try {
      groups = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const group of groups) {
      if (!group.isDirectory()) continue;
      const groupDir = path.join(root, group.name);
      let cwd = "";
      try {
        cwd = (await readFile(path.join(groupDir, ".cwd"), "utf8")).trim();
      } catch {
        cwd = decodeGrokCwdName(group.name);
      }
      if (!cwd) continue;
      let kids;
      try {
        kids = await readdir(groupDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const kid of kids) {
        if (!kid.isDirectory()) continue;
        const prev = map.get(kid.name);
        if (!prev || isIsolatedCwd(cwd)) map.set(kid.name, cwd);
      }
    }
  }
  return map;
}

async function resolveSessionCwd(sessionId, { create = false } = {}) {
  const live = acp.sessions.get(sessionId)?.cwd;
  if (live && inAppSandbox(live)) return live;
  const project = store.projectBySession(sessionId);
  if (project?.cwd && inAppSandbox(project.cwd)) {
    if (create) await mkdir(project.cwd, { recursive: true });
    return project.cwd;
  }
  const row = (await readIndex()).find((s) => s.sessionId === sessionId);
  if (row?.cwd && inAppSandbox(row.cwd)) return row.cwd;
  const grokCwd = (await grokSessionCwdMap()).get(sessionId);
  if (grokCwd && inAppSandbox(grokCwd)) return grokCwd;
  const dir = sessionCwd(sessionId);
  if (create) await mkdir(dir, { recursive: true });
  return dir;
}

async function deleteStoredSession(sessionId, user) {
  const id = String(sessionId || "");
  if (!id) throw new Error("缺少会话");
  const project = requireProject(user, id);
  try {
    acp.cancel(id);
  } catch {}
  acp.sessions.delete(id);
  acp.permModes?.delete(id);
  acp.cancelled.delete(id);
  try {
    await acp.request("session/delete", { sessionId: id }, 8000);
  } catch (err) {
    console.error("session/delete", err.message);
  }
  store.deleteUserProject(user.id, id);
  const index = await readIndex();
  await writeIndex(index.filter((s) => s.sessionId !== id));
  await stopApp(id);
  if (project.cwd && inAppSandbox(project.cwd)) {
    await rm(project.cwd, { recursive: true, force: true });
  }
  await rm(sessionSavesDir(id), { recursive: true, force: true });
  if (project.publishedSlug) {
    await rm(path.join(PUBLISHED, project.publishedSlug), { recursive: true, force: true });
  }
}

async function listUserSessions(userId) {
  return store.listUserProjects(userId).map((row) => ({
    sessionId: row.sessionId,
    title: displayTitle(row.title),
    cwd: row.cwd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedSlug: row.publishedSlug,
  }));
}

function isPlaceholderTitle(title) {
  const t = String(title || "").trim();
  if (!t) return true;
  if (/^(新对话|新会话|未命名对话|未命名|new session|untitled)$/i.test(t)) return true;
  if (/^[0-9a-f-]+$/i.test(t) && t.includes("-") && t.length >= 20) return true;
  return false;
}

function displayTitle(title) {
  return isPlaceholderTitle(title) ? "新对话" : String(title).trim().slice(0, 16);
}

function titleFromUserText(text) {
  let t = String(text || "")
    .replace(/【[\s\S]*?】/g, " ")
    .replace(/^\/\S+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  t = t.split(/[\n。！？!?]/)[0] || t;
  t = t.replace(/^(请你|请帮我|麻烦你|麻烦|帮我|我想|我要|能不能|可以帮我)\s*/u, "");
  t = t.replace(/^(先|再|帮我)?\s*(做|写|生成|创建|实现|开发|制作)\s*(一个|一份|一个简单的|简单的)?\s*/u, "");
  t = t.replace(/^(一个|一份|简单的)\s*/u, "");
  t = t.replace(/(小游戏|游戏|网页|页面)$/u, (m) => (/棋|蛇|球|塔|器|计时|计数/.test(t) ? "" : m));
  t = t.replace(/[，,、.]+$/g, "").trim();
  if (t.length > 16) t = t.slice(0, 16);
  return t;
}

function cleanGeneratedTitle(raw) {
  let t = String(raw || "")
    .replace(/["'`「」『』《》]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/[\n。]/)[0]
    .trim();
  if (t.length > 16) t = t.slice(0, 16);
  if (!t || isPlaceholderTitle(t)) return "";
  return t;
}

async function summarizeTitle(text) {
  const key = process.env.DEEPSEEK_API_KEY || process.env.XAI_API_KEY || "";
  if (!key) return "";
  const prompt = String(text || "").trim().slice(0, 200);
  if (!prompt) return "";
  try {
    const res = await fetch(`${deepseekBase()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        temperature: 0.2,
        max_tokens: 24,
        messages: [
          {
            role: "system",
            content:
              "把用户要做的事压成简体中文标题。最多12个字。不要标点、引号、书名号，不要出现新会话、对话、助手。只输出标题。",
          },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return "";
    const body = await res.json();
    return cleanGeneratedTitle(body?.choices?.[0]?.message?.content || "");
  } catch (err) {
    console.error("summarize title", err.message);
    return "";
  }
}

async function applyAutoTitle(user, sessionId, text) {
  const project = store.projectBySession(sessionId);
  if (!project || project.titleManual || !isPlaceholderTitle(project.title)) return;
  const local = cleanGeneratedTitle(titleFromUserText(text));
  if (local) {
    store.upsertProject({
      sessionId,
      title: local,
      titleManual: false,
      updatedAt: new Date().toISOString(),
    });
    emitToUser(user.id, { type: "session_renamed", sessionId, title: local });
  }
  const ai = await summarizeTitle(text);
  if (!ai) return;
  const latest = store.projectBySession(sessionId);
  if (!latest || latest.titleManual) return;
  if (ai === latest.title) return;
  store.upsertProject({
    sessionId,
    title: ai,
    titleManual: false,
    updatedAt: new Date().toISOString(),
  });
  try {
    await acp.renameSession(sessionId, ai, latest.cwd);
  } catch (err) {
    console.error("session rename", err.message);
  }
  emitToUser(user.id, { type: "session_renamed", sessionId, title: ai });
}

async function copyWorkspace(from, to) {
  await mkdir(to, { recursive: true });
  await cp(from, to, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      if (SKIP_DIRS.has(name) || name === "saves" || HIDDEN_FILES.has(name)) return false;
      return true;
    },
  });
}

async function emptyDir(dir) {
  let items = [];
  try {
    items = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    items.map((name) => rm(path.join(dir, name), { recursive: true, force: true })),
  );
}

const acp = new Acp();
acp.start();
try {
  await acp.initialize();
  console.log("ACP initialize ok");
} catch (err) {
  console.error("ACP initialize failed:", err.message);
  console.error("Run `grok login` on this machine if you have not signed in yet.");
}

const clients = new Set();

function emitToUser(userId, msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.user?.id === userId && ws.readyState === 1) ws.send(data);
  }
}

function emitScoped(msg) {
  const sid = msg.sessionId;
  if (!sid) return;
  const project = store.projectBySession(sid);
  if (!project) return;
  emitToUser(project.userId, msg);
}

acp.on((msg) => emitScoped(msg));

function isLocalSocket(req) {
  const addr = req.socket?.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function checkToken(req) {
  if (HOST === "127.0.0.1" || HOST === "localhost" || isLocalSocket(req)) return true;
  const u = new URL(req.url, "http://local");
  const q = u.searchParams.get("token");
  const auth = req.headers.authorization?.replace(/^Bearer /i, "");
  const cookie = parseCookie(req.headers.cookie || "").token;
  return [q, auth, cookie].includes(TOKEN);
}

function parseCookie(raw) {
  const out = {};
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/health") {
    json(res, { ok: true, ready: acp.ready });
    return;
  }
  if (url.pathname === "/api/me") {
    const user = userFromRequest(req);
    if (!user) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ user: null }));
      return;
    }
    json(res, { user });
    return;
  }
  if (url.pathname === "/api/register" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { user, token } = store.register(body.username, body.password);
      setAuthCookie(res, token);
      json(res, { user });
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: publicError(err) }));
    }
    return;
  }
  if (url.pathname === "/api/login" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { user, token } = store.login(body.username, body.password);
      setAuthCookie(res, token);
      json(res, { user });
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: publicError(err) }));
    }
    return;
  }
  if (url.pathname === "/api/logout" && req.method === "POST") {
    store.logout(parseCookie(req.headers.cookie || "")[AUTH_COOKIE]);
    clearAuthCookie(res);
    json(res, { ok: true });
    return;
  }
  if (url.pathname === "/api/download") {
    const user = userFromRequest(req);
    const sessionId = url.searchParams.get("session") || "";
    try {
      const project = requireProject(user, sessionId);
      const zip = await zipDirectory(project.cwd);
      const filename = encodeURIComponent(safeZipName(project.title));
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename*=UTF-8''${filename}`,
        "cache-control": "no-store",
      });
      res.end(zip);
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: publicError(err) }));
    }
    return;
  }
  if (url.pathname === "/api/publish" && req.method === "POST") {
    const user = userFromRequest(req);
    try {
      const body = await readJsonBody(req);
      const project = requireProject(user, body.sessionId);
      let slug = project.publishedSlug;
      if (!slug || store.projectBySlug(slug)?.sessionId !== project.sessionId) {
        do {
          slug = makeSlug();
        } while (store.projectBySlug(slug));
      }
      const dest = path.join(PUBLISHED, slug);
      if (isAppProject(project.cwd)) {
        const rec = await ensureApp(project.sessionId, project.cwd, volumeDir(user.id, project.sessionId), {
          rebuild: !runtimeOf(project.sessionId),
        });
        store.upsertProject({
          sessionId: project.sessionId,
          publishedSlug: slug,
          publishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        json(res, { url: appPublicUrl(req, rec.port), slug, kind: "app" });
        return;
      }
      await emptyDir(dest);
      if (existsSync(project.cwd)) await copyWorkspace(project.cwd, dest);
      await mkdir(dest, { recursive: true });
      if (!existsSync(path.join(dest, "index.html"))) {
        await writeFile(
          path.join(dest, "index.html"),
          `<!doctype html><meta charset="utf-8"><title>${project.title}</title><p>这个项目还没有首页。请先做一个 index.html。</p>`,
          "utf8",
        );
      }
      store.upsertProject({
        sessionId: project.sessionId,
        publishedSlug: slug,
        publishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      json(res, { url: publishUrl(req, slug), slug });
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: publicError(err) }));
    }
    return;
  }
  if (url.pathname.startsWith("/p/")) {
    const rest = decodeURIComponent(url.pathname.slice(3)).replace(/^\/+/, "");
    const slash = rest.indexOf("/");
    const slug = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
    const rel = slash === -1 ? "" : rest.slice(slash + 1);
    const project = store.projectBySlug(slug);
    if (!project) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("页面不存在或还没有发布。");
      return;
    }
    if (isAppProject(project.cwd)) {
      try {
        const rec =
          runtimeOf(project.sessionId) ||
          (await ensureApp(project.sessionId, project.cwd, volumeDir(project.userId, project.sessionId)));
        res.writeHead(302, { Location: appPublicUrl(req, rec.port) + (rel || "") });
        res.end();
      } catch (err) {
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end(publicError(err));
      }
      return;
    }
    try {
      const root = path.join(PUBLISHED, slug);
      let filePath = confine(root, rel || ".");
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = path.join(filePath, "index.html");
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "content-type": MIME[ext] || "application/octet-stream",
        "cache-control": "no-store",
      });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
    }
    return;
  }
  if (url.pathname.startsWith("/preview-app/")) {
    const user = userFromRequest(req);
    const raw = decodeURIComponent(url.pathname.slice("/preview-app/".length)).replace(/^\/+/, "");
    const slash = raw.indexOf("/");
    const sessionId = slash === -1 ? raw : raw.slice(0, slash);
    const rest = slash === -1 ? "/" : raw.slice(slash);
    let project;
    try {
      project = requireProject(user, sessionId);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    let rec = runtimeOf(sessionId);
    if (!rec) {
      try {
        rec = await ensureApp(sessionId, project.cwd, volumeDir(user.id, sessionId), { rebuild: false });
      } catch {
        rec = null;
      }
    }
    if (!rec) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("应用还没启动");
      return;
    }
    if (slash === -1) {
      res.writeHead(302, { Location: `/preview-app/${encodeURIComponent(sessionId)}/` });
      res.end();
      return;
    }
    proxyApp(req, res, rec, sessionId, rest || "/", url.search);
    return;
  }
  if (url.pathname.startsWith("/workspace/")) {
    const user = userFromRequest(req);
    const raw = decodeURIComponent(url.pathname.slice("/workspace/".length)).replace(/^\/+/, "");
    const slash = raw.indexOf("/");
    const sessionId = slash === -1 ? raw : raw.slice(0, slash);
    const rel = slash === -1 ? "" : raw.slice(slash + 1);
    try {
      requireProject(user, sessionId);
      const cwd = await resolveSessionCwd(sessionId);
      let filePath = confine(cwd, rel || ".");
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = path.join(filePath, "index.html");
      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || "application/octet-stream";
      if (type.startsWith("text/html")) {
        const html = injectHtmlChrome(await readFile(filePath, "utf8"));
        res.writeHead(200, {
          "content-type": type,
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(html),
        });
        res.end(html);
        return;
      }
      res.writeHead(200, {
        "content-type": type,
        "cache-control": "no-store",
      });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
    return;
  }
  let filePath =
    url.pathname === "/" || url.pathname === "/home"
      ? path.join(PUBLIC, "home.html")
      : url.pathname === "/app"
        ? path.join(PUBLIC, "index.html")
        : path.join(PUBLIC, url.pathname);
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, "index.html");
    const ext = path.extname(filePath);
    const type = MIME[ext] || "application/octet-stream";
    const fresh = [".html", ".htm", ".js", ".mjs", ".css"].includes(ext);
    res.writeHead(200, {
      "content-type": type,
      "cache-control": fresh ? "no-store" : "public, max-age=86400",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
});

function json(res, body) {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws, req) => {
  const user = userFromRequest(req);
  if (!user) {
    ws.send(JSON.stringify({ type: "auth_required" }));
    ws.close(4401, "auth required");
    return;
  }
  ws.user = user;
  clients.add(ws);
  ws.send(
    JSON.stringify({
      type: "ready",
      ready: acp.ready,
      user,
      provider: publicProvider(),
    }),
  );
  ws.on("close", () => clients.delete(ws));
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const run = () =>
      handleClient(ws, msg).catch((err) => {
        ws.send(JSON.stringify({ type: "error", message: publicError(err), op: msg.type }));
      });
    run();
  });
});

async function handleClient(ws, msg) {
  const send = (payload) => ws.send(JSON.stringify(payload));
  const user = ws.user;
  if (!user) throw new Error("请先登录。");
  if (msg.sessionId && !["new_session", "list_sessions"].includes(msg.type)) {
    requireProject(user, msg.sessionId);
  }
  switch (msg.type) {
    case "list_sessions": {
      const sessions = await listUserSessions(user.id);
      send({ type: "sessions", sessions });
      break;
    }
    case "new_session": {
      const folder = path.join(
        USERS_DIR,
        String(user.id),
        "projects",
        `s-${Date.now()}-${randomBytes(4).toString("hex")}`,
      );
      await mkdir(folder, { recursive: true });
      await ensureAgentsMd(folder);
      const session = await acp.newSession(folder);
      store.upsertProject({
        sessionId: session.sessionId,
        userId: user.id,
        title: "新对话",
        cwd: folder,
        updatedAt: new Date().toISOString(),
      });
      send({ type: "session", action: "new", session: { ...session, cwd: folder, title: "新对话" } });
      break;
    }
    case "load_session": {
      const id = String(msg.sessionId || "");
      const project = requireProject(user, id);
      await mkdir(project.cwd, { recursive: true });
      await ensureAgentsMd(project.cwd);
      const session = await acp.loadSession(id, project.cwd);
      await acp.ensureSessionModel(id, msg.model);
      if (acp.sessions.has(id)) acp.sessions.get(id).cwd = project.cwd;
      const grokTitle = session.title || "";
      const title = project.titleManual || !isPlaceholderTitle(project.title)
        ? displayTitle(project.title)
        : displayTitle(grokTitle || project.title);
      store.upsertProject({
        sessionId: id,
        title,
        cwd: project.cwd,
      });
      send({
        type: "session",
        action: "load",
        session: { ...session, cwd: project.cwd, title, publishedSlug: project.publishedSlug },
      });
      {
        const live = runtimeOf(id);
        if (live) send({ type: "runtime", sessionId: id, kind: "app", status: "ready", port: live.port });
        else if (isAppProject(project.cwd)) send({ type: "runtime", sessionId: id, kind: "app", status: "idle" });
        else send({ type: "runtime", sessionId: id, kind: "static" });
      }
      break;
    }
    case "delete_session": {
      await deleteStoredSession(msg.sessionId, user);
      send({ type: "session_deleted", sessionId: msg.sessionId });
      break;
    }
    case "fork_session": {
      const srcId = String(msg.sessionId || "");
      const row = requireProject(user, srcId);
      const srcCwd = await resolveSessionCwd(srcId);
      const folder = path.join(
        USERS_DIR,
        String(user.id),
        "projects",
        `s-${Date.now()}-${randomBytes(4).toString("hex")}`,
      );
      await mkdir(folder, { recursive: true });
      if (existsSync(srcCwd)) await copyWorkspace(srcCwd, folder);
      await ensureAgentsMd(folder);
      const session = await acp.newSession(folder);
      const base = String(row.title || "新对话").replace(/\s*(分支|副本)$/u, "");
      const title = `${base} 分支`.slice(0, 40);
      store.upsertProject({
        sessionId: session.sessionId,
        userId: user.id,
        title,
        titleManual: true,
        cwd: folder,
        updatedAt: new Date().toISOString(),
      });
      try {
        if (existsSync(sessionSavesDir(srcId))) {
          await cp(sessionSavesDir(srcId), sessionSavesDir(session.sessionId), { recursive: true });
        }
      } catch (err) {
        console.error("fork saves", err.message);
      }
      send({ type: "session", action: "new", session: { ...session, cwd: folder, title } });
      break;
    }
    case "rename_session": {
      const title = String(msg.title || "").trim();
      if (!title) throw new Error("标题不能为空");
      const project = requireProject(user, msg.sessionId);
      const cwd = acp.sessions.get(msg.sessionId)?.cwd || project.cwd;
      try {
        await acp.renameSession(msg.sessionId, title, cwd);
      } catch (err) {
        console.error("session rename", err.message);
      }
      store.upsertProject({
        sessionId: msg.sessionId,
        title,
        titleManual: true,
        updatedAt: new Date().toISOString(),
      });
      send({ type: "session_renamed", sessionId: msg.sessionId, title });
      break;
    }
    case "set_mode": {
      await acp.setMode(msg.sessionId, msg.modeId);
      send({ type: "mode", sessionId: msg.sessionId, modeId: msg.modeId });
      break;
    }
    case "set_permission": {
      const mode = ["confirm", "auto", "yolo"].includes(msg.mode) ? msg.mode : "yolo";
      acp.setPermMode(msg.sessionId, mode);
      send({ type: "permission_mode", sessionId: msg.sessionId, mode });
      break;
    }
    case "set_config": {
      let value = msg.value;
      if (msg.configId === "model") {
        value = acp.pickModel(value);
        const rec = acp.sessions.get(msg.sessionId);
        if (rec) rec.model = value;
      }
      const result = await acp.setConfig(msg.sessionId, msg.configId, value);
      if (result) {
        send({
          type: "config",
          sessionId: msg.sessionId,
          configId: msg.configId,
          result: Array.isArray(result) ? sanitizeConfigOptions(result) : result?.configOptions
            ? { ...result, configOptions: sanitizeConfigOptions(result.configOptions) }
            : result,
        });
      }
      break;
    }
    case "prompt": {
      const gen = msg.gen;
      acp.cancelled.delete(msg.sessionId);
      void applyAutoTitle(user, msg.sessionId, msg.text);
      await acp.ensureSessionModel(msg.sessionId, msg.model);
      try {
        const result = await acp.prompt(msg.sessionId, msg.text);
        if (acp.cancelled.has(msg.sessionId)) {
          acp.cancelled.delete(msg.sessionId);
          send({ type: "cancelled", sessionId: msg.sessionId, gen });
          break;
        }
        store.upsertProject({ sessionId: msg.sessionId, updatedAt: new Date().toISOString() });
        send({ type: "prompt_done", sessionId: msg.sessionId, result, gen });
        void syncRuntime(user, msg.sessionId, send, { rebuild: true });
      } catch (err) {
        if (/cancelled/i.test(err.message)) {
          acp.cancelled.delete(msg.sessionId);
          send({ type: "cancelled", sessionId: msg.sessionId, gen });
          break;
        }
        throw err;
      }
      break;
    }
    case "cancel": {
      acp.cancel(msg.sessionId);
      send({ type: "cancelled", sessionId: msg.sessionId, gen: msg.gen });
      break;
    }
    case "permission": {
      const outcome = msg.cancelled
        ? { outcome: "cancelled" }
        : { outcome: "selected", optionId: msg.optionId };
      const ok = acp.resolvePermission(msg.requestId, outcome);
      send({ type: "permission_ack", ok, requestId: msg.requestId });
      break;
    }
    case "list_dir": {
      const cwd = await resolveSessionCwd(msg.sessionId, { create: true });
      const entries = await listTree(cwd, msg.path || ".", 5);
      send({ type: "file_tree", sessionId: msg.sessionId, cwd, entries });
      break;
    }
    case "read_file": {
      const cwd = await resolveSessionCwd(msg.sessionId, { create: true });
      try {
        const file = await readWorkspaceFile(cwd, toRelPath(cwd, msg.path));
        send({ type: "file", sessionId: msg.sessionId, silent: Boolean(msg.silent), ...file });
      } catch (err) {
        if (msg.silent) {
          send({ type: "file_missing", sessionId: msg.sessionId, path: msg.path });
          break;
        }
        throw err;
      }
      break;
    }
    case "list_versions": {
      send({ type: "versions", ...(await versionsPayload(msg.sessionId)) });
      break;
    }
    case "save_version": {
      await saveVersion(msg.sessionId, msg.note);
      send({ type: "version_saved", ...(await versionsPayload(msg.sessionId)) });
      break;
    }
    case "restore_version": {
      await restoreVersion(msg.sessionId, msg.id);
      send({ type: "version_restored", id: msg.id, ...(await versionsPayload(msg.sessionId)) });
      break;
    }
    case "delete_version": {
      await deleteVersion(msg.sessionId, msg.id);
      send({ type: "versions", ...(await versionsPayload(msg.sessionId)) });
      break;
    }
    case "ensure_runtime": {
      const live = runtimeOf(msg.sessionId);
      if (live) {
        send({ type: "runtime", sessionId: msg.sessionId, kind: "app", status: "ready", port: live.port });
        break;
      }
      await syncRuntime(user, msg.sessionId, send, { rebuild: false });
      break;
    }
    case "model_key": {
      await acp.applyModelKey(msg.value, { baseUrl: msg.baseUrl });
      send({ type: "ready", ready: acp.ready, user, provider: publicProvider() });
      break;
    }
    default:
      send({ type: "error", message: `unknown ${msg.type}` });
  }
}

httpServer.listen(PORT, HOST, () => {
  const origin = `http://${HOST}:${PORT}`;
  console.log(`Super Coding  ${origin}`);
  console.log(`data      ${DATA}`);
  console.log(`bind      ${HOST}:${PORT}`);
  if (HOST === "0.0.0.0") {
    console.log("Public bind: this process can edit files and run shell on this machine.");
    console.log("Put it behind HTTPS + keep the token private. Do not use --always-approve.");
  }
});
