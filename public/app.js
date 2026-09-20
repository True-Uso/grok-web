import { highlight, languageOf } from "./syntax.js";

const $ = (id) => document.getElementById(id);
const localHost = ["localhost", "127.0.0.1"].includes(location.hostname);

function looksLikeApiKey(value) {
  return /^(sk-|sk-or-)/i.test(String(value || "").trim());
}

function readStoredToken() {
  const fromUrl = new URLSearchParams(location.search).get("token") || "";
  const fromStore = sessionStorage.getItem("grok-web-token") || "";
  if (looksLikeApiKey(fromUrl) || looksLikeApiKey(fromStore)) {
    const key = looksLikeApiKey(fromUrl) ? fromUrl : fromStore;
    sessionStorage.setItem("pending-model-key", key);
    sessionStorage.removeItem("grok-web-token");
    const url = new URL(location.href);
    url.searchParams.delete("token");
    history.replaceState({}, "", url);
    return "";
  }
  return fromUrl || fromStore;
}

function readPermMode() {
  try {
    const value = localStorage.getItem("super-coding-perm");
    if (["confirm", "auto", "yolo"].includes(value)) return value;
  } catch {
    /* ignore */
  }
  return "yolo";
}

function persistPermMode(mode) {
  try {
    localStorage.setItem("super-coding-perm", mode);
  } catch {
    /* ignore */
  }
}

function persistPref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

const RUN_MODES = ["single", "multi", "factory"];
const RUN_MODE_LABELS = {
  single: "单 Agent",
  multi: "多 Agent",
  factory: "工厂模式",
};

function readRunMode() {
  const value = readPref("super-coding-run-mode", "single");
  return RUN_MODES.includes(value) ? value : "single";
}

function applyRunMode(mode, { persist = true, toastChange = false } = {}) {
  if (!RUN_MODES.includes(mode)) return;
  const prev = state.runMode;
  state.runMode = mode;
  const stage = $("stage");
  if (stage) stage.dataset.runMode = mode;
  const board = $("work-board");
  if (board) board.dataset.runMode = mode;
  const shell = $("app");
  if (shell) shell.dataset.runMode = mode;
  const label = $("run-mode-label");
  if (label) label.textContent = RUN_MODE_LABELS[mode];
  for (const btn of document.querySelectorAll(".run-mode-opt")) {
    const on = btn.dataset.runMode === mode;
    btn.classList.toggle("on", on);
  }
  if (persist) persistPref("super-coding-run-mode", mode);
  if (toastChange && prev !== mode) toast(`已切换到${RUN_MODE_LABELS[mode]}`);
  paintWorkBoard();
}

function readPref(key, fallback = "") {
  try {
    const value = localStorage.getItem(key);
    if (value) return value;
  } catch {
    /* ignore */
  }
  return fallback;
}

const DEFAULT_MODELS = ["deepseek-flash", "deepseek-v4-pro"];

function pickClientModel(value) {
  const model = String(value || "").trim();
  if (DEFAULT_MODELS.includes(model)) return model;
  if (model === "deepseek" || model === "deepseek-chat") return "deepseek-flash";
  if (model === "deepseek-reasoner") return "deepseek-v4-pro";
  return DEFAULT_MODELS[0];
}

const salvaged = readStoredToken();
const state = {
  ws: null,
  token: localHost ? "" : salvaged,
  sessionId: null,
  restoring: false,
  busy: false,
  listening: false,
  gen: 0,
  tab: "preview",
  modeId: "default",
  permissionMode: "yolo",
  runMode: readRunMode(),
  model: pickClientModel(readPref("super-coding-model", "deepseek-flash")),
  effort: ["low", "medium", "high", "xhigh"].includes(readPref("super-coding-effort", "medium"))
    ? readPref("super-coding-effort", "medium")
    : "medium",
  commands: [],
  filePath: "",
  fileContent: "",
  previewPath: "",
  previewDirty: false,
  runtime: { kind: "static" },
  pendingPreview: "",
  htmlFiles: [],
  planEntries: [],
  planMarkdown: "",
  saves: [],
  saveHead: "",
  saveSelected: "",
  openTabs: [],
  fileFilter: "",
  treeEntries: [],
  collapsedDirs: new Set(),
  sessionTitle: "",
  publishedSlug: "",
  user: null,
  provider: null,
  authMode: "login",
  sessMenuId: "",
  sessMenuTitle: "",
  conn: "",
  bubbles: new Map(),
  tools: new Map(),
  workGroup: null,
  workSteps: [],
  workStatus: "idle",
  workStarted: 0,
  studioLine: null,
  boardOpen: false,
  boardUserClosed: false,
  revealPreview: false,
  turns: [],
  panelOpen: false,
  pendingAgent: "",
};

const WORKING_COPY = ["任务正在执行中", "正在处理，没有卡住", "还在思考怎么做"];
let workingTick = 0;
let workingTimer = 0;

const MODES = [
  { id: "default", label: "默认", slash: null },
  { id: "ask", label: "询问", slash: "/ask" },
  { id: "plan", label: "计划", slash: "/plan" },
  { id: "auto", label: "自动", slash: "/auto" },
  { id: "always-approve", label: "全放行", slash: "/always-approve" },
];

const GROK_COMMANDS = [
  {
    group: "会话",
    items: [
      { name: "new", label: "新会话", hint: "清空并开始新对话", aliases: ["clear"], run: "new" },
      { name: "resume", label: "恢复会话", hint: "从左侧列表载入历史会话", run: "focus-sessions" },
      { name: "rename", label: "重命名", hint: "给当前会话改标题", aliases: ["title"], needsArg: true },
      { name: "fork", label: "分叉", hint: "从当前进度复制出新会话" },
      { name: "compact", label: "压缩上下文", hint: "压缩历史，腾出窗口", needsArg: true },
      { name: "rewind", label: "回退", hint: "撤销到更早一轮", aliases: ["undo"] },
      { name: "copy", label: "复制回复", hint: "复制最近一条回复" },
      { name: "export", label: "导出对话", hint: "导出会话到文件" },
      { name: "delete", label: "删除会话", hint: "删除当前会话和工作区文件", run: "delete" },
      { name: "context", label: "上下文占用", hint: "查看窗口占用拆分" },
      { name: "session-info", label: "会话信息", hint: "模型、轮次、用量", aliases: ["status", "info"] },
      { name: "stop", label: "停止", hint: "取消当前一轮", run: "stop" },
    ],
  },
  {
    group: "模型与模式",
    items: [
      { name: "model", label: "切换模型", hint: "按模型 ID 或名称切换", aliases: ["m"], needsArg: true },
      { name: "effort", label: "思考强度", hint: "low / medium / high / xhigh", needsArg: true },
      { name: "plan", label: "计划模式", hint: "先规划再动手", needsArg: true, run: "mode", modeId: "plan" },
      { name: "view-plan", label: "查看计划", hint: "打开当前计划", aliases: ["show-plan", "plan-view"], run: "view-plan" },
      { name: "ask", label: "询问模式", hint: "只问不改", run: "mode", modeId: "ask" },
      { name: "always-approve", label: "全放行", hint: "跳过权限确认" },
      { name: "auto", label: "自动批准", hint: "安全工具自动放行" },
    ],
  },
  {
    group: "记忆",
    items: [
      { name: "memory", label: "记忆库", hint: "浏览和管理记忆", aliases: ["mem"] },
      { name: "remember", label: "记住", hint: "立刻写入一条记忆", needsArg: true },
      { name: "flush", label: "刷入记忆", hint: "把当前会话总结进记忆" },
      { name: "dream", label: "整理记忆", hint: "合并记忆主题" },
    ],
  },
  {
    group: "扩展",
    items: [
      { name: "skills", label: "技能", hint: "查看已安装 skills" },
      { name: "plugins", label: "插件", hint: "安装和管理插件" },
      { name: "marketplace", label: "市场", hint: "浏览插件市场" },
      { name: "hooks", label: "Hooks", hint: "查看和开关 hooks" },
      { name: "mcps", label: "MCP", hint: "管理 MCP 服务器" },
      { name: "workflows", label: "工作流目录", hint: "浏览已保存工作流" },
    ],
  },
  {
    group: "媒体",
    items: [
      { name: "imagine", label: "生成图片", hint: "用文字生成图片", needsArg: true },
      { name: "imagine-video", label: "生成视频", hint: "用文字生成视频", needsArg: true },
    ],
  },
  {
    group: "调度与目标",
    items: [
      { name: "loop", label: "循环任务", hint: "按间隔重复执行", needsArg: true },
      { name: "workflow", label: "运行工作流", hint: "启动或管理一次运行", needsArg: true },
      { name: "goal", label: "目标", hint: "设置或查看自治目标", needsArg: true },
      { name: "deep-research", label: "深度研究", hint: "后台调研并交叉验证", needsArg: true },
      { name: "btw", label: "旁问", hint: "不打断当前任务的附加问题", needsArg: true },
    ],
  },
  {
    group: "账号与配置",
    items: [
      { name: "usage", label: "用量", hint: "额度与本次消耗", aliases: ["cost"] },
      { name: "login", label: "登录", hint: "重新认证" },
      { name: "logout", label: "登出", hint: "退出当前账号" },
      { name: "privacy", label: "隐私", hint: "编码数据与训练选项" },
      { name: "settings", label: "设置", hint: "打开配置", aliases: ["config", "preferences", "prefs"] },
      { name: "config-agents", label: "Agents", hint: "管理 agent 定义", aliases: ["agents"] },
      { name: "personas", label: "人设", hint: "创建和编辑 personas" },
      { name: "import-claude", label: "导入 Claude", hint: "导入 ~/.claude 设置" },
    ],
  },
  {
    group: "诊断与帮助",
    items: [
      { name: "doctor", label: "诊断", hint: "检查会话与环境问题" },
      { name: "docs", label: "文档", hint: "内置 How-to 与在线文档", aliases: ["howto", "guides"], needsArg: true },
      { name: "tutorial", label: "教程", hint: "上手导览", aliases: ["tour", "onboarding"] },
      { name: "release-notes", label: "更新说明", hint: "当前版本变更", aliases: ["changelog"] },
      { name: "feedback", label: "反馈", hint: "报告问题", needsArg: true },
      { name: "help", label: "帮助", hint: "列出可用命令" },
    ],
  },
  {
    group: "终端界面",
    items: [
      { name: "dashboard", label: "仪表盘", hint: "多会话看板", aliases: ["agents-dashboard", "sessions"] },
      { name: "history", label: "提示历史", hint: "搜索本会话提示词" },
      { name: "theme", label: "主题", hint: "切换颜色主题", aliases: ["t"] },
      { name: "timestamps", label: "时间戳", hint: "开关消息时间" },
      { name: "multiline", label: "多行输入", hint: "Enter 换行", aliases: ["ml"] },
      { name: "compact-mode", label: "紧凑显示", hint: "更密的排版" },
      { name: "vim-mode", label: "Vim 键位", hint: "滚动区 vim 快捷键" },
      { name: "edit-prompt", label: "外部编辑", hint: "用编辑器写提示" },
      { name: "minimal", label: "极简界面", hint: "切到 minimal 模式" },
      { name: "fullscreen", label: "全屏界面", hint: "切回 fullscreen", aliases: ["full"] },
      { name: "home", label: "欢迎页", hint: "离开当前会话", aliases: ["welcome"] },
    ],
  },
];

const QUICK_COMMANDS = [
  "compact",
  "rewind",
  "fork",
  "context",
  "usage",
  "memory",
  "skills",
  "mcps",
  "imagine",
  "loop",
  "workflow",
  "goal",
  "deep-research",
  "doctor",
];

function allCommands() {
  return GROK_COMMANDS.flatMap((g) => g.items.map((item) => ({ ...item, group: g.group })));
}

