"""Compare this source stage with full approved central owner objects offline."""

import argparse
import io
import subprocess
import tarfile
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
BASELINE = "3a9299607128bd633bcd7e39ed25b6dcc78da8a7"
CENTRAL = Path("platform/targets/k8s-flux")
SOURCE = ROOT / "infra/k8s"
WORKLOAD = [
    ("Deployment", "pachigraph"),
    ("Service", "pachigraph"),
    ("NetworkPolicy", "pachigraph"),
]
ROUTES = [
    ("HTTPRoute", "pachigraph-browser"),
    ("HTTPRoute", "pachigraph-api"),
    ("SecurityPolicy", "pachigraph-oidc"),
]


def render(path: Path) -> dict:
    """Local Kustomize output stays in memory; Secret bodies are not parsed."""
    text = subprocess.run(
        ["kubectl", "kustomize", str(path), "--load-restrictor=LoadRestrictionsNone"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    result = {}
    for chunk in text.split("\n---\n"):
        if "\nkind: Secret\n" in f"\n{chunk}\n":
            continue
        document = yaml.safe_load(chunk)
        if not isinstance(document, dict):
            continue
        identity = (
            document["kind"],
            document["metadata"].get("namespace", ""),
            document["metadata"]["name"],
        )
        if identity in result:
            raise ValueError(f"duplicate object: {identity}")
        result[identity] = document
    return result


def compare(expected: dict, candidate: dict) -> None:
    """Identity-only diagnostics never print inline configuration values."""
    if expected.keys() != candidate.keys():
        raise ValueError("source identity set differs from approved owner")
    for identity, document in expected.items():
        if document != candidate[identity]:
            raise ValueError(f"source object differs from approved owner: {identity}")


def verify(central_repo: Path) -> None:
    """Use a frozen local Git object; no cluster/provider access or mutation."""
    archive = subprocess.run(
        ["git", "archive", BASELINE, str(CENTRAL)],
        cwd=central_repo,
        check=True,
        capture_output=True,
    ).stdout
    with tempfile.TemporaryDirectory() as directory:
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            source.extractall(directory, filter="data")
        central = Path(directory) / CENTRAL
        root = render(central / "clusters/dev01")
        gateway = render(central / "clusters/dev01/gateway-resources")
        workload = {
            (kind, "codex-specops", name): root[(kind, "codex-specops", name)]
            for kind, name in WORKLOAD
        }
        routes = {
            (kind, "codex-specops", name): gateway[(kind, "codex-specops", name)]
            for kind, name in ROUTES
        }
        compare(workload, render(SOURCE / "workload"))
        compare(routes, render(SOURCE / "routes"))
        compare(workload | routes, render(SOURCE))
        print(
            f"Verified {len(workload)} workload and {len(routes)} route objects against {BASELINE}"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--central-repo", type=Path, required=True)
    verify(parser.parse_args().central_repo)
