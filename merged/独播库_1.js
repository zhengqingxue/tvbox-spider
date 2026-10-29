// @name 独播库
// @author @caipeibin
// @description 刮削：支持，弹幕：支持，嗅探：支持
// @dependencies: axios
// @version 1.2.4
// @downloadURL https://gh-proxy.org/https://github.com/xiaohu1949/OmniBox-Spider/raw/refs/heads/main/影视/采集/独播库.js


/** 
 * OmniBox 爬虫脚本 - 独播库
 * 
 * 说明：
 * 1. 基于原始 TVBox T4 脚本逻辑转换为 OmniBox 标准 JS 模板。
 * 2. 实现了 `home` / `category` / `search` / `detail` / `play` 五个标准接口。
 * 3. 保留了原脚本的签名 (`sign`, `token`, `ssid`) 和 Base64 解码逻辑。
 */

const axios = require("axios");
const http = require("http");
const https = require("https");
const OmniBox = require("omnibox_sdk");

// ==================== 配置区域 ====================
const HOST = "https://api.dbokutv.com";
const REFERER_HOST = "https://www.duboku.tv";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const DEFAULT_HEADERS = {
    "User-Agent": UA,
    "Content-Type": "application/json",
    "Referer": `${REFERER_HOST}/`,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive"
};

const DANMU_API = process.env.DANMU_API || "";

// 站点列表每页固定返回的条数（实测 /vodshow/1--------1--- 为 48 条）
const PAGE_ITEMS = 48;

// ---- 封面图代理前缀（可选，v1.2.3）----
// 实测：本源的封面来自站点返回的 TnId 解码值，解出来就是 https://image.tmdb.org/t/p/w300/xxx.jpg
// —— 即图源是 TMDB 官方 CDN，站点自己并没有另存一套图，所以「换成站点自有图」这条路不存在。
// 而 image.tmdb.org / media.themoviedb.org / wsrv.nl 在容器网络下三次实测均 ECONNRESET（TCP 层被重置），
// 大陆网络下封面必然加载失败，这是站点自身的图源选择，脚本层无法换源。
// 若你自备了可用反代，设 DBK_IMG_PROXY=https://your-proxy（不带结尾 /）即可让封面走代理；
// 默认留空 = 输出与之前逐字节一致（零回归）。
const IMG_PROXY = String(process.env.DBK_IMG_PROXY || "").replace(/\/+$/, "");
const TMDB_IMG_ORIGIN = "https://image.tmdb.org";
function mapCover(url) {
    if (!url || !IMG_PROXY) return url || "";
    return url.startsWith(TMDB_IMG_ORIGIN) ? IMG_PROXY + url.slice(TMDB_IMG_ORIGIN.length) : url;
}

const axiosInstance = axios.create({
    timeout: 15 * 1000,
    httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
    httpAgent: new http.Agent({ keepAlive: true }),
});

// ==================== 日志工具 ====================
function logInfo(message, data = null) {
    const output = data ? `${message}: ${JSON.stringify(data)}` : message;
    OmniBox.log("info", `[独播库] ${output}`);
}
function logError(message, error) {
    OmniBox.log("error", `[独播库] ${message}: ${error?.message || error}`);
}

