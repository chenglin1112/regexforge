/**
 * RegexForge — Anna App bundle controller.
 *
 * The model PROPOSES a regex (anna.llm.complete); the bundled regex-forge
 * Executa PROVES it (anna.tools.invoke -> Python `re`). Every overlay and the
 * match-ratio ring are painted from the engine's real offsets — never the
 * model's guess.
 *
 * Connects to Anna via the runtime SDK at /static/anna-apps/_sdk/latest/index.js.
 * Runs three ways, all of which keep the deterministic verification intact:
 *   - real AI   : anna.llm.complete reaches the host model (anna-app dev --llm real)
 *   - mocked AI : canned completions from a fixture (anna-app dev --llm mock)
 *   - manual    : no AI — type/paste a regex yourself; the engine still verifies
 * Opened directly (no Anna), it falls back to a browser-RegExp preview engine.
 */

import { SAMPLES, DEFAULT_SAMPLE } from "./samples.js";

// The Anna runtime SDK is served by the HOST at this absolute path. Load it
// dynamically (not a static top-level import) so this module still boots when
// the bundle is opened OUTSIDE Anna — e.g. a plain static file server or a raw
// file preview — where that path 404s. In that case we fall back to a styled
// "standalone preview" that verifies patterns with the browser's own RegExp
// engine. Inside `anna-app dev` / the Anna dashboard the path resolves normally.
let AnnaAppRuntime = null;
async function loadAnnaSdk() {
  try {
    const mod = await import("/static/anna-apps/_sdk/latest/index.js");
    return mod.AnnaAppRuntime || null;
  } catch {
    return null; // not running inside Anna — standalone preview
  }
}

// Dev-harness fallback id; overridden at publish by window.__ANNA_TOOL_IDS__.
const DEV_FALLBACK_TOOL_ID = "tool-test-regex-forge-12345678";
const TOOL_ID =
  (typeof window !== "undefined" &&
    window.__ANNA_TOOL_IDS__ &&
    window.__ANNA_TOOL_IDS__["regex-forge"]) ||
  DEV_FALLBACK_TOOL_ID;
const TOOL_METHOD = "forge";
const STORAGE_KEY = "rf:session";

// Capture-group overlay palette (mirrors --g1..--g6 in style.css).
const PALETTE = ["#5eead4", "#818cf8", "#fbbf24", "#f472b6", "#38bdf8", "#a3e635"];
const ARC_R = 52;
const ARC = 2 * Math.PI * ARC_R;

const $ = (s) => document.querySelector(s);

const els = {
  body: document.body,
  intent: $("#intent-input"),
  forgeBtn: $("#forge-btn"),
  status: $("#status-label"),
  pattern: $("#pattern-input"),
  flags: $("#flags-input"),
  explain: $("#explain-line"),
  ringProgress: $(".ring__progress"),
  ringCount: $("#ring-count"),
  ringTotal: $("#ring-total"),
  ringLabel: $("#ring-label"),
  legend: $("#legend"),
  refineRow: $("#refine-row"),
  refineInput: $("#refine-input"),
  refineBtn: $("#refine-btn"),
  verified: $("#verified-note"),
  chips: $("#sample-chips"),
  pasteToggle: $("#paste-toggle"),
  pastePanel: $("#paste-panel"),
  pasteArea: $("#paste-area"),
  loadBtn: $("#load-btn"),
  lines: $("#lines"),
  exportTarget: $("#export-target"),
  copyBtn: $("#copy-btn"),
  conn: $("#conn-status"),
  aiMode: $("#ai-mode"),
  themeToggle: $("#theme-toggle"),
};

