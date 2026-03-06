import importlib
import sys
import warnings


def test_package_import_has_no_global_warning_side_effect(monkeypatch):
    calls = []

    def fake_filterwarnings(*args, **kwargs):
        calls.append((args, kwargs))

    monkeypatch.setattr(warnings, "filterwarnings", fake_filterwarnings)
    sys.modules.pop("otterai", None)

    importlib.import_module("otterai")

    assert calls == []
