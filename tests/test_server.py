import io
import json
import numpy as np
import pytest
from PIL import Image
from fastapi.testclient import TestClient
from server.app import create_app
from server.search import Library, normalize, read_image

KEY = "test-key-that-is-long-enough-for-tests"
AUTH = {"Authorization": f"Bearer {KEY}"}


class Encoder:
    def text(self, texts):
        return np.eye(1, 512, dtype=np.float32)[0]

    def image(self, data):
        read_image(data)
        return self.text([])


@pytest.fixture
def library(tmp_path):
    (tmp_path / "images").mkdir()
    for name in ["one.png", "two.png"]:
        Image.new("RGB", (30, 15), "red").save(tmp_path / "images" / name)
    refs = [
        {"id": "one", "file": "one.png"},
        {"id": "two", "file": "two.png"},
        {"id": "escape", "file": "../../secret.png"},
    ]
    (tmp_path / "references.json").write_text(json.dumps(refs))
    a = [1.0] + [0.0] * 511
    b = [0.0, 1.0] + [0.0] * 510
    (tmp_path / "embeddings.json").write_text(json.dumps({"one.png": a, "two.png": b}))
    return Library(tmp_path)


@pytest.fixture
def client(library):
    with TestClient(create_app(library, Encoder(), KEY)) as client:
        yield client


def test_authentication_on_every_route(client):
    for method, path, kwargs in [
        ("get", "/health", {}),
        ("get", "/images/one", {}),
        ("post", "/search/text", {"json": {"texts": ["bold"]}}),
        ("post", "/search/image", {"files": {"image": ("a.png", b"bad", "image/png")}}),
    ]:
        assert getattr(client, method)(path, **kwargs).status_code == 401
    assert client.get("/health", headers=AUTH).json()["count"] == 2


def test_text_search_and_limits(client):
    response = client.post(
        "/search/text", headers=AUTH, json={"texts": ["bold", "editorial"], "limit": 1}
    )
    assert response.status_code == 200
    assert response.json()["results"][0]["id"] == "one"
    for texts in [[], ["  "], ["x" * 12001], ["word"] * 51]:
        assert (
            client.post("/search/text", headers=AUTH, json={"texts": texts}).status_code
            == 422
        )


def test_image_search_and_bad_images(client):
    data = io.BytesIO()
    Image.new("RGB", (32, 32), "blue").save(data, format="PNG")
    result = client.post(
        "/search/image",
        headers=AUTH,
        files={"image": ("a.png", data.getvalue(), "image/png")},
    )
    assert result.status_code == 200
    assert result.json()["results"][0]["id"] == "one"
    assert (
        client.post(
            "/search/image",
            headers=AUTH,
            files={"image": ("a.png", b"invalid", "image/png")},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/search/image",
            headers=AUTH,
            files={"image": ("a.png", b"x" * (8 * 1024 * 1024 + 1), "image/png")},
        ).status_code
        == 413
    )


def test_images_are_bounded_and_use_ids_not_paths(client):
    response = client.get("/images/one?size=32", headers=AUTH)
    assert response.status_code == 200
    assert Image.open(io.BytesIO(response.content)).size == (30, 15)
    assert response.headers["cache-control"] == "no-store"
    assert client.get("/images/escape", headers=AUTH).status_code == 404
    assert client.get("/images/one?size=5000", headers=AUTH).status_code == 422


def test_image_search_excludes_source_without_dropping_unrelated_first_match(client, library):
    data = io.BytesIO()
    Image.new("RGB", (32, 32), "red").save(data, format="PNG")
    response = client.post(
        "/search/image", headers=AUTH,
        files={"image": ("a.png", data.getvalue(), "image/png")},
        data={"exclude_id": "one"},
    )
    assert response.status_code == 200
    assert [r["id"] for r in response.json()["results"]] == ["two"]
    vector = [1.0] + [0.0] * 511
    assert library.rank(vector, 1, exclude_id="one")[0]["id"] == "two"
    assert library.rank(vector, 1, exclude_id="unknown")[0]["id"] == "one"


