"""Active-path walk for one conversation."""


class BadTree(Exception):
    """The active path cycles or names a parent that is not in the mapping."""


def active_path(conversation, counters):
    mapping = conversation.get("mapping")
    if not isinstance(mapping, dict):
        counters["bad_tree"] += 1
        raise BadTree()
    current = conversation.get("current_node")
    chain = []
    seen = set()
    node_id = current
    while node_id:
        if (
            not isinstance(node_id, str)
            or node_id in seen
            or node_id not in mapping
            or not isinstance(mapping[node_id], dict)
        ):
            counters["bad_tree"] += 1
            raise BadTree()
        seen.add(node_id)
        node = mapping[node_id]
        chain.append(node)
        node_id = node.get("parent")
        if node_id is not None and not isinstance(node_id, str):
            counters["bad_tree"] += 1
            raise BadTree()
    chain.reverse()
    if any(not isinstance(node.get("id"), str) for node in chain):
        counters["bad_tree"] += 1
        raise BadTree()
    active = {node["id"] for node in chain}
    counters["side_branch"] += sum(1 for key in mapping if key not in active)
    return [node for node in chain if node.get("message") is not None]
