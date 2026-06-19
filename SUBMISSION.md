# RegexForge — DoraHacks submission

**Hackathon:** Anna AI‑Native App Hackathon — https://dorahacks.io/hackathon/2204/detail
**Tagline:** Describe a regex in plain English — then trust it, because the engine proves every match.

---

## Description (paste into the DoraHacks submission)

**RegexForge** turns the most‑hated dev/ops micro‑chore — hand‑crafting and
debugging a regex against messy real text — into one assistant‑driven
interaction inside Anna.

You `#mention` RegexForge, paste a handful of raw log or CSV lines, and say what
you want in plain English ("pull the ISO timestamp, the level, and the UUID
request id"). An LLM authors a Python‑`re` regex with named groups; a bundled
**Executa engine actually runs it** against every line and returns exact
per‑line match offsets. The window paints colored capture‑group overlays on your
real text and a match‑ratio ring fills to `15/15`. If a line doesn't match, the
engine tells you the precise character it diverged at; refine in plain words and
the red line snaps green. One click copies a commented, named‑group pattern plus
ready‑to‑paste `ripgrep` / `Python` / `JavaScript` / `grep` snippets — and posts
the verified result back into your chat.

**The model proposes; the engine proves.** Every highlight and every number
comes from Python's standard‑library `re`, never from the model — so a match is
real, not hallucinated.

### Who it's for
Developers, SREs, and data wranglers who write throwaway regexes against logs,
CSVs, and config every week and can never remember the exact syntax — or trust
that the pattern really matches.

### How AI is used
Two load‑bearing host‑LLM roles via the keyless `anna.llm.complete`:
**(1) Author** — English intent + sample lines → a strict‑JSON regex with named
groups and a one‑line explanation. **(2) Repair** — when the engine reports
misses, the structured miss report is fed back to produce a corrected pattern.
The deterministic Executa is the sole source of truth for what matches, so the
AI's #1 failure mode (confidently‑wrong matches) is structurally impossible.

### How it connects to Anna
Built as a schema‑2 Anna App: a static‑SPA bundle in an Anna window + a Python
stdio **Executa** (JSON‑RPC) + a **Skill** (SKILL.md) that teaches the assistant
to author re‑safe named groups and always verify before claiming a match. The
plain‑English authoring and refinement happen in chat; the assistant drives the
window (`open_app_view` → `tools.invoke`); the verified snippet returns to the
durable conversation via `chat.append_artifact`. It uses the host LLM
(`llm.complete`), tool invocation (`tools.invoke`), per‑app storage, and window
APIs — all keyless.

---

## Demo video

A recorded ~1‑minute walkthrough is included with this submission: **`regexforge-demo.mov`**.

### 60‑second demo script (what the recording shows)

Run: `anna-app dev --mock-llm fixtures/forge.jsonl` and open the dashboard URL.

- **0–8s** — The window is open with 15 raw nginx lines and the intent prefilled:
  *"Extract the ISO timestamp, the log level, and the UUID request id."* Press **Forge**.
- **8–22s** — The pattern bar fills with a named‑group regex; overlays bloom in
  per‑group colors (`ts` teal, `level` indigo, `req_id` amber) and the ring
  springs to a green **15/15 — ALL MATCHED**. Narrate: *"I described the fields
  in English; RegexForge wrote the regex and the engine proved it matches all 15
  of my real lines — including the one with a comma before the milliseconds."*
- **22–40s** — Show the engine is the truth: edit `[.,]` back to `\.`, press
  Enter → ring drops to amber **14/15**, one line turns red. Hover **why?** →
  *"Matched up to character 19 ('…09:21:07'); then `\.` could not match ','."*
  Fix it → **15/15** green again.
- **40–55s** — Pick **ripgrep** in the export dropdown, click **Copy regex +
  snippet** → the commented, verified pattern is posted to chat as a card.
- **55–60s** — *"A regex you can trust — because the engine proved it, not the model."*

> For a live‑AI encore (the LLM generalizing to a judge's own pasted lines), run
> `anna-app login` then `anna-app dev --llm real --llm-app-slug regexforge`.

---

## Reproduce / run the artifact

```bash
npm i -g @anna-ai/cli           # Node 22+, uv required
cd regexforge
anna-app validate --strict      # ✓ validate passed
anna-app dev --mock-llm fixtures/forge.jsonl
uv run --with pytest pytest tests/plugin -q   # 14 passing engine tests
```

See `README.md` for full architecture and run modes.

---

**Team:** solo. **License:** MIT.
**Note:** the DoraHacks submission itself (and any live Anna account / App‑Store
publish) is done from the participant's own account.
