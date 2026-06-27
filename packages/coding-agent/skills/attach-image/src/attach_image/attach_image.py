"""Load on-disk images into the model's context as multimodal attachments."""

from __future__ import annotations

import base64
from pathlib import Path

# Keep in sync with ATTACHMENT_DISPLAY_MIME in src/core/kernel/index.ts.
_ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json"

# Base64 expands by ~4/3, so this stays well under MAX_ATTACHMENT_DATA_CHARS in
# src/core/kernel/index.ts; an emit over that ceiling fails the cell rather than
# being dropped, so a reported-loaded image always reaches the model.
_MAX_IMAGE_BYTES = 3_500_000

# Matches IMAGE_MIME_TYPES in src/utils/mime.ts.
_IMAGE_SIGNATURES = (
    ("image/png", b"\x89PNG\r\n\x1a\n"),
    ("image/jpeg", b"\xff\xd8\xff"),
    ("image/gif", b"GIF87a"),
    ("image/gif", b"GIF89a"),
)


def _detect_image_mime(data: bytes) -> str | None:
    for mime, prefix in _IMAGE_SIGNATURES:
        if data.startswith(prefix):
            return mime
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _validate_image(path: str) -> tuple[Path, str]:
    filepath = Path(path).expanduser()
    if not filepath.is_file():
        raise FileNotFoundError(f"{path} is not an existing regular file")
    size = filepath.stat().st_size
    if size > _MAX_IMAGE_BYTES:
        raise ValueError(
            f"{path} is {size // 1_000_000}MB; images must be under "
            f"{_MAX_IMAGE_BYTES // 1_000_000}MB. Resize it (e.g. with PIL) first."
        )
    with filepath.open("rb") as f:
        head = f.read(16)
    mime = _detect_image_mime(head)
    if mime is None:
        raise ValueError(
            f"{path} is not a supported image (PNG, JPEG, GIF, WebP). "
            "Only images can be loaded into context; open other files in the kernel instead."
        )
    return filepath, mime


def _emit_attachment(filepath: Path, mime_type: str) -> None:
    from IPython.display import display

    data_b64 = base64.b64encode(filepath.read_bytes()).decode("ascii")
    display(
        {
            _ATTACHMENT_DISPLAY_MIME: {"mime_type": mime_type, "data": data_b64, "path": str(filepath)},
            "text/plain": f"Loaded image into context: {filepath}",
        },
        raw=True,
    )


async def run(*paths: str) -> str:
    """Load one or more on-disk images into the model's context as attachments.

    Use this when the model needs to actually SEE an image file — a screenshot,
    diagram, chart, photo, or scanned page. The image is sent to the model as a
    viewable attachment (the same way a pasted image is).

    Do NOT use this for programmatic image analysis (reading pixels, cropping,
    resizing, hashing, measuring colors). For that, open the file with PIL in
    the kernel instead.

    Args:
        *paths: One or more image paths. Relative, absolute, or `~`-prefixed.
            Supported formats: PNG, JPEG, GIF, WebP. Other types (PDF, audio,
            video) are not supported and raise an error.

    Returns:
        A short confirmation listing the images loaded into context.

    Raises:
        FileNotFoundError: If a path does not exist or is not a regular file.
        ValueError: If a file is not a supported image or is too large.
        RuntimeError: If the current model cannot accept images.
    """
    if not paths:
        raise ValueError("attach_image requires at least one image path")

    from rlm import host_request

    info = await host_request("model.info")
    if "image" not in info.get("input", []):
        model_id = info.get("id") or "the current model"
        raise RuntimeError(
            f"{model_id} does not support vision. "
            "Tell the user to switch to a vision-capable model to load images into context."
        )

    # Validate every path before emitting anything (so a later failure never
    # leaves a partial subset injected), but read+encode one image at a time to
    # avoid holding every base64 payload in memory at once.
    validated = [_validate_image(path) for path in paths]
    for filepath, mime in validated:
        _emit_attachment(filepath, mime)

    return f"Loaded {len(validated)} image(s) into context: {', '.join(paths)}"
