"""
Configuration and credential management for OtterAI CLI.

Credentials are stored in ~/.otterai/config.json and can be
overridden with environment variables OTTERAI_USERNAME and OTTERAI_PASSWORD.
"""

import json
import os
from pathlib import Path
from typing import Optional

try:
    import keyring
except Exception:  # pragma: no cover - import fallback for minimal envs
    keyring = None

CONFIG_DIR = Path.home() / ".otterai"
CONFIG_FILE = CONFIG_DIR / "config.json"
SERVICE_NAME = "otterai-cli"
DEFAULT_REQUEST_TIMEOUT = 30.0


def _ensure_config_dir() -> None:
    """Create config directory if it doesn't exist."""
    CONFIG_DIR.mkdir(mode=0o700, exist_ok=True)


def _write_config(config: dict) -> None:
    """Write config payload to disk with secure permissions."""
    _ensure_config_dir()
    CONFIG_FILE.write_text(json.dumps(config, indent=2))
    CONFIG_FILE.chmod(0o600)


def _read_config() -> dict:
    """Read config payload from disk, returning empty dict on parse errors."""
    if not CONFIG_FILE.exists():
        return {}
    try:
        data = json.loads(CONFIG_FILE.read_text())
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError, TypeError):
        return {}


def get_request_timeout() -> float:
    """Get request timeout in seconds from environment with safe default."""
    timeout_value = os.getenv("OTTERAI_REQUEST_TIMEOUT")
    if not timeout_value:
        return DEFAULT_REQUEST_TIMEOUT
    try:
        timeout = float(timeout_value)
    except ValueError:
        return DEFAULT_REQUEST_TIMEOUT
    if timeout <= 0:
        return DEFAULT_REQUEST_TIMEOUT
    return timeout


def save_credentials(username: str, password: str) -> None:
    """Save credentials to config file."""
    use_keyring = False

    if keyring and username:
        try:
            keyring.set_password(SERVICE_NAME, username, password)
            use_keyring = True
        except Exception:
            use_keyring = False

    payload = {"username": username}
    if not use_keyring:
        payload["password"] = password

    _write_config(payload)


def load_credentials() -> tuple[Optional[str], Optional[str]]:
    """
    Load credentials from environment variables or config file.

    Environment variables take precedence over config file.

    Returns:
        Tuple of (username, password), either may be None if not found.
    """
    env_username = os.getenv("OTTERAI_USERNAME")
    env_password = os.getenv("OTTERAI_PASSWORD")

    config = _read_config()
    file_username = config.get("username")
    file_password = config.get("password")

    username = env_username if env_username else file_username

    password = env_password
    keyring_password = None
    if not password and username and keyring:
        try:
            keyring_password = keyring.get_password(SERVICE_NAME, username)
        except Exception:
            keyring_password = None

    if not password:
        if keyring_password:
            password = keyring_password
        elif file_password and (not env_username or env_username == file_username):
            password = file_password

    if keyring and file_username and file_password:
        try:
            stored = keyring.get_password(SERVICE_NAME, file_username)
            if not stored:
                keyring.set_password(SERVICE_NAME, file_username, file_password)
            _write_config({"username": file_username})
        except Exception:
            pass

    return username, password


def clear_credentials() -> bool:
    """
    Clear saved credentials.

    Returns:
        True if credentials were cleared, False if no config existed.
    """
    config = _read_config()
    username = config.get("username")
    cleared = False

    if keyring and username:
        try:
            keyring.delete_password(SERVICE_NAME, username)
            cleared = True
        except Exception:
            pass

    if CONFIG_FILE.exists():
        CONFIG_FILE.unlink()
        cleared = True

    return cleared


def get_config_path() -> Path:
    """Return the path to the config file."""
    return CONFIG_FILE
