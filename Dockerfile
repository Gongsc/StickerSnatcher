FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json ./
COPY web ./web
RUN npm run check && npm run build

FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 \
    STICKER_CONTAINER=1 \
    STICKER_OUTPUT=/exports
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg librlottie0-1 \
    && rm -rf /var/lib/apt/lists/* \
    && python -c 'import ctypes, ctypes.util; ctypes.CDLL(ctypes.util.find_library("rlottie")).lottie_animation_render'
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py convert.py ./
COPY --from=frontend /build/dist ./dist
EXPOSE 8765
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8765"]
