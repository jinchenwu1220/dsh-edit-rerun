# dsh-edit-rerun

**编辑历史提示词并重跑** —— DeepSeek Harness（DSH）Web GUI 插件。

输入框右侧多一个回环箭头按钮：它列出当前会话里**每一条真实的用户提示词**，选一条改字，
然后从这一轮**之前**切出一个新分支，把改好的原文预填进新分支的输入框，你按回车重跑。
原会话不会被写入一个字节。

> 换句话：这是 ChatGPT 的「编辑并重新发送」，只是结果落在新分支会话上，而不是原地改写历史。

---

## 为什么不是「就地改写历史消息」

DSH 的会话日志（`session.v4.jsonl.zstd`）是 **append-only 事件流**：seq 单调递增，
fork / resume / replay / 压缩投影全部由它派生。就地改写已发生的事件会破坏 seq 连续性、
投影缓存与审计语义——所以本插件走官方支持的路径：

1. 读会话日志，取出每条 `user/message` 且 `data.source.kind === "user"` 的提示词
   （记忆注入、系统提醒、技能目录、时间上下文都是同一个事件类型，但 `source.kind` 不同，不算）；
2. 用 `sessions.fork({ atSeq })` 在**目标提示词之前那个 `turn/end`** 处切分支；
3. 子会话标题自动 +1，改好的原文写进它的输入框草稿，**不自动发送**。

原会话只读，零风险。

## 安装

前置：DSH 0.2.x（Web GUI / 桌面版），Node ≥ 22。

### 方式一：GUI 里让 agent 装（推荐）

```text
克隆 https://github.com/jinchenwu1220/dsh-edit-rerun 到本地，然后用 plugin_manager
的 install_bundle 把这个目录装进当前 profile
```

`install_bundle` 会同时完成「装包」和「把 bundle 加进 `dsh.profile.bundles`」两件事。

### 方式二：命令行手装

```bash
git clone https://github.com/jinchenwu1220/dsh-edit-rerun ~/dsh-edit-rerun
dsh plugin --profile desktop add ~/dsh-edit-rerun
```

然后把包名加进 profile 的 bundle 列表（**这一步不能省**，否则插件不会被装配）：

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": { "dsh-edit-rerun": "file:../../dsh-edit-rerun" },
  "dsh": { "profile": { "bundles": [ /* … */ "dsh-edit-rerun" ] } }
}
```

重启 DSH。

### 方式三：直接软链（开发用）

```bash
ln -sfn ~/dsh-edit-rerun ~/.dsh/profiles/desktop/node_modules/dsh-edit-rerun
```

再把 `dsh-edit-rerun` 加进 `dsh.profile.bundles`，重启。

> 装完重启一次是必须的：宿主半（路由）会在运行时重新装载，但浏览器半的 bundle
> 是启动时组装的模块图。

## 使用

1. 打开任意有历史的会话，点输入框右侧的回环箭头；
2. 面板列出第 1..N 轮提示词（首行摘要）；
3. 点一条 → 在 textarea 里改；
4. 点「在分支会话重跑」→ 新会话打开，改好的文本已在输入框里；
5. 回车发送。

`Esc` 或点面板外关闭。

## 边界

| 情形 | 行为 |
|---|---|
| 第 1 轮提示词 | **不可重跑**：它前面没有历史可继承，fork 只能切在某一轮结束之后。按钮显示「第一轮不可重跑」并禁用。 |
| 正在跑的这一轮 | 可以选，边界取上一个 `turn/end`（等于重跑本次） |
| 用过 `/compact` 的会话 | 提示词仍从日志读得出（压缩只影响模型上下文，不改写历史事件），行为不变 |
| 会话日志格式大版本升级 | 事件名假设可能失效，需要改 `log.js` 的 `turnsFromEvents` |
| 自动发送 | 不做，只预填草稿 |

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半：`GET /dsh-edit-rerun/turns?sessionId=…` + 给 agent 的提示段 |
| `log.js` | 会话日志读取：逐帧解 zstd、挑真实提示词、算 fork 边界 |
| `client.js` | 浏览器半：手写 `window.__ModuleLoader__.load({ id, factory })`，注册到 `conversation.input.right` |
| `cordis.patch.yml` | bundle 层：插入一行 `dsh-edit-rerun` |
| `locale/*.json` | Plugin Manager 里显示的名称与说明 |
| `icon.svg` | 插件图标 |

浏览器半只用 `react` 外部模块和 `slots` / `sessions` / `uiWorkspace` / `locale` 四个服务，
不 require 任何 Harness 客户端包；样式全部走 `--dsw-alias-*` 主题 token。

### 一个值得记的实现细节

会话日志是**多段 zstd frame 首尾相接**：Node 的 `zstdDecompressSync` 只解第一帧，
stream 形式遇到第二帧直接报 `Unknown frame descriptor`。正确读法是循环
`zstdDecompressSync(buf.subarray(off), { info: true })`，用 `engine.bytesWritten` 前进。

## 开发

```bash
npm run check   # node --check 三个模块
```

验证要点（真机而非推理）：面板能列出轮次、改词后新会话的输入框里确实是改后的文本、
子会话日志的前缀止于目标轮之前的 `turn/end`。

## English

**dsh-edit-rerun** is a DeepSeek Harness Web GUI plugin that lets you edit an earlier
prompt of the open conversation and re-run it in a **forked branch**.

The composer grows a loop-arrow button. It lists every real user prompt of the
current conversation (memory injections, system reminders, skill catalogues and time
context are the same event type with a different `data.source.kind`, so they are
excluded), lets you edit one, and then

- forks at the `turn/end` **before** that prompt (`sessions.fork({ atSeq })`),
- increments the child's title,
- pre-fills the edited text into the child's composer — **submitting is still yours**.

The source conversation is never written to: the session log is an append-only event
stream, so "edit history" is expressed as "branch and re-run".

**Limitations.** The first prompt of a conversation cannot be re-run (there is no
completed turn to fork after); the button shows *第一轮不可重跑* and stays disabled.
The host half reads `session.v<N>.jsonl.zstd` directly, so a future log-format major
version will need a matching change in `log.js`.

Install: clone the repo, then either let the agent install it with
`plugin_manager` `install_bundle`, or run
`dsh plugin --profile desktop add ~/dsh-edit-rerun` and add `dsh-edit-rerun` to
`dsh.profile.bundles` in the profile's `package.json`. Restart DSH once.

## License

MIT © 2026 jinchenwu1220
