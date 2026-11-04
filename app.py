import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
import uuid
import zipfile
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, SecretStr
from typing import Literal, Optional

from convert import convert

ROOT = Path(__file__).resolve().parent
DATA = ROOT / ".stickers"
CACHE = DATA / "cache"
CACHE.mkdir(parents=True, exist_ok=True)
OUTPUT = Path(os.getenv("STICKER_OUTPUT", str(DATA / "exports"))).resolve()
CAN_OPEN_FOLDER = os.getenv("STICKER_CONTAINER") != "1"
app = FastAPI()
jobs = {}
workers = asyncio.Semaphore(3)
thumbnail_workers = asyncio.Semaphore(3)


@app.middleware("http")
async def local_only(request: Request, call_next):
    if request.url.hostname not in {"localhost", "127.0.0.1", "::1"}:
        return Response(status_code=403)
    if request.method == "POST" and request.headers.get("origin") not in {
        None, f"{request.url.scheme}://{request.url.netloc}"
    }:
        return Response(status_code=403)
    return await call_next(request)


class Connection(BaseModel):
    token: SecretStr
    proxy: Optional[SecretStr] = None


class Import(Connection):
    links: list[str] = Field(min_length=1, max_length=30)


class Sticker(BaseModel):
    id: str = Field(min_length=1, max_length=256)
    pack: str = Field(pattern=r"^[a-zA-Z0-9_]{1,64}$")
    index: int = Field(ge=1, le=10000)
    kind: Literal["WEBP", "WEBM", "TGS"]
    emoji: str = Field(default="", max_length=32)


class Export(Connection):
    stickers: list[Sticker] = Field(min_length=1, max_length=2000)
    mode: Literal["normal", "qq"]
    edge: Literal[128, 256, 512] = 256
    background: str = Field(default="transparent", pattern=r"^(transparent|#[0-9a-fA-F]{6})$")
    still: bool = False
    max_kb: int = Field(default=500, ge=32, le=5000)


def client(config):
    try:
        return httpx.AsyncClient(proxy=config.proxy.get_secret_value() if config.proxy else None,
                                 timeout=25, trust_env=False)
    except (ValueError, ImportError):
        raise HTTPException(400, "代理设置无效") from None


async def telegram(http, config, method, **params):
    token = config.token.get_secret_value()
    if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]+", token):
        raise ValueError("Bot Token 格式无效")
    try:
        for attempt in range(3):
            response = await http.post(f"https://api.telegram.org/bot{token}/{method}", json=params)
            if response.status_code == 429 and attempt < 2:
                await asyncio.sleep(min(30, response.json().get("parameters", {}).get("retry_after", 1)))
                continue
            break
        result = response.json()
    except (httpx.HTTPError, ValueError):
        raise ValueError("无法连接 Telegram，请检查网络和代理") from None
    if not result.get("ok"):
        if response.status_code in (401, 404):
            raise ValueError("Telegram 未接受 Bot Token 或请求")
        raise ValueError("Telegram 请求失败，请检查表情包链接或稍后重试")
    return result["result"]


async def download(http, config, file_id):
    cache_key = hashlib.sha256(file_id.encode()).hexdigest()
    path = CACHE / cache_key
    if path.exists():
        return path.read_bytes()
    meta = await telegram(http, config, "getFile", file_id=file_id)
    file_path = meta.get("file_path")
    if not file_path:
        raise ValueError("Telegram 未返回下载路径")
    token = config.token.get_secret_value()
    try:
        async with http.stream("GET", f"https://api.telegram.org/file/bot{token}/{quote(file_path)}") as response:
            response.raise_for_status()
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > 4_000_000:
                    raise ValueError("贴纸文件过大")
    except httpx.HTTPError:
        raise ValueError("贴纸下载失败") from None
    temporary = path.with_name(uuid.uuid4().hex + ".tmp")
    temporary.write_bytes(data)
    temporary.replace(path)
    return bytes(data)


@app.post("/api/import")
async def import_packs(config: Import):
    packs, errors, seen = [], [], set()
    async with client(config) as http:
        for link in config.links:
            match = re.fullmatch(r"(?:https?://)?(?:t\.me|telegram\.me)/addstickers/([A-Za-z0-9_]{1,64})/?(?:[?#].*)?", link.strip())
            if not match:
                errors.append("链接格式有误，请使用 t.me/addstickers/…")
                continue
            name = match[1]
            if name.lower() in seen:
                continue
            seen.add(name.lower())
            try:
                result = await telegram(http, config, "getStickerSet", name=name)
            except ValueError as error:
                errors.append(f"{name}：{error}")
                continue
            stickers = []
            for index, item in enumerate(result["stickers"], 1):
                kind = "TGS" if item.get("is_animated") else "WEBM" if item.get("is_video") else "WEBP"
                stickers.append(dict(id=item["file_id"], pack=name, index=index, kind=kind,
                                     emoji=item.get("emoji", ""), thumb=item.get("thumbnail", {}).get("file_id")))
            packs.append(dict(name=name, title=result["title"], stickers=stickers))
    return dict(packs=packs, errors=errors)