def test_cors_for_opaque_figma_origin(client):
    response = client.options(
        "/search/text",
        headers={
            "Origin": "null",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"
    assert response.headers["access-control-allow-private-network"] == "true"


def test_invalid_vectors_rejected_and_rank_is_cosine(library):
    for vector in [[1, 2], [0.0] * 512, [float("nan")] * 512]:
        with pytest.raises(ValueError):
            normalize(vector)
    assert library.rank([20.0] + [0.0] * 511, 1)[0]["id"] == "one"


def test_fail_closed_without_token():
    with pytest.raises(RuntimeError):
        create_app(token="")


def test_long_text_keeps_all_tokens_across_clip_windows():
    import threading
    import torch
    from server.search import Encoder as ClipEncoder

    class Tokenizer:
        sot_token_id = 9001
        eot_token_id = 9002

        def encode(self, text):
            return list(range(1, int(text) + 1))

    class Model:
        context_length = 77
        seen = []

        def encode_text(self, batch):
            self.seen.extend(batch.tolist())
            return torch.ones((len(batch), 512))

    encoder = ClipEncoder.__new__(ClipEncoder)
    encoder.torch = torch
    encoder.device = "cpu"
    encoder.model = Model()
    encoder.tokenizer = Tokenizer()
    encoder.lock = threading.Lock()
    assert encoder.text(["160"]).shape == (512,)
    seen = [token for row in encoder.model.seen for token in row if 0 < token < 9001]
    assert seen == list(range(1, 161))
    assert len(encoder.model.seen) == 3


def test_reference_search_uses_index_and_excludes_source(client):
    result = client.post('/search/reference', headers=AUTH, json={'id': 'one'})
    assert result.status_code == 200
    assert [r['id'] for r in result.json()['results']] == ['two']
    assert client.post('/search/reference', json={'id': 'one'}).status_code == 401
    assert client.post('/search/reference', headers=AUTH, json={'id': 'missing'}).status_code == 404
    assert client.get('/ready').json() == {'status': 'ok'}


def test_hosted_library_works_without_local_images(library):
    root = library.root
    refs = json.loads((root / 'references.json').read_text())[:2]
    refs[0]['url'] = 'https://example.public.blob.vercel-storage.com/one.png'
    refs[1]['url'] = 'http://localhost/private'
    (root / 'references.json').write_text(json.dumps(refs))
    for file in (root / 'images').iterdir():
        file.unlink()
    hosted = Library(root)
    assert [r['id'] for r in hosted.refs] == ['one']
    assert hosted.reference_vector('one').shape == (512,)


def test_simultaneous_team_queries_wait_instead_of_failing(library):
    import time
    from concurrent.futures import ThreadPoolExecutor

    class SlowEncoder(Encoder):
        def text(self, texts):
            time.sleep(0.2)
            return super().text(texts)

    with TestClient(create_app(library, SlowEncoder(), KEY)) as client:
        def query(_):
            return client.post('/search/text', headers=AUTH, json={'texts': ['test']}).status_code
        with ThreadPoolExecutor(max_workers=3) as pool:
            assert list(pool.map(query, range(3))) == [200, 200, 200]


def test_idle_window_resets_after_work_and_never_expires_during_work():
    from server.idle import IdleTimer
    now = [0]
    timer = IdleTimer(10800, clock=lambda: now[0])
    now[0] = 10799
    assert not timer.expired()
    timer.begin()
    now[0] = 20000
    assert not timer.expired()
    timer.end()
    now[0] += 10799
    assert not timer.expired()
    now[0] += 1
    assert timer.expired()
    assert not IdleTimer(0).expired()


def test_only_authenticated_use_extends_idle_window(library):
    from server.idle import IdleTimer
    now = [0]
    timer = IdleTimer(10800, clock=lambda: now[0])
    with TestClient(create_app(library, Encoder(), KEY, shutdown=lambda: None, idle_timer=timer)) as client:
        now[0] = 100
        client.get('/ready')
        client.get('/health')
        client.options('/search/text', headers={'Origin': 'null', 'Access-Control-Request-Method': 'POST'})
        assert timer.last_activity == 0
        client.get('/health', headers=AUTH)
        assert timer.last_activity == 100
        now[0] = 200
        client.post('/search/text', headers=AUTH, json={'texts': ['test']})
        assert timer.last_activity == 200
        assert timer.active == 0


def test_idle_watch_requests_graceful_shutdown(library):
    import threading
    from server.idle import IdleTimer
    stopped = threading.Event()
    with TestClient(create_app(library, Encoder(), KEY, shutdown=stopped.set, idle_timer=IdleTimer(0.05))):
        assert stopped.wait(2)


def test_usage_is_durable_private_and_deduplicates_client_events(library, tmp_path):
    from server.usage import UsageStore
    import uuid
    admin = 'separate-usage-admin-secret-for-tests'
    path = tmp_path / 'usage.sqlite3'
    store = UsageStore(path)
    install = str(uuid.uuid4())
    auth = {**AUTH, 'X-Taste-Installation': install}
    with TestClient(create_app(library, Encoder(), KEY, usage=store, admin_token=admin)) as client:
        assert client.get('/usage').status_code == 200
        assert client.get('/usage/data').status_code == 401
        assert client.get('/usage/data', headers=AUTH).status_code == 401
        assert client.post('/search/text', headers=auth, json={'texts': ['private words never stored']}).status_code == 200
        assert client.post('/search/reference', headers=auth, json={'id': 'one'}).status_code == 200
        assert client.post('/search/reference', headers=auth, json={'id': 'missing'}).status_code == 404
        for kind, count in [('open', 1), ('insert', 3)]:
            event = dict(kind=kind, event_id=str(uuid.uuid4()), count=count)
            for _ in range(2):
                assert client.post('/usage/events', headers=auth, json=event).status_code == 204
        assert client.post('/usage/events', headers=AUTH, json=event).status_code == 422
        assert client.post('/usage/events', headers=auth, json={**event, 'kind': 'arbitrary'}).status_code == 422
        assert client.post('/usage/events', headers=auth, json={**event, 'count': 999}).status_code == 422
        report = client.get('/usage/data', headers={'Authorization': f'Bearer {admin}'}).json()
        assert report['totals'] == {'open': 1, 'insert': 3, 'search_reference': 1, 'search_text': 1, 'search_failed': 1}
        assert report['active_installations'] == 1
        assert report['active_days'] == 1
        assert len(report['daily']) == 30
    reopened = UsageStore(path)
    assert reopened.summary()['totals']['insert'] == 3
    with reopened.connect() as db:
        dump = '\n'.join(db.iterdump())
    assert 'private words' not in dump
    assert KEY not in dump
    assert admin not in dump


def test_usage_handles_older_plugins_and_storage_failures(library, tmp_path):
    from server.usage import UsageStore
    store = UsageStore(tmp_path / 'usage.sqlite3')
    with TestClient(create_app(library, Encoder(), KEY, usage=store)) as client:
        client.post('/search/text', headers=AUTH, json={'texts': ['old plugin']})
        report = store.summary()
        assert report['totals']['search_text'] == 1
        assert report['active_installations'] == 0
        def unavailable(*args):
            raise OSError('disk full')
        store.record = unavailable
        assert client.post('/search/text', headers=AUTH, json={'texts': ['test']}).status_code == 200


def test_usage_report_does_not_extend_idle_timer(library, tmp_path):
    from server.idle import IdleTimer
    from server.usage import UsageStore
    now = [0]
    timer = IdleTimer(10800, clock=lambda: now[0])
    admin = 'separate-usage-admin-secret-for-tests'
    with TestClient(create_app(library, Encoder(), KEY, shutdown=lambda: None, idle_timer=timer,
                              usage=UsageStore(tmp_path / 'usage.sqlite3'), admin_token=admin)) as client:
        now[0] = 100
        client.get('/usage')
        client.get('/usage/data', headers={'Authorization': f'Bearer {admin}'})
        assert timer.last_activity == 0


def test_paging_reuses_inference_and_excludes_source_across_pages(library):
    class CountingEncoder(Encoder):
        calls = 0
        def text(self, texts):
            self.calls += 1
            return super().text(texts)
    encoder = CountingEncoder()
    library.refs = [{'id': str(i), 'name': str(i), 'cluster': ''} for i in range(75)]
    library.matrix = np.tile(np.eye(1, 512, dtype=np.float32), (75, 1))
    library.indices = {r['id']: i for i, r in enumerate(library.refs)}
    with TestClient(create_app(library, encoder, KEY)) as client:
        page = client.post('/search/text', headers=AUTH, json={'texts':['test'], 'paginate':True}).json()
        ids = [r['id'] for r in page['results']]
        assert len(ids) == 24
        cursor = page['next']
        assert client.get('/search/page', params=cursor).status_code == 401
        while page['next']:
            page = client.get('/search/page', params=page['next'], headers=AUTH).json()
            ids.extend(r['id'] for r in page['results'])
        assert ids == [str(i) for i in range(75)]
        assert encoder.calls == 1
        repeated = client.get('/search/page', params=cursor, headers=AUTH).json()
        assert repeated['results'][0]['id'] == '24'
        assert client.get('/search/page', params={'search_id':'missing','offset':24}, headers=AUTH).status_code == 410
        page = client.post('/search/reference', headers=AUTH, json={'id':'0','paginate':True}).json()
        ids = [r['id'] for r in page['results']]
        while page['next']:
            page = client.get('/search/page', params=page['next'], headers=AUTH).json()
            ids.extend(r['id'] for r in page['results'])
        assert ids == [str(i) for i in range(1,75)]


def test_page_cache_is_bounded_and_expiry_is_explicit():
    from server.paging import SearchPages
    pages = SearchPages(capacity=1)
    first = pages.start(list(range(50)))['next']
    second = pages.start(list(range(30)))['next']
    assert pages.page(first['search_id'],24) is None
    assert pages.page(second['search_id'],24)['results'] == list(range(24,30))
    pages.ttl = 0
    assert pages.page(second['search_id'],24) is None


def test_paging_stops_after_ten_pages():
    from server.paging import SearchPages
    pages = SearchPages()
    page = pages.start(list(range(500)))
    results = []
    count = 0
    while True:
        count += 1
        results.extend(page['results'])
        if page['next'] is None:
            break
        page = pages.page(**{'identity': page['next']['search_id'], 'offset': page['next']['offset']})
    assert count == 10
    assert results == list(range(240))


def test_team_upload_is_searchable_deduplicated_and_survives_restart(library, tmp_path):
    from server.ingest import IngestStore
    store = IngestStore(tmp_path / "additions.sqlite3")
    data = io.BytesIO()
    Image.new("RGB", (48, 24), "purple").save(data, "PNG")
    payload = {"image": ("selection.png", data.getvalue(), "image/png")}
    with TestClient(create_app(library, Encoder(), KEY, additions=store)) as client:
        assert client.post("/library/images", files=payload).status_code == 401
        result = client.post("/library/images", headers=AUTH, files=payload, data={"name": "Team image"}).json()
        assert result["added"] is True
        identity = result["id"]
        assert client.post("/library/images", headers=AUTH, files=payload).json() == {"id": identity, "added": False}
        assert client.get("/health", headers=AUTH).json()["count"] == 3
        assert identity in [r["id"] for r in client.post("/search/text", headers=AUTH, json={"texts": ["purple"]}).json()["results"]]
        assert client.get(f"/images/{identity}", headers=AUTH).status_code == 200
        assert client.post("/library/images", headers=AUTH, files={"image": ("bad", b"bad")}).status_code == 422
        assert client.post("/library/images", headers=AUTH, files=payload, data={"reference_id": "one"}).json() == {"id": "one", "added": False}
    restored = Library(tmp_path)
    with TestClient(create_app(restored, Encoder(), KEY, additions=IngestStore(store.path))) as client:
        assert client.get("/health", headers=AUTH).json()["count"] == 3
        assert client.get(f"/images/{identity}?size=4096", headers=AUTH).status_code == 200


def test_channel_validation_and_download_boundaries():
    from server.ingest import channel_slug, fetch
    assert channel_slug("https://www.are.na/person/my-channel/") == "my-channel"
    assert channel_slug("my-channel") == "my-channel"
    for value in ["http://127.0.0.1/x", "https://example.com/a/b", "https://www.are.na/block/123", "../secret", "x?per=2", "https://evil@are.na/x/y"]:
        with pytest.raises(ValueError):
            channel_slug(value)
    for url in ["http://images.are.na/x", "https://127.0.0.1/x", "https://images.are.na.evil.com/x", "https://images.are.na:444/x"]:
        with pytest.raises(ValueError):
            fetch(url, image=True)


def test_channel_sync_incremental_shared_and_failure_visible(library, tmp_path, monkeypatch):
    import asyncio
    import server.ingest as ingest
    store = ingest.IngestStore(tmp_path / "additions.sqlite3")
    store.restore(library)
    data = io.BytesIO()
    Image.new("RGB", (12, 12), "green").save(data, "PNG")
    block = {"id": 99, "class": "Image", "title": "Green", "image": {"display": {"url": "https://images.are.na/image"}}}
    downloads = []
    def fetched(url, image=False):
        if image:
            downloads.append(url)
            return data.getvalue()
        return {"base_class": "Channel", "slug": "channel", "title": "Test channel", "status": "public", "length": 1, "contents": [block]}
    monkeypatch.setattr(ingest, "fetch", fetched)
    assert store.add_channel("channel") == "channel"
    store.add_channel("channel")
    assert len(store.channels()) == 1
    asyncio.run(store.sync_channel("channel", library, Encoder()))
    row = store.channels()[0]
    assert row["state"] == "synced" and row["last_synced"] and row["added"] == 1
    asyncio.run(store.sync_channel("channel", library, Encoder()))
    assert len(downloads) == 1
    assert store.channels()[0]["added"] == 0
    last_synced = store.channels()[0]["last_synced"]
    def failed(*args):
        raise OSError("offline")
    monkeypatch.setattr(ingest, "fetch", failed)
    asyncio.run(store.sync_channel("channel", library, Encoder()))
    assert store.channels()[0]["state"] == "error"
    assert store.channels()[0]["last_synced"] == last_synced


def test_channel_routes_require_team_key(client):
    assert client.get("/library/channels").status_code == 401
    assert client.post("/library/channels", json={"url": "channel"}).status_code == 401
    assert client.get("/library/channels", headers=AUTH).status_code == 503


def test_sync_schedule_does_not_extend_idle_and_obeys_six_hours(library, tmp_path, monkeypatch):
    import asyncio
    import server.ingest as ingest
    from server.idle import IdleTimer
    store = ingest.IngestStore(tmp_path / "additions.sqlite3")
    with store.db() as db:
        db.execute("INSERT INTO channels (slug,title,state,last_attempt) VALUES ('a','A','synced',1000)")
    now = [1000.0]
    monkeypatch.setattr(ingest.time, "time", lambda: now[0])
    idle = IdleTimer(10800, clock=lambda: 50)
    calls = []
    async def sync(slug, *args):
        assert idle.active == 1
        calls.append(slug)
        store.update_channel(slug, state="synced", last_attempt=now[0])
    monkeypatch.setattr(store, "sync_channel", sync)
    async def check():
        wake = asyncio.Event()
        task = asyncio.create_task(store.watch(library, Encoder(), idle, wake))
        await asyncio.sleep(.01)
        assert calls == ['a']  # Every wake, even if last synced recently.
        wake.set()
        await asyncio.sleep(.01)
        assert calls == ['a']
        now[0] += ingest.SYNC_SECONDS
        wake.set()
        await asyncio.sleep(.01)
        assert calls == ['a', 'a']
        assert idle.last_activity == 50 and idle.active == 0
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    asyncio.run(check())


def test_manual_channel_sync_is_authenticated_idempotent_and_preserves_history(library, tmp_path, monkeypatch):
    import asyncio
    from server.ingest import IngestStore
    store = IngestStore(tmp_path / 'additions.sqlite3')
    with store.db() as db:
        db.execute("INSERT INTO channels (slug,title,state,last_synced,last_attempt,error) VALUES ('moods','Moods','error',100,200,'offline')")
    async def paused(*args):
        await asyncio.Event().wait()
    monkeypatch.setattr(store, 'watch', paused)
    with TestClient(create_app(library, Encoder(), KEY, additions=store)) as client:
        path = '/library/channels/moods/sync'
        assert client.post(path).status_code == 401
        response = client.post(path, headers=AUTH)
        assert response.status_code == 202 and response.json()['state'] == 'pending'
        row = store.channels()[0]
        assert row['last_synced'] == 100 and row['error'] == ''
        assert client.post(path, headers=AUTH).json()['state'] == 'pending'
        store.update_channel('moods', state='syncing')
        assert client.post(path, headers=AUTH).json()['state'] == 'syncing'
        assert client.post('/library/channels/missing/sync', headers=AUTH).status_code == 404
    assert IngestStore.channel_url({'slug': 'moods', 'user': {'slug': 'sven'}}) == 'https://www.are.na/sven/moods'


def test_channel_url_migration_preserves_existing_channels(tmp_path):
    import sqlite3
    from server.ingest import IngestStore
    path = tmp_path / 'legacy.sqlite3'
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE channels (slug TEXT PRIMARY KEY,title TEXT,last_synced REAL,last_attempt REAL,state TEXT,error TEXT,added INTEGER)")
        db.execute("INSERT INTO channels VALUES ('moods','Moods',100,100,'synced','',42)")
    store = IngestStore(path)
    assert store.channels()[0]['last_synced'] == 100
    assert store.channels()[0]['added'] == 42
    assert store.channels()[0]['url'] == ''
