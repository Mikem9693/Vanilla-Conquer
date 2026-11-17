# SPDX-License-Identifier: GPL-3.0-or-later
# Image for the multiplayer relay on Fly.io (see fly.toml).
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
USER node
CMD ["node", "server.js"]
