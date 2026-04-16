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
    ytdlpPath = 'yt-dlp'; // 依赖 PATH 中存在 yt-dlp
}
console.log(`[配置] yt-dlp 路径: ${ytdlpPath}`);
youtubedl.path = ytdlpPath;

// --- ffmpeg 路径（用于音视频合并）---
// 优先系统 ffmpeg（Docker 环境），其次 ffmpeg-static（本地开发）
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

// --- 封面缓存（ID -> 原始 URL）---
const coverCache = new Map();
let coverId = 0;

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

        // 抖音需要 cookies
        const isDouyin = /douyin\.com|iesdouyin\.com/.test(url);
        if (isDouyin) {
            const cookiesPath = path.join(__dirname, 'cookies.txt');
            if (fs.existsSync(cookiesPath)) {
                ytdlpOptions.cookies = cookiesPath;
                console.log('[配置] 使用 cookies.txt');
            } else {
                ytdlpOptions.cookiesFromBrowser = 'chrome';
                console.log('[配置] 从 Chrome 提取 cookies');
            }
        }

        const metadata = await youtubedl(url, ytdlpOptions);
        console.log(`[成功] 解析完成: ${metadata.title}`);

        // 提取视频直链：优先 url，其次从 formats/requested_formats 里取最佳
        let videoUrl = metadata.url || '';
        if (!videoUrl && metadata.requested_formats && metadata.requested_formats.length > 0) {
            // 优先取有视频编码的格式（非纯音频）
            const videoFormat = metadata.requested_formats.find(f => f.vcodec && f.vcodec !== 'none');
            videoUrl = videoFormat ? videoFormat.url : metadata.requested_formats[0].url;
        }
        if (!videoUrl && metadata.formats && metadata.formats.length > 0) {
            // 从所有格式中取最后一个（通常是最高质量）
            for (let i = metadata.formats.length - 1; i >= 0; i--) {
                const f = metadata.formats[i];
                if (f.url && f.vcodec && f.vcodec !== 'none') {
                    videoUrl = f.url;
                    break;
                }
            }
            // 实在没有带视频的，取最后一个
            if (!videoUrl) videoUrl = metadata.formats[metadata.formats.length - 1].url || '';
        }

        // 判断视频还是图文
        const imageExts = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
        const isVideo = !(metadata.entries && metadata.entries.length > 0) && !imageExts.includes(metadata.ext);

        // 构建 mediaList
        let mediaList = [];
        if (metadata.entries && metadata.entries.length > 0) {
            mediaList = metadata.entries.map(entry => entry.url || entry.thumbnail).filter(Boolean);
        } else if (videoUrl) {
            mediaList = [videoUrl];
        }

        // 封面走代理（用短 ID 映射，避免 URL 编码问题）
        // 优先 metadata.thumbnail，其次从 thumbnails 数组取最高清的
        let rawCover = metadata.thumbnail || '';
        if (!rawCover && metadata.thumbnails && metadata.thumbnails.length > 0) {
            // thumbnails 数组通常最后一个是最高清的
            rawCover = metadata.thumbnails[metadata.thumbnails.length - 1].url || '';
        }
        let cover = '/placeholder.svg';
        if (rawCover) {
            const id = ++coverId;
            coverCache.set(id, { url: rawCover, sourceUrl: url });
            cover = `/api/cover/${id}?t=${Date.now()}`;
            // 1 小时后自动清理
            setTimeout(() => coverCache.delete(id), 3600000);
        }
        console.log(`[封面] 原始封面URL: ${rawCover ? rawCover.substring(0, 80) + '...' : '无'}`);

        res.json({
            success: true,
            data: {
                title: metadata.title || '未知视频标题',
                cover: cover,
                videoUrl: videoUrl,
                platform: metadata.extractor_key || 'Unknown',
                isVideo: isVideo,
                mediaList: mediaList
            }
        });

    } catch (error) {
        const rawMsg = error.stderr || error.message || '';
        console.error(`[报错] yt-dlp 执行失败:`, rawMsg);
        res.status(500).json({ success: false, message: friendlyError(rawMsg) });
    }
});

