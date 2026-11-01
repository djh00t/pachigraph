"""Classify one active-path message as visible or hidden."""


def classify(node, counters):
    message = node.get("message")
    if not isinstance(message, dict):
        return None
    author = message.get("author") if isinstance(message.get("author"), dict) else {}
    role = author.get("role")
    content = message.get("content") if isinstance(message.get("content"), dict) else {}
    content_type = content.get("content_type")
    recipient = message.get("recipient")
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    hidden_flag = metadata.get("is_visually_hidden_from_conversation") is True
    visible = (
        isinstance(role, str)
        and role in {"user", "assistant"}
        and content_type in {"text", "multimodal_text"}
        and (recipient is None or isinstance(recipient, str) and recipient == "all")
        and not hidden_flag
    )
    parts = content.get("parts")
    if not isinstance(parts, list):
        parts = []
    if not visible:
        counters["hidden"] += 1
        return {
            "visibility": "hidden",
            "text": "",
            "content": content,
            "role": role,
            "content_type": content_type,
            "recipient": recipient,
            "model_slug": metadata.get("model_slug"),
        }
    texts = []
    for part in parts:
        if isinstance(part, str):
            texts.append(part)
        else:
            counters["non_text_part"] += 1
    text = "\n".join(texts)
    if text == "":
        counters["empty_text"] += 1
        return None
    return {
        "visibility": "visible",
        "text": text,
        "content": None,
        "role": role,
        "content_type": content_type,
        "recipient": recipient,
        "model_slug": metadata.get("model_slug"),
    }
