"""Stable record fields. Children, title and status never enter the record."""


def build_record(conversation_id, node, classified, iso_time) -> dict:
    message = node.get("message") if isinstance(node.get("message"), dict) else {}
    record = {
        "source": {"platform": "chatgpt", "conversation_id": conversation_id},
        "node_id": node.get("id"),
        "parent_id": node.get("parent"),
        "role": classified.get("role"),
        "content_type": classified.get("content_type"),
        "model_slug": classified.get("model_slug"),
        "create_time": iso_time,
        "visibility": classified.get("visibility"),
        "recipient": classified.get("recipient"),
    }
    if classified.get("visibility") == "hidden":
        record["content"] = classified.get("content")
    return record
