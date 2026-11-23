# 目录导航器 (DirNavigator)

一个 **uTools 8.x** 插件：把 Windows 里"频繁打开深层目录找文件"这件麻烦事，做成一个**可视化、点击为主**的目录导航器。

- 左侧**书签栏**：登记常用目录（支持别名、颜色、置顶、拖动排序）。
- 右侧 **Miller 列**：像 macOS Finder 的"分栏视图"，点目录向右下钻、点文件直接打开，随时沿**面包屑**向上跳几级。
- 不用记住完整路径、不用纯键盘敲命令——识别代替回忆，专攻"反复访问"场景。

---

## 功能

| 能力 | 说明 |
| --- | --- |
| 书签锚点 | 常用目录登记为书签，一键回到起点 |
| Miller 列下钻 | 单击目录向右开新列，点多少钻多少，列宽自动收缩 |
| 面包屑上跳 | 顶部显示完整父级链路，点任意一级跳转 |
| 打开 / 定位 | 单击文件打开；双击目录在资源管理器打开；右键可"定位/复制路径" |
| 此电脑 | 底部入口枚举全部磁盘，从未登记也能浏览 |
| 实时过滤 | 工具栏搜索框过滤当前列，键盘 Ctrl+F 快速聚焦 |
| 右键菜单 | 打开 / 在资源管理器打开 / 定位 / 复制路径 / 添加书签 / 编辑 / 置顶 / 删除 |
| 键盘辅助 | ↑↓ 选择、Enter 打开、← 上一级、→ 下钻、Esc 关闭 |

---

## 文件结构

```
dir-navigator/
├── plugin.json       # 插件清单：入口、关键词、匹配指令
├── logo.svg          # 插件图标
├── index.html        # uTools 主面板兜底页（唤起独立大窗口）
├── preload.js        # 主窗口桥接：onPluginEnter 入口 → 打开导航器窗口
├── app.html          # 导航器独立窗口的 UI（SVG 图标 + 布局）
├── app.css           # 设计系统（冷中性色 + Fluent 风格）
├── app.js            # 渲染层全逻辑（书签/导航/过滤/键盘/右键/设置）
├── app-preload.js    # 导航器窗口桥接：暴露 window.services（fs 枚举/打开/存储）
├── demo-services.js  # 演示桥接：浏览器直开 app.html 时用内存目录树顶替真实 fs
├── verify.cmd        # 静态自检入口（双击运行，调用 tools/verify.js）
├── init-git.cmd      # git 初始化 + 首次提交（一次性）
├── push-github.cmd   # 建仓并推送到 GitHub（gh 或手动建空仓两种路径）
├── tools/
│   ├── verify.js     # 静态自检脚本（需 Node.js）
│   └── commit-msg.txt# 首次提交信息（UTF-8，交给 git -F 读取）
├── .github/
│   └── workflows/
│       └── verify.yml# CI：每次 push 在 Node 20 上跑一遍静态自检
├── .gitignore        # 忽略 node_modules / 构建产物 / 系统垃圾
├── .gitattributes    # 换行规范：源码 LF，.cmd 强制 CRLF
├── LICENSE           # MIT
├── PRD.md            # 产品定义（过程文档，不影响运行）
└── mockup.html       # 早期视觉稿（过程文档，不影响运行）
```

> `verify.cmd` / `init-git.cmd` / `push-github.cmd` 的**控制台输出故意用英文**：Windows 中文版 cmd 按 GBK(cp936) 解析批处理，UTF-8 文件里的中文会乱码，甚至可能"吞掉"紧跟其后的引号导致命令参数错位。中文提交信息放在 `tools/commit-msg.txt` 里由 `git -F` 读取，不经过批处理解析器。

**两条桥接链：**

- `preload.js`（主窗口）→ `window.services.openNavigator()`，负责 `onPluginEnter` 入口与唤起独立窗口。
- `app-preload.js`（独立窗口）→ `window.services.*`，负责文件系统枚举、打开/定位、对话框、`utools.db` 持久化。

**一条演示链：**

- `demo-services.js` 只在 `window.services` 不存在、且页面是**本地文件直开**（`file:`）或显式带 `?demo=1` 时安装同名接口，用一棵内存目录树 + `localStorage` 模拟一切。在 uTools 里它第一行就 return；即使桥接层意外失败也不会把假目录当真目录显示。

---

## 三种验证方式

| 方式 | 怎么用 | 能验证什么 |
| --- | --- | --- |
| **① 浏览器演示（最快，无需安装）** | 双击 `app.html`，用 Chrome/Edge 打开 | 全部视觉与交互：书签增删改/置顶/拖动、Miller 列下钻、面包屑回跳、过滤、键盘、右键菜单、设置、空态。顶部会出现「演示模式 · 模拟数据」角标；打开文件/定位只会弹提示，不真操作 |
| **② uTools 开发模式** | 见下方「安装 / 导入」 | 真实文件系统、`utools.db` 持久化、`shellOpenPath`、`readCurrentFolderPath`、右键匹配指令 |
| **③ 打包后安装** | 开发者工具「打包」出 `.upx` | 同上，且是用户实际安装路径 |