function findCommand(name) {
  const key = String(name || "").replace(/^\//, "").toLowerCase();
  return allCommands().find((c) => c.name === key || (c.aliases || []).includes(key));
}

function setConn(text, cls) {
  state.conn = text;
  if (cls === "bad" && text === "error") toast("连接出现问题");
}

let reconnectTimer = 0;
function connect({ force = false } = {}) {
  clearTimeout(reconnectTimer);
  if (!force && state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
  try {
    state.ws?.close();
  } catch {}
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => setConn("live", "ok");
  ws.onclose = () => {
    if (state.ws !== ws) return;
    setConn("offline", "bad");
    setBusy(false);
    reconnectTimer = setTimeout(() => connect(), 800);
  };
  ws.onerror = () => setConn("error", "bad");
  ws.onmessage = (ev) => onMsg(JSON.parse(ev.data));
}

function send(msg) {
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(msg));
}

function onMsg(msg) {
  switch (msg.type) {
    case "auth_required":
      location.replace("/?login=1");
      break;
    case "ready":
      hideGate();
      if (msg.user) {
        state.user = msg.user;
        paintAccount();
      }
      if (msg.provider) {
        state.provider = msg.provider;
        paintProviderForm();
      }
      consumeHomeStart();
      send({ type: "list_sessions" });
      if (queuedPrompt && state.sessionId) flushQueuedPrompt();
      {
        const pending = sessionStorage.getItem("pending-model-key");
        if (pending) {
          sessionStorage.removeItem("pending-model-key");
          send({ type: "model_key", value: pending });
          toast("已把刚才粘贴的 DeepSeek 密钥当作模型密钥保存，正在重连…");
        }
      }
      break;
    case "sessions":
      renderSessions(msg.sessions || []);
      restoreLastSession(msg.sessions || []);
      break;
    case "session":
      activateSession(msg.session);
      if (msg.action === "new") {
        clearTranscript("");
        send({ type: "list_sessions" });
      }
      if (msg.action === "load") {
        finalizeAgentReply();
        finishWorkingCards();
        state.previewDirty = true;
      }
      pushPermissionMode();
      send({ type: "list_dir", sessionId: msg.session.sessionId });
      send({ type: "list_versions", sessionId: msg.session.sessionId });
      flushQueuedPrompt();
      break;
    case "session_renamed":
      if (msg.sessionId === state.sessionId) paintSessionTitle(msg.title);
      send({ type: "list_sessions" });
      break;
    case "session_deleted":
      send({ type: "list_sessions" });
      if (msg.sessionId === state.sessionId) {
        state.sessionId = null;
        state.sessionTitle = "";
        paintSessionTitle("");
        resetWorkspaceUi();
        clearTranscript("");
        toast("已删除这个对话。");
      }
      break;
    case "update":
      if (msg.sessionId === state.sessionId) applyUpdate(msg.update);
      break;
    case "hint_file":
      if (msg.sessionId === state.sessionId && msg.path) {
        queueLivePreview(msg.path);
        queueListDir();
      }
      break;
    case "prompt_done":
      if (msg.gen != null && msg.gen !== state.gen) break;
      finalizeAgentReply();
      setBusy(false);
      state.previewDirty = true;
      state.revealPreview = true;
      if (state.sessionId) send({ type: "list_dir", sessionId: state.sessionId });
      send({ type: "list_sessions" });
      maybeRevealPreview();
      flushQueuedPrompt();
      break;
    case "cancelled":
      if (msg.gen != null && msg.gen !== state.gen) break;
      finalizeAgentReply();
      state.listening = false;
      state.pendingAgent = "";
      setBusy(false);
      state.revealPreview = false;
      flushQueuedPrompt();
      break;
    case "permission":
      autoOrShowPerm(msg);
      break;
    case "file_tree":
      if (msg.sessionId && msg.sessionId !== state.sessionId) break;
      renderTree(msg.entries || []);
      collectHtmlFiles(msg.entries || []);
      maybeLoadPlanFile(msg.entries || []);
      if (hasDockerfile(msg.entries || []) && state.runtime?.kind !== "app") {
        state.runtime = { kind: "app", status: "idle", sessionId: state.sessionId };
        send({ type: "ensure_runtime", sessionId: state.sessionId });
      }
      refreshPreviewIfNeeded();
      maybeTitleFromFiles();
      break;
    case "file":
      if (msg.sessionId && msg.sessionId !== state.sessionId) break;
      if (msg.silent) {
        if (/plan\.(md|json)$/i.test(msg.path || "")) ingestPlanMarkdown(msg.content || "");
        break;
      }
      showFile(msg);
      break;
    case "versions":
      ingestVersions(msg);
      break;
    case "version_saved":
      toast("已保存这一版");
      ingestVersions(msg);
      break;
    case "version_restored":
      toast("已切换到这一版");
      ingestVersions(msg);
      if (state.sessionId) send({ type: "list_dir", sessionId: state.sessionId });
      state.previewDirty = true;
      break;
    case "mode":
      if (["default", "ask", "plan"].includes(msg.modeId)) state.modeId = msg.modeId;
      renderModes();
      break;
    case "config":
      ingestConfig(msg.result);
      break;
    case "runtime":
      if (msg.sessionId && msg.sessionId !== state.sessionId) break;
      state.runtime = msg;
      if (msg.kind === "app" && msg.status === "building") {
        toast("正在启动应用…");
        showPreviewMessage("正在启动应用，第一次可能要等一会儿。");
      }
      if (msg.kind === "app" && msg.status === "ready") {
        loadAppPreview({ switchTab: false });
        maybeRevealPreview();
      }
      if (msg.kind === "app" && msg.status === "error") {
        showPreviewMessage(msg.message || "应用没启动起来。请确认 Docker Desktop 已打开。");
        toast(msg.message || "应用没启动起来。");
      }
      break;
    case "error":
      if (/invalid params/i.test(msg.message || "")) break;
      if (/auth/i.test(msg.message)) {
        toast("需要模型密钥。点左下角头像，在设置里填写 DeepSeek API Key。");
      } else if (msg.op === "read_file") {
        break;
      } else {
        toast(friendlyError(msg.message));
      }
      if (["prompt", "new_session", "set_mode", "set_config", "save_version", "restore_version", "delete_session", "fork_session"].includes(msg.op)) {
        setBusy(false);
        flushQueuedPrompt();
      }
      break;
  }
}

function consumeHomeStart() {
  let prompt = "";
  let mode = "";
  try {
    prompt = sessionStorage.getItem("sc-home-prompt") || "";
    mode = sessionStorage.getItem("sc-home-mode") || "";
    sessionStorage.removeItem("sc-home-prompt");
    sessionStorage.removeItem("sc-home-mode");
  } catch {
    /* ignore */
  }
  if (RUN_MODES.includes(mode)) applyRunMode(mode, { persist: true });
  if (!prompt) return;
  queuedPrompt = prompt;
  resetWorkspaceUi();
  clearTranscript("");
  send({ type: "new_session", model: state.model });
}

function showGate(err) {
  $("gate").classList.remove("hidden");
  $("gate").setAttribute("aria-hidden", "false");
  $("gate-error").textContent = err || "";
}
function hideGate() {
  $("gate").classList.add("hidden");
  $("gate").setAttribute("aria-hidden", "true");
}

function formatSessTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function sessBucket(iso) {
  const t = iso ? new Date(iso).getTime() : Date.now();
  if (Number.isNaN(t)) return "today";
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (t >= startToday) return "today";
  if (t >= startToday - 3 * day) return "three";
  if (t >= startToday - 7 * day) return "seven";
  return "older";
}

const SESS_GROUPS = [
  { id: "today", label: "今天" },
  { id: "three", label: "三天之内" },
  { id: "seven", label: "七天之内" },
  { id: "older", label: "更早" },
];

function renderSessions(sessions) {
  const box = $("session-list");
  box.replaceChildren();
  const groups = { today: [], three: [], seven: [], older: [] };
  for (const row of sessions) groups[sessBucket(row.updatedAt)].push(row);
  for (const group of SESS_GROUPS) {
    const rows = groups[group.id];
    if (!rows.length) continue;
    const head = document.createElement("div");
    head.className = "sess-group";
    head.textContent = group.label;
    box.append(head);
    for (const row of rows) {
      const id = row.sessionId;
      const wrap = document.createElement("div");
      wrap.dataset.id = id;
      wrap.className = `sess-row${id === state.sessionId ? " active" : ""}`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.id = id;
      btn.className = `sess${id === state.sessionId ? " active" : ""}`;
      btn.innerHTML = `<span class="t"></span><span class="m"></span>`;
      btn.querySelector(".t").textContent = prettyTitle(row);
      btn.querySelector(".m").textContent = formatSessTime(row.updatedAt);
      btn.onclick = () => {
        resetWorkspaceUi();
        state.sessionId = id;
        clearTranscript("");
        send({ type: "load_session", sessionId: id });
      };
      wrap.append(btn);
      const more = document.createElement("button");
      more.type = "button";
      more.className = "sess-more";
      more.title = "更多";
      more.setAttribute("aria-label", "更多");
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      more.innerHTML =
        '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>';
      more.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openSessMenu(more, id, prettyTitle(row));
      });
      wrap.append(more);
      box.append(wrap);
    }
  }
}

function closeSessMenu() {
  const menu = $("sess-menu");
  if (!menu) return;
  menu.classList.add("hidden");
  menu.setAttribute("aria-hidden", "true");
  for (const btn of document.querySelectorAll(".sess-more[aria-expanded='true']")) {
    btn.setAttribute("aria-expanded", "false");
  }
  state.sessMenuId = "";
  state.sessMenuTitle = "";
}

function openSessMenu(anchor, id, title) {
  const menu = $("sess-menu");
  if (!menu || !anchor) return;
  if (state.sessMenuId === id && !menu.classList.contains("hidden")) {
    closeSessMenu();
    return;
  }
  closeSessMenu();
  state.sessMenuId = id;
  state.sessMenuTitle = title;
  menu.classList.remove("hidden");
  menu.setAttribute("aria-hidden", "false");
  anchor.setAttribute("aria-expanded", "true");
  const box = anchor.getBoundingClientRect();
  const pad = 8;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let left = box.right - w;
  let top = box.bottom + 4;
  if (left < pad) left = pad;
  if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
  if (top + h > window.innerHeight - pad) top = Math.max(pad, box.top - h - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function beginListRename(id, currentTitle) {
  closeSessMenu();
  const row = document.querySelector(`.sess-row[data-id="${CSS.escape(id)}"]`);
  const titleEl = row?.querySelector(".t");
  if (!titleEl) return;
  if (row.querySelector(".sess-rename")) return;
  const input = document.createElement("input");
  input.className = "sess-rename";
  input.value = currentTitle || "";
  input.maxLength = TITLE_MAX;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const next = String(input.value || "").trim().slice(0, TITLE_MAX);
    if (commit && next && next !== currentTitle) {
      send({ type: "rename_session", sessionId: id, title: next });
      if (id === state.sessionId) paintSessionTitle(next);
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = next;
      input.replaceWith(t);
      return;
    }
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = currentTitle;
    input.replaceWith(t);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

let confirmWait = null;

function closeConfirm(result = false) {
  const layer = $("confirm");
  layer?.classList.add("hidden");
  layer?.setAttribute("aria-hidden", "true");
  const done = confirmWait;
  confirmWait = null;
  if (done) done(Boolean(result));
}

function confirmAction({ title = "请确认", copy = "", ok = "确定", cancel = "取消", danger = false } = {}) {
  closeConfirm(false);
  return new Promise((resolve) => {
    confirmWait = resolve;
    const layer = $("confirm");
    const titleEl = $("confirm-title");
    const copyEl = $("confirm-copy");
    const okBtn = $("confirm-ok");
    const cancelBtn = $("confirm-cancel");
    if (titleEl) titleEl.textContent = title;
    if (copyEl) copyEl.textContent = copy;
    if (cancelBtn) cancelBtn.textContent = cancel;
    if (okBtn) {
      okBtn.textContent = ok;
      okBtn.classList.toggle("danger", danger);
      okBtn.classList.toggle("primary", !danger);
    }
    layer?.classList.remove("hidden");
    layer?.setAttribute("aria-hidden", "false");
    (danger ? cancelBtn : okBtn)?.focus();
  });
}

function forkSession(id) {
  if (!id) return;
  send({ type: "fork_session", sessionId: id });
  toast("正在开分支…");
}

async function askDeleteSession(id, title) {
  if (!id) return;
  const label = title || "这个对话";
  const ok = await confirmAction({
    title: "删除对话",
    copy: `删除「${label}」？这个对话和工作区里的文件都会清掉，不能恢复。`,
    ok: "删除",
    danger: true,
  });
  if (!ok) return;
  send({ type: "delete_session", sessionId: id });
}

function resetWorkspaceUi() {
  state.previewPath = "";
  state.previewDirty = false;
  state.pendingPreview = "";
  state.htmlFiles = [];
  state.runtime = { kind: "static" };
  state.filePath = "";
  state.fileContent = "";
  state.planEntries = [];
  state.planMarkdown = "";
  state.saves = [];
  state.publishedSlug = "";
  $("project-actions")?.classList.add("hidden");
  state.saveHead = "";
  state.saveSelected = "";
  state.openTabs = [];
  paintPlan();
  renderSaves();
  paintTabs();
  $("file-tree")?.replaceChildren();
  paintBreadcrumb("");
  $("file-open-preview")?.classList.add("hidden");
  paintEditor({ path: "", content: "在左侧打开一个文件", binary: false });
  const filter = $("file-filter");
  if (filter) filter.value = "";
  state.fileFilter = "";
  state.treeEntries = [];
  state.collapsedDirs = new Set();
  state.workSteps = [];
  state.workStatus = "idle";
  state.studioLine = null;
  state.revealPreview = false;
  paintWorkBoard();
  clearPreview();
}

function paintPreviewChrome(rel, online) {
  const pathLabel = $("preview-path");
  const live = $("preview-live");
  const clean = String(rel || "").replaceAll("\\", "/");
  if (pathLabel) pathLabel.textContent = clean ? `${location.host} · ${clean}` : "未选择页面";
  live?.classList.toggle("on", Boolean(online));
}

const FRAME_SCROLL_CSS =
  "html,body,*{scrollbar-width:none!important;scrollbar-color:transparent transparent!important}*::-webkit-scrollbar,*::-webkit-scrollbar-button,*::-webkit-scrollbar-thumb,*::-webkit-scrollbar-track,*::-webkit-scrollbar-track-piece,*::-webkit-scrollbar-corner{display:none!important;width:0!important;height:0!important;background:transparent!important;border:none!important}";

function hideFrameScrollbars(frame) {
  try {
    const doc = frame?.contentDocument;
    if (!doc) return;
    let style = doc.getElementById("sc-hide-scroll");
    if (!style) {
      style = doc.createElement("style");
      style.id = "sc-hide-scroll";
      (doc.head || doc.documentElement).append(style);
    }
    style.textContent = FRAME_SCROLL_CSS;
  } catch {
    /* cross-origin preview */
  }
}

function bindPreviewFrame(frame) {
  if (!frame || frame.dataset.scrollBound === "1") return frame;
  frame.dataset.scrollBound = "1";
  frame.addEventListener("load", () => hideFrameScrollbars(frame));
  hideFrameScrollbars(frame);
  return frame;
}

function currentPreviewUrl() {
  if (state.runtime?.kind === "app" && state.runtime.port) return appPreviewUrl(state.runtime.port);
  if (state.previewPath && state.previewPath !== "__app__") {
    return new URL(workspaceUrl(state.previewPath), location.origin).href;
  }
  const src = $("preview-frame")?.src;
  return src && src !== "about:blank" ? src : "";
}

async function copyPreviewUrl() {
  const url = currentPreviewUrl();
  if (!url) {
    toast("还没有可复制的预览地址");
    return;
  }
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
    else throw new Error("no clipboard");
    toast("已复制预览地址");
  } catch {
    const input = document.createElement("textarea");
    input.value = url;
    input.setAttribute("readonly", "");
    input.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.append(input);
    input.select();
    const ok = document.execCommand("copy");
    input.remove();
    toast(ok ? "已复制预览地址" : "复制失败，请手动复制");
  }
}

function clearPreview() {
  state.previewPath = "";
  const frame = $("preview-frame");
  if (frame) {
    frame.removeAttribute("srcdoc");
    frame.src = "about:blank";
    frame.classList.add("hidden");
  }
  const fallback = $("preview-fallback");
  fallback?.classList.remove("hidden");
  const code = fallback?.querySelector("code");
  if (code) code.textContent = "这个对话还没有可预览的页面。";
  paintPreviewChrome("", false);
}

const TITLE_MAX = 40;

function isPlaceholderTitle(title) {
  const t = String(title || "").trim();
  if (!t) return true;
  if (/^(新对话|新会话|未命名对话|未命名|new session|untitled)$/i.test(t)) return true;
  if (/^[0-9a-f-]+$/i.test(t) && t.includes("-") && t.length >= 20) return true;
  return false;
}

function titleFromUserText(text) {
  let t = unwrapUserText(text)
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

function prettyTitle(row) {
  const t = String(row?.title || row?.summary || "").trim();
  if (isPlaceholderTitle(t) || (row?.sessionId && t === row.sessionId)) return "新对话";
  return t.slice(0, TITLE_MAX);
}

function lastSessionKey() {
  const id = state.user?.id;
  return id ? `sc:lastSession:${id}` : "";
}

function persistLastSession(id) {
  const key = lastSessionKey();
  if (key && id) localStorage.setItem(key, id);
}

function maybeTitleFromFiles() {
  if (!state.sessionId || !isPlaceholderTitle(state.sessionTitle)) return;
  const html = pickHtmlPreview();
  if (!html) return;
  const name = html.split("/").pop().replace(/\.html?$/i, "").trim();
  if (!name || /^index$/i.test(name) || isPlaceholderTitle(name)) return;
  const title = name.slice(0, TITLE_MAX);
  paintSessionTitle(title);
  send({ type: "rename_session", sessionId: state.sessionId, title });
}

function restoreLastSession(sessions) {
  if (state.sessionId || state.restoring || !sessions.length) return;
  const last = lastSessionKey() ? localStorage.getItem(lastSessionKey()) : "";
  const found = sessions.find((row) => row.sessionId === last) || sessions[0];
  if (!found?.sessionId) return;
  state.restoring = true;
  state.sessionId = found.sessionId;
  send({ type: "load_session", sessionId: found.sessionId });
}

function paintSessionTitle(title) {
  const label = prettyTitle({ title: title || state.sessionTitle || "新对话" });
  state.sessionTitle = label;
  const h1 = $("session-title");
  if (h1) h1.textContent = label;
  const editing = document.activeElement === $("session-title-input");
  const btn = $("session-title-btn");
  if (btn) {
    btn.textContent = state.sessionId ? label : "未命名对话";
    btn.disabled = !state.sessionId;
    btn.title = state.sessionId ? label : "";
    btn.classList.toggle("hidden", editing);
  }
  const input = $("session-title-input");
  if (input && !editing) {
    input.value = state.sessionId ? label : "";
    input.disabled = !state.sessionId;
    input.classList.add("hidden");
  }
}

function beginTitleEdit() {
  if (!state.sessionId) return;
  const btn = $("session-title-btn");
  const input = $("session-title-input");
  if (!input) return;
  btn?.classList.add("hidden");
  input.classList.remove("hidden");
  input.disabled = false;
  input.value = state.sessionTitle.slice(0, TITLE_MAX);
  input.focus();
  input.select();
}

function commitSessionTitle(raw) {
  const title = String(raw || "").trim().slice(0, TITLE_MAX);
  $("session-title-input")?.classList.add("hidden");
  $("session-title-btn")?.classList.remove("hidden");
  if (!state.sessionId || !title) {
    paintSessionTitle(state.sessionTitle);
    return;
  }
  if (title === state.sessionTitle) {
    paintSessionTitle(title);
    return;
  }
  paintSessionTitle(title);
  send({ type: "rename_session", sessionId: state.sessionId, title });
  for (const el of document.querySelectorAll(".sess-row, .sess")) {
    if (el.dataset.id === state.sessionId) {
      const t = el.querySelector(".t");
      if (t) t.textContent = title;
    }
  }
}

function activateSession(session) {
  if (state.sessionId !== session.sessionId) resetWorkspaceUi();
  state.sessionId = session.sessionId;
  state.restoring = false;
  persistLastSession(session.sessionId);
  state.publishedSlug = session.publishedSlug || state.publishedSlug || "";
  paintSessionTitle(session.title || "新对话");
  updateSessionMeta();
  $("project-actions")?.classList.remove("hidden");
  for (const el of document.querySelectorAll(".sess-row, .sess")) {
    el.classList.toggle("active", el.dataset.id === session.sessionId);
  }
  ingestModes(session.modes);
  ingestConfig(session.configOptions || session);
}

function ingestModes(modes) {
  const current = modes?.currentModeId || modes?.currentMode?.id;
  if (current) state.modeId = String(current);
  renderModes();
}

function ingestConfig(payload) {
  const options = Array.isArray(payload) ? payload : payload?.configOptions || payload?.options || [];
  const model = options.find((o) => o.configId === "model" || o.id === "model");
  fillSelect($("model-select"), DEFAULT_MODELS, "模型");
  const modelValue = unwrap(model?.currentValue || model?.value);
  applyModel(pickClientModel(modelValue || state.model), {
    persist: true,
    send: false,
  });
  updateComposerChrome();
}

function unwrap(value) {
  if (value && typeof value === "object" && "value" in value) return value.value;
  return value;
}

function fillSelect(el, values, placeholder) {
  const keep = el.value || (el.id === "model-select" ? state.model : "");
  el.replaceChildren();
  const first = document.createElement("option");
  first.value = "";
  first.textContent = placeholder;
  el.append(first);
  for (const value of values) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    el.append(opt);
  }
  const pick = keep && values.includes(keep) ? keep : values[0] || "";
  if (pick) el.value = pick;
}

function applyModel(value, { persist = true, send: push = true } = {}) {
  const model = pickClientModel(value);
  state.model = model;
  if ($("model-select")) $("model-select").value = model;
  if (persist) persistPref("super-coding-model", model);
  updateComposerChrome();
  if (push && state.sessionId) {
    send({ type: "set_config", sessionId: state.sessionId, configId: "model", value: model });
  }
}

function applyEffort(value, { persist = true, send: push = true } = {}) {
  const effort = String(value || "").trim();
  if (!EFFORT_STEPS.some((s) => s.value === effort)) return;
  state.effort = effort;
  if ($("effort-select")) $("effort-select").value = effort;
  if (persist) persistPref("super-coding-effort", effort);
  updateComposerChrome();
  if (push && state.sessionId) {
    send({ type: "set_config", sessionId: state.sessionId, configId: "reasoning_effort", value: effort });
  }
}

function modeLabel(id) {
  return MODES.find((m) => m.id === id)?.label || id || "默认";
}

const EFFORT_STEPS = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
];

const PERM_LABELS = {
  confirm: "每次确认",
  auto: "自动放行",
  yolo: "完全访问",
};

const AGENT_LABELS = {
  default: "默认",
  ask: "询问",
  plan: "计划",
};

let slashActiveIndex = 0;

function closeComposerPops() {
  for (const id of ["attach-pop", "model-pop", "agent-pop", "run-mode-pop"]) {
    $(id)?.classList.add("hidden");
  }
  setModelPopView("home");
  $("attach-btn")?.setAttribute("aria-expanded", "false");
  $("model-effort-btn")?.setAttribute("aria-expanded", "false");
  $("run-mode-btn")?.setAttribute("aria-expanded", "false");
}

function setModelPopView(view) {
  const home = $("model-view-home");
  const picker = $("model-view-picker");
  if (!home || !picker) return;
  const pick = view === "picker";
  home.classList.toggle("hidden", pick);
  picker.classList.toggle("hidden", !pick);
  picker.hidden = !pick;
}

function toggleComposerPop(id, anchor) {
  const el = $(id);
  if (!el) return;
  const willOpen = el.classList.contains("hidden");
  closeComposerPops();
  if (willOpen) {
    el.classList.remove("hidden");
    anchor?.setAttribute("aria-expanded", "true");
    if (id === "model-pop") setModelPopView("home");
  }
}

function effortIndex(value) {
  const i = EFFORT_STEPS.findIndex((s) => s.value === value);
  return i >= 0 ? i : 1;
}

function syncEffortSlider() {
  const slider = $("effort-slider");
  if (!slider) return;
  const idx = effortIndex(state.effort || $("effort-select")?.value || "medium");
  slider.value = String(idx);
  const pct = idx === 0 ? 0 : idx === 1 ? 33 : idx === 2 ? 66 : 100;
  slider.style.setProperty("--effort-pct", `${pct}%`);
  const effortLinkLabel = $("effort-link-label");
  if (effortLinkLabel) effortLinkLabel.textContent = EFFORT_STEPS[idx]?.label || "中";
}

function rebuildModelList() {
  const list = $("model-list");
  if (!list) return;
  list.replaceChildren();
  const current = pickClientModel(state.model);
  for (const id of DEFAULT_MODELS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `pop-row${id === current ? " on" : ""}`;
    const check = id === current ? '<span class="check">✓</span>' : "";
    btn.innerHTML = `<span></span>${check}`;
    btn.querySelector("span").textContent = id;
    btn.onclick = () => {
      applyModel(id);
      setModelPopView("home");
    };
    list.append(btn);
  }
  const modelPopName = $("model-pop-name");
  if (modelPopName) modelPopName.textContent = current || DEFAULT_MODELS[0];
}

function updateComposerChrome() {
  const model = state.model || $("model-select")?.value || "";
  const effortIdx = effortIndex(state.effort || $("effort-select")?.value || "medium");
  const effortLabel = EFFORT_STEPS[effortIdx]?.label || "中";
  const nameLabel = $("model-name-label");
  const effortChip = $("model-effort-label");
  if (nameLabel) nameLabel.textContent = model || "选择模型";
  if (effortChip) effortChip.textContent = model ? effortLabel : "";
  const agentModeSummary = $("agent-mode-summary");
  if (agentModeSummary) agentModeSummary.textContent = AGENT_LABELS[state.modeId] || "默认";
  for (const btn of document.querySelectorAll(".mode-opt")) {
    btn.classList.toggle("on", btn.dataset.mode === state.modeId);
  }
  syncEffortSlider();
  rebuildModelList();
  updateSessionMeta();
}

function initComposerUi() {
  $("attach-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleComposerPop("attach-pop", $("attach-btn"));
  });
  $("model-effort-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleComposerPop("model-pop", $("model-effort-btn"));
  });
  $("run-mode-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleComposerPop("run-mode-pop", $("run-mode-btn"));
  });
  $("model-picker-open")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setModelPopView("picker");
    rebuildModelList();
  });
  $("model-picker-back")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setModelPopView("home");
  });
  $("agent-mode-trigger")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeComposerPops();
    $("agent-pop")?.classList.remove("hidden");
  });
  $("open-palette-inline")?.addEventListener("click", () => {
    closeComposerPops();
    openPalette();
  });
  $("effort-slider")?.addEventListener("input", (e) => {
    const idx = Number(e.target.value);
    const step = EFFORT_STEPS[idx];
    if (!step) return;
    $("effort-select").value = step.value;
    applyEffort(step.value);
  });
  for (const btn of document.querySelectorAll(".mode-opt")) {
    btn.addEventListener("click", () => {
      $("agent-mode-select").value = btn.dataset.mode;
      applyAgentMode(btn.dataset.mode);
      closeComposerPops();
    });
  }
  for (const btn of document.querySelectorAll(".run-mode-opt")) {
    btn.addEventListener("click", () => {
      applyRunMode(btn.dataset.runMode);
      closeComposerPops();
    });
  }
  document.addEventListener("click", (e) => {
    const popOpen = ["attach-pop", "model-pop", "agent-pop", "run-mode-pop"].some(
      (id) => !$(id)?.classList.contains("hidden")
    );
    if (!popOpen) return;
    if (e.target.closest(".composer-pop")) return;
    if (e.target.closest("#attach-btn, #model-effort-btn, #agent-mode-trigger, #run-mode-btn")) return;
    closeComposerPops();
  });
}

