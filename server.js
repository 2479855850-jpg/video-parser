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

// --- 工具函数 ---
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
    if (/No video could be found/i.test(msg)) return '未找到视频内容';
    if (/Got error code 401|Unauthorized/i.test(msg)) return '访问被拒绝（需登录），请稍后重试';
    if (/403|Forbidden/i.test(msg)) return '访问被拒绝，请稍后重试';
    if (/404/.test(msg)) return '内容不存在 (404)';
    if (/timed?\s*out/i.test(msg)) return '请求超时，请检查网络后重试';
    if (/empty.*response/i.test(msg)) return 'Instagram 需要登录才能访问，暂不支持该平台';
    if (/instagram/i.test(msg)) return 'Instagram 接口受限，暂不支持该平台';
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

// --- 图片缓存 ---
const mediaCache = new Map();
let mediaId = 0;
const cacheUrl = (url, sourceUrl, type = 'media') => {
    const id = ++mediaId;
    mediaCache.set(id, { url, sourceUrl, type });
    setTimeout(() => mediaCache.delete(id), 3600000);
    return id;
};

// --- Chrome 检测 ---
let hasChromeAvailable = false;
try {
    if (process.platform === 'darwin') {
        fs.accessSync('/Applications/Google Chrome.app');
        hasChromeAvailable = true;
    } else if (process.platform === 'linux') {
        execSync('which google-chrome || which chromium-browser || which chromium', { encoding: 'utf-8' });
        hasChromeAvailable = true;
    }
} catch { hasChromeAvailable = false; }
console.log(`[配置] Chrome 可用: ${hasChromeAvailable}`);

// --- 文件查找 ---
const findOutputFile = (tmpFile) => {
    if (fs.existsSync(tmpFile)) return tmpFile;
    const dir = path.dirname(tmpFile);
    const base = path.basename(tmpFile, path.extname(tmpFile));
    let allFiles;
    try { allFiles = fs.readdirSync(dir).filter(f => f.startsWith(base)); }
    catch { return null; }
    if (allFiles.length === 0) return null;
    const merged = allFiles.find(f => !f.match(/\.f\d+\./));
    if (merged) return path.join(dir, merged);
    let biggest = allFiles[0], biggestSize = 0;
    for (const f of allFiles) {
        try {
            const s = fs.statSync(path.join(dir, f)).size;
            if (s > biggestSize) { biggestSize = s; biggest = f; }
        } catch {}
    }
    return path.join(dir, biggest);
};

// --- 视频探测 ---
const probeFile = (filePath) => {
    try {
        const out = execSync(`"${ffmpegPath}" -i "${filePath}" 2>&1 || true`, { encoding: 'utf-8', timeout: 10000 });
        const hasVideo = /Stream.*Video:/i.test(out);
        const hasAudio = /Stream.*Audio:/i.test(out);
        const codecMatch = out.match(/Stream.*Video:\s*(\w+)/i);
        const vcodec = codecMatch ? codecMatch[1].toLowerCase() : '';
        return { hasVideo, hasAudio, vcodec };
    } catch { return { hasVideo: false, hasAudio: false, vcodec: '' }; }
};

// --- VP9/AV1 → H264 转码 ---
const reencodeToH264 = (inputPath) => {
    return new Promise((resolve) => {
        const info = probeFile(inputPath);
        if (!info.hasVideo || info.vcodec === 'h264' || info.vcodec === 'avc1' || info.vcodec === 'avc') {
            return resolve(inputPath);
        }
        console.log(`[转码] ${info.vcodec} -> h264: ${path.basename(inputPath)}`);
        const outPath = inputPath.replace(/(\.\w+)$/, '_h264$1');
        const child = spawn(ffmpegPath, [
            '-i', inputPath,
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            '-y', outPath
        ]);
        let stderr = '';
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('error', () => resolve(inputPath));
        child.on('close', code => {
            if (code === 0 && fs.existsSync(outPath)) {
                console.log(`[转码] 完成: ${(fs.statSync(outPath).size/1048576).toFixed(1)}MB`);
                fs.unlink(inputPath, () => {});
                resolve(outPath);
            } else {
                console.error('[转码] 失败:', stderr.substring(0, 200));
                if (fs.existsSync(outPath)) fs.unlink(outPath, () => {});
                resolve(inputPath);
            }
        });
    });
};

