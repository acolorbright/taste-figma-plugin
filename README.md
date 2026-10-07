# Taste for Figma

Private Figma plugin: select an image to find visually similar references, or select one or more text layers to find relevant images. Choose multiple results and add them as image layers directly on the canvas beside the source. Insertion preserves image aspect ratios and can be undone in Figma.

The search service reads the original **Taste** library (`references.json`, `embeddings.json`, and `images/`) and uses its exact CLIP model: **OpenCLIP ViT-B-32, OpenAI weights, 512 dimensions**. It does not use taste-web’s separate OpenAI text-embedding index. Existing library files are read-only. No database migration or paid inference API is needed.

## Run locally

Requires Node.js 22+, Python 3.12+ and the Taste image library. On this machine it is at `/Users/se/Sites/taste/library`.

```sh
npm ci
npm run build
python3 -m venv .venv
.venv/bin/python -m pip install -r server/requirements.txt
.venv/bin/python -m server.run --library /Users/se/Sites/taste/library
```

The first launch may download CLIP model weights. The service binds to `127.0.0.1:8765`; the plugin connects via `http://localhost:8765` because Figma rejects numeric loopback addresses in its manifest. It uses Apple MPS / CUDA when available, and otherwise uses CPU. It creates `.taste-access-key` with owner-only permissions. Paste that file’s contents into the plugin’s initial connection setup. The key is saved in Figma client storage on this device, separately for each service URL, and reused when the plugin opens. An invalid key brings setup back.

The default plugin build now connects to the hosted Fly service. For local development, build with `TASTE_API_URL=http://localhost:8765 npm run package`.

### Install in Figma Desktop

1. Open a Figma Design or FigJam file.
2. Go to **Plugins → Development → Import plugin from manifest** and choose `dist/manifest.json`.
3. Select one layer with a visible image fill, or one or more text layers. FigJam sticky notes, shapes with text, and text inside frames, groups, components, and instances are also supported; hidden text is skipped.
4. Run **Taste — image search** from Development, enter the hosted team access key (or the local key for a local build), and connect.
5. Selecting an image or text layers starts a search automatically after a 300 ms pause, including when connecting with layers already selected. Select results, then **Insert images**.

Images are exported as seen, including crops and transforms. Mixed text/image selections and multiple images are deliberately rejected. Text layers are combined into a token-weighted CLIP query; long text is split into chunks so later words are not silently discarded. For best results use descriptive English phrases; CLIP is a visual matching model rather than a reasoning model.

Results are placed directly on the current page as image layers, beside the source’s containing frame. This avoids hiding new images inside clipped frames or changing auto-layout. Images use a three-column grid, 320 px wide, with original proportions. Inserted images become selected; a single inserted image automatically starts a similarity search. Original selection layers are left in place. Switching pages before insertion requires returning to the original page or searching again.

## Share privately with the team

**Option A: development distribution.** Share the contents of `dist/` or `taste-figma-plugin.zip` privately. Each teammate imports its manifest in Figma Desktop. With the local build, each teammate also runs the search service with a local copy of the Taste library.

**Option B: one team service and an internal organization plugin.**

1. Run `server/` on a machine/container reachable by the team, with the library mounted read-only and a long random `TASTE_API_TOKEN` set. Put it behind HTTPS. The server must be reachable from Figma; a browser login redirect is not compatible with its API.
2. Generate the plugin ID using Figma’s **Create new plugin** flow. Build against your service origin and that ID:

   ```sh
   TASTE_API_URL=https://taste.your-company.example FIGMA_PLUGIN_ID=YOUR_FIGMA_PLUGIN_ID npm run package
   ```