function syncComposerControls() {
  const agent = $("agent-mode-select");
  const perm = $("permission-select");
  if (agent && ["default", "ask", "plan"].includes(state.modeId)) {
    agent.value = state.modeId;
  }
  if (perm) perm.value = state.permissionMode;
  updateComposerChrome();
}

function renderModes() {
  syncComposerControls();
}

function applyAgentMode(modeId) {
  if (!["default", "ask", "plan"].includes(modeId)) return;
  state.modeId = modeId;
  syncComposerControls();
  if (!state.sessionId) return;
  send({ type: "set_mode", sessionId: state.sessionId, modeId });
}

function applyPermissionMode(_next) {
  state.permissionMode = "yolo";
  persistPermMode("yolo");
  syncComposerControls();
  pushPermissionMode();
}

function pushPermissionMode() {
  if (!state.sessionId) return;
  send({ type: "set_permission", sessionId: state.sessionId, mode: "yolo" });
}

function updateSessionMeta() {
  const meta = $("session-meta");
  if (!meta) return;
  const perm =
    state.permissionMode === "auto"
      ? "自动权限"
      : state.permissionMode === "yolo"
        ? "全放行"
        : "确认权限";
  meta.textContent = `${modeLabel(state.modeId)} · ${perm}${state.model ? " · " + state.model : ""}`;
}

function updateWelcomeVisibility() {
  const welcome = $("welcome");
  const hasChat = $("transcript").children.length > 0;
  if (welcome) welcome.classList.toggle("hidden", hasChat);
  $("stage")?.classList.toggle("has-chat", hasChat);
}

function initWelcome() {
  const title = $("welcome-title");
  if (title) title.textContent = "我们应该在 Super Coding 中做些什么？";
}

function noteUserTurn(el, text) {
  if (!el || el.dataset.turnRegistered) return;
  el.dataset.turnRegistered = "1";
  const preview = unwrapUserText(String(text || "")).trim().replace(/\s+/g, " ").slice(0, 160) || "提问";
  state.turns.push({ el, preview });
  $("jump-rail")?.classList.remove("hidden");
  syncJumpRail();
}

function syncJumpRail() {
  const rail = $("jump-rail");
  if (!rail) return;
  rail.replaceChildren();
  const turns = state.turns.filter((turn) => turn.el?.isConnected);
  const visible = turns.length;
  turns.forEach((turn, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "jump-mark";
    btn.setAttribute("aria-label", `跳转到：${turn.preview}`);
    const tip = document.createElement("span");
    tip.className = "jump-tip";
    tip.textContent = turn.preview;
    btn.append(tip);
    btn.onclick = () => {
      turn.el.scrollIntoView({ behavior: "smooth", block: "center" });
      paintJumpClasses(i);
    };
    rail.append(btn);
  });
  rail.classList.toggle("hidden", visible === 0);
  rail.classList.toggle("dense", visible > 10);
  if (visible) {
    const gap = visible > 24 ? 1 : visible > 16 ? 2 : visible > 10 ? 4 : visible > 6 ? 6 : 8;
    rail.style.gap = `${gap}px`;
    const h = rail.offsetHeight;
    rail.style.top = `max(16px, calc(50% - ${Math.round(h / 2)}px))`;
    paintJumpActive();
  }
}

function paintJumpClasses(activeIndex) {
  const marks = [...($("jump-rail")?.querySelectorAll(".jump-mark") || [])];
  marks.forEach((mark, i) => {
    mark.classList.toggle("active", i === activeIndex);
    mark.classList.toggle("near", i === activeIndex - 1 || i === activeIndex + 1);
  });
}

