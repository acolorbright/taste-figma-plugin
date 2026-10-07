"""Authenticated, read-only search service. No submitted images or text are saved."""

import asyncio
import io
import logging
import os
import secrets
import warnings
import re
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from functools import lru_cache

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, HTMLResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool
from .search import Encoder, Library, read_image
from .idle import IdleTimer, TrackActivity
from .usage import UsageStore
from typing import Literal
from uuid import UUID

MAX_UPLOAD = 8 * 1024 * 1024


class ReferenceQuery(BaseModel):
    id: str = Field(min_length=1, max_length=256)


class TextQuery(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=50)
    limit: int = Field(default=24, ge=1, le=48)

    @field_validator("texts")
    @classmethod
    def validate_texts(cls, texts):
        texts = [text.strip() for text in texts if text.strip()]
        if not texts or sum(map(len, texts)) > 12000:
            raise ValueError("Provide 1–12,000 characters of text.")
        return texts


class UsageEvent(BaseModel):
    kind: Literal["open", "insert"]
    event_id: UUID
    count: int = Field(default=1, ge=1, le=24)


def create_app(library=None, encoder=None, token=None, shutdown=None, idle_timer=None, usage=None, admin_token=None):
    idle = idle_timer or IdleTimer(float(os.environ.get("TASTE_IDLE_SECONDS", "0")))
    if idle.seconds > 0 and shutdown is None:
        raise RuntimeError("Idle shutdown requires the server.run launcher.")
    admin_key = admin_token if admin_token is not None else os.environ.get("TASTE_USAGE_ADMIN_TOKEN", "")
    if admin_key and len(admin_key) < 24:
        raise RuntimeError("TASTE_USAGE_ADMIN_TOKEN must be at least 24 characters.")
    usage_path = os.environ.get("TASTE_USAGE_PATH")
    ledger = usage or (UsageStore(usage_path) if usage_path else None)
    access_key = token if token is not None else os.environ.get("TASTE_API_TOKEN", "")
    if len(access_key) < 24:
        raise RuntimeError(
            "Set TASTE_API_TOKEN to a random secret of at least 24 characters."
        )

    @asynccontextmanager
    async def lifespan(app):
        app.state.library = library or Library(
            os.environ.get(
                "TASTE_LIBRARY_PATH", str(Path.home() / "Sites/taste/library")
            )
        )
        app.state.encoder = encoder or Encoder()
        app.state.search_gate = asyncio.Semaphore(1)
        idle.last_activity = idle.clock()
        watcher = asyncio.create_task(idle.watch(shutdown)) if idle.seconds > 0 else None
        try:
            yield
        finally:
            if watcher:
                watcher.cancel()
                with suppress(asyncio.CancelledError):
                    await watcher

    app = FastAPI(
        title="Taste private image search",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    # Figma UI iframes can have opaque origins. Bearer authentication is mandatory;
    # cookies are never used, so the CORS wildcard does not grant access to the library.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_private_network=True,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type", "X-Taste-Installation"],
    )

    # Authentication/size middleware below wraps this tracker: rejected requests
    # and public health checks cannot extend the idle window.
    app.add_middleware(TrackActivity, timer=idle)

    @app.middleware("http")
    async def limits(request, call_next):
        expected_key = admin_key if request.url.path == "/usage/data" else access_key
        public = request.method == "GET" and request.url.path in ("/ready", "/usage")
        if not public and request.method != "OPTIONS" and (not expected_key or not secrets.compare_digest(
            request.headers.get("authorization", "").encode(),
            f"Bearer {expected_key}".encode(),
        )):
            return Response(
                "Invalid team access key",
                status_code=401,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "no-store",
                },
            )
        length = request.headers.get("content-length")
        if length:
            try:
                if int(length) > MAX_UPLOAD + 65536:
                    return Response("Request too large", status_code=413)
            except ValueError:
                return Response("Invalid Content-Length", status_code=400)
        # Enforce limits even for chunked requests before multipart parsing allocates a file.
        received = 0
        original_receive = request._receive

        async def receive():
            nonlocal received
            message = await original_receive()
            received += len(message.get("body", b""))
            if received > MAX_UPLOAD + 65536:
                raise HTTPException(413, "Request too large.")
            return message

        request._receive = receive
        response = await call_next(request)
        if request.url.path in ("/search/text", "/search/image", "/search/reference") and request.method == "POST":
            kind = "search_" + request.url.path.rsplit("/", 1)[1] if response.status_code == 200 else "search_failed"
            await record_usage(kind, installation(request))
        response.headers["Cache-Control"] = "no-store"
        if request.method == "OPTIONS":
            response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response

    def installation(request):
        value = request.headers.get("x-taste-installation", "")
        return value.lower() if re.fullmatch(r"[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}", value) else None

    async def record_usage(kind, identity, count=1, event_id=None):
        if ledger:
            try:
                await run_in_threadpool(ledger.record, kind, identity, count, event_id)
            except Exception:
                # Analytics must never prevent a search or insertion.
                logging.warning("Could not record usage event")

    @app.get("/usage", response_class=HTMLResponse)
    def usage_page():
        return HTMLResponse(Path(__file__).with_name("usage.html").read_text(), headers={
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
            "Referrer-Policy": "no-referrer",
        })

    @app.get("/usage/data")
    def usage_summary(days: int = Query(default=30, ge=1, le=366)):
        if not ledger:
            raise HTTPException(503, "Usage tracking is not configured.")
        return ledger.summary(days)

    @app.post("/usage/events", status_code=204)
    async def usage_event(event: UsageEvent, request: Request):
        identity = installation(request)
        if identity is None:
            raise HTTPException(422, "An anonymous installation ID is required.")
        await record_usage(event.kind, identity, 1 if event.kind == "open" else event.count, str(event.event_id))
        return Response(status_code=204)

    def authenticate(request: Request):
        supplied = request.headers.get("authorization", "")
        if not secrets.compare_digest(
            supplied.encode(), f"Bearer {access_key}".encode()
        ):
            raise HTTPException(401, "Invalid team access key.")

    @app.get("/ready")
    def ready():
        return {"status": "ok"}

    @app.post("/search/reference", dependencies=[Depends(authenticate)])
    def reference_search(query: ReferenceQuery):
        if query.id not in app.state.library.indices:
            raise HTTPException(404, "Reference not found.")
        return {"results": app.state.library.rank(app.state.library.reference_vector(query.id), 24, query.id)}

    @app.get("/health", dependencies=[Depends(authenticate)])
    def health():
        return {
            "status": "ok",
            "count": len(app.state.library.refs),
            "model": "ViT-B-32",
            "weights": "openai",
        }

    async def search(work, limit, exclude_id=None):
        try:
            # Serialize model inference with a short queue for simultaneous team requests.
            await asyncio.wait_for(app.state.search_gate.acquire(), timeout=10)
        except TimeoutError:
            raise HTTPException(
                429, "Taste is processing another search. Please try again shortly."
            )
        try:
            vector = await run_in_threadpool(work)
            return {"results": app.state.library.rank(vector, limit, exclude_id)}
        except (
            ValueError,
            UnidentifiedImageError,
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
        ):
            raise HTTPException(
                422, "The selected image or text could not be processed."
            )
        except Exception:
            logging.exception("Search failed")
            raise HTTPException(503, "Search is temporarily unavailable.")
        finally:
            app.state.search_gate.release()

    @app.post("/search/text", dependencies=[Depends(authenticate)])
    async def text_search(query: TextQuery):
        return await search(lambda: app.state.encoder.text(query.texts), query.limit)

    @app.post("/search/image", dependencies=[Depends(authenticate)])
    async def image_search(image: UploadFile = File(...), exclude_id: str | None = Form(default=None, max_length=256)):
        try:
            data = await image.read(MAX_UPLOAD + 1)
        finally:
            await image.close()
        if not data or len(data) > MAX_UPLOAD:
            raise HTTPException(413, "Choose an image smaller than 8 MB.")
        return await search(lambda: app.state.encoder.image(data), 24, exclude_id)

    @lru_cache(maxsize=128)
    def thumbnail(identity):
        image = read_image(app.state.library.image_bytes(identity))
        image.thumbnail((320, 320))
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=90)
        return buffer.getvalue()

    @app.get("/images/{identity}", dependencies=[Depends(authenticate)])
    def image(identity: str, size: int = Query(default=320, ge=32, le=4096)):
        file = app.state.library.files.get(identity)
        if file is None:
            raise HTTPException(404, "Image not found.")
        try:
            if size == 320:
                return Response(thumbnail(identity), media_type="image/jpeg")
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                image = read_image(app.state.library.image_bytes(identity))
            image.thumbnail((size, size))
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=90)
            return Response(buffer.getvalue(), media_type="image/jpeg")
        except (
            OSError,
            ValueError,
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
        ):
            raise HTTPException(422, "This library image is unavailable.")

    return app
