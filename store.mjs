import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const USERNAME_RE = /^[\u4e00-\u9fffA-Za-z0-9_]{2,20}$/;

function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 32);
  return `${salt.toString("hex")}.${hash.toString("hex")}`;
}

function checkPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || "").split(".");
  if (!saltHex || !hashHex) return false;
  try {
    const hash = scryptSync(String(password), Buffer.from(saltHex, "hex"), 32);
    const expected = Buffer.from(hashHex, "hex");
    return hash.length === expected.length && timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

export function openStore(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS projects (
      session_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title_manual INTEGER NOT NULL DEFAULT 0,
      published_slug TEXT UNIQUE,
      published_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id, updated_at);
  `);

  const insertUser = db.prepare("INSERT INTO users (username, password, created_at) VALUES (?, ?, ?)");
  const findUserByName = db.prepare("SELECT * FROM users WHERE username = ?");
  const findUserById = db.prepare("SELECT * FROM users WHERE id = ?");
  const insertToken = db.prepare("INSERT INTO auth_tokens (token, user_id, created_at) VALUES (?, ?, ?)");
  const findToken = db.prepare("SELECT * FROM auth_tokens WHERE token = ?");
  const deleteToken = db.prepare("DELETE FROM auth_tokens WHERE token = ?");
  const insertProject = db.prepare(
    `INSERT INTO projects (session_id, user_id, title, cwd, title_manual, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateProject = db.prepare(
    `UPDATE projects SET title = ?, cwd = ?, title_manual = ?, published_slug = ?, published_at = ?, updated_at = ?
     WHERE session_id = ?`,
  );
  const findProject = db.prepare("SELECT * FROM projects WHERE session_id = ?");
  const findProjectBySlug = db.prepare("SELECT * FROM projects WHERE published_slug = ?");
    const listProjects = db.prepare("SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC");
    const listAllSessionIds = db.prepare("SELECT session_id FROM projects");
    const deleteProject = db.prepare("DELETE FROM projects WHERE session_id = ? AND user_id = ?");

  function publicUser(row) {
    if (!row) return null;
    return { id: Number(row.id), username: row.username };
  }

  function publicProject(row) {
    if (!row) return null;
    return {
      sessionId: row.session_id,
      userId: Number(row.user_id),
      title: row.title,
      cwd: row.cwd,
      titleManual: Boolean(row.title_manual),
      publishedSlug: row.published_slug || "",
      publishedAt: row.published_at || "",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function createToken(userId) {
    const token = randomBytes(24).toString("base64url");
    insertToken.run(token, userId, nowIso());
    return token;
  }

  return {
    register(username, password) {
      const name = String(username || "").trim();
      const pass = String(password || "");
      if (!USERNAME_RE.test(name)) throw new Error("账号用 2 到 20 个字，中文、字母、数字或下划线。");
      if (pass.length < 6) throw new Error("密码至少 6 位。");
      if (findUserByName.get(name)) throw new Error("这个账号已经有人用了。");
      const result = insertUser.run(name, hashPassword(pass), nowIso());
      const user = publicUser(findUserById.get(Number(result.lastInsertRowid)));
      return { user, token: createToken(user.id) };
    },

    login(username, password) {
      const name = String(username || "").trim();
      const row = findUserByName.get(name);
      if (!row || !checkPassword(password, row.password)) throw new Error("账号或密码不对。");
      return { user: publicUser(row), token: createToken(Number(row.id)) };
    },

    ensureUser(username, password) {
      const name = String(username || "").trim();
      const pass = String(password || "");
      const existing = findUserByName.get(name);
      if (existing) return publicUser(existing);
      return this.register(name, pass).user;
    },

    userByToken(token) {
      if (!token) return null;
      const row = findToken.get(String(token));
      if (!row) return null;
      return publicUser(findUserById.get(Number(row.user_id)));
    },

    logout(token) {
      if (token) deleteToken.run(token);
    },

    upsertProject(entry) {
      const prev = findProject.get(entry.sessionId);
      const next = {
        session_id: entry.sessionId,
        user_id: entry.userId ?? (prev ? Number(prev.user_id) : 0),
        title: entry.title || prev?.title || "新对话",
        cwd: entry.cwd || prev?.cwd || "",
        title_manual:
          entry.titleManual != null ? (entry.titleManual ? 1 : 0) : prev?.title_manual || 0,
        published_slug: entry.publishedSlug !== undefined ? entry.publishedSlug || null : prev?.published_slug,
        published_at: entry.publishedAt !== undefined ? entry.publishedAt || null : prev?.published_at,
        created_at: prev?.created_at || nowIso(),
        updated_at: entry.updatedAt || prev?.updated_at || nowIso(),
      };
      if (prev) {
        updateProject.run(
          next.title,
          next.cwd,
          next.title_manual,
          next.published_slug,
          next.published_at,
          next.updated_at,
          next.session_id,
        );
      } else {
        insertProject.run(
          next.session_id,
          next.user_id,
          next.title,
          next.cwd,
          next.title_manual,
          next.created_at,
          next.updated_at,
        );
      }
      return publicProject(findProject.get(entry.sessionId));
    },

    projectBySession(sessionId) {
      return publicProject(findProject.get(String(sessionId || "")));
    },

    projectBySlug(slug) {
      return publicProject(findProjectBySlug.get(String(slug || "")));
    },

    listUserProjects(userId) {
      return listProjects.all(Number(userId)).map(publicProject);
    },

    listAllSessionIds() {
      return listAllSessionIds.all().map((row) => String(row.session_id));
    },

    deleteUserProject(userId, sessionId) {
      deleteProject.run(String(sessionId || ""), Number(userId));
    },
  };
}
