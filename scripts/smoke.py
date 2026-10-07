"""Test the real local service without printing the access key."""

import json
import os
from pathlib import Path
import time
import httpx

root = Path(__file__).resolve().parent.parent
key = (
    os.environ.get("TASTE_API_TOKEN")
    or (root / ".taste-access-key").read_text().strip()
)
library = Path(
    os.environ.get("TASTE_LIBRARY_PATH", str(Path.home() / "Sites/taste/library"))
)
with httpx.Client(
    base_url="http://127.0.0.1:8765",
    headers={"Authorization": f"Bearer {key}"},
    timeout=90,
) as client:
    health = client.get("/health")
    health.raise_for_status()
    print("Service:", health.json())
    start = time.monotonic()
    text = client.post(
        "/search/text",
        json={
            "texts": ["Bold editorial typography", "Black and white graphic design"],
            "limit": 5,
        },
    )
    text.raise_for_status()
    assert len(text.json()["results"]) == 5
    print(
        "Text search:",
        round(time.monotonic() - start, 2),
        "seconds;",
        len(text.json()["results"]),
        "results",
    )
    ref = next(
        r
        for r in json.loads((library / "references.json").read_text())
        if r.get("id") == "001"
    )
    start = time.monotonic()
    image = client.post(
        "/search/image",
        files={
            "image": (
                "query.png",
                (library / "images" / ref["file"]).read_bytes(),
                "image/png",
            )
        },
    )
    image.raise_for_status()
    top = image.json()["results"][0]
    assert top["id"] == "001", f"Self-image retrieval failed: {top}"
    assert top["score"] > 0.98, top
    print(
        "Image search:",
        round(time.monotonic() - start, 2),
        "seconds; self-image ranked first; score",
        round(top["score"], 5),
    )
    downloaded = client.get(f"/images/{top['id']}?size=4096")
    downloaded.raise_for_status()
    assert downloaded.headers["content-type"] == "image/jpeg"
    print("Image download:", len(downloaded.content), "bytes; all smoke checks passed")
