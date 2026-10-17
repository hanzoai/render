# Hanzo render: Node 24 runs src/main.ts as written (type stripping, no build).
#
# Chrome is Debian's chromium-headless-shell: one package for amd64 and arm64
# (Chrome for Testing ships no linux-arm64), kept current by bookworm-security,
# and the headless shell is what @hanzo/frames captures with. puppeteer and
# frames both run it from CHROME_PATH. ffmpeg encodes; the fonts are what
# documents, slides and captions draw with.
FROM node:24-bookworm-slim

LABEL org.opencontainers.image.source=https://github.com/hanzoai/render

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates chromium-headless-shell ffmpeg \
      fonts-noto-core fonts-noto-mono fonts-noto-color-emoji \
      fonts-dejavu-core fonts-liberation2 fonts-inter \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# No install scripts run. onnxruntime-node (a frames dependency render never
# loads) ships prebuilt binaries for six platforms; only this one's is kept.
RUN npm ci --omit=dev --ignore-scripts \
 && cd node_modules/onnxruntime-node/bin/napi-v3 \
 && find . -mindepth 2 -maxdepth 2 ! -path "./linux/$(node -p process.arch)" -exec rm -rf {} + \
 && rm -rf /root/.npm
COPY bin ./bin
COPY src ./src

# Every write lands under TMPDIR (an emptyDir in the pod), so a read-only root
# filesystem works; HOME points there for Chrome's and fontconfig's caches.
ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium-headless-shell \
    TMPDIR=/tmp \
    HOME=/tmp
USER node
CMD ["node", "src/main.ts"]
