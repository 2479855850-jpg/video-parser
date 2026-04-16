const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, spawn } = require('child_process');
const axios = require('axios');
const youtubedl = require('youtube-dl-exec');

const app = express();
const PORT = process.env.PORT || 3003;

// --- yt-dlp ---
let ytdlpPath;
try {
    ytdlpPath = execSync(process.platform === 'win32' ? 'where yt-dlp' : 'which yt-dlp', { encoding: 'utf-8' }).trim().split('\n')[0];
} catch { ytdlpPath = 'yt-dlp'; }
console.log(`[配置] yt-dlp: ${ytdlpPath}`);
youtubedl.path = ytdlpPath;

// --- ffmpeg ---
let ffmpegPath;
try {
    ffmpegPath = execSync(process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg', { encoding: 'utf-8' }).trim().split('\n')[0];
} catch {
    try { ffmpegPath = require('ffmpeg-static'); } catch { ffmpegPath = 'ffmpeg'; }
}
console.log(`[配置] ffmpeg: ${ffmpegPath}`);

// --- 工具 ---
const isValidUrl = (str) => {
    try { return ['http:', 'https:'].includes(new URL(str).protocol); }
    catch { return false; }
};

const friendlyError = (msg) => {
    if (!msg) return '解析失败，请检查链接是否正确或稍后重试';
    if (/cookie/i.test(msg) || /login|sign.?in/i.test(msg)) return '该平台需要登录后才能访问此内容';
    if (/Video unavailable/i.test(msg)) return '视频不可用，可能已被删除';
    if (/Private/i.test(msg)) return '该视频为私密视频，无法解析';
    if (/Unsupported URL/i.test(msg)) return '不支持该链接，请检查链接是否正确';
    if (/Unable to extract/i.test(msg)) return '无法解析该链接，可能链接已失效或平台不支持';
    if (/No video could be found/i.test(msg)) return '未找到视频内容，该推文可能不包含视频';
    if (/Got error code 401|Unauthorized/i.test(msg)) return '访问被拒绝（需登录），请稍后重试或换一个链接';
    if (/403|Forbidden/i.test(msg)) return '访问被拒绝，请稍后重试';
    if (/404/.test(msg)) return '内容不存在 (404)';
    if (/timed?\s*out/i.test(msg)) return '请求超时，请检查网络后重试';
    if (/empty.*response/i.test(msg)) return '平台返回空数据，可能需要登录才能访问';
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
const mediaCache = new Map();
const previewCache = new Map();
let mediaId = 0;

const cacheUrl = (url, sourceUrl, type = 'media') => {
    const id = ++mediaId;
    mediaCache.set(id, { url, sourceUrl, type });
    setTimeout(() => mediaCache.delete(id), 3600000);
    return id;
};

// 查找 yt-dlp 输出的最终合并文件（关键：忽略 .fXXX 的分片文件）
const findOutputFile = (tmpFile) => {
    // 最优先：合并后的输出文件就是 tmpFile 本身
    if (fs.existsSync(tmpFile)) return tmpFile;

    const dir = path.dirname(tmpFile);
    const base = path.basename(tmpFile, path.extname(tmpFile));
    const allFiles = fs.readdirSync(dir).filter(f => f.startsWith(base));

    if (allFiles.length === 0) return null;

    // 优先选没有 .fXXX 后缀的（合并后的文件）
    const merged = allFiles.find(f => !f.match(/\.f\d+\./));
    if (merged) return path.join(dir, merged);

    // 如果都是分片文件，选最大的（通常是视频）
    let biggest = allFiles[0];
    let biggestSize = 0;
    for (const f of allFiles) {
        try {
            const s = fs.statSync(path.join(dir, f)).size;
            if (s > biggestSize) { biggestSize = s; biggest = f; }
        } catch {}
    }
    return path.join(dir, biggest);
};

// 检测是否有 Chrome 浏览器可用（Docker 中没有）
let hasChromeAvailable = false;
try {
    if (process.platform === 'darwin') {
        fs.accessSync('/Applications/Google Chrome.app');
        hasChromeAvailable = true;
    } else if (process.platform === 'linux') {
        execSync('which google-chrome || which chromium-browser || which chromium', { encoding: 'utf-8' });
        hasChromeAvailable = true;
    } else if (process.platform === 'win32') {
        hasChromeAvailable = true; // Windows 一般有
    }
} catch { hasChromeAvailable = false; }
console.log(`[配置] Chrome 可用: ${hasChromeAvailable}`);

// 通用 yt-dlp 下载参数
const buildYtdlpArgs = (url, outputPath, maxHeight) => {
    const args = [url];

    // 格式选择：[vcodec!=none] 确保有视频轨道，不会下到纯音频
    if (maxHeight) {
        args.push('-f', `best[ext=mp4][vcodec!=none][height<=${maxHeight}]/best[vcodec!=none][height<=${maxHeight}]/bestvideo[height<=${maxHeight}][vcodec^=avc]+bestaudio/bestvideo[height<=${maxHeight}]+bestaudio/best[vcodec!=none]`);
    } else {
        args.push('-f', `best[ext=mp4][vcodec!=none]/best[vcodec!=none]/bestvideo[vcodec^=avc]+bestaudio/bestvideo+bestaudio/best`);
    }

    args.push(
        '--merge-output-format', 'mp4',
        '--remux-video', 'mp4',
        '--no-warnings',
        '--no-playlist',
        '-o', outputPath
    );

    // ffmpeg 位置
    if (ffmpegPath && ffmpegPath !== 'ffmpeg') {
        const dir = path.dirname(ffmpegPath);
        if (dir && dir !== '.') args.push('--ffmpeg-location', dir);
    }

    // Cookies：只在有 cookies.txt 或有 Chrome 时才加
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    const needsCookies = /douyin\.com|iesdouyin\.com|twitter\.com|x\.com|instagram\.com/.test(url);
    if (needsCookies) {
        if (fs.existsSync(cookiesPath)) {
            args.push('--cookies', cookiesPath);
        } else if (hasChromeAvailable) {
            args.push('--cookies-from-browser', 'chrome');
        }
        // Docker 没有 Chrome 且没有 cookies.txt 时不加任何 cookie 参数，避免报错
    }

    return args;
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 解析接口 ---
app.post('/api/parse', async (req, res) => {
    const { url } = req.body;
    console.log(`[请求] ${url}`);

    if (!url) return res.status(400).json({ success: false, message: '提供链接为空' });
    if (!isValidUrl(url)) return res.status(400).json({ success: false, message: '链接格式无效' });

    try {
        const opts = {
            dumpJson: true,
            noWarnings: true,
            noPlaylist: true,
            addHeader: ['User-Agent:Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36']
        };

        // 需要 cookies 的平台
        if (/douyin\.com|iesdouyin\.com|twitter\.com|x\.com|instagram\.com/.test(url)) {
            const cp = path.join(__dirname, 'cookies.txt');
            if (fs.existsSync(cp)) opts.cookies = cp;
            else if (hasChromeAvailable) opts.cookiesFromBrowser = 'chrome';
        }

        const metadata = await youtubedl(url, opts);
        console.log(`[成功] ${metadata.title}`);

        // 提取视频直链
        let videoUrl = metadata.url || '';
        if (!videoUrl && metadata.requested_formats?.length > 0) {
            const vf = metadata.requested_formats.find(f => f.vcodec && f.vcodec !== 'none');
            videoUrl = vf ? vf.url : metadata.requested_formats[0].url;
        }
        if (!videoUrl && metadata.formats?.length > 0) {
            for (let i = metadata.formats.length - 1; i >= 0; i--) {
                const f = metadata.formats[i];
                if (f.url && f.vcodec && f.vcodec !== 'none') { videoUrl = f.url; break; }
            }
            if (!videoUrl) videoUrl = metadata.formats[metadata.formats.length - 1].url || '';
        }

        const imageExts = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
        const isVideo = !(metadata.entries?.length > 0) && !imageExts.includes(metadata.ext);

        let rawMediaList = [];
        if (metadata.entries?.length > 0) {
            rawMediaList = metadata.entries.map(e => e.url || e.thumbnail).filter(Boolean);
        } else if (videoUrl) {
            rawMediaList = [videoUrl];
        }

        // 视频走专用预览接口，图片走代理
        let proxyMediaList;
        if (isVideo) {
            proxyMediaList = [`/api/preview?url=${encodeURIComponent(url)}`];
        } else {
            proxyMediaList = rawMediaList.map(u => {
                const id = cacheUrl(u, url, 'image');
                return `/api/stream/${id}`;
            });
        }

        // 封面
        let rawCover = metadata.thumbnail || '';
        if (!rawCover && metadata.thumbnails?.length > 0) {
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
                title: metadata.title || '未知标题',
                cover,
                videoUrl: proxyMediaList[0] || '',
                platform: metadata.extractor_key || 'Unknown',
                isVideo,
                mediaList: proxyMediaList,
                pageUrl: url
            }
        });

    } catch (error) {
        const rawMsg = error.stderr || error.message || '';
        console.error(`[报错]`, rawMsg.substring(0, 200));
        res.status(500).json({ success: false, message: friendlyError(rawMsg) });
    }
});

// --- 视频预览（yt-dlp 下载到临时文件，sendFile 完美支持 iOS Range 请求）---
app.get('/api/preview', (req, res) => {
    const pageUrl = req.query.url;
    if (!pageUrl || !isValidUrl(pageUrl)) return res.status(400).send('无效链接');

    const cached = previewCache.get(pageUrl);
    if (cached?.ready && fs.existsSync(cached.filePath)) {
        return res.sendFile(cached.filePath);
    }
    if (cached && !cached.ready && !cached.error) {
        cached.clients.push(res);
        return;
    }

    const tmpFile = path.join(os.tmpdir(), `pv_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    const entry = { filePath: tmpFile, ready: false, clients: [res], error: null };
    previewCache.set(pageUrl, entry);

    console.log(`[预览] 下载: ${pageUrl.substring(0, 60)}...`);
    const args = buildYtdlpArgs(pageUrl, tmpFile, 720);
    const child = spawn(ytdlpPath, args);

    let stderrBuf = '';
    child.stderr.on('data', d => { stderrBuf += d.toString(); });
    child.stdout.on('data', d => {});

    child.on('error', err => {
        console.error('[预览错误]', err.message);
        entry.clients.forEach(c => { if (!c.headersSent) c.status(500).send('预览失败'); });
        entry.clients = [];
        previewCache.delete(pageUrl);
        fs.unlink(tmpFile, () => {});
    });

    child.on('close', code => {
        if (code !== 0) {
            console.error('[预览] 失败:', stderrBuf.substring(0, 200));
            entry.clients.forEach(c => { if (!c.headersSent) c.status(500).send('预览失败'); });
            entry.clients = [];
            previewCache.delete(pageUrl);
            fs.unlink(tmpFile, () => {});
            return;
        }

        const actualFile = findOutputFile(tmpFile);
        if (!actualFile) {
            entry.clients.forEach(c => { if (!c.headersSent) c.status(500).send('预览文件未生成'); });
            entry.clients = [];
            previewCache.delete(pageUrl);
            return;
        }

        const sizeMB = (fs.statSync(actualFile).size / 1024 / 1024).toFixed(1);
        console.log(`[预览] 完成: ${sizeMB}MB`);
        entry.filePath = actualFile;
        entry.ready = true;
        entry.clients.forEach(c => { if (!c.headersSent) c.sendFile(actualFile); });
        entry.clients = [];

        // 30 分钟后清理
        setTimeout(() => { fs.unlink(actualFile, () => {}); previewCache.delete(pageUrl); }, 1800000);
    });

    res.on('close', () => {
        entry.clients = entry.clients.filter(c => c !== res);
        if (entry.clients.length === 0 && !entry.ready) {
            if (!child.killed) child.kill();
            previewCache.delete(pageUrl);
            fs.unlink(tmpFile, () => {});
        }
    });
});

// --- 图片/封面代理 ---
app.get('/api/stream/:id', async (req, res) => {
    const entry = mediaCache.get(parseInt(req.params.id));
    if (!entry?.url) return res.redirect('/placeholder.svg');

    const referer = guessReferer(entry.url);
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/*,*/*;q=0.8',
        ...(referer ? { 'Referer': referer } : {})
    };

    const tryFetch = async (hdrs) => {
        const r = await axios({ method: 'GET', url: entry.url, responseType: 'stream', timeout: 15000, maxRedirects: 5, headers: hdrs });
        res.setHeader('Content-Type', r.headers['content-type'] || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        if (r.headers['content-length']) res.setHeader('Content-Length', r.headers['content-length']);
        r.data.pipe(res);
    };

    try {
        await tryFetch(headers);
    } catch {
        try { await tryFetch({ 'User-Agent': headers['User-Agent'], 'Accept': 'image/*,*/*' }); }
        catch { if (!res.headersSent) res.redirect('/placeholder.svg'); }
    }
});

// --- 下载接口 ---
app.get('/api/download', (req, res) => {
    const { pageUrl, title } = req.query;
    if (!pageUrl) return res.status(400).send('缺少下载链接');

    const decodedUrl = decodeURIComponent(pageUrl);
    if (!isValidUrl(decodedUrl)) return res.status(400).send('链接格式无效');

    const safeTitle = (title || 'download').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_\-]/g, '_');
    console.log(`[下载] ${safeTitle} <- ${decodedUrl.substring(0, 60)}...`);

    const tmpFile = path.join(os.tmpdir(), `dl_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    const args = buildYtdlpArgs(decodedUrl, tmpFile, null);

    console.log(`[下载] yt-dlp args:`, args.slice(1).join(' '));
    const child = spawn(ytdlpPath, args);

    let stderrBuf = '';
    child.stdout.on('data', d => {});
    child.stderr.on('data', d => { const m = d.toString(); stderrBuf += m; });

    child.on('error', err => {
        console.error('[下载错误]', err.message);
        fs.unlink(tmpFile, () => {});
        if (!res.headersSent) res.status(500).send('下载失败');
    });

    child.on('close', code => {
        if (code !== 0) {
            console.error('[下载] 失败:', stderrBuf.substring(0, 300));
            fs.unlink(tmpFile, () => {});
            if (!res.headersSent) return res.status(500).send('下载失败');
            return;
        }

        const actualFile = findOutputFile(tmpFile);
        if (!actualFile) {
            console.error('[下载] 找不到输出文件');
            if (!res.headersSent) res.status(500).send('下载失败：文件未生成');
            return;
        }

        const stat = fs.statSync(actualFile);
        console.log(`[下载] 完成: ${(stat.size / 1024 / 1024).toFixed(1)}MB -> ${path.basename(actualFile)}`);

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

app.listen(PORT, () => console.log(`[启动] http://localhost:${PORT}`));
