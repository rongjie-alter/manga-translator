"""Mock vision endpoint for exercising the translation pipeline.

Speaks both request shapes the app can send: plain OpenAI-compatible chat completions,
and Gemini's native `:generateContent` API. Implements just enough of each for the web
app: image parts, a model list, CORS preflight, structured JSON output, and a usage
block. The point is the failure modes -- rate limits, transient errors, dropped pages,
truncated output, safety blocks -- which are hard to trigger on purpose against a real
endpoint.

    py mock_server.py --port 8787 --rpm 6 --truncate 0.2 --block-rate 0.1 --seed 1

Then add an endpoint in the app's settings: `http://localhost:8787/v1` with kind
`openai`, or `http://localhost:8787/v1beta` with kind `gemini`.

The app sends one user message per batch, alternating a text part that marks each page

    [page 3] nippon1-3.jpeg

with the corresponding `image_url` part, and expects back a JSON object shaped like

    {"pages": [{"page": 3, "file": "nippon1-3.jpeg", "lines": [
        {"id": 1, "kind": "dialogue", "original": "…", "translation": "…"}
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
NATIVE_MODEL_PATH = re.compile(r"/models/([^:/]+):generateContent$")

MODEL_ID = "mock-translate-1"

# Enough variety that batching, ordering and glossary merging are visibly exercised.
SOURCE_LINES = [
    ("dialogue", "おはよう、今日もいい天気だね"),
    ("dialogue", "まったく、君はいつも遅刻ばかりだ"),
    ("dialogue", "そんなこと言われても困るよ！"),
    ("narration", "その日、彼女はまだ何も知らなかった"),
    ("sfx", "ドキドキ"),
    ("sfx", "ガタン"),
    ("dialogue", "……まさか、本当にやるつもりか？"),
    ("sign", "第一高等学校"),
    ("narration", "三年前のあの夏を、僕はまだ覚えている"),
    ("dialogue", "待って！行かないで！"),
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
    kind, original = SOURCE_LINES[rng.randrange(len(SOURCE_LINES))]
    out.append({
      "id": i + 1,
      "kind": kind,
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


def extract_pages_native(contents):
  """Pull `[page N] file` markers and count inline images from native `contents`."""
  pages = []
  images = 0
  for c in contents:
    if not isinstance(c, dict) or c.get("role") != "user":
      continue
    for part in c.get("parts", []):
      if not isinstance(part, dict):
        continue
      if "inlineData" in part:
        images += 1
      elif isinstance(part.get("text"), str):
        for num, name in PAGE_MARKER.findall(part["text"]):
          pages.append({"page": int(num), "file": name})
  return pages, images


def openai_response(model_id, content, finish_reason, prompt_tokens, completion_tokens,
                     reasoning=None, reasoning_tokens=0):
  message = {"role": "assistant", "content": content}
  usage = {
    "prompt_tokens": prompt_tokens,
    "completion_tokens": completion_tokens,
    "total_tokens": prompt_tokens + completion_tokens,
  }
  if reasoning:
    message["reasoning_content"] = reasoning
    usage["completion_tokens_details"] = {"reasoning_tokens": reasoning_tokens}
    usage["total_tokens"] += reasoning_tokens
  return {
    "id": f"chatcmpl-mock-{random.randint(1000, 9999)}",
    "object": "chat.completion",
    "created": int(time.time()),
    "model": model_id,
    "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
    "usage": usage,
  }


def gemini_response(model_id, parts, finish_reason, prompt_tokens, completion_tokens):
  """Native `generateContent` response shape."""
  return {
    "modelVersion": model_id,
    "candidates": [{
      "content": {"role": "model", "parts": parts},
      "finishReason": finish_reason,
    }],
    "usageMetadata": {
      "promptTokenCount": prompt_tokens,
      "candidatesTokenCount": completion_tokens,
      "totalTokenCount": prompt_tokens + completion_tokens,
    },
  }


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
    path = self.path.rstrip("/")
    if path.endswith("/chat/completions"):
      self._handle_completion(native=False)
      return
    match = NATIVE_MODEL_PATH.search(path)
    if match:
      self._handle_completion(native=True, model_id=match.group(1))
      return
    self._error(404, f"no route for {self.path}", "invalid_request_error")

  def _handle_completion(self, native, model_id=MODEL_ID):
    """Shared body for the OpenAI-compat `/chat/completions` route and the native
    Gemini `:generateContent` route, so the same failure injection (rate limits,
    truncation, safety blocks) exercises whichever request shape the app sends."""
    cfg = self.server.cfg
    length = int(self.headers.get("Content-Length", 0))
    raw = self.rfile.read(length).decode("utf-8") if length else "{}"

    key_header = "x-goog-api-key" if native else "Authorization"
    if cfg.require_key and not self.headers.get(key_header):
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

    if native:
      system = "\n".join(p.get("text", "") for p in req.get("systemInstruction", {}).get("parts", []))
      pages, image_count = extract_pages_native(req.get("contents", []))
      wants_thoughts = req.get("generationConfig", {}).get("thinkingConfig", {}).get("includeThoughts")
    else:
      messages = req.get("messages", [])
      system = "\n".join(
        m.get("content", "") for m in messages
        if m.get("role") == "system" and isinstance(m.get("content"), str)
      )
      pages, image_count = extract_pages(messages)
      model_id = req.get("model", MODEL_ID)
      wants_thoughts = req.get("extra_body", {}).get("google", {}).get("thinking_config", {}).get("include_thoughts")

    lang = detect_lang(system)

    if not pages:
      self._error(400, "no [page N] markers found in the request", "invalid_request_error")
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
      if native:
        self._send(200, gemini_response(model_id, [], "SAFETY", prompt_tokens, 0))
      else:
        self._send(200, openai_response(model_id, "", "content_filter", prompt_tokens, 0))
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

    finish = "STOP" if native else "stop"
    if cfg.truncate and random.random() < cfg.truncate:
      # Cut somewhere in the back half, so at least one page usually survives and the
      # app's tolerant parser has something to salvage.
      cut = random.randint(len(content) // 2, max(len(content) // 2, len(content) - 1))
      content = content[:cut]
      finish = "MAX_TOKENS" if native else "length"

    prompt_tokens = count_tokens(system) + image_count * 1032
    completion_tokens = count_tokens(content)

    # Mirrors Gemini's "include thoughts" response shape, so the per-call debug view
    # can be exercised without a real Gemini key.
    reasoning = None
    reasoning_tokens = 0
    if wants_thoughts:
      reasoning_tokens = max(1, completion_tokens // 4)
      reasoning = f"(mock reasoning) reading {len(pages)} page(s) into {lang}…"

    if native:
      parts = [{"text": content}]
      if reasoning:
        parts.append({"text": reasoning, "thought": True})
      self._send(200, gemini_response(model_id, parts, finish, prompt_tokens,
                                       completion_tokens + reasoning_tokens))
    else:
      self._send(200, openai_response(model_id, content, finish, prompt_tokens, completion_tokens,
                                       reasoning, reasoning_tokens))


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
  p.add_argument("--require-key", action="store_true",
                 help="401 without an Authorization or x-goog-api-key header")
  cfg = p.parse_args()

  if cfg.seed is not None:
    random.seed(cfg.seed)

  server = ThreadingHTTPServer((cfg.host, cfg.port), Handler)
  server.cfg = cfg
  server.limiter = Limiter(cfg.rpm)
  print(f"[mock] listening on http://{cfg.host}:{cfg.port}  model={MODEL_ID}")
  print(f"[mock] openai-compat: http://{cfg.host}:{cfg.port}/v1  "
        f"gemini-native: http://{cfg.host}:{cfg.port}/v1beta")
  print(f"[mock] rpm={cfg.rpm or 'unlimited'} fail={cfg.fail_rate} "
        f"page-drop={cfg.page_drop_rate} truncate={cfg.truncate} block={cfg.block_rate} "
        f"latency={cfg.latency_ms}ms")
  try:
    server.serve_forever()
  except KeyboardInterrupt:
    print("\n[mock] bye")


if __name__ == "__main__":
  main()
