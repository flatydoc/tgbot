FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
# На Railway/Fly подключите том и задайте тот же путь в переменной окружения DATA_DIR
ENV DATA_DIR=/data

# Том /data подключайте в Railway Dashboard → Volumes (директива VOLUME в Dockerfile там запрещена)
RUN mkdir -p /data

CMD ["node", "src/index.js"]
