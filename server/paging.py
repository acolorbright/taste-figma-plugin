"""Bounded, temporary ranked search snapshots. Never re-encode on scroll."""
from collections import OrderedDict
import secrets
import threading
import time


class SearchPages:
    def __init__(self, capacity=64, ttl=10800):
        self.capacity, self.ttl = capacity, ttl
        self.items = OrderedDict()
        self.lock = threading.Lock()

    def start(self, results, size=24):
        if len(results) <= size:
            return {'results': results, 'next': None}
        with self.lock:
            identity = secrets.token_urlsafe(24)
            self.items[identity] = (time.monotonic(), results)
            while len(self.items) > self.capacity:
                self.items.popitem(last=False)
        return self.page(identity, 0, size)

    def page(self, identity, offset, size=24):
        with self.lock:
            stored = self.items.get(identity)
            if stored is None or time.monotonic() - stored[0] >= self.ttl:
                self.items.pop(identity, None)
                return None
            results = stored[1]
            self.items[identity] = (time.monotonic(), results)
            self.items.move_to_end(identity)
            end = offset + size
            return {'results': results[offset:end],
                    'next': {'search_id': identity, 'offset': end} if end < len(results) else None}