function paintJumpActive() {
  const scroller = $("chat-scroller");
  const turns = state.turns.filter((turn) => turn.el?.isConnected);
  if (!scroller || !turns.length) return;
  const box = scroller.getBoundingClientRect();
  const mid = box.top + box.height * 0.42;
  let best = 0;
  let bestDist = Infinity;
  turns.forEach((turn, i) => {
    const rect = turn.el.getBoundingClientRect();
    const dist = Math.abs(rect.top + rect.height / 2 - mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  paintJumpClasses(best);
}

function setPanelOpen(open) {
  const body = $("workspace-body");
  body?.classList.toggle("panel-closed", !open);
  if (open) $("panel-body")?.classList.remove("hidden");
  state.panelOpen = Boolean(open);
  const toggle = $("toggle-panel");
  toggle?.setAttribute("aria-expanded", open ? "true" : "false");
  toggle?.setAttribute("title", open ? "收起预览栏" : "打开预览栏");
  toggle?.setAttribute("aria-label", open ? "收起预览栏" : "打开预览栏");
}

function openSidePanel() {
  setPanelOpen(true);
}

function setBoardOpen(open, { user = false } = {}) {
  if (user) state.boardUserClosed = !open;
  state.boardOpen = Boolean(open);
  $("workspace-body")?.classList.toggle("board-closed", !open);
  const toggle = $("toggle-board");
  toggle?.setAttribute("aria-expanded", open ? "true" : "false");
  toggle?.setAttribute("title", open ? "收起工作台" : "打开工作台");
  toggle?.setAttribute("aria-label", open ? "收起工作台" : "打开工作台");
}

const FACTORY_LINES = [
  { id: 0, floor: "一层", name: "产线甲", role: "界面", hint: "页面、样式、交互" },
  { id: 1, floor: "二层", name: "产线乙", role: "系统", hint: "接口、数据、容器" },
  { id: 2, floor: "三层", name: "产线丙", role: "验收", hint: "运行、检查、收口" },
];

const MULTI_ROLES = [
  { id: 0, name: "主 Agent", role: "分工与整合" },
  { id: 1, name: "调研子 Agent", role: "读代码、搜资料" },
  { id: 2, name: "实现子 Agent", role: "改文件、写功能" },
  { id: 3, name: "验收子 Agent", role: "跑命令、核对结果" },
];

function stepDone(step) {
  return /complete|completed|done/i.test(step?.status || "");
}

function stepFail(step) {
  return /fail|error/i.test(step?.status || "");
}

function stepLive(step) {
  return !stepDone(step) && !stepFail(step) && state.workStatus === "running";
}

function stepsInLane(lane) {
  return state.workSteps.filter((s) => s.lane === lane);
}

function assignWorkLane(kind, title) {
  const blob = `${kind} ${title}`.toLowerCase();
  if (state.runMode === "single") return 0;
  if (state.runMode === "factory") {
    if (/\.(html?|css|scss|less|jsx|tsx|vue|svg)\b|frontend|界面|样式/.test(blob)) return 0;
    if (/\.(py|go|rs|java|php|sql)\b|server|docker|api|database|后端|数据/.test(blob)) return 1;
    if (/bash|exec|terminal|shell|command|test|lint/.test(blob)) return 2;
    return state.workSteps.filter((s) => s.kind !== "lead").length % 3;
  }
  if (/read|search|grep|glob|list/.test(blob)) return 1;
  if (/bash|exec|terminal|shell|command|test/.test(blob)) return 3;
  return 2;
}

function workFileHint(update, title) {
  const loc = update?.locations?.[0]?.path || update?.path || "";
  if (loc) return String(loc).replaceAll("\\", "/");
  const m = String(title || "").match(/[\w./\\-]+\.[a-z0-9]{1,8}/i);
  return m ? m[0].replaceAll("\\", "/") : "";
}

function recordWorkStep(update) {
  const id = String(update.toolCallId || "");
  if (!id) return;
  let step = state.workSteps.find((s) => s.id === id);
  const kind = update.kind || step?.kind || "tool";
  const title = update.title || step?.title || "";
  if (!step) {
    step = {
      id,
      kind,
      title,
      status: update.status || "in_progress",
      label: toolCardLabel(kind, title, update.status || ""),
      lane: assignWorkLane(kind, title),
      file: workFileHint(update, title),
    };
    state.workSteps.push(step);
  } else {
    if (update.kind) step.kind = update.kind;
    if (update.title) step.title = update.title;
    if (update.status) step.status = update.status;
    step.label = toolCardLabel(step.kind, step.title, step.status);
    const file = workFileHint(update, step.title);
    if (file) step.file = file;
  }
  paintWorkBoard();
}

function beginWorkRun() {
  state.workSteps = [];
  state.studioLine = null;
  state.workStatus = "running";
  state.workStarted = Date.now();
  state.boardUserClosed = false;
  if (state.runMode === "multi") {
    state.workSteps.push({
      id: "lead-split",
      kind: "lead",
      title: "拆任务",
      status: "in_progress",
      label: "正在把任务分给子 Agent",
      lane: 0,
      file: "",
    });
  }
  setBoardOpen(true);
  paintWorkBoard();
}

function deliveryLabel() {
  const files = [...new Set(state.workSteps.map((s) => s.file).filter(Boolean))];
  if (state.previewPath && state.previewPath !== "__app__") return `已交付预览 · ${state.previewPath}`;
  if (state.runtime?.kind === "app" && state.runtime.status === "ready") return "已交付可运行的应用";
  if (files.length) return `本轮产出 ${files.length} 个文件`;
  return "本轮工作已收口";
}

function endWorkRun() {
  if (state.workStatus !== "running") {
    paintWorkBoard();
    return;
  }
  state.workStatus = "done";
  for (const step of state.workSteps) {
    if (!stepDone(step) && !stepFail(step)) step.status = "completed";
  }
  if (state.runMode === "multi") {
    const lead = state.workSteps.find((s) => s.id === "lead-split");
    if (lead) {
      lead.status = "completed";
      lead.label = "子 Agent 结果已收回";
    }
    state.workSteps.push({
      id: "lead-ship",
      kind: "lead",
      title: "交付",
      status: "completed",
      label: deliveryLabel(),
      lane: 0,
      file: state.previewPath && state.previewPath !== "__app__" ? state.previewPath : "",
    });
  }
  paintWorkBoard();
}

function boardNowText() {
  const live = state.workSteps.find((s) => stepLive(s) && s.kind !== "lead");
  if (state.workStatus === "running") return live?.label || "正在拆解任务";
  if (state.workStatus === "done") return deliveryLabel();
  return "还没有开始这一轮";
}

function paintMeter(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `<div class="board-meter"><div class="board-meter-track"><div class="board-meter-fill${state.workStatus === "running" ? " live" : ""}" style="width:${pct}%"></div></div><span class="board-meter-n">${done}/${total || 0}</span></div>`;
}

function paintStepList(steps) {
  if (!steps.length) return `<p class="board-empty">这一侧还没有动作。</p>`;
  return `<ol class="board-steps">${steps
    .map((s) => {
      const cls = stepFail(s) ? "fail" : stepDone(s) ? "done" : stepLive(s) ? "live" : "";
      const file = s.file ? `<span class="file">${escapeHtml(s.file)}</span>` : "";
      return `<li class="board-step ${cls}"><span class="dot"></span><span>${escapeHtml(s.label || s.title)}${file}</span></li>`;
    })
    .join("")}</ol>`;
}

function paintShip() {
  const files = [...new Set(state.workSteps.map((s) => s.file).filter(Boolean))];
  if (!files.length && state.workStatus !== "done") return "";
  const body = files.length ? files.map((f) => escapeHtml(f)).join("、") : deliveryLabel();
  return `<div class="board-ship"><b>成果</b>${body}</div>`;
}

function paintSingleBoard() {
  const real = state.workSteps.filter((s) => s.kind !== "lead");
  const done = real.filter((s) => stepDone(s) || stepFail(s)).length;
  return `${paintMeter(done, real.length)}<p class="board-now">${escapeHtml(boardNowText())}</p>${paintStepList(real)}${paintShip()}`;
}

function laneStatus(steps) {
  if (steps.some(stepLive)) return "进行中";
  if (steps.length && steps.every((s) => stepDone(s) || stepFail(s))) return "已完成";
  if (state.workStatus === "running") return "待命";
  return steps.length ? "已完成" : "空闲";
}

function paintMultiBoard() {
  const lead = stepsInLane(0);
  const leadText = lead.at(-1)?.label || "等待主 Agent 分工";
  const cards = MULTI_ROLES.slice(1)
    .map((role) => {
      const steps = stepsInLane(role.id);
      const live = steps.some(stepLive);
      return `<article class="multi-card${live ? " live" : ""}"><header><h3>${role.name}</h3><span class="st">${laneStatus(steps)}</span></header><p class="board-empty" style="margin:0">${escapeHtml(role.role)}</p>${paintStepList(steps)}</article>`;
    })
    .join("");
  return `<section class="multi-lead"><strong>主 Agent</strong><p>${escapeHtml(leadText)}</p></section><div class="multi-subs">${cards}</div>${paintShip()}`;
}

function paintFactoryOverview() {
  const floors = FACTORY_LINES.map((line) => {
    const steps = stepsInLane(line.id);
    const live = steps.some(stepLive);
    const doneN = steps.filter((s) => stepDone(s) || stepFail(s)).length;
    const desks = [0, 1, 2, 3]
      .map((i) => {
        const cls = live && i === 0 ? "busy" : doneN > i ? "done" : "";
        return `<span class="studio-desk ${cls}"></span>`;
      })
      .join("");
    return `<button type="button" class="studio-floor${live ? " live" : ""}${!live && steps.length && doneN === steps.length ? " done" : ""}" data-studio-line="${line.id}"><span class="fl">${line.floor}</span><span class="nm">${line.name}</span><span class="role">${line.role} · ${laneStatus(steps)}</span><span class="studio-desks">${desks}</span></button>`;
  }).join("");
  return `<p class="studio-note">厂长指令：三条线并行。点进某一层，看他们正在做什么。</p><div class="studio-stack">${floors}</div>${paintShip()}`;
}

function paintFactoryLine(id) {
  const line = FACTORY_LINES[id];
  if (!line) return paintFactoryOverview();
  const steps = stepsInLane(id);
  return `<button type="button" class="studio-back" data-studio-back="1">← 回到工作室</button><p class="board-now">${escapeHtml(line.floor)} · ${escapeHtml(line.name)} · ${escapeHtml(line.hint)}</p>${paintStepList(steps)}${paintShip()}`;
}

function paintWorkBoard() {
  const kicker = $("board-kicker");
  const title = $("board-title");
  const body = $("board-body");
  if (kicker) kicker.textContent = RUN_MODE_LABELS[state.runMode] || "单 Agent";
  if (title) {
    title.textContent =
      state.runMode === "factory" ? (state.studioLine == null ? "2D 工作室" : FACTORY_LINES[state.studioLine]?.name || "产线") : "工作状态";
  }
  if (!body) return;
  if (!state.workSteps.length && state.workStatus !== "running") {
    if (state.runMode === "factory" && state.studioLine != null) {
      body.innerHTML = paintFactoryLine(state.studioLine);
      return;
    }
    const idle =
      state.runMode === "factory"
        ? "三层产线已就绪。发出任务后，可以点进每一层看他们在做什么。"
        : state.runMode === "multi"
          ? "主 Agent 会在这里拆任务，子 Agent 的进度和最终整合也会落在这。"
          : "发出任务后，这里会跟着走：现在做到哪一步、进度如何。";
    body.innerHTML = `<p class="board-idle">${idle}</p>${state.runMode === "factory" ? paintFactoryOverview() : ""}`;
    return;
  }
  if (state.runMode === "factory") {
    body.innerHTML = state.studioLine == null ? paintFactoryOverview() : paintFactoryLine(state.studioLine);
    return;
  }
  body.innerHTML = state.runMode === "multi" ? paintMultiBoard() : paintSingleBoard();
}

function hasPreviewable() {
  if (state.runtime?.kind === "app" && state.runtime.status === "ready" && state.runtime.port) return true;
  const frame = $("preview-frame");
  if (frame && !frame.classList.contains("hidden") && frame.src && frame.src !== "about:blank") return true;
  return Boolean((state.htmlFiles || []).length);
}

function maybeRevealPreview() {
  if (state.busy || !state.revealPreview) return;
  if (!hasPreviewable()) return;
  state.revealPreview = false;
  setTab("preview");
}

function renderToolbar() {
  const bar = $("toolbar");
  bar.replaceChildren();
  const shortcuts = [
    { label: "会话摘要", run: () => sendPrompt("帮我总结当前会话要点") },
    { label: "报错修复", run: () => sendPrompt("检查沙箱项目里可能的报错并修复") },
  ];
  for (const item of shortcuts) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = item.label;
    btn.onclick = item.run;
    bar.append(btn);
  }
  for (const name of QUICK_COMMANDS) {
    const cmd = findCommand(name);
    if (!cmd) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = cmd.label;
    btn.title = `/${cmd.name}  ${cmd.hint}`;
    btn.onclick = () => runCommand(cmd);
    bar.append(btn);
  }
}

function workGroupSteps(group) {
  return [...(group?.querySelectorAll(".tool, .bubble.thought") || [])];
}

function closeWorkGroup() {
  const group = state.workGroup;
  if (!group || group.dataset.closed) {
    state.workGroup = null;
    return;
  }
  for (const el of workGroupSteps(group)) {
    if (el.classList.contains("thought") && !(el.querySelector(".body")?.dataset.raw || "").trim()) {
      el.remove();
    }
  }
  const n = workGroupSteps(group).length;
  if (!n) {
    group.remove();
    state.workGroup = null;
    return;
  }
  group.dataset.closed = "1";
  group.open = false;
  group.classList.add("done");
  const label = group.querySelector(".work-label");
  if (label) label.textContent = `已完成 · ${n} 步`;
  state.workGroup = null;
}

function updateWorkGroupLabel(group) {
  if (!group || group.dataset.closed) return;
  const n = workGroupSteps(group).length;
  const label = group.querySelector(".work-label");
  if (!label) return;
  const copy = WORKING_COPY[workingTick % WORKING_COPY.length];
  label.textContent = n > 1 ? `${copy} · ${n} 步` : copy;
}

function unwrapUserText(text) {
  return String(text || "")
    .replace(/【强制语言】[\s\S]*?(?:现在可以怎么用。)/gu, "")
    .replace(/^【强制语言】[^\n]*\n+/u, "")
    .replace(/请用简体中文回复，面向完全没有编程基础的用户：先说结论和现在的进度，少用术语，必要的文件名和代码可以保留英文。不要写大段英文说明。\s*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ensureWorkGroup() {
  let group = state.workGroup;
  if (group?.isConnected && !group.dataset.closed) return group;
  group = document.createElement("details");
  group.className = "work-group";
  group.innerHTML = `<summary class="work-summary"><span class="thought-pulse" aria-hidden="true"></span><span class="work-label">正在工作</span></summary><div class="work-body"></div>`;
  const lastUser = [...$("transcript").querySelectorAll(":scope > .bubble.user")].at(-1);
  if (lastUser) lastUser.after(group);
  else $("transcript").append(group);
  updateWelcomeVisibility();
  state.workGroup = group;
  return group;
}

function clearTranscript(note) {
  state.bubbles.clear();
  state.tools.clear();
  state.workGroup = null;
  state.turns = [];
  $("transcript").replaceChildren();
  $("jump-rail")?.classList.add("hidden");
  $("jump-rail")?.replaceChildren();
  updateWelcomeVisibility();
  if (note) addBubble("agent", note);
}

function addBubble(role, text) {
  if (role === "user") {
    closeWorkGroup();
    text = unwrapUserText(text);
  }
  const el = document.createElement(role === "thought" ? "details" : "article");
  el.className = `bubble ${role}`;
  if (role === "thought") {
    el.innerHTML = `<summary class="thought-summary"><span class="thought-label">思考过程</span></summary><div class="body"></div>`;
  } else {
    el.innerHTML = `<div class="body"></div>`;
  }
  const body = el.querySelector(".body");
  if (text) {
    body.dataset.raw = text;
    body.innerHTML = renderMd(text);
  } else {
    body.dataset.raw = "";
  }
  if (role === "thought") {
    ensureWorkGroup().querySelector(".work-body").append(el);
    updateWorkGroupLabel(state.workGroup);
  } else {
    $("transcript").append(el);
  }
  updateWelcomeVisibility();
  if (role === "user") noteUserTurn(el, text);
  requestAnimationFrame(syncJumpRail);
  const scroller = role === "thought" ? state.workGroup : el;
  scroller?.scrollIntoView({ block: "end", behavior: "smooth" });
  return el;
}

function appendText(role, chunk) {
  const key = role;
  let el = state.bubbles.get(key);
  if (!el || el.dataset.closed) {
    el = addBubble(role, "");
    state.bubbles.set(key, el);
  }
  const body = el.querySelector(".body");
  body.dataset.raw = (body.dataset.raw || "") + chunk;
  if (role === "user") body.dataset.raw = unwrapUserText(body.dataset.raw);
  body.innerHTML = renderMd(body.dataset.raw);
  if (role === "user") {
    const turn = state.turns.find((t) => t.el === el);
    const preview = body.dataset.raw.trim().replace(/\s+/g, " ").slice(0, 160) || "提问";
    if (turn) turn.preview = preview;
    else noteUserTurn(el, body.dataset.raw);
    requestAnimationFrame(syncJumpRail);
  }
  if (role !== "thought" || el.open) el.scrollIntoView({ block: "end" });
}

function ensureWorkingCard() {
  let el = state.bubbles.get("thought");
  if (el && !el.dataset.closed) return el;
  el = addBubble("thought", "");
  state.bubbles.set("thought", el);
  return el;
}

function applyWorkingCopy() {
  const el = state.bubbles.get("thought");
  const label = el?.querySelector(".thought-label");
  if (label && !el.classList.contains("done")) {
    label.textContent = WORKING_COPY[workingTick % WORKING_COPY.length];
  }
  updateWorkGroupLabel(state.workGroup);
}

function startWorkingCopy() {
  stopWorkingCopy();
  workingTick = 0;
  ensureWorkGroup();
  applyWorkingCopy();
  workingTimer = window.setInterval(() => {
    workingTick += 1;
    applyWorkingCopy();
  }, 2800);
}

function stopWorkingCopy() {
  if (workingTimer) {
    window.clearInterval(workingTimer);
    workingTimer = 0;
  }
}

function finishWorkingCards() {
  stopWorkingCopy();
  for (const el of document.querySelectorAll(".bubble.thought:not(.done)")) {
    el.classList.add("done");
    el.dataset.closed = "1";
    const label = el.querySelector(".thought-label");
    if (label) label.textContent = "思考过程";
  }
  state.bubbles.delete("thought");
  closeWorkGroup();
}

function isUserFacingReply(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t.length > 160) return false;
  if (/我先看|现在写|校验脚本|发现了两点|先改脚本|真实缺陷|接下来/.test(t)) return false;
  if (/\b(I'll|I will|Let me|Now I'll|I'm going to|I need to|The file is|PowerShell doesn't|Still \d+ pass)\b/i.test(t)) {
    return false;
  }
  return (t.match(/[\u4e00-\u9fff]/g) || []).length >= 8;
}

function summarizeTurn(pending) {
  if (isUserFacingReply(pending)) return pending.trim();
  const bits = [];
  for (const card of state.tools.values()) {
    const title = String(card.dataset.title || "");
    const kind = String(card.dataset.kind || "").toLowerCase();
    const failed = card.classList.contains("failed");
    const name = title.replace(/^(Read|Write|Edit|Update|Create|Run|Bash|Shell|Execute)\s+/i, "").split(/[\s(]/)[0];
    if (failed) bits.push(name ? `${name} 没做成` : "有一步没做成");
    else if (/write|edit|create/.test(kind) || /^(write|edit|create)/i.test(title)) {
      bits.push(name ? `写好了 ${name}` : "改好了文件");
    } else if (/bash|exec|shell|terminal|command/.test(kind) || /^(run|exec|bash)/i.test(title)) {
      bits.push("跑过检查");
    }
  }
  const unique = [...new Set(bits)].slice(0, 4);
  if (unique.length) return `已经处理好了：${unique.join("，")}。`;
  return "这件事已经做完了。";
}

function finalizeAgentReply() {
  const pending = state.pendingAgent || "";
  state.pendingAgent = "";
  const text = summarizeTurn(pending);
  const el = state.bubbles.get("agent");
  if (!text) {
    if (el && !(el.querySelector(".body")?.dataset.raw || "").trim()) el.remove();
    state.bubbles.delete("agent");
    return;
  }
  if (el) {
    const body = el.querySelector(".body");
    body.dataset.raw = text;
    body.innerHTML = renderMd(text);
    el.scrollIntoView({ block: "end" });
  } else {
    addBubble("agent", text);
  }
  state.bubbles.delete("agent");
}

function applyUpdate(update) {
  if (!update) return;
  const kind = update.sessionUpdate;
  if (kind === "user_message_chunk") {
    const text = unwrapUserText(update.content?.text || "");
    if (!text) return;
    const last = [...document.querySelectorAll("#transcript > .bubble.user")].at(-1);
    const existing = unwrapUserText(last?.querySelector(".body")?.dataset.raw || "");
    if (existing && (text === existing || existing.includes(text) || text.includes(existing))) return;
    appendText("user", text);
  } else if (kind === "agent_message_chunk") {
    state.pendingAgent = (state.pendingAgent || "") + (update.content?.text || "");
  } else if (kind === "agent_thought_chunk") {
    return;
  } else if (kind === "tool_call" || kind === "tool_call_update") {
    upsertTool(update);
  } else if (kind === "plan") {
    ingestPlanUpdate(update);
  } else if (kind === "available_commands_update") {
    return;
  } else if (kind === "current_mode_update") {
    const id = update.currentModeId || update.modeId;
    if (id && ["default", "ask", "plan"].includes(String(id))) {
      state.modeId = String(id);
      syncComposerControls();
    }
  } else if (kind === "config_option_update") {
    ingestConfig(update.configOptions || update);
  }
}

function upsertTool(update) {
  const id = update.toolCallId;
  let card = state.tools.get(id);
  const group = ensureWorkGroup();
  if (!card) {
    card = document.createElement("details");
    card.className = "tool";
    card.innerHTML = `<summary class="tool-summary"><span class="tool-label">正在处理</span></summary><pre class="out"></pre>`;
    group.querySelector(".work-body").append(card);
    updateWelcomeVisibility();
    state.tools.set(id, card);
  }
  const kind = update.kind || card.dataset.kind || "tool";
  const title = update.title || card.dataset.title || "";
  const status = update.status || card.dataset.status || "";
  card.dataset.kind = kind;
  card.dataset.title = title;
  card.dataset.status = status;
  const done = /complete|done/i.test(status);
  const failed = /fail|error/i.test(status);
  card.classList.toggle("done", done && !failed);
  card.classList.toggle("failed", failed);
  const label = card.querySelector(".tool-label");
  if (label) label.textContent = toolCardLabel(kind, title, status);
  const text = toolText(update);
  if (text) {
    const out = card.querySelector(".out");
    out.textContent = (out.textContent + text).slice(-4000);
  }
  maybeIngestPlanFromTool(update);
  updateWorkGroupLabel(group);
  recordWorkStep(update);
}

function toolCardLabel(kind, title, status) {
  const k = String(kind || "").toLowerCase();
  const t = String(title || "");
  const done = /complete|done/i.test(status);
  const failed = /fail|error/i.test(status);
  let action = "处理";
  if (/read/.test(k) || /^read /i.test(t)) action = "读文件";
  else if (/write|edit/.test(k) || /^(write|edit|update)/i.test(t)) action = "改文件";
  else if (/search|grep|glob/.test(k) || /search/i.test(t)) action = "搜索";
  else if (/bash|exec|terminal|shell|command/.test(k) || /^(run|exec|bash)/i.test(t)) action = "运行命令";
  else if (/list|dir|other/.test(k) || /list/i.test(t)) action = "查看文件";
  if (failed) return `${action}出错了`;
  if (done) return `已完成 · ${action}`;
  return `正在${action}`;
}

function toolText(update) {
  const chunks = [];
  for (const block of update.content || []) {
    if (block.type === "content" && block.content?.text) chunks.push(block.content.text);
    else if (block.type === "diff") chunks.push(block.diff || JSON.stringify(block, null, 2));
    else if (block.text) chunks.push(block.text);
  }
  if (update.rawOutput) chunks.push(typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput, null, 2));
  return chunks.join("\n");
}

function fileMeta(name) {
  const base = String(name || "").split("/").pop() || "";
  const lower = base.toLowerCase();
  if (lower === ".gitignore" || lower === ".gitattributes") return { bg: "#f05032", fg: "#fff", label: "GIT", wide: false };
  if (lower === "dockerfile" || lower === "compose.yaml" || lower === "compose.yml") return { bg: "#2496ed", fg: "#fff", label: "DK", wide: false };
  const ext = lower.includes(".") ? lower.split(".").pop() : "";
  const table = {
    html: { bg: "#e34f26", fg: "#fff", label: "HTML", wide: true },
    htm: { bg: "#e34f26", fg: "#fff", label: "HTML", wide: true },
    js: { bg: "#f7df1e", fg: "#323330", label: "JS", wide: false },
    mjs: { bg: "#f7df1e", fg: "#323330", label: "JS", wide: false },
    cjs: { bg: "#f7df1e", fg: "#323330", label: "JS", wide: false },
    ts: { bg: "#3178c6", fg: "#fff", label: "TS", wide: false },
    tsx: { bg: "#3178c6", fg: "#fff", label: "TSX", wide: true },
    jsx: { bg: "#61dafb", fg: "#213547", label: "JSX", wide: true },
    css: { bg: "#563d7c", fg: "#fff", label: "CSS", wide: false },
    md: { bg: "#519aba", fg: "#fff", label: "MD", wide: false },
    json: { bg: "#cbcb41", fg: "#333", label: "{}", wide: false },
    png: { bg: "#a074c4", fg: "#fff", label: "PNG", wide: true },
    jpg: { bg: "#a074c4", fg: "#fff", label: "IMG", wide: false },
    jpeg: { bg: "#a074c4", fg: "#fff", label: "IMG", wide: false },
    gif: { bg: "#a074c4", fg: "#fff", label: "IMG", wide: false },
    webp: { bg: "#a074c4", fg: "#fff", label: "IMG", wide: false },
    svg: { bg: "#ffb13b", fg: "#333", label: "SVG", wide: true },
    bmp: { bg: "#a074c4", fg: "#fff", label: "IMG", wide: false },
    sql: { bg: "#336791", fg: "#fff", label: "SQL", wide: false },
    yml: { bg: "#cb171e", fg: "#fff", label: "YML", wide: false },
    yaml: { bg: "#cb171e", fg: "#fff", label: "YML", wide: false },
    toml: { bg: "#9c4221", fg: "#fff", label: "TOML", wide: true },
  };
  return table[ext] || { bg: "#6e7681", fg: "#fff", label: (ext || "FILE").slice(0, 3).toUpperCase(), wide: (ext || "").length > 2 };
}

function fileIconSvg(name, kind, collapsed = false) {
  if (kind === "dir") {
    if (collapsed) {
      return `<svg class="tree-ico" viewBox="0 0 16 16" aria-hidden="true"><path fill="#dcb67a" d="M1.6 3.1h4.7l.9 1.3h7.2c.4 0 .7.3.7.7v7.2c0 .4-.3.7-.7.7H1.6c-.4 0-.7-.3-.7-.7V3.8c0-.4.3-.7.7-.7Z"/></svg>`;
    }
    return `<svg class="tree-ico" viewBox="0 0 16 16" aria-hidden="true"><path fill="#c09553" d="M1.5 3.2h4.8l.8 1.2h2.2"/><path fill="#e0b76a" d="M1.3 6.1 2.6 13h11l1.5-6.9H1.3Z"/></svg>`;
  }
  const meta = fileMeta(name);
  return `<span class="file-badge tab-ico${meta.wide ? " wide" : ""}" style="background:${meta.bg};color:${meta.fg}">${meta.label}</span>`;
}

function twistSvg(isDir, collapsed) {
  if (!isDir) return `<span class="tree-twist"></span>`;
  const rot = collapsed ? "" : ` style="transform:rotate(90deg)"`;
  return `<span class="tree-twist"><svg viewBox="0 0 16 16"${rot}><path d="M6 4.5 11 8 6 11.5Z"/></svg></span>`;
}

function entryMatches(entry, q) {
  if (!q) return true;
  if (String(entry.name || "").toLowerCase().includes(q)) return true;
  return (entry.children || []).some((child) => entryMatches(child, q));
}

function paintBreadcrumb(filePath) {
  const bar = $("file-crumbs");
  if (!bar) return;
  bar.replaceChildren();
  const clean = String(filePath || "").replaceAll("\\", "/");
  if (!clean) {
    bar.textContent = "未选择文件";
    return;
  }
  const parts = clean.split("/").filter(Boolean);
  parts.forEach((part, i) => {
    if (i) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "›";
      bar.append(sep);
    }
    const span = document.createElement("span");
    span.className = "crumb-part";
    span.textContent = part;
    bar.append(span);
  });
}

function renderTree(entries, into, depth = 0) {
  const box = into || $("file-tree");
  const q = (state.fileFilter || "").trim().toLowerCase();
  if (!into) {
    state.treeEntries = entries || [];
    box.replaceChildren();
    if (!state.treeEntries.length) {
      const empty = document.createElement("p");
      empty.className = "tree-empty";
      empty.textContent = "这个对话还没有文件。做完页面后会出现在这里。";
      box.append(empty);
      return;
    }
    renderTreeNode(
      { name: "工作区", path: "", kind: "dir", children: state.treeEntries },
      box,
      0,
      q,
      true,
    );
    return;
  }
  for (const entry of entries || []) renderTreeNode(entry, box, depth, q, false);
}

function renderTreeNode(entry, box, depth, q, isRoot) {
  if (q && !isRoot && !entryMatches(entry, q)) return;
  const isDir = entry.kind === "dir";
  const collapsed = !isRoot && !q && isDir && state.collapsedDirs.has(entry.path);
  const row = document.createElement("button");
  row.type = "button";
  row.className = `tree-row ${isDir ? "dir" : "file"}${isRoot ? " root" : ""}`;
  if (entry.path && entry.path === state.filePath) row.classList.add("on");
  row.dataset.path = entry.path || "";
  row.style.setProperty("--depth", String(depth));
  row.innerHTML = `${twistSvg(isDir, collapsed)}${fileIconSvg(entry.name, entry.kind, collapsed)}`;
  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = entry.name;
  row.append(name);
  row.onclick = () => {
    if (isDir) {
      if (!isRoot) {
        if (state.collapsedDirs.has(entry.path)) state.collapsedDirs.delete(entry.path);
        else state.collapsedDirs.add(entry.path);
      } else if (state.collapsedDirs.has("__root__")) state.collapsedDirs.delete("__root__");
      else state.collapsedDirs.add("__root__");
      renderTree(state.treeEntries);
      return;
    }
    if (state.sessionId) {
      const lower = String(entry.path || "").toLowerCase();
      state.pendingPreview = /\.(html?|svg)$/i.test(lower) ? entry.path : "";
      send({ type: "read_file", sessionId: state.sessionId, path: entry.path });
    }
  };
  box.append(row);
  const rootCollapsed = isRoot && !q && state.collapsedDirs.has("__root__");
  if (isDir && entry.children?.length && !collapsed && !rootCollapsed) {
    renderTree(entry.children, box, depth + 1);
  }
}

function paintTabs() {
  const bar = $("editor-tabs");
  if (!bar) return;
  bar.replaceChildren();
  bar.classList.toggle("empty", !state.openTabs.length);
  for (const filePath of state.openTabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `editor-tab${filePath === state.filePath ? " on" : ""}`;
    const name = filePath.replaceAll("\\", "/");
    btn.innerHTML = `${fileIconSvg(name.split("/").pop() || name, "file")}<span class="tab-name"></span><span class="tab-close" title="关闭">✕</span>`;
    btn.querySelector(".tab-name").textContent = name;
    btn.onclick = (e) => {
      if (e.target.closest(".tab-close")) {
        e.preventDefault();
        closeFileTab(filePath);
        return;
      }
      if (state.sessionId) send({ type: "read_file", sessionId: state.sessionId, path: filePath });
    };
    bar.append(btn);
  }
  bar.querySelector(".editor-tab.on")?.scrollIntoView({ inline: "nearest", block: "nearest" });
}

function openFileTab(filePath) {
  if (!filePath) return;
  if (!state.openTabs.includes(filePath)) state.openTabs.push(filePath);
  paintTabs();
}

function closeFileTab(filePath) {
  state.openTabs = state.openTabs.filter((path) => path !== filePath);
  if (state.filePath !== filePath) {
    paintTabs();
    return;
  }
  const next = state.openTabs[state.openTabs.length - 1];
  if (next && state.sessionId) {
    send({ type: "read_file", sessionId: state.sessionId, path: next });
    return;
  }
  state.filePath = "";
  state.fileContent = "";
  paintBreadcrumb("");
  $("file-open-preview")?.classList.add("hidden");
  paintEditor({ path: "", content: "在左侧打开一个文件", binary: false });
  paintTabs();
}

function showFile(msg) {
  state.filePath = msg.path || "";
  state.fileContent = msg.binary ? "" : msg.content || "";
  if (msg.path) openFileTab(msg.path);
  paintBreadcrumb(msg.path || "");
  paintEditor(msg);
  for (const row of document.querySelectorAll("#file-tree .tree-row")) {
    row.classList.toggle("on", row.dataset.path === state.filePath);
  }
  const lower = String(msg.path || "").toLowerCase();
  const previewable = lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".svg");
  const openBtn = $("file-open-preview");
  if (openBtn) openBtn.classList.toggle("hidden", !previewable);
  if (previewable && state.pendingPreview === msg.path) {
    state.pendingPreview = "";
    loadPreview(msg.path, { switchTab: false });
  }
  if (/plan\.(md|json)$/i.test(msg.path || "") && !msg.binary) ingestPlanMarkdown(msg.content || "");
}

function isImagePath(filePath) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filePath || "");
}

