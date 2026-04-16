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
    if (/empty.*response/i.test(msg)) return 'Instagram 需要登录才能访问，暂不支持解析私密内容';
    if (/instagram.*API.*not.*granting/i.test(msg)) return 'Instagram 接口受限，请稍后重试';
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

// 用 ffmpeg 探测文件信息（是否有视频、编码格式）
const probeFile = (filePath) => {
    try {
        const out = execSync(`"${ffmpegPath}" -i "${filePath}" 2>&1 || true`, { encoding: 'utf-8', timeout: 10000 });
        const hasVideo = /Stream.*Video:/i.test(out);
        const hasAudio = /Stream.*Audio:/i.test(out);
        // 检测视频编码
        const codecMatch = out.match(/Stream.*Video:\s*(\w+)/i);
        const vcodec = codecMatch ? codecMatch[1].toLowerCase() : '';
        return { hasVideo, hasAudio, vcodec };
    } catch { return { hasVideo: false, hasAudio: false, vcodec: '' }; }
};

// 如果视频编码不是 h264，转码为 h264（iOS 兼容）
const reencodeToH264 = (inputPath) => {
    return new Promise((resolve, reject) => {
        const info = probeFile(inputPath);
        // 已经是 h264 或没有视频轨道，不需要转码
        if (!info.hasVideo || info.vcodec === 'h264' || info.vcodec === 'avc1' || info.vcodec === 'avc') {
            return resolve(inputPath);
        }
        console.log(`[转码] ${info.vcodec} -> h264: ${path.basename(inputPath)}`);
        const outPath = inputPath.replace(/(\.\w+)$/, '_h264$1');
        const args = [
            '-i', inputPath,
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '23',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-y',
            outPath
        ];
        const child = spawn(ffmpegPath, args);
        let stderr = '';
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('error', err => {
            console.error('[转码错误]', err.message);
            resolve(inputPath); // 转码失败就用原文件
        });
        child.on('close', code => {
            if (code === 0 && fs.existsSync(outPath)) {
                const oldSize = fs.statSync(inputPath).size;
                const newSize = fs.statSync(outPath).size;
                console.log(`[转码] 完成: ${(oldSize/1048576).toFixed(1)}MB -> ${(newSize/1048576).toFixed(1)}MB`);
                fs.unlink(inputPath, () => {}); // 删除原文件
                resolve(outPath);
            } else {
                console.error('[转码] 失败:', stderr.substring(0, 200));
                resolve(inputPath); // 转码失败就用原文件
            }
        });
    });
};

