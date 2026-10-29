// @name iKanBot
// @author 
// @description 刮削：支持，弹幕：支持，嗅探：支持
// @dependencies: axios, cheerio, crypto
// @version 1.0.7
// @downloadURL https://gh-proxy.org/https://github.com/xiaohu1949/OmniBox-Spider/raw/refs/heads/main/影视/采集/iKanBot.js


/**
 * ============================================================================
 * iKanBot资源 - OmniBox 爬虫脚本
 * ============================================================================
 */
const axios = require("axios");
const cheerio = require("cheerio");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const OmniBox = require("omnibox_sdk");

// ========== 全局配置 ==========
const ikanbotConfig = {
    host: "https://www1.ikanbot.com",
    headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"
    }
};
const DANMU_API = process.env.DANMU_API || "";

const axiosInstance = axios.create({
    timeout: 15000,
    httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
    httpAgent: new http.Agent({ keepAlive: true })
});

const PAGE_LIMIT = 20;

/**
 * 日志工具函数
 */
const logInfo = (message, data = null) => {
    const output = data ? `${message}: ${JSON.stringify(data)}` : message;
    OmniBox.log("info", `[iKanBot-DEBUG] ${output}`);
};

const logError = (message, error) => {
    OmniBox.log("error", `[iKanBot-DEBUG] ${message}: ${error.message || error}`);
};

// warn 级别才会进客户端日志面板（info 会被过滤）
const logWarn = (message, data = null) => {
    const output = data !== undefined && data !== null ? `${message}: ${JSON.stringify(data)}` : message;
    OmniBox.log("warn", `[iKanBot] ${output}`);
};

const encodeMeta = (obj) => {
    try {
        return Buffer.from(JSON.stringify(obj || {}), 'utf8').toString('base64');
    } catch {
        return '';
    }
};

const decodeMeta = (str) => {
    try {
        const raw = Buffer.from(str || '', 'base64').toString('utf8');
        return JSON.parse(raw || '{}');
    } catch {
        return {};
    }
};

/* ============================================================================
 * 多线路解析（v1.0.4 新增）
 *
 * 站点 /api/getResN 一次就返回多组播放源（实测 flag: kuaikan / bfzym3u8 /
 * ffm3u8 / lzm3u8 / …），detail 里已被铺成「快看 / 暴风 / 非凡 / 量子」等多条线路，
 * 每条线路的 playId 就是 MacCMS 的 url 字段（多数是 CDN 真实直链，不需要嗅探）。
 * 但 play() 过去只把「用户点中的那一条」返回，该条 CDN 挂了这一集就放不了。
 * 所以：detail 阶段把「集序号 → 各线路直链」落盘，play 阶段一次全部列出。
 * 客户端每次调用都是新进程，状态必须落盘（OmniBox.setCache）。
 * ========================================================================== */
const MULTI_LINE_CACHE_PREFIX = "ikan:multi:v2";
const MULTI_LINE_TTL_SECONDS = 6 * 3600;
const MEDIA_URL_RE = /\.(m3u8|mp4|flv|ts|mkv|avi)(\?|#|$)/i;

/** cache key 必须是安全字符：iKanBot 的 videoId 是 /play/xxxx 这种路径，含 '/' 会被当目录分隔 */
function sanitizeCacheToken(value) {
    const raw = String(value == null ? "" : value);
    if (!raw) return "_empty";
    // 【v1.0.5】原先只做字符替换 + 截断 120，会**碰撞**：
    //   /play/611100 与 /play/611100?from=x 与 /play/611100#a 全部映射成同一个 key
    //   ⇒ A 片的线路清单被当成B 片返回（缓存 6 小时，用户完全无感知），超长 id 也会撞。
    // 改用 md5：一次性解决碰撞、截断、路径穿越三个问题。
    // 【v1.0.5】改用顶部已加载的 crypto，避免函数内require 在离线回归里拿不到
    try {
        return crypto.createHash("md5").update(raw, "utf8").digest("hex");
    } catch {
        return raw.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 120);
    }
}

function buildMultiLineCacheKey(videoId) {
    return `${MULTI_LINE_CACHE_PREFIX}:${sanitizeCacheToken(videoId)}`;
}

/**
 * 【v1.0.5】fid 分隔符从 `#` 换成 `§`：
 *   videoId 是 `/play/611100` 这类路径，分隔符可能出现在片名派生 id 里；
 *   `§` 会被 encodeURIComponent 转义成 %C2%A7，片名里几乎不出现，比 `#` 安全。
 *   解析一律「从尾部切」（videoId = 去掉末两段后重新拼回），对纯路径 id 与旧逻辑一致。
 */
const FID_SEP = "§";

function buildFid(videoId, sIdx, epKey) {
    return `${String(videoId == null ? "" : videoId)}${FID_SEP}${sIdx}${FID_SEP}${epKey}`;
}