> 演示模式的数据存在浏览器 `localStorage`（键 `dirnav:demo:config`），与真实 `utools.db` 互不影响；想重置演示数据，清掉该键或换无痕窗口即可。

---

## 安装 / 导入（开发模式）

1. 打开 uTools，在搜索框输入 **`开发者工具`**（未安装则先在插件中心安装"uTools 开发者工具"）。
2. 进入开发者工具面板，选择 **导入插件项目**，选中本目录（含 `plugin.json` 的那一层）。
3. 导入后插件进入开发模式，修改文件后刷新即可生效。

> uTools 不同版本的开发者工具界面措辞可能略有差异，请以官方文档为准：
> <https://www.u-tools.cn/docs/guide/devtools.html>

---

## 使用方式

**唤起：**

- 关键词：`folders` / `目录导航` / `文件夹导航` / `dirnav` / `书签栏`
- 右键文件/文件夹 → **在目录导航器中打开**（`files` 匹配指令）
  - 选中**目录** → 锚定到该目录；
  - 选中**文件** → 锚定到其父目录并高亮该文件。

**交互（点击为主）：**

| 操作 | 效果 |
| --- | --- |
| 单击目录 | 向右下钻一列 |
| 单击文件 | 直接打开（关联程序） |
| 双击目录 | 在资源管理器中打开 |
| 单击书签 | 锚定到该书签目录 |
| 单击面包屑 | 跳到该级目录 |
| 右键 | 打开 / 定位 / 复制 / 书签操作 |

**键盘（辅助）：** `↑↓` 选择、`Enter` 打开、`←` 上一级、`→` 下钻、`Ctrl+F` 过滤、`Esc` 关闭/清过滤。

---

## 数据存储

配置保存在 `utools.db` 的文档 `_id: "dirnav:config"`：

```js
{
  _id: "dirnav:config",
  version: 1,
  anchors: [{ id, name, path, color, pinned, order, createdAt, lastVisited }],
  settings: { showFiles: true, showHidden: false, colWidth: 212, lastPath: "" }
}
```

- `anchors` 数组顺序即显示顺序；置顶=移到最前并打 pin 标记；拖动=重排序。
- `settings.lastPath` 用于下次打开时恢复上一次会话。

---

## 打包 / 发布

开发完成、验证通过后，用 uTools 开发者工具的 **打包** 功能导出 `.upx` 插件包，即可分享或提交插件市场。

---

## 本地自检

```bat
init-git.cmd    :: 首次：git init + 首次提交（提交信息读 tools/commit-msg.txt）
verify.cmd      :: 每次改动后：静态自检（需要 Node.js）
```

两个脚本都可以直接双击，控制台输出英文（原因见上一节），最后会 `pause` 停住等你看结果；在终端里调用可加 `-nopause` 参数跳过暂停。

`tools/verify.js` 覆盖：必需文件齐全、`plugin.json` 字段合法性（含 `files.fileType` 只收 `file`/`directory` 的陷阱）、四个 JS 文件的语法编译、`app.html` 的 `id` 与 `app.js` 里 `$("#id")` 选择器一一对应、SVG `<symbol>` 与 `icon()`／`href="#i-*"` 引用对应、`services` 接口在真实桥接（`app-preload.js`）与演示桥接（`demo-services.js`）之间的一致性、CSS 括号与 `var()` 变量声明、编码卫生（BOM／混用换行），以及几条历史 bug 的回归守卫（preload 必须绝对路径、Electron 隔离开关、`window.__dirnav` 钩子、`clearFilter`、`prevChainLen`）。

退出码 `0` = 通过，`1` = 有失败项。

---

## 上传到 GitHub

```bat
push-github.cmd            :: 建仓 + 推送，仓库名默认 dir-navigator
push-github.cmd my-repo    :: 指定仓库名
```

脚本的行为取决于本机环境，两种路径都会自动走通：