class Preview(Connection):
    id: str = Field(min_length=1, max_length=256)
    kind: Literal["WEBP", "WEBM", "TGS"]
    still: bool = True


@app.post("/api/preview")
async def preview(config: Preview):
    limiter = thumbnail_workers if config.still else workers
    try:
        async with limiter, client(config) as http:
            data = await download(http, config, config.id)
            extension, result = await asyncio.to_thread(convert, data, config.kind, 128, "transparent", config.still)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    except OSError:
        raise HTTPException(422, "无法读取贴纸或加载转换依赖") from None
    return Response(result, media_type=f"image/{extension}")


def pack_archive(folder, state, mode):
    manifest = {"mode": mode, "items": state["items"]}
    (folder / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    if mode == "qq":
        (folder / "QQ 导入说明.txt").write_text(
            "解压后，在目标 QQ 客户端的表情面板里添加自定义表情。请选择 PNG/GIF 文件。"
            "具体操作和批量选择能力取决于客户端版本。\n", encoding="utf-8")
    with zipfile.ZipFile(folder / "stickers.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for path in folder.rglob("*"):
            if path.is_file() and path.name != "stickers.zip":
                archive.write(path, path.relative_to(folder))


async def run_export(job_id, config, state):
    folder = OUTPUT / job_id
    try:
        folder.mkdir(parents=True, exist_ok=False)
        async with client(config) as http:
            async def process(sticker, item):
                async with workers:
                    if state["cancel"]:
                        item.update(status="cancelled")
                        return
                    item.update(status="downloading")
                    try:
                        data = await download(http, config, sticker.id)
                        if state["cancel"]:
                            item.update(status="cancelled")
                            return
                        item.update(status="converting")
                        qq = config.mode == "qq"
                        ext, output = await asyncio.to_thread(
                            convert, data, sticker.kind, config.edge if qq else 0,
                            config.background, config.still, config.max_kb * 1024 if qq else 0)
                        if state["cancel"]:
                            item.update(status="cancelled")
                            return
                        path = Path(sticker.pack) / f"{sticker.index:03d}.{ext}"
                        (folder / path).parent.mkdir(exist_ok=True)
                        (folder / path).write_bytes(output)
                        item.update(status="done", file=path.as_posix(), bytes=len(output))
                    except ValueError as error:
                        item.update(status="failed", error=str(error))
                    except OSError:
                        item.update(status="failed", error="素材读取、转换或保存失败")
            await asyncio.gather(*(process(s, i) for s, i in zip(config.stickers, state["items"])))
        await asyncio.to_thread(pack_archive, folder, state, config.mode)
        state.update(status="cancelled" if state["cancel"] else "done", folder=str(folder), archive=True,
                     can_open_folder=CAN_OPEN_FOLDER)
    except Exception:
        state.update(status="failed", error="无法完成导出，请检查保存位置和磁盘空间")


@app.post("/api/jobs", status_code=202)
async def create_job(config: Export):
    keys = {(item.pack.lower(), item.index) for item in config.stickers}
    if len(keys) != len(config.stickers):
        raise HTTPException(422, "导出列表包含重复表情")
    job_id = uuid.uuid4().hex
    state = dict(status="running", cancel=False, items=[
        dict(pack=s.pack, index=s.index, kind=s.kind, emoji=s.emoji, status="queued",
             source=f"https://t.me/addstickers/{s.pack}") for s in config.stickers])
    jobs[job_id] = state
    task = asyncio.create_task(run_export(job_id, config, state))
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return {"id": job_id}


tasks = set()


@app.get("/api/jobs/{job_id}")
async def job_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404)
    return jobs[job_id]


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    state = await job_status(job_id)
    if state["status"] == "running":
        state["cancel"] = True
    return {"ok": True}


@app.post("/api/jobs/{job_id}/open")
async def open_folder(job_id: str):
    if not CAN_OPEN_FOLDER:
        raise HTTPException(422, "请从宿主机打开挂载的导出目录，或下载 ZIP")
    state = await job_status(job_id)
    if not state.get("folder"):
        raise HTTPException(404, "导出目录尚未就绪")
    folder = state["folder"]
    try:
        if sys.platform == "win32":
            os.startfile(folder)
        else:
            command = "open" if sys.platform == "darwin" else "xdg-open"
            result = await asyncio.to_thread(subprocess.run, [command, folder], capture_output=True, timeout=10)
            if result.returncode:
                raise OSError
    except (OSError, subprocess.SubprocessError):
        raise HTTPException(422, "无法打开目录，请手动打开界面显示的路径") from None
    return {"ok": True}


@app.get("/api/jobs/{job_id}/zip")
async def archive(job_id: str):
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        raise HTTPException(404)
    path = OUTPUT / job_id / "stickers.zip"
    if not path.is_file() or (job_id in jobs and not jobs[job_id].get("archive")):
        raise HTTPException(404)
    return FileResponse(path, filename="StickerSnatcher.zip")


if (ROOT / "dist").exists():
    app.mount("/", StaticFiles(directory=ROOT / "dist", html=True))
