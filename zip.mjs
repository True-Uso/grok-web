import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const SKIP = new Set(["node_modules", ".git", "target", "dist", "build", ".next", "__pycache__"]);
const HIDDEN = new Set(["AGENTS.md"]);

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

async function walk(root, rel, files) {
  const dir = path.join(root, rel);
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    if (item.name.startsWith(".") && item.name !== ".gitignore") continue;
    if (SKIP.has(item.name) || HIDDEN.has(item.name)) continue;
    const child = rel ? `${rel}/${item.name}` : item.name;
    if (item.isDirectory()) await walk(root, child, files);
    else if (item.isFile()) files.push(child.replaceAll("\\", "/"));
  }
}

export async function zipDirectory(root) {
  const names = [];
  await walk(root, "", names);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of names) {
    const data = await readFile(path.join(root, name));
    const info = await stat(path.join(root, name));
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const dosTime = 0;
    const local = Buffer.concat([
      Buffer.from("PK\u0003\u0004"),
      u16(20),
      u16(0),
      u16(0),
      u16(dosTime),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      data,
    ]);
    const central = Buffer.concat([
      Buffer.from("PK\u0001\u0002"),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(dosTime),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(info.isFile() ? 0 : 0),
      u32(offset),
      nameBuf,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.concat([
    Buffer.from("PK\u0005\u0006"),
    u16(0),
    u16(0),
    u16(names.length),
    u16(names.length),
    u32(centralBuf.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralBuf, end]);
}

export function safeZipName(title) {
  const base = String(title || "project")
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 40);
  return `${base || "project"}.zip`;
}