// ---- 短 TTL 缓存（客户端每次调用都是新进程，首页/分类被反复打上游）----
const HOME_CACHE_TTL = 300; // 5 分钟
const CAT_CACHE_TTL = 300; // 5 分钟
const readCache = async (key) => {
    try {
        const raw = await OmniBox.getCache(key);
        if (!raw) return null;
        return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
};
const writeCache = async (key, value, ttl) => {
    try {
        // 空结果绝不入缓存（项目铁律）
        if (!value || !Array.isArray(value.list) || value.list.length === 0) return;
        await OmniBox.setCache(key, JSON.stringify(value), ttl);
    } catch {
        /* 缓存失败不影响主流程 */
    }
};
const safeCacheKey = (s) => String(s).slice(0, 40).replace(/[^\w\u4e00-\u9fa5.-]/g, "_");

const encodeMeta = (obj) => {
    try {
        return Buffer.from(JSON.stringify(obj || {}), "utf8").toString("base64");
    } catch {
        return "";
    }
};

const decodeMeta = (str) => {
    try {
        const raw = Buffer.from(str || "", "base64").toString("utf8");
        return JSON.parse(raw || "{}");
    } catch {
        return {};
    }
};

// ==================== 辅助函数 ====================
const decodeDubokuData = (data) => {
    if (!data || typeof data !== 'string') return '';
    const strippedStr = data.trim().replace(/['"]/g, '');
    if (!strippedStr) return '';
    const segmentLength = 10;
    try {
        let processedBase64 = '';
        for (let i = 0; i < strippedStr.length; i += segmentLength) {
            const segment = strippedStr.slice(i, i + segmentLength);
            processedBase64 += segment.split('').reverse().join('');
        }
        processedBase64 = processedBase64.replace(/\./g, '=');
        const paddingNeeded = 4 - (processedBase64.length % 4);
        if (paddingNeeded !== 4) {
            processedBase64 += '='.repeat(paddingNeeded);
        }
        const decodedBytes = Buffer.from(processedBase64, 'base64');
        return decodedBytes.toString('utf-8');
    } catch (error) {
        logError('解码错误', error);
        return '';
    }
};

/**
 * 从 PaginationList 里解析真实总页数。
 * 站点返回形如 { Name: "1/7", Type: "ShortPage" }，老代码直接写死 pagecount。
 */
const parsePageCount = (data, fallbackPage = 1) => {
    const list = Array.isArray(data && data.PaginationList) ? data.PaginationList : [];
    for (const item of list) {
        const m = String((item && item.Name) || "").match(/(\d+)\s*\/\s*(\d+)/);
        if (m) {
            const totalPages = parseInt(m[2], 10) || 0;
            if (totalPages > 0) return Math.max(fallbackPage, totalPages);
        }
    }
    return fallbackPage;
};

const generateRandomString = (length) => {
    const characters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * characters.length);
        result += characters[randomIndex];
    }
    return result;
};

const interleaveStrings = (str1, str2) => {
    const result = [];
    const minLength = Math.min(str1.length, str2.length);
    for (let i = 0; i < minLength; i++) {
        result.push(str1[i]);
        result.push(str2[i]);
    }
    result.push(str1.slice(minLength));
    result.push(str2.slice(minLength));
    return result.join('');
};

const generateSignature = (url) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const randomNumber = Math.floor(Math.random() * 800000000);
    const valueA = randomNumber + 100000000;
    const valueB = 900000000 - randomNumber;
    const interleaved = interleaveStrings(`${valueA}${valueB}`, timestamp.toString());
    const ssid = Buffer.from(interleaved).toString('base64').replace(/=/g, '.');
    const sign = generateRandomString(60);
    const token = generateRandomString(38);
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}sign=${sign}&token=${token}&ssid=${ssid}`;
};

const isDirectVideoUrl = (url) => {
    if (!url) return false;
    return /\.(m3u8|mp4|flv|avi|mkv|ts)(\?|$)/i.test(url);
};

const sniffDubokuPlay = async (playUrl) => {
    if (!playUrl) return null;
    try {
        logInfo("尝试嗅探播放页", playUrl);
        const sniffed = await OmniBox.sniffVideo(playUrl);
        if (sniffed && sniffed.url) {
            logInfo("嗅探成功", sniffed.url);
            return {
                urls: [{ name: "嗅探线路", url: sniffed.url }],
                parse: 0,
                header: sniffed.header || {
                    "User-Agent": UA,
                    "Referer": playUrl
                }
            };
        }
    } catch (error) {
        logInfo(`嗅探失败: ${error.message || error}`);
    }
    return null;
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
        const hit = scrapeData.episodes.find(
            (ep) => ep.episodeNumber === mapping.episodeNumber && ep.seasonNumber === mapping.seasonNumber
        );
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
    if (scrapeType === "movie") {
        return scrapeData.title || fallbackVodName;
    }
    const title = scrapeData.title || fallbackVodName;
    const seasonAirYear = scrapeData.seasonAirYear || "";
    const seasonNumber = mapping?.seasonNumber || 1;
    const episodeNumber = mapping?.episodeNumber || 1;
    return `${title}.${seasonAirYear}.S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
};

