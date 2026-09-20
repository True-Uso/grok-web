FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git docker.io \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://x.ai/cli/install.sh | GROK_BIN_DIR=/usr/local/bin bash \
  && grok --version

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.mjs runtime.mjs store.mjs zip.mjs ./
COPY public ./public

ENV GROK_WEB_HOST=0.0.0.0
ENV GROK_WEB_PORT=8787
ENV GROK_BIN=/usr/local/bin/grok

EXPOSE 8787

CMD ["node", "server.mjs"]
