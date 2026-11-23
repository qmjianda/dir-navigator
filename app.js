// ============================================================
// app.js —— 目录导航器渲染层
// 职责：配置加载/持久化、书签 CRUD、置顶/拖动排序、面包屑、
//       Miller 列下钻、过滤、键盘导航、右键菜单、设置、错误降级、
//       session 恢复、?open&highlight 处理、驱动器视图。
// 依赖：window.services（app-preload.js 暴露）。
// ============================================================

(function () {
  "use strict";

  // ---------- 常量 ----------
  const services = window.services;
  const DRIVES = (services && services.DRIVES_SENTINEL) || "__DRIVES__";
  const CONFIG_ID = "dirnav:config";
  const BOOKMARK_COLORS = ["#0067c0", "#c2395f", "#2e9e5b", "#d97706", "#7a5cd6", "#0e7490"];
  const MAX_ITEMS = 1000;       // 单列最多显示条数，超大目录做截断
  const DBLCLICK_MS = 250;      // 单击/双击消歧延迟

  // ---------- DOM ----------
  const $ = function (sel) { return document.querySelector(sel); };
  const els = {
    filter: $("#filter"), upBtn: $("#upBtn"), openInExplorer: $("#openInExplorer"),
    addCurrentBtn: $("#addCurrentBtn"), settingsBtn: $("#settingsBtn"), addBtn: $("#addBtn"),
    bmList: $("#bmList"), bmCount: $("#bmCount"), thisPcBtn: $("#thisPcBtn"),
    breadcrumb: $("#breadcrumb"), columns: $("#columns"), emptyState: $("#emptyState"),
    emptyAdd: $("#emptyAdd"), stTotal: $("#stTotal"), stDetail: $("#stDetail"),
    ctxMenu: $("#ctxMenu"), overlay: $("#overlay"),
    bookmarkModal: $("#bookmarkModal"), bmTitle: $("#bmTitle"), bmPath: $("#bmPath"),
    bmBrowse: $("#bmBrowse"), bmCurrent: $("#bmCurrent"), bmPathHint: $("#bmPathHint"),
    bmName: $("#bmName"), swatches: $("#swatches"), bmCancel: $("#bmCancel"), bmSave: $("#bmSave"),
    settingsModal: $("#settingsModal"), setShowFiles: $("#setShowFiles"),
    setShowHidden: $("#setShowHidden"), setColWidth: $("#setColWidth"),
    setColWidthValue: $("#setColWidthValue"), setCancel: $("#setCancel"), setDone: $("#setDone"),
    toast: $("#toast")
  };

  // ---------- 状态 ----------
  let config = null;            // 持久化配置文档（含 _id/_rev）
  let chain = [];               // 导航链 [{path,name,items,error,truncated}]
  let filterText = "";
  let selIndex = -1;            // 键盘/高亮选中项（末列索引）
  let selectedColor = BOOKMARK_COLORS[0];
  let editingBookmarkId = null; // null=新增，否则为编辑目标 id
  let contextTarget = null;     // 右键菜单目标
  let clickTimer = null;        // 单击/双击消歧
  let navSeq = 0;               // 导航序号：丢弃快速连续导航的过期异步结果
  let toastTimer = null;

  // ============================================================
  // 工具
  // ============================================================
  function icon(id) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#" + id);
    svg.appendChild(use);
    return svg;
  }
  function basename(p) {
    if (p === DRIVES) return "此电脑";
    if (/^[A-Za-z]:[\\/]?$/.test(p)) return p;
    const s = String(p).replace(/[\\/]+$/, "");
    const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  // 路径比较用（大小写不敏感、忽略末尾分隔符）
  function normPath(p) {
    return String(p || "").replace(/[\\/]+$/, "").toLowerCase();
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function currentPath() {
    return chain.length ? chain[chain.length - 1].path : null;
  }

  function toast(msg, isErr) {
    clearTimeout(toastTimer);
    els.toast.textContent = "";
    els.toast.className = "toast" + (isErr ? " err" : "");
    els.toast.appendChild(icon(isErr ? "i-close" : "i-check")).classList.add("t-ic");
    const sp = document.createElement("span");
    sp.textContent = msg;
    els.toast.appendChild(sp);
    els.toast.classList.add("show");
    toastTimer = setTimeout(function () { els.toast.classList.remove("show"); }, 2200);
  }

  // ============================================================
  // 配置加载 / 持久化
  // ============================================================
  async function loadConfig() {
    let doc = null;
    try { doc = services.getConfig(); } catch (e) { doc = null; }
    if (!doc || !Array.isArray(doc.anchors)) {
      doc = {
        _id: CONFIG_ID,
        version: 1,
        anchors: [],
        settings: { showFiles: true, showHidden: false, colWidth: 212, lastPath: "" }
      };
      try { services.saveConfig(doc); } catch (e) { /* 忽略 */ }
    }
    doc.settings = Object.assign(
      { showFiles: true, showHidden: false, colWidth: 212, lastPath: "" },
      doc.settings || {}
    );
    config = doc;
    applySettingsToUI();
  }

  function saveConfig() {
    try { services.saveConfig(config); } catch (e) { /* 忽略 */ }
  }

  function markVisited(p) {
    if (!p) return;
    config.settings.lastPath = p;
    saveConfig();
  }

  function applySettingsToUI() {
    const s = config.settings;
    els.setShowFiles.checked = s.showFiles !== false;
    els.setShowHidden.checked = !!s.showHidden;
    els.setColWidth.value = s.colWidth || 212;
    els.setColWidthValue.textContent = (s.colWidth || 212) + " px";
    document.documentElement.style.setProperty("--col-w", (s.colWidth || 212) + "px");
  }

  // ============================================================
  // 书签
  // ============================================================
  function renderBookmarks() {
    els.bmList.innerHTML = "";
    const rootPath = chain.length ? chain[0].path : null;
    config.anchors.forEach(function (a) {
      const item = document.createElement("div");
      item.className = "bm-item";
      item.dataset.id = a.id;
      item.draggable = true;
      if (rootPath && normPath(a.path) === normPath(rootPath)) item.classList.add("selected");

      const dot = document.createElement("span");
      dot.className = "bm-dot";
      dot.style.background = a.color || BOOKMARK_COLORS[0];
      const name = document.createElement("span");
      name.className = "bm-name";
      name.textContent = a.name || basename(a.path);
      name.title = a.path;

      item.appendChild(dot);
      item.appendChild(name);
      if (a.pinned) {
        const pin = icon("i-pin");
        pin.classList.add("bm-pin");
        item.appendChild(pin);
      }

      item.title = "单击导航 · 双击在资源管理器中打开";
      item.addEventListener("click", function () { navigateTo(a.path); });
      // 双击不再等待 250ms 消歧：第一次单击已经导航，双击只是额外打开资源管理器，
      // 这样单击保持即时响应，同时满足 PRD F2。
      item.addEventListener("dblclick", function () {
        clearTimeout(clickTimer);
        clickTimer = null;
        openPath(a.path);
      });
      item.addEventListener("contextmenu", function (e) { openContextMenu(e, { kind: "bookmark", anchor: a }); });
      item.addEventListener("dragstart", function (e) { onBmDragStart(e, a); });
      item.addEventListener("dragover", function (e) { onBmDragOver(e, item); });
      item.addEventListener("drop", function (e) { onBmDrop(e, a); });
      item.addEventListener("dragend", clearDragState);

      els.bmList.appendChild(item);
    });
    els.bmCount.textContent = config.anchors.length ? config.anchors.length + " 个" : "";
  }

  let dragId = null;
  function onBmDragStart(e, a) {
    dragId = a.id;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", a.id); } catch (err) { /* 忽略 */ }
    const el = e.target && e.target.closest ? e.target.closest(".bm-item") : null;
    if (el) el.classList.add("dragging");
  }
  function onBmDragOver(e, item) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDragOver();
    item.classList.add("drag-over");
  }
  function onBmDrop(e, target) {
    e.preventDefault();
    const fromId = dragId;
    clearDragState();
    if (!fromId || fromId === target.id) return;
    const fromIdx = config.anchors.findIndex(function (a) { return a.id === fromId; });
    const toIdx = config.anchors.findIndex(function (a) { return a.id === target.id; });
    if (fromIdx < 0 || toIdx < 0) return;
    const moved = config.anchors.splice(fromIdx, 1)[0];
    config.anchors.splice(toIdx, 0, moved);
    saveConfig();
    renderBookmarks();
  }
  function clearDragOver() {
    els.bmList.querySelectorAll(".drag-over").forEach(function (el) { el.classList.remove("drag-over"); });
  }
  function clearDragState() {
    dragId = null;
    clearDragOver();
    els.bmList.querySelectorAll(".dragging").forEach(function (el) { el.classList.remove("dragging"); });
  }

  function togglePin(id) {
    const idx = config.anchors.findIndex(function (a) { return a.id === id; });
    if (idx < 0) return;
    const a = config.anchors[idx];
    if (a.pinned) {
      a.pinned = false;
    } else {
      a.pinned = true;
      config.anchors.splice(idx, 1);
      config.anchors.unshift(a);
    }
    saveConfig();
    renderBookmarks();
  }

  function deleteBookmark(id) {
    config.anchors = config.anchors.filter(function (a) { return a.id !== id; });
    saveConfig();
    renderBookmarks();
    toast("书签已删除");
  }

  // ============================================================
  // 导航（Miller 列）
  // ============================================================
  async function navigateTo(targetPath, highlightName) {
    if (!config) return;
    const seq = ++navSeq;
    clearTimeout(clickTimer);
    clickTimer = null;
    const p = String(targetPath || "");
    chain = [];
    selIndex = -1;
    clearFilter();
    if (p === DRIVES) {
      chain.push({ path: DRIVES, name: "此电脑", items: [], error: null, truncated: 0 });
    } else {
      chain.push({ path: p, name: basename(p), items: [], error: null, truncated: 0 });
      // 记录书签访问时间
      const a = config.anchors.find(function (x) { return x.path === p; });
      if (a) a.lastVisited = Date.now();
    }
    await loadColumn(0);
    if (seq !== navSeq) return; // 已有更新的导航，丢弃本次结果
    renderAll();
    markVisited(p);
    if (highlightName) highlightItem(highlightName);
  }

  async function descend(item, colIndex) {
    if (!item || !item.isDir) return;
    const seq = ++navSeq;
    clearTimeout(clickTimer);
    clickTimer = null;
    chain = chain.slice(0, colIndex + 1);
    chain.push({ path: item.path, name: item.name, items: [], error: null, truncated: 0 });
    selIndex = -1;
    clearFilter();
    await loadColumn(chain.length - 1);
    if (seq !== navSeq) return; // 快速点了别处，别让旧列覆盖新导航
    renderAll();
    markVisited(item.path);
  }

  async function goUp() {
    clearTimeout(clickTimer);
    clickTimer = null;
    clearFilter();
    if (chain.length > 1) {
      chain.pop();
      selIndex = -1;
      renderAll();
      markVisited(currentPath());
      return;
    }
    const cur = currentPath();
    if (!cur || cur === DRIVES) { renderColumns(); return; }
    const parts = services.splitPath(cur);
    if (parts.length > 1) {
      await navigateTo(parts[parts.length - 2].path);
    }
  }

  function showDrives() {
    navigateTo(DRIVES);
  }

  function openInExplorerCurrent() {
    const cur = currentPath();
    if (!cur || cur === DRIVES) return;
    openPath(cur);
  }

  function openPath(p) {
    if (!p) return;
    // shellOpenPath 没有返回值，无法用返回值判断成败：先 stat 预检，
    // 路径不存在时给出明确提示，避免"点了没反应"。
    let st = null;
    try { st = services.stat(p); } catch (e) { st = null; }
    if (!st || !st.exists) { toast("路径不存在或已失效：" + p, true); return; }
    try {
      services.openPath(p);
    } catch (e) {
      toast("打开失败：" + ((e && e.message) || String(e)), true);
    }
  }

  // 加载第 idx 列的内容
  async function loadColumn(idx) {
    const col = chain[idx];
    if (!col) return;
    col.error = null;
    col.truncated = 0;
    try {
      const res = services.listDir(col.path, {
        showHidden: config.settings.showHidden,
        showFiles: config.settings.showFiles
      });
      if (res && res.ok) {
        col.items = res.items || [];
        if (col.items.length > MAX_ITEMS) {
          col.truncated = col.items.length - MAX_ITEMS;
          col.items = col.items.slice(0, MAX_ITEMS);
        }
      } else if (res) {
        col.error = res.message || "无法访问该目录";
      } else {
        col.error = "未知错误";
      }
    } catch (e) {
      col.error = (e && e.message) || String(e);
    }
  }

  function highlightItem(name) {
    if (!chain.length) return;
    const items = getVisibleItems(chain.length - 1);
    const idx = items.findIndex(function (it) { return it.name === name; });
    if (idx >= 0) {
      selIndex = idx;
      renderColumns();
      scrollSelectedIntoView();
    }
  }

  // ============================================================
  // 渲染
  // ============================================================
  function renderAll() {
    renderColumns();
    renderBreadcrumb();
    renderBookmarks();
    updateStatus();
    updateToolbar();
  }

  function getVisibleItems(colIndex) {
    const col = chain[colIndex];
    if (!col || col.error) return [];
    return (colIndex === chain.length - 1) ? filterItems(col.items) : col.items;
  }

  function filterItems(items) {
    if (!filterText) return items;
    const q = filterText.toLowerCase();
    return items.filter(function (it) { return String(it.name).toLowerCase().indexOf(q) >= 0; });
  }

  let prevChainLen = 0;
  function renderColumns() {
    const wrap = els.columns;
    wrap.innerHTML = "";
    if (!chain.length) {
      els.emptyState.classList.remove("hidden");
      return;
    }
    els.emptyState.classList.add("hidden");

    chain.forEach(function (col, i) {
      const colEl = document.createElement("div");
      colEl.className = "col";

      const head = document.createElement("div");
      head.className = "col-head";
      head.title = col.path;
      const hIcon = icon(col.path === DRIVES ? "i-computer" : "i-folder");
      hIcon.classList.add("ch-ic");
      const hName = document.createElement("span");
      hName.textContent = col.name;
      head.appendChild(hIcon);
      head.appendChild(hName);
      colEl.appendChild(head);

      const list = document.createElement("div");
      list.className = "col-list";

      if (col.error) {
        const err = document.createElement("div");
        err.className = "col-item error-row";
        err.textContent = "无法访问：" + col.error;
        list.appendChild(err);
      } else {
        const items = (i === chain.length - 1) ? filterItems(col.items) : col.items;
        if (!items.length) {
          const empty = document.createElement("div");
          empty.className = "col-item";
          empty.style.color = "var(--text-3)";
          empty.style.cursor = "default";
          empty.textContent = "（空目录）";
          list.appendChild(empty);
        } else {
          items.forEach(function (item, idx) {
            list.appendChild(buildItem(item, i, idx));
          });
        }
      }

      colEl.appendChild(list);
      wrap.appendChild(colEl);
    });

    // 只有"又开了一列"时才横向滚到最右，避免过滤/键盘移动时视口乱跳
    if (chain.length > prevChainLen) {
      requestAnimationFrame(function () { wrap.scrollLeft = wrap.scrollWidth; });
    }
    prevChainLen = chain.length;
  }

  function buildItem(item, colIndex, idx) {
    const el = document.createElement("div");
    el.className = "col-item";
    if (colIndex === chain.length - 1 && idx === selIndex) el.classList.add("selected");

    const ic = icon(item.isDrive ? "i-drive" : (item.isDir ? "i-folder" : "i-file"));
    ic.classList.add("ci-ic");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = item.name;
    el.appendChild(ic);
    el.appendChild(name);

    el.addEventListener("click", function () {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(function () {
        clickTimer = null;
        if (item.isDir) descend(item, colIndex);
        else openPath(item.path);
      }, DBLCLICK_MS);
    });
    el.addEventListener("dblclick", function () {
      clearTimeout(clickTimer);
      clickTimer = null;
      openPath(item.path); // 目录→资源管理器打开；文件→打开
    });
    el.addEventListener("contextmenu", function (e) {
      openContextMenu(e, { kind: (item.isDir ? "dir" : "file"), item: item, colIndex: colIndex });
    });
    return el;
  }

  function renderBreadcrumb() {
    const bc = els.breadcrumb;
    bc.innerHTML = "";
    if (!chain.length) return;
    const lastPath = chain[chain.length - 1].path;
    if (lastPath === DRIVES) {
      bc.appendChild(makeCrumb("此电脑", DRIVES, true, true));
      return;
    }
    const parts = services.splitPath(lastPath);
    const rootPath = chain[0].path;
    parts.forEach(function (seg, i) {
      const isRoot = seg.path === rootPath;
      const isLast = i === parts.length - 1;
      bc.appendChild(makeCrumb(seg.name, seg.path, isRoot, isLast));
      if (i < parts.length - 1) {
        const sep = icon("i-chev");
        sep.classList.add("crumb-sep");
        bc.appendChild(sep);
      }
    });
  }

  function makeCrumb(name, p, isRoot, isLast) {
    const wrap = document.createElement("span");
    wrap.className = "crumb";
    const btn = document.createElement("button");
    btn.className = "crumb-btn" + (isRoot ? " root" : "") + (isLast ? " cur" : "");
    if (!isLast) {
      const ic = icon("i-folder");
      ic.classList.add("crumb-ic");
      btn.appendChild(ic);
    }
    const nm = document.createElement("span");
    nm.className = "crumb-name";
    nm.textContent = name;
    nm.title = p;
    btn.appendChild(nm);
    if (!isLast) {
      btn.addEventListener("click", function () { navigateTo(p); });
    }
    btn.addEventListener("contextmenu", function (e) {
      openContextMenu(e, { kind: "crumb", path: p });
    });
    wrap.appendChild(btn);
    return wrap;
  }

  function updateStatus() {
    if (!chain.length) { els.stTotal.textContent = ""; els.stDetail.textContent = ""; return; }
    const last = chain[chain.length - 1];
    if (last.error) {
      els.stTotal.textContent = "";
      els.stDetail.textContent = last.error;
      return;
    }
    const items = getVisibleItems(chain.length - 1);
    const n = items.length;
    const dirs = items.filter(function (i) { return i.isDir; }).length;
    const files = n - dirs;
    els.stTotal.textContent = n + " 项";
    let detail = "";
    if (dirs) detail += dirs + " 目录";
    if (files) detail += (detail ? " · " : "") + files + " 文件";
    if (filterText) detail += (detail ? " · " : "") + "筛选命中 " + n + " 项";
    if (last.truncated) detail += "（仅显示前 " + MAX_ITEMS + " 项）";
    els.stDetail.textContent = detail;
  }

  function updateToolbar() {
    els.upBtn.disabled = !chain.length;
    els.openInExplorer.disabled = !chain.length || currentPath() === DRIVES;
  }

  // ============================================================
  // 过滤
  // ============================================================
  function setFilter(v) {
    filterText = v;
    selIndex = -1;
    renderColumns();
    updateStatus();
  }

  function clearFilter() {
    filterText = "";
    els.filter.value = "";
  }

  // ============================================================
  // 键盘导航
  // ============================================================
  function moveSelection(delta) {
    const idx = chain.length - 1;
    if (idx < 0) return;
    const items = getVisibleItems(idx);
    if (!items.length) return;
    if (selIndex < 0) selIndex = 0;
    else selIndex = Math.max(0, Math.min(items.length - 1, selIndex + delta));
    renderColumns();
    scrollSelectedIntoView();
  }

  function activateSelection() {
    const idx = chain.length - 1;
    if (idx < 0) return;
    const items = getVisibleItems(idx);
    const item = items[selIndex];
    if (!item) return;
    if (item.isDir) descend(item, idx);
    else openPath(item.path);
  }

  function scrollSelectedIntoView() {
    const sel = els.columns.querySelector(".col-item.selected");
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
  }

  // ============================================================
  // 右键菜单
  // ============================================================
  function openContextMenu(e, target) {
    e.preventDefault();
    contextTarget = target;
    const menu = els.ctxMenu;
    menu.innerHTML = "";
    buildContextItems(target).forEach(function (it) {
      if (it === "---") {
        const sep = document.createElement("div");
        sep.className = "ctx-sep";
        menu.appendChild(sep);
        return;
      }
      const row = document.createElement("div");
      row.className = "ctx-item" + (it.danger ? " danger" : "");
      const ic = icon(it.iconId || "i-file");
      ic.classList.add("ctx-ic");
      const sp = document.createElement("span");
      sp.textContent = it.label;
      row.appendChild(ic);
      row.appendChild(sp);
      row.addEventListener("click", function () { hideContextMenu(); it.action(); });
      menu.appendChild(row);
    });
    menu.classList.remove("hidden");
    const rect = menu.getBoundingClientRect();
    let x = e.clientX, y = e.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
    menu.style.left = Math.max(0, x) + "px";
    menu.style.top = Math.max(0, y) + "px";
  }

  function hideContextMenu() {
    els.ctxMenu.classList.add("hidden");
    contextTarget = null;
  }

  function buildContextItems(target) {
    const items = [];
    if (target.kind === "dir") {
      items.push({ label: "打开", iconId: "i-folder", action: function () { descend(target.item, target.colIndex); } });
      items.push({ label: "在资源管理器中打开", iconId: "i-open", action: function () { openPath(target.item.path); } });
      items.push({ label: "在资源管理器中定位", iconId: "i-open", action: function () { services.showItem(target.item.path); } });
      items.push("---");
      items.push({ label: "复制路径", iconId: "i-copy", action: function () { services.copyText(target.item.path); toast("已复制路径"); } });
      items.push({ label: "添加为书签", iconId: "i-plus", action: function () { openBookmarkModal(null, target.item.path, target.item.name); } });
    } else if (target.kind === "file") {
      items.push({ label: "打开", iconId: "i-open", action: function () { openPath(target.item.path); } });
      items.push({ label: "在资源管理器中定位", iconId: "i-open", action: function () { services.showItem(target.item.path); } });
      items.push("---");
      items.push({ label: "复制路径", iconId: "i-copy", action: function () { services.copyText(target.item.path); toast("已复制路径"); } });
    } else if (target.kind === "bookmark") {
      const a = target.anchor;
      items.push({ label: "打开", iconId: "i-folder", action: function () { navigateTo(a.path); } });
      items.push({ label: "在资源管理器中打开", iconId: "i-open", action: function () { openPath(a.path); } });
      items.push({ label: "在资源管理器中定位", iconId: "i-open", action: function () { services.showItem(a.path); } });
      items.push("---");
      items.push({ label: "复制路径", iconId: "i-copy", action: function () { services.copyText(a.path); toast("已复制路径"); } });
      items.push({ label: "编辑", iconId: "i-edit", action: function () { openBookmarkModal(a.id); } });
      items.push({ label: a.pinned ? "取消置顶" : "置顶", iconId: "i-pin", action: function () { togglePin(a.id); } });
      items.push("---");
      items.push({ label: "删除", iconId: "i-trash", danger: true, action: function () { deleteBookmark(a.id); } });
    } else if (target.kind === "crumb") {
      items.push({ label: "复制路径", iconId: "i-copy", action: function () { services.copyText(target.path); toast("已复制路径"); } });
    }
    return items;
  }

  // ============================================================
  // 书签弹窗
  // ============================================================
  function buildSwatches() {
    els.swatches.innerHTML = "";
    BOOKMARK_COLORS.forEach(function (c) {
      const s = document.createElement("div");
      s.className = "swatch";
      s.style.background = c;
      s.dataset.color = c;
      if (c === selectedColor) s.classList.add("sel");
      s.addEventListener("click", function () {
        selectedColor = c;
        els.swatches.querySelectorAll(".swatch").forEach(function (x) { x.classList.remove("sel"); });
        s.classList.add("sel");
      });
      els.swatches.appendChild(s);
    });
  }

  function openBookmarkModal(id, presetPath, presetName) {
    editingBookmarkId = id || null;
    if (id) {
      const a = config.anchors.find(function (x) { return x.id === id; });
      if (!a) return;
      els.bmTitle.textContent = "编辑书签";
      els.bmPath.value = a.path;
      els.bmName.value = a.name || "";
      selectedColor = a.color || BOOKMARK_COLORS[0];
    } else {
      els.bmTitle.textContent = "添加书签";
      const cur = currentPath();
      els.bmPath.value = presetPath || (cur && cur !== DRIVES ? cur : "");
      els.bmName.value = presetName || "";
      selectedColor = BOOKMARK_COLORS[0];
    }
    buildSwatches();
    els.bmPathHint.textContent = "";
    els.bmPathHint.classList.remove("ok");
    showOverlay(els.bookmarkModal);
    setTimeout(function () { els.bmPath.focus(); }, 50);
  }

  function saveBookmarkFromModal() {
    const p = els.bmPath.value.trim();
    if (!p) { els.bmPathHint.textContent = "请输入路径"; return; }
    let st;
    try { st = services.stat(p); } catch (e) { st = { exists: false }; }
    if (!st || !st.exists || !st.isDir) {
      els.bmPathHint.textContent = "目录不存在或不是文件夹";
      return;
    }
    const name = els.bmName.value.trim() || basename(p);
    const isAdd = !editingBookmarkId;
    if (editingBookmarkId) {
      const a = config.anchors.find(function (x) { return x.id === editingBookmarkId; });
      if (a) {
        a.path = p; a.name = name; a.color = selectedColor;
      } else {
        els.bmPathHint.textContent = "该书签已不存在，请重新添加";
        return;
      }
    } else {
      const dup = config.anchors.find(function (x) { return normPath(x.path) === normPath(p); });
      if (dup) {
        els.bmPathHint.textContent = "该目录已在书签里：" + (dup.name || dup.path);
        return;
      }
      config.anchors.push({
        id: uid(), name: name, path: p, color: selectedColor,
        pinned: false, order: config.anchors.length,
        createdAt: Date.now(), lastVisited: Date.now()
      });
    }
    saveConfig();
    renderBookmarks();
    closeOverlay();
    toast(isAdd ? "书签已添加" : "书签已更新");
    if (isAdd) navigateTo(p);
  }

  // ============================================================
  // 设置弹窗
  // ============================================================
  function openSettings() {
    applySettingsToUI();
    showOverlay(els.settingsModal);
  }

  async function applySettings() {
    config.settings.showFiles = els.setShowFiles.checked;
    config.settings.showHidden = els.setShowHidden.checked;
    config.settings.colWidth = parseInt(els.setColWidth.value, 10) || 212;
    saveConfig();
    applySettingsToUI();
    closeOverlay();
    // 重新加载所有列以应用 showFiles / showHidden
    for (let i = 0; i < chain.length; i++) {
      await loadColumn(i);
    }
    renderAll();
  }

  // ============================================================
  // 弹层通用
  // ============================================================
  function showOverlay(modal) {
    els.overlay.classList.remove("hidden");
    els.bookmarkModal.classList.add("hidden");
    els.settingsModal.classList.add("hidden");
    modal.classList.remove("hidden");
  }
  function closeOverlay() {
    els.overlay.classList.add("hidden");
  }

  // ============================================================
  // 事件绑定
  // ============================================================
  function bindEvents() {
    // 工具栏
    els.upBtn.addEventListener("click", goUp);
    els.openInExplorer.addEventListener("click", openInExplorerCurrent);
    els.settingsBtn.addEventListener("click", openSettings);
    els.addCurrentBtn.addEventListener("click", async function () {
      const p = await services.getCurrentFolder();
      if (p) openBookmarkModal(null, p, basename(p));
      else toast("未能获取当前资源管理器目录（请先打开一个资源管理器窗口）", true);
    });
    // 侧栏
    els.addBtn.addEventListener("click", function () { openBookmarkModal(null); });
    els.thisPcBtn.addEventListener("click", showDrives);
    els.emptyAdd.addEventListener("click", function () { openBookmarkModal(null); });
    // 过滤
    els.filter.addEventListener("input", function () { setFilter(els.filter.value); });
    // 书签弹窗
    els.bmBrowse.addEventListener("click", function () {
      const p = services.pickFolder(els.bmPath.value.trim() || undefined);
      if (p) els.bmPath.value = p;
    });
    els.bmCurrent.addEventListener("click", async function () {
      const p = await services.getCurrentFolder();
      if (p) els.bmPath.value = p;
      else toast("未能获取当前资源管理器目录", true);
    });
    els.bmCancel.addEventListener("click", closeOverlay);
    els.bmSave.addEventListener("click", saveBookmarkFromModal);
    // 设置弹窗
    els.setCancel.addEventListener("click", closeOverlay);
    els.setDone.addEventListener("click", applySettings);
    els.setColWidth.addEventListener("input", function () {
      els.setColWidthValue.textContent = els.setColWidth.value + " px";
    });
    // 弹层点击遮罩关闭
    els.overlay.addEventListener("click", function (e) {
      if (e.target === els.overlay) closeOverlay();
    });
    // 全局
    // 全局：只拦非输入控件的右键，保留输入框里原生的复制/粘贴菜单
    document.addEventListener("contextmenu", function (e) {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      e.preventDefault();
    });
    document.addEventListener("click", function (e) {
      if (!els.ctxMenu.classList.contains("hidden") && !els.ctxMenu.contains(e.target)) hideContextMenu();
    });
    document.addEventListener("keydown", onKeydown);
    window.addEventListener("resize", function () { hideContextMenu(); });
  }

  function closeWindow() {
    // 演示模式没有真实窗口可关，给个提示避免「按了没反应」
    if (services.demo) { toast("演示模式：真实插件中按 Esc 会关闭窗口"); return; }
    try { window.close(); } catch (e) { /* 忽略 */ }
  }

  function onKeydown(e) {
    // 弹层打开时
    if (!els.overlay.classList.contains("hidden")) {
      if (e.key === "Escape") closeOverlay();
      if (e.key === "Enter" && !els.bookmarkModal.classList.contains("hidden")) {
        if (document.activeElement === els.bmPath || document.activeElement === els.bmName) {
          e.preventDefault();
          saveBookmarkFromModal();
        }
      }
      return;
    }
    // 右键菜单打开时
    if (!els.ctxMenu.classList.contains("hidden")) {
      if (e.key === "Escape") hideContextMenu();
      return;
    }
    // 过滤输入框聚焦时
    if (document.activeElement === els.filter) {
      if (e.key === "Escape") {
        els.filter.value = "";
        setFilter("");
        els.filter.blur();
      }
      return;
    }
    if (e.key === "Escape") {
      // 级联：有过滤词先清过滤，否则关闭窗口（PRD F7）
      if (filterText) {
        els.filter.value = "";
        setFilter("");
        return;
      }
      closeWindow();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      els.filter.focus();
      els.filter.select();
      return;
    }
    if (e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); moveSelection(1); return; }
    if (e.key === "Enter") { e.preventDefault(); activateSelection(); return; }
    if (e.key === "ArrowLeft" || e.key === "Backspace") { e.preventDefault(); goUp(); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); activateSelection(); return; }
  }

  // ============================================================
  // 启动
  // ============================================================
  async function init() {
    if (!services) {
      document.body.innerHTML = '<div style="padding:40px;font-family:Segoe UI;color:#c42b1c;">桥接层加载失败：请通过 uTools 插件入口打开本窗口。</div>';
      return;
    }
    bindEvents();
    await loadConfig();
    buildSwatches();
    renderBookmarks();

    const params = new URLSearchParams(location.search);
    const openPath = params.get("open");
    const highlight = params.get("highlight");

    if (openPath) {
      await navigateTo(openPath, highlight || null);
    } else if (config.settings.lastPath) {
      await navigateTo(config.settings.lastPath, null);
    } else if (config.anchors.length) {
      const first = config.anchors.find(function (a) { return a.pinned; }) || config.anchors[0];
      await navigateTo(first.path, null);
    } else {
      renderAll(); // 空态：提示添加书签或浏览此电脑
    }
  }

  // ============================================================
  // 对外钩子：供 preload.js 驱动「已打开窗口」跳转
  // ============================================================
  window.__dirnav = {
    open: function (p, highlight) {
      if (!p) return;
      Promise.resolve(navigateTo(p, highlight || null)).catch(function () { /* 忽略 */ });
    }
  };
  // 演示桥接层复用同一套 toast 视觉
  window.__dirnavToast = toast;

  init().catch(function (e) {
    const box = document.createElement("div");
    box.style.cssText = "padding:40px;font-family:Segoe UI;color:#c42b1c;line-height:1.6";
    box.textContent = "初始化失败：" + ((e && e.message) || String(e));
    document.body.innerHTML = "";
    document.body.appendChild(box);
  });
})();