let anna = null;
let aiAvailable = false;
let busy = false;
const state = {
  lines: [],
  pattern: "",
  flags: "",
  result: null,            // last test_pattern payload
  groupColors: {},         // name -> hex
  groupMeanings: {},       // name -> short text (from the model)
  sampleId: DEFAULT_SAMPLE,
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  if (els.ringProgress) {
    els.ringProgress.style.strokeDasharray = String(ARC);
    els.ringProgress.style.strokeDashoffset = String(ARC);
  }
  buildChips();
  bindUi();
  honorSavedTheme();

  AnnaAppRuntime = await loadAnnaSdk();
  if (AnnaAppRuntime) {
    try {
      anna = await AnnaAppRuntime.connect();
      setConn(true);
      aiAvailable = true; // optimistic; flips to manual on first real llm error (--no-llm / no PAT)
      setAiBadge();
    } catch (e) {
      anna = null;
      console.warn("[regexforge] standalone preview:", e?.message || e);
    }
  }
  if (!anna) {
    setConn(false);
    aiAvailable = false;
    setAiBadge();
    setStatus("Standalone preview — using the browser regex engine. Pick a sample and type a pattern.");
  }

  // Restore prior session, else load the default corpus.
  let restored = false;
  if (anna) {
    try {
      const got = await anna.storage.get({ key: STORAGE_KEY });
      const saved = unwrap(got)?.value ?? unwrap(got);
      if (saved && Array.isArray(saved.lines) && saved.lines.length) {
        state.lines = saved.lines;
        state.sampleId = saved.sampleId || "custom";
        state.pattern = saved.pattern || "";
        state.flags = saved.flags || "";
        const corpus = SAMPLES.find((s) => s.id === state.sampleId);
        els.intent.value = saved.intent || corpus?.intent || "";
        await pushSamples(state.lines);
        restored = true;
      }
    } catch { /* fresh session */ }
  }
  if (!restored) {
    await loadSample(DEFAULT_SAMPLE, { silent: true });
  } else {
    markActiveChip();
    els.pattern.value = state.pattern;
    els.flags.value = state.flags;
    renderLinesPlain();
    setRing(0, state.lines.length);
    if (state.pattern) await runTest({ persist: false });
  }

  // Honor an LLM-supplied intent / first instruction, if any.
  const entry = anna?.entryPayload;
  if (entry && typeof entry.intent === "string" && entry.intent.trim()) {
    els.intent.value = entry.intent.trim();
  }
  anna?.on?.("entry_payload", (p) => {
    if (p && typeof p.intent === "string") {
      els.intent.value = p.intent.trim();
      forge();
    }
  });
}

function capHas(ns, method) {
  const caps = anna?.capabilities?.[ns];
  if (Array.isArray(caps)) return caps.includes(method);
  if (caps && typeof caps === "object") return !!caps[method] || method in caps;
  return !!caps;
}

// ---------------------------------------------------------------------------
// RPC helpers (defensive unwrapping — SDK result shape varies by version)
// ---------------------------------------------------------------------------

function unwrap(res) {
  if (res == null || typeof res !== "object") return res;
  const markers = ["ok", "match_count", "count", "snippet", "samples", "tokens", "missed", "results", "value"];
  if (markers.some((m) => m in res)) return res;
  if ("data" in res && res.data && typeof res.data === "object") return res.data;
  if ("result" in res) return unwrap(res.result);
  return res;
}

async function callForge(action, extra = {}) {
  if (!anna) throw new Error("not connected");
  const raw = await anna.tools.invoke({
    tool_id: TOOL_ID,
    method: TOOL_METHOD,
    args: { action, ...extra },
  });
  return unwrap(raw);
}

