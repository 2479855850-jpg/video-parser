FROM node:18-slim

# 安装 yt-dlp + ffmpeg（不加 --no-install-recommends 确保编解码器完整）
RUN apt-get update && \
    apt-get install -y python3 ffmpeg curl ca-certificates && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 验证安装
RUN ffmpeg -version | head -1 && yt-dlp --version

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public/

ENV NODE_ENV=production
ENV PORT=3003

EXPOSE 3003

CMD ["node", "server.js"]