function paintEditor(msg) {
  const imageWrap = $("file-image-wrap");
  const editor = $("file-editor");
  const codeEl = $("file-view")?.querySelector("code") || $("file-view");
  const gutter = $("file-gutter");
  if (msg.binary && isImagePath(msg.path)) {
    imageWrap?.classList.remove("hidden");
    editor?.classList.add("hidden");
    const img = $("file-image");
    if (img) {
      img.src = workspaceUrl(msg.path);
      img.alt = msg.path;
    }
    return;
  }
  imageWrap?.classList.add("hidden");
  editor?.classList.remove("hidden");
  if (msg.binary) {
    if (codeEl) codeEl.textContent = `这是二进制文件，不能当代码打开（${msg.size || 0} 字节）`;
    if (gutter) gutter.textContent = "";
    return;
  }
  const text = msg.content || "";
  const lang = languageOf(msg.path);
  if (codeEl) codeEl.innerHTML = highlight(text, lang);
  if (gutter) {
    const lines = text.split("\n").length;
    gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
  }
}

function maybeLoadPlanFile(entries) {
  const paths = [];
  const walk = (items) => {
    for (const entry of items || []) {
      if (entry.kind === "file" && /plan\.(md|json)$/i.test(entry.name || "")) paths.push(entry.path);
      if (entry.children) walk(entry.children);
    }
  };
  walk(entries);
  const planPath = paths.find((p) => /plan\.md$/i.test(p)) || paths[0];
  if (planPath && state.sessionId) {
    send({ type: "read_file", sessionId: state.sessionId, path: planPath, silent: true });
  }
}

