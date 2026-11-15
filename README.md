# dsh-md-panel

右侧栏的「知识库」面板：把本地 Markdown 知识库（默认 `~/KnowledgeBase`，可用配置或环境变量改）变成 DSH 里随手可翻、随手可问的一块面板 —— 聊天在左，知识库在右，边读边问。

## 它能干什么

- **右侧栏入口**：
  - 会话标题右侧多一个书本按钮，点一下把「知识库」页开在右栏（页签与 Chat / Trajectory / Agent Browser 并列）；
  - 右栏的「+」引导页里也有「知识库」胶囊；
  - 实现是标准两阶段注册：`ctx.sidebarRightTabs.register({ id: 'dsh-md-panel', kind: 'kbPanel', … })` 定义页类型，正文挂 `sidebar.right.pane.tab`、标题挂 `sidebar.right.pane.tab.title`。
- **目录可收起**：面板顶栏「◀ 收起 / ☰ 目录」；宽屏（≥720px）目录与正文左右并排，窄屏上下叠（目录最多占 44% 高）。收起状态记在 `localStorage`（`dsh-md-panel:side-collapsed`），下次打开还是上次那个样子。
- **实时同步**：宿主每 2 秒扫一次文件指纹（路径 + 大小 + mtime），有变化就 SSE 推给浏览器。存盘即刷新，当前打开的那篇会静默重载，不用手动点刷新。
- **五种视图**：栏目树 / 全文搜索（命中行高亮）/ 最近更新 / 收藏（`localStorage`）/ 待补 frontmatter。
- **Markdown 预览**：标题锚点、大纲、表格、代码块、任务列表、`[[wiki]]` 与相对链接（面板内跳转）、`95-素材/` 图片（走 `/md-panel/api/asset`）。
- **frontmatter 徽章**：type / status / updated / tags，其余字段也摊开显示；缺 `type`、`updated`、`status` 会亮黄点并提示（跟 `dsh-kb-guard` 同一套规则）。
- **出链 / 反向链接**：谁引用了这篇、这篇又指向谁，一眼看得到。
- **接入对话（默认走当前会话）**：所有提问默认**追加进当前正在跑的这个会话的输入栏**，不打断手头对话、不另开会话。机制：在 `conversation.input.left` 挂一个不渲染的桥接组件拿会话的 `inputActions`，用 `captureInsertion()` + `insertText()` 插到光标处——不会覆盖你已经打的字，插不上就退回复制剪贴板。
  - 文档右上「引用」→ 只放这篇的引用（标题 + 相对路径 + 绝对路径）；
  - 文档右上「解读」→ 放引用 + 整篇解读要求（先读原文、列关键事实和坑）；
  - 选中正文任意一段 → 浮动条「解读这段 / 继续分析 / 总结」，带上所选原文一起放进输入栏；
  - 底部输入框「问小鲸鱼」→ 针对这篇问一句，回车即放进输入栏。
  - 底部输入框右侧「新会话提问」→ 唯一会**另开一个会话**的按钮：先弹一个工作区选择（当前工作区 / 其他工作区 / 跟随当前工作区），选定后**先让 DSH 开新会话、等新会话挂上来再往它的输入栏写**问题——分两步是因为 `startSession(workspaceId, { prompt })` 的草稿初始化会落在「当前仍保留的那个会话」上，实测会把问题写进旧会话的输入栏（新会话根本没建）。现在改成 `startSession(workspaceId)`（不带 options）+ 每 150ms 轮询桥接组件拿到的 `sessionId`，变了才 `insertText`；6 秒还没切过去就退回复制剪贴板并提示。
  - 所有路径**只填草稿不替你发**，改一句再按回车。
- **其他**：复制绝对路径、复制 `[[wiki]]` 链接、在系统文件管理器打开所在目录。

## 配置

`cordis.patch.yml` 里那几行：

```yaml
config:
  root: ~/KnowledgeBase     # 换成你自己的知识库路径（绝对路径，~ 不展开）
  pollIntervalMs: 2000
  verbose: false
```

- `root`：知识库根目录，绝对路径（`~` 不展开）。不填则取环境变量 `DSH_KB_ROOT`，再退回 `~/KnowledgeBase`。
- `pollIntervalMs`：扫描间隔，默认 2000ms，夹在 500–60000 之间。
- `verbose`：调试日志开关。

改完 `plugin_manager` 里重启该插件即可生效。

## 宿主接口

全部挂在 `/md-panel/api` 下（同源，无鉴权，只读本地知识库 + 一个打开文件管理器的动作）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/tree` | 全量索引：文件元数据、栏目、type/tag 统计、合规问题数 |
| GET | `/file?path=` | 单篇：frontmatter、正文、出链、反向链接 |
| GET | `/search?q=&limit=` | 全文搜索，带命中行 |
| GET | `/timeline?limit=` | 按 mtime 排序的最近变更 |
| GET | `/asset?path=` | 图片等素材（限知识库目录内） |
| GET | `/events` | SSE：`hello` / `change` 事件 |
| GET | `/status` | 扫描统计 |
| POST | `/rescan` | 立即重扫 |
| POST | `/open` | `{ path, mode: 'reveal' \| 'file' }` → 打开文件管理器 |

所有 `path` 参数都会被夹在 `root` 里面，`..` 越界直接 400。

## 仓库

<https://github.com/kakarin/dsh-md-panel>

```bash
git clone https://github.com/kakarin/dsh-md-panel.git
git clone git@github.com:kakarin/dsh-md-panel.git      # SSH
```

## 结构

```
dsh-md-panel/
├── package.json        # dsh.bundle.patch + dsh.client
├── cordis.patch.yml    # 插进 profile 的那一行（含 config）
├── icon.svg
├── locale/{zh,en}.json # meta.title / meta.description
└── lib/
    ├── index.js        # 宿主：索引、扫描、SSE、HTTP
    └── client.js       # 浏览器：右栏页类型 + 面板正文（手写 bundle，只 require react）
```

## 装 / 卸

```bash
# 装（在当前会话里）
plugin_manager action: install_bundle target=<本目录绝对路径>

# 卸
plugin_manager action: remove_bundle target=dsh-md-panel
```

## 注意

- 扫描会跳过工具目录与第三方仓库：`.git`、`.obsidian`、`.plume`、`node_modules`、`repos/`、`vendor/`、`third_party/`、`dist/`、`build/` 等——塞在知识库里的 ESP32 仓库不会污染文件树和「待补 frontmatter」计数。
- 面板只**读**知识库，不提供写入；改文档还是用编辑器 / Obsidian。这样不会跟 `dsh-kb-guard` 的写入校验打架。
- 全文搜索是宿主侧线性扫（500 篇量级几十毫秒），知识库到几万篇时需要换索引。
