# StickerSnatcher

本地批量导出 Telegram 贴纸。支持多个表情包链接、勾选与预览、PNG/GIF、QQ 图片适配、ZIP 下载和失败项重试。

## 用 Docker 启动

安装并启动 Docker 和 Compose，在项目目录运行：

```sh
docker compose up -d --build
```

打开 http://127.0.0.1:8765。镜像内包含前端、FFmpeg 和 rlottie。导出文件保存在宿主机的 `./exports` 目录，也可在页面下载 ZIP。原文件缓存保存在 Docker 数据卷中。停止服务可运行 `docker compose down`。

如果本机的 8765 端口已被占用，可用 `STICKER_PORT=8766 docker compose up -d --build`，然后打开 http://127.0.0.1:8766。若通过 Docker Desktop 使用宿主机上的 Telegram 代理，页面里的代理地址应使用 `host.docker.internal`，并确保代理允许来自容器的连接。

## 直接在本机启动

需要 Python 3.9+、Node.js 22.12+、FFmpeg（含 libvpx-vp9 解码器）及 rlottie 动态库。FFmpeg 用于 WEBM，rlottie 用于 TGS。FFmpeg 应在 PATH 上。若系统无法找到 rlottie，可设置 `RLOTTIE_LIBRARY` 为动态库的完整路径。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci
npm run build
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765
```

打开 http://127.0.0.1:8765。Windows 请将 `.venv/bin/python` 换为 `.venv\Scripts\python.exe`。

## 导出

1. 在 Telegram 里通过 @BotFather 创建 Bot，将 Token 填入工具。如需代理，可填 HTTP 或 SOCKS5 代理地址。
2. 粘贴一个或多个 `https://t.me/addstickers/包名`，读取后勾选需要的贴纸。
3. 普通模式保留原尺寸。QQ 模式提供方形画布和 GIF 体积上限，压缩时可能进一步缩小画布。两种模式都可为动画选择 GIF 或首帧 PNG。
4. 导出完成后下载 ZIP，或打开界面显示的本地目录。默认保存到 `.stickers/exports`，可在启动前设置 `STICKER_OUTPUT` 自定义目录。取消任务后仍可下载已完成的部分。

QQ 模式提供 PNG/GIF 和导入说明。解压后在 QQ 的自定义表情面板中添加图片，具体操作及批量添加能力取决于客户端版本。本工具生成的归档格式为 ZIP。

Token 随当前页面会话使用，不写入磁盘。原文件缓存位于 `.stickers/cache`。导出文件和结果清单会保存在磁盘，服务重启后需重新导入链接才能创建新任务。

### 从源码构建 rlottie

如系统没有现成的动态库，可使用 Git、CMake 和 C++ 编译工具在项目内构建。应用会自动查找下面生成的动态库。

```sh
git clone --depth 1 https://github.com/Samsung/rlottie.git .stickers/rlottie-src
cmake -S .stickers/rlottie-src -B .stickers/rlottie-build -DCMAKE_BUILD_TYPE=Release -DLOTTIE_MODULE=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_CXX_FLAGS=-U__ARM_NEON__
cmake --build .stickers/rlottie-build --config Release
```
