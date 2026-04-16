FROM node:18-slim

# 安装完整 ffmpeg（含所有编解码器）和 yt-dlp
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg curl ca-certificates && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 验证安装：ffmpeg 必须支持 h264 编解码
RUN echo "=== ffmpeg ===" && ffmpeg -version | head -1 \
    && echo "=== yt-dlp ===" && yt-dlp --version \
    && echo "=== h264 support ===" && ffmpeg -codecs 2>/dev/null | grep -i h264 | head -1 \
    && echo "=== aac support ===" && ffmpeg -codecs 2>/dev/null | grep -i aac | head -1

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public/

ENV NODE_ENV=production
ENV PORT=3003

EXPOSE 3003

CMD ["node", "server.js"]
