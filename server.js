const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, spawn } = require('child_process');
const axios = require('axios');
const youtubedl = require('youtube-dl-exec');

const app = express();
const PORT = process.env.PORT || 3003;

// --- yt-dlp 路径 ---
let ytdlpPath;
try {
    ytdlpPath = execSync(process.platform === 'win32' ? 'where yt-dlp' : 'which yt-dlp', { encoding: 'utf-8' }).trim().split('\n')[0];
} catch {
    ytdlpPath = 'yt-dlp';
}
console.log(`[配置] yt-dlp 路径: ${ytdlpPath}`);
youtubedl.path = ytdlpPath;

// --- ffmpeg 路径 ---
let ffmpegPath;
try {
    ffmpegPath = execSync(process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg', { encoding: 'utf-8' }).trim().split('\n')[0];
} catch {
    try { ffmpegPath = require('ffmpeg-static'); } catch { ffmpegPath = 'ffmpeg'; }
}
const ffmpegDir = ffmpegPath.includes(path.sep) ? path.dirname(ffmpegPath) : '';
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

const guessReferer = (url) => {
    try {
        const host = new URL(url).hostname;
        if (/instagram|cdninstagram|fbcdn/.test(host)) return 'https://www.instagram.com/';
        if (/ytimg|youtube|googlevideo|ggpht/.test(host)) return 'https://www.youtube.com/';
        if (/bilivideo|hdslb|biliimg/.test(host)) return 'https://www.bilibili.com/';
        if (/twimg|twitter|x\.com/.test(host)) return 'https://twitter.com/';
        return '';
    } catch { return ''; }
};

// --- 缓存 ---
const mediaCache = new Map();   // id -> { url, sourceUrl, type }
const previewCache = new Map(); // pageUrl -> { filePath, ready, clients[], error }
let mediaId = 0;

const cacheUrl = (url, sourceUrl, type = 'media') => {
    const id = ++mediaId;
    mediaCache.set(id, { url, sourceUrl, type });
    setTimeout(() => mediaCache.delete(id), 3600000);
    return id;
};

// 清理过期预览文件（30 分钟后删）
const cleanPreview = (filePath, delay = 1800000) => {
    setTimeout(() => {
        fs.unlink(filePath, () => {});
    }, delay);
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
        const ytdlpOptions = {
            dumpJson: true,
            noWarnings: true,
            addHeader: ['User-Agent:Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36']
        };

        const isDouyin = /douyin\.com|iesdouyin\.com/.test(url);
        if (isDouyin) {
            const cookiesPath = path.join(__dirname, 'cookies.txt');
            if (fs.existsSync(cookiesPath)) ytdlpOptions.cookies = cookiesPath;
            else ytdlpOptions.cookiesFromBrowser = 'chrome';
        }

        const metadata = await youtubedl(url, ytdlpOptions);
        console.log(`[成功] 解析完成: ${metadata.title}`);

        // 提取视频直链（用于图片展示等，视频预览走 /api/preview）
        let videoUrl = metadata.url || '';
        if (!videoUrl && metadata.requested_formats && metadata.requested_formats.length > 0) {
            const vf = metadata.requested_formats.find(f => f.vcodec && f.vcodec !== 'none');
            videoUrl = vf ? vf.url : metadata.requested_formats[0].url;
        }
        if (!videoUrl && metadata.formats && metadata.formats.length > 0) {
            for (let i = metadata.formats.length - 1; i >= 0; i--) {
                const f = metadata.formats[i];
                if (f.url && f.vcodec && f.vcodec !== 'none') { videoUrl = f.url; break; }
            }
            if (!videoUrl) videoUrl = metadata.formats[metadata.formats.length - 1].url || '';
        }

        // 判断视频还是图文
        const imageExts = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
        const isVideo = !(metadata.entries && metadata.entries.length > 0) && !imageExts.includes(metadata.ext);

        // 构建 mediaList
        let rawMediaList = [];
        if (metadata.entries && metadata.entries.length > 0) {
            rawMediaList = metadata.entries.map(entry => entry.url || entry.thumbnail).filter(Boolean);
        } else if (videoUrl) {
            rawMediaList = [videoUrl];
        }

        // 图片走代理，视频预览走专用接口
        let proxyMediaList;
        if (isVideo) {
            // 视频：预览走 /api/preview?url=原始页面URL
            proxyMediaList = [`/api/preview?url=${encodeURIComponent(url)}`];
        } else {
            // 图片：走 stream 代理
            proxyMediaList = rawMediaList.map(rawUrl => {
                const id = cacheUrl(rawUrl, url, 'image');
                return `/api/stream/${id}`;
            });
        }

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

        res.json({
            success: true,
            data: {
                title: metadata.title || '未知视频标题',
                cover: cover,
                videoUrl: proxyMediaList.length > 0 ? proxyMediaList[0] : '',
                platform: metadata.extractor_key || 'Unknown',
                isVideo: isVideo,
                mediaList: proxyMediaList,
                pageUrl: url  // 原始页面 URL，前端下载用
            }
        });

    } catch (error) {
        const rawMsg = error.stderr || error.message || '';
        console.error(`[报错] yt-dlp 执行失败:`, rawMsg);
        res.status(500).json({ success: false, message: friendlyError(rawMsg) });
    }
});

