"""Optional outbound connectors: LLM, images, sound.

    Nothing here is required. Toon Anvil is an offline tool that can phone out
    if you give it somewhere to phone.

KEYS
----
No key ships with this project and none is ever asked for by the app. A key is
read from ONE of:

    1. an environment variable, or
    2. secrets.json in the project root, which .gitignore excludes.

The browser never receives a key. The page calls the local server, the server
calls the provider. That removes two standard failure modes at once: a key
sitting in localStorage where any injected script can read it, and provider
CORS refusing a request that originates from a browser.

`describe()` reports only WHETHER a key is present, never its value, so the
Settings screen can say "configured" without the key ever crossing the wire.

PROVIDERS
---------
    llm     anthropic | openai | ollama (local, no key)
    image   local Stable Diffusion (Automatic1111 / ComfyUI compatible)
    sfx     elevenlabs (generate) | freesound (search, CC-licensed)

Local providers are listed first everywhere because they cost nothing, need no
key, and work on a train - which is the rest of this project's posture too.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

try:
    import truststore

    truststore.inject_into_ssl()
except ImportError:                                        # pragma: no cover
    pass

ROOT = Path(__file__).resolve().parent.parent
SECRETS = ROOT / "secrets.json"
# What a key actually unlocks, and roughly what it costs. Under app/
# because the browser has to fetch the same file this module reads -
# two copies of "what is on offer" would drift, and the one the user
# reads is the one that matters.
CAPABILITIES = ROOT / "app" / "data" / "connector-capabilities.json"

TIMEOUT = 120


# --------------------------------------------------------------------------
# secrets
# --------------------------------------------------------------------------

def _secrets() -> dict:
    """Read secrets.json, if the user made one. Never cached: editing it should
    take effect without restarting the server."""
    if not SECRETS.exists():
        return {}
    try:
        data = json.loads(SECRETS.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def catalogue() -> dict:
    """The capability map. Never cached, for the same reason secrets are
    not: editing the file should take effect without a restart."""
    try:
        data = json.loads(CAPABILITIES.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        # A missing or broken catalogue must not take the app down - it
        # is a menu, not a dependency. The UI shows providers alone.
        return {}


def estimate_cents(cap: dict, provider: str, prices: dict) -> float | None:
    """Roughly what one use of this capability costs on this provider.

    None means "we cannot say", which is a real answer and must never be
    rendered as 0. A zero here is a CLAIM that something is free, and
    only a local provider gets to make it.
    """
    p = prices.get(provider)
    if not isinstance(p, dict):
        return None
    est = cap.get("est") or {}
    if cap.get("kind") == "llm":
        if "inPerMTok" not in p:
            return None
        return ((est.get("inTokens", 0) / 1e6) * p["inPerMTok"]
                + (est.get("outTokens", 0) / 1e6) * p["outPerMTok"])
    if cap.get("kind") == "image" and "perImage" in p:
        return est.get("images", 1) * p["perImage"]
    if cap.get("kind") == "sfx":
        if "perSecond" in p:
            return est.get("seconds", 0) * p["perSecond"]
        if "perSearch" in p:
            return p["perSearch"]
    return None


def key_for(name: str) -> str | None:
    """A key by name, from the environment first, then secrets.json."""
    env = os.environ.get(name)
    if env and env.strip():
        return env.strip()
    val = _secrets().get(name)
    return val.strip() if isinstance(val, str) and val.strip() else None


def setting(name: str, default: str | None = None) -> str | None:
    """A non-secret setting - a base URL, a model name."""
    return os.environ.get(name) or _secrets().get(name) or default


# --------------------------------------------------------------------------
# discovery
# --------------------------------------------------------------------------

def _ollama_base() -> str:
    return setting("OLLAMA_URL", "http://127.0.0.1:11434")


def _sd_base() -> str:
    return setting("SD_URL", "http://127.0.0.1:7860")


def _reachable(url: str, timeout: float = 1.5) -> bool:
    """Is a LOCAL service up? Only used for local endpoints, where a fast
    negative is better than making the user guess why nothing happens."""
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout):
            return True
    except Exception:                                      # noqa: BLE001
        return False


def describe() -> dict:
    """What is configured. Reports presence only - never a key's value."""
    providers = {
        "ollama": {
            "label": "Local model (Ollama)",
            "kind": "llm",
            "configured": _reachable(f"{_ollama_base()}/api/tags"),
            "note": f"No key needed. Looking at {_ollama_base()} - start Ollama "
                    "and pull a model to enable this.",
        },
        "anthropic": {
            "label": "Anthropic (Claude)",
            "kind": "llm",
            "configured": bool(key_for("ANTHROPIC_API_KEY")),
            "note": "Set ANTHROPIC_API_KEY in your environment or secrets.json.",
        },
        "openai": {
            "label": "OpenAI",
            "kind": "llm",
            "configured": bool(key_for("OPENAI_API_KEY")),
            "note": "Set OPENAI_API_KEY in your environment or secrets.json.",
        },
        "sd-local": {
            "label": "Local Stable Diffusion",
            "kind": "image",
            "configured": _reachable(f"{_sd_base()}/sdapi/v1/sd-models"),
            "note": f"No key needed. Looking at {_sd_base()} (Automatic1111 API). "
                    "Hosted image providers are deliberately not wired up.",
        },
        "elevenlabs": {
            "label": "ElevenLabs (sound effects)",
            "kind": "sfx",
            "configured": bool(key_for("ELEVENLABS_API_KEY")),
            "note": "Set ELEVENLABS_API_KEY. Your own key - none ships with "
                    "this project.",
        },
        "freesound": {
            "label": "Freesound (search)",
            "kind": "sfx",
            "configured": bool(key_for("FREESOUND_API_KEY")),
            "note": "Set FREESOUND_API_KEY. Results are CC-licensed and the "
                    "attribution comes back with them.",
        },
    }
    # The catalogue rides along, with every cost worked out per provider, so
    # the screen can answer "what would this key give me, and what would it
    # cost" in one fetch and without a second opinion about either.
    cat = catalogue()
    prices = cat.get("prices", {})
    caps = []
    for cap in cat.get("capabilities", []):
        usable = [p for p in cap.get("providers", []) if p in providers]
        caps.append({
            **cap,
            "providers": usable,
            # Only providers that are actually set up right now. This is what
            # turns the catalogue from a brochure into a status board.
            "readyProviders": [p for p in usable if providers[p]["configured"]],
            "estCents": {p: estimate_cents(cap, p, prices) for p in usable},
        })

    # What each key would unlock, counted from the catalogue rather than
    # asserted in prose - so adding a capability updates the sales pitch.
    for pid, prov in providers.items():
        # `internal` rows spend real money and belong in the catalogue, but
        # counting them here would pad the pitch: nobody adds a key in order
        # to unlock the button that checks the key.
        mine = [c for c in caps
                if pid in c["providers"] and not c.get("internal")]
        prov["unlocks"] = [c["id"] for c in mine]
        prov["unlocksBuilt"] = [c["id"] for c in mine if c.get("status") == "built"]
        prov["free"] = all(
            (prices.get(pid) or {}).get(k, 1) == 0
            for k in ("inPerMTok", "perImage", "perSearch", "perSecond")
            if k in (prices.get(pid) or {})
        ) and bool(prices.get(pid))

    return {
        "available": True,
        "secretsFile": str(SECRETS),
        "secretsFileExists": SECRETS.exists(),
        "providers": providers,
        "anyConfigured": any(p["configured"] for p in providers.values()),
        "capabilities": caps,
        "prices": prices,
        "pricesAsOf": cat.get("pricesAsOf"),
        "priceNote": cat.get("priceNote"),
        "notOffered": cat.get("notOffered") or cat.get("_notOffered"),
    }