**有 GitHub CLI（推荐）** —— 装了 [gh](https://cli.github.com/) 并执行过 `gh auth login`，脚本会直接 `gh repo create --source=. --remote=origin --push` 建一个公开仓库并推送，你不用先在网页上建。

**没有 gh** —— 脚本提示你打开 <https://github.com/new> 创建一个**空仓库**（不要勾 README、.gitignore、license，否则首次推送会被拒），然后把仓库 URL 粘进命令行，脚本负责 `remote add` + `push -u origin main`。

两种路径都要求仓库里已经有提交，所以脚本发现没有 `.git` 时会先自动调用 `init-git.cmd`。

推上去之后，`.github/workflows/verify.yml` 会在每次 push 时用 Node 20 跑一遍 `tools/verify.js`，等于把本地自检搬到云端再验一次。

---

## 人工验证清单（约 5 分钟）

浏览器模式——双击 `app.html`（走 `demo-services.js` 的模拟数据）：

1. 左栏出现 5 个书签，每个左侧有 8×8 圆角色块
2. 点「Work」→ 面包屑出现 `Work`，右侧列出子目录
3. 点一个子目录 → 右边再开一列，面包屑变长
4. 点面包屑中间某一级 → 它右边的列全部收起
5. 点工具栏 `←` → 回到上一级
6. 双击目录 → 演示模式只弹提示（真实模式会打开资源管理器）
7. 搜索框输入 `src` → 列表只剩匹配项，状态栏显示「筛选命中 N 项」
8. 切换到另一个书签 → 搜索框自动清空，且回到该书签根目录
9. 右键条目 → 菜单出现（打开 / 在资源管理器中定位 / 复制路径 / 加为书签）
10. 工具栏「+」→ 弹窗能浏览选目录、改名、选颜色；保存后左栏多一个书签
11. 拖书签换顺序；右键书签可置顶 / 编辑 / 删除
12. 设置里关掉「显示文件」→ 列里只剩目录；重开页面仍保持

uTools 模式——开发者工具加载 `plugin.json`：

13. 输入 `folders` 回车 → 独立窗口打开，并恢复到上次目录
14. 资源管理器里右键文件夹 → 「在目录导航器中打开」→ 窗口定位到该文件夹
15. 右键一个文件 → 窗口定位到其父目录，且该文件高亮
16. 关掉窗口后再次唤起 → 窗口正常重建，不报错

---

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 窗口打开但写着「桥接层加载失败」 | preload 没跑起来：路径不对，或 Electron 的 `sandbox`/`contextIsolation` 把 `window.services` 隔离了 | `preload.js` 已用 `path.join(__dirname, "app-preload.js")` 绝对路径，并显式设置 `sandbox:false / contextIsolation:false`；若宿主版本仍隔离，`app-preload.js` 末尾会退回 `contextBridge` 通道 |
| 窗口一片空白、不显示 | 创建窗口时 `show:false`，回调没被调用就永不显示 | 回调改为闭包兜底 `arguments[0] || navWin`，并在 `onPluginEnter` 路径上直接 `show()` |
| 右键文件/文件夹没有「在目录导航器中打开」 | `plugin.json` 的 `files` 匹配指令字段非法 | `files` 的 `fileType` 只接受 `"file"` / `"directory"`，**想要文件+文件夹都匹配就整条省略**（当前即如此），`minLength/maxLength` 控制选中数量 |
| 再次右键打开时窗口停在旧目录 | 窗口复用时没有把新目标推给渲染层 | `preload.js` 的 `navigateExisting()` 通过 `webContents.executeJavaScript` 调用 `window.__dirnav.open()`，加载中会等 `did-finish-load` 再重试 |
| 插件图标在 uTools 里不显示 | 部分版本/旧清单要求 `logo` 为 png | 当前用 `logo.svg`（矢量、随主题清晰）；如遇不显示，导出 256×256 的 `logo.png` 并把 `plugin.json` 的 `logo` 改成 `logo.png` |
| 中文目录名乱码 | 文件系统返回的是 UTF-8，页面声明了 `<meta charset="utf-8">`，正常不会出现 | 若出现，检查宿主是否改写了编码；本插件全部字符串按 UTF-8 处理 |

---

## 已知限制 / 设计取舍

- **枚举用 `fs.readdirSync`（同步即时枚举）**：为的是"前后几级"秒开、零索引；单列超过 1000 项会截断并提示。跨盘全局模糊搜目录名未做（留给后续，需要 Everything 索引，且 1.5a 的 `alpha_instance` 会破坏 SDK 连接）。
- **锚点不做分组**：v1 保持扁平 + 置顶/拖动，分组留待 v2。
- **单击/双击消歧延迟 250ms**：为同时支持"单击下钻"与"双击在资源管理器打开"。
- **窗口关闭了 `sandbox`/`contextIsolation`**：Electron 20+ 默认开启会把 preload 的 `window.services` 隔离掉；本插件只加载本地页面、不加载远程内容，因此按 uTools 插件惯例关闭，以换取 Node 文件系统能力。若要接远程内容，必须重新打开隔离并改写桥接。
- **`logo.svg` 而非 png**：矢量图标在缩放/深色主题下更清晰；个别旧版本若校验格式，替换成 256×256 png 即可（见「故障排查」）。
- **`files` 匹配指令不写 `fileType`**：uTools 只接受 `file`/`directory`，省略才同时匹配文件与文件夹。
- **不调用 `utools.outPlugin()`**：官方文档写明「uTools 主窗口隐藏后，插件应用可能在用户设定时间（默认 3 分钟）内自动退出」。退出会连带销毁导航器窗口，所以这里只 `hideMainWindow()`，让插件保持已进入状态、窗口常驻；用户关闭窗口即结束会话。
- **不依赖 uTools 特有 API**：核心逻辑（书签 + Miller 列 + fs 枚举）可平移为独立 Electron/Tauri 应用，降低平台风险。

---

## 平台风险预案

产品逻辑（书签、Miller 列、面包屑、过滤、键盘）全部走 `window.services` 抽象层，不直接调用 uTools API。若未来脱离 uTools，只需重写 `app-preload.js`（把 `utools.*` 换成 Node/Electron 原生实现），`app.html` / `app.js` / `app.css` 可原样复用。
