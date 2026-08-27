from pathlib import Path

from blue.cli import load_yaml

ROOT = Path(__file__).resolve().parents[2]
FIXTURE_FILE = ROOT / "test" / "fixtures" / "colors.yml"


def fixture(overrides: dict | None = None) -> dict:
    return {**load_yaml(FIXTURE_FILE.read_text()), **(overrides or {})}