LOCAL_LLM = ("ollama",)


def _usage(in_tok, out_tok) -> dict:
    """What a call actually used.

    Every provider already tells us this and the code used to throw it away -
    OpenAI as prompt_tokens, Anthropic as input_tokens, Ollama as
    prompt_eval_count. `measured` says whether these are real numbers or a
    blank, so an estimate is never quietly promoted to a fact.
    """
    ok = isinstance(in_tok, int) and isinstance(out_tok, int)
    return {"inTokens": in_tok if ok else None,
            "outTokens": out_tok if ok else None,
            "measured": ok}


def _pick_llm(preferred: str | None, local_only: bool = False) -> str | None:
    """Local first: it costs nothing and needs no key.

    `local_only` is the privacy rule with teeth. The README promises your
    homebrew "is never uploaded anywhere", and a capability carrying your own
    prose - lore, book extracts, chronicle text - would break that the moment
    it reached a hosted model. Those capabilities pass local_only=True, and if
    no local model is running the call is REFUSED rather than quietly sent
    somewhere else. A promise enforced in code beats one kept in a docstring.
    """
    caps = describe()["providers"]
    allowed = LOCAL_LLM if local_only else ("ollama", "anthropic", "openai")
    if preferred and preferred in allowed and caps.get(preferred, {}).get("configured"):
        return preferred
    for name in allowed:
        if caps.get(name, {}).get("configured"):
            return name
    return None