function preprocessTitle(title) {
    if (!title) return "";
    return title
        .replace(/4[kK]|[xX]26[45]|720[pP]|1080[pP]|2160[pP]|1280x720|1920x1080/g, " ")
        .replace(/[hH]\.?26[45]/g, " ")
        .replace(/BluRay|WEB-DL|HDR|REMUX/gi, " ")
        .replace(/\.mp4|\.mkv|\.avi|\.flv/gi, " ");
}

function chineseToArabic(cn) {
    const map = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
    if (!isNaN(cn)) return parseInt(cn);
    if (cn.length === 1) return map[cn] || cn;
    if (cn.length === 2) {
        if (cn[0] === '十') return 10 + map[cn[1]];
        if (cn[1] === '十') return map[cn[0]] * 10;
    }
    if (cn.length === 3) return map[cn[0]] * 10 + map[cn[2]];
    return cn;
}

function extractEpisode(title) {
    if (!title) return "";
    const processedTitle = preprocessTitle(title).trim();
    const seMatch = processedTitle.match(/[Ss](?:\d{1,2})?[-._\s]*[Ee](\d{1,3})/i);
    if (seMatch) return seMatch[1];
    const cnMatch = processedTitle.match(/第\s*([零一二三四五六七八九十0-9]+)\s*[集话章节回期]/);
    if (cnMatch) return String(chineseToArabic(cnMatch[1]));
    const epMatch = processedTitle.match(/\b(?:EP|E)[-._\s]*(\d{1,3})\b/i);
    if (epMatch) return epMatch[1];
    const bracketMatch = processedTitle.match(/[\[\(【（](\d{1,3})[\]\)】）]/);
    if (bracketMatch) {
        const num = bracketMatch[1];
        if (!["720", "1080", "480"].includes(num)) return num;
    }
    const standaloneMatches = processedTitle.match(/(?:^|[\s\-\._\[\]])(\d{1,3})(?![0-9pP])/g);
    if (standaloneMatches) {
        const candidates = standaloneMatches
            .map(m => m.match(/\d+/)[0])
            .filter(num => {
                const n = parseInt(num);
                return n > 0 && n < 300 && !["720", "480", "264", "265"].includes(num);
            });
        if (candidates.length > 0) {
            const normalEp = candidates.find(n => parseInt(n) < 100);
            return normalEp || candidates[0];
        }
    }
    return "";
}

function buildFileNameForDanmu(vodName, episodeTitle) {
    if (!vodName) return "";
    if (!episodeTitle || episodeTitle === '正片' || episodeTitle === '播放') {
        return vodName;
    }
    const digits = extractEpisode(episodeTitle);
    if (digits) {
        const epNum = parseInt(digits, 10);
        if (epNum > 0) {
            if (epNum < 10) {
                return `${vodName} S01E0${epNum}`;
            }
            return `${vodName} S01E${epNum}`;
        }
    }
    return vodName;
}

async function matchDanmu(fileName) {
    if (!DANMU_API || !fileName) {
        return [];
    }
    try {
        logInfo(`匹配弹幕: ${fileName}`);
        const matchUrl = `${DANMU_API}/api/v2/match`;
        const response = await OmniBox.request(matchUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": UA
            },
            body: JSON.stringify({ fileName: fileName })
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
        const danmakuURL = `${DANMU_API}/api/v2/comment/${episodeId}?format=xml`;
        logInfo(`弹幕匹配成功: ${danmakuName}`);
        return [{ name: danmakuName, url: danmakuURL }];
    } catch (error) {
        logInfo(`弹幕匹配失败: ${error.message || error}`);
        return [];
    }
}

