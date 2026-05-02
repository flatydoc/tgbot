FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV DATA_DIR=/data
# Railway подставляет свой PORT в рантайме; если нет — слушаем 8080 для healthcheck
ENV PORT=8080

# Том /data подключайте в Railway Dashboard → Volumes (директива VOLUME в Dockerfile там запрещена)
RUN mkdir -p /data

CMD ["node", "src/index.js"]
