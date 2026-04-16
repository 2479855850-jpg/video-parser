# Video Parser / 视频解析

A self-hosted web application to parse and download videos from **YouTube, Bilibili, Instagram, Twitter/X** and **1800+** other platforms. Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp).

一个自部署的视频解析下载工具，支持 YouTube、B站、Instagram、Twitter/X 等 1800+ 个平台。

---

## Features / 功能

- Paste any video link → get title, cover, preview & download
- Chat-style UI with dark theme
- Chinese / English language switch
- Cover image proxy (bypasses hotlink protection)
- Works on macOS / Linux / Windows

## Supported Platforms / 支持平台

| Platform | Status |
|----------|--------|
| YouTube (Videos / Shorts / Playlists) | Stable |
| Bilibili (Videos / Bangumi) | Stable |
| Twitter / X | Stable |
| Instagram (Reels / Posts) | Stable |
| Facebook (Videos / Reels) | Stable |
| Vimeo | Stable |
| Twitch (VODs / Clips) | Stable |
| Dailymotion | Stable |
| TikTok, Reddit, Pinterest, etc. | 1800+ more via yt-dlp |

> **Not Supported:** Douyin, Kuaishou, Xiaohongshu (due to anti-scraping restrictions)

## Prerequisites / 前置要求

- **Node.js** >= 16
- **yt-dlp** installed and available in PATH

### Install yt-dlp / 安装 yt-dlp

```bash
# macOS
brew install yt-dlp

# Linux
sudo apt install yt-dlp
# or
pip install yt-dlp

# Windows
winget install yt-dlp
# or
pip install yt-dlp
```

## Quick Start / 快速开始

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/video-parser.git
cd video-parser

# Install dependencies
npm install

# Start the server
npm start
```

Then open **http://localhost:3003** in your browser.

### macOS users / macOS 用户

Double-click `一键启动.command` to start, `一键关闭.command` to stop.

## Configuration / 配置

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `3003` | Server port |

```bash
# Example: run on port 8080
PORT=8080 npm start
```

### Douyin Cookie Support (Optional) / 抖音 Cookie（可选）

Place a `cookies.txt` file (Netscape format) in the project root to enable Douyin parsing. You can export cookies using browser extensions like [Get cookies.txt](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc).

## Project Structure / 项目结构

```
├── server.js              # Express backend (API + proxy)
├── package.json
├── public/
│   ├── index.html         # Frontend (single page)
│   ├── background.jpg     # Background image
│   └── placeholder.svg    # Fallback cover image
├── 一键启动.command        # macOS start script
├── 一键关闭.command        # macOS stop script
└── 一键重启.command        # macOS restart script
```

## API Endpoints / 接口

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/parse` | Parse a video URL, returns metadata |
| `GET` | `/api/cover/:id` | Proxy cover image (bypasses hotlink) |
| `GET` | `/api/download` | Proxy video download stream |

## License / 许可

MIT
