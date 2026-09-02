"""Mock OpenAI-compatible vision endpoint for exercising the translation pipeline.

Implements just enough of the API for the web app: chat completions with image parts,
a model list, CORS preflight, structured JSON output, and a usage block. The point is
the failure modes -- rate limits, transient errors, dropped pages, truncated output,
safety blocks -- which are hard to trigger on purpose against a real endpoint.

    py mock_server.py --port 8787 --rpm 6 --truncate 0.2 --block-rate 0.1 --seed 1

Then add http://localhost:8787/v1 as an endpoint in the app's settings.

The app sends one user message per batch, alternating a text part that marks each page

    [page 3] nippon1-3.jpeg

with the corresponding `image_url` part, and expects back a JSON object shaped like

    {"pages": [{"page": 3, "file": "nippon1-3.jpeg", "lines": [
        {"id": 1, "kind": "dialogue", "speaker": "リナ", "original": "…", "translation": "…"}
     ]}],
     "glossary": [{"term": "リナ", "translation": "Rina", "note": "protagonist"}]}

Translations here are deterministic in the page's file name, so a test that runs the
same batch twice gets the same text and only the injected failures vary.
"""

import argparse
import hashlib
import json
import random
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PAGE_MARKER = re.compile(r"^\s*\[page (\d+)\]\s*(.+?)\s*$", re.MULTILINE)

MODEL_ID = "mock-translate-1"

# Enough variety that batching, ordering and glossary merging are visibly exercised.
SOURCE_LINES = [
    ("dialogue", "リナ", "おはよう、今日もいい天気だね"),
    ("dialogue", "ケンジ", "まったく、君はいつも遅刻ばかりだ"),
    ("dialogue", "リナ", "そんなこと言われても困るよ！"),
    ("narration", "", "その日、彼女はまだ何も知らなかった"),
    ("sfx", "", "ドキドキ"),
    ("sfx", "", "ガタン"),
    ("dialogue", "ケンジ", "……まさか、本当にやるつもりか？"),
    ("sign", "", "第一高等学校"),
    ("narration", "", "三年前のあの夏を、僕はまだ覚えている"),
    ("dialogue", "リナ", "待って！行かないで！"),
]

GLOSSARY_POOL = [
    {"term": "リナ", "translation": "Rina", "note": "protagonist"},
    {"term": "ケンジ", "translation": "Kenji", "note": "classmate"},
    {"term": "第一高等学校", "translation": "Daiichi High School", "note": "setting"},
]

LANG_TAG = {"en": "EN", "zh-hans": "简", "zh-hant": "繁"}


class Limiter:
  """Sliding-window request-per-minute counter, shared across threads."""

  def __init__(self, rpm):
    self.rpm = rpm
    self.hits = []
    self.lock = threading.Lock()

  def check(self):
    """Return seconds to wait, or 0 when the request is allowed."""
    if not self.rpm:
      return 0
    with self.lock:
      now = time.monotonic()
      self.hits = [t for t in self.hits if now - t < 60]
      if len(self.hits) >= self.rpm:
        return max(1, int(60 - (now - self.hits[0])) + 1)
      self.hits.append(now)
      return 0


def count_tokens(s):
  """Rough CJK-aware token count, close enough to make the app's estimate meaningful."""
  cjk = sum(1 for c in s if ord(c) > 0x2E80)
  return cjk + max(1, (len(s) - cjk) // 4)


def seed_of(text):
  """Stable integer derived from a string, so a given page always yields the same lines."""
  return int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:8], 16)


def detect_lang(prompt):
  low = prompt.lower()
  for key, lang in (("simplified", "zh-hans"), ("traditional", "zh-hant"), ("english", "en")):
    if key in low:
      return lang
  return "en"


def lines_for_page(file_name, lang):
  """Deterministic stand-in for OCR plus translation of one page."""
  rng = random.Random(seed_of(file_name))
  count = rng.randint(2, 6)
  tag = LANG_TAG.get(lang, "TL")
  out = []
  for i in range(count):
    kind, speaker, original = SOURCE_LINES[rng.randrange(len(SOURCE_LINES))]
    out.append({
      "id": i + 1,
      "kind": kind,
      "speaker": speaker,
      "original": original,
      "translation": f"[{tag}] {file_name} line {i + 1}",
    })
  return out


