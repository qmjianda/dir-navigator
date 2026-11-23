// ============================================================
// app-preload.js —— 自定义窗口（目录导航器）桥接层
// 职责：向前端 app.html 暴露文件系统枚举、打开、对话框、存储等本地能力。
// 运行环境：Node.js 20 + uTools API（自定义窗口上下文）。
// 遵循「最小暴露原则」：只暴露前端实际需要的、经过封装的接口。
// ============================================================

const fs = require("node:fs");
const path = require("node:path");
const { clipboard, contextBridge } = require("electron");

const CONFIG_ID = "dirnav:config";
const DRIVES_SENTINEL = "__DRIVES__"; // 虚拟「此电脑」视图标识

// ------------------------------------------------------------
// 工具函数
// ------------------------------------------------------------

// 自然排序（数字感知、大小写不敏感），贴近资源管理器的排序习惯
function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

// 常见的 Windows 噪音项，默认隐藏
function isDenylisted(name) {
  const n = String(name).toUpperCase();
  return (
    n === "DESKTOP.INI" ||
    n === "THUMBS.DB" ||
    n === "$RECYCLE.BIN" ||
    n === "SYSTEM VOLUME INFORMATION" ||
    n === "RECYCLER" ||
    n === "PAGEFILE.SYS" ||
    n === "HIBERFIL.SYS" ||
    n === "SWAPFILE.SYS"
  );
}

/**
 * 将绝对路径拆分为逐级片段，用于渲染面包屑。
 * @param {string} p 绝对路径，如 C:\Users\you\Work
 * @returns {Array<{name:string, path:string}>} 每级名称及其完整路径
 */
function splitPath(p) {
  try {
    const norm = path.normalize(String(p || ""));
    const parsed = path.parse(norm);
    const parts = [];
    const root = parsed.root || "";
    if (root) parts.push({ name: root, path: root });
    let acc = root;
    const rel = norm.slice(root.length);
    if (rel) {
      for (const seg of rel.split(/[\\/]+/)) {
        if (!seg) continue;
        acc = path.join(acc, seg);
        parts.push({ name: seg, path: acc });
      }
    }
    if (parts.length === 0 && norm) {
      parts.push({ name: norm, path: norm });
    }
    return parts;
  } catch (e) {
    return [{ name: String(p || ""), path: String(p || "") }];
  }
}

function statPath(p) {
  try {
    const st = fs.statSync(p);
    return {
      exists: true,
      isDir: st.isDirectory(),
      isFile: st.isFile(),
      size: st.size,
      mtimeMs: st.mtimeMs
    };
  } catch (e) {
    return { exists: false, code: e.code || "", message: e.message || String(e) };
  }
}

/**
 * 枚举目录内容。
 * @param {string} dirPath 绝对路径，或虚拟标识 __DRIVES__
 * @param {{showHidden?:boolean, showFiles?:boolean}} opts
 * @returns {{ok:true, path:string, items:Array, drives?:boolean} | {ok:false, path:string, code:string, message:string}}
 */
function listDir(dirPath, opts) {
  opts = opts || {};
  const showHidden = !!opts.showHidden;
  const showFiles = opts.showFiles !== false;
  const p = String(dirPath || "");

  // 「此电脑」虚拟视图：枚举所有驱动器
  if (p === DRIVES_SENTINEL) {
    const drives = [];
    for (let c = 65; c <= 90; c++) {
      const letter = String.fromCharCode(c);
      const root = letter + ":\\";
      try {
        const st = fs.statSync(root);
        if (st) drives.push({ name: letter + ":", path: root, isDir: true, isFile: false, isLink: false, isDrive: true });
      } catch (e) { /* 该盘符不存在或不可用，跳过 */ }
    }
    drives.sort(function (a, b) { return naturalCompare(a.name, b.name); });
    return { ok: true, path: p, items: drives, drives: true };
  }

  try {
    const entries = fs.readdirSync(p, { withFileTypes: true });
    const items = [];
    for (const e of entries) {
      const name = e.name;
      let isDir, isFile, isLink = false;
      if (e.isSymbolicLink && e.isSymbolicLink()) {
        isLink = true;
        const st = statPath(path.join(p, name));
        isDir = st.exists && st.isDir;
        isFile = st.exists && st.isFile;
      } else {
        isDir = e.isDirectory();
        isFile = e.isFile();
      }
      if (!isDir && !isFile) continue; // 跳过 socket 等特殊类型
      if (!showFiles && isFile) continue;
      if (!showHidden && name.startsWith(".")) continue;
      if (!showHidden && isDenylisted(name)) continue;
      items.push({ name: name, path: path.join(p, name), isDir: isDir, isFile: isFile, isLink: isLink });
    }
    items.sort(function (a, b) {
      return (b.isDir - a.isDir) || naturalCompare(a.name, b.name);
    });
    return { ok: true, path: p, items: items };
  } catch (err) {
    return {
      ok: false,
      path: p,
      code: err.code || "",
      message: err.message || String(err)
    };
  }
}