def capability(cap_id: str | None) -> dict | None:
    """One catalogue row.

    Three distinct answers, and keeping them apart is the whole point:

      `{}`   the call named no capability - a bare transport probe, which
             carries nothing of yours by construction.
      row    the call named one, and here is what the catalogue says about it.
      None   the call named one that does not exist.

    That last case used to return `{}` as well, which quietly made a typo the
    MOST permissive path in the file: an unknown id has no `contentClass`, so
    a misspelt `session_recap` would have sent the user's own writing to a
    hosted provider. A safety rule that a spelling mistake can switch off is
    not a safety rule.
    """
    if not cap_id:
        return {}
    for c in catalogue().get("capabilities", []):
        if c.get("id") == cap_id:
            return c
    return None


# --------------------------------------------------------------------------
# http
# --------------------------------------------------------------------------

def _post_json(url: str, payload: dict, headers: dict, timeout: int = TIMEOUT) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json", **headers,
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# --------------------------------------------------------------------------
# text
# --------------------------------------------------------------------------

def generate_text(prompt: str, system: str | None = None, provider: str | None = None,
                  max_tokens: int = 400, temperature: float = 0.9,
                  cap_id: str | None = None) -> dict:
    """Ask a model for prose. Returns {ok, text, usage} or {ok: False, error}.

    `cap_id` names the catalogue capability being bought. It decides two
    things: whether your content may leave the machine, and what the spend
    ledger records the money against. Naming nothing is allowed - a transport
    probe carries nothing of yours. Naming something that is not in the
    catalogue is refused, because the alternative is a typo choosing the
    privacy policy.
    """
    cap = capability(cap_id)
    if cap is None:
        return {"ok": False, "capability": cap_id,
                "error": f"'{cap_id}' is not a capability in the catalogue, so "
                         "there is no way to know whether it may leave this "
                         "machine or what it should cost. Refusing rather than "
                         "guessing."}
    local_only = cap.get("contentClass") == "user"
    chosen = _pick_llm(provider, local_only=local_only)
    if not chosen and local_only:
        # Deliberately NOT falling back to a hosted model. This capability
        # carries the user's own writing, and the whole point of the rule is
        # that it is a refusal rather than a silent upload.
        return {"ok": False, "contentClass": "user", "capability": cap_id,
                "error": "this one sends your own writing, so it only runs on "
                         "a local model. Start Ollama and pull a model - or "
                         "pick a capability that does not carry your content."}
    if not chosen:
        return {"ok": False,
                "error": "no language model is configured. Start Ollama for a "
                         "free local one, or add a key in secrets.json."}
    try:
        if chosen == "ollama":
            model = setting("OLLAMA_MODEL", "llama3.2")
            data = _post_json(f"{_ollama_base()}/api/generate", {
                "model": model,
                "prompt": f"{system}\n\n{prompt}" if system else prompt,
                "stream": False,
                "options": {"temperature": temperature, "num_predict": max_tokens},
            }, {})
            return {"ok": True, "provider": chosen, "model": model,
                    "capability": cap_id,
                    "text": (data.get("response") or "").strip(),
                    # Ollama counts too, and it costs nothing - recording it
                    # keeps the ledger's arithmetic honest across providers
                    # instead of only where money changed hands.
                    "usage": _usage(data.get("prompt_eval_count"),
                                    data.get("eval_count"))}

        if chosen == "anthropic":
            model = setting("ANTHROPIC_MODEL", "claude-sonnet-4-5")
            payload = {
                "model": model, "max_tokens": max_tokens,
                "temperature": temperature,
                "messages": [{"role": "user", "content": prompt}],
            }
            if system:
                payload["system"] = system
            data = _post_json("https://api.anthropic.com/v1/messages", payload, {
                "x-api-key": key_for("ANTHROPIC_API_KEY") or "",
                "anthropic-version": "2023-06-01",
            })
            parts = [b.get("text", "") for b in data.get("content", [])
                     if b.get("type") == "text"]
            u = data.get("usage") or {}
            return {"ok": True, "provider": chosen, "model": model,
                    "capability": cap_id, "text": "".join(parts).strip(),
                    "usage": _usage(u.get("input_tokens"), u.get("output_tokens"))}

        model = setting("OPENAI_MODEL", "gpt-4o-mini")
        messages = ([{"role": "system", "content": system}] if system else []) + [
            {"role": "user", "content": prompt}]
        data = _post_json(
            f"{setting('OPENAI_URL', 'https://api.openai.com/v1')}/chat/completions",
            {"model": model, "messages": messages, "max_tokens": max_tokens,
             "temperature": temperature},
            {"Authorization": f"Bearer {key_for('OPENAI_API_KEY') or ''}"})
        u = data.get("usage") or {}
        return {"ok": True, "provider": chosen, "model": model,
                "capability": cap_id,
                "text": (data["choices"][0]["message"]["content"] or "").strip(),
                "usage": _usage(u.get("prompt_tokens"), u.get("completion_tokens"))}

    except urllib.error.HTTPError as exc:
        # Report the status, never the request - a body can echo a key back.
        return {"ok": False, "provider": chosen,
                "error": f"{chosen} refused the request ({exc.code})"}
    except Exception as exc:                               # noqa: BLE001
        return {"ok": False, "provider": chosen,
                "error": f"{type(exc).__name__}: {exc}"}


