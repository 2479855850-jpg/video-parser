const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const axios = require('axios');
const youtubedl = require('youtube-dl-exec');

const app = express();
const PORT = process.env.PORT || 3003;

// --- yt-dlp 路径动态查找 ---
let ytdlpPath;
try {
    ytdlpPath = execSync(process.platform === 'win32' ? 'where yt-dlp' : 'which yt-dlp', { encoding: 'utf-8' }).trim().split('\n')[0];
} catch {
    ytdlpPath = 'yt-dlp';
}
console.log(`[配置] yt-dlp 路径: ${ytdlpPath}`);
youtubedl.path = ytdlpPath;

// --- ffmpeg 路径（用于音视频合并）---
let ffmpegPath;
try {
    ffmpegPath = execSync(process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg', { encoding: 'utf-8' }).trim().split('\n')[0];
} catch {
    try {
        ffmpegPath = require('ffmpeg-static');
    } catch {
        ffmpegPath = 'ffmpeg';
    }
}
console.log(`[配置] ffmpeg 路径: ${ffmpegPath}`);

// --- 工具函数 ---
const isValidUrl = (str) => {
    try { return ['http:', 'https:'].includes(new URL(str).protocol); }
    catch { return false; }
};

const friendlyError = (msg) => {
    if (!msg) return '解析失败，请检查链接是否正确或稍后重试';
    if (/cookie/i.test(msg)) return '需要登录才能访问，请确保 Chrome 已登录该平台';
    if (/Video unavailable/i.test(msg)) return '视频不可用，可能已被删除';
    if (/Private/i.test(msg)) return '该视频为私密视频，无法解析';
    if (/Unsupported URL/i.test(msg)) return '不支持该链接，请检查链接是否正确';
    if (/Unable to extract/i.test(msg)) return '无法解析该链接，可能链接已失效或平台不支持';
    if (/403/.test(msg)) return '访问被拒绝，请稍后重试';
    if (/404/.test(msg)) return '内容不存在 (404)';
    if (/timed?\s*out/i.test(msg)) return '请求超时，请检查网络后重试';
    return '解析失败，请检查链接是否正确或稍后重试';
};

// 根据 URL 猜测合适的 Referer
const guessReferer = (url) => {
    try {
        const host = new URL(url).hostname;
        if (/instagram|cdninstagram|fbcdn/.test(host)) return 'https://www.instagram.com/';
        if (/ytimg|youtube|googlevideo|ggpht/.test(host)) return 'https://www.youtube.com/';
        if (/bilivideo|hdslb|biliimg/.test(host)) return 'https://www.bilibili.com/';
        if (/twimg|twitter|x\.com/.test(host)) return 'https://twitter.com/';
        if (/tiktok/.test(host)) return 'https://www.tiktok.com/';
        return '';
    } catch { return ''; }
};

// 通用代理请求头
const proxyHeaders = (targetUrl) => {
    const referer = guessReferer(targetUrl);
    return {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'video',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
        ...(referer ? { 'Referer': referer, 'Origin': referer.replace(/\/$/, '') } : {})
    };
};

// --- 缓存：ID -> { url, sourceUrl, type } ---
const mediaCache = new Map();
let mediaId = 0;

const cacheUrl = (url, sourceUrl, type = 'media') => {
    const id = ++mediaId;
    mediaCache.set(id, { url, sourceUrl, type });
    setTimeout(() => mediaCache.delete(id), 3600000); // 1 小时后清理
    return id;
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 解析接口 ---
app.post('/api/parse', async (req, res) => {
    const { url } = req.body;
    console.log(`[请求] 收到解析链接: ${url}`);

    if (!url) return res.status(400).json({ success: false, message: '提供链接为空' });
    if (!isValidUrl(url)) return res.status(400).json({ success: false, message: '链接格式无效，仅支持 http/https 链接' });

    try {
        console.log(`[执行] 正在调用 yt-dlp...`);

        const ytdlpOptions = {
            dumpJson: true,
            noWarnings: true,
            addHeader: ['User-Agent:Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36']
        };

        const isDouyin = /douyin\.com|iesdouyin\.com/.test(url);
        if (isDouyin) {
            const cookiesPath = path.join(__dirname, 'cookies.txt');
            if (fs.existsSync(cookiesPath)) {
                ytdlpOptions.cookies = cookiesPath;
            } else {
                ytdlpOptions.cookiesFromBrowser = 'chrome';
            }
        }

        const metadata = await youtubedl(url, ytdlpOptions);
        console.log(`[成功] 解析完成: ${metadata.title}`);

        // 提取视频直链
        let videoUrl = metadata.url || '';
        if (!videoUrl && metadata.requested_formats && metadata.requested_formats.length > 0) {
            const videoFormat = metadata.requested_formats.find(f => f.vcodec && f.vcodec !== 'none');
            videoUrl = videoFormat ? videoFormat.url : metadata.requested_formats[0].url;
        }
        if (!videoUrl && metadata.formats && metadata.formats.length > 0) {
            for (let i = metadata.formats.length - 1; i >= 0; i--) {
                const f = metadata.formats[i];
                if (f.url && f.vcodec && f.vcodec !== 'none') {
                    videoUrl = f.url;
                    break;
                }
            }
            if (!videoUrl) videoUrl = metadata.formats[metadata.formats.length - 1].url || '';
        }

        // 判断视频还是图文
        const imageExts = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
        const isVideo = !(metadata.entries && metadata.entries.length > 0) && !imageExts.includes(metadata.ext);

        // 构建 mediaList（原始 URL）
        let rawMediaList = [];
        if (metadata.entries && metadata.entries.length > 0) {
            rawMediaList = metadata.entries.map(entry => entry.url || entry.thumbnail).filter(Boolean);
        } else if (videoUrl) {
            rawMediaList = [videoUrl];
        }

        // 将所有媒体 URL 转为代理 URL（解决 CDN IP 锁定问题）
        const proxyMediaList = rawMediaList.map(rawUrl => {
            const id = cacheUrl(rawUrl, url, isVideo ? 'video' : 'image');
            return `/api/stream/${id}`;
        });

        // 封面代理
        let rawCover = metadata.thumbnail || '';
        if (!rawCover && metadata.thumbnails && metadata.thumbnails.length > 0) {
            rawCover = metadata.thumbnails[metadata.thumbnails.length - 1].url || '';
        }
        let cover = '/placeholder.svg';
        if (rawCover) {
            const id = cacheUrl(rawCover, url, 'image');
            cover = `/api/stream/${id}?t=${Date.now()}`;
        }
        console.log(`[封面] 原始URL: ${rawCover ? rawCover.substring(0, 80) + '...' : '无'}`);

        res.json({
            success: true,
            data: {
                title: metadata.title || '未知视频标题',
                cover: cover,
                videoUrl: proxyMediaList.length > 0 ? proxyMediaList[0] : '',
                platform: metadata.extractor_key || 'Unknown',
                isVideo: isVideo,
                mediaList: proxyMediaList
            }
        });

    } catch (error) {
        const rawMsg = error.stderr || error.message || '';
        console.error(`[报错] yt-dlp 执行失败:`, rawMsg);
        res.status(500).json({ success: false, message: friendlyError(rawMsg) });
    }
});

// --- 统一媒体代理接口（封面 + 视频预览 + 图片都走这里）---
app.get('/api/stream/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const entry = mediaCache.get(id);
    if (!entry) {
        return res.redirect('/placeholder.svg');
    }

    const targetUrl = entry.url;
    if (!targetUrl) return res.redirect('/placeholder.svg');

    const headers = proxyHeaders(targetUrl);

    // 支持 Range 请求（视频拖动进度条）
    if (req.headers.range) {
        headers['Range'] = req.headers.range;
    }

    try {
        const response = await axios({
            method: 'GET',
            url: targetUrl,
            responseType: 'stream',
            timeout: 30000,
            maxRedirects: 5,
            headers: headers
        });

        // 透传响应头
        const ct = response.headers['content-type'] || (entry.type === 'video' ? 'video/mp4' : 'image/jpeg');
        res.setHeader('Content-Type', ct);
        res.setHeader('Accept-Ranges', 'bytes');
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }
        if (response.headers['content-range']) {
            res.setHeader('Content-Range', response.headers['content-range']);
            res.status(206);
        }
        // 允许缓存
        res.setHeader('Cache-Control', 'public, max-age=1800');

        response.data.pipe(res);

        response.data.on('error', () => {
            if (!res.headersSent) res.redirect('/placeholder.svg');
        });

    } catch (err) {
        console.error(`[代理报错] ${entry.type}`, targetUrl.substring(0, 60), err.message);
        // 重试一次（不带 Referer）
        try {
            const retryHeaders = {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*'
            };
            if (req.headers.range) retryHeaders['Range'] = req.headers.range;

            const retry = await axios({
                method: 'GET',
                url: targetUrl,
                responseType: 'stream',
                timeout: 30000,
                maxRedirects: 5,
                headers: retryHeaders
            });
            const ct = retry.headers['content-type'] || 'application/octet-stream';
            res.setHeader('Content-Type', ct);
            if (retry.headers['content-length']) res.setHeader('Content-Length', retry.headers['content-length']);
            if (retry.headers['content-range']) { res.setHeader('Content-Range', retry.headers['content-range']); res.status(206); }
            retry.data.pipe(res);
        } catch (retryErr) {
            console.error('[代理重试也失败]', retryErr.message);
            if (!res.headersSent) {
                if (entry.type === 'image') res.redirect('/placeholder.svg');
                else res.status(502).send('媒体加载失败');
            }
        }
    }
});

