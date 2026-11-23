// ============================================================
// preload.js —— 主窗口桥接层
// 职责：注册插件入口（onPluginEnter），唤起独立的目录导航器大窗口。
// 运行环境：Node.js 20 + uTools API（主窗口上下文）。
// ============================================================

const path = require("node:path");
const bookmarkStore = require("./bookmark-store.js");

let navWin = null;

const WINDOW_OPTIONS = {
  show: false, // 页面加载完成后再显示，避免白屏闪烁
  title: "目录导航器",
  width: 1040,
  height: 680,
  minWidth: 680,
  minHeight: 420,
  center: true,
  resizable: true,
  minimizable: true,
  maximizable: true,
  closable: true,
  frame: true, // 使用系统原生标题栏，保证吸附/缩放/任务栏等原生行为
  backgroundColor: "#fbfcfe",
  webPreferences: {
    // Electron 的 preload 必须是绝对路径：相对路径会被解析到 uTools 自身的
    // 应用根目录而不是插件目录，导致独立窗口拿不到 window.services。
    preload: path.join(__dirname, "app-preload.js"),
    // Electron 20+ 的默认值（sandbox=true / contextIsolation=true）会让 preload
    // 既 require 不到 node:fs，也无法把 window.services 交给页面，表现为窗口白屏
    // 或「桥接层加载失败」。这里按 uTools 插件的惯例显式关闭，只加载本地页面。
    sandbox: false,
    contextIsolation: false,
    nodeIntegration: true
  }
};

/**
 * 打开（或聚焦已打开的）导航器窗口。
 * @param {string|null} openPath  初始锚定的绝对路径（files 匹配入口使用）
 * @param {string|null} highlight 初始要高亮的文件/目录名（定位文件使用）
 */
function openNavigator(openPath, highlight) {
  if (navWin) {
    try {
      // uTools 的自定义窗口不支持 on('close')，改用 isDestroyed 判断；若方法缺失则按已失效处理
      if (typeof navWin.isDestroyed === "function" && navWin.isDestroyed()) {
        navWin = null;
      } else {
        // 窗口已存在：把新的目标路径推给渲染层，避免「再次右键打开」时窗口停在旧目录
        try {
          if (typeof navWin.isMinimized === "function" && navWin.isMinimized() &&
              typeof navWin.restore === "function") navWin.restore();
        } catch (e) { /* 忽略 */ }
        if (openPath) navigateExisting(navWin, openPath, highlight);
        navWin.show();
        navWin.focus();
        return navWin;
      }
    } catch (e) {
      navWin = null; // 窗口已失效，重建
    }
  }

  let url = "app.html";
  const qs = [];
  if (openPath) qs.push("open=" + encodeURIComponent(openPath));
  if (highlight) qs.push("highlight=" + encodeURIComponent(highlight));
  if (qs.length) url += "?" + qs.join("&");

  navWin = utools.createBrowserWindow(url, WINDOW_OPTIONS, function () {
    // 回调参数在部分 uTools 版本里为空，用闭包里的 navWin 兜底
    const w = arguments[0] || navWin;
    try {
      if (w && typeof w.show === "function") w.show();
    } catch (e) {
      /* 忽略显示异常 */
    }
  });
  return navWin;
}

/**
 * 让已打开的导航器窗口跳转到新路径（app.js 暴露了 window.__dirnav 钩子）。
 * 用 JSON.stringify 拼接，避免路径里的引号/反斜杠破坏 JS 字面量。
 */
function navigateExisting(win, openPath, highlight) {
  const js =
    "(function(){var d=window.__dirnav;" +
    "if(d&&typeof d.open==='function'){d.open(" +
    JSON.stringify(String(openPath)) + "," +
    JSON.stringify(highlight ? String(highlight) : null) +
    ");return true;}return false;})()";

  const run = function () {
    try {
      return Promise.resolve(win.webContents.executeJavaScript(js)).catch(function () { return false; });
    } catch (e) {
      return Promise.resolve(false);
    }
  };

  run().then(function (ok) {
    if (ok === true) return;
    // 页面还没加载完（或 __dirnav 尚未就绪）：等加载完成/稍后再试一次，
    // 否则「右键打开某个目录」这一入口会被静默丢弃。
    try {
      const wc = win.webContents;
      if (typeof wc.isLoading === "function" && wc.isLoading() && typeof wc.once === "function") {
        wc.once("did-finish-load", function () { run(); });
      } else if (typeof wc.on === "function") {
        setTimeout(function () { run(); }, 400);
      }
    } catch (e) { /* 忽略 */ }
  });
}

