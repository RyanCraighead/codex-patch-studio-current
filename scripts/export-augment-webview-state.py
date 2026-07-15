#!/usr/bin/env python3

import json
import re
import sqlite3
import sys
from pathlib import Path
from datetime import datetime, timezone

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def base62_decode(value: str) -> int:
    result = 0
    for char in value:
        result = result * 62 + ALPHABET.index(char)
    return result


def sanitize_file_name(value: object) -> str:
    name = str(value or "untitled").strip().replace("\n", " ")
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name[:120] or "untitled"


def read_webview_state(db_path: Path, key: str) -> str:
    with sqlite3.connect(str(db_path)) as connection:
        row = connection.execute("select value from ItemTable where key=?", (key,)).fetchone()
    if row is None:
        raise SystemExit(f"Key not found in {db_path}: {key}")

    value = row[0]
    text = value.decode("utf-8", "replace") if isinstance(value, bytes) else value
    wrapper = json.loads(text)
    return wrapper["webviewState"]


def decode_webview_state(webview_state: str):
    raw_state = json.loads(webview_state)
    if isinstance(raw_state, dict):
        return raw_state

    if not (isinstance(raw_state, list) and len(raw_state) == 2):
        raise SystemExit(
            f"Unsupported webviewState format: {type(raw_state).__name__}"
        )

    table, root_ref = raw_state
    memo = {}

    def decode_ref(ref: str):
        return decode_index(base62_decode(ref))

    def decode_index(index: int):
        if index in memo:
            return memo[index]

        value = table[index]
        if isinstance(value, str) and len(value) >= 2 and value[1] == "|":
            kind = value[0]
            parts = [] if value[2:] == "" else value[2:].split("|")

            if kind == "a":
                decoded = []
                memo[index] = decoded
                decoded.extend(decode_ref(part) for part in parts if part)
                return decoded

            if kind == "o":
                keys = decode_ref(parts[0]) if parts else []
                decoded = {}
                memo[index] = decoded
                for key, ref in zip(keys, parts[1:]):
                    decoded[str(key)] = decode_ref(ref)
                return decoded

            if kind == "b":
                return bool(parts and parts[0] == "T")

            if kind == "n":
                return base62_decode(parts[0]) if parts and parts[0] else 0

        memo[index] = value
        return value

    return decode_ref(root_ref)


def exchange_to_markdown(item: dict, index: int) -> list[str]:
    lines = []
    timestamp = item.get("timestamp") or item.get("createdAtIso") or item.get("created_at")
    heading = f"## Item {index + 1}"
    if item.get("chatItemType"):
        heading += f" - {item['chatItemType']}"
    if timestamp:
        heading += f" - {timestamp}"
    lines.extend([heading, ""])

    if item.get("request_message"):
        lines.extend(["### User", "", str(item["request_message"]), ""])
    if item.get("response_text"):
        lines.extend(["### Assistant", "", str(item["response_text"]), ""])
    if item.get("summary"):
        lines.extend(["### Summary", "", str(item["summary"]), ""])
    if not any(key in item for key in ("request_message", "response_text", "summary")):
        small = {
            key: value
            for key, value in item.items()
            if key
            in (
                "chatItemType",
                "exchangeUuid",
                "request_id",
                "status",
                "seen_state",
                "timestamp",
            )
        }
        lines.extend(["```json", json.dumps(small, indent=2, ensure_ascii=False), "```", ""])
    return lines


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "Usage: python scripts/export-augment-webview-state.py <state.vscdb-or-backup> [out-dir]",
            file=sys.stderr,
        )
        return 2

    db_path = Path(sys.argv[1]).resolve()
    out_dir = (
        Path(sys.argv[2]).resolve()
        if len(sys.argv) > 2
        else Path.cwd() / "augment-vscode-state-exports" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    )
    key = "memento/webviewView.augment-chat"

    out_dir.mkdir(parents=True, exist_ok=True)
    conversations_dir = out_dir / "conversations"
    conversations_dir.mkdir(parents=True, exist_ok=True)

    state = decode_webview_state(read_webview_state(db_path, key))
    conversations = state.get("conversations", {})
    if not isinstance(conversations, dict):
        raise SystemExit("Decoded webview state did not contain a conversations object")

    index = []
    for conversation_id, conversation in conversations.items():
        if not isinstance(conversation, dict):
            continue

        chat_history = conversation.get("chatHistory") or []
        extra = conversation.get("extraData") or {}
        name = conversation.get("name")
        record = {
            "id": conversation_id,
            "name": name.strip() if isinstance(name, str) else name,
            "createdAtIso": conversation.get("createdAtIso"),
            "lastInteractedAtIso": conversation.get("lastInteractedAtIso"),
            "chatHistoryCount": len(chat_history) if isinstance(chat_history, list) else None,
            "isPinned": conversation.get("isPinned"),
            "isShareable": conversation.get("isShareable"),
            "isAgentConversation": extra.get("isAgentConversation"),
            "hasTitleGenerated": extra.get("hasTitleGenerated"),
            "isForked": extra.get("isForked"),
            "forkedFrom": extra.get("forkedFrom"),
            "rootTaskUuid": conversation.get("rootTaskUuid"),
        }
        index.append(record)

        base_name = f"{sanitize_file_name(record['name'] or conversation_id)} -- {conversation_id}"
        (conversations_dir / f"{base_name}.json").write_text(
            json.dumps(conversation, indent=2, ensure_ascii=True),
            encoding="utf-8",
        )

        lines = [
            f"# {record['name'] or conversation_id}",
            "",
            f"Conversation ID: `{conversation_id}`",
            f"Created: {record['createdAtIso']}",
            f"Last interacted: {record['lastInteractedAtIso']}",
            f"Chat history items: {record['chatHistoryCount']}",
            "",
        ]
        if isinstance(chat_history, list):
            for item_index, item in enumerate(chat_history):
                if isinstance(item, dict):
                    lines.extend(exchange_to_markdown(item, item_index))

        (conversations_dir / f"{base_name}.md").write_text(
            "\n".join(lines),
            encoding="utf-8",
            errors="replace",
        )

    index.sort(key=lambda row: row.get("lastInteractedAtIso") or "", reverse=True)

    (out_dir / "webview-state.json").write_text(json.dumps(state, indent=2, ensure_ascii=True), encoding="utf-8")
    (out_dir / "conversation-index.json").write_text(json.dumps(index, indent=2, ensure_ascii=True), encoding="utf-8")

    print(
        json.dumps(
            {
                "outDir": str(out_dir),
                "conversationCount": len(index),
                "currentConversationId": state.get("currentConversationId"),
                "newestConversations": index[:10],
            },
            indent=2,
            ensure_ascii=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