/**
 * 集键用 extractEpisode 抽出的**真实集号**，不用线路内下标 ——
 * 快看/暴风/非凡/量子四条线路的集数与顺序并不一致，按下标对齐会播错集。
 * 抽不出集号时回退下标并加 `i` 前缀，与真实集号区分开。
 */
function resolveEpKey(ep, eIdx) {
    const epNum = extractEpisode(ep?.name || "");
    const n = parseInt(epNum, 10);
    if (Number.isInteger(n) && n > 0) return String(n);
    return `i${eIdx}`;
}

/** 从 playSources 抽「集序号 → 各线路直链」；fid 形如 <videoId>§<线路号>§<集键> */
function buildMultiLineMap(playSources) {
    const map = {};
    for (const source of playSources || []) {
        const lineName = String(source?.name || "线路");
        for (const ep of source?.episodes || []) {
            const [rawPart, metaPart] = String(ep?.playId || "").split("|||");
            const url = String(rawPart || "");
            if (!/^https?:\/\//i.test(url) || !MEDIA_URL_RE.test(url)) continue;
            const meta = decodeMeta(metaPart || "");
            const fidParts = String(meta?.fid || "").split(FID_SEP);
            if (fidParts.length < 3) continue;
            const epKey = fidParts[fidParts.length - 1];
            if (!map[epKey]) map[epKey] = [];
            map[epKey].push({ l: lineName, u: url });
        }
    }
    // 同集按地址去重（不同线路名可能指向同一个 CDN 地址）
    for (const key of Object.keys(map)) {
        const seen = new Set();
        map[key] = map[key].filter((it) => {
            if (seen.has(it.u)) return false;
            seen.add(it.u);
            return true;
        });
    }
    return map;
}

async function saveMultiLineMap(videoId, playSources) {
    try {
        const map = buildMultiLineMap(playSources);
        const epKeys = Object.keys(map);
        if (!videoId || epKeys.length === 0) return;
        await OmniBox.setCache(buildMultiLineCacheKey(videoId), JSON.stringify(map), MULTI_LINE_TTL_SECONDS);
        logInfo(`多线路清单已落盘: ${videoId} 覆盖 ${epKeys.length} 集, 首集 ${map[epKeys[0]].length} 条`);
    } catch (error) {
        logError("多线路清单落盘失败", error);
    }
}

async function loadMultiLineMap(videoId) {
    try {
        const raw = await OmniBox.getCache(buildMultiLineCacheKey(videoId));
        if (!raw) return null;
        const map = typeof raw === "string" ? JSON.parse(raw) : raw;
        return map && typeof map === "object" ? map : null;
    } catch {
        return null;
    }
}

/** 命中清单就把该集在所有线路上的直链一次返回（当前线路排第一）；返回 null 表示走原逻辑 */
async function resolveMultiLinePlay(rawPlayId, playMeta) {
    // 【v1.0.5】从尾部切，videoId 自身可能含分隔符
    const fidParts = String(playMeta?.fid || "").split(FID_SEP);
    if (fidParts.length < 3) return null;
    const videoId = fidParts.slice(0, -2).join(FID_SEP);
    const epKey = fidParts[fidParts.length - 1];
    const map = await loadMultiLineMap(videoId);
    const list = map?.[epKey];
    if (!Array.isArray(list) || list.length <= 1) return null;

    const current = list.find((it) => it.u === rawPlayId);
    const ordered = current ? [current, ...list.filter((it) => it !== current)] : list;
    return {
        urls: ordered.map((it) => ({ name: it.l, url: it.u })),
        parse: 0,
    };
}

/**
 * 图像地址修复 - 保留原版复杂逻辑
 */
const fixImageUrl = (imageUrl, baseURL = "", referer = "") => {
    if (!imageUrl) return '';

    let url = '';

    if (imageUrl.startsWith('http')) {
        url = imageUrl;
    } else if (imageUrl.startsWith('//')) {
        url = 'https:' + imageUrl;
    } else if (imageUrl.startsWith('/')) {
        url = ikanbotConfig.host + imageUrl;
    } else {
        url = ikanbotConfig.host + '/' + imageUrl.replace(/^\.?\//, '');
    }

    const isExternalUrl = !url.includes(ikanbotConfig.host) && url.startsWith('http');
    const isDouban = url.includes('doubanio.com');

    if (isDouban) {
        try {
            const finalReferer = referer || 'https://movie.douban.com';
            const urlWithHeaders = `${url}@Referer=${finalReferer}`;
            const encodedUrl = encodeURIComponent(urlWithHeaders);
            const proxyUrl = `${baseURL}/api/proxy/image?url=${encodedUrl}`;
            // logInfo("图片分组: 豆瓣代理", { input: imageUrl, finalUrl: url, referer: finalReferer, result: proxyUrl });
            return proxyUrl;
        } catch (error) {
            logError("处理豆瓣图片失败", error);
            return url;
        }
    }

    if (isExternalUrl) {
        try {
            let finalReferer = referer;
            if (!finalReferer) {
                try {
                    const urlObj = new URL(url);
                    finalReferer = `${urlObj.protocol}//${urlObj.host}`;
                } catch {
                    finalReferer = ikanbotConfig.host;
                }
            }
            const urlWithHeaders = `${url}@Referer=${finalReferer}`;
            const encodedUrl = encodeURIComponent(urlWithHeaders);
            const proxyUrl = `${baseURL}/api/proxy/image?url=${encodedUrl}`;
            // logInfo("图片分组: 外部代理", { input: imageUrl, finalUrl: url, referer: finalReferer, result: proxyUrl });
            return proxyUrl;
        } catch (error) {
            logError("处理图片 URL 失败", error);
            return url;
        }
    }

    // logInfo("图片分组: 直连", { input: imageUrl, finalUrl: url, result: url });
    return url;
};

// ========== 弹幕工具函数 ==========
const preprocessTitle = (title) => {
    if (!title) return "";
    return title
        .replace(/4[kK]|[xX]26[45]|720[pP]|1080[pP]|2160[pP]/g, " ")
        .replace(/[hH]\\.?26[45]/g, " ")
        .replace(/BluRay|WEB-DL|HDR|REMUX/gi, " ")
        .replace(/\.mp4|\.mkv|\.avi|\.flv/gi, " ");
};

const chineseToArabic = (cn) => {
    const map = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
    if (!isNaN(cn)) return parseInt(cn, 10);
    if (cn.length === 1) return map[cn] || cn;
    if (cn.length === 2) {
        if (cn[0] === '十') return 10 + map[cn[1]];
        if (cn[1] === '十') return map[cn[0]] * 10;
    }
    if (cn.length === 3) return map[cn[0]] * 10 + map[cn[2]];
    return cn;
};

const extractEpisode = (title) => {
    if (!title) return "";
    const processedTitle = preprocessTitle(title).trim();

    const cnMatch = processedTitle.match(/第\s*([零一二三四五六七八九十0-9]+)\s*[集话章节回期]/);
    if (cnMatch) return String(chineseToArabic(cnMatch[1]));

    const seMatch = processedTitle.match(/[Ss](?:\d{1,2})?[-._\s]*[Ee](\d{1,3})/i);
    if (seMatch) return seMatch[1];

    const epMatch = processedTitle.match(/\b(?:EP|E)[-._\s]*(\d{1,3})\b/i);
    if (epMatch) return epMatch[1];

    const bracketMatch = processedTitle.match(/[\[\(【(](\d{1,3})[\]\)】)]/);
    if (bracketMatch) {
        const num = bracketMatch[1];
        if (!["720", "1080", "480"].includes(num)) return num;
    }

    return "";
};

const buildFileNameForDanmu = (vodName, episodeTitle) => {
    if (!vodName) return "";
    if (!episodeTitle || episodeTitle === '正片' || episodeTitle === '播放') return vodName;

    const digits = extractEpisode(episodeTitle);
    if (digits) {
        const epNum = parseInt(digits, 10);
        if (epNum > 0) {
            if (epNum < 10) return `${vodName} S01E0${epNum}`;
            return `${vodName} S01E${epNum}`;
        }
    }
    return vodName;
};

const buildScrapedEpisodeName = (scrapeData, mapping, originalName) => {
    if (!mapping || mapping.episodeNumber === 0 || (mapping.confidence && mapping.confidence < 0.5)) {
        return originalName;
    }
    if (mapping.episodeName) {
        const epName = mapping.episodeNumber + "." + mapping.episodeName;
        return epName;
    }
    if (scrapeData && Array.isArray(scrapeData.episodes)) {
        const hit = scrapeData.episodes.find((ep) => ep.episodeNumber === mapping.episodeNumber && ep.seasonNumber === mapping.seasonNumber);
        if (hit?.name) {
            return `${hit.episodeNumber}.${hit.name}`;
        }
    }
    return originalName;
};

const buildScrapedDanmuFileName = (scrapeData, scrapeType, mapping, fallbackVodName, fallbackEpisodeName) => {
    if (!scrapeData) {
        return buildFileNameForDanmu(fallbackVodName, fallbackEpisodeName);
    }
    if (scrapeType === 'movie') {
        return scrapeData.title || fallbackVodName;
    }
    const title = scrapeData.title || fallbackVodName;
    const seasonAirYear = scrapeData.seasonAirYear || '';
    const seasonNumber = mapping?.seasonNumber || 1;
    const episodeNumber = mapping?.episodeNumber || 1;
    return `${title}.${seasonAirYear}.S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
};

const matchDanmu = async (fileName) => {
    if (!DANMU_API || !fileName) return [];

    try {
        logInfo(`匹配弹幕: ${fileName}`);
        const matchUrl = `${DANMU_API}/api/v2/match`;
        const response = await OmniBox.request(matchUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
            body: JSON.stringify({ fileName }),
        });

        if (response.statusCode !== 200) {
            logInfo(`弹幕匹配失败: HTTP ${response.statusCode}`);
            return [];
        }

        const matchData = JSON.parse(response.body);
        if (!matchData.isMatched) {
            logInfo("弹幕未匹配到");
            return [];
        }

        const matches = matchData.matches || [];
        if (matches.length === 0) return [];

        const firstMatch = matches[0];
        const episodeId = firstMatch.episodeId;
        const animeTitle = firstMatch.animeTitle || "";
        const episodeTitle = firstMatch.episodeTitle || "";
        if (!episodeId) return [];

        let danmakuName = "弹幕";
        if (animeTitle && episodeTitle) {
            danmakuName = `${animeTitle} - ${episodeTitle}`;
        } else if (animeTitle) {
            danmakuName = animeTitle;
        } else if (episodeTitle) {
            danmakuName = episodeTitle;
        }

        return [{
            name: danmakuName,
            url: `${DANMU_API}/api/v2/comment/${episodeId}?format=xml`,
        }];
    } catch (error) {
        logInfo(`弹幕匹配失败: ${error.message}`);
        return [];
    }
};

/**
 * 获取HTML内容
 */
const getHtml = async (url, headers = ikanbotConfig.headers) => {
    try {
        const response = await axiosInstance.get(url, { headers });
        return response.data;
    } catch (error) {
        logError(`获取HTML失败: ${url}`, error);
        return null;
    }
};

/**
 * 提取token逻辑 - 保留原版算法
 */
const extractToken = ($) => {
    const currentId = $('#current_id').val();
    let eToken = $('#e_token').val();
    if (!currentId || !eToken) return '';
    
    const idLength = currentId.length;
    const subId = currentId.substring(idLength - 4, idLength);
    let keys = [];
    
    for (let i = 0; i < subId.length; i++) {
        // 【v1.0.5】原未判 NaN：current_id 末4 位一旦含非数字（站点调整 ID 规则即触发），
        // splitPos = NaN%3+1 = NaN，substring(NaN,...) 退化成从头取 ⇒ token 全错、整个详情无播放源。
        const curInt = parseInt(subId[i], 10);
        if (!Number.isInteger(curInt)) return '';
        const splitPos = curInt % 3 + 1;
        // eToken 剩余长度不足就说明 token 结构变了，直接放弃而不是切出垃圾
        if (eToken.length < splitPos + 8) return '';
        keys[i] = eToken.substring(splitPos, splitPos + 8);
        eToken = eToken.substring(splitPos + 8, eToken.length);
    }
    
    return keys.join('');
};

/**
 * 解析播放源 - 适配 OmniBox 格式
 */
const parsePlaySourcesFromIkan = (playFrom, playList, vodName = '', videoId = '') => {
    // logInfo("开始解析iKanBot播放源", { from: playFrom, list: playList });
    
    const playSources = [];
    if (!playFrom || !playList) return playSources;
    
    const froms = playFrom.split('$$$');
    const urls = playList.split('$$$');
    
    for (let i = 0; i < froms.length; i++) {
        const sourceName = froms[i] || `线路${i + 1}`;
        const sourceItems = urls[i] ? urls[i].split('#') : [];
        
        const episodes = sourceItems.map((item, epIndex) => {
            // 【v1.0.5】原先 item.split('$') 后 parts[1] 会被截断 ——
            // MacCMS 的 url 里出现 `$`（部分 CDN 的 token/签名参数）时地址只剩半截。
            // 改为按**第一个** `$` 切，其余全部归入 url。
            const sepIdx = item.indexOf('$');
            const episodeName = (sepIdx >= 0 ? item.slice(0, sepIdx) : item) || '正片';
            const actualPlayId = sepIdx >= 0 ? item.slice(sepIdx + 1) : item;
            if (!actualPlayId) return null;
            // 【v1.0.5】集键用真实集号而非线路内下标，各线路集数不一致时按下标对齐会播错集
            const fid = buildFid(videoId, i, resolveEpKey({ name: episodeName }, epIndex));
            return {
                name: episodeName,
                playId: `${actualPlayId}|||${encodeMeta({ sid: videoId, fid, v: vodName || '', e: episodeName })}`,
                _fid: fid,
                _rawName: episodeName,
            };
        }).filter(e => e && e.playId);
        
        if (episodes.length > 0) {
            playSources.push({
                name: sourceName,
                episodes: episodes
            });
        }
    }
    
    // logInfo("播放源解析结果", playSources);
    return playSources;
};

// ========== 接口实现 ==========

/**
 * 首页
 */
// 【v1.0.7】首页短 TTL 缓存：客户端每次切源都是新进程，本源首页要并抓 3 个页面
// （热门电影/热门剧/首页），实测单次 2.3~2.7s。缓存后二次进入 <0.3s。
const HOME_CACHE_KEY = "ikanbot:home:v1";
const HOME_CACHE_TTL_SECONDS = 300; // 5 分钟

async function readHomeCache() {
    try {
        const raw = await OmniBox.getCache(HOME_CACHE_KEY);
        if (!raw) return null;
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        // 空结果绝不采用（防历史脏数据）
        if (parsed && Array.isArray(parsed.list) && parsed.list.length > 0) return parsed;
    } catch (e) {
        logWarn(`首页缓存读取失败，按未命中处理: ${e.message || e}`);
    }
    return null;
}

async function writeHomeCache(value) {
    // 空结果绝不入缓存（项目铁律）
    if (!value || !Array.isArray(value.list) || value.list.length === 0) return;
    try {
        await OmniBox.setCache(HOME_CACHE_KEY, JSON.stringify(value), HOME_CACHE_TTL_SECONDS);
    } catch (e) {
        logWarn(`首页缓存写入失败: ${e.message || e}`);
    }
}

async function home(params, context) {
    logInfo("进入首页");
    
    try {
        const cached = await readHomeCache();
        if (cached) {
            logInfo(`首页命中缓存 ${cached.list.length} 条`);
            return cached;
        }
        const baseURL = params?.context?.baseURL || params?.baseURL || context?.baseURL || "";
        // 获取分类
        const classes = [];

        // 【v1.0.5】原先三次请求串行 await，最坏 45s；改为并发，总耗时≈单次
        const [movieHtml, tvHtml, html] = await Promise.all([
            getHtml(ikanbotConfig.host + "/hot/index-movie-热门.html"),
            getHtml(ikanbotConfig.host + "/hot/index-tv-热门.html"),
            getHtml(ikanbotConfig.host),
        ]);

        // 分类名优先取页面里的 h1/面包屑；<title> 没有 '-' 时 split 会拿到整串再砍头，
        // 得到「分类电影」这种残缺名字（甚至空串）⇒ 首页分类不可用。
        const pickCategoryName = (doc, fallback) => {
            const $ = cheerio.load(doc);
            const h1 = $('h1, .breadcrumb a:last, .position a:last').first().text().trim();
            if (h1 && h1.length <= 12) return h1;
            const t = $('title:first').text().split('-')[0].replace(/^\s*.*?(热门|电影|电视剧)\s*/, '$1').trim();
            return t || fallback;
        };
        
        // 电影分类
        if (movieHtml) {
            classes.push({
                type_id: "/hot/index-movie-热门.html",
                type_name: pickCategoryName(movieHtml, "电影")
            });
        }
        
        // 电视剧分类
        if (tvHtml) {
            classes.push({
                type_id: "/hot/index-tv-热门.html",
                type_name: pickCategoryName(tvHtml, "电视剧")
            });
        }
        
        // 获取首页推荐
        const list = [];
        
        if (html) {
            const $ = cheerio.load(html);
            const items = $('div.v-list a.item');
            
            items.each((_, item) => {
                const img = $(item).find('img:first');
                const imgSrc = img.attr('data-src') || img.attr('src') || '';
                
                list.push({
                    vod_id: $(item).attr('href'),
                    vod_name: img.attr('alt') || $(item).find('.title').text() || '未知标题',
                    // 【v1.0.5】原先写 context.baseURL，context 为 undefined 时抛错
                    // 被外层 catch 吞掉 ⇒ 首页整页空白。函数开头已算出 baseURL，直接用它。
                    vod_pic: fixImageUrl(imgSrc, baseURL),
                    vod_remarks: $(item).find('.label').text() || ''
                });
            });
        }
        
        if (list.length === 0) logWarn("首页未解析到任何条目，页面结构可能已变更");
        const result = {
            class: classes,
            list: list.slice(0, 20)
        };
        await writeHomeCache(result);
        return result;
    } catch (e) {
        logError("首页获取失败", e);
        return { class: [], list: [] };
    }
}

/**
 * 分类列表
 */
async function category(params, context) {
    const { categoryId, page } = params;
    const pg = parseInt(page) || 1;
    const baseURL = context?.baseURL || params?.baseURL || "";
    
    logInfo(`请求分类: ${categoryId}, 页码: ${pg}`);
    
    try {
        const link = ikanbotConfig.host + categoryId.replace('.html', pg > 1 ? `-p-${pg}.html` : '.html');
        const html = await getHtml(link);
        
        if (!html) {
            logWarn(`分类 ${categoryId} 第 ${pg} 页请求返回空`);
            return { list: [], page: pg, pagecount: 1 };
        }
        
        const $ = cheerio.load(html);
        const items = $('div.v-list a.item');
        const list = [];
        
        items.each((_, item) => {
            const img = $(item).find('img:first');
            const imgSrc = img.attr('data-src') || img.attr('src') || '';
            
            list.push({
                vod_id: $(item).attr('href'),
                vod_name: img.attr('alt') || $(item).text().trim(),
                vod_pic: fixImageUrl(imgSrc, baseURL),
                vod_remarks: $(item).find('.label').text() || ''
            });
        });
        
        if (list.length === 0) logWarn(`分类 ${categoryId} 第 ${pg} 页解析到 0 条`);
        return {
            list: list,
            page: pg,
            pagecount: list.length >= PAGE_LIMIT ? pg + 1 : pg
        };
    } catch (e) {
        logError("分类请求失败", e);
        return { list: [], page: pg, pagecount: 0 };
    }
}

/**
 * 详情页
 */
async function detail(params, context) {
    const videoId = params.videoId;
    const baseURL = context?.baseURL || params?.baseURL || "";
    logInfo(`请求详情 ID: ${videoId}`);
    
    try {
        const html = await getHtml(ikanbotConfig.host + videoId);
        if (!html) return { list: [] };
        
        const $ = cheerio.load(html);
        const detail = $('div.detail');
        
        // 获取封面图片
        const coverImg = $('div.item-root > img');
        const coverSrc = coverImg.attr('data-src') || coverImg.attr('src') || '';
        
        // 提取token
        const token = extractToken($);
        const pureVideoId = videoId.substring(videoId.lastIndexOf('/') + 1);
        
        // 获取播放资源
        const resUrl = ikanbotConfig.host + '/api/getResN?videoId=' + pureVideoId + '&mtype=2&token=' + token;
        const resResponse = await axiosInstance.get(resUrl, {
            headers: {
                ...ikanbotConfig.headers,
                'Referer': ikanbotConfig.host
            }
        });
        
        const resData = resResponse.data;
        const apiList = resData.data?.list || [];
        
        let playlist = {};
        let arr = [];
        
        // 解析播放源
        for (const l of apiList) {
            try {
                const flagData = JSON.parse(l.resData);
                for (const f of flagData) {
                    const from = f.flag;
                    const urls = f.url;
                    if (!from || !urls) continue;
                    if (playlist[from]) continue;
                    playlist[from] = urls;
                }
            } catch (e) {
                logError('解析播放源失败', e);
            }
        }
        
        // 排序播放源
        for (const key in playlist) {
            if ('kuaikan' === key) {
                arr.push({ flag: '快看', url: playlist[key], sort: 1 });
            } else if ('bfzym3u8' === key) {
                arr.push({ flag: '暴风', url: playlist[key], sort: 2 });
            } else if ('ffm3u8' === key) {
                arr.push({ flag: '非凡', url: playlist[key], sort: 3 });
            } else if ('lzm3u8' === key) {
                arr.push({ flag: '量子', url: playlist[key], sort: 4 });
            } else {
                arr.push({ flag: key, url: playlist[key], sort: 5 });
            }
        }
        
        arr.sort((a, b) => a.sort - b.sort);
        
        // 获取影片基本信息
        const title = $(detail).find('h2').text().trim();
        const actor = $(detail).find('h3:nth-child(5)').text();
        const director = $(detail).find('h3:nth-child(4)').text() || '';

        const playFrom = arr.map(val => val.flag).join("$$$");
        const playList = arr.map(val => val.url).join("$$$");
        
        // 解析为 OmniBox 格式
        const playSources = parsePlaySourcesFromIkan(playFrom, playList, title, String(videoId || ''));

        // 刮削处理
        let scrapeData = null;
        let videoMappings = [];
        let scrapeType = '';
        const scrapeCandidates = [];

        for (const source of playSources) {
            for (const ep of source.episodes || []) {
                if (!ep._fid) continue;
                scrapeCandidates.push({
                    fid: ep._fid,
                    file_id: ep._fid,
                    file_name: ep._rawName || ep.name || '正片',
                    name: ep._rawName || ep.name || '正片',
                    format_type: 'video',
                });
            }
        }

        if (scrapeCandidates.length > 0) {
            try {
                const videoIdForScrape = String(videoId || '');
                const scrapingResult = await OmniBox.processScraping(videoIdForScrape, title || '', title || '', scrapeCandidates);
                OmniBox.log('info', `[iKanBot-DEBUG] 刮削处理完成,结果: ${JSON.stringify(scrapingResult || {}).substring(0, 200)}`);

                const metadata = await OmniBox.getScrapeMetadata(videoIdForScrape);
                scrapeData = metadata?.scrapeData || null;
                videoMappings = metadata?.videoMappings || [];
                scrapeType = metadata?.scrapeType || '';
            } catch (e) {
                logError('刮削处理失败', e);
            }
        }

        for (const source of playSources) {
            for (const ep of source.episodes || []) {
                const mapping = videoMappings.find((m) => m?.fileId === ep._fid);
                if (!mapping) continue;
                const oldName = ep.name;
                const newName = buildScrapedEpisodeName(scrapeData, mapping, oldName);
                if (newName && newName !== oldName) {
                    ep.name = newName;
                    OmniBox.log('info', `[iKanBot-DEBUG] 应用刮削后源文件名: ${oldName} -> ${newName}`);
                }
                ep._seasonNumber = mapping.seasonNumber;
                ep._episodeNumber = mapping.episodeNumber;
            }

            const hasEpisodeNumber = (source.episodes || []).some((ep) => ep._episodeNumber !== undefined && ep._episodeNumber !== null);
            if (hasEpisodeNumber) {
                source.episodes.sort((a, b) => {
                    const seasonA = a._seasonNumber || 0;
                    const seasonB = b._seasonNumber || 0;
                    if (seasonA !== seasonB) return seasonA - seasonB;
                    const episodeA = a._episodeNumber || 0;
                    const episodeB = b._episodeNumber || 0;
                    return episodeA - episodeB;
                });
            }
        }

        const normalizedPlaySources = playSources.map((source) => ({
            name: source.name,
            episodes: (source.episodes || []).map((ep) => ({
                name: ep.name,
                playId: ep.playId,
            })),
        }));
        if (normalizedPlaySources.length === 0) logWarn(`详情未解析到任何播放线路 videoId=${videoId}`);
        
        const fixedRemarks = '(线路利用网络爬虫技术获取,各线路的版本、清晰度、播放速度等存在差异请自行切换。建议避开晚上高峰时段。)';

        // 把「同一集在各条线路上的直链」落盘，供 play() 一次把全部线路都返回
        await saveMultiLineMap(String(videoId || ''), normalizedPlaySources);

        return {
            list: [{
                vod_id: videoId,
                vod_name: scrapeData?.title || title,
                vod_pic: scrapeData?.posterPath ? fixImageUrl(`https://image.tmdb.org/t/p/w500${scrapeData.posterPath}`, baseURL) : fixImageUrl(coverSrc, baseURL),
                vod_content: fixedRemarks,
                vod_actor: (scrapeData?.credits?.cast || []).slice(0, 5).map((c) => c?.name).filter(Boolean).join(',') || actor,
                vod_director: (scrapeData?.credits?.crew || []).filter((c) => c?.job === 'Director' || c?.department === 'Directing').slice(0, 3).map((c) => c?.name).filter(Boolean).join(',') || director,
                vod_remarks: '',
                vod_play_sources: normalizedPlaySources
            }]
        };
    } catch (e) {
        logError("详情获取失败", e);
        return { list: [] };
    }
}

