# Chat Transfer Console

Local viewer and import manager for Augment, Kiro, Roo Code, and Cline chat history.

Run from the repository root:

```powershell
node .\viewer\server.cjs
```

Then open:

```text
http://127.0.0.1:4577
```

The viewer auto-detects exports under:

- `augment-vscode-state-exports`
- `augment-chat-exports`
- `kiro-chat-exports`
- `roo-code-exports`
- `cline-chat-exports`

It uses the decoded VS Code webview export for titles/sidebar metadata, then merges the LevelDB export for full message bodies when available.

Tool calls/actions are read from `response_nodes[].tool_use` in each LevelDB exchange and joined with the matching `tooluse:<conversationId>:<requestId>;<toolUseId>` records.

Edit cards use Augment's saved tool result metadata, especially `result.metrics.tool_use_diff`, which contains the edited path and before/after hunks. Augment also keeps full edit checkpoints under `augment-user-assets/checkpoint-documents`, with `originalCode` and `modifiedCode` snapshots.

Intermediate reasoning blocks are read from `response_nodes[].thinking.summary`. In this export, the full reasoning body is stored as `thinking.encrypted_content`, so the normal viewer shows the available plaintext summary and marks when an encrypted body exists.
