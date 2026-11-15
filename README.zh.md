# dsh-session-import

把 **Codex**、**Claude Code / Claude Desktop** 与 **WorkBuddy** 的会话导入 DeepSeek Harness，成为普通的 DSH 会话。

插件在侧栏增加一个入口。页面列出本机能找到的全部会话，由你决定每个会话带过来多少：时间范围、项目、可选的条数上限，以及四档颗粒度。

[English](README.md)

## 读取哪些目录

| 客户端 | 目录 | 文件 |
| --- | --- | --- |
| Codex | `$CODEX_HOME` 或 `~/.codex` | `sessions/YYYY/MM/DD/rollout-*.jsonl`、`archived_sessions/`，标题取自 `session_index.jsonl` |
| Claude Code | `$CLAUDE_CONFIG_DIR` 或 `~/.claude` | `projects/<slug>/<session-id>.jsonl` |
| Claude Desktop | 同一个 Claude 目录 | 桌面端用的是同一套引擎，所以它的对话就是 `entrypoint` 为 `claude-desktop-3p` 的那些记录，列表里标为 *Claude Desktop* |
| WorkBuddy | `$WORKBUDDY_HOME` 或 `~/.workbuddy` | `projects/<slug>/<session-id>.jsonl` |

这些目录一律只读，不会改写、移动或删除任何文件。

无法解析的文件会被计数并报告，而不是当成失败：包括被数据防泄漏代理加密的 rollout、正在写入的文件和空占位文件。

同一个对话可能对应多份文件：Codex 每次续写都会生成一份带同一 thread id 的新日志，WorkBuddy 的 resend fork 也一样。这些文件会合并成一行——取其中最大的一份，因为它完整重放了之前的记录——行尾用 `×2`、`×3` 标出合并了几份。不会做拼接，所以对话既不会丢也不会重复。

## 颗粒度

每一档都包含上一档的全部内容。

| 档位 | 内容 |
| --- | --- |
| L1 摘要 | 用户与助手的正文 |
| L2 对话 | 加上对话开始后客户端注入的开发者/系统说明 |
| L3 工具 | 加上工具调用与工具输出，输出按 `toolOutputLimit` 截断 |
| L4 完整 | 加上推理内容，工具输出不截断 |

条数上限保留会话最近 *n* 条消息，并把起点对齐到用户发言，所以裁剪过的导入仍然从用户说过的话开始。

客户端在记录开头重放的指令属于脚手架而非对话：L2 及以上只在第一条真实用户发言之后保留。

## 导入产生什么

每个选中的会话都会变成一个真正的 DSH 会话：

- 存放在正常的会话目录里，Host 重启后依然存在；
- 归入其原始目录对应的工作区，没有匹配时新建一个（`createWorkspace`）；
- 写完后恢复一次（`publishSessions`），因此侧栏行、标题与继续对话立即可用，无需重启；
- 每个事件一行，格式通过读取路径的校验，所以写入错误在导入时报出来，而不是等你打开会话才发现。

同一个会话第二次导入会被跳过。勾选*写一份副本*即可按另一档颗粒度再导入一次，副本带数字后缀。不带副本地重复导入仍会修复归组与发布，也就是 **修复分组** 按钮的作用。

会话 id 按来源加前缀（`session-claude-<id>`、`session-workbuddy-<id>`），只有 Codex 保留 `session-<id>`，以便早先版本写入的会话仍与原记录对应。

## 安装

让 profile 指向 release 产物——是打包好的 bundle，不是源码目录：

```bash
dsh plugin install https://github.com/RuriLothlorien/dsh-session-import/releases/latest/download/dsh-session-import-1.0.1.tgz
```

也可以把同一个压缩包下载到本地后安装，离线交付按 `INSTALL.md` 操作。

需要同时提供插件 Web 载体、会话持久化服务、工作区注册表，以及承载浏览器信任栅栏的 connection 服务的 DSH 版本。要求 DSH `>=0.2.0-rc.2 <0.3.0-0`。

## 配置

默认值随 `cordis.patch.yml` 发布，并在本包的 `Config` schema 里声明，因此设置表单能看到它们，写错的值会让加载直接失败而不是被悄悄忽略。在 profile 的插件行里覆盖任意字段；只要覆盖了一个字段，就要把全部字段重新列一遍，因为插件行的 config 是整体替换而不是合并。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `codexHome` | `''` | Codex 目录；空表示 `$CODEX_HOME`，再退到 `~/.codex` |
| `claudeHome` | `''` | Claude 目录；空表示 `$CLAUDE_CONFIG_DIR`，再退到 `~/.claude` |
| `workbuddyHome` | `''` | WorkBuddy 目录；空表示 `$WORKBUDDY_HOME`，再退到 `~/.workbuddy` |
| `toolOutputLimit` | `4000` | L3 下单个工具输出保留的字符数；`0` 表示不截断 |
| `createWorkspace` | `true` | 为导入会话创建所属工作区 |
| `publishSessions` | `true` | 恢复导入会话，使其无需重启即可见 |

## 接口

浏览器端与 Host 端通过 `/session-import` 下的接口通信。三个接口都是 `POST`，仅回环可达。

每个请求都先经过 Host 自己的浏览器信任栅栏——也就是守卫 `/api` 的同一个 `ctx.connection.requestRejection`——因此只要 `Host` 头指向的不是本监听地址，即便附带的 `Origin` 与之相符也会被拒绝。这正是 `Origin` 单比无法防住的 DNS rebinding；空的 `Origin:` 以及不带任何 DSH 会话凭证的请求同样会被拒绝。

- `/ping` —— 各来源解析到的目录。
- `/scan` —— 找到的会话，已按请求的范围过滤。
- `/import` —— 写入选中的会话。会话以 `{source, id}` 标识，且必须是 Host 自己扫描过的，因此路径不会经过浏览器。

## 文件结构

```
lib/index.js    Host 入口：接口、工作区归组、发布
lib/sources.js  每个客户端一个适配器：目录、扫描、记录 → items
lib/build.js    items → DSH 会话事件，按颗粒度取舍
lib/client.js   侧栏图标与导入页面
```

## 许可证

MIT。
