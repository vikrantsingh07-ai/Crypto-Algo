"""Rotating file logging + concise terminal status lines. Secrets are redacted."""
import logging
import os
import re
from logging.handlers import RotatingFileHandler

_SECRET_PATTERNS = [
    re.compile(r"(api[-_ ]?key|secret|signature)(['\"]?\s*[:=]\s*['\"]?)([A-Za-z0-9+/=_\-]{6,})", re.I),
]


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        for pat in _SECRET_PATTERNS:
            msg = pat.sub(lambda m: f"{m.group(1)}{m.group(2)}***REDACTED***", msg)
        record.msg, record.args = msg, ()
        return True


def setup_logging(log_dir: str, level: str = "INFO") -> logging.Logger:
    os.makedirs(log_dir, exist_ok=True)
    root = logging.getLogger("bot")
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    if root.handlers:
        return root
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    fh = RotatingFileHandler(os.path.join(log_dir, "bot.log"), maxBytes=5_000_000, backupCount=5)
    fh.setFormatter(fmt)
    fh.addFilter(RedactingFilter())
    root.addHandler(fh)
    root.propagate = False
    return root


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"bot.{name}")


def say(tag: str, message: str) -> None:
    """Concise terminal line, also written to the log file."""
    line = f"[{tag}] {message}"
    print(line, flush=True)
    get_logger("terminal").info(line)
