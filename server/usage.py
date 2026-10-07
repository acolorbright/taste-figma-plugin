"""Small, content-free usage ledger on a persistent volume."""

from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
import sqlite3
from pathlib import Path
import time
import uuid


class UsageStore:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
            db.execute("INSERT OR IGNORE INTO metadata VALUES ('started_at', ?)", (datetime.now(timezone.utc).isoformat(),))
            db.execute('''CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL,
                installation TEXT, count INTEGER NOT NULL DEFAULT 1
            )''')
            db.execute('CREATE INDEX IF NOT EXISTS events_at ON events(at)')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=2)
        try:
            with db:
                yield db
        finally:
            db.close()

    def record(self, kind, installation=None, count=1, event_id=None, at=None):
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?)',
                       (event_id or str(uuid.uuid4()), int(time.time() if at is None else at), kind, installation, count))

    def summary(self, days=30):
        today = datetime.now(timezone.utc).date()
        dates = [(today - timedelta(days=i)).isoformat() for i in reversed(range(days))]
        since = int(datetime.fromisoformat(dates[0]).replace(tzinfo=timezone.utc).timestamp())
        with self.connect() as db:
            totals = dict(db.execute('SELECT kind, SUM(count) FROM events WHERE at >= ? GROUP BY kind', (since,)))
            active = db.execute("SELECT COUNT(DISTINCT installation) FROM events WHERE at >= ? AND kind != 'search_failed'", (since,)).fetchone()[0]
            rows = db.execute("""SELECT date(at, 'unixepoch'),
                COUNT(DISTINCT CASE WHEN kind != 'search_failed' THEN installation END),
                SUM(CASE WHEN kind = 'open' THEN count ELSE 0 END),
                SUM(CASE WHEN kind IN ('search_text', 'search_image', 'search_reference') THEN count ELSE 0 END),
                SUM(CASE WHEN kind = 'insert' THEN count ELSE 0 END),
                SUM(CASE WHEN kind = 'search_failed' THEN count ELSE 0 END)
                FROM events WHERE at >= ? GROUP BY date(at, 'unixepoch')""", (since,)).fetchall()
            started = db.execute("SELECT value FROM metadata WHERE key='started_at'").fetchone()[0]
            last = db.execute('SELECT MAX(at) FROM events').fetchone()[0]
        by_date = {r[0]: dict(zip(('date', 'active', 'opens', 'searches', 'images', 'failed'), r)) for r in rows}
        daily = [by_date.get(date, dict(date=date, active=0, opens=0, searches=0, images=0, failed=0)) for date in dates]
        return dict(days=days, started_at=started, last_activity=last, totals=totals, active_installations=active,
                    active_days=sum(any(row[k] for k in ('opens', 'searches', 'images')) for row in daily), daily=daily)
