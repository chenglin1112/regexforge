"""
Contract tests for the regex-forge Executa engine.

These assert the deterministic ground truth the RegexForge UI depends on:
exact per-line match offsets, named-group spans, structured compile errors,
the "why did this miss" localizer, and the export snippets. Run with:

    uv run --with pytest pytest tests/plugin -q      # from the app root
"""

import importlib.util
import json
from pathlib import Path

import pytest

PLUGIN = Path(__file__).resolve().parents[2] / "executas" / "regex-forge" / "regex_forge_plugin.py"
_spec = importlib.util.spec_from_file_location("regex_forge_plugin", PLUGIN)
rf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rf)

TS = r"^(?P<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+(?P<level>INFO|WARN|ERROR|DEBUG)\s+req=(?P<req_id>[0-9a-f-]{36})"
TS_COMMA = TS.replace(r"\.", "[.,]")
DOT_LINE = "2026-06-16T09:21:03.114Z INFO req=550e8400-e29b-41d4-a716-446655440000 GET /x"
COMMA_LINE = "2026-06-16T09:21:07,250Z INFO req=6ba7b810-9dad-11d1-80b4-00c04fd430c8 GET /y"


@pytest.fixture(autouse=True)
def tmp_state(tmp_path, monkeypatch):
    """Isolate persisted state in a temp dir so tests never touch ~/.anna."""
    monkeypatch.setattr(rf, "STATE_DIR", tmp_path / "rf")
    monkeypatch.setattr(rf, "STATE_FILE", tmp_path / "rf" / "state.json")


def invoke(action, **args):
    """Drive the JSON-RPC `invoke` handler exactly like the host does."""
    res = rf.handle_invoke({"tool": "forge", "arguments": {"action": action, **args}})
    assert res["success"] is True, res
    return res["data"]


# --- protocol --------------------------------------------------------------

def test_describe_exposes_single_forge_tool():
    m = rf.handle_describe({})
    assert [t["name"] for t in m["tools"]] == ["forge"]
    assert m["runtime"]["type"] == "uv"


def test_invoke_wraps_invokeresult_shape():
    res = rf.handle_invoke({"tool": "forge", "arguments": {"action": "get_state"}})
    assert res == {"success": True, "data": res["data"]}
    assert set(res["data"]) >= {"samples", "count", "last_pattern"}


def test_unknown_action_is_a_tool_error_not_a_crash():
    res = rf.handle_invoke({"tool": "forge", "arguments": {"action": "nope"}})
    assert res["success"] is False and "unknown action" in res["error"]


# --- engine: matching is ground truth --------------------------------------

def test_set_samples_then_test_pattern_offsets():
    assert invoke("set_samples", lines=[DOT_LINE, COMMA_LINE])["count"] == 2
    d = invoke("test_pattern", pattern=TS)
    assert d["ok"] is True
    assert d["match_count"] == 1 and d["total"] == 2
    assert d["group_names"] == ["ts", "level", "req_id"]
    # line 0 matches with exact named-group spans
    row0 = d["results"][0]
    assert row0["matched"] is True
    groups = {g["name"]: (g["start"], g["end"], g["text"]) for g in row0["matches"][0]["groups"]}
    assert groups["ts"] == (0, 24, "2026-06-16T09:21:03.114Z")
    assert groups["level"][2] == "INFO"
    assert groups["req_id"][2] == "550e8400-e29b-41d4-a716-446655440000"
    # the comma-millis line is NOT matched by a dot pattern — the whole point
    assert d["results"][1]["matched"] is False


def test_repair_widens_to_match_all():
    invoke("set_samples", lines=[DOT_LINE, COMMA_LINE])
    d = invoke("test_pattern", pattern=TS_COMMA)
    assert d["match_count"] == 2 and d["total"] == 2


def test_inline_samples_override_and_persist():
    d = invoke("test_pattern", pattern=r"(?P<n>\d+)", samples=["a 1", "b 22", "c"])
    assert d["match_count"] == 2 and d["total"] == 3
    # samples persisted for the next call
    assert invoke("get_state")["count"] == 3


# --- engine: compile errors are structured, never thrown -------------------

def test_compile_error_is_structured():
    invoke("set_samples", lines=[DOT_LINE])
    d = invoke("test_pattern", pattern=r"(?P<bad>\d{3}")  # missing )
    assert d["ok"] is False
    assert "error" in d and isinstance(d["error_pos"], int)


# --- diff_miss: localizes the exact divergence -----------------------------

def test_diff_miss_points_at_the_comma():
    invoke("set_samples", lines=[DOT_LINE, COMMA_LINE])
    d = invoke("diff_miss", pattern=TS, line_idx=1)
    assert d["missed"] is True
    # matched through the seconds, then `\.` fails at the comma (char 19)
    assert d["matched_upto"] == 19
    assert d["culprit_atom"] == r"\."


def test_diff_miss_reports_no_miss_when_it_matches():
    invoke("set_samples", lines=[DOT_LINE])
    d = invoke("diff_miss", pattern=TS, line_idx=0)
    assert d["missed"] is False


# --- export: ready-to-run snippets -----------------------------------------

@pytest.mark.parametrize("target,needle", [
    ("python", "re.compile"),
    ("javascript", "const re ="),
    ("ripgrep", "rg -oP"),
    ("grep", "grep"),
])
def test_export_targets(target, needle):
    d = invoke("export", pattern=r"req=(?P<id>[0-9a-f-]{36})", target=target)
    assert d["ok"] is True
    assert needle in d["snippet"]
    assert "id" in d["named_groups"]


def test_export_javascript_converts_named_groups():
    d = invoke("export", pattern=r"(?P<n>\d+)", target="javascript")
    assert "(?<n>" in d["pattern"]  # Python (?P<n>) -> JS (?<n>)
    assert "(?P<" not in d["pattern"]
