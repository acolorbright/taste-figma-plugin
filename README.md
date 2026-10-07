# Taste for Figma and FigJam

Find images from the team's Taste library by selecting an image, text layers, or FigJam sticky notes.

## Install — for designers

**[Download the latest plugin ZIP](https://github.com/acolorbright/taste-figma-plugin/releases/latest/download/taste-figma-plugin.zip)**

You need the **Figma desktop app** and the **team access key**. Ask Sven for the key. No coding, terminal commands, or local server setup is needed.

1. **Download and unzip** `taste-figma-plugin.zip`. Keep the extracted folder somewhere permanent, such as `Documents/Taste plugin`.
2. **Open a Figma Design or FigJam file** in the desktop app.
3. In the Figma menu, choose **Plugins → Development → Import plugin from manifest**. Select **`manifest.json` inside the extracted folder**.
4. Run **Plugins → Development → Taste — image search**.
5. **Paste the team access key and click Connect.** You only need to do this once per device; the plugin remembers it.

The download is public; no GitHub account is needed. Searching the team library still requires the team access key, which is not included in the download. On the [releases page](https://github.com/acolorbright/taste-figma-plugin/releases/latest), choose **`taste-figma-plugin.zip`** under Assets, not “Source code”.

## Use it

- Select **one image** to find visually similar images.
- Select **one or more text layers or FigJam sticky notes** to find images based on their contents. Multiple texts are searched together.
- Search starts automatically. Tick the images you want, then click **Insert images**. You can select and insert each result as soon as its preview loads.

After a quiet period, Taste wakes up automatically. The plugin shows a small animated explanation while the server starts; your search continues when it is ready. Each use keeps it awake for another three hours.

Images are placed directly on the canvas. Inserting one image selects it and starts a new similarity search, excluding that same Taste reference.

## Update the plugin

Close the plugin, [download the latest ZIP](https://github.com/acolorbright/taste-figma-plugin/releases/latest/download/taste-figma-plugin.zip), and replace the files in the folder you originally imported. Then reopen the plugin. If you moved that folder, import its `manifest.json` again.

## If something isn't working

- **Plugin doesn't appear:** use the desktop app and import `manifest.json`, not the ZIP.
- **Access key not accepted:** ask Sven for the current team key and reconnect.
- **Cannot reach Taste:** check your internet connection; if it persists, let Sven know.
- **No search starts:** select one image, or text/sticky notes containing words. Multiple images and mixed image/text selections aren't supported.

---

## Developer and hosting notes

The default build connects to the team's hosted Fly.io service. The sections below are for maintaining the plugin; colleagues installing it can stop here.

Search uses **OpenCLIP ViT-B-32, OpenAI weights, 512 dimensions**, matching the original Taste library. It does not use Taste Web's separate OpenAI text-embedding index. The hosted service uses a CLIP index snapshot and existing Vercel Blob image URLs.

## Run locally

Requires Node.js 22+, Python 3.12+ and the Taste image library. On this machine it is at `/Users/se/Sites/taste/library`.

```sh
npm ci
TASTE_API_URL=http://localhost:8765 npm run build
python3 -m venv .venv
.venv/bin/python -m pip install -r server/requirements.txt
.venv/bin/python -m server.run --library /Users/se/Sites/taste/library
```

The first launch may download CLIP model weights. The service binds to `127.0.0.1:8765`; the plugin connects via `http://localhost:8765` because Figma rejects numeric loopback addresses in its manifest. It uses Apple MPS / CUDA when available, and otherwise uses CPU. It creates `.taste-access-key` with owner-only permissions. Paste that file’s contents into the plugin’s initial connection setup. The key is saved in Figma client storage on this device, separately for each service URL, and reused when the plugin opens. An invalid key brings setup back.

The default plugin build now connects to the hosted Fly service. For local development, build with `TASTE_API_URL=http://localhost:8765 npm run package`.

Images are exported as seen, including crops and transforms. Mixed text/image selections and multiple images are deliberately rejected. Text layers are combined into a token-weighted CLIP query; long text is split into chunks so later words are not silently discarded. For best results use descriptive English phrases; CLIP is a visual matching model rather than a reasoning model.

Results are placed directly on the current page as image layers, beside the source’s containing frame. This avoids hiding new images inside clipped frames or changing auto-layout. Images use a three-column grid, 320 px wide, with original proportions. Inserted images become selected; a single inserted image automatically starts a similarity search. Original selection layers are left in place. Switching pages before insertion requires returning to the original page or searching again.

## Share privately with the team

**Option A: development distribution.** Share the contents of `dist/` or `taste-figma-plugin.zip` privately. Each teammate imports its manifest in Figma Desktop. The default hosted build needs no local server. A deliberately configured local build requires a local search service.

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

Provide HTTPS through your existing reverse proxy. Keep one worker per container to avoid loading duplicate models. Allow up to 90 seconds for searches, configure request limits at the proxy, and keep this service private to the team. The service queues simultaneous inference requests for up to 10 seconds, then returns HTTP 429 if it is still busy. Restart it after updating the library index.

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
Frankfurt (`fra`), with one performance Machine (2 CPUs, 4 GB RAM) that shuts down after three idle hours.
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

### Idle shutdown and startup

`TASTE_IDLE_SECONDS=10800` sets a rolling three-hour window after the last
completed authenticated request. Searches, image downloads, and connecting the
plugin count as activity; `/ready` probes, CORS preflights, and rejected credentials
do not. Active requests finish before the idle timer can expire. An open plugin
makes no background keepalive requests.

The application asks Uvicorn to exit cleanly. Fly's `on-failure` restart policy
leaves it stopped; `auto_start_machines=true` wakes it on the next request.
`auto_stop_machines="off"` prevents Fly's shorter idle policy from overriding the
three-hour window. The plugin checks readiness before searching or inserting,
with bounded retries for startup failures, and displays rotating explanatory
messages when readiness takes more than 1.2 seconds. These explain startup;
they are not live server-stage telemetry. Normal warm searches skip the animation.

Set `TASTE_IDLE_SECONDS=0` to disable idle shutdown (the local default). A positive
value requires launching with `python -m server.run`. Compute charges stop while
the Machine is stopped; storage/network charges may still apply.
