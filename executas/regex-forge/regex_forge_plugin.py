#!/usr/bin/env python3
"""
regex-forge — Executa stdio tool plugin (single-dispatcher method)

The deterministic engine behind the RegexForge Anna App. The LLM *proposes*
a regex; THIS plugin is the sole source of truth for what actually matches.
Every highlight the UI paints, every number in the match-ratio ring, and
every compile error comes from Python's standard-library ``re`` module here —
never from the model. That is the whole point: a regex you can trust because
the engine proved it.

Why one method instead of six?
    Anna's UI Runtime allocates one Executa row per running plugin (matched by
    the server-minted ``tool_id``). Inside that plugin, behaviours are selected
    by the ``action`` discriminator on a single ``forge`` tool, exactly like the
    Focus Flow example's ``session`` tool. The bundle and the assistant both
    just toggle ``action``::

        anna.tools.invoke({
          tool_id: "<minted tool_id>",
          method:  "forge",
          args:    { action: "test_pattern", pattern: "...", flags: "i" },
        })

Actions:
    set_samples   {lines}                       -> {count}
    test_pattern  {pattern, flags?, samples?}   -> per-line match offsets (ground truth)
    explain       {pattern}                      -> deterministic token legend + named groups
    diff_miss     {pattern, line_idx, flags?}    -> why one line failed to match
    export        {pattern, flags?, target}      -> commented pattern + ready-to-run snippet
    get_state     {}                             -> current samples + last pattern

Protocol: JSON-RPC 2.0 over stdio.  Methods: describe, invoke, health.
State:    ~/.anna/regexforge/state.json  (stdlib only — instant uv cold start).
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Plugin manifest — Anna calls ``describe`` and uses this dict verbatim.
# ---------------------------------------------------------------------------
MANIFEST = {
    "display_name": "Regex Forge",
    "version": "1.0.0",
    "description": (
        "Compile and run a regular expression against real sample lines using "
        "Python's standard-library `re` engine, returning exact per-line match "
        "offsets, named-group spans, compile errors, and ready-to-paste "
        "snippets. The authoritative ground truth for the RegexForge Anna App."
    ),
    "author": "RegexForge",
    "homepage": "https://anna.partners",
    "license": "MIT",
    "tags": ["developer-tools", "regex", "logs", "anna-app"],
    "tools": [
        {
            "name": "forge",
            "description": (
                "Run the regex engine. Select an operation with `action`: "
                "set_samples | test_pattern | explain | diff_miss | export | "
                "get_state. `test_pattern` is the source of truth for which "
                "substrings match — always call it before claiming a match."
            ),
            "parameters": [
                {
                    "name": "action",
                    "type": "string",
                    "description": (
                        "One of: set_samples, test_pattern, explain, diff_miss, "
                        "export, get_state."
                    ),
                    "required": True,
                },
                {
                    "name": "pattern",
                    "type": "string",
                    "description": "Python `re` pattern (test_pattern, explain, diff_miss, export).",
                    "required": False,
                    "default": "",
                },
                {
                    "name": "flags",
                    "type": "string",
                    "description": "Inline flag letters: i (ignorecase), m (multiline), s (dotall), x (verbose), a (ascii).",
                    "required": False,
                    "default": "",
                },
                {
                    "name": "lines",
                    "type": "array",
                    "description": "Sample lines for action='set_samples' (each is one line of raw text).",
                    "required": False,
                },
                {
                    "name": "samples",
                    "type": "array",
                    "description": "Optional inline samples for action='test_pattern'; when given they also replace the stored set.",
                    "required": False,
                },
                {
                    "name": "line_idx",
                    "type": "integer",
                    "description": "Zero-based index of the failing line for action='diff_miss'.",
                    "required": False,
                },
                {
                    "name": "target",
                    "type": "string",
                    "description": "Export flavour for action='export': python | javascript | ripgrep | grep.",
                    "required": False,
                    "default": "python",
                },
            ],
        },
    ],
    "runtime": {"type": "uv", "min_version": "0.1.0"},
}

# ---------------------------------------------------------------------------
# State persistence (atomic write + corrupt-state quarantine, like Focus Flow).
# ---------------------------------------------------------------------------
STATE_DIR = Path(os.path.expanduser("~/.anna/regexforge"))
STATE_FILE = STATE_DIR / "state.json"
MAX_SAMPLES = 200
MAX_LINE_LEN = 4000

FLAG_LETTERS = {
    "i": re.IGNORECASE,
    "m": re.MULTILINE,
    "s": re.DOTALL,
    "x": re.VERBOSE,
    "a": re.ASCII,
}


def _empty_state():
    return {"samples": [], "last_pattern": "", "last_flags": ""}


def _load_state():
    if not STATE_FILE.exists():
        return _empty_state()
    try:
        with STATE_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("state.json root must be an object")
        base = _empty_state()
        base.update({k: data[k] for k in base if k in data})
        if not isinstance(base["samples"], list):
            base["samples"] = []
        return base
    except (json.JSONDecodeError, ValueError, OSError) as e:
        try:
            STATE_FILE.rename(STATE_FILE.with_suffix(".broken.json"))
            print(f"[regex-forge] corrupt state quarantined: {e}", file=sys.stderr)
        except OSError:
            pass
        return _empty_state()


def _save_state(state):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
    tmp.replace(STATE_FILE)


def _normalize_lines(lines):
    out = []
    for item in lines:
        if item is None:
            continue
        s = item if isinstance(item, str) else str(item)
        # A single multi-line blob counts as several sample lines.
        for piece in s.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
            out.append(piece[:MAX_LINE_LEN])
            if len(out) >= MAX_SAMPLES:
                return out
    return out


def _parse_flags(flags):
    f = 0
    seen = []
    for ch in (flags or ""):
        lo = ch.lower()
        if lo in FLAG_LETTERS:
            f |= FLAG_LETTERS[lo]
            if lo not in seen:
                seen.append(lo)
    return f, "".join(seen)


def _compile(pattern, flags):
    """Return (compiled, normalized_flag_string, error_dict_or_None)."""
    flag_bits, norm = _parse_flags(flags)
    try:
        compiled = re.compile(pattern, flag_bits)
        return compiled, norm, None
    except re.error as e:
        return None, norm, {
            "ok": False,
            "error": str(e),
            "error_pos": getattr(e, "pos", None),
            "pattern": pattern,
            "flags": norm,
        }


def _group_key(compiled, index):
    """Stable display key for a capture group: its name if any, else gN."""
    for name, gi in compiled.groupindex.items():
        if gi == index:
            return name
    return "g%d" % index


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------

def _action_set_samples(lines):
    if not isinstance(lines, list):
        raise ValueError("`lines` must be an array of strings")
    state = _load_state()
    state["samples"] = _normalize_lines(lines)
    _save_state(state)
    return {"count": len(state["samples"])}


def _action_test_pattern(pattern, flags, samples):
    state = _load_state()
    if samples is not None:
        if not isinstance(samples, list):
            raise ValueError("`samples` must be an array of strings")
        state["samples"] = _normalize_lines(samples)
    lines = state["samples"]

    compiled, norm, err = _compile(pattern or "", flags)
    if err is not None:
        # Persist the attempt so the UI/refine loop can read it back.
        state["last_pattern"] = pattern or ""
        state["last_flags"] = norm
        _save_state(state)
        err["total"] = len(lines)
        return err

    state["last_pattern"] = pattern or ""
    state["last_flags"] = norm
    _save_state(state)

    total_groups = compiled.groups
    group_names = [_group_key(compiled, gi) for gi in range(1, total_groups + 1)]

    results = []
    match_count = 0
    for idx, line in enumerate(lines):
        matches = []
        for m in compiled.finditer(line):
            groups = []
            for gi in range(1, total_groups + 1):
                span = m.span(gi)
                if span[0] < 0:
                    continue  # optional group that didn't participate
                groups.append({
                    "name": group_names[gi - 1],
                    "index": gi,
                    "start": span[0],
                    "end": span[1],
                    "text": line[span[0]:span[1]],
                })
            matches.append({
                "start": m.start(),
                "end": m.end(),
                "groups": groups,
            })
            if m.start() == m.end():
                break  # guard against zero-width infinite loop within a line
        if matches:
            match_count += 1
        results.append({
            "line_idx": idx,
            "text": line,
            "matched": bool(matches),
            "matches": matches,
        })

    return {
        "ok": True,
        "pattern": pattern or "",
        "flags": norm,
        "group_names": group_names,
        "match_count": match_count,
        "total": len(lines),
        "results": results,
    }


# --- regex tokenizer (shared by explain + diff_miss) -----------------------

def _tokenize_pattern(pattern):
    """Split a regex into top-level atoms (literal/escape/class/group/anchor),
    each carrying any trailing quantifier. Best-effort; never raises."""
    atoms = []
    i = 0
    n = len(pattern)
    while i < n:
        ch = pattern[i]
        start = i
        if ch == "\\" and i + 1 < n:
            i += 2
        elif ch == "[":
            i += 1
            if i < n and pattern[i] == "^":
                i += 1
            if i < n and pattern[i] == "]":
                i += 1  # literal ] as first class member
            while i < n and pattern[i] != "]":
                if pattern[i] == "\\" and i + 1 < n:
                    i += 2
                else:
                    i += 1
            if i < n:
                i += 1  # closing ]
        elif ch == "(":
            depth = 0
            while i < n:
                c = pattern[i]
                if c == "\\" and i + 1 < n:
                    i += 2
                    continue
                if c == "(":
                    depth += 1
                elif c == ")":
                    depth -= 1
                    if depth == 0:
                        i += 1
                        break
                i += 1
        else:
            i += 1
        # absorb a trailing quantifier (+ * ? or {m,n}) and lazy/possessive mark
        if i < n and pattern[i] in "*+?":
            i += 1
        elif i < n and pattern[i] == "{":
            j = pattern.find("}", i)
            if j != -1:
                i = j + 1
        if i < n and pattern[i] in "?+":
            i += 1
        atoms.append(pattern[start:i])
        if i == start:  # safety: never stall
            i += 1
    return atoms


_TOKEN_DESC = {
    r"\d": "a digit (0-9)",
    r"\D": "a non-digit",
    r"\w": "a word character",
    r"\W": "a non-word character",
    r"\s": "whitespace",
    r"\S": "non-whitespace",
    r"\b": "a word boundary",
    r"\.": "a literal dot",
    ".": "any character",
    "^": "start of line",
    "$": "end of line",
    "|": "OR (alternation)",
}


def _describe_atom(atom):
    base = atom
    quant = ""
    for q in ("*?", "+?", "??", "*", "+", "?"):
        if base.endswith(q) and len(base) > len(q):
            base, quant = base[:-len(q)], q
            break
    if quant == "" and base.endswith("}") and "{" in base:
        idx = base.rfind("{")
        base, quant = base[:idx], base[idx:]
    desc = _TOKEN_DESC.get(base)
    if desc is None:
        if base.startswith("(?P<") or base.startswith("(?<"):
            desc = "a named capture group"
        elif base.startswith("(?:"):
            desc = "a non-capturing group"
        elif base.startswith("(?"):
            desc = "an inline group construct"
        elif base.startswith("("):
            desc = "a capture group"
        elif base.startswith("["):
            desc = "a character class " + base
        elif base.startswith("\\"):
            desc = "literal " + base[1:]
        else:
            desc = "literal '%s'" % base
    rep = {
        "*": " (zero or more)", "+": " (one or more)", "?": " (optional)",
        "*?": " (zero or more, lazy)", "+?": " (one or more, lazy)",
        "??": " (optional, lazy)",
    }
    suffix = rep.get(quant, (" (repeated %s)" % quant) if quant else "")
    return desc + suffix


def _strip_quantifier(atom):
    for q in ("*?", "+?", "??", "*", "+", "?"):
        if atom.endswith(q) and len(atom) > len(q):
            return atom[:-len(q)]
    if atom.endswith("}") and "{" in atom:
        return atom[:atom.rfind("{")]
    return atom


def _group_inner(atom):
    """If `atom` is a descendable group — (...), (?:...), (?P<name>...) — return
    its inner pattern (parens dropped) so diff_miss can localize one level
    deeper. Lookarounds and other inline constructs return None (their parens
    change match semantics, so we don't descend)."""
    base = _strip_quantifier(atom)
    if not (base.startswith("(") and base.endswith(")")):
        return None
    inner = base[1:-1]
    if inner.startswith("?P<"):
        gt = inner.find(">")
        return inner[gt + 1:] if gt != -1 else None
    if inner.startswith("?:"):
        return inner[2:]
    if inner.startswith("?"):
        return None  # lookaround / flags / other construct — not safe to descend
    return inner  # plain capturing group


def _localize_prefix(prefix, atoms, line, flag_bits):
    """Greedily extend `prefix` (a regex string already matching the start of
    `line`) by `atoms`, returning (matched_atoms, matched_upto)."""
    matched_atoms, matched_upto = 0, 0
    m0 = None
    try:
        m0 = re.compile(prefix, flag_bits).match(line) if prefix else None
    except re.error:
        m0 = None
    if m0:
        matched_upto = m0.end()
    for k in range(1, len(atoms) + 1):
        sub = prefix + "".join(atoms[:k])
        try:
            c = re.compile(sub, flag_bits)
        except re.error:
            continue
        m = c.match(line)
        if m:
            matched_atoms, matched_upto = k, m.end()
        else:
            break
    return matched_atoms, matched_upto


def _action_explain(pattern):
    compiled, norm, err = _compile(pattern or "", "")
    tokens = [{"text": a, "desc": _describe_atom(a)} for a in _tokenize_pattern(pattern or "")]
    named = []
    if compiled is not None:
        named = sorted(compiled.groupindex.keys(), key=lambda k: compiled.groupindex[k])
    out = {"ok": err is None, "pattern": pattern or "", "tokens": tokens, "named_groups": named}
    if err is not None:
        out["error"] = err["error"]
        out["error_pos"] = err["error_pos"]
    return out


def _action_diff_miss(pattern, line_idx, flags):
    state = _load_state()
    lines = state["samples"]
    if not isinstance(line_idx, int) or not (0 <= line_idx < len(lines)):
        raise ValueError("line_idx out of range")
    line = lines[line_idx]
    compiled, norm, err = _compile(pattern or "", flags)
    if err is not None:
        return err
    if compiled.search(line):
        return {"ok": True, "missed": False, "line_idx": line_idx, "line_text": line}

    flag_bits, _ = _parse_flags(flags)
    atoms = _tokenize_pattern(pattern or "")
    matched_atoms, matched_upto = _localize_prefix("", atoms, line, flag_bits)
    culprit = atoms[matched_atoms] if matched_atoms < len(atoms) else None

    # Descend one level into a culprit group so we point at the exact construct
    # that diverges (e.g. `\.` inside the timestamp group), not the whole group.
    if culprit is not None:
        inner_pat = _group_inner(culprit)
        if inner_pat:
            prefix = "".join(atoms[:matched_atoms])
            inner_atoms = _tokenize_pattern(inner_pat)
            inner_matched, inner_upto = _localize_prefix(prefix, inner_atoms, line, flag_bits)
            if inner_matched < len(inner_atoms):
                culprit = inner_atoms[inner_matched]
                matched_upto = max(matched_upto, inner_upto)

    rest = line[matched_upto:matched_upto + 16]
    hint = (
        "Matched up to character %d (%r); then %r could not match %r."
        % (matched_upto, line[:matched_upto][-24:], culprit, rest)
    ) if culprit else "Pattern partially matched but did not anchor at the start."
    return {
        "ok": True,
        "missed": True,
        "line_idx": line_idx,
        "line_text": line,
        "matched_atoms": matched_atoms,
        "total_atoms": len(atoms),
        "matched_upto": matched_upto,
        "culprit_atom": culprit,
        "hint": hint,
    }


def _flag_to_python(norm):
    names = {"i": "re.IGNORECASE", "m": "re.MULTILINE", "s": "re.DOTALL",
             "x": "re.VERBOSE", "a": "re.ASCII"}
    parts = [names[c] for c in norm if c in names]
    return " | ".join(parts)


def _py_to_js_pattern(pattern):
    # Python named groups (?P<name>...) -> JS (?<name>...); backrefs (?P=name) -> \k<name>
    p = re.sub(r"\(\?P<([A-Za-z_][A-Za-z0-9_]*)>", r"(?<\1>", pattern or "")
    p = re.sub(r"\(\?P=([A-Za-z_][A-Za-z0-9_]*)\)", r"\\k<\1>", p)
    return p


def _action_export(pattern, flags, target):
    pattern = pattern or ""
    target = (target or "python").lower()
    compiled, norm, err = _compile(pattern, flags)
    named = []
    if compiled is not None:
        named = sorted(compiled.groupindex.keys(), key=lambda k: compiled.groupindex[k])
    legend = ("# capture groups: " + ", ".join(named)) if named else "# (no named groups)"

    if target in ("python", "py"):
        flag_expr = _flag_to_python(norm)
        flag_arg = (", " + flag_expr) if flag_expr else ""
        snippet = (
            "import re\n\n"
            "%s\n"
            "pattern = re.compile(r'''%s'''%s)\n\n"
            "for line in lines:\n"
            "    m = pattern.search(line)\n"
            "    if m:\n"
            "        print(m.groupdict())\n"
        ) % (legend, pattern, flag_arg)
        return {"ok": err is None, "target": "python", "pattern": pattern,
                "flags": norm, "snippet": snippet, "named_groups": named, "error": (err or {}).get("error")}

    if target in ("javascript", "js", "node"):
        js_pattern = _py_to_js_pattern(pattern)
        js_flags = "".join([c for c in norm if c in "ims"]) + "g"
        dropped = [c for c in norm if c in "xa"]
        note = ("// note: dropped unsupported flag(s) %s — JS regex has no equivalent\n" % "".join(dropped)) if dropped else ""
        snippet = (
            "%s"
            "// capture groups: %s\n"
            "const re = /%s/%s;\n\n"
            "for (const line of lines) {\n"
            "  const m = line.match(re);\n"
            "  if (m) console.log(m.groups);\n"
            "}\n"
        ) % (note, ", ".join(named) or "(none)", js_pattern.replace("/", "\\/"), js_flags)
        return {"ok": err is None, "target": "javascript", "pattern": js_pattern,
                "flags": js_flags, "snippet": snippet, "named_groups": named, "error": (err or {}).get("error")}

    if target in ("ripgrep", "rg"):
        rg_flags = "".join([c for c in norm if c in "ims"])
        flag_part = ("(?%s)" % rg_flags) if rg_flags else ""
        snippet = (
            "# ripgrep (PCRE2). Named groups (?P<name>) are supported.\n"
            "%s\n"
            "rg -oP '%s%s' yourfile.log\n"
        ) % (legend, flag_part, pattern.replace("'", "'\\''"))
        return {"ok": err is None, "target": "ripgrep", "pattern": pattern,
                "flags": norm, "snippet": snippet, "named_groups": named, "error": (err or {}).get("error")}

    if target == "grep":
        gr_flags = "".join([c for c in norm if c in "i"])
        opt = "-oP" + (gr_flags and " -i" or "")
        snippet = (
            "# GNU grep with PCRE (-P). On macOS use ripgrep or the Python snippet.\n"
            "%s\n"
            "grep %s '%s' yourfile.log\n"
        ) % (legend, opt, pattern.replace("'", "'\\''"))
        return {"ok": err is None, "target": "grep", "pattern": pattern,
                "flags": norm, "snippet": snippet, "named_groups": named, "error": (err or {}).get("error")}

    raise ValueError("unknown export target: %r (python|javascript|ripgrep|grep)" % target)


def _action_get_state():
    state = _load_state()
    return {
        "samples": state["samples"],
        "count": len(state["samples"]),
        "last_pattern": state.get("last_pattern", ""),
        "last_flags": state.get("last_flags", ""),
    }


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

def tool_forge(action=None, pattern="", flags="", lines=None, samples=None,
               line_idx=None, target="python", **_ignored):
    if action == "set_samples":
        return _action_set_samples(lines if lines is not None else [])
    if action == "test_pattern":
        return _action_test_pattern(pattern, flags, samples)
    if action == "explain":
        return _action_explain(pattern)
    if action == "diff_miss":
        return _action_diff_miss(pattern, line_idx, flags)
    if action == "export":
        return _action_export(pattern, flags, target)
    if action == "get_state":
        return _action_get_state()
    raise ValueError(
        "unknown action: %r; expected set_samples | test_pattern | explain | "
        "diff_miss | export | get_state" % action
    )


TOOL_DISPATCH = {"forge": tool_forge}


# ---------------------------------------------------------------------------
# JSON-RPC handlers
# ---------------------------------------------------------------------------

def handle_describe(_params):
    return MANIFEST


def handle_invoke(params):
    tool_name = params.get("tool")
    args = params.get("arguments") or {}
    if not isinstance(args, dict):
        raise ValueError("`arguments` must be an object")
    fn = TOOL_DISPATCH.get(tool_name)
    if fn is None:
        raise ValueError("unknown tool: %r" % tool_name)
    # Executa runtime expects InvokeResult: {"success": true, "data": <payload>}.
    try:
        payload = fn(**args)
    except Exception as exc:  # noqa: BLE001 — surface as a tool error, not a crash
        return {"success": False, "error": "%s: %s" % (type(exc).__name__, exc)}
    return {"success": True, "data": payload}


def handle_health(_params):
    return {"status": "ok", "state_file": str(STATE_FILE)}


METHOD_DISPATCH = {
    "describe": handle_describe,
    "invoke": handle_invoke,
    "health": handle_health,
}


# ---------------------------------------------------------------------------
# Stdio loop
# ---------------------------------------------------------------------------

def send(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    print(
        "[regex-forge] %s v%s ready" % (MANIFEST["display_name"], MANIFEST["version"]),
        file=sys.stderr,
    )
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            send({"jsonrpc": "2.0", "id": None,
                  "error": {"code": -32700, "message": "parse error: %s" % e}})
            continue
        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        handler = METHOD_DISPATCH.get(method)
        if handler is None:
            send({"jsonrpc": "2.0", "id": req_id,
                  "error": {"code": -32601, "message": "method not found: %s" % method}})
            continue
        try:
            result = handler(params)
            send({"jsonrpc": "2.0", "id": req_id, "result": result})
        except Exception as exc:  # noqa: BLE001
            send({"jsonrpc": "2.0", "id": req_id,
                  "error": {"code": -32000, "message": str(exc)}})


if __name__ == "__main__":
    main()
