#!/usr/bin/env node
/**
 * 目录导航器 · 运行时自检（headless Chrome + CDP）
 *
 * 目的：把 README 里的「人工验收清单」落成可重复执行的断言。
 * 为什么不用 Playwright：项目坚持零依赖，Node 22 自带 WebSocket，
 * 直接用 DevTools 协议驱动 Chrome 即可，不需要 npm install。
 *
 * 用法：
 *   node tools/ui-check.js                    # 只跑断言
 *   node tools/ui-check.js --screenshot=docs/screenshot.png
 *   CHROME_PATH=/path/to/chrome node tools/ui-check.js
 *
 * 说明：
 *   - 只测演示模式（demo-services.js 的内存目录树），不会碰真实磁盘；
 *   - 找不到 Chrome/Edge 时打印 SKIP 并以 0 退出，方便无意调用时不阻塞；
 *   - 需要 Node 22+（全局 WebSocket）；本脚本不进 CI，避免 CI 依赖浏览器。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const ROOT = process.env.DIRNAV_ROOT
  ? path.resolve(process.env.DIRNAV_ROOT)
  : path.resolve(__dirname, "..");
const APP_URL = pathToFileURL(path.join(ROOT, "app.html")).href;
const VIEW = { width: 1040, height: 680 };
const SHOT_ARG = process.argv.find(function (a) { return a.indexOf("--screenshot=") === 0; });
const SHOT = path.resolve(
  ROOT,
  SHOT_ARG ? SHOT_ARG.slice("--screenshot=".length) : "docs/screenshot.png"
);

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

// ---------------------------------------------------------------
// Chrome 定位与启动
// ---------------------------------------------------------------
function findChrome() {
  const cands = [];
  if (process.env.CHROME_PATH) cands.push(process.env.CHROME_PATH);
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA || "";
    cands.push(path.join(pf, "Google", "Chrome", "Application", "chrome.exe"));
    cands.push(path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"));
    if (local) cands.push(path.join(local, "Google", "Chrome", "Application", "chrome.exe"));
    cands.push(path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"));
    cands.push(path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"));
  } else if (process.platform === "darwin") {
    cands.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    cands.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  } else {
    cands.push("/usr/bin/google-chrome");
    cands.push("/usr/bin/google-chrome-stable");
    cands.push("/usr/bin/chromium");
    cands.push("/usr/bin/chromium-browser");
  }
  for (let i = 0; i < cands.length; i++) {
    try { if (fs.statSync(cands[i]).isFile()) return cands[i]; } catch (e) { /* 继续找 */ }
  }
  return null;
}

function requestJson(url, method) {
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: method || "GET", timeout: 2000
    }, function (res) {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", function (d) { body += d; });
      res.on("end", function () {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", function () { req.destroy(new Error("request timeout")); });
    req.end();
  });
}

class CDP {
  constructor(ws) {
    const self = this;
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", function (ev) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && self.pending.has(msg.id)) {
        const p = self.pending.get(msg.id);
        self.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
        return;
      }
      const arr = self.listeners.get(msg.method);
      if (arr) arr.forEach(function (fn) { try { fn(msg.params); } catch (e) { /* 忽略 */ } });
    });
  }
  send(method, params) {
    const self = this;
    return new Promise(function (resolve, reject) {
      const id = ++self.nextId;
      const timer = setTimeout(function () {
        self.pending.delete(id);
        reject(new Error("CDP timeout: " + method));
      }, 20000);
      self.pending.set(id, {
        resolve: function (v) { clearTimeout(timer); resolve(v); },
        reject: function (e) { clearTimeout(timer); reject(e); }
      });
      self.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  close() { try { this.ws.close(); } catch (e) { /* 忽略 */ } }
}

function connect(wsUrl) {
  return new Promise(function (resolve, reject) {
    if (typeof WebSocket === "undefined") {
      reject(new Error("Node 22+ required (global WebSocket missing)"));
      return;
    }
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(function () { reject(new Error("WebSocket connect timeout")); }, 5000);
    ws.addEventListener("open", function () { clearTimeout(timer); resolve(new CDP(ws)); });
    ws.addEventListener("error", function () {
      clearTimeout(timer);
      reject(new Error("WebSocket connection failed (try --remote-allow-origins=*)"));
    });
  });
}

// ---------------------------------------------------------------
// 断言
// ---------------------------------------------------------------
let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  PASS  " + name);
  } else {
    failures.push({ name: name, extra: extra || "" });
    console.log("  FAIL  " + name + (extra ? "  -> " + extra : ""));
  }
}
function section(title) { console.log("\n[" + title + "]"); }

