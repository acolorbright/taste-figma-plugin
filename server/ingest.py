"""Persistent team additions and incremental public Are.na channel imports."""
import asyncio
import hashlib
import io
import json
import re
import shutil
import sqlite3
import threading
import time
from pathlib import Path
from contextlib import contextmanager
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler

from .search import read_image

SYNC_SECONDS = 6 * 60 * 60
MAX_BYTES = 8 * 1024 * 1024


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch(url, image=False):
    parsed = urlparse(url)
    hosts = {"images.are.na", "d2w9rnfcy7mm78.cloudfront.net"} if image else {"api.are.na"}
    if parsed.scheme != "https" or parsed.hostname not in hosts or parsed.port not in (None, 443) or parsed.username or parsed.password:
        raise ValueError("Unsupported Are.na image host.")
    with build_opener(NoRedirect()).open(Request(url, headers={"User-Agent": "Taste-library/0.2"}), timeout=15) as response:
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("Are.na response exceeds 8 MB.")
    return data if image else json.loads(data)


def channel_slug(value):
    value = value.strip()
    if "://" in value:
        parsed = urlparse(value)
        if parsed.scheme != "https" or parsed.hostname not in ("are.na", "www.are.na") or parsed.username or parsed.password or parsed.port not in (None, 443):
            raise ValueError("Enter a public Are.na channel URL or slug.")
        parts = parsed.path.strip("/").split("/")
        if len(parts) != 2 or parts[0] in ("block", "blocks"):
            raise ValueError("Enter a channel URL, not a block URL.")
        value = parts[-1]
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}", value):
        raise ValueError("Enter a public Are.na channel URL or slug.")
    return value


class IngestStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS images (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
                    data BLOB NOT NULL, vector TEXT NOT NULL, created REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS arena_blocks (id TEXT PRIMARY KEY, image_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS channels (
                    slug TEXT PRIMARY KEY, title TEXT NOT NULL, last_synced REAL,
                    last_attempt REAL, state TEXT NOT NULL DEFAULT 'pending',
                    error TEXT NOT NULL DEFAULT '', added INTEGER NOT NULL DEFAULT 0
                );
                UPDATE channels SET state='pending' WHERE state='syncing';
            ''')

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def restore(self, library):
        library.additions = self
        with self.db() as db:
            for row in db.execute("SELECT id,name,source,vector FROM images"):
                library.add(row["id"], row["name"], row["source"], json.loads(row["vector"]))

    def image_bytes(self, identity):
        with self.db() as db:
            row = db.execute("SELECT data FROM images WHERE id=?", (identity,)).fetchone()
        if row is None:
            raise KeyError(identity)
        return row["data"]

    def add(self, data, name, source, library, encoder, block_id=None):
        image = read_image(data)
        image.thumbnail((2048, 2048))
        identity = "team-" + hashlib.sha256(str(image.size).encode() + image.tobytes()).hexdigest()
        with self.lock:
            if identity in library.indices:
                if block_id:
                    self.remember_block(block_id, identity)
                return {"id": identity, "added": False}
            if shutil.disk_usage(self.path.parent).free < 100 * 1024 * 1024:
                raise ValueError("Library storage is nearly full. Ask the administrator to expand it.")
            buffer = io.BytesIO()
            image.save(buffer, "JPEG", quality=92)
            stored = buffer.getvalue()
            vector = encoder.image(stored)
            with self.db() as db:
                db.execute("INSERT INTO images VALUES (?,?,?,?,?,?)", (identity, name[:200], source, stored, json.dumps(vector.tolist()), time.time()))
                if block_id:
                    db.execute("INSERT OR IGNORE INTO arena_blocks VALUES (?,?)", (str(block_id), identity))
            library.add(identity, name[:200], source, vector)
        return {"id": identity, "added": True}

    def remember_block(self, block_id, identity):
        with self.db() as db:
            db.execute("INSERT OR IGNORE INTO arena_blocks VALUES (?,?)", (str(block_id), identity))

    def has_block(self, block_id, library):
        if str(block_id) in library.arena_ids:
            return True
        with self.db() as db:
            return db.execute("SELECT 1 FROM arena_blocks WHERE id=?", (str(block_id),)).fetchone() is not None

    def channels(self):
        with self.db() as db:
            return [dict(row) for row in db.execute("SELECT * FROM channels ORDER BY title COLLATE NOCASE")]

    def add_channel(self, value):
        slug = channel_slug(value)
        data = fetch(f"https://api.are.na/v2/channels/{slug}?per=1")
        if (data.get("class") or data.get("base_class")) != "Channel" or data.get("status") == "private":
            raise ValueError("Choose a public or closed Are.na channel that anyone can read.")
        slug = channel_slug(data["slug"])
        with self.db() as db:
            db.execute("INSERT OR IGNORE INTO channels (slug,title) VALUES (?,?)", (slug, str(data.get("title") or slug)[:200]))
        return slug

    def update_channel(self, slug, **fields):
        with self.db() as db:
            db.execute("UPDATE channels SET " + ",".join(f"{key}=?" for key in fields) + " WHERE slug=?", (*fields.values(), slug))

    async def sync_channel(self, slug, library, encoder):
        self.update_channel(slug, state="syncing", error="", last_attempt=time.time())
        added = 0
        failures = 0
        try:
            page = 1
            while True:
                data = await asyncio.to_thread(fetch, f"https://api.are.na/v2/channels/{slug}?page={page}&per=100")
                for block in data.get("contents", []):
                    if block.get("class") != "Image" or not block.get("image") or self.has_block(block["id"], library):
                        continue
                    try:
                        url = block["image"]["display"]["url"]
                        raw = await asyncio.to_thread(fetch, url, True)
                        result = await asyncio.to_thread(self.add, raw, block.get("title") or "Are.na image", "Are.na: " + str(data.get("title") or slug), library, encoder, block["id"])
                        added += int(result["added"])
                    except Exception:
                        failures += 1
                    await asyncio.sleep(0.05)
                if page * 100 >= data.get("length", 0) or not data.get("contents"):
                    break
                page += 1
                await asyncio.sleep(0.5)
            fields = dict(state="error" if failures else "synced", error=f"{failures} images could not be imported; they will be retried next sync." if failures else "", added=added)
            if not failures:
                fields["last_synced"] = time.time()
            self.update_channel(slug, **fields)
        except Exception:
            self.update_channel(slug, state="error", error="Could not read this channel. Check that it is still public. Taste will retry next sync.", added=added)

    async def watch(self, library, encoder, idle, wake):
        # Sync on every process start, then every six hours; never wake a stopped machine.
        first = True
        while True:
            wake.clear()
            for channel in self.channels():
                if first or channel["state"] == "pending" or time.time() - (channel["last_attempt"] or 0) >= SYNC_SECONDS:
                    idle.active += 1
                    try:
                        await self.sync_channel(channel["slug"], library, encoder)
                    finally:
                        # Background work must not reset the three-hour user idle window.
                        idle.active -= 1
            first = False
            try:
                await asyncio.wait_for(wake.wait(), timeout=60)
            except TimeoutError:
                pass
