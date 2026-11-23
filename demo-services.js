// ============================================================
// demo-services.js —— 浏览器演示用桥接层
// 作用：在没有 uTools（即没有 preload 注入 window.services）时，
//       用一棵内存目录树顶替真实文件系统，让 app.html 可以直接
//       双击用浏览器打开、逐项验证交互与视觉。
// 注意：在 uTools 里 window.services 已由 app-preload.js 提供，
//       本文件第一行就会直接返回，绝不覆盖真实桥接。
// ============================================================

(function () {
  "use strict";

  if (window.services) return; // 真实环境（uTools）下不生效
  // 双保险：只有「本地文件直开」或显式加 ?demo=1 时才模拟。
  // 万一 uTools 里桥接层加载失败，也宁可显示错误提示，不把假数据当真目录。
  if (location.protocol !== "file:" && location.search.indexOf("demo=1") < 0) return;

  // ------------------------------------------------------------
  // 演示目录树（嵌套写，加载时展平成路径表）
  // ------------------------------------------------------------
  const C_DRIVE = {
    dirs: {
      Users: {
        dirs: {
          you: {
            dirs: {
              Work: {
                dirs: {
                  "client-2024": {
                    dirs: {
                      src: {
                        dirs: {
                          components: {
                            files: ["Button.tsx", "DataTable.tsx", "LineChart.tsx", "index.ts"]
                          },
                          utils: { files: ["format.ts", "request.ts"] },
                          assets: { files: ["logo.svg", "icons.svg"] }
                        },
                        files: ["main.tsx", "App.tsx", "vite.config.ts"]
                      },
                      docs: { files: ["需求说明.docx", "接口文档.md", "会议纪要.md"] },
                      assets: { files: ["banner.png", "mockup.png"] }
                    },
                    files: ["package.json", "tsconfig.json", ".gitignore"]
                  },
                  "client-2025": {
                    dirs: {
                      design: { files: ["首页.fig", "配色规范.md"] },
                      src: { files: ["main.ts", "router.ts"] }
                    },
                    files: ["README.md"]
                  },
                  "内部文档": { files: ["周报 2024-W12.md", "预算.xlsx"] }
                }
              },
              Documents: {
                dirs: {
                  "合同": { files: ["2024 采购合同.pdf", "保密协议.pdf"] },
                  "发票": { files: ["1月.pdf", "2月.pdf"] }
                },
                files: ["简历.pdf", "笔记.md"]
              },
              Downloads: { files: ["setup.exe", "report.zip", "旅行照片.jpg"] },
              Pictures: {
                dirs: {
                  "截图": { files: ["截图 2024-11-20.png", "截图 2024-11-21.png"] },
                  "2024 旅行": { files: ["IMG_0412.jpg", "IMG_0413.jpg"] }
                }
              },
              Desktop: { files: ["待办.txt"] },
              AppData: { dirs: { Local: { files: ["temp.log"] } } },
              ".ssh": { files: ["config", "id_rsa"] }
            }
          },
          Public: { files: ["公共文档.txt"] }
        }
      },
      "Program Files": { dirs: { "Common Files": {} } },
      Windows: { dirs: { System32: {} } }
    },
    files: ["pagefile.sys"]
  };

  const D_DRIVE = {
    dirs: {
      "素材库": {
        dirs: {
          "图片": { files: ["hero-01.png", "hero-02.png", "纹理.jpg"] },
          "视频": { files: ["demo.mp4"] },
          "字体": { files: ["HarmonyOS Sans.ttf"] }
        },
        files: ["索引.md"]
      },
      "备份": { files: ["2023-全量.zip"] }
    }
  };

  const TREE = {}; // 归一化路径 -> { dirs:[], files:[] }

  const DRIVES_SENTINEL = "__DRIVES__";
  const DRIVE_LETTERS = ["C", "D"];

  function normKey(p) {
    let s = String(p == null ? "" : p).replace(/\//g, "\\").replace(/\\+/g, "\\");
    if (/^[A-Za-z]:$/.test(s)) s += "\\";
    if (s.length > 3 && s.endsWith("\\")) s = s.slice(0, -1);
    if (/^[A-Za-z]:\\$/.test(s)) s = s.slice(0, 2) + "\\";
    return s.toLowerCase();
  }

  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }

  function join(dirPath, name) {
    const base = String(dirPath || "");
    return base.endsWith("\\") ? base + name : base + "\\" + name;
  }

  // 把嵌套树展平成「路径 -> 直接子项」表
  function flatten(node, dirPath) {
    const entry = { dirs: [], files: [] };
    const dirs = node.dirs || {};
    const files = node.files || [];
    Object.keys(dirs).forEach(function (name) {
      entry.dirs.push(name);
      flatten(dirs[name], join(dirPath, name));
    });
    files.forEach(function (name) { entry.files.push(name); });
    TREE[normKey(dirPath)] = entry;
  }

  flatten(C_DRIVE, "C:\\");
  flatten(D_DRIVE, "D:\\");

  // ------------------------------------------------------------
  // 演示提示（复用 app.css 的 toast 样式）
  // ------------------------------------------------------------
  let demoToastTimer = null;
  function demoToast(msg) {
    // 优先复用 app.js 的 toast，保持图标/配色/时长一致
    if (typeof window.__dirnavToast === "function") { window.__dirnavToast(msg); return; }
    const el = document.getElementById("toast");
    if (!el) return;
    clearTimeout(demoToastTimer);
    el.textContent = msg;
    el.className = "toast show";
    demoToastTimer = setTimeout(function () { el.className = "toast"; }, 2400);
  }

  // 与 app-preload.js 保持一致的噪音项黑名单
  const DENYLIST = ["DESKTOP.INI", "THUMBS.DB", "$RECYCLE.BIN", "SYSTEM VOLUME INFORMATION",
    "RECYCLER", "PAGEFILE.SYS", "HIBERFIL.SYS", "SWAPFILE.SYS"];

  function isDenylisted(name) {
    return DENYLIST.indexOf(String(name).toUpperCase()) >= 0;
  }

  // ------------------------------------------------------------
  // 文件系统（与 app-preload.js 保持完全相同的返回结构）
  // ------------------------------------------------------------
  function listDir(dirPath, opts) {
    opts = opts || {};
    const showHidden = !!opts.showHidden;
    const showFiles = opts.showFiles !== false;
    const p = String(dirPath || "");

    if (p === DRIVES_SENTINEL) {
      const items = DRIVE_LETTERS.map(function (letter) {
        return { name: letter + ":", path: letter + ":\\", isDir: true, isFile: false, isLink: false, isDrive: true };
      });
      return { ok: true, path: p, items: items, drives: true };
    }

    const node = TREE[normKey(p)];
    if (!node) {
      return { ok: false, path: p, code: "ENOENT", message: "系统找不到指定的路径。" };
    }

    const items = [];
    node.dirs.slice().sort(naturalCompare).forEach(function (name) {
      if (!showHidden && name.charAt(0) === ".") return;
      if (!showHidden && isDenylisted(name)) return;
      items.push({ name: name, path: join(p, name), isDir: true, isFile: false, isLink: false });
    });
    if (showFiles) {
      node.files.slice().sort(naturalCompare).forEach(function (name) {
        if (!showHidden && name.charAt(0) === ".") return;
        if (!showHidden && isDenylisted(name)) return;
        items.push({ name: name, path: join(p, name), isDir: false, isFile: true, isLink: false });
      });
    }
    return { ok: true, path: p, items: items };
  }

  function splitPath(p) {
    const norm = String(p || "").replace(/\//g, "\\").replace(/\\+/g, "\\");
    const m = /^([A-Za-z]:\\)(.*)$/.exec(norm);
    if (!m) return [{ name: norm, path: norm }];
    const parts = [{ name: m[1], path: m[1] }];
    const rest = m[2].replace(/\\$/, "");
    if (rest) {
      let acc = m[1];
      rest.split("\\").forEach(function (seg) {
        if (!seg) return;
        acc = acc.endsWith("\\") ? acc + seg : acc + "\\" + seg;
        parts.push({ name: seg, path: acc });
      });
    }
    return parts;
  }

  function stat(p) {
    const key = normKey(p);
    if (TREE[key]) return { exists: true, isDir: true, isFile: false, size: 0, mtimeMs: Date.now() };
    // 是某个目录下的文件？
    const parentKey = normKey(String(p || "").replace(/\\[^\\]+$/, ""));
    const parent = TREE[parentKey];
    const name = String(p || "").split("\\").pop();
    if (parent && parent.files.indexOf(name) >= 0) {
      return { exists: true, isDir: false, isFile: true, size: 20480, mtimeMs: Date.now() };
    }
    return { exists: false, code: "ENOENT", message: "系统找不到指定的路径。" };
  }

  // ------------------------------------------------------------
  // 配置持久化（浏览器里用 localStorage，等价于 utools.db）
  // ------------------------------------------------------------
  const LS_KEY = "dirnav:demo:config";

  function seedConfig() {
    const now = Date.now();
    return {
      _id: "dirnav:config",
      version: 1,
      anchors: [
        { id: "a-work", name: "Work", path: "C:\\Users\\you\\Work", color: "#0067c0", pinned: true, order: 0, createdAt: now, lastVisited: now },
        { id: "a-doc", name: "文档", path: "C:\\Users\\you\\Documents", color: "#c2395f", pinned: false, order: 1, createdAt: now, lastVisited: now },
        { id: "a-dl", name: "下载", path: "C:\\Users\\you\\Downloads", color: "#2e9e5b", pinned: false, order: 2, createdAt: now, lastVisited: now },
        { id: "a-pic", name: "截图", path: "C:\\Users\\you\\Pictures\\截图", color: "#d97706", pinned: false, order: 3, createdAt: now, lastVisited: now },
        { id: "a-media", name: "素材库", path: "D:\\素材库", color: "#7a5cd6", pinned: false, order: 4, createdAt: now, lastVisited: now }
      ],
      settings: { showFiles: true, showHidden: false, colWidth: 212, lastPath: "C:\\Users\\you\\Work" }
    };
  }

  function getConfig() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) {
        const doc = seedConfig();
        localStorage.setItem(LS_KEY, JSON.stringify(doc));
        return doc;
      }
      const doc = JSON.parse(raw);
      if (!doc || !Array.isArray(doc.anchors)) {
        const fresh = seedConfig();
        try { localStorage.setItem(LS_KEY, JSON.stringify(fresh)); } catch (e) { /* 忽略 */ }
        return fresh;
      }
      return doc;
    } catch (e) {
      return seedConfig();
    }
  }

  function saveConfig(doc) {
    try {
      doc._rev = "demo-" + Date.now().toString(36);
      localStorage.setItem(LS_KEY, JSON.stringify(doc));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ------------------------------------------------------------
  // 暴露接口
  // ------------------------------------------------------------
  window.services = {
    version: 1,
    demo: true,

    listDir: listDir,
    listDrives: function () { return listDir(DRIVES_SENTINEL, {}).items || []; },
    splitPath: splitPath,
    stat: stat,

    openPath: function (p) {
      demoToast("演示模式：真实环境会在此打开「" + p + "」");
      return Promise.resolve("");
    },
    showItem: function (p) {
      demoToast("演示模式：真实环境会定位到「" + p + "」");
      return true;
    },
    copyText: function (t) {
      try { if (navigator.clipboard) navigator.clipboard.writeText(String(t)); } catch (e) { /* 忽略 */ }
      return true;
    },
    pickFolder: function (defaultPath) {
      return defaultPath || "C:\\Users\\you\\Work\\client-2024\\src\\components";
    },
    getCurrentFolder: function () {
      return Promise.resolve("C:\\Users\\you\\Work");
    },
    onEntry: function () {
      // 浏览器演示没有插件入口事件；返回空注销函数保持接口一致。
      return function () {};
    },
    getPath: function (name) {
      const map = {
        home: "C:\\Users\\you",
        downloads: "C:\\Users\\you\\Downloads",
        desktop: "C:\\Users\\you\\Desktop",
        documents: "C:\\Users\\you\\Documents",
        pictures: "C:\\Users\\you\\Pictures"
      };
      return map[name] || "";
    },

    getConfig: getConfig,
    saveConfig: saveConfig,
    exitPlugin: function () { /* 演示模式无需退出 */ },

    DRIVES_SENTINEL: DRIVES_SENTINEL
  };

  // ------------------------------------------------------------
  // 演示角标：让人一眼看出这是模拟数据，不会误以为真在读写磁盘
  // ------------------------------------------------------------
  function addBadge() {
    const brand = document.querySelector(".toolbar .brand");
    if (!brand || document.querySelector(".demo-badge")) return;
    const b = document.createElement("span");
    b.className = "demo-badge";
    b.textContent = "演示模式 · 模拟数据";
    b.title = "当前由 demo-services.js 提供内存目录树；在 uTools 中运行时为真实文件系统";
    brand.appendChild(b);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", addBadge);
  } else {
    addBadge();
  }
})();