// ---------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------
async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("[SKIP] Chrome/Edge not found. Set CHROME_PATH to run the UI check.");
    return 0;
  }
  console.log("Chrome: " + chrome);
  console.log("App   : " + APP_URL);

  const port = 9500 + Math.floor(Math.random() * 300);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dirnav-ui-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--mute-audio",
    "--remote-allow-origins=*",
    "--window-size=" + VIEW.width + "," + VIEW.height,
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + profile,
    "about:blank"
  ];
  if (process.platform !== "win32") args.unshift("--no-sandbox");

  const proc = spawn(chrome, args, { stdio: "ignore" });
  let cdp = null;
  let health = {};
  try {
    let version = null;
    for (let i = 0; i < 100 && !version; i++) {
      try { version = await requestJson("http://127.0.0.1:" + port + "/json/version"); }
      catch (e) { await sleep(100); }
    }
    if (!version) throw new Error("Chrome DevTools endpoint did not come up");

    const target = await requestJson(
      "http://127.0.0.1:" + port + "/json/new?" + encodeURIComponent("about:blank"), "PUT");
    cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Log.enable");

    cdp.on("Runtime.exceptionThrown", function (p) {
      const d = p.exceptionDetails || {};
      health.errors = (health.errors || 0) + 1;
      console.log("  [page exception] " + (d.text || "") + " " + ((d.exception && d.exception.description) || ""));
    });

    async function evaluate(expr) {
      const res = await cdp.send("Runtime.evaluate", {
        expression: expr, awaitPromise: true, returnByValue: true, userGesture: true
      });
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        throw new Error((d.exception && d.exception.description) || d.text || "evaluate failed");
      }
      return res.result ? res.result.value : undefined;
    }

    async function waitReady(timeout) {
      const t0 = Date.now();
      while (Date.now() - t0 < (timeout || 10000)) {
        try {
          const ok = await evaluate(
            "!!(window.__dirnav && document.querySelector('.bm-item') && document.querySelectorAll('.col').length)");
          if (ok) return true;
        } catch (e) { /* 页面还没加载完 */ }
        await sleep(100);
      }
      return false;
    }

    async function waitFor(expr, timeout) {
      const t0 = Date.now();
      while (Date.now() - t0 < (timeout || 4000)) {
        try { if (await evaluate(expr)) return true; } catch (e) { /* 重试 */ }
        await sleep(80);
      }
      return false;
    }

    await cdp.send("Page.navigate", { url: APP_URL });
    check("app boots with demo bridge", await waitReady(12000));

    // 页面内测试助手：只依赖稳定的 class / id，不侵入业务代码。
    // 刷新页面会丢掉挂载在 window 上的助手，因此抽成常量，每次 reload 后重注入。
    const HELPERS = `window.__t = {
      bm: function (name) {
        return Array.from(document.querySelectorAll(".bm-item")).find(function (el) {
          var n = el.querySelector(".bm-name");
          return n && n.textContent === name;
        }) || null;
      },
      clickBm: function (name) { var el = this.bm(name); if (!el) return false; el.click(); return true; },
      dblBm: function (name) {
        var el = this.bm(name); if (!el) return false;
        el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
        return true;
      },
      item: function (name) {
        return Array.from(document.querySelectorAll(".col:last-child .col-item")).find(function (el) {
          var n = el.querySelector(".name");
          return n && n.textContent === name;
        }) || null;
      },
      clickItem: function (name) { var el = this.item(name); if (!el) return false; el.click(); return true; },
      ctxItem: function (name) {
        var el = this.item(name); if (!el) return false;
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 180, clientY: 180 }));
        return true;
      },
      clickCrumb: function (name) {
        var el = Array.from(document.querySelectorAll("#breadcrumb .crumb-btn")).find(function (b) {
          var n = b.querySelector(".crumb-name"); return n && n.textContent === name;
        });
        if (!el) return false; el.click(); return true;
      },
      names: function () {
        return Array.from(document.querySelectorAll(".col:last-child .col-item .name")).map(function (el) { return el.textContent; });
      },
      cols: function () { return document.querySelectorAll(".columns .col").length; },
      crumbs: function () {
        return Array.from(document.querySelectorAll("#breadcrumb .crumb-name")).map(function (el) { return el.textContent; });
      },
      crumb: function () { var a = this.crumbs(); return a.length ? a[a.length - 1] : ""; },
      total: function () { return document.querySelector("#stTotal").textContent; },
      detail: function () { return document.querySelector("#stDetail").textContent; },
      toast: function () { return document.querySelector("#toast").textContent; },
      filter: function () { return document.querySelector("#filter").value; },
      setFilter: function (v) {
        var el = document.querySelector("#filter");
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      },
      key: function (key, mods) {
        document.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ key: key, bubbles: true, cancelable: true }, mods || {})));
      },
      overlayOpen: function () { return !document.querySelector("#overlay").classList.contains("hidden"); },
      ctxOpen: function () { return !document.querySelector("#ctxMenu").classList.contains("hidden"); },
      ctxLabels: function () {
        return Array.from(document.querySelectorAll("#ctxMenu .ctx-item")).map(function (el) { return el.textContent; });
      },
      modalPath: function () { return document.querySelector("#bmPath").value; },
      bmCount: function () { return document.querySelectorAll(".bm-item").length; },
      selectedBms: function () {
        return Array.from(document.querySelectorAll(".bm-item.selected .bm-name")).map(function (el) { return el.textContent; });
      },
      anchors: function () {
        try { return JSON.parse(localStorage.getItem("dirnav:demo:config") || "{}").anchors || []; }
        catch (e) { return []; }
      }
    };
    true`;
    const inject = async function () { await evaluate(HELPERS); };
    await inject();

    // -----------------------------------------------------------
    section("1. 启动状态");
    check("5 个种子书签", await evaluate("__t.bmCount()") === 5,
      "count=" + (await evaluate("__t.bmCount()")));
    check("演示模式角标", await evaluate("!!document.querySelector('.demo-badge')"));
    check("首屏停在上次的 Work 目录", await evaluate("__t.crumb()") === "Work",
      "crumb=" + (await evaluate("__t.crumb()")));
    check("面包屑为 C:\\ > Users > you > Work", JSON.stringify(await evaluate("__t.crumbs()").then(function (v) { return v; })) ===
      JSON.stringify(["C:\\", "Users", "you", "Work"]), JSON.stringify(await evaluate("__t.crumbs()")));
    check("单列 3 项", await evaluate("__t.cols()") === 1 && (await evaluate("__t.names()")).length === 3,
      "cols=" + (await evaluate("__t.cols()")) + " names=" + JSON.stringify(await evaluate("__t.names()")));
    check("状态栏 3 项 3 目录", (await evaluate("__t.total()")) === "3 项" && (await evaluate("__t.detail()")) === "3 目录",
      await evaluate("__t.total()") + " / " + (await evaluate("__t.detail()")));

    // -----------------------------------------------------------
    section("2. 真实鼠标点击书签");
    const bmPt = await evaluate(`(function () {
      var el = __t.bm("文档"); if (!el) return null;
      var r = el.getBoundingClientRect();
      return { x: r.left + 30, y: r.top + r.height / 2 };
    })()`);
    if (bmPt) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: bmPt.x, y: bmPt.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: bmPt.x, y: bmPt.y, button: "left", clickCount: 1 });
    }
    check("命中并切到「文档」（Documents）", await waitFor('__t.crumb() === "Documents"'),
      "crumb=" + (await evaluate("__t.crumb()")));
    const docNames = (await evaluate("__t.names()")).slice().sort();
    const docExpect = ["合同", "发票", "简历.pdf", "笔记.md"].slice().sort();
    check("文档 = 4 项（2 目录 + 2 文件）", JSON.stringify(docNames) === JSON.stringify(docExpect),
      JSON.stringify(await evaluate("__t.names()")));
    check("书签高亮跟随 root", JSON.stringify(await evaluate("__t.selectedBms()")) === JSON.stringify(["文档"]),
      JSON.stringify(await evaluate("__t.selectedBms()")));

    // -----------------------------------------------------------
    section("3. Miller 列导航");
    await evaluate('__t.clickBm("Work")');
    await waitFor('__t.crumb() === "Work"');
    await evaluate('__t.clickItem("client-2024")');
    check("单击目录 250ms 后下钻", await waitFor('__t.crumb() === "client-2024" && __t.cols() === 2', 3000),
      "crumb=" + (await evaluate("__t.crumb()")) + " cols=" + (await evaluate("__t.cols()")));
    await evaluate('__t.clickCrumb("Work")');
    check("点面包屑回到 Work 且收成一列", await waitFor('__t.crumb() === "Work" && __t.cols() === 1'),
      "crumb=" + (await evaluate("__t.crumb()")) + " cols=" + (await evaluate("__t.cols()")));
    await evaluate('document.querySelector("#upBtn").click()');
    check("向上一级 = C:\\Users\\you", await waitFor('__t.crumb() === "you"'),
      "crumb=" + (await evaluate("__t.crumb()")));
    check("you 下有 Work 目录", (await evaluate("__t.names()")).indexOf("Work") >= 0,
      JSON.stringify(await evaluate("__t.names()")));
    await evaluate('__t.clickBm("Work")');
    await waitFor('__t.crumb() === "Work"');

    // 回归守卫：单击目录的 250ms 延迟不能穿越到随后的书签导航里
    await evaluate('__t.clickItem("client-2024"); __t.clickBm("下载")');
    await sleep(600);
    check("点目录后立刻切书签，不被旧单击定时器带偏", (await evaluate("__t.crumb()")) === "Downloads",
      "crumb=" + (await evaluate("__t.crumb()")));
    await evaluate('__t.clickBm("Work")');
    await waitFor('__t.crumb() === "Work"');

    // -----------------------------------------------------------
    section("4. 过滤与状态栏");
    await evaluate('__t.setFilter("client")');
    check("过滤后当前列 2 项", JSON.stringify(await evaluate("__t.names()")) === JSON.stringify(["client-2024", "client-2025"]),
      JSON.stringify(await evaluate("__t.names()")));
    check("状态栏同步「筛选命中 2 项」", (await evaluate("__t.detail()")).indexOf("筛选命中 2 项") >= 0 &&
      (await evaluate("__t.total()")) === "2 项",
      await evaluate("__t.total()") + " / " + (await evaluate("__t.detail()")));
    await evaluate('document.querySelector(".columns").click()');
    await evaluate('__t.key("Escape")');
    check("Esc 清空过滤词", await waitFor('__t.filter() === ""'),
      "filter=" + (await evaluate("__t.filter()")));
    check("Esc 后恢复 3 项", (await evaluate("__t.names()")).length === 3,
      JSON.stringify(await evaluate("__t.names()")));
    await evaluate('__t.setFilter("zzz")');
    await evaluate('__t.clickBm("下载")');
    check("切换书签自动清过滤", await waitFor('__t.filter() === "" && __t.crumb() === "Downloads"'),
      "filter=" + (await evaluate("__t.filter()")) + " crumb=" + (await evaluate("__t.crumb()")));

    // -----------------------------------------------------------
    section("5. 键盘");
    await evaluate('__t.clickBm("Work")');
    await waitFor('__t.crumb() === "Work"');
    const firstDir = (await evaluate("__t.names()"))[0];
    await evaluate('__t.key("ArrowDown")');
    check("ArrowDown 选中首项", await evaluate('!!document.querySelector(".col-item.selected")'));
    await evaluate('__t.key("Enter")');
    check("Enter 下钻 " + firstDir, await waitFor('__t.crumb() === ' + JSON.stringify(firstDir), 3000),
      "crumb=" + (await evaluate("__t.crumb()")));
    await evaluate('__t.key("ArrowLeft")');
    check("ArrowLeft 返回 Work", await waitFor('__t.crumb() === "Work"'),
      "crumb=" + (await evaluate("__t.crumb()")));

    // -----------------------------------------------------------
    section("6. 右键菜单");
    await evaluate('__t.ctxItem("client-2024")');
    check("右键目录弹出菜单", await evaluate("__t.ctxOpen()"));
    check("菜单包含 添加为书签/复制路径",
      (await evaluate("__t.ctxLabels()")).join("|").indexOf("添加为书签") >= 0 &&
      (await evaluate("__t.ctxLabels()")).join("|").indexOf("复制路径") >= 0,
      (await evaluate("__t.ctxLabels()")).join("|"));
    await evaluate('__t.key("Escape")');
    check("Esc 收起右键菜单", !(await evaluate("__t.ctxOpen()")));
    await evaluate('__t.ctxItem("client-2024")');
    await evaluate(`(function () {
      var row = Array.from(document.querySelectorAll("#ctxMenu .ctx-item")).find(function (el) {
        return el.textContent.indexOf("添加为书签") >= 0;
      });
      if (row) row.click();
    })()`);
    check("菜单「添加为书签」预填该路径",
      (await evaluate("__t.overlayOpen()")) && /client-2024$/.test(await evaluate("__t.modalPath()")),
      "path=" + (await evaluate("__t.modalPath()")));
    await evaluate('__t.key("Escape")');
    check("Esc 关闭书签弹窗", !(await evaluate("__t.overlayOpen()")));

    // -----------------------------------------------------------
    section("7. 此电脑 / 磁盘");
    await evaluate('document.querySelector("#thisPcBtn").click()');
    check("进入此电脑，显示 C:/D:", await waitFor('__t.crumb() === "此电脑" && __t.names().length === 2'),
      JSON.stringify(await evaluate("__t.names()")));
    check("此电脑时「在资源管理器打开」禁用", await evaluate('document.querySelector("#openInExplorer").disabled'));
    await evaluate('document.querySelector("#addBtn").click()');
    check("此电脑下添加书签不预填哨兵路径", (await evaluate("__t.overlayOpen()")) && (await evaluate("__t.modalPath()")) === "",
      "path=" + JSON.stringify(await evaluate("__t.modalPath()")));
    await evaluate('document.querySelector("#bmCancel").click()');
    await evaluate('__t.clickBm("Work")');
    await waitFor('__t.crumb() === "Work"');
    await evaluate('__t.key("Escape")');
    check("Esc 无过滤词时触发关窗（演示模式提示）", await waitFor('/关闭窗口/.test(__t.toast())', 2000),
      "toast=" + (await evaluate("__t.toast()")));
    await sleep(2300);

    // -----------------------------------------------------------
    section("8. 双击书签（PRD F2）");
    await evaluate('__t.dblBm("素材库")');
    check("双击书签调用资源管理器打开", await waitFor('/打开/.test(__t.toast())', 2000),
      "toast=" + (await evaluate("__t.toast()")));
    await sleep(2400);

    // -----------------------------------------------------------
    section("9. 新增书签与持久化");
    await evaluate('__t.clickBm("Work")');
    await waitFor('__t.crumb() === "Work"');
    await evaluate('document.querySelector("#addBtn").click()');
    await evaluate(`(function () {
      var p = document.querySelector("#bmPath");
      p.value = "D:/素材库/图片";
      p.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#bmName").value = "UI 测试";
      document.querySelector("#bmSave").click();
    })()`);
    check("保存后跳到新书签目录", await waitFor('__t.crumb() === "图片"', 3000),
      "crumb=" + (await evaluate("__t.crumb()")));
    check("书签数变为 6", await evaluate("__t.bmCount()") === 6,
      "count=" + (await evaluate("__t.bmCount()")));
    check("toast 提示已添加", (await evaluate("__t.toast()")).indexOf("书签已添加") >= 0,
      await evaluate("__t.toast()"));
    await cdp.send("Page.reload");
    await waitReady(12000);
    await inject();
    check("刷新后书签仍在", await evaluate("document.querySelectorAll('.bm-item').length") === 6,
      "count=" + (await evaluate("document.querySelectorAll('.bm-item').length")));
    check("刷新后停在最后访问目录", await evaluate('__t.crumb()') === "图片",
      "crumb=" + (await evaluate("__t.crumb()")));

    // -----------------------------------------------------------
    section("10. 设置持久化");
    await evaluate('document.querySelector("#settingsBtn").click()');
    check("设置弹窗可见", await evaluate('!document.querySelector("#overlay").classList.contains("hidden")'));
    await evaluate('document.querySelector("#setShowFiles").click()');
    await evaluate('document.querySelector("#setDone").click()');
    check("关闭显示文件后当前列变空", await waitFor('__t.names().length === 0', 3000),
      JSON.stringify(await evaluate("__t.names()")));
    await cdp.send("Page.reload");
    await waitReady(12000);
    await inject();
    check("刷新后仍不显示文件", (await evaluate("document.querySelectorAll('.col:last-child .col-item .name').length")) === 0,
      "names=" + JSON.stringify(await evaluate("document.querySelectorAll('.col:last-child .col-item .name').length")));
    await evaluate('document.querySelector("#settingsBtn").click()');
    check("设置项回填为关闭", await evaluate('document.querySelector("#setShowFiles").checked === false'));
    await evaluate('document.querySelector("#setShowFiles").click()');
    await evaluate('document.querySelector("#setDone").click()');
    check("重新开启后文件回来了", await waitFor('__t.names().length > 0', 3000),
      JSON.stringify(await evaluate("__t.names()")));

    // -----------------------------------------------------------
    section("11. 控制台与截图");
    check("无未捕获异常", !health.errors, "exceptions=" + (health.errors || 0));

    if (SHOT) {
      // 截图用干净的种子数据，不带测试期间新增的书签/设置
      await evaluate('localStorage.removeItem("dirnav:demo:config")');
      await cdp.send("Page.reload");
      await waitReady(12000);
      await inject();
      await waitFor('__t.crumb() === "Work"', 5000);
      await sleep(800);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync(path.dirname(SHOT), { recursive: true });
      fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
      console.log("Screenshot: " + SHOT);
    }
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) { /* 忽略 */ }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  console.log("\n---------------------------------------------");
  console.log("UI check: " + pass + " passed, " + failures.length + " failed");
  if (failures.length) {
    failures.forEach(function (f) { console.log("  - " + f.name + (f.extra ? " (" + f.extra + ")" : "")); });
    return 1;
  }
  return 0;
}

main().then(function (code) {
  process.exitCode = code;
}).catch(function (e) {
  console.error("[ERROR] " + ((e && e.stack) || e));
  process.exitCode = 2;
});