// ==================== OmniBox 标准接口实现 ====================
async function home(params) {
    const classes = [
        { type_id: "2", type_name: "连续剧" },
        { type_id: "3", type_name: "综艺" },
        { type_id: "1", type_name: "电影" },
        { type_id: "4", type_name: "动漫" }
    ];
    // 该站筛选器在站点侧是加密 PId 驱动的，实测明文 / PId 拼 URL 均无法生效（返回内容与不筛选一致），
    // 故不对外暴露筛选项，避免出现「选了没反应」的假筛选。
    const filters = {};

    try {
        const cached = await readCache("dbk:home:v1");
        if (cached) return cached;

        const url = generateSignature(`${HOST}/home`);
        logInfo("获取首页推荐", { url });
        const response = await axiosInstance.get(url, { headers: DEFAULT_HEADERS });
        const data = response.data;
        const list = [];
        if (Array.isArray(data)) {
            data.forEach(category => {
                const vodList = category.VodList || [];
                vodList.forEach(vod => {
                    const vodId = vod.DId || vod.DuId || '';
                    const vodPic = vod.TnId || '';
                    list.push({
                        vod_id: decodeDubokuData(vodId),
                        vod_name: vod.Name || '',
                        vod_pic: mapCover(decodeDubokuData(vodPic)),
                        vod_remarks: vod.Tag || ''
                    });
                });
            });
        }
        logInfo(`获取到 ${list.length} 个首页推荐`);
        if (list.length === 0) logWarn("首页推荐返回 0 条，接口可能变更或签名失效");
        // 首页裁到 40 条：封面是 TMDB（大陆不可达，除非自备 DBK_IMG_PROXY 反代），
        // 条数越多破图越多越显卡；40 条已够首屏铺满
        const result = { class: classes, filters, list: list.slice(0, 40) };
        await writeCache("dbk:home:v1", result, HOME_CACHE_TTL);
        return result;
    } catch (error) {
        logError("获取首页数据失败", error);
        return { class: classes, filters, list: [] };
    }
}

async function category(params) {
    const categoryId = params.categoryId;
    const page = parseInt(params.page, 10) || 1;

    const cacheKey = `dbk:cat:v1:${safeCacheKey(categoryId)}:${page}`;
    try {
        const cached = await readCache(cacheKey);
        if (cached) return cached;

        const pageStr = page === 1 ? '' : page.toString();
        const path = `/vodshow/${categoryId}--------${pageStr}---`;
        const url = generateSignature(HOST + path);
        logInfo(`获取分类列表: ${categoryId} 第 ${page} 页`, { url });
        const response = await axiosInstance.get(url, { headers: DEFAULT_HEADERS });
        const data = response.data;
        const list = [];

        if (data && data.VodList && Array.isArray(data.VodList)) {
            data.VodList.forEach(vod => {
                const vodId = vod.DId || vod.DuId || '';
                const vodPic = vod.TnId || '';
                list.push({
                    vod_id: decodeDubokuData(vodId),
                    vod_name: vod.Name || '',
                    vod_pic: mapCover(decodeDubokuData(vodPic)),
                    vod_remarks: vod.Tag || ''
                });
            });
        }
        if (list.length === 0) logWarn(`分类 ${categoryId} 第 ${page} 页返回 0 条`);

        // 【修复】真实分页信息在 PaginationList 里。老代码写死 pagecount:9999 / total:999999 / limit:20，
        // 前端翻页条永远拉不到底，且 limit 与站点实际每页条数（48）不符。
        const pagecount = parsePageCount(data, page);
        const result = { list, page, pagecount, limit: PAGE_ITEMS, total: pagecount * PAGE_ITEMS };
        await writeCache(cacheKey, result, CAT_CACHE_TTL);
        return result;
    } catch (error) {
        logError("获取分类数据失败", error);
        return { list: [], page: 1, pagecount: 0, limit: 0, total: 0 };
    }
}

async function search(params) {
    const keyword = params.keyword || "";
    const page = parseInt(params.page, 10) || 1;

    try {
        const baseUrl = generateSignature(`${HOST}/vodsearch`);
        const url = `${baseUrl}&wd=${encodeURIComponent(keyword)}`;
        logInfo(`搜索 "${keyword}"`, { url });
        const response = await axiosInstance.get(url, { headers: DEFAULT_HEADERS });
        const data = response.data;
        const list = [];
        if (Array.isArray(data)) {
            data.forEach(vod => {
                const vodId = vod.DId || vod.DuId || '';
                const vodPic = vod.TnId || '';
                list.push({
                    vod_id: decodeDubokuData(vodId),
                    vod_name: vod.Name || '',
                    vod_pic: mapCover(decodeDubokuData(vodPic)),
                    vod_remarks: vod.Tag || '',
                    vod_actor: vod.Actor || '',
                    vod_score: vod.Rating || ''
                });
            });
        }
        logInfo(`搜索 "${keyword}" 找到 ${list.length} 个结果`);
        // 搜索接口返回的是纯数组，不带分页元信息，故固定单页
        return { list, page, pagecount: 1, limit: PAGE_ITEMS, total: list.length };
    } catch (error) {
        logError("搜索失败", error);
        return { list: [], page: 1, pagecount: 0, limit: 0, total: 0 };
    }
}

