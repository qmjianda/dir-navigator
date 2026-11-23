#!/usr/bin/env node
/**
 * DirNavigator 静态自检
 * ---------------------------------------------------------------
 * 用法:  node tools/verify.js
 * 退出码: 0 = 全部通过（可能有警告）  1 = 存在失败项
 *
 * 检查内容：
 *   1. 必需文件齐全
 *   2. plugin.json 结构与 uTools 合法字段（含 files 指令 fileType 陷阱）
 *   3. 七个 JS 文件的语法（vm.Script 编译，不执行）
 *   4. app.html 的 id 与 app.js 里 $("#id") 选择器一一对应
 *   5. SVG 雪碧图 symbol 与 icon()/#i-xxx 引用对应
 *   6. services 接口三方一致（app.js 调用点 vs app-preload.js vs demo-services.js）
 *   7. HTML 本地资源引用存在、脚本加载顺序正确
 *   8. app.css 大括号配对
 *   9. 编码卫生（BOM / 混用换行）
 *  10. 历史 bug 回归守卫（preload 绝对路径、Electron 隔离开关、fileType:"all"）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");

let pass = 0;
let warn = 0;
let fail = 0;
const out = [];

function ok(m) { pass++; out.push("  [ OK ]  " + m); }
function wr(m) { warn++; out.push("  [WARN]  " + m); }
function bad(m) { fail++; out.push("  [FAIL]  " + m); }
function head(t) { out.push(""); out.push("== " + t + " =="); }
function fileExists(rel) {
  try { return fs.statSync(path.join(ROOT, rel)).isFile(); } catch (e) { return false; }
}
function readText(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }
function readBuf(rel) { return fs.readFileSync(path.join(ROOT, rel)); }
function uniq(arr) {
  const r = [];
  for (let i = 0; i < arr.length; i++) if (r.indexOf(arr[i]) < 0) r.push(arr[i]);
  return r;
}
function matchAll(src, re) {
  if (!re.global) throw new Error("matchAll 需要 /g 正则: " + re);
  const r = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(src)) !== null) {
    r.push(m);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return r;
}

// ---------------------------------------------------------------
// 1. 必需文件
// ---------------------------------------------------------------
const REQUIRED = [
  "plugin.json", "logo.svg", "index.html",
  "preload.js", "app-preload.js",
  "app.html", "app.css", "app.js", "demo-services.js",
  "bookmark-store.js",
  "ui-check.cmd", "tools/ui-check.js",
  "README.md"
];

head("1. 文件完整性");
REQUIRED.forEach(function (f) {
  if (fileExists(f)) ok(f);
  else bad("缺少必需文件: " + f);
});

// ---------------------------------------------------------------
// 2. plugin.json
// ---------------------------------------------------------------
head("2. plugin.json");
let PJ = null;
if (fileExists("plugin.json")) {
  const raw = readText("plugin.json");
  try {
    PJ = JSON.parse(raw);
    ok("JSON 解析通过");
  } catch (e) {
    bad("JSON 解析失败: " + e.message);
  }
}

if (PJ) {
  // 2.1 入口三件套
  ["main", "logo"].forEach(function (k) {
    if (typeof PJ[k] === "string" && PJ[k]) {
      if (fileExists(PJ[k])) ok(k + " -> " + PJ[k] + "（文件存在）");
      else bad(k + " 指向的文件不存在: " + PJ[k]);
    } else {
      bad("缺少必填字段 " + k);
    }
  });
  if (PJ.preload) {
    if (fileExists(PJ.preload)) ok("preload -> " + PJ.preload + "（文件存在）");
    else bad("preload 指向的文件不存在: " + PJ.preload);
  } else {
    wr("未声明 preload（主窗口就不会有 window.services.openNavigator）");
  }

  // 2.2 features
  if (!Array.isArray(PJ.features) || PJ.features.length === 0) {
    bad("features 必须是非空数组");
  } else {
    const codes = [];
    PJ.features.forEach(function (f, i) {
      const tag = "features[" + i + "]";
      if (!f || typeof f !== "object") { bad(tag + " 不是对象"); return; }
      if (typeof f.code !== "string" || !f.code) bad(tag + " 缺少 code");
      else if (codes.indexOf(f.code) >= 0) bad(tag + " code 重复: " + f.code);
      else codes.push(f.code);

      const cmds = f.cmds;
      if (typeof cmds === "string") {
        if (!cmds.trim()) bad(tag + " cmds 为空字符串");
      } else if (Array.isArray(cmds)) {
        if (cmds.length === 0) bad(tag + " cmds 为空数组");
        if (cmds.length > 5) wr(tag + " cmds 有 " + cmds.length + " 条，官方建议同一 feature 最多 5 条");
        cmds.forEach(function (c, j) {
          const ct = tag + ".cmds[" + j + "]";
          if (typeof c === "string" || c instanceof String) {
            if (!String(c).trim()) bad(ct + " 是空字符串");
            return;
          }
          if (!c || typeof c !== "object") { bad(ct + " 类型非法"); return; }
          if (c.type === "files") {
            if (c.fileType !== undefined) {
              if (c.fileType === "all") {
                bad(ct + ' fileType:"all" 不合法 —— uTools 只接受 "file" / "directory"，"全部"请直接省略该字段');
              } else if (c.fileType !== "file" && c.fileType !== "directory") {
                bad(ct + ' fileType 只能是 "file" 或 "directory"，当前: ' + JSON.stringify(c.fileType));
              } else {
                ok(ct + " fileType=" + c.fileType);
              }
            } else {
              ok(ct + " 未写 fileType（同时匹配文件与目录）");
            }
            if (c.extensions && c.match) wr(ct + " extensions 与 match 只能二选一（同时存在时 uTools 只用其中一个）");
            if (c.label !== undefined && typeof c.label !== "string") bad(ct + " label 应为字符串");
          } else if (c.type === "window") {
            if (!c.match || !Array.isArray(c.match.app) || c.match.app.length === 0) {
              bad(ct + " window 指令必须提供 match.app（如 [\"explorer.exe\"]）");
            } else if (!c.label) {
              bad(ct + " window 指令必须提供 label");
            } else {
              ok(ct + " window -> " + c.match.app.join(","));
            }
          } else if (c.type === "regex" || c.type === "over" || c.type === "img") {
            // 其它匹配类型，这里只做存在性检查
          } else if (c.type === undefined && c.label) {
            wr(ct + " 有 label 但无 type（uTools 会当成文本匹配指令）");
          }
        });
      } else {
        bad(tag + " 缺少 cmds");
      }

      if (f.platform !== undefined) {
        if (!Array.isArray(f.platform)) bad(tag + " platform 应为数组，如 [\"win32\"]");
        else if (f.platform.indexOf("win32") < 0) wr(tag + " platform 不含 win32，Windows 上不会被触发");
      }
      if (f.mainHide !== undefined && typeof f.mainHide !== "boolean") bad(tag + " mainHide 应为布尔值");
    });
  }

  // 2.2b 收藏当前文件夹指令（A 方案的关键配置）
  if (Array.isArray(PJ.features)) {
    const collect = PJ.features.find(function (f) { return f && f.code === "dirnav-collect"; });
    if (!collect) {
      bad("缺少 dirnav-collect 功能指令（无法在不打开导航器时收藏资源管理器文件夹）");
    } else {
      if (collect.mainHide === true) ok("dirnav-collect 设置了 mainHide（静默执行）");
      else bad("dirnav-collect 必须设置 mainHide:true，否则收藏时会弹出插件主窗口");
      const cmds = Array.isArray(collect.cmds) ? collect.cmds : [];
      const win = cmds.find(function (c) { return c && c.type === "window"; });
      if (!win) bad("dirnav-collect 缺少 window 类型指令（无法在资源管理器前台触发）");
      else if (!win.match || !Array.isArray(win.match.app) || win.match.app.indexOf("explorer.exe") < 0) {
        bad("dirnav-collect 的 window.match.app 应包含 explorer.exe");
      } else {
        ok("dirnav-collect 匹配 explorer.exe 窗口");
      }
    }
  }

  // 2.3 绝对路径泄漏
  const absHits = matchAll(JSON.stringify(PJ), /"[A-Za-z]:[\\/][^"]*"/g).map(function (m) { return m[0]; });
  if (absHits.length) bad("plugin.json 里出现硬编码绝对路径: " + absHits.join(", "));
  else ok("无硬编码绝对路径");

  // 2.4 pluginSetting
  if (PJ.pluginSetting && typeof PJ.pluginSetting.single !== "undefined" && typeof PJ.pluginSetting.single !== "boolean") {
    bad("pluginSetting.single 应为布尔值");
  }
}

// ---------------------------------------------------------------
// 3. JS 语法
// ---------------------------------------------------------------
head("3. JS 语法（编译校验，不执行）");
[
  "preload.js", "app-preload.js", "app.js", "demo-services.js",
  "bookmark-store.js",
  "tools/verify.js", "tools/ui-check.js"
].forEach(function (f) {
  if (!fileExists(f)) { bad("文件不存在，无法校验: " + f); return; }
  const src = readText(f);
  try {
    new vm.Script(src, { filename: f });
    ok(f + "（" + src.split("\n").length + " 行）");
  } catch (e) {
    bad(f + " 语法错误: " + e.message);
  }
});

// ---------------------------------------------------------------
// 4. HTML id <-> app.js 选择器
// ---------------------------------------------------------------
head("4. DOM id 与选择器");
let appHtml = "";
let appJs = "";
if (fileExists("app.html")) appHtml = readText("app.html");
if (fileExists("app.js")) appJs = readText("app.js");

if (appHtml && appJs) {
  const ids = matchAll(appHtml, /\bid="([^"]+)"/g).map(function (m) { return m[1]; });
  const symIds = matchAll(appHtml, /<symbol[^>]*\bid="([^"]+)"/g).map(function (m) { return m[1]; });
  const domIds = ids.filter(function (id) { return symIds.indexOf(id) < 0; });

  const dupIds = ids.filter(function (id, i) { return ids.indexOf(id) !== i; });
  if (dupIds.length) bad("app.html 存在重复 id: " + uniq(dupIds).join(", "));
  else ok("app.html 共 " + ids.length + " 个 id（DOM " + domIds.length + " + symbol " + symIds.length + "），无重复");

  const used = uniq(matchAll(appJs, /\$\("#([A-Za-z0-9_-]+)"\)/g).map(function (m) { return m[1]; }));
  const missing = used.filter(function (u) { return ids.indexOf(u) < 0; });
  if (missing.length) bad("app.js 选择了不存在的 id: " + missing.join(", "));
  else ok("app.js 引用的 " + used.length + " 个 id 全部存在");

  const anchorRefs = uniq(matchAll(appHtml, /href="#([A-Za-z0-9_-]+)"/g).map(function (m) { return m[1]; }));
  const unusedDir = domIds.filter(function (id) {
    return used.indexOf(id) < 0 && anchorRefs.indexOf(id) < 0;
  });
  if (unusedDir.length) wr("DOM 中未被 app.js / 锚点引用的 id: " + unusedDir.join(", "));
}

// ---------------------------------------------------------------
// 5. SVG symbol
// ---------------------------------------------------------------
head("5. SVG 图标");
if (appHtml && appJs) {
  const syms = matchAll(appHtml, /<symbol[^>]*\bid="([^"]+)"/g).map(function (m) { return m[1]; });
  if (!syms.length) {
    bad("app.html 里没有找到任何 <symbol>，图标会全部空白");
  } else {
    ok("雪碧图共 " + syms.length + " 个 symbol");
  }
  const iconArgs = uniq(matchAll(appJs, /"(i-[A-Za-z0-9_-]+)"/g).map(function (m) { return m[1]; }));
  const htmlUses = uniq(matchAll(appHtml, /href="#([^"]+)"/g).map(function (m) { return m[1]; }));
  const refs = uniq(iconArgs.concat(htmlUses.filter(function (h) { return h.indexOf("i-") === 0; })));
  const badRefs = refs.filter(function (r) { return syms.indexOf(r) < 0; });
  if (badRefs.length) bad("引用了不存在的 symbol: " + badRefs.join(", "));
  else ok("所有 " + refs.length + " 个图标引用都能在雪碧图里找到");
  const unusedSyms = syms.filter(function (s) { return refs.indexOf(s) < 0; });
  if (unusedSyms.length) wr("定义了但未使用的 symbol: " + unusedSyms.join(", "));
}

// ---------------------------------------------------------------
// 6. services 接口三方一致
// ---------------------------------------------------------------
function topLevelKeys(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const open = src.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  let close = -1;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { close = k; break; } }
  }
  if (close < 0) return null;
  const body = src.slice(open + 1, close);

  // 压平到只保留顶层字符，跳过字符串与注释，避免值里的冒号被误判为 key
  let flat = "";
  let d = 0;
  let i = 0;
  let quote = null;
  while (i < body.length) {
    const ch = body[i];
    const nx = body[i + 1];
    if (quote) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "/" && nx === "/") { while (i < body.length && body[i] !== "\n") i++; continue; }
    if (ch === "/" && nx === "*") {
      i += 2;
      while (i < body.length && !(body[i] === "*" && body[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; i++; continue; }
    if (ch === "{" || ch === "[" || ch === "(") { d++; i++; continue; }
    if (ch === "}" || ch === "]" || ch === ")") { d--; if (d === 0) flat += ","; i++; continue; }
    if (d === 0) flat += ch;
    i++;
  }
  const keys = [];
  const re = /(?:^|[,\s])([A-Za-z_$][\w$]*)\s*:/g;
  let m;
  while ((m = re.exec(flat)) !== null) if (keys.indexOf(m[1]) < 0) keys.push(m[1]);
  return keys;
}

head("6. services 接口一致性");
if (appJs) {
  const preloadSrc = fileExists("app-preload.js") ? readText("app-preload.js") : "";
  const demoSrc = fileExists("demo-services.js") ? readText("demo-services.js") : "";

  const realKeys = preloadSrc ? topLevelKeys(preloadSrc, "const servicesApi = {") : null;
  const demoKeys = demoSrc ? topLevelKeys(demoSrc, "window.services = {") : null;

  if (!realKeys) bad("app-preload.js 里找不到 `const servicesApi = {` 对象");
  else ok("app-preload.js 暴露 " + realKeys.length + " 个接口: " + realKeys.join(", "));

  if (!demoKeys) {
    if (demoSrc) bad("demo-services.js 里找不到 `window.services = {` 对象");
  } else {
    ok("demo-services.js 模拟 " + demoKeys.length + " 个接口");
  }

  const called = uniq(matchAll(appJs, /\bservices\.([A-Za-z_$][\w$]*)/g).map(function (m) { return m[1]; }));
  ok("app.js 调用 " + called.length + " 个接口: " + called.join(", "));

  if (realKeys) {
    const missReal = called.filter(function (c) { return realKeys.indexOf(c) < 0; });
    if (missReal.length) bad("app.js 调用但 app-preload.js 未实现: " + missReal.join(", "));
    else ok("app.js 的调用点在 app-preload.js 中全部存在");
  }
  if (demoKeys) {
    const missDemo = called.filter(function (c) { return demoKeys.indexOf(c) < 0; });
    if (missDemo.length) bad("app.js 调用但 demo-services.js 未模拟: " + missDemo.join(", "));
    else ok("app.js 的调用点在 demo-services.js 中全部存在");

    if (realKeys) {
      const onlyReal = realKeys.filter(function (k) { return demoKeys.indexOf(k) < 0 && k !== "DRIVES_SENTINEL"; });
      const onlyDemo = demoKeys.filter(function (k) { return realKeys.indexOf(k) < 0 && k !== "demo"; });
      if (onlyReal.length) wr("仅在真实桥接里有的接口（演示模式会缺）: " + onlyReal.join(", "));
      if (onlyDemo.length) wr("仅在演示桥接里有的接口: " + onlyDemo.join(", "));
    }
  }

  // 关键接口逐个点名，防止被顺手改掉
  ["listDir", "listDrives", "splitPath", "stat", "openPath", "showItem", "copyText",
    "pickFolder", "getCurrentFolder", "getPath", "getConfig", "saveConfig"].forEach(function (k) {
    const inReal = realKeys ? realKeys.indexOf(k) >= 0 : false;
    if (!inReal) bad("app-preload.js 缺少关键接口: " + k);
  });

  // 哨兵常量
  if (preloadSrc.indexOf("DRIVES_SENTINEL") < 0) bad("app-preload.js 未定义 DRIVES_SENTINEL");
  if (!/DRIVES_SENTINEL\s*=/.test(demoSrc)) bad("demo-services.js 未定义 DRIVES_SENTINEL");
  if (/\bconst\s+DRIVES\s*=[^;\n]*DRIVES_SENTINEL/.test(appJs)) ok("app.js 通过 services 取哨兵值");
  else wr("app.js 里没找到 DRIVES = ...DRIVES_SENTINEL 赋值，确认哨兵来源");

  // 页面钩子（preload.js 里的 executeJavaScript 依赖它）
  if (/window\.__dirnav\s*=/.test(appJs)) ok("app.js 暴露了 window.__dirnav 钩子");
  else bad("app.js 未暴露 window.__dirnav，preload.js 的 navigateExisting 会失效");
}

// ---------------------------------------------------------------
// 7. HTML 资源引用与加载顺序
// ---------------------------------------------------------------
head("7. 资源引用与脚本顺序");
if (appHtml) {
  const refs = matchAll(appHtml, /(?:src|href)="([^"]*)"/g).map(function (m) { return m[1]; })
    .filter(function (u) {
      return u && u.charAt(0) !== "#" && !/^(?:https?:|data:|mailto:|javascript:)/i.test(u);
    });
  const localRefs = uniq(refs);
  if (!localRefs.length) wr("app.html 没有引用任何本地资源（app.css / app.js 是否漏了？）");
  localRefs.forEach(function (u) {
    const clean = u.split("?")[0].split("#")[0];
    if (fileExists(clean)) ok("引用存在: " + clean);
    else bad("引用的本地文件不存在: " + clean);
  });

  const iDemo = appHtml.indexOf("demo-services.js");
  const iApp = appHtml.indexOf("app.js\"");
  if (iDemo < 0) bad("app.html 未引入 demo-services.js（浏览器演示模式会白屏）");
  else if (iDemo > iApp && iApp > 0) bad("demo-services.js 必须在 app.js 之前引入");
  else ok("脚本顺序正确：demo-services.js 先于 app.js");

  if (appHtml.indexOf("app.css") < 0) bad("app.html 未引入 app.css");
  if (!/charset\s*=\s*["']?utf-8/i.test(appHtml)) {
    wr("app.html 未声明 UTF-8 字符集，可能出现中文乱码");
  }

  // uTools 自定义窗口里 file:// 与 utools 两种来源的脚本都要能跑
  if (appHtml.indexOf("Content-Security-Policy") >= 0) ok("存在 CSP 声明（确认没有拦掉 file:// 资源）");
}

// ---------------------------------------------------------------
// 8. CSS 括号配对
// ---------------------------------------------------------------
head("8. app.css");
if (fileExists("app.css")) {
  const css = readText("app.css");
  const openBraces = (css.match(/\{/g) || []).length;
  const closeBraces = (css.match(/\}/g) || []).length;
  if (openBraces === closeBraces) ok("大括号配对: " + openBraces + " 对");
  else bad("大括号不配对: { " + openBraces + " 个, } " + closeBraces + " 个");

  const openParen = (css.match(/\(/g) || []).length;
  const closeParen = (css.match(/\)/g) || []).length;
  if (openParen !== closeParen) bad("圆括号不配对: ( " + openParen + " 个, ) " + closeParen + " 个");
  else ok("圆括号配对");

  if (/var\(--[a-z0-9-]+\)/.test(css)) ok("使用 CSS 变量（设计令牌）");
  const declared = uniq(matchAll(css, /(--[a-z0-9-]+)\s*:/g).map(function (m) { return m[1]; }));
  const usedVars = uniq(matchAll(css, /var\((--[a-z0-9-]+)/g).map(function (m) { return m[1]; }));
  const undeclared = usedVars.filter(function (v) { return declared.indexOf(v) < 0; });
  if (undeclared.length) wr("var() 引用了未声明的变量: " + undeclared.join(", "));
  else ok("所有 var() 变量都有 :root 声明");
}

// ---------------------------------------------------------------
// 9. 编码卫生
// ---------------------------------------------------------------
head("9. 编码");
const TEXT_FILES = REQUIRED.filter(function (f) {
  return /\.(?:json|js|html|css|svg|md)$/i.test(f);
});
TEXT_FILES.forEach(function (f) {
  if (!fileExists(f)) return;
  const buf = readBuf(f);
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    wr(f + " 带 UTF-8 BOM（uTools 解析 JSON/HTML 时偶发异常）");
  }
  const txt = buf.toString("utf8");
  if (/^\uFFFD/m.test(txt)) bad(f + " 含替换字符 U+FFFD，可能有编码损坏");
  const crlf = (txt.match(/\r\n/g) || []).length;
  const lfOnly = (txt.match(/(?<!\r)\n/g) || []).length;
  if (crlf > 0 && lfOnly > 0) wr(f + " 混用 CRLF/LF（Git 会产生整文件 diff）");
});

// ---------------------------------------------------------------
// 10. 历史 bug 回归守卫
// ---------------------------------------------------------------
head("10. 回归守卫");
if (fileExists("preload.js")) {
  const p = readText("preload.js");
  if (/preload\s*:\s*path\.join\(\s*__dirname\s*,/.test(p)) {
    ok("preload 使用绝对路径 path.join(__dirname, ...)");
  } else {
    bad("preload.js 的 webPreferences.preload 必须是 path.join(__dirname, 'app-preload.js') —— 相对路径会被 Electron 解析到 uTools 应用根目录，独立窗口将拿不到 window.services");
  }
  if (/contextIsolation\s*:\s*false/.test(p)) ok("显式关闭 contextIsolation");
  else wr("preload.js 未显式声明 contextIsolation:false（Electron 20+ 默认 true，preload 会 require 不到 node:fs）");
  if (/nodeIntegration\s*:\s*true/.test(p)) ok("显式开启 nodeIntegration");
  else wr("preload.js 未显式声明 nodeIntegration:true");
  if (/sandbox\s*:\s*false/.test(p)) ok("显式关闭 sandbox");
  else wr("preload.js 未显式声明 sandbox:false");
  // 收藏指令完成后必须退出插件；其余路径仍不应调用 outPlugin（会连带销毁导航器窗口）
  const collectBlock = (p.match(/\/\/ ---- 收藏指令[\s\S]*?\/\/ ---- 收藏指令结束/) || [""])[0];
  if (collectBlock && /utools\.outPlugin\s*\(/.test(collectBlock)) {
    ok("收藏指令完成后主动退出插件");
  } else {
    bad("收藏指令没有调用 utools.outPlugin()，uTools 会停在空白主窗口");
  }
  const enterIdx = p.indexOf('action.code === "dirnav-collect"');
  if (enterIdx >= 0 && p.slice(enterIdx, enterIdx + 320).indexOf("__dirnavEntered") >= 0) {
    ok("收藏指令会阻止 index.html 兜底打开导航器");
  } else {
    bad("dirnav-collect 分支未设置 __dirnavEntered：主窗口兜底逻辑仍会打开导航器");
  }
  const pNoCollect = p.replace(/\/\/ ---- 收藏指令[\s\S]*?\/\/ ---- 收藏指令结束/, "");
  const pNoComment = pNoCollect
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  if (!/utools\.outPlugin\s*\(/.test(pNoComment)) {
    ok("隐藏主窗口时没有真实调用 outPlugin（避免插件退出时连带销毁导航器窗口）");
  } else {
    wr("preload.js 里出现了真实调用的 utools.outPlugin() —— 插件退出会销毁自定义窗口，确认是有意为之");
  }
  if (/isDestroyed/.test(p)) ok("窗口复用带 isDestroyed 防御");
  else bad("openNavigator 缺少 isDestroyed 防御，窗口关闭后再唤起会抛异常");
}
if (appJs) {
  if (/window\.__dirnavEntered/.test(fileExists("preload.js") ? readText("preload.js") : "")) {
    ok("index.html/preload 与 onPluginEnter 的竞态守卫存在");
  }
  if (/services\.stat\(/.test(appJs)) ok("打开路径前做了 stat 预检");
  else wr("app.js 未在打开前 stat 预检 —— shellOpenPath 没有返回值，失败无法感知");
  if (/function clearFilter\s*\(/.test(appJs)) ok("存在 clearFilter（切换目录时清空过滤词）");
  else wr("没有 clearFilter，过滤词可能跨目录残留");
  if (/prevChainLen/.test(appJs)) ok("列数变化时才自动横向滚动（prevChainLen 守卫）");

  // 2026-11 交互修复批次：这些守卫对应 tools/ui-check.js 里真实复现过的问题
  if (/const seq = \+\+navSeq;/.test(appJs) && /if \(seq !== navSeq\) return;/.test(appJs)) {
    ok("导航带 navSeq 守卫（丢弃过期异步结果）");
  } else {
    bad("navigateTo/descend 缺少 navSeq 守卫：快速连续导航会被旧结果覆盖");
  }
  if ((appJs.match(/clearTimeout\(clickTimer\)/g) || []).length >= 4) {
    ok("导航/上钻/双击前都会清理单击定时器");
  } else {
    bad("未在 navigateTo/descend/goUp 里 clearTimeout(clickTimer)：先点目录再点书签会被 250ms 旧定时器带偏");
  }
  const sf = appJs.indexOf("function setFilter");
  if (sf >= 0 && /updateStatus\(\)/.test(appJs.slice(sf, sf + 600))) {
    ok("setFilter 之后刷新状态栏（筛选命中 N 项）");
  } else {
    bad("setFilter 未调用 updateStatus：过滤时状态栏不会显示「筛选命中 N 项」");
  }
  if (/cur !== DRIVES/.test(appJs)) {
    ok("添加书签不会把 __DRIVES__ 哨兵预填进路径");
  } else {
    bad("openBookmarkModal 未排除 DRIVES 哨兵：在「此电脑」视图添加书签会预填 __DRIVES__ 并保存失败");
  }
  if (/item\.addEventListener\("dblclick"/.test(appJs) && /openPath\(a\.path\)/.test(appJs)) {
    ok("书签支持双击在资源管理器中打开");
  } else {
    bad("书签缺少 dblclick -> openPath：PRD F2 要求双击锚点在资源管理器中打开");
  }

  // 2026-11 列宽拖动：直接拖列边调整宽度，并按目录记住
  if (/function buildColResizer\s*\(/.test(appJs) && /"pointerdown"/.test(appJs) && /"col-resizer"/.test(appJs)) {
    ok("列边带拖动调整条（pointerdown 起拖）");
  } else {
    bad("缺少 .col-resizer / pointerdown：无法直接拖动列边调整宽度");
  }
  if (/function rememberColWidth\s*\(/.test(appJs) && /settings\.colWidths/.test(appJs) && /savedColWidth\(col\.path\)/.test(appJs)) {
    ok("列宽按目录持久化并在重绘时恢复");
  } else {
    bad("列宽未按目录持久化：刷新或重新进入目录后拖动结果会丢失");
  }
  if (/nextWidth !== prevWidth\) config\.settings\.colWidths = \{\}/.test(appJs)) {
    ok("修改默认列宽会清空逐列覆盖值");
  } else {
    bad("修改默认列宽未清空 colWidths：设置里的默认值会对已拖过的列失效");
  }
  const appCss = fileExists("app.css") ? readText("app.css") : "";
  if (/\.col-resizer\s*\{/.test(appCss) && /body\.col-resizing/.test(appCss)) {
    ok("拖动条与拖动中光标的样式存在");
  } else {
    bad("app.css 缺少 .col-resizer / body.col-resizing 样式");
  }

  // 2026-11 快速收藏：导航器内一键收藏 + Shift 命名，重复路径不重复添加
  if (appJs.indexOf("collectCurrentFolderBookmark") >= 0 && appJs.indexOf("e.shiftKey") >= 0 && appJs.indexOf("els.addCurrentBtn.addEventListener") >= 0) {
    ok("导航器「+」支持一键收藏，Shift+点击保留命名弹窗");
  } else {
    bad("addCurrentBtn 未接入 collectCurrentFolderBookmark 或 Shift 分支");
  }
  if (appJs.indexOf("collectCurrentFolderBookmark") >= 0 && appJs.indexOf("normPath(a.path) === normPath(p)") >= 0) {
    ok("一键收藏按 normPath 去重");
  } else {
    bad("一键收藏缺少 normPath 去重：同一目录会被重复加入书签");
  }
  const storeSrc = fileExists("bookmark-store.js") ? readText("bookmark-store.js") : "";
  if (/function collectCurrentFolder\s*\(/.test(storeSrc) && /readCurrentFolderPath/.test(storeSrc)) {
    ok("bookmark-store 负责读取资源管理器当前目录");
  } else {
    bad("bookmark-store.js 缺少 collectCurrentFolder/readCurrentFolderPath");
  }
  const appHtml = fileExists("app.html") ? readText("app.html") : "";
  if (/id="addCurrentBtn"[^>]*title="[^"]*Shift/.test(appHtml)) {
    ok("「+」按钮的 title 提示 Shift 用法");
  } else {
    wr("「+」按钮 title 未提示 Shift+点击可命名");
  }
}

// ---------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------
out.push("");
out.push("---------------------------------------------------------------");
out.push("通过 " + pass + " 项  警告 " + warn + " 项  失败 " + fail + " 项");
out.push("工程目录: " + ROOT);
out.push(fail === 0
  ? "结论: 静态自检通过。注意这只是静态检查，运行时仍需在 uTools / 浏览器里真机验证。"
  : "结论: 有 " + fail + " 项失败，先修完再看运行时。");
out.push("---------------------------------------------------------------");
console.log(out.join("\n"));

process.exitCode = fail === 0 ? 0 : 1;