// ---- 收藏指令（唯一需要 outPlugin 的路径） ----
// 进入条件：用户在资源管理器前台时通过指令/快捷键触发 dirnav-collect。
// 这里在 uTools 抢走焦点之前读取路径，写完书签后用系统通知反馈，不打开导航器。
function runCollectCommand() {
  let notified = false;
  function notify(text) {
    if (notified) return;
    notified = true;
    try { utools.showNotification(text); } catch (e) { /* 忽略系统通知异常 */ }
  }

  bookmarkStore.collectCurrentFolder(utools).then(function (res) {
    if (res.ok) {
      notify("已收藏：" + res.bookmark.name);
    } else if (res.reason === "duplicate") {
      notify("已在书签中：" + (res.bookmark && res.bookmark.name ? res.bookmark.name : "该文件夹"));
    } else if (res.reason === "no-folder") {
      notify("没有读到资源管理器文件夹，请先在资源管理器中打开一个文件夹");
    } else if (res.reason === "not-dir") {
      notify("当前路径不是可收藏的文件夹");
    } else {
      notify("收藏失败，请重试");
    }
  }).catch(function () {
    notify("收藏失败，请重试");
  }).then(function () {
    // 收藏指令没有独立窗口，完成即退出，避免插件常驻
    try { utools.hideMainWindow(); } catch (e) { /* 忽略 */ }
    try { setTimeout(function () { utools.outPlugin(); }, 150); } catch (e) { /* 忽略 */ }
  });
}
// ---- 收藏指令结束 ----

function hideMainWindow() {
  // 只隐藏 uTools 搜索面板，让独立大窗口成为焦点。
  //
  // 这里**故意不调用 utools.outPlugin()**：官方文档明确「uTools 主窗口隐藏后，
  // 插件应用可能会在用户设定的时间（默认 3 分钟）内自动退出」，而退出会连带
  // 销毁我们创建的导航器窗口——那等于用户正用着窗口就凭空消失。
  // 保持插件处于「已进入」状态即可让窗口常驻，用户点窗口右上角关闭时才结束。
  try {
    if (typeof utools.hideMainWindow === "function") utools.hideMainWindow();
  } catch (e) { /* 忽略 */ }
}

// 供主窗口 index.html 兜底调用
// 与 app-preload.js 同样的双通道挂载：隔离上下文走 contextBridge，否则直接赋值。
(function exposeMainServices() {
  const api = {
    openNavigator: function () {
      openNavigator();
      hideMainWindow();
    }
  };
  try {
    if (typeof process !== "undefined" && process && process.contextIsolated) {
      const eb = require("electron");
      if (eb && eb.contextBridge && typeof eb.contextBridge.exposeInMainWorld === "function") {
        eb.contextBridge.exposeInMainWorld("services", api);
        return;
      }
    }
  } catch (e) { /* 落到直接赋值 */ }
  try { window.services = api; } catch (e) { /* 忽略 */ }
})();

// 插件入口：用户通过关键词或「在目录导航器中打开」匹配指令进入时触发
utools.onPluginEnter(function (action) {
  if (action && action.code === "dirnav-collect") {
    window.__dirnavEntered = true; // 收藏指令不打开导航器，阻止 index.html 的兜底唤起
    runCollectCommand();
    return;
  }
  window.__dirnavEntered = true; // 让 index.html 的兜底唤起让路
  let openPath = null;
  let highlight = null;

  if (action && action.type === "files" && Array.isArray(action.payload) && action.payload.length) {
    const dir = action.payload.find(function (x) { return x && x.isDirectory && typeof x.path === "string" && x.path; });
    const file = action.payload.find(function (x) { return x && x.isFile && typeof x.path === "string" && x.path; });
    if (dir) {
      openPath = dir.path;
    } else if (file) {
      // 定位文件：锚定到其父目录，并高亮该文件
      openPath = path.dirname(file.path);
      highlight = typeof file.name === "string" && file.name ? file.name : path.basename(file.path);
    }
  }

  openNavigator(openPath, highlight);
  hideMainWindow();
});
