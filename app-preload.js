// ============================================================
// app-preload.js —— 插件主界面桥接层
// 职责：向前端 app.html 暴露文件系统枚举、打开、对话框、存储等本地能力，
//       并处理 uTools 入口（关键词、资源管理器文件、收藏指令）。
// 运行环境：Node.js 20 + uTools API（主窗口 BrowserView 上下文）。
// 遵循「最小暴露原则」：只暴露前端实际需要的、经过封装的接口。
// ============================================================

const fs = require("node:fs");
const path = require("node:path");
const { clipboard, contextBridge } = require("electron");
const bookmarkStore = require("./bookmark-store.js");

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
  DRIVES_SENTINEL: DRIVES_SENTINEL,

  // ---- 入口目标（onPluginEnter 读取到的路径/高亮） ----
  // 页面初始化可能晚于 onPluginEnter，所以先用队列接住；页面就绪后注册
  // onEntry 就能立刻拿到，避免入口目标被丢弃或与默认导航互相覆盖。
  onEntry: function (cb) {
    if (typeof cb !== "function") return function () {};
    entryListeners.push(cb);
    if (pendingEntry) {
      const entry = pendingEntry;
      pendingEntry = null;
      try { cb(entry); } catch (e) { /* 页面自己的异常不应影响入口 */ }
    }
    return function () {
      const i = entryListeners.indexOf(cb);
      if (i >= 0) entryListeners.splice(i, 1);
    };
  }
};

// 入口目标队列：只保留最新一次，避免快速连续触发时页面跳来跳去
let pendingEntry = null;
const entryListeners = [];

function deliverEntry(openPath, highlight, refresh) {
  const entry = { path: openPath || null, highlight: highlight || null, refresh: !!refresh };
  if (entryListeners.length) {
    entryListeners.slice().forEach(function (cb) {
      try { cb(entry); } catch (e) { /* 忽略单个监听器异常 */ }
    });
    return;
  }
  pendingEntry = entry;
}

function showAndOpen(openPath, highlight, refresh) {
  deliverEntry(openPath, highlight, refresh);
  try {
    if (typeof utools.showMainWindow === "function") utools.showMainWindow();
  } catch (e) { /* 已在独立窗口时可能不可用，页面仍然能收到入口 */ }
}

// ------------------------------------------------------------
// 挂载到页面
// ------------------------------------------------------------
// Electron 20+ 默认 contextIsolation=true：此时 preload 里的 window 与页面
// 的 window 是两个隔离上下文，直接赋值页面看不到（app.js 会误报「桥接层加载
// 失败」）。所以两条腿走路：开启隔离时用 contextBridge，否则直接赋值。
// 主界面现在由 uTools 主窗口承载，隔离开关由宿主决定，这里做兼容处理。
(function exposeServices() {
  const hasBridge = typeof contextBridge !== "undefined" && contextBridge &&
    typeof contextBridge.exposeInMainWorld === "function";
  if (hasBridge) {
    try {
      contextBridge.exposeInMainWorld("services", servicesApi);
      return;
    } catch (e) { /* 未开启隔离时会抛错，落到直接赋值 */ }
  }
  try {
    window.services = servicesApi;
  } catch (e) { /* 忽略 */ }
})();

// ------------------------------------------------------------
// 收藏指令：资源管理器前台 -> 写书签 -> 打开导航器并定位
// ------------------------------------------------------------
function runCollectCommand() {
  let notified = false;
  function notify(text) {
    if (notified) return;
    notified = true;
    try { utools.showNotification(text); } catch (e) { /* 忽略系统通知异常 */ }
  }

  bookmarkStore.collectCurrentFolder(utools).then(function (res) {
    let target = null;
    if (res.ok) {
      notify("已收藏：" + res.bookmark.name);
      target = res.bookmark.path;
    } else if (res.reason === "duplicate") {
      notify("已在书签中：" + (res.bookmark && res.bookmark.name ? res.bookmark.name : "该文件夹"));
      target = res.bookmark && res.bookmark.path ? res.bookmark.path : null;
    } else if (res.reason === "no-folder") {
      notify("没有读到资源管理器文件夹，请先在资源管理器中打开一个文件夹");
    } else if (res.reason === "not-dir") {
      notify("当前路径不是可收藏的文件夹");
    } else {
      notify("收藏失败，请重试");
    }
    // 收藏不是终点：打开导航器，成功/重复时直接定位到目标目录。
    // refresh=true 让页面重读配置，刚写入的书签才会出现在左栏。
    // 失败时也打开（停在上次目录），让用户能继续手动选择。
    showAndOpen(target, null, true);
  }).catch(function () {
    notify("收藏失败，请重试");
    showAndOpen(null, null, true);
  });
}

// ------------------------------------------------------------
// 插件入口
// ------------------------------------------------------------
utools.onPluginEnter(function (action) {
  if (action && action.code === "dirnav-collect") {
    runCollectCommand();
    return;
  }

  // 「在目录导航器中打开」：目录直接定位，文件定位父目录并高亮
  if (action && action.type === "files" && Array.isArray(action.payload) && action.payload.length) {
    const dir = action.payload.find(function (x) {
      return x && x.isDirectory && typeof x.path === "string" && x.path;
    });
    const file = action.payload.find(function (x) {
      return x && x.isFile && typeof x.path === "string" && x.path;
    });
    if (dir) {
      showAndOpen(dir.path, null);
      return;
    }
    if (file) {
      showAndOpen(path.dirname(file.path),
        typeof file.name === "string" && file.name ? file.name : path.basename(file.path));
      return;
    }
  }

  // 普通关键词入口：app.html 已经是插件主页面，直接显示即可。
  // 页面 init() 会按 lastPath / 首个书签恢复上次位置。
});
