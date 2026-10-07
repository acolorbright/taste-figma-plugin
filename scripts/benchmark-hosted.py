"""Measure the deployed service without exposing its access key."""
from pathlib import Path
import json
import time
from concurrent.futures import ThreadPoolExecutor
import httpx

root = Path(__file__).resolve().parent.parent
key = (root / '.taste-fly-access-key').read_text().strip()
with httpx.Client(base_url='https://taste-figma-search.fly.dev', headers={'Authorization': f'Bearer {key}'}, timeout=90) as client:
    health = client.get('/health')
    health.raise_for_status()
    print('Health:', health.json())
    timings = {}
    def measure(name, work):
        start = time.perf_counter()
        response = work()
        response.raise_for_status()
        timings.setdefault(name, []).append(round(time.perf_counter()-start, 3))
        return response
    for _ in range(3):
        response = measure('text', lambda: client.post('/search/text', json={'texts':['warm gradient graphic design']}))
    source = response.json()['results'][0]['id']
    for _ in range(3):
        related = measure('reference', lambda: client.post('/search/reference', json={'id':source})).json()['results']
        assert len(related) == 24 and source not in [r['id'] for r in related]
    image = measure('download', lambda: client.get(f'/images/{source}?size=1024')).content
    for _ in range(3):
        measure('new_image', lambda: client.post('/search/image', files={'image':('test.jpg', image,'image/jpeg')}, data={'exclude_id':source}))
    def thumbnail(result):
        r=client.get(f'/images/{result["id"]}?size=320')
        r.raise_for_status()
        return len(r.content)
    for label in ['previews_cold','previews_cached']:
        start=time.perf_counter()
        with ThreadPoolExecutor(max_workers=4) as pool:
            assert all(pool.map(thumbnail, related))
        timings[label]=[round(time.perf_counter()-start,3)]
    def text_job(i):
        r=client.post('/search/text',json={'texts':[f'editorial poster {i}']})
        r.raise_for_status()
    start=time.perf_counter()
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(text_job,range(3)))
    timings['three_simultaneous_queries']=[round(time.perf_counter()-start,3)]
    print(json.dumps(timings,indent=2))
    (root/'output').mkdir(exist_ok=True)
    (root/'output/hosted-benchmark.json').write_text(json.dumps(timings,indent=2))
