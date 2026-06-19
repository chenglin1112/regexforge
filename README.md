<div align="center">

# 🔧 RegexForge

### *the pattern that proves itself*

**Describe a regex in plain English. RegexForge writes it, runs it against your real lines with a deterministic engine, and lights up exactly what matched — then hands you a regex you can paste with confidence.**

`Anna App` · `Executa (Python re)` · `keyless host LLM` · `schema‑2 UI bundle`

</div>

---

An [Anna](https://anna.partners) App built for the **Anna AI‑Native App Hackathon** ([DoraHacks #2204](https://dorahacks.io/hackathon/2204/detail)).

📹 **Demo:** a ~1‑minute walkthrough is included as [`regexforge-demo.mov`](regexforge-demo.mov).

> **The model proposes; the engine proves.**
> Every highlight you see and every number in the match‑ratio ring is computed by Python's standard‑library `re` engine — **never by the model**. So a match is *real*, not hallucinated. That's the whole idea: a regex you can trust, because the engine verified it on *your* data.

## What it does

Writing a throwaway regex against messy logs, JSON, or CSV is a chore everybody does and nobody trusts. RegexForge turns it into one assistant‑driven interaction:

1. **`#mention` RegexForge** in chat, paste ~15 raw lines, and say what you want — *"extract the ISO timestamp, the level, and the UUID request id."*
2. The assistant opens the RegexForge window; you press **Forge**.
3. An LLM authors a Python‑`re` regex with **named groups**; the bundled **`regex‑forge` Executa actually runs it** on every line and returns exact match offsets.
4. The window paints colored capture‑group overlays on your text and a big **match‑ratio ring** springs to `15 / 15`. A line didn't match? Hover **why?** and the engine pinpoints the exact character it diverged at (*"matched to `:07`, then `\.` couldn't match `,`"*). Refine in words and the red line snaps green.
5. Click **Copy regex + snippet** → a commented, named‑group pattern + ready‑to‑paste **ripgrep / Python / JavaScript / grep** snippets, posted back into your chat.

### Works on real formats — all verified live

| Sample | Plain‑English ask | Result |
|---|---|---|
| **App log** | timestamp + level + UUID request id | `15/15`, groups `ts · level · req_id` |
| **JSON logs** | timestamp + level + latency in ms | `10/10`, groups `ts · level · latency` |
| **CSV rows** | order date + SKU + dollar amount | `10/10`, groups `date · sku · amount` |

Or paste your own lines.

## How AI is used — meaningfully, not decoratively

Two load‑bearing roles via the **keyless** `anna.llm.complete` (host‑billed, no API key):

| Role | Who | Call |
|---|---|---|
| **Author** a regex from English + your samples | host LLM | `anna.llm.complete` |
| **Repair** on misses (reads the engine's miss report) | host LLM | `anna.llm.complete` |
| **Verify** what actually matches (source of truth) | `regex‑forge` Executa | `anna.tools.invoke` → Python `re` |

The deterministic engine structurally eliminates the #1 LLM‑tool failure mode — confidently‑wrong matches. The LLM does the language reasoning; the engine owns the facts.

## Why it fits Anna

- The plain‑English authoring and conversational refinement live **in chat**; the assistant **drives the window** (`open_app_view` → `tools.invoke`) — you never type a regex character.
- The verified result + snippet ride back into the durable conversation via **`chat.append_artifact`**, so it's in your transcript even after the window closes.
- A `#mention` brings the regex **Skill** + **Executa** into exactly the turn you need, then leaves. A standalone regex101 tab can't do any of that.

## Architecture

```
regexforge/
├── manifest.json                 # schema‑2: permissions, ui.views, host_api (llm/tools/chat/storage/window)
├── app.json                      # store listing + bundled_executas → handle map
├── bundle/                       # static SPA mounted in the Anna window
│   ├── index.html                #   compose card · pattern bar · match ring · legend · lines · export
│   ├── app.js                    #   SDK connect → author (llm) → verify (executa) → paint → export
│   ├── style.css                 #   calm, spacious; the ring is the one saturated focal point
│   ├── samples.js                #   3 built‑in corpora (app log / json / csv) for zero‑paste demos
│   └── icon.svg
├── executas/
│   ├── regex-forge/              # the deterministic engine — Python stdio Executa (JSON‑RPC 2.0)
│   │   ├── regex_forge_plugin.py #   one `forge` tool, action = set_samples|test_pattern|explain|diff_miss|export|get_state
│   │   ├── executa.json          #   dev tool_id + explicit run command (no deps)
│   │   └── pyproject.toml         #   stdlib only → instant `uv` cold start
│   └── regex-coach/
│       └── SKILL.md              # teaches Anna: NAMED groups, ALWAYS verify before claiming, refine‑on‑miss
├── fixtures/
│   └── forge.jsonl               # canned llm.complete per corpus → the demo runs fully offline
└── tests/
    └── plugin/test_forge_contract.py   # 14 contract tests over the engine
```

**The `forge` Executa** — one dispatcher tool, selected by `action`:

| action | returns |
|---|---|
| `set_samples {lines}` | `{count}` |
| `test_pattern {pattern, flags?, samples?}` | per‑line match offsets + named‑group spans — **the ground truth** |
| `diff_miss {pattern, line_idx}` | the exact char span where the pattern diverges from a missing line |
| `explain {pattern}` | a deterministic token‑by‑token legend |
| `export {pattern, flags?, target}` | a commented snippet for `python` / `javascript` / `ripgrep` / `grep` |

Compile errors are returned as structured `{ok:false, error, error_pos}` — never thrown — so a bad pattern becomes a refinement loop, not a crash.

## Run it

**Prerequisites:** Node 22+, [`uv`](https://docs.astral.sh/uv/), and the Anna CLI:

```bash
npm i -g @anna-ai/cli
anna-app doctor
```

**Fully offline demo (no account needed)** — the AI is served from a fixture and the engine runs for real, so the whole arc is deterministic:

```bash
cd regexforge
anna-app validate --strict
anna-app dev --mock-llm fixtures/forge.jsonl
# open the printed dashboard URL → pick a sample → press Forge
```

**Live AI authoring** — after connecting your Anna account, the LLM generalizes to *your* pasted lines and refine‑in‑words works conversationally:

```bash
anna-app login --host https://anna.partners
anna-app dev --llm real --llm-app-slug regexforge
```

**Standalone styled preview** (no Anna) — verifies patterns with the browser's own RegExp engine:

```bash
cd bundle && python3 -m http.server 8000   # open http://localhost:8000
```

## Verified

- **Engine:** `uv run --with pytest pytest tests/plugin -q` → **14 passing** contract tests (match offsets, named groups, structured compile errors, the `diff_miss` localizer, all four export targets).
- **End‑to‑end:** driven through the real `anna-app dev` harness — bundle connects, `tools.invoke` reaches the Executa over the production RPC dispatcher, overlays/ring/legend render from real offsets, all three sample formats Forge to a full match, and `chat.append_artifact` succeeds (zero failed RPCs, zero console errors).

## How it maps to the judging criteria

- **Usefulness** — a universal, immediately‑legible dev/ops pain.
- **Working demo** — the wow is an in‑window button + a keyless‑or‑mockable LLM call, so it runs 100% offline under `anna-app dev`.
- **Meaningful AI** — English→named‑group authoring + failure‑driven repair, with the engine as the guardrail against hallucinated matches.
- **Fit with Anna** — chat authors, the assistant drives the window, the verified snippet lands back in the conversation.
- **Creativity & execution** — *self‑proving regex*, a single saturated match‑ratio ring, polished + tested code.

## License

MIT
