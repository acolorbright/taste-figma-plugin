"""Graceful idle shutdown, without treating health probes as user activity."""

import asyncio
import logging
import time


class IdleTimer:
    def __init__(self, seconds, clock=time.monotonic):
        self.seconds = seconds
        self.clock = clock
        self.last_activity = clock()
        self.active = 0

    def begin(self):
        self.active += 1

    def end(self):
        self.active -= 1
        self.last_activity = self.clock()

    def expired(self):
        return self.seconds > 0 and self.active == 0 and self.clock() - self.last_activity >= self.seconds

    async def watch(self, shutdown):
        while True:
            await asyncio.sleep(min(30, self.seconds))
            if self.expired():
                logging.getLogger("uvicorn.error").info("Idle for %s seconds; shutting down cleanly", self.seconds)
                shutdown()
                return


class TrackActivity:
    """Keep requests active until the complete response has been sent."""

    def __init__(self, app, timer):
        self.app = app
        self.timer = timer

    async def __call__(self, scope, receive, send):
        tracked = scope["type"] == "http" and scope["path"] not in ("/ready", "/usage", "/usage/data") and scope["method"] != "OPTIONS"
        if not tracked:
            return await self.app(scope, receive, send)
        self.timer.begin()
        try:
            await self.app(scope, receive, send)
        finally:
            self.timer.end()
