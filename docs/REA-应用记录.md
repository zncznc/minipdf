# 这次复刻里实际用到的 REA / Eleven 写法

对象：`D:\REA` 下的 REA 提示词契约（`REA提示词-完整版.md`）、`eleven-skills/*`、
`agent驱动GUI协议-规格.md`。下面只记"真的落到了代码或验收里"的部分，不列口号。

---

## 1. first-look：先确认对象是什么，再动手

对 `Acrobat DC 2023\Setup.exe` 做了一次 first-look：

| 观察（Observation） | 证据 |
|---|---|
| 安装器是 MSI 引导器，不是单文件 exe | `Setup.exe` 420 KB；同目录 `AcroPro.msi` 13 MB + 7 个 CAB + 一个 340 MB MSP |
| 主安装包是 `AcroPro.msi`，带 25 种语言的 MST | `setup.ini` 的 `[Product] msi=AcroPro.msi`、`Languages=2052;...` |
| 界面文案不在可直接读的流里 | `!Feature` / `!UIText` 提取出来是 MSI 压缩表，`strings` 无有效文本 |

**Unknown（没有当成结论）**：Acrobat 的具体菜单文案、图标与布局参数没有从安装包中取到。
因此界面是按"公开可见的行为面 + 通用交互惯例"重建的，不声称逐像素一致。
这也决定了后续验收口径：**验行为，不验像素**。

---

## 2. Evidence discipline：把"看到"与"推断"分开

README 的验收表只写工具能复现的数字（命中 16 处、文本长度 767→0、注释 7 种读回 7 种），
没有写"和 Acrobat 一模一样"这种无法证伪的话。能力缺口单列一张表，写清为什么不做
（AES 加密、OCR、正文重排），而不是留一个点了没反应的按钮。

对应 REA 的四条纪律里最有用的一条：

> 证据不全导致的"没看到"不等于"不存在"。

所以 `!UIText` 读不出字符串，结论是"这条证据路径不可用"，不是"Acrobat 没有这些文案"。

---

## 3. verify_reconstruction：每条主张都要有 pass / fail / unknown

`MINIPDF_SMOKE` + `MINIPDF_SCENE` 把"声称"变成可重跑的断言：

| 主张 | 判据 | 结果 |
|---|---|---|
| 能写标准注释 | 写完后用 pdf.js `getAnnotations()` 读 subtype | 7/7 命中 |
| 中文便签不乱码 | 读回 `contentsObj.str` 与原文比对 | 一致 |
| 表单能写回 | pdf.js 与 pdf-lib 两侧读 `/V` | 都是 `Ada Lovelace` |
| 修订是真删 | 栅格化后该页文本长度 | 767 → 0 |
| 排序真改页序 | 移动后第 1 页文本 | 变成原第 3 页 |

失败场景也保留：`unsupported tool` 返回可执行提示；加密文件保存失败会明确说
"不支持写回加密文件"，而不是静默生成一个坏文件。

---

## 4. Eleven 的交付口径：报告模板 + 停止条件

- 每个场景的 smoke 输出是固定字段（`pages / rendered / annots / savedAnnots / ok`），
  不是一段"我完成了"的作文；
- 明确停止条件：不做 OCR、不做加密、不做正文重排——理由写进 README，避免"越做越像半成品"；
- 遇到 `constructor.name` 在压缩产物里失效这种坑，写进"踩过的坑"，让下次不用再撞。

---

## 5. agent 驱动 GUI 协议：只抄骨架

按 `agent驱动GUI协议-规格.md` 落了一个最小实现（`electron/main.cjs` + `app/js/app.mjs`）：

| 规格里的要求 | 实现 |
|---|---|
| 宿主持有全部状态 | 桥只做转发，状态在渲染进程的 `S` / `viewer` 里 |
| 一行一 JSON、一请求一响应 | HTTP + JSON，`{ok,text,result}` |
| 读上下文 | `current_view`（文档、页、缩放、工具、面板、选中注释） |
| 改视线 | `open_target`（页 / 矩形 / 注释）、`set_view`（面板 / 缩放 / 工具 / 主题） |
| 写项目 | `annotate`（写注释，但不落盘，仍需人按 `Ctrl+S`） |
| 建议性写 | `propose_patch`（只记录 + 提示，永不自动应用） |
| 错误要可执行 | 未知工具返回「不支持的工具 X」 |

没有做 REST/WebSocket 之外的协议，也没有把工具调用直接映射成"立刻写盘"。

---

## 6. 没照搬的

- Eleven 的 `shader-check` / `gpu_profile`：Metal 专用，本机没有对应通道；
- `open_function` 这类"驱动另一个窗口"的工具：MiniPDF 的被观察对象是 PDF 页面，
  用 `open_target` 代替，没必要再造一层"函数视图"；
- REA 的 `compare_application_versions`：手上只有一个 Acrobat 版本，没有可比对象，
  强行比较会变成编造。

---

## 7. 结论

REA 那套东西真正有用的不是"提示词模板"，而是三条约束：
**先看证据再下结论、每条主张都要能复跑、做不到就明说**。
MiniPDF 的验收表和"没做的"清单，就是这三条在工程上的落点。

## 1.0.1：修「编辑基本不能用」

**症状**：选「编辑 → 添加文本」，按钮亮着，点页面没反应。

**定位**（读代码 5 分钟，不靠猜）：`viewer.mjs` 里 `DRAW_TOOLS` 只写了 `freetext`，
而 UI（工具条 / 注释面板 / 编辑面板）用的工具 id 是 `textbox`。
`onPointerDown` 第一道闸就是 `if (!DRAW_TOOLS.has(this.tool)) return;`，
于是点击被静默吞掉 —— 没有报错、没有日志，只有"按钮没反应"。

**连带修掉的四处**（都是同一个功能链路上一试就露的）：

1. `contenteditable` 回车生成 `<div>`，`textContent` 把换行吃掉 → 存进去两行变一行。
2. 选中框后按退格，外层 keydown 把整个框删了 → 加 `isContentEditable` 判断。
3. 点一下框就 `renderAnnotations()` 重建 DOM，刚拿到的焦点被扔掉 → 选中态只切 class。
4. 图片/签名固定 132×20pt，宽高比被拉扁 → 按 `naturalWidth/Height` 放置。

**加的东西**：框高随文字自动增长、白底覆盖原文（默认开，可关）、宽度可调、
方向键 1pt 微调、签名自动裁白边、工具面板加字号。

**证据**（`MINIPDF_SCENE=edit`，打包版同样跑通）：

| 主张 | 读数 |
|---|---|
| 点页面出框 | `boxCreated: 1` |
| 输入留住 | 3 行、框高 51.5pt（= 3×15.84+4） |
| 框里退格不删框 | `backspaceKeptBox: true` |
| 图片不变形 | 400×100 的图 → `imageRatio: 4` |
| 签名不变形 | 240×80 → `signRatio: 3` |
| 白底生效 | 同区域黑色像素 7713（白底）vs 8293（透明） |
| 存进去能看见 | 文本区 3349 个暗像素、3 个 Image XObject |