3. Import that manifest and test it in a Design file. Distribute the access key to authorized teammates using your usual secret-sharing channel.
4. In Figma’s plugin publishing flow, set **Publish to** to your organization. Do not select the public Community. Availability depends on your organization’s plan and publishing permissions. See [Figma’s internal plugin instructions](https://help.figma.com/hc/en-us/articles/4404228629655-Create-internal-plugins-for-an-organization).

The development ID is a placeholder; replace it with a Figma-issued ID before publishing. Builds explicitly allow only the configured service origin, plus localhost development URLs. A hosted plugin needs a real team service URL; localhost points at each teammate’s own machine.

### Container deployment

```sh
docker build -t taste-search .
docker run --rm -p 127.0.0.1:8765:8765 \
  -e TASTE_API_TOKEN -e TASTE_LIBRARY_PATH=/library \
  -v /path/to/taste/library:/library:ro \
  -v taste-model-cache:/home/app/.cache \
  taste-search
```

Provide HTTPS through your existing reverse proxy. Keep one worker per container to avoid loading duplicate models. Allow up to 90 seconds for searches, configure request limits at the proxy, and keep this service private to the team. The service rejects simultaneous inference requests with HTTP 429 rather than building an unbounded queue. Restart it after updating the library index.

The shared bearer key grants access to the full reference library. Rotate `TASTE_API_TOKEN` to revoke it. This first version does not implement individual user accounts, SSO, or per-user revocation. Uploaded selection images/text are processed in memory and not persisted or sent to third-party inference APIs. Authenticated downloads are re-encoded JPEGs, with a 4096-pixel maximum; GIF references use their first frame and transparent images use a white background.

## Development and verification

```sh
npm run check
.venv/bin/python -m pip install pytest httpx
.venv/bin/python -m pytest tests/test_server.py -q
# With the service running, use the real local library:
.venv/bin/python scripts/smoke.py
```

`npm run check` type-checks the plugin, runs selection/layout and mocked Figma host integration tests, then builds the importable plugin. Python tests check authentication, ranking, invalid inputs, image serving, and Figma iframe CORS. The smoke script exercises real CLIP text and image searches and checks self-image retrieval without printing credentials.

`npm run preview` opens a local browser harness at `http://127.0.0.1:8766` for checking the panel against the running search service. It simulates Figma selection and insertion; actual Figma document behavior still needs an in-editor test.

Source layout: `src/main.ts` is the Figma sandbox, `src/ui.ts` and `src/ui.html` are the panel, `server/search.py` handles CLIP and the existing index, and `server/app.py` exposes the authenticated API. Nothing in the Taste repositories needs modification.

## UI components

The panel uses [Figma Plugin DS](https://github.com/thomas-lowry/figma-plugin-ds), a community library linked from [Figma’s plugin samples](https://github.com/figma/plugin-samples#styling-your-plugin-ui). Its buttons, input, and checkboxes are bundled locally and mapped to Figma’s theme colors. External font loading is removed; the plugin uses installed Inter or the system font. The component license is included in the distribution.

## Fly.io team service

The pilot app is `taste-figma-search` in the **A Color Bright GmbH** organization,
Frankfurt (`fra`), with one always-running performance Machine (2 CPUs, 4 GB RAM).
The service uses CLIP ViT-B-32/openai and a snapshot of the library's CLIP vectors;
images are fetched from the existing Taste Web Vercel Blob URLs. No Neon or Blob
write credentials are deployed. Model weights are baked into the container.

Refresh the snapshot and deploy:

```sh
node scripts/export-hosted-library.mjs /Users/se/Sites/taste-web /Users/se/Sites/taste/library
fly deploy --remote-only --ha=false
.venv/bin/python scripts/benchmark-hosted.py
TASTE_API_URL=https://taste-figma-search.fly.dev npm run package
```

The export reads Taste Web's `.env.local` only to query image URLs. It writes ignored
`deploy-data/` files. New images require an updated local CLIP index, an uploaded
image in Taste Web, and another export/deploy. This pilot does not synchronize
library changes automatically.

The hosted team key is in `.taste-fly-access-key` (owner-readable only, ignored by
Git). It is stored as Fly secret `TASTE_API_TOKEN`, never bundled in the plugin.
Teammates import the packaged manifest and enter this key once. Public `/ready`
reveals only readiness; all library, image, and search routes require the key.

Unchanged images inserted by this plugin use `/search/reference` to reuse their
stored vectors. New images and text use CLIP inference. Thumbnails are cached in
memory and simultaneous inference requests queue briefly. The single-Machine
pilot can be interrupted by a restart/deploy; it is not a highly available setup.
