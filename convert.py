import ctypes as C
import ctypes.util
import gzip
import io
import hashlib
import os
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageColor


def tgs_frames(data, fps):
    build = Path(__file__).resolve().parent / ".stickers" / "rlottie-build"
    bundled = next((path for pattern in ("librlottie.dylib", "librlottie.so", "rlottie.dll")
                    for path in build.rglob(pattern)), None)
    library = (os.getenv("RLOTTIE_LIBRARY") or bundled or C.util.find_library("rlottie")
               or next(iter(Path("/opt/homebrew/lib").glob("librlottie.dylib")), None))
    if not library:
        raise ValueError("请安装 rlottie 或设置 RLOTTIE_LIBRARY")
    lib = C.CDLL(str(library))
    pointer, size = C.c_void_p, C.c_size_t
    signatures = {
        "from_data": (pointer, [C.c_char_p] * 3),
        "get_size": (None, [pointer, C.POINTER(size), C.POINTER(size)]),
        "get_totalframe": (size, [pointer]),
        "get_framerate": (C.c_double, [pointer]),
        "render": (None, [pointer, size, pointer, size, size, size]),
        "destroy": (None, [pointer]),
    }
    calls = {}
    for name, (result, args) in signatures.items():
        function = getattr(lib, "lottie_animation_" + name)
        function.restype, function.argtypes = result, args
        calls[name] = function
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as source:
        raw = source.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError("TGS 文件过大")
    animation = calls["from_data"](raw, hashlib.sha256(raw).hexdigest().encode(), b"")
    if not animation:
        raise ValueError("TGS 无法解析")
    try:
        width, height = size(), size()
        calls["get_size"](animation, C.byref(width), C.byref(height))
        w, h = width.value, height.value
        count = calls["get_totalframe"](animation)
        rate = calls["get_framerate"](animation)
        if not (0 < w <= 512 and 0 < h <= 512 and 0 < rate <= 120
                and 0 < count <= rate * 10):
            raise ValueError("TGS 尺寸或时长超出范围")
        total = round(count / rate * 1000)
        frames = []
        for index in range(max(1, round(count / rate * fps))):
            buffer = C.create_string_buffer(w * h * 4)
            calls["render"](animation, min(count - 1, int(index * rate / fps)),
                            buffer, w, h, w * 4)
            frames.append(Image.frombytes("RGBa", (w, h), buffer.raw, "raw", "BGRa").convert("RGBA"))
        return frames, total
    finally:
        calls["destroy"](animation)


def webm_frames(data, fps):
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "source.webm"
        source.write_bytes(data)
        try:
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-c:v", "libvpx-vp9",
                            "-i", str(source), "-an", "-t", "10", "-vf", f"fps={fps}",
                            "-threads", "1", str(Path(directory) / "%04d.png")],
                           check=True, timeout=25, capture_output=True)
        except FileNotFoundError:
            raise ValueError("请安装 FFmpeg") from None
        except (subprocess.SubprocessError, OSError):
            raise ValueError("WEBM 解码失败") from None
        frames = []
        for path in sorted(Path(directory).glob("*.png")):
            with Image.open(path) as frame:
                frames.append(frame.convert("RGBA"))
        if not frames:
            raise ValueError("WEBM 没有可用画面")
        return frames, round(len(frames) * 1000 / fps)


def transform(frame, edge, background):
    if edge:
        frame = frame.copy()
        frame.thumbnail((edge, edge), Image.Resampling.LANCZOS)
    width, height = frame.size
    fill = (0, 0, 0, 0) if background == "transparent" else ImageColor.getrgb(background) + (255,)
    canvas = Image.new("RGBA", (edge, edge) if edge else frame.size, fill)
    canvas.alpha_composite(frame, ((canvas.width - width) // 2, (canvas.height - height) // 2))
    return canvas


def convert(data, kind, edge=0, background="transparent", still=False, budget=0):
    fps = 20 if budget else 30
    if kind == "TGS":
        frames, total = tgs_frames(data, fps)
    elif kind == "WEBM":
        frames, total = webm_frames(data, fps)
    else:
        with Image.open(io.BytesIO(data)) as image:
            frames = [image.convert("RGBA")]
        still = True
    if still:
        output = io.BytesIO()
        transform(frames[0], edge, background).save(output, "PNG")
        return "png", output.getvalue()
    attempts = [(edge, 1, 255)]
    if budget:
        attempts += [(edge, 2, 127), (max(64, edge // 2), 2, 95),
                     (max(48, edge // 4), 4, 63)]
    for size, step, colors in attempts:
        images = []
        durations = []
        for index in range(0, len(frames), step):
            rgba = transform(frames[index], size, background)
            palette = rgba.convert("RGB").quantize(colors=colors)
            mask = rgba.getchannel("A").point(lambda alpha: 255 if alpha < 128 else 0)
            palette.paste(255, mask=mask)
            images.append(palette)
            start = round(total * index / len(frames) / 10)
            end = round(total * min(index + step, len(frames)) / len(frames) / 10)
            durations.append(max(10, (end - start) * 10))
        output = io.BytesIO()
        images[0].save(output, "GIF", save_all=True, append_images=images[1:],
                       duration=durations, loop=0, disposal=2, transparency=255, optimize=False)
        if not budget or output.tell() <= budget:
            return "gif", output.getvalue()
    raise ValueError("无法压缩到目标大小，请提高体积上限")
