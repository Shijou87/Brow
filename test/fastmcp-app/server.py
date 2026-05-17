from __future__ import annotations

import hashlib
import mimetypes
from pathlib import Path
from typing import Annotated

from fastmcp import FastMCP
from fastmcp.apps import AppConfig, ResourceCSP
from pydantic import Field
from starlette.requests import Request
from starlette.responses import FileResponse, PlainTextResponse, Response

SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8000
SERVER_ORIGIN = f"http://{SERVER_HOST}:{SERVER_PORT}"
THREE_VERSION = "0.181.1"
VIEW_URI = "ui://threejs-demo/view.html"

ROOT_DIR = Path(__file__).resolve().parent
APP_DIR = ROOT_DIR / "app"
ASSETS_DIR = ROOT_DIR / "assets"

ASSET_HEADERS = {
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
}

mcp = FastMCP("ThreeJS Demo Server")


def _resolve_asset(asset_path: str) -> Path | None:
    normalized = asset_path.strip().lstrip("/")
    if not normalized:
        return None

    candidate = (ASSETS_DIR / normalized).resolve()
    if ASSETS_DIR.resolve() not in candidate.parents:
        return None
    if not candidate.is_file():
        return None
    return candidate


def _guess_media_type(file_path: Path) -> str:
    if file_path.suffix == ".js":
        return "text/javascript; charset=utf-8"
    guessed, _ = mimetypes.guess_type(file_path.name)
    return guessed or "application/octet-stream"


@mcp.tool(
    app=AppConfig(resource_uri=VIEW_URI, visibility=["model"]),
    annotations={"readOnlyHint": True, "openWorldHint": False},
)
def render_threejs_scene(
    script: Annotated[
        str,
        Field(
            description=(
                "JavaScript scene-body code for the MCP app view. "
                "The code runs with prebound locals (`THREE`, `scene`, `camera`, "
                "`renderer`, `controls`, `canvas`, `clock`, `setAnimationLoop`, "
                "`addCleanup`) and should only build or animate the scene. "
                "Do not use import/export statements, create your own host page, "
                "or bootstrap another application shell."
            ),
            min_length=1,
        ),
    ],
    title: Annotated[
        str | None,
        Field(description="Optional title shown in the MCP app header."),
    ] = None,
) -> dict[str, str]:
    """Render a Three.js scene in an inline MCP app view."""
    scene_title = title.strip() if title and title.strip() else "Untitled Scene"
    script_digest = hashlib.sha256(script.encode("utf-8")).hexdigest()[:12]
    return {
        "status": "accepted",
        "sceneTitle": scene_title,
        "renderer": f"threejs-{THREE_VERSION}",
        "scriptDigest": script_digest,
    }


@mcp.resource(
    VIEW_URI,
    app=AppConfig(
        csp=ResourceCSP(resource_domains=[SERVER_ORIGIN]),
    ),
)
def scene_view() -> str:
    return (APP_DIR / "scene-view.html").read_text(encoding="utf-8")


@mcp.custom_route("/assets/{asset_path:path}", methods=["GET", "OPTIONS"])
async def serve_asset(request: Request) -> Response:
    if request.method == "OPTIONS":
        return Response(status_code=204, headers=ASSET_HEADERS)

    asset_path = request.path_params.get("asset_path", "")
    file_path = _resolve_asset(asset_path)
    if file_path is None:
        return PlainTextResponse("Asset not found", status_code=404)

    return FileResponse(
        file_path,
        media_type=_guess_media_type(file_path),
        headers=ASSET_HEADERS,
    )


if __name__ == "__main__":
    mcp.run(transport="http", host=SERVER_HOST, port=SERVER_PORT)