// ------------------------------------------------------------
// 暴露给前端的服务接口
// ------------------------------------------------------------
const servicesApi = {
  version: 1,

  // ---- 文件系统 ----
  listDir: listDir,
  listDrives: function () {
    const r = listDir(DRIVES_SENTINEL, {});
    return r.items || [];
  },
  splitPath: splitPath,
  stat: statPath,

  // ---- 打开 / 定位 / 复制 ----
  openPath: function (p) {
    // shellOpenPath 无返回值；失败只能靠调用前的 stat 预检发现
    utools.shellOpenPath(String(p));
    return true;
  },
  showItem: function (p) {
    utools.shellShowItemInFolder(String(p));
    return true;
  },
  copyText: function (t) {
    clipboard.writeText(String(t == null ? "" : t));
    return true;
  },

  // ---- 对话框 ----
  pickFolder: function (defaultPath) {
    const opts = {
      title: "选择文件夹",
      properties: ["openDirectory"]
    };
    if (defaultPath) opts.defaultPath = defaultPath;
    const arr = utools.showOpenDialog(opts);
    if (Array.isArray(arr) && arr.length) return arr[0];
    return null;
  },
  getCurrentFolder: function () {
    // 读取当前活动资源管理器窗口的路径（非资源管理器时返回空串）
    try {
      const r = utools.readCurrentFolderPath();
      if (r && typeof r.then === "function") {
        return r.then(function (p) { return p || ""; }).catch(function () { return ""; });
      }
      return Promise.resolve(typeof r === "string" ? r : "");
    } catch (e) {
      return Promise.resolve("");
    }
  },

  // ---- 系统路径 ----
  getPath: function (name) {
    try { return utools.getPath(name); } catch (e) { return ""; }
  },

  // ---- 配置持久化（utools.db 文档型存储） ----
  getConfig: function () {
    return utools.db.get(CONFIG_ID) || null;
  },
  saveConfig: function (doc) {
    let res = utools.db.put(doc);
    if (res && res.ok) {
      doc._rev = res.rev;
      return true;
    }
    // _rev 过期（别的窗口/实例已改过同一文档）时拉最新 rev 重试一次，
    // 否则书签和设置会静默丢失。
    try {
      const cur = utools.db.get(doc._id);
      if (cur && cur._rev) {
        doc._rev = cur._rev;
        res = utools.db.put(doc);
        if (res && res.ok) {
          doc._rev = res.rev;
          return true;
        }
      }
    } catch (e) { /* 忽略 */ }
    return false;
  },

  // ---- 插件生命周期 ----
  exitPlugin: function () {
    try {
      if (typeof utools.outPlugin === "function") utools.outPlugin();
    } catch (e) { /* 忽略 */ }
  },

  // ---- 常量 ----
  demo: false, // 真实桥接永远不是演示模式；demo-services.js 里为 true
  DRIVES_SENTINEL: DRIVES_SENTINEL
};

// ------------------------------------------------------------
// 挂载到页面
// ------------------------------------------------------------
// Electron 20+ 默认 contextIsolation=true：此时 preload 里的 window 与页面
// 的 window 是两个隔离上下文，直接赋值页面看不到（app.js 会误报「桥接层加载
// 失败」）。所以两条腿走路：开启隔离时用 contextBridge，否则直接赋值。
// preload.js 里已显式关闭隔离，这里仍做兼容，避免宿主版本差异导致白屏。
(function exposeServices() {
  const isolated = typeof process !== "undefined" && process && process.contextIsolated;
  if (isolated && typeof contextBridge !== "undefined" && contextBridge &&
      typeof contextBridge.exposeInMainWorld === "function") {
    try {
      contextBridge.exposeInMainWorld("services", servicesApi);
      return;
    } catch (e) { /* 落到直接赋值 */ }
  }
  try {
    window.services = servicesApi;
  } catch (e) { /* 忽略 */ }
})();