async function detail(params) {
    const vodId = params.videoId;

    // 【v1.2.1】原先不判空：params.videoId 为 undefined 时 vodId.startsWith 抛错
    // 被外层 catch 吞掉 ⇒ 返回 {list:[]}，与 iKanBot / 热播 的处理不一致。
    if (!vodId || typeof vodId !== "string") {
        logWarn("videoId 为空或类型异常");
        return { list: [] };
    }

    try {
        let detailPath = vodId.startsWith('/') ? vodId : '/' + vodId;
        const url = generateSignature(HOST + detailPath);
        logInfo("获取详情", { url });
        const response = await axiosInstance.get(url, { headers: DEFAULT_HEADERS });
        const data = response.data;
        if (!data) return { list: [] };

        // DId / TnId 都是加密串，先解码。
        // 【关键修复】老代码把 vod_id / vod_pic 的声明放在下面 if 块之后，而 if 块内部已经引用了 vod_id
        // （`String(vodId || vod_id || "")`）—— const 的 TDZ 会抛 "Cannot access 'vod_id' before initialization"，
        // 被 catch 吞掉后直接 return { list: [] }，等于详情页 100% 打不开。声明提前即可。
        const vod_pic = decodeDubokuData(data.TnId || '');
        const vod_id = decodeDubokuData(data.DId || data.DuId || '') || vodId;

        let vod_play_url = '';
        const playList = [];
        let vod_play_sources = [];
        if (data.Playlist && Array.isArray(data.Playlist)) {
            data.Playlist.forEach(episode => {
                const episodeName = episode.EpisodeName || `第${playList.length + 1}集`;
                const videoId = decodeDubokuData(episode.VId || '');
                if (videoId) {
                    playList.push(`${episodeName}$${videoId}`);
                }
            });
            vod_play_url = playList.join('#');
            const videoIdForScrape = String(vodId || vod_id || "");
            // 【v1.2.1】所有 VId 都解码失败时 playList 为空，原先仍会push 一条
            // episodes 为空的「独播库」线路 ⇒ vod_play_sources.length > 0 成立、
            // 白跑一次 processScraping。这里只在真有集数时才建线路。
            if (playList.length === 0) {
                logWarn("Playlist 全部解码失败，本次不生成播放线路");
            } else {
            vod_play_sources = [
                {
                    name: '独播库',
                    episodes: playList.map((item, epIndex) => {
                        // 【v1.2.1】原先 item.split('$') 后取 parts[1]，url 里出现 `$`
                        // （部分 CDN 的 token/签名参数）时地址会被截断。改为按第一个 `$` 切。
                        const sepIdx = item.indexOf('$');
                        const episodeName = (sepIdx >= 0 ? item.slice(0, sepIdx) : item) || '播放';
                        const actualUrl = sepIdx >= 0 ? item.slice(sepIdx + 1) : item;
                        if (!actualUrl) return null;
                        const fid = `${videoIdForScrape}#0#${epIndex}`;
                        const combinedId = `${actualUrl}|||${encodeMeta({ sid: String(videoIdForScrape || ""), fid, v: data.Name || "", e: episodeName })}`;
                        return {
                            name: episodeName,
                            playId: combinedId,
                            _fid: fid,
                            _rawName: episodeName
                        };
                    }).filter(ep => ep && ep.playId)
                }
            ];
            }
        }

        const detail = {
            vod_id: vod_id,
            vod_name: data.Name || '',
            vod_pic: mapCover(vod_pic) || '',
            vod_remarks: data.Tag ? `评分：${data.Rating || '暂无'}` : '',
            vod_year: data.ReleaseYear || '',
            vod_area: data.Region || '',
            vod_actor: Array.isArray(data.Actor) ? data.Actor.join(',') : data.Actor || '',
            vod_director: data.Director || '',
            vod_content: data.Description || '',
            vod_play_from: '独播库',
            vod_play_url: vod_play_url,
            vod_play_sources: vod_play_sources,
            type_name: `${data.Genre || ''},${data.Scenario || ''},${data.Language || ''}`
        };

        if (vod_play_sources.length > 0) {
            const scrapeCandidates = [];
            for (const source of vod_play_sources) {
                for (const ep of source.episodes || []) {
                    if (!ep._fid) continue;
                    scrapeCandidates.push({
                        fid: ep._fid,
                        file_id: ep._fid,
                        file_name: ep._rawName || ep.name || "正片",
                        name: ep._rawName || ep.name || "正片",
                        format_type: "video"
                    });
                }
            }

            if (scrapeCandidates.length > 0) {
                try {
                    const videoIdForScrape = String(vod_id || "");
                    await OmniBox.processScraping(videoIdForScrape, detail.vod_name || "", detail.vod_name || "", scrapeCandidates);
                    const metadata = await OmniBox.getScrapeMetadata(videoIdForScrape);
                    const scrapeData = metadata?.scrapeData || null;
                    const videoMappings = metadata?.videoMappings || [];
                    const scrapeType = metadata?.scrapeType || "";
                    logInfo("刮削元数据读取完成", { hasScrapeData: !!scrapeData, mappingCount: videoMappings.length, scrapeType });

                    for (const source of vod_play_sources) {
                        for (const ep of source.episodes || []) {
                            const mapping = videoMappings.find((m) => m?.fileId === ep._fid);
                            if (!mapping) continue;
                            const oldName = ep.name;
                            const newName = buildScrapedEpisodeName(scrapeData, mapping, oldName);
                            if (newName && newName !== oldName) {
                                ep.name = newName;
                            }
                            ep._seasonNumber = mapping.seasonNumber;
                            ep._episodeNumber = mapping.episodeNumber;
                        }
                        const hasEpisodeNumber = (source.episodes || []).some(
                            (ep) => ep._episodeNumber !== undefined && ep._episodeNumber !== null
                        );
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

                    detail.vod_play_sources = vod_play_sources.map((source) => ({
                        name: source.name,
                        episodes: (source.episodes || []).map((ep) => ({
                            name: ep.name,
                            playId: ep.playId
                        }))
                    }));

                    if (scrapeData) {
                        detail.vod_name = scrapeData.title || detail.vod_name;
                        if (scrapeData.posterPath) {
                            detail.vod_pic = mapCover(`https://image.tmdb.org/t/p/w500${scrapeData.posterPath}`);
                        }
                        if (scrapeData.overview) {
                            detail.vod_content = scrapeData.overview;
                        }
                        if (scrapeData.releaseDate) {
                            detail.vod_year = String(scrapeData.releaseDate).substring(0, 4) || detail.vod_year;
                        }
                        const actors = (scrapeData.credits?.cast || []).slice(0, 5).map((c) => c?.name).filter(Boolean).join(",");
                        if (actors) {
                            detail.vod_actor = actors;
                        }
                        const directors = (scrapeData.credits?.crew || [])
                            .filter((c) => c?.job === "Director" || c?.department === "Directing")
                            .slice(0, 3)
                            .map((c) => c?.name)
                            .filter(Boolean)
                            .join(",");
                        if (directors) {
                            detail.vod_director = directors;
                        }
                    }
                } catch (error) {
                    logError("刮削处理失败", error);
                }
            }
        }

        logInfo(`详情获取成功，找到 ${playList.length} 个剧集`);
        return { list: [detail] };
    } catch (error) {
        logError("获取详情失败", error);
        return { list: [] };
    }
}

async function play(params) {
    let playUrl = params.playId;
    let vodName = "";
    let episodeName = "";
    let playMeta = {};

    try {
        if (playUrl && playUrl.includes("|||")) {
            const [mainPlayId, metaB64] = playUrl.split("|||");
            playUrl = mainPlayId;
            playMeta = decodeMeta(metaB64 || "");
            vodName = playMeta.v || "";
            episodeName = playMeta.e || "";
        }
        logInfo('处理播放URL', { playUrl });
        // 【v1.2.1】原先不校验 playId：为空时 finalUrl = HOST + '/'，
        // 每一集都会白白打一次签名请求到站点首页，失败后再触发一次无意义嗅探。
        if (!playUrl) {
            logWarn('playId 为空，直接返回空结果');
            return { urls: [], parse: 1, header: {} };
        }
        let finalUrl = playUrl;
        if (!playUrl.startsWith('http')) {
            if (playUrl.startsWith('/')) {
                finalUrl = HOST + playUrl;
            } else {
                finalUrl = HOST + '/' + playUrl;
            }
        }
        const signedUrl = generateSignature(finalUrl);
        logInfo('签名后的播放URL', { signedUrl });

        const response = await axiosInstance.get(signedUrl, { headers: DEFAULT_HEADERS });
        const data = response.data;
        if (!data || !data.HId) {
            logInfo('未找到播放地址，回退 parse=1');
            // 【v1.2.1】原先回退 url 用的是解密前的原始串（不是 URL），客户端拿它解析必然失败，
            // 用户只看到空白。改成站点播放页地址，至少能被支持网页解析的客户端接手。
            return {
                urls: [{ name: "回退", url: finalUrl }],
                parse: 1,
                header: {
                    "User-Agent": UA,
                    "Referer": REFERER_HOST + "/",
                    "Origin": REFERER_HOST
                }
            };
        }

        const videoUrl = decodeDubokuData(data.HId);
        if (!videoUrl) {
            logInfo('视频地址解码失败，回退 parse=1');
            return {
                urls: [{ name: "回退", url: finalUrl }],
                parse: 1,
                header: {
                    "User-Agent": UA,
                    "Referer": REFERER_HOST + "/",
                    "Origin": REFERER_HOST
                }
            };
        }

        logInfo('解码后的视频地址', { videoUrl });
        let playResponse = {
            urls: [{ name: "播放", url: videoUrl }],
            parse: isDirectVideoUrl(videoUrl) ? 0 : 1,
            header: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                "Accept-Encoding": "gzip, deflate",
                "origin": REFERER_HOST,
                "referer": REFERER_HOST + "/",
                "priority": "u=1, i"
            }
        };

        if (playResponse.parse === 1 && playResponse.urls[0]?.url) {
            const sniffResult = await sniffDubokuPlay(playResponse.urls[0].url);
            if (sniffResult) {
                playResponse = sniffResult;
            }
        }

        if (DANMU_API && (vodName || params.vodName)) {
            let scrapedDanmuFileName = "";
            try {
                const videoIdFromParam = params.vodId ? String(params.vodId) : "";
                const videoIdFromMeta = playMeta?.sid ? String(playMeta.sid) : "";
                const videoIdForScrape = videoIdFromParam || videoIdFromMeta;
                if (videoIdForScrape) {
                    const metadata = await OmniBox.getScrapeMetadata(videoIdForScrape);
                    if (metadata && metadata.scrapeData) {
                        const mapping = (metadata.videoMappings || []).find((m) => m?.fileId === playMeta?.fid);
                        scrapedDanmuFileName = buildScrapedDanmuFileName(
                            metadata.scrapeData,
                            metadata.scrapeType || "",
                            mapping,
                            vodName || params.vodName,
                            episodeName || params.episodeName
                        );
                    }
                }
            } catch (error) {
                logInfo(`读取刮削元数据失败: ${error.message || error}`);
            }

            const finalVodName = vodName || params.vodName;
            const finalEpisodeName = episodeName || params.episodeName || '';
            const fileName = scrapedDanmuFileName || buildFileNameForDanmu(finalVodName, finalEpisodeName);
            if (fileName) {
                const danmakuList = await matchDanmu(fileName);
                if (danmakuList && danmakuList.length > 0) {
                    playResponse.danmaku = danmakuList;
                }
            }
        }

        return playResponse;
    } catch (error) {
        logError("播放解析失败", error);
        const fallbackSniff = await sniffDubokuPlay(playUrl);
        if (fallbackSniff) {
            return fallbackSniff;
        }
        // 【v1.2.1】同上文：回退 url 必须是可解析的地址，不是解密前的原始串
        const fallbackUrl = playUrl && /^https?:\/\//i.test(playUrl) ? playUrl : `${HOST}/`;
        return {
            urls: [{ name: "回退", url: fallbackUrl }],
            parse: 1,
            header: {
                "User-Agent": UA,
                "Referer": REFERER_HOST + "/",
                "Origin": REFERER_HOST
            }
        };
    }
}

module.exports = { home, category, search, detail, play };
const runner = require("spider_runner");
runner.run(module.exports);