/**
 * 搜索 - 保留严格匹配逻辑
 */
async function search(params, context) {
    const wd = params.keyword || params.wd || "";
    const pg = parseInt(params.page) || 1;
    const baseURL = context?.baseURL || params?.baseURL || "";
    
    logInfo(`搜索关键词: ${wd}, 页码: ${pg}`);
    
    try {
        const link = pg === 1
            ? ikanbotConfig.host + '/search?q=' + encodeURIComponent(wd)
            : ikanbotConfig.host + '/search?q=' + encodeURIComponent(wd) + '&p=' + pg;
        
        const html = await getHtml(link);
        if (!html) return { list: [], page: pg, pagecount: 1 };
        
        const $ = cheerio.load(html);
        const items = $('div.media');
        
        // 获取所有结果
        const allResults = [];
        items.each((_, item) => {
            const a = $(item).find('a:first');
            const img = $(item).find('img:first');
            const imgSrc = img.attr('data-src') || img.attr('src') || '';
            const remarks = $(item).find('span.label').first().text().trim();
            const title = img.attr('alt') || a.text().trim();
            
            allResults.push({
                vod_id: a.attr('href'),
                vod_name: title,
                vod_pic: fixImageUrl(imgSrc, baseURL),
                vod_remarks: remarks || '',
                originalTitle: title
            });
        });
        
        // 严格过滤:检查标题是否包含完整的搜索关键字
        const lowerKeyword = wd.toLowerCase().trim();
        const filteredList = allResults.filter(item => {
            const lowerTitle = item.vod_name.toLowerCase();
            
            // 1. 完全包含关键字
            if (lowerTitle.includes(lowerKeyword)) {
                return true;
            }
            
            // 2. 处理可能的关键字分割
            if (lowerKeyword.length >= 2) {
                const cleanTitle = lowerTitle.replace(/[·\-_:()()《》【】\s]/g, '');
                const cleanKeyword = lowerKeyword.replace(/[·\-_:()()《》【】\s]/g, '');
                
                if (cleanTitle.includes(cleanKeyword)) {
                    return true;
                }
                
                // 如果是中文,尝试字符级别匹配
                if (/[\u4e00-\u9fa5]/.test(lowerKeyword)) {
                    const keywordChars = cleanKeyword.split('');
                    return keywordChars.every(char => cleanTitle.includes(char));
                }
            }
            
            return false;
        });
        
        // 移除用于过滤的字段
        const finalList = filteredList.map(({ originalTitle, ...rest }) => rest);
        
        if (finalList.length === 0) logWarn(`搜索「${wd}」过滤后 0 条（原始命中 ${allResults.length} 条）`);
        return {
            list: finalList,
            page: pg,
            pagecount: finalList.length >= PAGE_LIMIT ? pg + 1 : pg
        };
    } catch (e) {
        logError("搜索失败", e);
        return { list: [], page: pg, pagecount: 0 };
    }
}