// --- 封面图代理接口 ---
app.get('/api/cover/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const cacheEntry = coverCache.get(id);
    if (!cacheEntry) return res.redirect('/placeholder.svg');

    const imageUrl = typeof cacheEntry === 'string' ? cacheEntry : cacheEntry.url;
    const sourceUrl = typeof cacheEntry === 'object' ? cacheEntry.sourceUrl : '';
    if (!imageUrl) return res.redirect('/placeholder.svg');

    // 根据图片 URL 域名构造合适的 Referer
    let referer = '';
    try {
        const imgHost = new URL(imageUrl).hostname;
        if (/instagram|cdninstagram|fbcdn/.test(imgHost)) referer = 'https://www.instagram.com/';
        else if (/ytimg|youtube|googlevideo/.test(imgHost)) referer = 'https://www.youtube.com/';
        else if (/bilivideo|hdslb|biliimg/.test(imgHost)) referer = 'https://www.bilibili.com/';
        else if (/twimg/.test(imgHost)) referer = 'https://twitter.com/';
        else if (/pximg/.test(imgHost)) referer = 'https://www.pixiv.net/';
        else {
            try { referer = new URL(sourceUrl).origin + '/'; } catch {}
        }
    } catch {}

    try {
        const response = await axios({
            method: 'GET',
            url: imageUrl,
            responseType: 'stream',
            timeout: 15000,
            maxRedirects: 5,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Fetch-Dest': 'image',
                'Sec-Fetch-Mode': 'no-cors',
                'Sec-Fetch-Site': 'cross-site',
                ...(referer ? { 'Referer': referer } : {})
            }
        });

        // 透传原始 Content-Type
        const ct = response.headers['content-type'] || 'image/jpeg';
        res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }
        response.data.pipe(res);
    } catch (err) {
        console.error('[封面代理报错]', imageUrl.substring(0, 80), err.message);
        // 如果带 Referer 失败，尝试不带 Referer 重试一次
        try {
            const retry = await axios({
                method: 'GET',
                url: imageUrl,
                responseType: 'stream',
                timeout: 15000,
                maxRedirects: 5,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'image/*,*/*;q=0.8'
                }
            });
            const ct = retry.headers['content-type'] || 'image/jpeg';
            res.setHeader('Content-Type', ct);
            res.setHeader('Cache-Control', 'public, max-age=3600');
            if (retry.headers['content-length']) {
                res.setHeader('Content-Length', retry.headers['content-length']);
            }
            retry.data.pipe(res);
        } catch (retryErr) {
            console.error('[封面代理重试也失败]', retryErr.message);
            if (!res.headersSent) {
                res.redirect('/placeholder.svg');
            }
        }
    }
});

// --- 下载接口（使用 yt-dlp 下载到临时文件，确保 mp4 格式完整）---
app.get('/api/download', (req, res) => {
    const { pageUrl, title } = req.query;

    if (!pageUrl) return res.status(400).send('缺少下载链接');

    const decodedUrl = decodeURIComponent(pageUrl);
    if (!isValidUrl(decodedUrl)) return res.status(400).send('链接格式无效');

    const safeTitle = (title || 'download').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_\-]/g, '_');
    console.log(`[下载] ${safeTitle} <- ${decodedUrl.substring(0, 80)}...`);

    // 下载到临时文件（mp4 合并需要可写文件，stdout 管道会导致文件损坏）
    const os = require('os');
    const tmpFile = path.join(os.tmpdir(), `vp_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);

    const { spawn } = require('child_process');
    const args = [
        decodedUrl,
        // 优先 H.264 视频（兼容性最好），回退到任意格式
        '-f', 'bv[vcodec^=avc]+ba/bv*+ba/b/best',
        '--merge-output-format', 'mp4',
        '--remux-video', 'mp4',
        '--ffmpeg-location', path.dirname(ffmpegPath),
        '--ppa', 'ffmpeg:-movflags +faststart',
        '--no-warnings',
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

    const child = spawn(ytdlpPath, args);

    child.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.log('[下载 yt-dlp]', msg);
    });

    child.on('error', (err) => {
        console.error('[下载进程错误]', err.message);
        fs.unlink(tmpFile, () => {});
        if (!res.headersSent) res.status(500).send('下载失败');
    });

    child.on('close', (code) => {
        if (code !== 0) {
            console.error('[下载] yt-dlp 退出码:', code);
            fs.unlink(tmpFile, () => {});
            if (!res.headersSent) return res.status(500).send('下载失败');
            return;
        }

        // yt-dlp 可能会自动加后缀，查找实际文件
        let actualFile = tmpFile;
        if (!fs.existsSync(actualFile)) {
            // 尝试查找同前缀的文件
            const dir = path.dirname(tmpFile);
            const base = path.basename(tmpFile, '.mp4');
            const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
            if (files.length > 0) {
                actualFile = path.join(dir, files[0]);
            } else {
                if (!res.headersSent) res.status(500).send('下载失败：文件未生成');
                return;
            }
        }

        const stat = fs.statSync(actualFile);
        console.log(`[下载] 完成，文件大小: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);

        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}.mp4"`);
        res.setHeader('Content-Type', 'video/mp4');
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
        // 延迟清理，避免竞态
        setTimeout(() => fs.unlink(tmpFile, () => {}), 5000);
    });
});

app.listen(PORT, () => {
    console.log(`[启动] 服务已启动，监听端口: ${PORT}`);
    console.log(`[启动] 访问地址: http://localhost:${PORT}`);
});
