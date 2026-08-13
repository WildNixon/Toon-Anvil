#!/usr/bin/env python3
"""What the connectors actually cost, recorded rather than guessed.

The catalogue quotes an estimate before you spend anything. This records what
was really spent afterwards, and the two are kept apart on purpose: an
estimate that quietly becomes a fact is how a price table stays wrong for a
year. Every row says which it is.

Every provider already hands back its token counts and the app used to throw
them away, so the measured figures cost nothing extra to collect - OpenAI as
`usage.prompt_tokens`, Anthropic as `usage.input_tokens`, Ollama as
`prompt_eval_count`. Where a provider says nothing, the row falls back to the
catalogue estimate and is marked `measured: false`.

The ledger is append-only and lives in `data/spend.jsonl`, which is
gitignored: it is a record of your own usage and belongs to you.

Stdlib only.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEDGER = ROOT / "data" / "spend.jsonl"

# The cap, in US cents. Absent means no cap - which is the default, because a
# tool that silently stops working is worse than one that spends what you told
# it it could.
BUDGET_ENV = "TOON_ANVIL_BUDGET_CENTS"


def budget_cents() -> float | None:
    """The cap, from the environment or secrets.json. None means uncapped."""
    raw = os.environ.get(BUDGET_ENV)
    if raw is None:
        try:
            import connectors                              # noqa: PLC0415
            raw = connectors.setting(BUDGET_ENV)
        except Exception:                                  # noqa: BLE001
            raw = None
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return None
    return val if val > 0 else None


def _cost_cents(kind: str, usage: dict, price: dict) -> float | None:
    """Real cost from real token counts. None when it cannot be worked out."""
    if not isinstance(price, dict):
        return None
    if kind == "llm":
        i, o = usage.get("inTokens"), usage.get("outTokens")
        if not isinstance(i, int) or not isinstance(o, int):
            return None
        if "inPerMTok" not in price:
            return None
        return (i / 1e6) * price["inPerMTok"] + (o / 1e6) * price["outPerMTok"]
    if kind == "image" and "perImage" in price:
        return float(price["perImage"])
    if kind == "sfx":
        if "perSecond" in price and isinstance(usage.get("seconds"), (int, float)):
            return usage["seconds"] * price["perSecond"]
        if "perSearch" in price:
            return float(price["perSearch"])
    return None


def record(*, cap_id, provider, model, kind, usage, prices, est_cents=None,
           seat="dm") -> dict:
    """Append one row. Returns it, so a caller can show the cost it just paid.

    Never raises: a ledger that can take the app down is worse than one with a
    gap in it, and the thing it is recording already happened.
    """
    usage = usage or {}
    measured = bool(usage.get("measured"))
    cents = _cost_cents(kind, usage, prices.get(provider, {})) if measured else None
    row = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "capability": cap_id,
        "provider": provider,
        "model": model,
        "kind": kind,
        "inTokens": usage.get("inTokens"),
        "outTokens": usage.get("outTokens"),
        # measured: these numbers came from the provider. Otherwise the row
        # carries the catalogue's guess, and says so.
        "measured": measured,
        "cents": cents if cents is not None else est_cents,
        "centsAreEstimate": cents is None,
        "seat": seat,
    }
    try:
        LEDGER.parent.mkdir(parents=True, exist_ok=True)
        with LEDGER.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
    except OSError:
        row["unrecorded"] = True
    return row


def rows(limit: int = 2000) -> list[dict]:
    if not LEDGER.exists():
        return []
    out = []
    try:
        for line in LEDGER.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return out[-limit:]


def summary() -> dict:
    """Totals, and how much of the total is guesswork.

    `estimatedShare` is the honest caveat on the headline: if most rows came
    from a provider that reports no usage, "you have spent $2" is a sentence
    with a lot of shrugging in it.
    """
    all_rows = rows()
    total = sum(r.get("cents") or 0 for r in all_rows)
    guessed = sum(r.get("cents") or 0 for r in all_rows if r.get("centsAreEstimate"))
    by_cap: dict[str, dict] = {}
    for r in all_rows:
        c = by_cap.setdefault(r.get("capability") or "(unnamed)",
                              {"calls": 0, "cents": 0.0})
        c["calls"] += 1
        c["cents"] += r.get("cents") or 0
    cap = budget_cents()
    return {
        "calls": len(all_rows),
        "cents": round(total, 4),
        "estimatedCents": round(guessed, 4),
        "estimatedShare": round(guessed / total, 3) if total else 0,
        "byCapability": by_cap,
        "budgetCents": cap,
        "overBudget": bool(cap is not None and total >= cap),
        "ledger": str(LEDGER),
    }


def check_budget() -> dict | None:
    """A refusal to hand back, or None to proceed.

    Checked BEFORE a call, so the cap is a cap rather than a post-mortem.
    """
    cap = budget_cents()
    if cap is None:
        return None
    spent = sum(r.get("cents") or 0 for r in rows())
    if spent < cap:
        return None
    # Formatted to the value rather than to a fixed width: a 0.5c cap printed
    # as "0c" reads like a bug report waiting to happen.
    fmt = (lambda v: f"{v:.0f}c" if v >= 10 else f"{v:.2f}c")
    return {"ok": False, "overBudget": True,
            "budgetCents": cap, "spentCents": round(spent, 4),
            "error": f"your budget of {fmt(cap)} is used up ({fmt(spent)} "
                     f"spent). Raise {BUDGET_ENV} or clear {LEDGER.name} "
                     f"to carry on."}


def selftest() -> int:
    """Assert the two things the browser gym cannot reach.

    The gym runs in a browser, so the clamp and the ledger arithmetic - both
    pure Python - would otherwise be verified once by hand and never again.
    A guard that only ran the day it was written is not a guard.
    """
    import importlib.util                                     # noqa: PLC0415
    import sys                                                # noqa: PLC0415
    fails = []

    def check(cond, label):
        print(("  ok   " if cond else "  FAIL ") + label)
        if not cond:
            fails.append(label)

    # --- the clamp -------------------------------------------------------
    spec = importlib.util.spec_from_file_location("_srv", ROOT / "serve.py")
    srv = importlib.util.module_from_spec(spec)
    sys.modules["_srv"] = srv
    spec.loader.exec_module(srv)
    c = srv._clamp                                            # noqa: SLF001
    check(c(999999, 1, 2000, 400) == 2000, "an absurd maxTokens hits the ceiling")
    check(c(-5, 1, 2000, 400) == 1, "a negative hits the floor")
    check(c("abc", 1, 2000, 400) == 400, "junk falls back to the default")
    check(c(None, 1, 2000, 400) == 400, "absent falls back to the default")
    check(c(float("nan"), 1, 2000, 400) == 400, "NaN falls back to the default")
    check(c(350, 1, 2000, 400) == 350, "a reasonable value is left alone")

    # --- the ledger ------------------------------------------------------
    prices = {"openai": {"inPerMTok": 15, "outPerMTok": 60}}
    measured = _cost_cents("llm", {"inTokens": 1_000_000,
                                   "outTokens": 1_000_000}, prices["openai"])
    check(measured == 75, f"a million each way costs in+out (got {measured})")
    check(_cost_cents("llm", {"measured": False}, prices["openai"]) is None,
          "no token counts means no cost claim, not a zero")
    check(_cost_cents("llm", {"inTokens": 0, "outTokens": 0},
                      prices["openai"]) == 0,
          "but a genuine zero stays zero")
    print()
    print("spend selftest:", "PASS" if not fails else f"{len(fails)} FAILED")
    return 1 if fails else 0


if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        raise SystemExit(selftest())
    print(json.dumps(summary(), indent=2))
