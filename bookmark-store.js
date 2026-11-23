// ============================================================
// bookmark-store.js —— 书签配置的 Node 侧共享逻辑
// 职责：读取/写入 dirnav:config、路径去重、追加书签、读取资源管理器当前目录。
// 使用方：preload.js（主窗口指令）、可选的其它 Node 侧入口。
// 说明：这是主进程/预加载环境模块，不要在 app.html 里用 <script> 引用。
// ============================================================

"use strict";

const fs = require("node:fs");

const CONFIG_ID = "dirnav:config";
const DRIVES_SENTINEL = "__DRIVES__";
// 与 app.js 的 BOOKMARK_COLORS 保持一致
const BOOKMARK_COLORS = ["#0067c0", "#c2395f", "#2e9e5b", "#d97706", "#7a5cd6", "#0e7490"];

function normPath(p) {
  return String(p || "").replace(/[\\/]+$/, "").toLowerCase();
}

// 书签默认名称：盘符原样，其余取最后一段
function folderName(p) {
  if (p === DRIVES_SENTINEL) return "此电脑";
  const s = String(p || "").replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(s)) return s.toUpperCase();
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

function defaultConfig() {
  return {
    _id: CONFIG_ID,
    version: 1,
    anchors: [],
    settings: { showFiles: true, showHidden: false, colWidth: 212, lastPath: "" }
  };
}

function normalizeConfig(doc) {
  const out = doc && typeof doc === "object" ? doc : defaultConfig();
  out._id = CONFIG_ID;
  out.version = out.version || 1;
  if (!Array.isArray(out.anchors)) out.anchors = [];
  out.settings = Object.assign(
    { showFiles: true, showHidden: false, colWidth: 212, lastPath: "" },
    out.settings || {}
  );
  return out;
}

function readConfig(db) {
  try {
    return normalizeConfig(db.get(CONFIG_ID));
  } catch (e) {
    return defaultConfig();
  }
}

// 写入失败时用最新 _rev 重试一次；仍失败则交给调用方重读合并
function putConfig(db, doc) {
  try {
    let res = db.put(doc);
    if (res && res.ok) {
      doc._rev = res.rev;
      return true;
    }
    const cur = db.get(CONFIG_ID);
    if (cur && cur._rev) {
      doc._rev = cur._rev;
      res = db.put(doc);
      if (res && res.ok) {
        doc._rev = res.rev;
        return true;
      }
    }
  } catch (e) { /* 交给调用方处理 */ }
  return false;
}

function findDuplicate(doc, p) {
  const key = normPath(p);
  return doc.anchors.find(function (a) { return normPath(a.path) === key; }) || null;
}

function pickColor(doc) {
  const used = doc.anchors.map(function (a) { return a.color; });
  for (let i = 0; i < BOOKMARK_COLORS.length; i++) {
    if (used.indexOf(BOOKMARK_COLORS[i]) < 0) return BOOKMARK_COLORS[i];
  }
  return BOOKMARK_COLORS[doc.anchors.length % BOOKMARK_COLORS.length];
}

function addBookmark(doc, p, opts) {
  opts = opts || {};
  const maxOrder = doc.anchors.reduce(function (m, a) {
    return Math.max(m, Number(a.order) || 0);
  }, -1);
  const now = Date.now();
  const bookmark = {
    id: now.toString(36) + Math.random().toString(36).slice(2, 8),
    name: opts.name || folderName(p),
    path: p,
    color: opts.color || pickColor(doc),
    pinned: false,
    order: maxOrder + 1,
    createdAt: now,
    lastVisited: now
  };
  doc.anchors.push(bookmark);
  return bookmark;
}

/**
 * 读取当前活动的资源管理器文件夹并直接加入书签。
 * 返回 { ok:true, bookmark, path } 或 { ok:false, reason, bookmark? }；
 * reason: no-folder / not-dir / duplicate / save-failed。
 */
function collectCurrentFolder(utools) {
  return Promise.resolve()
    .then(function () { return utools.readCurrentFolderPath(); })
    .catch(function () { return ""; })
    .then(function (raw) {
      const p = String(raw == null ? "" : raw).trim();
      if (!p || p === DRIVES_SENTINEL) return { ok: false, reason: "no-folder" };

      let st;
      try { st = fs.statSync(p); } catch (e) { return { ok: false, reason: "not-dir" }; }
      if (!st || !st.isDirectory()) return { ok: false, reason: "not-dir" };

      // 写入冲突时重读再判重，避免并发下产生重复书签
      for (let i = 0; i < 3; i++) {
        const doc = readConfig(utools.db);
        const dup = findDuplicate(doc, p);
        if (dup) return { ok: false, reason: "duplicate", bookmark: dup };
        const bookmark = addBookmark(doc, p);
        if (putConfig(utools.db, doc)) return { ok: true, bookmark: bookmark, path: p };
      }
      return { ok: false, reason: "save-failed" };
    });
}

module.exports = {
  CONFIG_ID: CONFIG_ID,
  DRIVES_SENTINEL: DRIVES_SENTINEL,
  BOOKMARK_COLORS: BOOKMARK_COLORS,
  normPath: normPath,
  folderName: folderName,
  defaultConfig: defaultConfig,
  normalizeConfig: normalizeConfig,
  readConfig: readConfig,
  putConfig: putConfig,
  findDuplicate: findDuplicate,
  addBookmark: addBookmark,
  collectCurrentFolder: collectCurrentFolder
};