// --- yt-dlp 参数 ---
const buildYtdlpArgs = (url, outputPath, maxHeight, forceVideo = true) => {
    const args = [url];
    if (forceVideo) {
        let hf = maxHeight ? `[height<=${maxHeight}]` : '';
        args.push('-f', [
            `bv*${hf}[vcodec^=avc]+ba[ext=m4a]`,
            `bv*${hf}[vcodec^=avc]+ba`,
            `bv*${hf}[vcodec^=avc]`,
            `b${hf}[vcodec^=avc]`,
            `bv*${hf}[vcodec!=none]+ba`,
            `bv*${hf}[vcodec!=none]`,
            `b${hf}[vcodec!=none]`,
            `b${hf}`
        ].join('/'));
    }
    args.push('-S', ['vcodec:h264', 'acodec:aac', 'ext:mp4:m4a', ...(maxHeight ? [`res:${maxHeight}`] : [])].join(','));
    args.push('--merge-output-format', 'mp4', '--remux-video', 'mp4', '--no-warnings', '--no-playlist', '-o', outputPath);
    if (ffmpegPath && ffmpegPath !== 'ffmpeg') {
        const dir = path.dirname(ffmpegPath);
        if (dir && dir !== '.') args.push('--ffmpeg-location', dir);
    }
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    if (/douyin\.com|iesdouyin\.com|twitter\.com|x\.com|instagram\.com/.test(url)) {
        if (fs.existsSync(cookiesPath)) args.push('--cookies', cookiesPath);
        else if (hasChromeAvailable) args.push('--cookies-from-browser', 'chrome');
    }
    return args;
};

// ===================================================================
//  任务队列系统 — 解决 Render 30 秒超时 + 手机下载兼容性
// ===================================================================
const taskStore = new Map();
let taskCounter = 0;

const startTask = (url, type, maxHeight) => {
    // 相同 URL + 类型 复用已有任务
    for (const [id, t] of taskStore) {
        if (t.url === url && t.type === type && t.status !== 'error') {
            console.log(`[任务] 复用 ${id}`);
            return id;
        }
    }

    const taskId = `${++taskCounter}_${Date.now().toString(36)}`;
    const tmpFile = path.join(os.tmpdir(), `task_${taskId}.mp4`);
    const task = { url, type, status: 'downloading', file: null, error: null, tmpFile, created: Date.now() };
    taskStore.set(taskId, task);

    console.log(`[任务 ${taskId}] 开始 ${type}: ${url.substring(0, 80)}`);

    const doAttempt = (attempt) => {
        const currentTmp = attempt === 1 ? tmpFile : tmpFile.replace('.mp4', `_r${attempt}.mp4`);
        const args = buildYtdlpArgs(url, currentTmp, maxHeight, attempt === 1);
        const child = spawn(ytdlpPath, args);

        let stderr = '';
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.stdout.on('data', () => {});

        child.on('error', err => {
            console.error(`[任务 ${taskId}] spawn 错误:`, err.message);
            task.status = 'error';
            task.error = friendlyError(err.message);
        });

        child.on('close', code => {
            if (code !== 0) {
                if (attempt === 1) {
                    console.log(`[任务 ${taskId}] 严格模式失败，宽松重试...`);
                    return doAttempt(2);
                }
                task.status = 'error';
                task.error = friendlyError(stderr);
                console.error(`[任务 ${taskId}] 失败:`, stderr.substring(0, 300));
                return;
            }

            const actualFile = findOutputFile(currentTmp);
            if (!actualFile) {
                if (attempt === 1) return doAttempt(2);
                task.status = 'error';
                task.error = '文件未生成';
                return;
            }

            const info = probeFile(actualFile);
            if (!info.hasVideo && attempt === 1) {
                console.log(`[任务 ${taskId}] 纯音频，重试...`);
                fs.unlink(actualFile, () => {});
                return doAttempt(2);
            }

            // 转码（VP9 → H264）
            task.status = 'transcoding';
            reencodeToH264(actualFile).then(finalFile => {
                task.file = finalFile;
                task.status = 'done';
                const size = (fs.statSync(finalFile).size / 1048576).toFixed(1);
                console.log(`[任务 ${taskId}] 完成: ${size}MB`);
            }).catch(() => {
                task.file = actualFile;
                task.status = 'done';
            });
        });
    };

    doAttempt(1);

    // 30 分钟后清理
    setTimeout(() => {
        const t = taskStore.get(taskId);
        if (t?.file && fs.existsSync(t.file)) fs.unlink(t.file, () => {});
        taskStore.delete(taskId);
        console.log(`[任务 ${taskId}] 已清理`);
    }, 1800000);

    return taskId;
};