async function pushSamples(lines) {
  if (!anna) return;
  try {
    await callForge("set_samples", { lines });
  } catch (e) {
    console.warn("[regexforge] set_samples failed:", e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// AI: author + repair (host LLM). Falls back to manual cleanly.
// ---------------------------------------------------------------------------

function llmText(reply) {
  const r = reply?.result ?? reply;
  const c = r?.content;
  if (typeof c === "string") return c;
  if (c && typeof c.text === "string") return c.text;
  if (Array.isArray(c)) return c.map((x) => x?.text || "").join("");
  return r?.text || "";
}

function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* try to carve it out */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}

const AUTHOR_RULES =
  "You are a precise regex engineer. Write ONE Python `re`-compatible regular " +
  "expression that satisfies the request, using NAMED capture groups " +
  "(?P<name>...) for each field requested. Prefer conservative constructs " +
  "(\\d{4} not \\d+, character classes not .). Return ONLY a single-line JSON " +
  'object, no prose, no code fence: {"pattern":"<regex>","flags":"<subset of ' +
  'imsxa or empty>","groups":[{"name":"<group>","meaning":"<short>"}],' +
  '"explanation":"<one sentence>"}';

async function llmComplete(userText) {
  if (!anna || !anna.llm || typeof anna.llm.complete !== "function") {
    const e = new Error("llm.complete unavailable in this runtime");
    e.code = "not_implemented";
    throw e;
  }
  const reply = await anna.llm.complete({
    messages: [{ role: "user", content: { type: "text", text: userText } }],
    maxTokens: 700,
    // Top-level `content` carries the real prompt PLUS a small [corpus:<id>]
    // tag. Real runtimes read `messages`; the offline --mock-llm matcher keys
    // off `content`, so this lets a fixture return the right pattern per sample
    // format. Harmless either way.
    content: `[corpus:${state.sampleId}] ${userText}`,
  });
  return llmText(reply);
}

async function aiAuthor(intent, lines) {
  const text = await llmComplete(
    `${AUTHOR_RULES}\n\nREQUEST: ${intent}\n\nSAMPLE LINES:\n${lines.join("\n")}`
  );
  return extractJson(text);
}

async function aiRepair(note) {
  const r = state.result || {};
  const misses = (r.results || [])
    .filter((row) => !row.matched)
    .slice(0, 6)
    .map((row) => `  - line ${row.line_idx}: ${row.text}`)
    .join("\n");
  let diff = "";
  try {
    const firstMiss = (r.results || []).find((row) => !row.matched);
    if (anna && firstMiss) {
      const d = await callForge("diff_miss", {
        pattern: state.pattern, flags: state.flags, line_idx: firstMiss.line_idx,
      });
      if (d && d.hint) diff = d.hint;
    }
  } catch { /* best-effort */ }

  const text = await llmComplete(
    `${AUTHOR_RULES}\n\nThe previous regex did not match every line. Produce a ` +
    `corrected regex (same JSON format) that ALSO matches the missed lines, ` +
    `WITHOUT matching lines it should not.\n\n` +
    `PREVIOUS PATTERN: ${state.pattern}\nFLAGS: ${state.flags || "(none)"}\n` +
    `MATCHED: ${r.match_count}/${r.total}\nMISSES:\n${misses || "  (none)"}\n` +
    `ENGINE DIVERGENCE: ${diff || "(n/a)"}\nUSER NOTE: ${note || "(none)"}`
  );
  return extractJson(text);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function forge() {
  if (busy) return;
  const intent = els.intent.value.trim();
  if (!state.lines.length) { setStatus("Load some sample lines first.", "error"); return; }
  if (!aiAvailable) {
    setStatus("AI is off — type a regex in the bar below and press Enter (the engine still verifies it).", "error");
    els.pattern.focus();
    return;
  }
  if (!intent) { setStatus("Describe what to capture, then press Forge.", "error"); els.intent.focus(); return; }

  setBusy(true);
  setStatus("Forging a pattern from your description…", "busy");
  try {
    const authored = await aiAuthor(intent, state.lines);
    if (!authored || typeof authored.pattern !== "string") {
      setStatus("The model didn't return a usable pattern — try rephrasing, or type one yourself.", "error");
      return;
    }
    applyAuthored(authored);
    await runTest({});
  } catch (e) {
    handleLlmError(e);
  } finally {
    setBusy(false);
  }
}

async function refine() {
  if (busy) return;
  const note = els.refineInput.value.trim();
  if (!state.pattern) return;
  if (!aiAvailable) {
    setStatus("AI is off — edit the pattern in the bar and press Enter.", "error");
    els.pattern.focus();
    return;
  }
  setBusy(true);
  setStatus("Refining the pattern…", "busy");
  try {
    const repaired = await aiRepair(note);
    if (!repaired || typeof repaired.pattern !== "string") {
      setStatus("Couldn't refine automatically — adjust the pattern by hand.", "error");
      return;
    }
    applyAuthored(repaired);
    els.refineInput.value = "";
    await runTest({});
  } catch (e) {
    handleLlmError(e);
  } finally {
    setBusy(false);
  }
}

function applyAuthored(j) {
  state.pattern = String(j.pattern || "");
  state.flags = String(j.flags || "").replace(/[^imsxa]/gi, "");
  els.pattern.value = state.pattern;
  els.flags.value = state.flags;
  state.groupMeanings = {};
  if (Array.isArray(j.groups)) {
    for (const g of j.groups) if (g && g.name) state.groupMeanings[g.name] = g.meaning || "";
  }
  els.explain.textContent = j.explanation ? String(j.explanation) : "";
}

// run the current pattern through the engine (or local preview) + render
async function runTest({ persist = true } = {}) {
  state.pattern = els.pattern.value;
  state.flags = els.flags.value.replace(/[^imsxa]/gi, "");
  els.flags.value = state.flags;
  if (!state.pattern.trim()) { setStatus("Type or forge a pattern to test.", ""); return; }

  let data;
  try {
    data = anna ? await callForge("test_pattern", { pattern: state.pattern, flags: state.flags })
                : localTest(state.pattern, state.flags, state.lines);
  } catch (e) {
    setStatus(`Engine error: ${e?.message || e}`, "error");
    return;
  }
  state.result = data;

  if (data && data.ok === false) {
    renderCompileError(data);
    if (persist) saveSession();
    return;
  }
  assignColors(data.group_names || []);
  renderResult(data);
  els.copyBtn.disabled = !(data.match_count > 0);
  if (persist) saveSession();
}

async function showWhy(lineIdx) {
  if (!anna && !state.pattern) return;
  let data;
  try {
    data = anna ? await callForge("diff_miss", { pattern: state.pattern, flags: state.flags, line_idx: lineIdx })
                : localDiff(state.pattern, state.flags, state.lines, lineIdx);
  } catch (e) { setStatus(`Could not analyze: ${e?.message || e}`, "error"); return; }
  if (!data) return;
  renderWhy(lineIdx, data);
}

async function copyExport() {
  if (!state.pattern || !state.result || state.result.ok === false) return;
  const target = els.exportTarget.value;
  let data;
  try {
    data = anna ? await callForge("export", { pattern: state.pattern, flags: state.flags, target })
                : localExport(state.pattern, state.flags, target);
  } catch (e) { setStatus(`Export failed: ${e?.message || e}`, "error"); return; }
  if (!data || !data.snippet) { setStatus("Nothing to export yet.", "error"); return; }

  const ok = await copyToClipboard(data.snippet);
  const ratio = `${state.result.match_count}/${state.result.total}`;
  setStatus(ok ? `Copied ${target} snippet — verified ${ratio} by the engine.`
               : `Snippet ready (clipboard blocked) — it's posted to chat. Verified ${ratio}.`, "good");

  // The durable Anna-native payoff: drop a card into the conversation.
  if (anna) {
    try {
      await anna.chat.append_artifact({
        kind: "app_event",
        summary: `RegexForge → ${target}: /${state.pattern}/${state.flags} — verified ${ratio} lines`,
        payload: { pattern: state.pattern, flags: state.flags, target, snippet: data.snippet, matched: state.result.match_count, total: state.result.total },
      });
    } catch { /* chat may be denied */ }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function assignColors(groupNames) {
  state.groupColors = {};
  groupNames.forEach((name, i) => { state.groupColors[name] = PALETTE[i % PALETTE.length]; });
}

function renderResult(data) {
  renderLines(data);
  renderLegend(data.group_names || []);
  setRing(data.match_count || 0, data.total || 0);
  const all = data.total > 0 && data.match_count === data.total;
  els.refineRow.hidden = !(aiAvailable && data.total > 0 && data.match_count < data.total);
  if (data.total > 0 && data.match_count < data.total) {
    els.verified.textContent = `${data.total - data.match_count} line(s) didn't match — hover a red line to see why, or refine in words.`;
    els.verified.dataset.kind = "warn";
    setStatus(`Matched ${data.match_count}/${data.total}. Refine to close the gap.`, "");
  } else if (all) {
    els.verified.textContent = `All ${data.total} lines matched — engine-verified. Copy a snippet you can trust.`;
    els.verified.dataset.kind = "good";
    setStatus(`All ${data.total} lines matched. ✓`, "good");
  } else {
    els.verified.textContent = "";
    setStatus("No matches yet — adjust the pattern or refine.", "");
  }
  syncTitle();
}

function renderLines(data) {
  els.lines.innerHTML = "";
  const firstSeen = new Set();
  for (const row of data.results || []) {
    const li = document.createElement("li");
    li.className = "line " + (row.matched ? "is-match" : "is-miss");
    const no = document.createElement("span");
    no.className = "line__no";
    no.textContent = String(row.line_idx + 1);
    const src = document.createElement("code");
    src.className = "line__src";
    paintLine(src, row, firstSeen);
    li.append(no, src);
    if (!row.matched) {
      const why = document.createElement("button");
      why.className = "line__why";
      why.type = "button";
      why.textContent = "why?";
      why.addEventListener("click", () => showWhy(row.line_idx));
      li.appendChild(why);
    }
    els.lines.appendChild(li);
  }
}

// build the line with colored group overlays from engine offsets
function paintLine(container, row, firstSeen) {
  const text = row.text || "";
  // flatten all group spans across matches; sort; drop overlaps
  let spans = [];
  for (const m of row.matches || []) {
    for (const g of m.groups || []) spans.push(g);
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const clean = [];
  let lastEnd = -1;
  for (const s of spans) {
    if (s.start >= lastEnd && s.end > s.start) { clean.push(s); lastEnd = s.end; }
  }
  let cursor = 0;
  for (const s of clean) {
    if (s.start > cursor) container.appendChild(document.createTextNode(text.slice(cursor, s.start)));
    const span = document.createElement("span");
    span.className = "grp";
    span.style.setProperty("--c", state.groupColors[s.name] || PALETTE[0]);
    if (!firstSeen.has(s.name)) {
      firstSeen.add(s.name);
      const tag = document.createElement("sup");
      tag.className = "grp__tag";
      tag.textContent = s.name;
      span.appendChild(tag);
    }
    span.appendChild(document.createTextNode(text.slice(s.start, s.end)));
    container.appendChild(span);
    cursor = s.end;
  }
  if (cursor < text.length) container.appendChild(document.createTextNode(text.slice(cursor)));
}

function renderLegend(groupNames) {
  els.legend.innerHTML = "";
  if (!groupNames.length) {
    const e = document.createElement("span");
    e.className = "legend__empty";
    e.textContent = "no capture groups";
    els.legend.appendChild(e);
    return;
  }
  for (const name of groupNames) {
    const chip = document.createElement("span");
    chip.className = "legend__item";
    chip.style.setProperty("--c", state.groupColors[name] || PALETTE[0]);
    const sw = document.createElement("span");
    sw.className = "legend__swatch";
    const nm = document.createElement("span");
    nm.className = "legend__name";
    nm.textContent = name;
    chip.append(sw, nm);
    const meaning = state.groupMeanings[name];
    if (meaning) { const mt = document.createElement("span"); mt.textContent = meaning; chip.appendChild(mt); }
    els.legend.appendChild(chip);
  }
}

function renderCompileError(data) {
  els.lines.innerHTML = "";
  renderLinesPlain();
  els.legend.innerHTML = "";
  setRing(0, state.lines.length, true);
  els.body.dataset.state = "error";
  els.refineRow.hidden = !aiAvailable;
  els.verified.textContent = "";
  const pos = data.error_pos != null ? ` (at position ${data.error_pos})` : "";
  setStatus(`Compile error: ${data.error}${pos}. ${aiAvailable ? "Refine or" : ""} fix the pattern.`, "error");
}

function renderLinesPlain() {
  els.lines.innerHTML = "";
  state.lines.forEach((text, idx) => {
    const li = document.createElement("li");
    li.className = "line";
    const no = document.createElement("span");
    no.className = "line__no";
    no.textContent = String(idx + 1);
    const src = document.createElement("code");
    src.className = "line__src";
    src.textContent = text;
    li.append(no, src);
    els.lines.appendChild(li);
  });
}

function renderWhy(lineIdx, data) {
  // remove any prior hint
  els.lines.querySelectorAll(".miss-hint").forEach((n) => n.remove());
  const items = Array.from(els.lines.children);
  const target = items.find((li) => li.querySelector(".line__no")?.textContent === String(lineIdx + 1));
  const hint = document.createElement("li");
  hint.className = "miss-hint";
  if (data.missed === false) {
    hint.textContent = "This line actually matches now.";
  } else {
    hint.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = "why it missed: ";
    hint.append(b, document.createTextNode(data.hint || "could not localize the divergence."));
  }
  if (target && target.nextSibling) els.lines.insertBefore(hint, target.nextSibling);
  else els.lines.appendChild(hint);
}

function setRing(matched, total, isError) {
  // #ring-count = <leading text node "N"><span id=ring-total>/T</span>.
  // Update only the leading text node so the inner span survives.
  let countNode = els.ringCount.childNodes[0];
  if (!countNode || countNode.nodeType !== Node.TEXT_NODE) {
    countNode = document.createTextNode("");
    els.ringCount.insertBefore(countNode, els.ringCount.firstChild);
  }
  countNode.nodeValue = String(matched);
  els.ringTotal.textContent = "/" + total;
  const frac = total > 0 ? matched / total : 0;
  els.ringProgress.style.strokeDashoffset = String(ARC * (1 - frac));
  let st = "empty";
  if (isError) st = "error";
  else if (total > 0 && matched === total) st = "perfect";
  else if (matched > 0) st = "partial";
  else st = "empty";
  els.body.dataset.state = st;
  els.ringLabel.textContent = isError ? "compile error"
    : total === 0 ? "no samples"
    : matched === total ? "all matched"
    : matched === 0 ? "no matches"
    : "matched";
}

function syncTitle() {
  if (!anna || !state.result || state.result.ok === false) return;
  const r = state.result;
  anna.window?.set_title?.({ title: `RegexForge · ${r.match_count}/${r.total}` }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

function buildChips() {
  els.chips.innerHTML = "";
  for (const s of SAMPLES) {
    const b = document.createElement("button");
    b.className = "chip";
    b.type = "button";
    b.dataset.id = s.id;
    b.textContent = s.label;
    b.addEventListener("click", () => loadSample(s.id, {}));
    els.chips.appendChild(b);
  }
}

function markActiveChip() {
  for (const c of els.chips.children) c.classList.toggle("is-active", c.dataset.id === state.sampleId);
}

async function loadSample(id, { silent = false } = {}) {
  const corpus = SAMPLES.find((s) => s.id === id) || SAMPLES[0];
  state.sampleId = corpus.id;
  state.lines = corpus.lines.slice();
  state.result = null;
  state.pattern = "";
  state.flags = "";
  els.pattern.value = "";
  els.flags.value = "";
  els.explain.textContent = "";
  els.intent.value = corpus.intent;
  els.copyBtn.disabled = true;
  els.refineRow.hidden = true;
  els.verified.textContent = "";
  els.legend.innerHTML = "";
  markActiveChip();
  renderLinesPlain();
  setRing(0, state.lines.length);
  await pushSamples(state.lines);
  if (!silent) setStatus(`Loaded ${state.lines.length} ${corpus.label} lines. Press Forge to build a pattern.`, "");
  saveSession();
}

async function loadPasted() {
  const raw = els.pasteArea.value;
  const lines = raw.split(/\r?\n/).map((l) => l).filter((l) => l.length > 0);
  if (!lines.length) { setStatus("Paste at least one line.", "error"); return; }
  state.sampleId = "custom";
  state.lines = lines.slice(0, 200);
  state.result = null; state.pattern = ""; state.flags = "";
  els.pattern.value = ""; els.flags.value = ""; els.explain.textContent = "";
  els.copyBtn.disabled = true; els.refineRow.hidden = true; els.verified.textContent = "";
  els.legend.innerHTML = "";
  markActiveChip();
  renderLinesPlain();
  setRing(0, state.lines.length);
  await pushSamples(state.lines);
  setStatus(`Loaded ${state.lines.length} pasted lines. Describe what to capture, then Forge.`, "");
  saveSession();
}

function saveSession() {
  if (!anna) return;
  anna.storage?.set?.({
    key: STORAGE_KEY,
    value: { lines: state.lines, pattern: state.pattern, flags: state.flags, sampleId: state.sampleId, intent: els.intent.value },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Standalone preview engine (browser RegExp) — only when not connected to Anna
// ---------------------------------------------------------------------------

function pyToJs(pattern) {
  return String(pattern)
    .replace(/\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/g, "(?<$1>")
    .replace(/\(\?P=([A-Za-z_][A-Za-z0-9_]*)\)/g, "\\k<$1>");
}

function jsFlags(flags) {
  let f = "";
  for (const c of flags || "") if ("ims".includes(c)) f += c;
  return f + "gd";
}

function groupNamesOf(pattern) {
  const names = [];
  const re = /\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/g;
  let m;
  while ((m = re.exec(pattern))) names.push(m[1]);
  return names;
}

function localTest(pattern, flags, lines) {
  let re;
  try { re = new RegExp(pyToJs(pattern), jsFlags(flags)); }
  catch (e) { return { ok: false, error: e.message, error_pos: null, pattern, flags, total: lines.length }; }
  const group_names = groupNamesOf(pattern);
  const results = [];
  let match_count = 0;
  lines.forEach((text, idx) => {
    const matches = [];
    for (const m of text.matchAll(re)) {
      const groups = [];
      const gi = m.indices && m.indices.groups;
      if (gi) {
        for (const name of group_names) {
          const sp = gi[name];
          if (sp) groups.push({ name, start: sp[0], end: sp[1], text: text.slice(sp[0], sp[1]) });
        }
      }
      matches.push({ start: m.index, end: m.index + m[0].length, groups });
      if (m[0].length === 0) break;
    }
    if (matches.length) match_count++;
    results.push({ line_idx: idx, text, matched: matches.length > 0, matches });
  });
  return { ok: true, pattern, flags, group_names, match_count, total: lines.length, results };
}

function localDiff(pattern, flags, lines, idx) {
  const line = lines[idx] || "";
  let re;
  try { re = new RegExp(pyToJs(pattern), jsFlags(flags)); }
  catch (e) { return { ok: false, error: e.message }; }
  if (re.test(line)) return { ok: true, missed: false, line_idx: idx, line_text: line };
  return { ok: true, missed: true, line_idx: idx, line_text: line, hint: "this line did not match (open in Anna for an exact divergence point)." };
}

function localExport(pattern, flags, target) {
  if (target === "javascript") {
    return { ok: true, target, pattern: pyToJs(pattern), flags: jsFlags(flags),
      snippet: `const re = /${pyToJs(pattern).replace(/\//g, "\\/")}/${jsFlags(flags)};\nfor (const line of lines) {\n  const m = line.match(re);\n  if (m) console.log(m.groups);\n}` };
  }
  return { ok: true, target: "python", pattern, flags,
    snippet: `import re\npattern = re.compile(r'''${pattern}''')\nfor line in lines:\n    m = pattern.search(line)\n    if m:\n        print(m.groupdict())` };
}

// ---------------------------------------------------------------------------
// UI wiring + utilities
// ---------------------------------------------------------------------------

function bindUi() {
  els.forgeBtn.addEventListener("click", forge);
  els.intent.addEventListener("keydown", (e) => { if (e.key === "Enter") forge(); });
  els.refineBtn.addEventListener("click", refine);
  els.refineInput.addEventListener("keydown", (e) => { if (e.key === "Enter") refine(); });
  els.pattern.addEventListener("keydown", (e) => { if (e.key === "Enter") runTest({}); });
  els.flags.addEventListener("keydown", (e) => { if (e.key === "Enter") runTest({}); });
  els.copyBtn.addEventListener("click", copyExport);
  els.themeToggle.addEventListener("click", toggleTheme);
  els.pasteToggle.addEventListener("click", () => {
    const open = els.pastePanel.hidden;
    els.pastePanel.hidden = !open;
    els.pasteToggle.textContent = open ? "Use a sample" : "Paste your own";
    if (open) els.pasteArea.focus();
  });
  els.loadBtn.addEventListener("click", loadPasted);
}

function handleLlmError(e) {
  const code = e?.code || e?.name || "";
  if (/not_implemented|permission_denied|llm_disabled|disabled|quota/i.test(String(code) + " " + (e?.message || ""))) {
    aiAvailable = false;
    setAiBadge();
    setStatus("AI isn't available here — type a regex in the bar and press Enter (the engine still verifies it). Run `anna-app dev --llm real` after `anna-app login` for AI authoring.", "error");
  } else {
    setStatus(`AI error: ${e?.message || e}`, "error");
  }
}

async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }
}

function setBusy(on) { busy = on; els.body.classList.toggle("is-busy", !!on); els.forgeBtn.disabled = !!on; els.refineBtn.disabled = !!on; }
function setConn(on) {
  els.conn.classList.toggle("dot--off", !on);
  els.conn.classList.toggle("dot--on", !!on);
  els.conn.title = on ? "Connected to Anna" : "Standalone preview (browser regex engine)";
  const label = els.conn.querySelector(".conn__label");
  if (label) label.textContent = on ? "live" : "offline";
}
function setAiBadge() { els.body.dataset.ai = aiAvailable ? "ai" : "manual"; els.aiMode.textContent = aiAvailable ? "AI" : "manual"; }
function setStatus(text, kind) { els.status.textContent = text; if (kind) els.status.dataset.kind = kind; else delete els.status.dataset.kind; }

const THEME_KEY = "regexforge:theme";
function applyTheme(t) { if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme"); }
function effectiveTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit) return explicit;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function toggleTheme() { const next = effectiveTheme() === "dark" ? "light" : "dark"; applyTheme(next); try { localStorage.setItem(THEME_KEY, next); } catch {} }
function honorSavedTheme() { let s = null; try { s = localStorage.getItem(THEME_KEY); } catch {} if (s) applyTheme(s); }

document.addEventListener("DOMContentLoaded", init);