// --- 视频预览接口（yt-dlp 下载临时文件，sendFile 自动支持 Range/206）---
app.get('/api/preview', (req, res) => {
    const pageUrl = req.query.url;
    if (!pageUrl || !isValidUrl(pageUrl)) {
        return res.status(400).send('无效链接');
    }

    // 检查是否已有缓存的预览文件
    const cached = previewCache.get(pageUrl);
    if (cached && cached.ready && fs.existsSync(cached.filePath)) {
        console.log(`[预览] 使用缓存: ${cached.filePath}`);
        return res.sendFile(cached.filePath);
    }

    // 如果正在下载中，等待完成
    if (cached && !cached.ready && !cached.error) {
        console.log(`[预览] 正在下载中，等待...`);
        cached.clients.push(res);
        return;
    }

    // 开始新的下载
    const tmpFile = path.join(os.tmpdir(), `preview_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    const entry = { filePath: tmpFile, ready: false, clients: [res], error: null };
    previewCache.set(pageUrl, entry);

    console.log(`[预览] 开始下载: ${pageUrl.substring(0, 60)}...`);

    const args = [
        pageUrl,
        '-f', 'bestvideo[vcodec^=avc1][height<=720]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc][height<=720]+bestaudio/best[height<=720]/bestvideo[vcodec^=avc1]+bestaudio/best',
        '--merge-output-format', 'mp4',
        '--remux-video', 'mp4',
        '--no-warnings',
        '--no-playlist',
        '-o', tmpFile
    ];
    if (ffmpegDir) args.push('--ffmpeg-location', ffmpegDir);

    // 抖音加 cookies
    if (/douyin\.com|iesdouyin\.com/.test(pageUrl)) {
        const cookiesPath = path.join(__dirname, 'cookies.txt');
        if (fs.existsSync(cookiesPath)) args.push('--cookies', cookiesPath);
        else args.push('--cookies-from-browser', 'chrome');
    }

    const child = spawn(ytdlpPath, args);

    child.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.log('[预览 yt-dlp]', msg);
    });

    child.on('error', (err) => {
        console.error('[预览进程错误]', err.message);
        entry.error = err.message;
        entry.clients.forEach(c => { if (!c.headersSent) c.status(500).send('预览失败'); });
        entry.clients = [];
        previewCache.delete(pageUrl);
        fs.unlink(tmpFile, () => {});
    });

    child.on('close', (code) => {
        if (code !== 0) {
            console.error('[预览] yt-dlp 退出码:', code);
            entry.clients.forEach(c => { if (!c.headersSent) c.status(500).send('预览失败'); });
            entry.clients = [];
            previewCache.delete(pageUrl);
            fs.unlink(tmpFile, () => {});
            return;
        }

        // 查找实际文件（yt-dlp 可能改后缀）
        let actualFile = tmpFile;
        if (!fs.existsSync(actualFile)) {
            const dir = path.dirname(tmpFile);
            const base = path.basename(tmpFile, '.mp4');
            const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
            if (files.length > 0) {
                actualFile = path.join(dir, files[0]);
            } else {
                entry.clients.forEach(c => { if (!c.headersSent) c.status(500).send('预览文件未生成'); });
                entry.clients = [];
                previewCache.delete(pageUrl);
                return;
            }
        }

        const sizeMB = (fs.statSync(actualFile).size / 1024 / 1024).toFixed(1);
        console.log(`[预览] 下载完成: ${sizeMB}MB -> ${actualFile}`);

        entry.filePath = actualFile;
        entry.ready = true;

        // 向所有等待的客户端发送文件
        entry.clients.forEach(c => {
            if (!c.headersSent) c.sendFile(actualFile);
        });
        entry.clients = [];

        // 30 分钟后清理
        cleanPreview(actualFile);
        setTimeout(() => previewCache.delete(pageUrl), 1800000);
    });

    // 客户端断开时从等待列表移除
    res.on('close', () => {
        entry.clients = entry.clients.filter(c => c !== res);
        // 如果所有客户端都断开了且还没下完，杀进程
        if (entry.clients.length === 0 && !entry.ready) {
            if (!child.killed) child.kill();
            previewCache.delete(pageUrl);
            fs.unlink(tmpFile, () => {});
        }
    });
});

// --- 图片/封面代理接口 ---
app.get('/api/stream/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const entry = mediaCache.get(id);
    if (!entry) return res.redirect('/placeholder.svg');

    const targetUrl = entry.url;
    if (!targetUrl) return res.redirect('/placeholder.svg');

    const referer = guessReferer(targetUrl);
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
        ...(referer ? { 'Referer': referer } : {})
    };

    try {
        const response = await axios({
            method: 'GET', url: targetUrl, responseType: 'stream',
            timeout: 15000, maxRedirects: 5, headers
        });
        const ct = response.headers['content-type'] || 'image/jpeg';
        res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
        response.data.pipe(res);
    } catch (err) {
        console.error('[图片代理报错]', targetUrl.substring(0, 60), err.message);
        // 不带 Referer 重试
        try {
            const retry = await axios({
                method: 'GET', url: targetUrl, responseType: 'stream',
                timeout: 15000, maxRedirects: 5,
                headers: { 'User-Agent': headers['User-Agent'], 'Accept': 'image/*,*/*;q=0.8' }
            });
            const ct = retry.headers['content-type'] || 'image/jpeg';
            res.setHeader('Content-Type', ct);
            if (retry.headers['content-length']) res.setHeader('Content-Length', retry.headers['content-length']);
            retry.data.pipe(res);
        } catch {
            if (!res.headersSent) res.redirect('/placeholder.svg');
        }
    }
});

// --- 下载接口 ---
app.get('/api/download', (req, res) => {
    const { pageUrl, title } = req.query;
    if (!pageUrl) return res.status(400).send('缺少下载链接');

    const decodedUrl = decodeURIComponent(pageUrl);
    if (!isValidUrl(decodedUrl)) return res.status(400).send('链接格式无效');

    const safeTitle = (title || 'download').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_\-]/g, '_');
    console.log(`[下载] ${safeTitle} <- ${decodedUrl.substring(0, 80)}...`);

    const tmpFile = path.join(os.tmpdir(), `dl_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);

    const args = [
        decodedUrl,
        '-f', 'bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc]+bestaudio/bestvideo+bestaudio/best',
        '--merge-output-format', 'mp4',
        '--remux-video', 'mp4',
        '--no-warnings',
        '--no-playlist',
        '-o', tmpFile
    ];
    if (ffmpegDir) {
        args.push('--ffmpeg-location', ffmpegDir);
        args.push('--postprocessor-args', 'ffmpeg:-movflags +faststart');
    }

    if (/douyin\.com|iesdouyin\.com/.test(decodedUrl)) {
        const cookiesPath = path.join(__dirname, 'cookies.txt');
        if (fs.existsSync(cookiesPath)) args.push('--cookies', cookiesPath);
        else args.push('--cookies-from-browser', 'chrome');
    }

    console.log(`[下载] 参数: yt-dlp ${args.join(' ')}`);
    const child = spawn(ytdlpPath, args);

    let stderrLog = '';
    child.stdout.on('data', d => { const m = d.toString().trim(); if (m) console.log('[下载 out]', m); });
    child.stderr.on('data', d => { const m = d.toString().trim(); stderrLog += m + '\n'; if (m) console.log('[下载 err]', m); });

    child.on('error', (err) => {
        console.error('[下载进程错误]', err.message);
        fs.unlink(tmpFile, () => {});
        if (!res.headersSent) res.status(500).send('下载失败');
    });

    child.on('close', (code) => {
        if (code !== 0) {
            console.error('[下载] 退出码:', code, stderrLog.substring(0, 300));
            fs.unlink(tmpFile, () => {});
            if (!res.headersSent) return res.status(500).send('下载失败');
            return;
        }

        let actualFile = tmpFile;
        if (!fs.existsSync(actualFile)) {
            const dir = path.dirname(tmpFile);
            const base = path.basename(tmpFile, '.mp4');
            const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
            if (files.length > 0) actualFile = path.join(dir, files[0]);
            else { if (!res.headersSent) res.status(500).send('下载失败：文件未生成'); return; }
        }

        const stat = fs.statSync(actualFile);
        console.log(`[下载] 完成: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);

        const ext = path.extname(actualFile).toLowerCase() || '.mp4';
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}${ext}"`);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', stat.size);

        const stream = fs.createReadStream(actualFile);
        stream.pipe(res);
        stream.on('end', () => fs.unlink(actualFile, () => {}));
        stream.on('error', () => { fs.unlink(actualFile, () => {}); if (!res.headersSent) res.status(500).send('下载失败'); });
    });

    res.on('close', () => {
        if (!child.killed) child.kill();
        setTimeout(() => fs.unlink(tmpFile, () => {}), 5000);
    });
});

app.listen(PORT, () => {
    console.log(`[启动] 服务已启动: http://localhost:${PORT}`);
});