// ===================================================================
//  路由
// ===================================================================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 解析接口（不变）---
app.post('/api/parse', async (req, res) => {
    const { url } = req.body;
    console.log(`[请求] ${url}`);
    if (!url) return res.status(400).json({ success: false, message: '提供链接为空' });
    if (!isValidUrl(url)) return res.status(400).json({ success: false, message: '链接格式无效' });

    try {
        const opts = {
            dumpJson: true, noWarnings: true, noPlaylist: true,
            addHeader: ['User-Agent:Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36']
        };
        if (/douyin\.com|iesdouyin\.com|twitter\.com|x\.com|instagram\.com/.test(url)) {
            const cp = path.join(__dirname, 'cookies.txt');
            if (fs.existsSync(cp)) opts.cookies = cp;
            else if (hasChromeAvailable) opts.cookiesFromBrowser = 'chrome';
        }

        const metadata = await youtubedl(url, opts);
        console.log(`[成功] ${metadata.title}`);

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

        let proxyMediaList;
        if (isVideo) {
            proxyMediaList = []; // 前端用任务系统加载预览
        } else {
            proxyMediaList = rawMediaList.map(u => {
                const id = cacheUrl(u, url, 'image');
                return `/api/stream/${id}`;
            });
        }

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

// --- 任务系统接口 ---

// POST /api/prepare — 启动下载/预览任务，立即返回任务 ID（不阻塞）
app.post('/api/prepare', (req, res) => {
    const { url, type } = req.body;
    if (!url || !isValidUrl(url)) return res.status(400).json({ error: '无效链接' });
    const maxHeight = type === 'preview' ? 720 : null;
    const taskId = startTask(url, type || 'download', maxHeight);
    res.json({ taskId });
});

// GET /api/task/:id — 查询任务状态（前端轮询）
app.get('/api/task/:id', (req, res) => {
    const task = taskStore.get(req.params.id);
    if (!task) return res.status(404).json({ status: 'error', error: '任务不存在或已过期' });
    res.json({ status: task.status, error: task.error });
});

// GET /api/file/:id — 获取已完成的文件（支持 Range / iOS 视频）
app.get('/api/file/:id', (req, res) => {
    const task = taskStore.get(req.params.id);
    if (!task || task.status !== 'done' || !task.file || !fs.existsSync(task.file)) {
        return res.status(404).send('文件未就绪');
    }
    if (req.query.download === '1') {
        const title = req.query.title || 'download';
        const safeTitle = title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_\-]/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}.mp4"`);
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.sendFile(task.file); // sendFile 自动支持 Range 206
});

app.listen(PORT, () => console.log(`[启动] http://localhost:${PORT}`));