// 通用 yt-dlp 下载参数
const buildYtdlpArgs = (url, outputPath, maxHeight, forceVideo = true) => {
    const args = [url];

    if (forceVideo) {
        // 优先选 h264 编码（iOS 兼容），然后才选其他编码
        let hf = maxHeight ? `[height<=${maxHeight}]` : '';
        args.push('-f', [
            // 第一优先：h264 视频 + aac 音频（最佳兼容性）
            `bv*${hf}[vcodec^=avc]+ba[ext=m4a]`,
            `bv*${hf}[vcodec^=avc]+ba`,
            `bv*${hf}[vcodec^=avc]`,
            // 第二优先：h264 已合并格式
            `b${hf}[vcodec^=avc]`,
            // 第三优先：任何有视频的格式（VP9/AV1 等，后续会转码）
            `bv*${hf}[vcodec!=none]+ba`,
            `bv*${hf}[vcodec!=none]`,
            `b${hf}[vcodec!=none]`,
            `b${hf}`
        ].join('/'));
    }

    // 排序偏好 h264+aac+mp4
    const sortParts = ['vcodec:h264', 'acodec:aac', 'ext:mp4:m4a'];
    if (maxHeight) sortParts.push(`res:${maxHeight}`);
    args.push('-S', sortParts.join(','));

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

    // Cookies
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    const needsCookies = /douyin\.com|iesdouyin\.com|twitter\.com|x\.com|instagram\.com/.test(url);
    if (needsCookies) {
        if (fs.existsSync(cookiesPath)) {
            args.push('--cookies', cookiesPath);
        } else if (hasChromeAvailable) {
            args.push('--cookies-from-browser', 'chrome');
        }
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
    const args = buildYtdlpArgs(pageUrl, tmpFile, 720, true);
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

        let actualFile = findOutputFile(tmpFile);
        if (!actualFile) {
            entry.clients.forEach(c => { if (!c.headersSent) c.status(500).send('预览文件未生成'); });
            entry.clients = [];
            previewCache.delete(pageUrl);
            return;
        }

        const sizeMB = (fs.statSync(actualFile).size / 1024 / 1024).toFixed(1);
        console.log(`[预览] 下载完成: ${sizeMB}MB，检查编码...`);

        // 如果不是 h264，转码为 h264（确保 iOS 能播放）
        reencodeToH264(actualFile).then(finalFile => {
            entry.filePath = finalFile;
            entry.ready = true;
            entry.clients.forEach(c => { if (!c.headersSent) c.sendFile(finalFile); });
            entry.clients = [];
            // 30 分钟后清理
            setTimeout(() => { fs.unlink(finalFile, () => {}); previewCache.delete(pageUrl); }, 1800000);
        });
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

    // 实际下载逻辑（支持重试）
    const doDownload = (attempt) => {
        const tmpFile = path.join(os.tmpdir(), `dl_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
        // 第一次用严格模式（强制视频），失败后用宽松模式
        const args = buildYtdlpArgs(decodedUrl, tmpFile, null, attempt === 1);

        console.log(`[下载] 尝试 #${attempt}, yt-dlp args:`, args.slice(1).join(' '));
        const child = spawn(ytdlpPath, args);

        let stderrBuf = '';
        child.stdout.on('data', d => { console.log('[下载 stdout]', d.toString().trim()); });
        child.stderr.on('data', d => { const m = d.toString(); stderrBuf += m; });

        child.on('error', err => {
            console.error('[下载错误]', err.message);
            fs.unlink(tmpFile, () => {});
            if (!res.headersSent) res.status(500).send('下载失败');
        });

        child.on('close', code => {
            if (code !== 0) {
                console.error(`[下载] 尝试 #${attempt} 失败:`, stderrBuf.substring(0, 300));
                // 如果严格视频模式失败（没有视频格式匹配），用宽松模式重试
                if (attempt === 1) {
                    console.log('[下载] 严格视频模式失败，用宽松模式重试...');
                    fs.unlink(tmpFile, () => {});
                    return doDownload(2);
                }
                fs.unlink(tmpFile, () => {});
                if (!res.headersSent) return res.status(500).send('下载失败');
                return;
            }

            const actualFile = findOutputFile(tmpFile);
            if (!actualFile) {
                console.error('[下载] 找不到输出文件');
                if (attempt === 1) { fs.unlink(tmpFile, () => {}); return doDownload(2); }
                if (!res.headersSent) res.status(500).send('下载失败：文件未生成');
                return;
            }

            const info = probeFile(actualFile);
            const sizeMB = (fs.statSync(actualFile).size / 1048576).toFixed(1);
            console.log(`[下载] 尝试 #${attempt} 完成: ${sizeMB}MB, 含视频=${info.hasVideo}, 编码=${info.vcodec}`);

            // 第一次下载得到纯音频 → 宽松模式重试
            if (!info.hasVideo && attempt === 1) {
                console.log('[下载] 输出是纯音频，用宽松模式重试...');
                fs.unlink(actualFile, () => {});
                return doDownload(2);
            }

            // 如果不是 h264，转码为 h264（确保手机能播放）
            const sendFile = (filePath) => {
                const stat = fs.statSync(filePath);
                const ext = path.extname(filePath).toLowerCase() || '.mp4';
                res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}${ext}"`);
                res.setHeader('Content-Type', 'video/mp4');
                res.setHeader('Content-Length', stat.size);
                const stream = fs.createReadStream(filePath);
                stream.pipe(res);
                stream.on('end', () => fs.unlink(filePath, () => {}));
                stream.on('error', () => { fs.unlink(filePath, () => {}); if (!res.headersSent) res.status(500).send('下载失败'); });
            };

            reencodeToH264(actualFile).then(finalFile => {
                if (res.headersSent) { fs.unlink(finalFile, () => {}); return; }
                sendFile(finalFile);
            });
        });

        res.on('close', () => {
            if (!child.killed) child.kill();
            setTimeout(() => fs.unlink(tmpFile, () => {}), 5000);
        });
    };

    doDownload(1);
});

app.listen(PORT, () => console.log(`[启动] http://localhost:${PORT}`));
