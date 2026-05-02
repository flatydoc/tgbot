FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
# На Railway/Fly подключите том и задайте тот же путь в переменной окружения DATA_DIR
ENV DATA_DIR=/data

RUN mkdir -p /data
VOLUME ["/data"]

CMD ["node", "src/index.js"]
