# pi-codex-request

为 [Earendil Works Pi](https://github.com/earendil-works/pi) 的 `openai-responses` Model Provider 按需转换 Codex Responses Lite 请求，并提供命令快速切换 Provider 模式。

## 功能

- 将工具定义移动到首个 `additional_tools` input item。
- 规范 developer/system/user message 结构。
- 设置 `reasoning.context: "all_turns"`、`tool_choice: "auto"` 和 `parallel_tool_calls: false`。
- 移除当前 Responses Lite 不发送的旧字段。
- 通过 Provider Header 选择模式，未标记的 Provider 完全不受影响。
- 原子更新 `models.json`，随后调用 Pi Model Registry 刷新，立即生效。
- Codex 版本或请求协议不匹配时，在网络请求前中止。

## 模式

| 模式 | 行为 |
| --- | --- |
| `off` | 不改写请求；配置中不保留内部 marker。 |
| `lite` | 使用 Responses Lite 请求体，发送 `Originator: pi`，不发送 Codex 安装身份。 |
| `official` | 在 Lite 请求体之外发送 `codex_exec` User-Agent、installation/session/thread/turn metadata。 |

`official` 是对目标 Provider 发送本机 Codex 身份元数据的显式授权，仅应为可信 Provider 启用。

## 安装

```bash
pi install git:github.com/Molaison/pi-codex-request
```

临时试用：

```bash
pi -e git:github.com/Molaison/pi-codex-request
```

Pi package/extension 具有当前用户的完整系统权限，安装前请审查源码。

## 命令

```text
/codex-mode                         # 交互选择 Provider 和模式
/codex-mode list                    # 查看当前配置
/codex-mode <provider> <模式>       # 模式：lite、official、off

/codex-lite [provider]              # 省略 provider 时作用于当前模型
/codex-official [provider]
/codex-off [provider]
```

例如：

```text
/codex-lite anyrouter
/codex-official zzzcoding
/codex-off sub2api
```

命令只允许全部模型均使用 `openai-responses` API 的 Provider。设置 Provider 模式时，会清除该 Provider 在 `models[]` 和 `modelOverrides` 中遗留的同名 model-level marker，保留其他 Header 和配置。

## 手动配置

也可以把 `models.example.json` 中的 `headers` 合并到已有 Provider 配置：

```json
{
  "headers": {
    "X-Pi-Codex-Request-Mode": "lite"
  }
}
```

允许值只有 `lite` 和 `official`；关闭时应删除该 Header。该内部 Header 会在请求发出前移除，不会传给上游。

## 兼容性

当前协议基线：

- Pi `0.82.1`
- `@openai/codex` `0.146.0-alpha.13`
- Provider API：`openai-responses`

扩展会执行 `codex --version`。如果本机 Codex 版本与协议基线不同，标记 Provider 的请求会在发送前失败，避免用旧请求结构伪装成新版本。`official` 模式还要求 `$CODEX_HOME/installation_id`（默认 `~/.codex/installation_id`）存在且格式有效。

## License

MIT
