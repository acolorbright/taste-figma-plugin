"""Local launcher; generates an access key once, without embedding it in the plugin."""

import argparse
import os
from pathlib import Path
import secrets
import uvicorn


def main():
    parser = argparse.ArgumentParser(description="Run the private Taste search service")
    parser.add_argument("--library", default=str(Path.home() / "Sites/taste/library"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    os.environ.setdefault("TASTE_LIBRARY_PATH", args.library)
    if not os.environ.get("TASTE_API_TOKEN"):
        if args.host not in ("127.0.0.1", "localhost"):
            parser.error(
                "Set TASTE_API_TOKEN when exposing the service beyond localhost."
            )
        key_file = Path(__file__).resolve().parent.parent / ".taste-access-key"
        if not key_file.exists():
            fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write(secrets.token_urlsafe(32))
        os.environ["TASTE_API_TOKEN"] = key_file.read_text().strip()
        print(
            f"Local access key: {key_file} (paste its contents into the plugin’s Connection panel)",
            flush=True,
        )
    uvicorn.run(
        "server.app:create_app",
        factory=True,
        host=args.host,
        port=args.port,
        access_log=False,
    )


if __name__ == "__main__":
    main()