def glossary_for(files):
  """A couple of terms, as a real run would accumulate them page by page."""
  rng = random.Random(seed_of("|".join(files)))
  return rng.sample(GLOSSARY_POOL, rng.randint(0, len(GLOSSARY_POOL)))


def extract_pages(messages):
  """Pull `[page N] file` markers and count the images that came with them."""
  pages = []
  images = 0
  for m in messages:
    if m.get("role") != "user":
      continue
    content = m.get("content")
    parts = content if isinstance(content, list) else [{"type": "text", "text": content or ""}]
    for part in parts:
      if not isinstance(part, dict):
        continue
      if part.get("type") == "image_url":
        images += 1
      elif part.get("type") == "text":
        for num, name in PAGE_MARKER.findall(part.get("text") or ""):
          pages.append({"page": int(num), "file": name})
  return pages, images


class Handler(BaseHTTPRequestHandler):
  protocol_version = "HTTP/1.1"

  def log_message(self, fmt, *a):
    print(f"[mock] {self.address_string()} {fmt % a}")

  def _cors(self):
    self.send_header("Access-Control-Allow-Origin", "*")
    self.send_header("Access-Control-Allow-Headers", "*")
    self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    # Without this the browser hides Retry-After from cross-origin JS, and the app
    # silently falls back to its own backoff instead of the wait the server asked for.
    self.send_header("Access-Control-Expose-Headers", "Retry-After")
    self.send_header("Access-Control-Max-Age", "86400")

  def _send(self, code, obj, extra_headers=()):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    self.send_response(code)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Content-Length", str(len(body)))
    for k, v in extra_headers:
      self.send_header(k, v)
    self._cors()
    self.end_headers()
    self.wfile.write(body)

  def _error(self, code, message, kind, extra_headers=()):
    self._send(code, {"error": {"message": message, "type": kind, "code": code}}, extra_headers)

  def do_OPTIONS(self):
    self.send_response(204)
    self.send_header("Content-Length", "0")
    self._cors()
    self.end_headers()

  def do_GET(self):
    if self.path.rstrip("/").endswith("/models"):
      self._send(200, {
        "object": "list",
        "data": [{"id": MODEL_ID, "object": "model", "owned_by": "mock"}],
      })
      return
    self._error(404, f"no route for {self.path}", "invalid_request_error")

  def do_POST(self):
    if not self.path.rstrip("/").endswith("/chat/completions"):
      self._error(404, f"no route for {self.path}", "invalid_request_error")
      return

    cfg = self.server.cfg
    length = int(self.headers.get("Content-Length", 0))
    raw = self.rfile.read(length).decode("utf-8") if length else "{}"

    if cfg.require_key and not self.headers.get("Authorization"):
      self._error(401, "missing api key", "authentication_error")
      return

    if cfg.max_bytes and length > cfg.max_bytes:
      self._error(413, f"request of {length} bytes exceeds the {cfg.max_bytes} byte limit",
                  "invalid_request_error")
      return

    wait = self.server.limiter.check()
    if wait:
      self._error(429, f"rate limit exceeded, retry in {wait}s", "rate_limit_error",
                  [("Retry-After", str(wait))])
      return

    if cfg.fail_rate and random.random() < cfg.fail_rate:
      self._error(503, "mock transient failure", "server_error")
      return

    try:
      req = json.loads(raw)
    except json.JSONDecodeError as e:
      self._error(400, f"bad json: {e}", "invalid_request_error")
      return

    messages = req.get("messages", [])
    system = "\n".join(
      m.get("content", "") for m in messages
      if m.get("role") == "system" and isinstance(m.get("content"), str)
    )
    lang = detect_lang(system)
    pages, image_count = extract_pages(messages)

    if not pages:
      self._error(400, "no [page N] markers found in the user message",
                  "invalid_request_error")
      return
    if image_count < len(pages):
      self._error(400, f"{len(pages)} page markers but only {image_count} images",
                  "invalid_request_error")
      return

    if cfg.latency_ms:
      time.sleep(cfg.latency_ms / 1000.0)

    # A safety block returns a well-formed response with nothing in it, which is the
    # shape the app has to distinguish from a merely empty page.
    if cfg.block_rate and random.random() < cfg.block_rate:
      prompt_tokens = count_tokens(system) + image_count * 1032
      self._send(200, {
        "id": f"chatcmpl-mock-{random.randint(1000, 9999)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": req.get("model", MODEL_ID),
        "choices": [{
          "index": 0,
          "message": {"role": "assistant", "content": ""},
          "finish_reason": "content_filter",
        }],
        "usage": {
          "prompt_tokens": prompt_tokens,
          "completion_tokens": 0,
          "total_tokens": prompt_tokens,
        },
      })
      return

    kept = [p for p in pages
            if not (cfg.page_drop_rate and random.random() < cfg.page_drop_rate)]

    payload = {
      "pages": [
        {"page": p["page"], "file": p["file"], "lines": lines_for_page(p["file"], lang)}
        for p in kept
      ],
      "glossary": glossary_for([p["file"] for p in kept]),
    }
    content = json.dumps(payload, ensure_ascii=False, indent=2)

    finish = "stop"
    if cfg.truncate and random.random() < cfg.truncate:
      # Cut somewhere in the back half, so at least one page usually survives and the
      # app's tolerant parser has something to salvage.
      cut = random.randint(len(content) // 2, max(len(content) // 2, len(content) - 1))
      content = content[:cut]
      finish = "length"

    prompt_tokens = count_tokens(system) + image_count * 1032
    completion_tokens = count_tokens(content)

    message = {"role": "assistant", "content": content}
    usage = {
      "prompt_tokens": prompt_tokens,
      "completion_tokens": completion_tokens,
      "total_tokens": prompt_tokens + completion_tokens,
    }
    # Mirrors Gemini's OpenAI-compat "include thoughts" response shape, so the
    # per-call debug view can be exercised without a real Gemini key.
    thinking_config = req.get("extra_body", {}).get("google", {}).get("thinking_config", {})
    if thinking_config.get("include_thoughts"):
      reasoning_tokens = max(1, completion_tokens // 4)
      message["reasoning_content"] = (
        f"(mock reasoning) reading {len(pages)} page(s) into {lang}…"
      )
      usage["completion_tokens_details"] = {"reasoning_tokens": reasoning_tokens}
      usage["total_tokens"] += reasoning_tokens

    self._send(200, {
      "id": f"chatcmpl-mock-{random.randint(1000, 9999)}",
      "object": "chat.completion",
      "created": int(time.time()),
      "model": req.get("model", MODEL_ID),
      "choices": [{"index": 0, "message": message, "finish_reason": finish}],
      "usage": usage,
    })


def main():
  p = argparse.ArgumentParser(description=__doc__,
                              formatter_class=argparse.RawDescriptionHelpFormatter)
  p.add_argument("--port", type=int, default=8787)
  p.add_argument("--host", default="127.0.0.1")
  p.add_argument("--rpm", type=int, default=0, help="requests per minute before 429 (0 = no limit)")
  p.add_argument("--fail-rate", type=float, default=0.0, help="chance of a 503")
  p.add_argument("--page-drop-rate", type=float, default=0.0,
                 help="chance of omitting each requested page from the response")
  p.add_argument("--truncate", type=float, default=0.0, help="chance of a cut-off response")
  p.add_argument("--block-rate", type=float, default=0.0,
                 help="chance of an empty content_filter response")
  p.add_argument("--latency-ms", type=int, default=0)
  p.add_argument("--max-bytes", type=int, default=0,
                 help="reject requests larger than this with a 413 (0 = no limit)")
  p.add_argument("--seed", type=int, default=None, help="make the failure injection reproducible")
  p.add_argument("--require-key", action="store_true", help="401 without an Authorization header")
  cfg = p.parse_args()

  if cfg.seed is not None:
    random.seed(cfg.seed)

  server = ThreadingHTTPServer((cfg.host, cfg.port), Handler)
  server.cfg = cfg
  server.limiter = Limiter(cfg.rpm)
  print(f"[mock] listening on http://{cfg.host}:{cfg.port}/v1  model={MODEL_ID}")
  print(f"[mock] rpm={cfg.rpm or 'unlimited'} fail={cfg.fail_rate} "
        f"page-drop={cfg.page_drop_rate} truncate={cfg.truncate} block={cfg.block_rate} "
        f"latency={cfg.latency_ms}ms")
  try:
    server.serve_forever()
  except KeyboardInterrupt:
    print("\n[mock] bye")


if __name__ == "__main__":
  main()