function ingestPlanUpdate(update) {
  const entries = normalizePlanEntries(update.entries || update.plan || update);
  if (entries.length) {
    state.planEntries = entries;
    paintPlan();
  }
}

function maybeIngestPlanFromTool(update) {
  const kind = String(update.kind || update.title || "").toLowerCase();
  const input = update.rawInput || update._meta?.rawInput || {};
  if (typeof input.plan === "string" && input.plan.trim()) {
    ingestPlanMarkdown(input.plan);
    if (Array.isArray(input.todos)) {
      state.planEntries = input.todos.map((t) => ({
        content: t.content || t.title || String(t),
        status: t.status || "pending",
      }));
      paintPlan();
    }
    return;
  }
  if (Array.isArray(input.todos) && input.todos.length) {
    state.planEntries = input.todos.map((t) => ({
      content: t.content || t.title || String(t),
      status: t.status || "pending",
    }));
    paintPlan();
    return;
  }
  if (/plan|todo/.test(kind) && typeof update.title === "string") {
    const text = toolText(update);
    if (text) ingestPlanMarkdown(text);
  }
}

function normalizePlanEntries(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === "string") return { content: item, status: "pending" };
        return {
          content: item.content || item.title || item.text || "",
          status: String(item.status || "pending").toLowerCase(),
        };
      })
      .filter((item) => item.content);
  }
  if (typeof raw === "string") return planEntriesFromMarkdown(raw);
  if (Array.isArray(raw.entries)) return normalizePlanEntries(raw.entries);
  return [];
}

function planEntriesFromMarkdown(text) {
  const entries = [];
  for (const line of String(text || "").split("\n")) {
    const check = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (check) {
      entries.push({ content: check[2], status: check[1].trim() ? "completed" : "pending" });
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) entries.push({ content: bullet[1], status: "pending" });
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (numbered) entries.push({ content: numbered[1], status: "pending" });
  }
  return entries;
}

function ingestPlanMarkdown(text) {
  if (!text || !String(text).trim()) return;
  state.planMarkdown = String(text);
  const parsed = planEntriesFromMarkdown(text);
  if (parsed.length) state.planEntries = parsed;
  paintPlan();
}

function paintPlan() {
  const empty = $("plan-empty");
  const list = $("plan-list");
  const md = $("plan-md");
  const entries = state.planEntries || [];
  const markdown = state.planMarkdown || "";
  if (!entries.length && !markdown.trim()) {
    empty?.classList.remove("hidden");
    list?.classList.add("hidden");
    md?.classList.add("hidden");
    return;
  }
  empty?.classList.add("hidden");
  if (list) {
    list.classList.toggle("hidden", entries.length === 0);
    list.replaceChildren();
    for (const entry of entries) {
      const status = String(entry.status || "pending").replace("-", "_");
      const li = document.createElement("li");
      li.className = `plan-item ${status}`;
      li.innerHTML = `<span class="plan-check"></span><span class="plan-text"></span>`;
      li.querySelector(".plan-text").textContent = entry.content;
      list.append(li);
    }
  }
  if (md) {
    const extra = entries.length ? "" : markdown;
    md.classList.toggle("hidden", !extra.trim());
    if (extra.trim()) md.innerHTML = renderMd(extra);
  }
}

function ingestVersions(msg) {
  state.saves = msg.versions || state.saves;
  if (msg.head) state.saveHead = msg.head;
  else if (!state.saveHead && state.saves[0]?.id) state.saveHead = state.saves[0].id;
  if (state.saveSelected && !state.saves.some((row) => row.id === state.saveSelected)) {
    state.saveSelected = state.saveHead || "";
  }
  renderSaves();
}

const SAVE_LANE_COLORS = ["#3fb950", "#58a6ff", "#d2a8ff", "#f0883e", "#f85149", "#39d0d6"];
const SAVE_ROW_H = 68;

function assignSaveLanes(saves, headId) {
  const byId = new Map(saves.map((row) => [row.id, row]));
  const laneOf = new Map();
  let nextLane = 0;
  const paintChain = (startId, lane) => {
    let id = startId;
    while (id && byId.has(id) && !laneOf.has(id)) {
      laneOf.set(id, lane);
      id = byId.get(id).parentId;
    }
  };
  if (headId && byId.has(headId)) {
    paintChain(headId, 0);
    nextLane = 1;
  }
  const leaves = saves.filter((row) => !saves.some((other) => other.parentId === row.id));
  leaves.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  for (const leaf of leaves) {
    if (laneOf.has(leaf.id)) continue;
    paintChain(leaf.id, nextLane);
    nextLane += 1;
  }
  for (const row of saves) {
    if (!laneOf.has(row.id)) {
      paintChain(row.id, nextLane);
      nextLane += 1;
    }
  }
  return laneOf;
}

function isSaveAncestor(saves, olderId, newerId) {
  const byId = new Map(saves.map((row) => [row.id, row]));
  const seen = new Set();
  let cur = byId.get(newerId);
  while (cur && !seen.has(cur.id)) {
    if (cur.id === olderId) return true;
    seen.add(cur.id);
    cur = byId.get(cur.parentId);
  }
  return false;
}

async function checkoutSave(row, mode) {
  const label = row.note || "这一版";
  const copy =
    mode === "rollback"
      ? `回退到「${label}」？当前没存档的改动会被盖掉。`
      : `切换到「${label}」？工作区会变成这一版，之后再保存会从这里分叉。`;
  const ok = await confirmAction({
    title: mode === "rollback" ? "回退存档" : "切换存档",
    copy,
    ok: mode === "rollback" ? "回退" : "切换",
  });
  if (!ok) return;
  send({ type: "restore_version", id: row.id, sessionId: state.sessionId });
}

function renderSaves() {
  const box = $("save-list");
  const svg = $("save-graph-svg");
  if (!box) return;
  box.replaceChildren();
  if (svg) {
    svg.replaceChildren();
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.removeAttribute("viewBox");
  }
  if (!state.saves.length) {
    const p = document.createElement("p");
    p.className = "save-empty";
    p.textContent = "还没有存档。做出一版能玩的应用后，点上面的「保存这一版」。";
    box.append(p);
    return;
  }

  const saves = state.saves;
  const headId = state.saveHead || saves[0]?.id || "";
  const selectedId = state.saveSelected || headId;
  const laneOf = assignSaveLanes(saves, headId);
  const ordered = [...saves].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const rowOf = new Map(ordered.map((row, i) => [row.id, i]));
  const maxLane = Math.max(0, ...laneOf.values());
  const col = 16;
  const padX = 18;
  const graphW = padX * 2 + (maxLane + 1) * col;
  const height = ordered.length * SAVE_ROW_H;
  box.style.setProperty("--graph-pad", `${graphW + 8}px`);

  if (svg) {
    const ns = "http://www.w3.org/2000/svg";
    svg.setAttribute("width", String(graphW));
    svg.setAttribute("height", String(height));
    svg.setAttribute("viewBox", `0 0 ${graphW} ${height}`);
    const colorOf = (lane) => SAVE_LANE_COLORS[lane % SAVE_LANE_COLORS.length];
    for (const node of ordered) {
      const i = rowOf.get(node.id);
      const lane = laneOf.get(node.id) || 0;
      const x = padX + lane * col;
      const y = i * SAVE_ROW_H + SAVE_ROW_H / 2;
      if (node.parentId && rowOf.has(node.parentId)) {
        const pi = rowOf.get(node.parentId);
        const plane = laneOf.get(node.parentId) || 0;
        const px = padX + plane * col;
        const py = pi * SAVE_ROW_H + SAVE_ROW_H / 2;
        const path = document.createElementNS(ns, "path");
        if (lane === plane) path.setAttribute("d", `M ${x} ${y} L ${px} ${py}`);
        else {
          const mid = (y + py) / 2;
          path.setAttribute("d", `M ${x} ${y} C ${x} ${mid}, ${px} ${mid}, ${px} ${py}`);
        }
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", colorOf(lane));
        path.setAttribute("stroke-width", "2");
        svg.append(path);
      }
      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", String(x));
      dot.setAttribute("cy", String(y));
      dot.setAttribute("r", node.id === headId ? "5.5" : "4.5");
      dot.setAttribute("fill", colorOf(lane));
      dot.setAttribute("stroke", "#0d1117");
      dot.setAttribute("stroke-width", "2");
      svg.append(dot);
    }
  }

  const leaves = new Set(saves.filter((row) => !saves.some((other) => other.parentId === row.id)).map((row) => row.id));
  for (const row of ordered) {
    const card = document.createElement("article");
    const isHead = row.id === headId;
    const lane = laneOf.get(row.id) || 0;
    card.className = `save-card${isHead ? " head" : ""}${row.id === selectedId ? " on" : ""}`;
    const switchLabel = isHead ? "当前版本" : isSaveAncestor(saves, row.id, headId) ? "回退到这一版" : "切换到这一版";
    card.innerHTML = `<div class="save-main"><div class="t"><span class="save-note"></span></div><div class="m"></div></div><div class="save-actions"><button type="button" data-act="checkout"></button><button type="button" class="danger" data-act="delete">删除</button></div>`;
    const title = card.querySelector(".save-note");
    title.textContent = row.note || "未命名存档";
    if (isHead) {
      const badge = document.createElement("span");
      badge.className = "save-badge";
      badge.textContent = "HEAD";
      card.querySelector(".t").append(badge);
    } else if (leaves.has(row.id) && lane > 0) {
      const badge = document.createElement("span");
      badge.className = "save-badge branch";
      badge.textContent = "分支";
      card.querySelector(".t").append(badge);
    }
    card.querySelector(".m").textContent = row.createdAt ? new Date(row.createdAt).toLocaleString() : row.id;
    const checkout = card.querySelector("[data-act=checkout]");
    checkout.textContent = switchLabel;
    checkout.disabled = isHead;
    checkout.onclick = (e) => {
      e.stopPropagation();
      checkoutSave(row, isSaveAncestor(saves, row.id, headId) ? "rollback" : "switch");
    };
    card.querySelector("[data-act=delete]").onclick = async (e) => {
      e.stopPropagation();
      const ok = await confirmAction({
        title: "删除存档",
        copy: "删除这个存档？删掉后不能恢复。",
        ok: "删除",
        danger: true,
      });
      if (!ok) return;
      send({ type: "delete_version", id: row.id, sessionId: state.sessionId });
    };
    card.onclick = () => {
      state.saveSelected = row.id;
      for (const el of box.querySelectorAll(".save-card")) el.classList.toggle("on", el === card);
    };
    box.append(card);
  }
}

function collectHtmlFiles(entries, acc) {
  if (!acc) {
    state.htmlFiles = [];
    acc = state.htmlFiles;
  }
  for (const entry of entries || []) {
    if (entry.kind === "file" && /\.html?$/i.test(entry.name || entry.path || "")) {
      acc.push(normRel(entry.path));
    }
    if (entry.children?.length) collectHtmlFiles(entry.children, acc);
  }
  return acc;
}

function normRel(rel) {
  return String(rel || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function hasDockerfile(entries) {
  for (const entry of entries || []) {
    const name = String(entry.name || entry.path || "");
    if (entry.kind === "file" && /(^|\/)Dockerfile$/i.test(name.replaceAll("\\", "/"))) return true;
    if (entry.children?.length && hasDockerfile(entry.children)) return true;
  }
  return false;
}

function showPreviewMessage(text) {
  const frame = $("preview-frame");
  const fallback = $("preview-fallback");
  if (frame) {
    frame.classList.add("hidden");
    frame.removeAttribute("srcdoc");
    frame.src = "about:blank";
  }
  fallback?.classList.remove("hidden");
  const code = fallback?.querySelector("code");
  if (code) code.textContent = text;
  paintPreviewChrome("", false);
}

function pickHtmlPreview() {
  const files = state.htmlFiles || [];
  return files.find((p) => /(^|\/)index\.html?$/i.test(p)) || files[0] || "";
}

function workspaceUrl(rel) {
  if (!state.sessionId) return "about:blank";
  const clean = String(rel || "").replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = clean.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const params = new URLSearchParams();
  params.set("t", String(Date.now()));
  if (state.token) params.set("token", state.token);
  const sid = encodeURIComponent(state.sessionId);
  return `/workspace/${sid}/${parts}?${params.toString()}`;
}

let previewTimer = 0;
let listDirTimer = 0;

function queueListDir() {
  if (!state.sessionId) return;
  clearTimeout(listDirTimer);
  listDirTimer = setTimeout(() => {
    send({ type: "list_dir", sessionId: state.sessionId });
  }, 180);
}

function queueLivePreview(rel) {
  if (state.runtime?.kind === "app") return;
  const path = normRel(rel);
  if (!/\.(html?|svg)$/i.test(path)) return;
  if (!state.htmlFiles.includes(path)) state.htmlFiles.unshift(path);
  const jump = state.tab === "preview" && state.panelOpen && !state.busy;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    loadPreview(path, { switchTab: jump });
    maybeRevealPreview();
  }, 120);
}

function appPreviewUrl(port) {
  return `${location.protocol}//${location.hostname}:${port}/`;
}

function appFrameUrl() {
  if (!state.sessionId) return "about:blank";
  return `/preview-app/${encodeURIComponent(state.sessionId)}/`;
}

const STATIC_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-popups";

function replacePreviewFrame({ sandbox, kind } = {}) {
  const old = $("preview-frame");
  if (!old) return null;
  const next = document.createElement("iframe");
  next.id = "preview-frame";
  next.className = "preview-frame";
  next.title = "preview";
  next.dataset.kind = kind || "";
  next.setAttribute("allow", "local-network-access; fullscreen");
  if (sandbox) next.setAttribute("sandbox", sandbox);
  old.replaceWith(next);
  return bindPreviewFrame(next);
}

function previewFrame(kind, sandbox) {
  let frame = $("preview-frame");
  if (!frame) return null;
  const same =
    frame.dataset.kind === kind &&
    (sandbox ? frame.getAttribute("sandbox") === sandbox : !frame.hasAttribute("sandbox"));
  if (same) return frame;
  return replacePreviewFrame({ sandbox, kind });
}

