function escapeHtml(src) {
  return String(src)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function span(kind, text) {
  return `<span class="tok-${kind}">${escapeHtml(text)}</span>`;
}

export function languageOf(filePath) {
  const ext = String(filePath || "").split(".").pop()?.toLowerCase() || "";
  if (["html", "htm", "xml", "svg"].includes(ext)) return "html";
  if (ext === "css") return "css";
  if (["js", "mjs", "cjs", "ts"].includes(ext)) return "js";
  if (ext === "json") return "json";
  if (["md", "markdown"].includes(ext)) return "md";
  return "text";
}

export function highlight(code, lang) {
  const src = String(code || "");
  if (lang === "html") return highlightHtml(src);
  if (lang === "css") return highlightCss(src);
  if (lang === "js" || lang === "json") return highlightJs(src);
  if (lang === "md") return highlightMd(src);
  return escapeHtml(src);
}

function highlightHtml(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      const j = end < 0 ? src.length : end + 3;
      out += span("c", src.slice(i, j));
      i = j;
      continue;
    }
    if (src[i] === "<") {
      const end = src.indexOf(">", i);
      const j = end < 0 ? src.length : end + 1;
      out += colorTag(src.slice(i, j));
      i = j;
      continue;
    }
    const next = src.indexOf("<", i);
    const j = next < 0 ? src.length : next;
    out += escapeHtml(src.slice(i, j));
    i = j;
  }
  return out;
}

function colorTag(tag) {
  return tag.replace(
    /^(<\/?)([a-zA-Z0-9:-]+)([\s\S]*?)(\/?>)$/,
    (_, open, name, rest, close) =>
      `${escapeHtml(open)}${span("tag", name)}${colorAttrs(rest)}${escapeHtml(close)}`,
  );
}

function colorAttrs(rest) {
  return rest.replace(
    /([a-zA-Z_:][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'=<>`]+)?/g,
    (_, name, eq, val) => `${span("n", name)}${escapeHtml(eq)}${val ? span("s", val) : ""}`,
  );
}

function highlightCss(src) {
  return tokenize(src, [
    [/\/\*[\s\S]*?\*\//y, "c"],
    [/'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"/y, "s"],
    [/#[0-9a-fA-F]{3,8}\b/y, "num"],
    [/-?\d[\d.]*[%a-z]*/y, "num"],
    [/[.#]?[a-zA-Z_-][\w-]*/y, "n"],
  ]);
}

const JS_KW =
  /^(?:break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|function|if|import|in|instanceof|let|new|return|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|async|await|from|of|true|false|null|undefined)$/;

function highlightJs(src) {
  return tokenize(src, [
    [/\/\*[\s\S]*?\*\//y, "c"],
    [/\/\/.*/y, "c"],
    [/`(?:\\[\s\S]|[^\\`])*`/y, "s"],
    [/'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"/y, "s"],
    [/\b\d[\d_]*(\.[\d_]+)?\b/y, "num"],
    [/[A-Za-z_$][\w$]*/y, (m, i, src) => {
      if (JS_KW.test(m)) return "k";
      let j = i + m.length;
      while (src[j] === " " || src[j] === "\t") j += 1;
      return src[j] === "(" ? "fn" : "n";
    }],
  ]);
}

function highlightMd(src) {
  return src
    .split("\n")
    .map((line) => {
      if (/^#{1,6}\s/.test(line)) return span("k", line);
      if (/^```/.test(line)) return span("t", line);
      if (/^\s*[-*]\s/.test(line)) return `${span("t", line.slice(0, line.indexOf("-") >= 0 ? line.indexOf("-") + 1 : 1))}${escapeHtml(line.replace(/^\s*[-*]\s?/, " "))}`;
      return escapeHtml(line).replace(/`([^`]+)`/g, '<span class="tok-s">`$1`</span>');
    })
    .join("\n");
}

function tokenize(src, rules) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    let hit = null;
    for (const [re, kind] of rules) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (m && m.index === i) {
        const type = typeof kind === "function" ? kind(m[0], i, src) : kind;
        hit = span(type, m[0]);
        i += m[0].length;
        break;
      }
    }
    if (hit) {
      out += hit;
      continue;
    }
    out += escapeHtml(src[i]);
    i += 1;
  }
  return out;
}