# --------------------------------------------------------------------------
# images
# --------------------------------------------------------------------------

def generate_image(prompt: str, size: str = "512x512", provider: str | None = None) -> dict:
    """Local Stable Diffusion only, on purpose. Hosted image APIs are the
    easiest way to spend real money by accident, and this tool otherwise costs
    nothing to run - so connecting one is left as the user's decision."""
    if provider and provider != "sd-local":
        return {"ok": False,
                "error": f"{provider} is not wired up. Only a local Stable "
                         "Diffusion endpoint ships enabled."}
    if not _reachable(f"{_sd_base()}/sdapi/v1/sd-models"):
        return {"ok": False,
                "error": f"no Stable Diffusion API at {_sd_base()}. Start "
                         "Automatic1111 with --api, or set SD_URL."}
    try:
        w, _, h = size.partition("x")
        data = _post_json(f"{_sd_base()}/sdapi/v1/txt2img", {
            "prompt": prompt, "steps": 20,
            "width": int(w or 512), "height": int(h or 512),
        }, {}, timeout=300)
        images = data.get("images") or []
        if not images:
            return {"ok": False, "error": "the endpoint returned no image"}
        return {"ok": True, "provider": "sd-local",
                "image": f"data:image/png;base64,{images[0]}"}
    except Exception as exc:                               # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


# --------------------------------------------------------------------------
# sound
# --------------------------------------------------------------------------

def search_sounds(query: str, limit: int = 8) -> dict:
    """Freesound search. Attribution travels WITH the result - a CC-BY sound
    used without credit is a licence breach, and the app should not make that
    easy to do by accident."""
    key = key_for("FREESOUND_API_KEY")
    if not key:
        return {"ok": False,
                "error": "no Freesound key. Get a free one at freesound.org and "
                         "set FREESOUND_API_KEY."}
    try:
        from urllib.parse import quote                     # noqa: PLC0415
        url = (f"https://freesound.org/apiv2/search/text/?query={quote(query)}"
               f"&page_size={int(limit)}"
               "&fields=id,name,license,username,previews,duration"
               f"&token={quote(key)}")
        with urllib.request.urlopen(url, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return {"ok": True, "provider": "freesound", "results": [
            {"id": r.get("id"), "name": r.get("name"),
             "seconds": round(r.get("duration") or 0, 1),
             "licence": r.get("license"),
             "by": r.get("username"),
             "attribution": f"\"{r.get('name')}\" by {r.get('username')} "
                            f"({r.get('license')})",
             "preview": (r.get("previews") or {}).get("preview-hq-mp3")}
            for r in data.get("results", [])
        ]}
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": f"Freesound refused the request ({exc.code})"}
    except Exception as exc:                               # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def generate_sound(prompt: str, seconds: float = 4.0) -> dict:
    """ElevenLabs sound-effect generation, behind the user's own key."""
    key = key_for("ELEVENLABS_API_KEY")
    if not key:
        return {"ok": False,
                "error": "no ElevenLabs key. This project ships without one - "
                         "set ELEVENLABS_API_KEY to use your own."}
    try:
        import base64                                      # noqa: PLC0415
        body = json.dumps({"text": prompt,
                           "duration_seconds": max(0.5, min(22.0, float(seconds)))}
                          ).encode("utf-8")
        req = urllib.request.Request(
            "https://api.elevenlabs.io/v1/sound-generation",
            data=body, method="POST",
            headers={"Content-Type": "application/json", "xi-api-key": key})
        with urllib.request.urlopen(req, timeout=120) as resp:
            audio = resp.read()
        return {"ok": True, "provider": "elevenlabs",
                "audio": "data:audio/mpeg;base64,"
                         + base64.b64encode(audio).decode("ascii")}
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": f"ElevenLabs refused the request ({exc.code})"}
    except Exception as exc:                               # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