function loadAppPreview({ switchTab = true } = {}) {
  const port = state.runtime?.port;
  if (!port || !state.sessionId) return;
  const frame = previewFrame("app");
  const fallback = $("preview-fallback");
  if (!frame) return;
  const url = appFrameUrl();
  state.previewPath = "__app__";
  fallback?.classList.add("hidden");
  frame.classList.remove("hidden");
  if (!frame.src.includes(`/preview-app/${encodeURIComponent(state.sessionId)}/`)) frame.src = url;
  paintPreviewChrome(`应用 · ${location.hostname}:${port}`, true);
  if (switchTab) setTab("preview");
  else maybeRevealPreview();
}

function loadPreview(rel, { switchTab = true } = {}) {
  if (!rel) return;
  state.previewPath = rel;
  const frame = previewFrame("static", STATIC_FRAME_SANDBOX);
  const fallback = $("preview-fallback");
  if (!frame) return;
  fallback?.classList.add("hidden");
  frame.classList.remove("hidden");
  frame.src = workspaceUrl(rel);
  paintPreviewChrome(rel, true);
  if (switchTab) setTab("preview");
  else maybeRevealPreview();
}

function refreshPreviewIfNeeded() {
  if (state.runtime?.kind === "app") {
    if (state.runtime.status === "ready" && state.runtime.port) {
      loadAppPreview({ switchTab: false });
      maybeRevealPreview();
    } else if (state.runtime.status === "building") showPreviewMessage("正在启动应用，第一次可能要等一会儿。");
    return;
  }
  const current = normRel(state.previewPath);
  const currentOk = current && state.htmlFiles.includes(current);
  if (currentOk) {
    if (state.previewDirty) loadPreview(current, { switchTab: false });
    state.previewDirty = false;
    maybeRevealPreview();
    return;
  }
  const next = pickHtmlPreview();
  state.previewDirty = false;
  if (next) {
    loadPreview(next, { switchTab: false });
    maybeRevealPreview();
  } else if (state.previewPath) clearPreview();
}

function renderPreview(msg) {
  const frame = $("preview-frame");
  const fallback = $("preview-fallback");
  const pathName = String(msg.path || "").toLowerCase();
  if (msg.binary) {
    frame.classList.add("hidden");
    fallback.classList.remove("hidden");
    fallback.querySelector("code").textContent = `无法预览二进制文件 ${msg.path}`;
    return;
  }
  const text = msg.content || "";
  if (pathName.endsWith(".html") || pathName.endsWith(".htm")) {
    loadPreview(msg.path);
    return;
  }
  if (pathName.endsWith(".svg")) {
    fallback.classList.add("hidden");
    frame.classList.remove("hidden");
    frame.srcdoc = text;
    setTab("preview");
    return;
  }
  frame.classList.add("hidden");
  fallback.classList.remove("hidden");
  fallback.querySelector("code").innerHTML = pathName.endsWith(".md") ? renderMd(text) : escapeHtml(text);
}

function setTab(name, { open = true } = {}) {
  state.tab = name;
  if (open) openSidePanel();
  for (const btn of document.querySelectorAll(".tab")) {
    btn.classList.toggle("on", btn.dataset.tab === name);
  }
  for (const pane of ["files", "preview", "plan", "saves"]) {
    $(`pane-${pane}`)?.classList.toggle("hidden", pane !== name);
  }
  if (name === "saves" && state.sessionId) send({ type: "list_versions", sessionId: state.sessionId });
  if (name === "preview" && state.sessionId) {
    send({ type: "ensure_runtime", sessionId: state.sessionId });
    if (state.runtime?.kind === "app" && state.runtime.status === "ready" && state.runtime.port) {
      loadAppPreview({ switchTab: false });
    }
  }
}

function setBusy(busy) {
  const was = state.busy;
  state.busy = busy;
  if (busy) state.listening = true;
  const sendBtn = $("send");
  const prompt = $("prompt");
  const hasText = Boolean(prompt?.value.trim() || queuedPrompt);
  if (prompt) {
    prompt.placeholder = busy && !hasText ? "正在执行，点暂停可停止" : "随心输入";
  }
  if (sendBtn) {
    const pausing = busy && !hasText;
    sendBtn.disabled = false;
    sendBtn.classList.toggle("stop", pausing);
    sendBtn.setAttribute("aria-label", pausing ? "暂停" : "发送");
    sendBtn.querySelector(".icon-send")?.classList.toggle("hidden", pausing);
    sendBtn.querySelector(".icon-pause")?.classList.toggle("hidden", !pausing);
  }
  if (busy && !was) beginWorkRun();
  if (busy) startWorkingCopy();
  else finishWorkingCards();
  if (!busy && was) endWorkRun();
}

function stopGeneration({ silent = false } = {}) {
  if (!state.busy && !state.listening) return;
  state.listening = false;
  state.gen += 1;
  if (state.sessionId) send({ type: "cancel", sessionId: state.sessionId, gen: state.gen });
  setBusy(false);
  if (!silent) toast("已停止");
}

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
  return best?.optionId || best?.id || "";
}

function autoOrShowPerm(msg) {
  const optionId = pickAllowOption(msg.params?.options, "yolo");
  if (optionId) {
    send({ type: "permission", requestId: msg.requestId, optionId });
    return;
  }
  showPerm(msg);
}

function showPerm(msg) {
  $("perm").classList.remove("hidden");
  $("perm").setAttribute("aria-hidden", "false");
  const tc = msg.params?.toolCall || {};
  $("perm-title").textContent = tc.title || "工具调用";
  $("perm-body").textContent = JSON.stringify(tc.rawInput || tc, null, 2);
  const box = $("perm-options");
  box.replaceChildren();
  for (const opt of msg.params?.options || []) {
    const btn = document.createElement("button");
    const optionId = opt.optionId || opt.id;
    btn.textContent = opt.name || optionId;
    if (String(opt.kind || optionId || "").toLowerCase().includes("allow")) btn.className = "new";
    btn.onclick = () => {
      send({ type: "permission", requestId: msg.requestId, optionId });
      $("perm").classList.add("hidden");
      $("perm").setAttribute("aria-hidden", "true");
    };
    box.append(btn);
  }
  const deny = document.createElement("button");
  deny.textContent = "拒绝";
  deny.onclick = () => {
    send({ type: "permission", requestId: msg.requestId, cancelled: true });
    $("perm").classList.add("hidden");
    $("perm").setAttribute("aria-hidden", "true");
  };
  box.append(deny);
}

function toast(message) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast hidden";
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add("hidden"), 2800);
}

function friendlyError(message) {
  const msg = String(message || "");
  if (/timed out|session timeout/i.test(msg)) return "这次做得有点久，已经停了。请再发一次。";
  if (/supported API model|you passed grok|只支持 deepseek/i.test(msg)) {
    return "当前只能用 deepseek-flash。已经帮你改好了，请再发一次。";
  }
  if (/path not found/i.test(msg)) return "找不到这次对话。";
  if (/ENOENT|no such file/i.test(msg)) return "工作区里没有这个文件。";
  if (/EACCES|EPERM|permission denied/i.test(msg)) return "没有权限访问这个文件。";
  if (/outside/i.test(msg)) return "不能访问工作区以外的文件。";
  return msg
    .replace(/[A-Za-z]:\\[^\s'"]+/g, "工作区文件")
    .replace(/\/(?:Users|home)\/[^\s'"]+/g, "工作区文件")
    .slice(0, 160);
}

function escapeHtml(src) {
  return String(src)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function inlineMd(src) {
  return String(src)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

function isTableSep(line) {
  return /^\|?\s*:?-{2,}[-:\s|]*$/.test(String(line || "").trim());
}

function isTableRow(line) {
  const t = String(line || "").trim();
  if (!t.includes("|")) return false;
  return /^\|/.test(t) || /\|/.test(t);
}

function parseTableRow(line) {
  let s = String(line || "").trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((cell) => inlineMd(cell.trim()));
}

function renderTable(lines) {
  if (lines.length < 2) return "";
  const sepAt = lines.findIndex(isTableSep);
  if (sepAt < 1) return "";
  const headers = parseTableRow(lines[0]);
  const rows = lines
    .slice(sepAt + 1)
    .filter((line) => line.trim())
    .map(parseTableRow);
  const thead = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<div class="md-table"><table>${thead}${tbody}</table></div>`;
}

function renderSimpleBlock(block) {
  const heading = block.match(/^(#{1,3})\s+(.+)$/);
  if (heading && !block.includes("\n")) {
    const level = Math.min(heading[1].length + 1, 4);
    return `<h${level}>${inlineMd(heading[2])}</h${level}>`;
  }
  if (heading && block.startsWith(heading[0])) {
    const level = Math.min(heading[1].length + 1, 4);
    const rest = block.slice(heading[0].length).trim();
    return `<h${level}>${inlineMd(heading[2])}</h${level}>${rest ? `<p>${inlineMd(rest).replaceAll("\n", "<br>")}</p>` : ""}`;
  }
  const lines = block.split("\n");
  const listish = lines.filter((l) => l.trim());
  if (listish.length && listish.every((l) => /^([-*]|\d+\.)\s+/.test(l.trim()))) {
    const items = listish
      .map((l) => `<li>${inlineMd(l.trim().replace(/^([-*]|\d+\.)\s+/, ""))}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }
  return `<p>${inlineMd(block).replaceAll("\n", "<br>")}</p>`;
}

function renderMdBlock(block) {
  const lines = block.split("\n");
  const start = lines.findIndex((line, i) => isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1]));
  if (start >= 0) {
    let end = start + 2;
    while (end < lines.length && (isTableRow(lines[end]) || isTableSep(lines[end]))) end += 1;
    const before = lines.slice(0, start).join("\n").trim();
    const table = renderTable(lines.slice(start, end));
    const after = lines.slice(end).join("\n").trim();
    return [before && renderSimpleBlock(before), table, after && renderSimpleBlock(after)].filter(Boolean).join("");
  }
  return renderSimpleBlock(block);
}

function renderMd(src) {
  const fences = [];
  const prepared = String(src || "").replace(/```([\s\S]*?)```/g, (_, code) => {
    fences.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    return `\n\n%%FENCE${fences.length - 1}%%\n\n`;
  });
  const blocks = escapeHtml(prepared).split(/\n{2,}/);
  return blocks
    .map((raw) => {
      const block = raw.trim();
      if (!block) return "";
      const fence = block.match(/^%%FENCE(\d+)%%$/);
      if (fence) return fences[Number(fence[1])];
      return renderMdBlock(block);
    })
    .join("");
}

function localizePrompt(text) {
  return String(text || "");
}

function ensureSession() {
  if (state.sessionId) return true;
  send({ type: "new_session", model: state.model });
  return false;
}

let queuedPrompt = "";
function flushQueuedPrompt() {
  const text = queuedPrompt;
  if (!text || state.busy) return;
  queuedPrompt = "";
  sendPrompt(text);
}

function sendPrompt(text, { echo = true } = {}) {
  if (!text) return;
  if (state.busy) {
    queuedPrompt = text;
    if ($("prompt")?.value.trim() === text) $("prompt").value = "";
    stopGeneration({ silent: true });
    setTimeout(flushQueuedPrompt, 120);
    return;
  }
  if (state.ws?.readyState !== 1) {
    queuedPrompt = text;
    toast("还没连上，连上后会自动发出。");
    return;
  }
  const rename = String(text).match(/^\/rename\s+(.+)/i);
  if (rename) {
    if (!ensureSession()) {
      queuedPrompt = text;
      return;
    }
    $("prompt").value = "";
    hideSlash();
    commitSessionTitle(rename[1]);
    toast("已改会话名称");
    return;
  }
  if (!ensureSession()) {
    queuedPrompt = text;
    if ($("prompt")?.value.trim() === text) $("prompt").value = "";
    hideSlash();
    return;
  }
  $("prompt").value = "";
  hideSlash();
  if (isPlaceholderTitle(state.sessionTitle)) {
    const auto = titleFromUserText(text);
    if (auto) paintSessionTitle(auto);
  }
  if (echo) {
    state.bubbles.delete("user");
    state.bubbles.delete("agent");
    state.pendingAgent = "";
    const el = addBubble("user", text);
    el.dataset.closed = "1";
    state.bubbles.delete("user");
  }
  state.gen += 1;
  setBusy(true);
  send({
    type: "prompt",
    sessionId: state.sessionId,
    text: localizePrompt(text),
    gen: state.gen,
    model: state.model,
  });
}

function fillPrompt(text) {
  const el = $("prompt");
  el.value = text;
  el.focus();
  const n = el.value.length;
  try {
    el.setSelectionRange(n, n);
  } catch {}
  hideSlash();
  closePalette();
}

function insertCommand(cmd) {
  if (!cmd) return;
  fillPrompt(`/${cmd.name} `);
}

function runCommand(cmd) {
  closePalette();
  hideSlash();
  if (!cmd) return;
  if (cmd.run === "new") {
    $("prompt").value = "";
    resetWorkspaceUi();
    clearTranscript("");
    send({ type: "new_session", model: state.model });
    return;
  }
  if (cmd.run === "stop") {
    stopGeneration();
    return;
  }
  if (cmd.run === "delete") {
    if (!state.sessionId) {
      toast("还没有当前对话。");
      return;
    }
    askDeleteSession(state.sessionId, state.sessionTitle);
    return;
  }
  if (cmd.run === "focus-sessions") {
    toast("从左侧会话列表点选即可恢复。");
    return;
  }
  if (cmd.run === "view-plan") {
    setTab("plan");
    sendPrompt("/view-plan");
    return;
  }
  if (cmd.run === "mode") {
    runMode(MODES.find((m) => m.id === cmd.modeId) || { id: cmd.modeId, slash: `/${cmd.name}` });
    return;
  }
  insertCommand(cmd);
}

function runMode(mode) {
  if (!ensureSession()) return;
  if (mode.id === "auto") {
    applyPermissionMode("auto");
    return;
  }
  if (mode.id === "always-approve") {
    applyPermissionMode("yolo");
    return;
  }
  applyAgentMode(mode.id);
}

function commandMatches(cmd, query) {
  const q = query.trim().replace(/^\//, "").toLowerCase();
  if (!q) return true;
  const hay = [cmd.name, cmd.label, cmd.hint, cmd.group, ...(cmd.aliases || [])].join(" ").toLowerCase();
  return hay.includes(q);
}

function setSlashActive(index) {
  const items = $("slash-menu").querySelectorAll(".slash-item");
  if (!items.length) return;
  slashActiveIndex = Math.max(0, Math.min(index, items.length - 1));
  for (const [i, el] of items.entries()) {
    el.classList.toggle("active", i === slashActiveIndex);
  }
  items[slashActiveIndex].scrollIntoView({ block: "nearest" });
}

function renderSlash() {
  const raw = $("prompt").value;
  const menu = $("slash-menu");
  if (!raw.startsWith("/")) {
    menu.classList.add("hidden");
    slashActiveIndex = 0;
    return;
  }
  const query = raw.slice(1);
  if (query.includes(" ")) {
    menu.classList.add("hidden");
    slashActiveIndex = 0;
    return;
  }
  const hits = allCommands().filter((c) => commandMatches(c, query)).slice(0, 12);
  const reopening = menu.classList.contains("hidden");
  menu.replaceChildren();
  if (reopening) slashActiveIndex = 0;
  if (slashActiveIndex >= hits.length) slashActiveIndex = Math.max(0, hits.length - 1);
  for (const [i, cmd] of hits.entries()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `slash-item${i === slashActiveIndex ? " active" : ""}`;
    btn.innerHTML = `<span class="name"></span><span class="hint"></span>`;
    btn.querySelector(".name").textContent = `/${cmd.name}`;
    btn.querySelector(".hint").textContent = cmd.hint;
    btn.onclick = () => runCommand(cmd);
    menu.append(btn);
  }
  menu.classList.toggle("hidden", hits.length === 0);
}

function hideSlash() {
  $("slash-menu").classList.add("hidden");
  slashActiveIndex = 0;
}

function renderPalette(query = "") {
  const body = $("palette-body");
  body.replaceChildren();
  const grouped = new Map();
  for (const cmd of allCommands().filter((c) => commandMatches(c, query))) {
    if (!grouped.has(cmd.group)) grouped.set(cmd.group, []);
    grouped.get(cmd.group).push(cmd);
  }
  for (const [group, items] of grouped) {
    const section = document.createElement("section");
    section.className = "cmd-group";
    section.innerHTML = `<h3></h3><div class="cmd-grid"></div>`;
    section.querySelector("h3").textContent = group;
    const grid = section.querySelector(".cmd-grid");
    for (const cmd of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cmd-card";
      btn.innerHTML = `<div class="slash"></div><div class="label"></div><div class="hint"></div>`;
      btn.querySelector(".slash").textContent = `/${cmd.name}`;
      btn.querySelector(".label").textContent = cmd.label;
      btn.querySelector(".hint").textContent = cmd.hint;
      btn.title = [cmd.label, cmd.hint].filter(Boolean).join("\n");
      btn.onclick = () => runCommand(cmd);
      grid.append(btn);
    }
    body.append(section);
  }
}

function openPalette() {
  $("palette").classList.remove("hidden");
  $("palette").setAttribute("aria-hidden", "false");
  renderPalette("");
  $("palette-search").value = "";
  $("palette-search").focus();
}

function closeSettings() {
  $("settings")?.classList.add("hidden");
  $("settings")?.setAttribute("aria-hidden", "true");
}

function defaultProvider() {
  return {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyConfigured: false,
    keyHint: "",
    format: "Chat Completions (/chat/completions)",
    models: [
      { id: "deepseek-flash", name: "DeepSeek Flash", hint: "默认，响应更快" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", hint: "更强一些" },
    ],
  };
}

function paintProviderForm() {
  const provider = state.provider || defaultProvider();
  const name = $("provider-name");
  const base = $("provider-base");
  const format = $("provider-format");
  const key = $("model-key");
  const status = $("key-status");
  const list = $("provider-models");
  if (name) name.value = provider.name || "DeepSeek";
  if (base && document.activeElement !== base) {
    base.value = provider.baseUrl || "https://api.deepseek.com/v1";
  }
  if (format) format.value = provider.format || "Chat Completions (/chat/completions)";
  if (key) {
    key.placeholder = provider.keyConfigured
      ? "已配置，留空则保持原密钥"
      : "输入 API Key";
  }
  if (status) {
    status.textContent = provider.keyConfigured
      ? `当前已接入 ${provider.keyHint || "DeepSeek"}`
      : "还没有配置密钥。";
  }
  $("provider-dot")?.classList.toggle("on", Boolean(provider.keyConfigured));
  $("provider-dot")?.setAttribute("title", provider.keyConfigured ? "已配置" : "未配置");
  if (list) {
    list.replaceChildren();
    const models = provider.models?.length ? provider.models : defaultProvider().models;
    for (const model of models) {
      const item = document.createElement("li");
      item.className = "provider-model";
      const id = document.createElement("span");
      id.className = "provider-model-id";
      id.textContent = model.id;
      const label = document.createElement("span");
      label.className = "provider-model-name";
      label.textContent = model.name || model.id;
      item.append(id, label);
      list.append(item);
    }
  }
}

function openSettings() {
  closeSessMenu();
  paintProviderForm();
  $("settings")?.classList.remove("hidden");
  $("settings")?.setAttribute("aria-hidden", "false");
  $("model-key")?.focus();
}

function paintAccount() {
  const name = $("account-name");
  if (name) name.textContent = state.user?.username || "未登录";
  const account = $("settings-account");
  if (account) account.textContent = state.user?.username ? `当前账号 ${state.user.username}` : "未登录";
}

function setAuthMode(mode) {
  state.authMode = mode === "register" ? "register" : "login";
  $("gate-login-tab")?.classList.toggle("on", state.authMode === "login");
  $("gate-register-tab")?.classList.toggle("on", state.authMode === "register");
  const submit = $("gate-submit");
  if (submit) submit.textContent = state.authMode === "register" ? "注册并进入" : "登录";
  const pass = $("auth-pass");
  if (pass) pass.autocomplete = state.authMode === "register" ? "new-password" : "current-password";
}

async function bootAuth() {
  try {
    const res = await fetch("/api/me");
    const body = await res.json();
    if (body?.user) {
      state.user = body.user;
      paintAccount();
      hideGate();
      connect({ force: true });
      return;
    }
  } catch {
    /* show home login */
  }
  location.replace("/?login=1");
}

async function submitAuth(username, password) {
  const path = state.authMode === "register" ? "/api/register" : "/api/login";
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "登录失败");
  state.user = body.user;
  paintAccount();
  hideGate();
  connect({ force: true });
}

async function logout() {
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  location.href = "/";
}

async function downloadProject() {
  if (!state.sessionId) return;
  location.href = `/api/download?session=${encodeURIComponent(state.sessionId)}`;
}

async function publishProject() {
  if (!state.sessionId) return;
  try {
    const res = await fetch("/api/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "发布失败");
    state.publishedSlug = body.slug || "";
    try {
      await navigator.clipboard.writeText(body.url);
      toast(`已发布，链接已复制：${body.url}`);
    } catch {
      toast(`已发布：${body.url}`);
    }
  } catch (err) {
    toast(String(err.message || err));
  }
}

function initAccountBar() {
  paintAccount();
  $("account-profile")?.addEventListener("click", openSettings);
  $("settings-close")?.addEventListener("click", closeSettings);
  $("settings")?.addEventListener("click", (e) => {
    if (e.target.id === "settings") closeSettings();
  });
  $("logout-btn")?.addEventListener("click", logout);
  $("download-project")?.addEventListener("click", downloadProject);
  $("publish-project")?.addEventListener("click", publishProject);
  $("sess-menu")?.addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    const id = state.sessMenuId;
    const title = state.sessMenuTitle;
    if (!act || !id) return;
    closeSessMenu();
    if (act === "rename") beginListRename(id, title);
    else if (act === "fork") forkSession(id);
    else if (act === "delete") askDeleteSession(id, title);
  });
  $("session-list")?.addEventListener("scroll", closeSessMenu);
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest("#sess-menu") || e.target.closest(".sess-more")) return;
    closeSessMenu();
  });
  $("confirm")?.addEventListener("click", (e) => {
    if (e.target.id === "confirm") closeConfirm(false);
  });
  $("confirm-cancel")?.addEventListener("click", () => closeConfirm(false));
  $("confirm-ok")?.addEventListener("click", () => closeConfirm(true));
}