// --- 下载接口（使用 yt-dlp 下载到临时文件）---
app.get('/api/download', (req, res) => {
    const { pageUrl, title } = req.query;

    if (!pageUrl) return res.status(400).send('缺少下载链接');

    const decodedUrl = decodeURIComponent(pageUrl);
    if (!isValidUrl(decodedUrl)) return res.status(400).send('链接格式无效');

    const safeTitle = (title || 'download').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_\-]/g, '_');
    console.log(`[下载] ${safeTitle} <- ${decodedUrl.substring(0, 80)}...`);

    const os = require('os');
    const tmpFile = path.join(os.tmpdir(), `vp_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);

    const { spawn } = require('child_process');
    const args = [
        decodedUrl,
        // 格式选择：优先 H.264+音频合并，回退到任意视频+音频，再回退到最佳单文件
        '-f', 'bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc]+bestaudio/bestvideo+bestaudio/best',
        '--merge-output-format', 'mp4',
        '--remux-video', 'mp4',
        '--ffmpeg-location', ffmpegPath.includes('/') ? path.dirname(ffmpegPath) : ffmpegPath,
        '--postprocessor-args', 'ffmpeg:-movflags +faststart',
        '--no-warnings',
        '--no-playlist',
        '--verbose',
        '-o', tmpFile
    ];

    // 抖音加 cookies
    const isDouyin = /douyin\.com|iesdouyin\.com/.test(decodedUrl);
    if (isDouyin) {
        const cookiesPath = path.join(__dirname, 'cookies.txt');
        if (fs.existsSync(cookiesPath)) {
            args.push('--cookies', cookiesPath);
        } else {
            args.push('--cookies-from-browser', 'chrome');
        }
    }

    console.log(`[下载] yt-dlp 参数:`, args.join(' '));

    const child = spawn(ytdlpPath, args);

    let stderrLog = '';
    child.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.log('[下载 stdout]', msg);
    });
    child.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        stderrLog += msg + '\n';
        if (msg) console.log('[下载 stderr]', msg);
    });

    child.on('error', (err) => {
        console.error('[下载进程错误]', err.message);
        fs.unlink(tmpFile, () => {});
        if (!res.headersSent) res.status(500).send('下载失败');
    });

    child.on('close', (code) => {
        if (code !== 0) {
            console.error('[下载] yt-dlp 退出码:', code);
            console.error('[下载] 错误日志:', stderrLog.substring(0, 500));
            fs.unlink(tmpFile, () => {});
            if (!res.headersSent) return res.status(500).send('下载失败');
            return;
        }

        // yt-dlp 可能会自动加后缀，查找实际文件
        let actualFile = tmpFile;
        if (!fs.existsSync(actualFile)) {
            const dir = path.dirname(tmpFile);
            const base = path.basename(tmpFile, '.mp4');
            const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
            if (files.length > 0) {
                actualFile = path.join(dir, files[0]);
            } else {
                console.error('[下载] 找不到输出文件, tmpFile=', tmpFile);
                if (!res.headersSent) res.status(500).send('下载失败：文件未生成');
                return;
            }
        }

        const stat = fs.statSync(actualFile);
        const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
        console.log(`[下载] 完成，文件大小: ${sizeMB}MB, 路径: ${actualFile}`);

        // 根据实际文件扩展名设置正确的 Content-Type
        const ext = path.extname(actualFile).toLowerCase();
        const mimeMap = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.m4a': 'audio/mp4' };
        const contentType = mimeMap[ext] || 'video/mp4';

        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}${ext || '.mp4'}"`);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', stat.size);

        const stream = fs.createReadStream(actualFile);
        stream.pipe(res);
        stream.on('end', () => fs.unlink(actualFile, () => {}));
        stream.on('error', () => {
            fs.unlink(actualFile, () => {});
            if (!res.headersSent) res.status(500).send('下载失败');
        });
    });

    // 用户断开连接时终止 yt-dlp 进程并清理
    res.on('close', () => {
        if (!child.killed) child.kill();
        setTimeout(() => fs.unlink(tmpFile, () => {}), 5000);
    });
});

app.listen(PORT, () => {
    console.log(`[启动] 服务已启动，监听端口: ${PORT}`);
    console.log(`[启动] 访问地址: http://localhost:${PORT}`);
});
