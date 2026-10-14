<h1 align="center">pi-codex-request</h1>

<p align="center">
  <strong>为 Pi 的 OpenAI Responses Provider 按需启用 Codex Responses Lite。</strong><br>
  一条命令切换请求协议，按 Provider 独立生效。
</p>

<p align="center">
  <a href="https://github.com/Molaison/pi-codex-request/stargazers"><img src="https://img.shields.io/github/stars/Molaison/pi-codex-request" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="Version 0.1.0"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#模式与隐私">模式与隐私</a> ·
  <a href="#命令参考">命令参考</a> ·
  <a href="#兼容性">兼容性</a>
</p>

---

## 为什么需要它？

某些接收 Codex Responses Lite 结构的 Provider，需要与 Pi 默认 `openai-responses` 请求不同的格式。本扩展会在**发送请求之前**转换这些 Provider 的请求：

- 把工具定义归入首个 `additional_tools` input item，并调整 system、developer、user 消息结构。
- 设置 `reasoning.context: "all_turns"`、`tool_choice: "auto"` 和 `parallel_tool_calls: false`，移除不适用于 Lite 的旧字段。
- 通过 Provider Header 显式选择模式；**未启用的 Provider 不受影响**。
- 修改配置后原子写入 `models.json`，并刷新 Pi Model Registry。

## 快速开始

需要 **Node.js 22.19+**、支持扩展的 [Pi](https://github.com/earendil-works/pi)，以及使用 `openai-responses` API 的 Provider。

```bash
pi install git:github.com/Molaison/pi-codex-request
```

仅在当前启动中试用：

```bash
pi -e git:github.com/Molaison/pi-codex-request
```

在 Pi 中按你的 Provider 名称执行：

```text
/codex-mode                 # 交互选择 Provider 与模式
/codex-lite anyrouter       # 为 anyrouter 启用 Lite
/codex-mode list            # 查看各 Provider 当前模式
```

如果希望恢复原始请求：

```text
/codex-off anyrouter
```

## 模式与隐私

| 模式 | 请求行为 | 适用情形 |
| --- | --- | --- |
| **off** | 保持 Pi 原始请求；移除本扩展的配置 marker。 | 默认或不需要适配的 Provider |
| **lite** | 转换为 Responses Lite 结构，发送 `Originator: pi`；不发送 Codex 安装身份。 | 需要 Lite 协议的 Provider |
| **official** | 使用 Lite 结构，并附带 `codex_exec` User-Agent、installation / session / thread / turn 身份元数据。 | **仅限你信任的 Provider** |

`official` 会向目标 Provider 暴露本机 Codex 安装及会话相关标识，请在了解对方数据处理方式后手动开启。内部模式标记 `X-Pi-Codex-Request-Mode` 会在发起网络请求前移除。

## 命令参考

```text
/codex-mode                         # 交互选择 Provider / 模式
/codex-mode list                    # 列出 Provider 的有效模式
/codex-mode <provider> lite|official|off

/codex-lite [provider]              # 为指定或当前模型的 Provider 启用 Lite
/codex-official [provider]          # 启用包含 Codex 身份的请求
/codex-off [provider]               # 关闭适配
```

命令只处理模型全部使用 `openai-responses` API 的 Provider。切换时还会清除该 Provider 下 `models[]` 和 `modelOverrides` 中遗留的同名标记，保留其他 Header 与模型配置。

也可以参考 [`models.example.json`](models.example.json) 手动设置 Provider 的 `headers`：

```json
{
  "headers": {
    "X-Pi-Codex-Request-Mode": "lite"
  }
}
```

允许值为 `lite` 或 `official`；关闭时删除此 Header。

## 兼容性

本仓库的**协议基线**是 Pi `0.82.1`、`@openai/codex` `0.146.0-alpha.13`，仅适配 `openai-responses`。标记 Provider 发送前会通过 `codex --version` 检查本机版本：版本不匹配就中止请求，避免错误的协议结构被发送。

`official` 还要求有效的 `$CODEX_HOME/installation_id`（默认 `~/.codex/installation_id`）。本扩展作为 Pi package 运行，具有当前用户的系统权限；安装前请阅读 [扩展源码](extensions/codex-request.ts)。

## 开发与许可

入口：[extensions/codex-request.ts](extensions/codex-request.ts) · 协议配置示例：[models.example.json](models.example.json) · 许可证：[MIT](LICENSE)。