function closePalette() {
  $("palette").classList.add("hidden");
  $("palette").setAttribute("aria-hidden", "true");
}

$("gate-login-tab")?.addEventListener("click", () => setAuthMode("login"));
$("gate-register-tab")?.addEventListener("click", () => setAuthMode("register"));

$("gate-form").onsubmit = (e) => {
  e.preventDefault();
  const username = $("auth-user").value.trim();
  const password = $("auth-pass").value;
  $("gate-error").textContent = "";
  submitAuth(username, password).catch((err) => {
    $("gate-error").textContent = err.message || "登录失败";
  });
};

$("save-key").onclick = () => {
  const value = $("model-key").value.trim();
  const baseUrl = $("provider-base")?.value.trim() || "";
  if (!value && !state.provider?.keyConfigured) {
    toast("请先填写 DeepSeek API Key。");
    return;
  }
  send({ type: "model_key", value, baseUrl });
  $("model-key").value = "";
  closeSettings();
  toast("已保存，正在重连…");
};

$("new-session").onclick = () => {
  resetWorkspaceUi();
  clearTranscript("");
  send({ type: "new_session", model: state.model });
};

$("open-commands")?.addEventListener("click", openPalette);

$("toggle-panel")?.addEventListener("click", () => {
  setPanelOpen(!state.panelOpen);
});
$("toggle-board")?.addEventListener("click", () => {
  setBoardOpen(!state.boardOpen, { user: true });
});
$("board-close")?.addEventListener("click", () => {
  setBoardOpen(false, { user: true });
});
$("work-board")?.addEventListener("click", (e) => {
  const back = e.target.closest("[data-studio-back]");
  if (back) {
    state.studioLine = null;
    paintWorkBoard();
    return;
  }
  const floor = e.target.closest("[data-studio-line]");
  if (floor) {
    state.studioLine = Number(floor.dataset.studioLine);
    paintWorkBoard();
  }
});

$("session-title-btn")?.addEventListener("click", () => beginTitleEdit());
$("session-title-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    e.currentTarget.blur();
  }
  if (e.key === "Escape") {
    e.currentTarget.value = state.sessionTitle;
    e.currentTarget.blur();
  }
});
$("session-title-input")?.addEventListener("input", (e) => {
  if (e.currentTarget.value.length > TITLE_MAX) {
    e.currentTarget.value = e.currentTarget.value.slice(0, TITLE_MAX);
  }
});
$("session-title-input")?.addEventListener("blur", (e) => {
  commitSessionTitle(e.currentTarget.value);
});

$("file-filter")?.addEventListener("input", () => {
  state.fileFilter = $("file-filter").value || "";
  renderTree(state.treeEntries);
});

$("file-open-preview")?.addEventListener("click", () => {
  if (state.filePath) loadPreview(state.filePath, { switchTab: true });
});

$("save-version")?.addEventListener("click", () => {
  if (!state.sessionId) {
    toast("先开始一个对话再存档");
    return;
  }
  const note = $("save-note")?.value.trim() || "";
  send({ type: "save_version", sessionId: state.sessionId, note });
  if ($("save-note")) $("save-note").value = "";
});
$("preview-refresh")?.addEventListener("click", () => {
  if (state.runtime?.kind === "app" && state.runtime.port) loadAppPreview({ switchTab: false });
  else if (state.previewPath) loadPreview(state.previewPath, { switchTab: false });
});
$("preview-url-btn")?.addEventListener("click", () => {
  copyPreviewUrl();
});
$("preview-open")?.addEventListener("click", () => {
  const url = currentPreviewUrl();
  if (url) window.open(url, "_blank", "noopener");
});

$("send")?.addEventListener("click", (e) => {
  e.preventDefault();
  $("composer").requestSubmit();
});

function initColumnResize() {
  const root = document.documentElement;
  const minSidebar = 200;
  const maxSidebar = 420;
  const minPanel = 320;
  const maxPanel = 920;

  const parsePx = (name, fallback) => {
    const raw = getComputedStyle(root).getPropertyValue(name).trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
  };

  for (const handle of document.querySelectorAll(".resize-handle")) {
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const kind = handle.dataset.resize;
      const startX = e.clientX;
      const startSidebar = parsePx("--sidebar-w", 260);
      const startPanel = parsePx("--panel-w", 560);
      const startBoard = parsePx("--board-w", 348);
      const startExplorer = parsePx("--explorer-w", 200);
      const body = $("workspace-body");
      const panelClosed = body?.classList.contains("panel-closed");
      const boardClosed = body?.classList.contains("board-closed");

      document.body.classList.add("resizing-col");
      handle.classList.add("active");

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        if (kind === "sidebar") {
          const w = Math.min(maxSidebar, Math.max(minSidebar, startSidebar + dx));
          root.style.setProperty("--sidebar-w", `${w}px`);
        } else if (kind === "panel" && !panelClosed) {
          const w = Math.min(maxPanel, Math.max(minPanel, startPanel - dx));
          root.style.setProperty("--panel-w", `${w}px`);
        } else if (kind === "board" && !boardClosed) {
          const w = Math.min(480, Math.max(280, startBoard - dx));
          root.style.setProperty("--board-w", `${w}px`);
        } else if (kind === "explorer") {
          const pane = $("pane-files");
          const max = Math.max(160, Math.floor((pane?.clientWidth || 420) * 0.55));
          const w = Math.min(max, Math.max(132, startExplorer + dx));
          root.style.setProperty("--explorer-w", `${w}px`);
        }
      };

      const onUp = () => {
        document.body.classList.remove("resizing-col");
        handle.classList.remove("active");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      e.preventDefault();
    });
  }
}
$("slash-btn")?.addEventListener("click", () => {
  closeComposerPops();
  fillPrompt("/");
  renderSlash();
});
$("palette").onclick = (e) => {
  if (e.target.id === "palette") closePalette();
};
let paletteTimer = 0;
$("palette-search").oninput = () => {
  window.clearTimeout(paletteTimer);
  paletteTimer = window.setTimeout(() => renderPalette($("palette-search").value), 60);
};

$("model-select").onchange = () => {
  applyModel($("model-select").value);
};

$("effort-select").onchange = () => {
  applyEffort($("effort-select").value);
};

$("agent-mode-select")?.addEventListener("change", () => {
  applyAgentMode($("agent-mode-select").value);
});

$("permission-select")?.addEventListener("change", () => {
  applyPermissionMode($("permission-select").value);
});

$("composer").onsubmit = (e) => {
  e.preventDefault();
  const text = $("prompt").value.trim();
  if (text) {
    if (text.startsWith("/")) {
      const [name, ...rest] = text.slice(1).split(/\s+/);
      const cmd = findCommand(name);
      if (cmd?.run && cmd.run !== "prompt" && !rest.join(" ").trim()) {
        runCommand(cmd);
        return;
      }
    }
    sendPrompt(text);
    return;
  }
  if (state.busy) stopGeneration();
};

$("prompt").addEventListener("input", () => {
  renderSlash();
  setBusy(state.busy);
});
$("prompt").addEventListener("keydown", (e) => {
  const slashOpen = !$("slash-menu").classList.contains("hidden");
  if (e.key === "Escape") {
    hideSlash();
    closePalette();
    closeComposerPops();
    return;
  }
  if (slashOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    setSlashActive(slashActiveIndex + (e.key === "ArrowDown" ? 1 : -1));
    return;
  }
  if (e.key === "Tab" && slashOpen) {
    e.preventDefault();
    const active = $("slash-menu").querySelector(".slash-item.active");
    if (active) active.click();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    const active = $("slash-menu").querySelector(".slash-item.active");
    if (active && slashOpen) {
      e.preventDefault();
      active.click();
      return;
    }
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

for (const btn of document.querySelectorAll(".tab")) {
  btn.onclick = () => setTab(btn.dataset.tab);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if ($("confirm") && !$("confirm").classList.contains("hidden")) {
      e.preventDefault();
      closeConfirm(false);
      return;
    }
    hideSlash();
    closePalette();
    closeComposerPops();
    closeSessMenu();
    closeSettings();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if ($("palette").classList.contains("hidden")) openPalette();
    else closePalette();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
    e.preventDefault();
    resetWorkspaceUi();
    clearTranscript("");
    send({ type: "new_session", model: state.model });
  }
});

initAccountBar();
fillSelect($("model-select"), DEFAULT_MODELS, "模型");
if (state.model) $("model-select").value = state.model;
if (state.effort) $("effort-select").value = state.effort;
initWelcome();
updateWelcomeVisibility();
renderModes();
renderToolbar();
initColumnResize();
initComposerUi();
updateComposerChrome();
applyRunMode(state.runMode, { persist: false });
persistPermMode("yolo");
setTab("preview", { open: false });
paintWorkBoard();
bindPreviewFrame($("preview-frame"));
paintSessionTitle("");
$("chat-scroller")?.addEventListener(
  "scroll",
  () => {
    if (paintJumpActive._raf) return;
    paintJumpActive._raf = requestAnimationFrame(() => {
      paintJumpActive._raf = 0;
      paintJumpActive();
    });
  },
  { passive: true },
);

bootAuth();
