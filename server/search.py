"""Taste's existing ViT-B-32/openai index, with image and text query encoders."""

import io
import hashlib
import json
import threading
import os
from urllib.parse import urlparse
from urllib.request import urlopen
import warnings
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

MODEL = "ViT-B-32"
WEIGHTS = "openai"
Image.MAX_IMAGE_PIXELS = 40_000_000


def normalize(vector):
    value = np.asarray(vector, dtype=np.float32)
    norm = np.linalg.norm(value)
    if value.shape != (512,) or not np.isfinite(value).all() or norm < 1e-8:
        raise ValueError(
            "Invalid CLIP vector; expected 512 finite, nonzero dimensions."
        )
    return value / norm


def read_image(data):
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        return _decode_image(data)


def _decode_image(data):
    with Image.open(io.BytesIO(data)) as source:
        source.load()
        image = ImageOps.exif_transpose(source).convert("RGBA")
        background = Image.new("RGBA", image.size, "white")
        return Image.alpha_composite(background, image).convert("RGB")


class Library:
    def __init__(self, root):
        self.lock = threading.RLock()
        self.additions = None
        self.arena_ids = set()
        self.root = Path(root).resolve()
        embeddings = json.loads((self.root / "embeddings.json").read_text())
        refs = json.loads((self.root / "references.json").read_text())
        self.refs = []
        self.files = {}
        self.urls = {}
        vectors = []
        image_root = (self.root / "images").resolve()
        for ref in refs:
            file = (image_root / ref["file"]).resolve()
            url = ref.get("url", "")
            parsed = urlparse(url)
            hosted = parsed.scheme == "https" and (parsed.hostname or "").endswith(".public.blob.vercel-storage.com")
            if (
                not file.is_relative_to(image_root)
                or (not file.is_file() and not hosted)
                or ref["file"] not in embeddings
            ):
                continue
            identity = str(
                ref.get("id") or hashlib.sha256(ref["file"].encode()).hexdigest()[:24]
            )
            if identity in self.files:
                raise ValueError("Duplicate reference ID in library.")
            if ref.get("arenaBlockId"):
                self.arena_ids.add(str(ref["arenaBlockId"]))
            vectors.append(normalize(embeddings[ref["file"]]))
            self.refs.append(
                {
                    "id": identity,
                    "name": ref.get("brand") or ref.get("figmaNodeName") or file.stem,
                    "cluster": ref.get("cluster", ""),
                }
            )
            self.files[identity] = file
            if hosted:
                self.urls[identity] = url
        if not vectors:
            raise ValueError("The library contains no images with CLIP embeddings.")
        self.matrix = np.stack(vectors)
        self.indices = {ref["id"]: i for i, ref in enumerate(self.refs)}

    def add(self, identity, name, source, vector):
        with self.lock:
            if identity in self.indices:
                return
            self.matrix = np.vstack((self.matrix, normalize(vector)))
            self.indices[identity] = len(self.refs)
            self.refs.append({"id": identity, "name": name, "cluster": source})
            self.files[identity] = None

    def image_bytes(self, identity):
        if self.files.get(identity) is None and self.additions:
            return self.additions.image_bytes(identity)
        if identity in self.urls:
            with urlopen(self.urls[identity], timeout=20) as response:
                data = response.read(20 * 1024 * 1024 + 1)
            if len(data) > 20 * 1024 * 1024:
                raise ValueError("Library image too large")
            return data
        return self.files[identity].read_bytes()

    def reference_vector(self, identity):
        with self.lock:
            return self.matrix[self.indices[identity]]

    def rank(self, vector, limit=24, exclude_id=None):
        with self.lock:
            scores = self.matrix @ normalize(vector)
            indices = [i for i in np.argsort(-scores, kind="stable")
                       if self.refs[i]["id"] != exclude_id][:limit]
            return [{**self.refs[i], "score": float(scores[i])} for i in indices]



class Encoder:
    def __init__(self):
        import torch
        import open_clip

        torch.set_num_threads(int(os.environ.get("TASTE_CPU_THREADS", "2")))
        self.torch = torch
        self.device = (
            "cuda"
            if torch.cuda.is_available()
            else "mps"
            if torch.backends.mps.is_available()
            else "cpu"
        )
        self.model, _, self.preprocess = open_clip.create_model_and_transforms(
            MODEL, pretrained=WEIGHTS, device=self.device
        )
        self.model.eval()
        self.tokenizer = open_clip.get_tokenizer(MODEL)
        self.lock = threading.Lock()

    def image(self, data):
        image = read_image(data)
        with self.lock, self.torch.inference_mode():
            tensor = self.preprocess(image).unsqueeze(0).to(self.device)
            return normalize(self.model.encode_image(tensor)[0].float().cpu().numpy())

    def text(self, texts):
        # CLIP accepts 77 tokens. Encode every chunk rather than silently dropping long layers.
        torch = self.torch
        chunks = []
        weights = []
        context = self.model.context_length
        for text in texts:
            tokens = self.tokenizer.encode(text)
            for start in range(0, len(tokens), context - 2):
                part = tokens[start : start + context - 2]
                row = [self.tokenizer.sot_token_id, *part, self.tokenizer.eot_token_id]
                chunks.append(row + [0] * (context - len(row)))
                weights.append(len(part))
        if not chunks:
            raise ValueError("Select text containing words.")
        features = []
        with self.lock, torch.inference_mode():
            for start in range(0, len(chunks), 32):
                batch = torch.tensor(chunks[start : start + 32], device=self.device)
                feature = self.model.encode_text(batch)
                feature = feature / feature.norm(dim=-1, keepdim=True)
                features.extend(feature.float().cpu().numpy())
        return normalize(np.average(features, axis=0, weights=weights))