/**
 * 播放
 */
async function play(params) {
    let playId = params.playId;
    logInfo(`准备播放 ID: ${playId}`);
    // 【v1.0.5】原先无入口空值防护：playId 为空时会返回 url 为 undefined 的条目，
    // 客户端只能显示"播放失败"且无从报错。
    if (!playId || typeof playId !== "string") {
        logWarn("playId 为空或类型异常，直接返回空结果");
        return { urls: [], parse: 1, header: {} };
    }
    let vodName = "";
    let episodeName = "";
    let playMeta = {};
    let scrapedDanmuFileName = "";

    if (playId && playId.includes('|||')) {
        const [mainPlayId, metaB64] = playId.split('|||');
        playId = mainPlayId || '';
        playMeta = decodeMeta(metaB64 || '');
        vodName = playMeta.v || '';
        episodeName = playMeta.e || '';
        logInfo(`解析透传信息 - 视频: ${vodName}, 集数: ${episodeName}`);
    } else if (playId && playId.includes('|')) {
        const parts = playId.split('|');
        playId = parts.shift() || '';
        vodName = parts.shift() || '';
        episodeName = parts.join('|') || '';
        logInfo(`解析旧透传信息 - 视频: ${vodName}, 集数: ${episodeName}`);
    }

    try {
        const sourceVideoId = String(params.vodId || playMeta.sid || '');
        if (sourceVideoId) {
            const metadata = await OmniBox.getScrapeMetadata(sourceVideoId);
            if (metadata && metadata.scrapeData) {
                const mapping = (metadata.videoMappings || []).find((m) => m?.fileId === playMeta?.fid);
                scrapedDanmuFileName = buildScrapedDanmuFileName(
                    metadata.scrapeData,
                    metadata.scrapeType || '',
                    mapping,
                    vodName,
                    episodeName
                );
                if (metadata.scrapeData.title) {
                    vodName = metadata.scrapeData.title;
                }
                if (mapping?.episodeName) {
                    episodeName = mapping.episodeName;
                }
            }
        }
    } catch (e) {
        logInfo(`读取刮削元数据失败: ${e.message}`);
    }
    
    // iKanBot 播放地址处理，支持嗅探
    let playUrl = playId;
    if (playUrl && !playUrl.startsWith('http')) {
        playUrl = playUrl.startsWith('/') ? ikanbotConfig.host + playUrl : ikanbotConfig.host + '/' + playUrl;
    }

    const isDirectPlayable = playUrl && playUrl.match(/\.(m3u8|mp4|flv|avi|mkv|ts)/i);
    let finalUrl = playUrl;
    let finalHeader = { ...ikanbotConfig.headers, Referer: ikanbotConfig.host };

    // 命中 detail 落盘的多线路清单时，一次把该集在所有线路上的直链都返回（当前线路排第一）。
    // 注意不能提前 return —— 弹幕在后面还要挂到 playResponse 上。
    let multiLineResult = null;
    if (isDirectPlayable) {
        try {
            multiLineResult = await resolveMultiLinePlay(playUrl, playMeta);
            if (multiLineResult) {
                logInfo(`命中多线路清单，一次返回 ${multiLineResult.urls.length} 条`);
            }
        } catch (e) {
            logWarn(`多线路清单读取失败，退回单条: ${e.message}`);
        }
    }

    if (!isDirectPlayable && playUrl) {
        try {
            const sniffResult = await OmniBox.sniffVideo(playUrl);
            if (sniffResult && sniffResult.url) {
                finalUrl = sniffResult.url;
                finalHeader = sniffResult.header || finalHeader;
                logInfo("嗅探成功", { url: finalUrl });
            } else {
                logWarn("嗅探未返回有效地址");
            }
        } catch (e) {
            logWarn(`嗅探失败: ${e.message}`);
        }
    }

    const playResponse = {
        urls: multiLineResult ? multiLineResult.urls : [{ name: "默认", url: finalUrl }],
        parse: 0,
        header: finalHeader
    };

    if (DANMU_API && vodName) {
        const fileName = scrapedDanmuFileName || buildFileNameForDanmu(vodName, episodeName);
        logInfo(`尝试匹配弹幕文件名: ${fileName}`);
        if (fileName) {
            const danmakuList = await matchDanmu(fileName);
            if (danmakuList.length > 0) {
                playResponse.danmaku = danmakuList;
                logInfo("弹幕已添加到播放响应");
            }
        }
    } else if (!DANMU_API) {
        logInfo("DANMU_API 未配置，跳过弹幕匹配");
    }

    return playResponse;
}

module.exports = { home, category, search, detail, play };

const runner = require("spider_runner");
runner.run(module.exports);
