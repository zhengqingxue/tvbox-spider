// @name 影猫仓库
// @author 
// @description 刮削：支持，弹幕：支持，嗅探：支持，并发：安全
// @description 03 + 开心 + 真狼 + 聚合源上钻 + 上游精确检索 (并发解析)
// @description 多线路：同一集在各条线路上的直链一次全列（当前线路优先）
// @description 搜索提纯：按片名相关度过滤+重排，剔除只共享关键词片段的无关条目
// @description 多线路修复：vod_id 含下划线（search_ / up_）时不再错位，搜索入口也生效 (v1.3.3)
// @description 死通道短路：03yy(530)/playr.top(000) 失效通道落盘拉黑 15 分钟，省去每次 4~5s 空等 (v1.3.5)
// @dependencies: axios, crypto, cheerio, http, https
// @version 1.3.6
// @downloadURL https://gh-proxy.org/https://github.com/xiaohu1949/OmniBox-Spider/raw/refs/heads/main/影视/采集/影猫仓库.js

const axios = require("axios");
const cheerio = require("cheerio");
const OmniBox = require("omnibox_sdk");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

// ==================== 全局配置 ====================
const HOST = "https://www.ymck.pro";
const PAGE_LIMIT = 20;
const DANMU_API = process.env.DANMU_API || "";

// 聚合搜索只有片名、没有海报，统一用站点占位图（原先这个长 URL 在 search / detail 里各硬编码了一份）
const SEARCH_PLACEHOLDER_PIC =
  `${HOST}/upload/site/20230825-1/5c00fbcfb4ff0737d3c8320d30b2d1de.png`;

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
  "Referer": `${HOST}/`,
};

// ==================== 上游精确检索源（v1.3.0 新增） ====================
// 影猫自己的聚合索引 `API/v2.php?q=片名` 是**子串关键词索引**，不是标题检索：
// 实测搜「大夏守墓人」返回 51 条「大夏*」的相似片（大夏第一憨王 / 大夏双骄 / …），
// 一条都不是《大夏守墓人》——站点自己收录了这部片（movie/123570.html），
// 但索引命中不了，于是 detail 只能把 50 条错配片当「备用源」列出来，
// 用户点哪条都播不了（play 里因片名校验全部拒绝 → 16~18s 后才失败）。
//
// 但这些上游站本身就是 MacCMS，`ac=videolist&wd=片名` 是**精确标题检索**，
// 一次请求就能连 vod_play_url（含全部线路 + 集数 + 真实 m3u8）一起拿到。
// 所以：聚合索引查不到时，改走上游精确检索，把「影猫索引盲区」补上。
const EXACT_UPSTREAMS = [
  { origin: "https://feikuai.in",          name: "飞快TV",     api: "/api.php/provide/vod" },
  { origin: "https://iqiyizy.cc",          name: "爱奇艺资源", api: "/api.php/provide/vod" },
  { origin: "https://cj.rytvapi.com",      name: "如意资源",   api: "/api.php/provide/vod" },
  { origin: "https://caiji.dyttzyapi.com", name: "电影天堂",   api: "/api.php/provide/vod" },
];
const MAX_EXACT_HOSTS = 4;

// ==================== 搜索结果提纯（v1.3.2 新增） ====================
// 影猫的聚合索引是「任意位置含关键词」的模糊索引，不是标题检索：
// 搜「大夏守墓人」→ 51 条，一大半是「大夏剑主动态漫画 / 大夏第一憨王 / 大夏双骄…」
//   这类只共享「大夏」二字、和目标毫无关系的条目；
// 搜「庆余年」→ 还会混进「万千星辉贺台庆」「人间逍遥西门庆」「庆余生」。
// 默认开启提纯：按片名相关度过滤 + 重排（精确匹配与最接近的名字浮到最前）。
// 把 YMCK_SEARCH_STRICT 设为 "false" 可关掉，恢复成原样的原始列表。
const SEARCH_STRICT = String(process.env.YMCK_SEARCH_STRICT || "true").toLowerCase() !== "false";

// 判断一个地址是不是**媒体流直链**（可 parse:0 直接交给播放器）
const MEDIA_URL_RE = /\.(m3u8|mp4|flv|ts|mkv)(\?|#|$)/i;

const axiosInstance = axios.create({ 
    timeout: 15000,
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false })
});

// ==================== 日志工具 ====================
const logInfo = (message, data = null) => {
  OmniBox.log("info", `[影猫] ${message}${data ? ': ' + JSON.stringify(data) : ''}`);
};
const logWarn = (message, error = null) => {
  OmniBox.log("warn", `[影猫] ⚠️ ${message}${error ? ': ' + (error.message || error) : ''}`);
};
const logError = (message, error) => {
  OmniBox.log("error", `[影猫] ❌ ${message}: ${error?.message || error}`);
};

// ==================== 死通道短期拉黑（v1.3.5 新增） ====================
// 两个上游通道实测已失效，每次调用都白等 4~5s：
//   - www.03yy.live  → HTTP 530（源站不可用，只回 /_guard/auto.js 守卫页）
//   - super.playr.top → HTTP 000（不可达）
// 失败即落盘拉黑 15 分钟（客户端每次调用都是新进程，进程内变量毫无意义），
// 到期自动解除重试 —— 站点恢复了能自己回来。
// ⚠️ 只对「网络层失败」拉黑；解析失败（页面结构变化）不拉黑，避免误杀活着的站点。
const DEAD_CHANNEL_TTL_SECONDS = 15 * 60;
const deadChannelKey = (name) => `ymck:deadch:v1:${name}`;

async function isChannelDead(name) {
  try {
    const v = await OmniBox.getCache(deadChannelKey(name));
    return !!v;
  } catch {
    return false;
  }
}

async function markChannelDead(name, reason) {
  try {
    await OmniBox.setCache(deadChannelKey(name), String(reason || "dead"), DEAD_CHANNEL_TTL_SECONDS);
    logWarn(`通道 ${name} 网络层失败，短期拉黑 ${DEAD_CHANNEL_TTL_SECONDS / 60} 分钟`, reason);
  } catch {
    /* 拉黑失败不影响主流程 */
  }
}

// 判断异常是否属于「网络层失败 / 源站不可用」（值得拉黑），而不是解析失败
function isChannelNetworkFailure(err) {
  const msg = String((err && (err.message || err.code)) || "");
  return (
    !!(err && err.code) || // axios: ECONNABORTED / ETIMEDOUT / ENOTFOUND / ECONNREFUSED ...
    /timeout|timedout|socket hang up|ECONN|ENOTFOUND|EAI_AGAIN|Network Error|status code 5\d\d/i.test(msg)
  );
}

// ==================== 辅助工具函数 ====================
function d64(text) {
  try { return Buffer.from(String(text || ""), "base64").toString("utf8"); } catch { return ""; }
}

const encodeMeta = (obj) => {
  try { return Buffer.from(JSON.stringify(obj || {}), "utf8").toString("base64"); } catch { return ""; }
};
const decodeMeta = (str) => {
  try { return JSON.parse(Buffer.from(str || "", "base64").toString("utf8")); } catch { return {}; }
};

function safeDecode(str) {
  try { return decodeURIComponent(str); } catch (e) { return unescape(str); }
}

// ==================== 多线路解析（v1.3.1 新增） ====================
// 影猫的 vod_play_sources 里，同一部片常有 6~10 条线路
// （飞快TV · wsym3u8 / 如意资源 · rym3u8 / 电影天堂 · dyttm3u8 …），
// 且每条线路的 playId 本身就是 CDN 真实直链（用不到嗅探）。
// 但 play() 过去只把「用户点中的那一条」返回 —— 该条 CDN 挂掉这一集就放不了。
// 实测同一集多条线路分属不同 CDN，互为备份。
// 于是：detail 阶段把「集序号 → 各线路直链」落盘，play 阶段一次把全部线路都列出来。
// 注意客户端每次调用都是新进程，状态必须落盘（OmniBox.setCache），进程内变量毫无意义。
//
// 【v1.3.3 修复】影猫的 vod_id 有两类自带下划线：搜索入口 `search_<片名>`、上游入口 `up_<片名>`。
// 而 fid 是 `${id}_${sIdx}_${eIdx}`，直接 split("_") 会错位：
//   写：fidParts[2] 本意取「集序号(eIdx)」，实际拿到「线路号(sIdx)」⇒ 同一线路 46 集堆进同一个 key；
//   读：fidParts[0] 本意取 videoId，实际拿到 "search" ⇒ 查不到缓存 ⇒ 静默回退单条。
// 结果：搜索出来的片子，多线路解析 100% 未生效（只有采集 API 直出的纯数字 id 正常）。
// 修法：一律「从尾部解析」（集序号 = 末段，videoId = 去掉末两段后重新拼回），
// 对纯数字 id 的结果与旧逻辑完全一致（零回归）。
//
// ⚠️ 前缀必须同步升级为 v2：旧缓存里 map 的 key 是「线路号」，与修正后使用的「集序号」
// 数值区间重叠，沿用旧前缀会把「线路 N 的全集」误当成「第 N 集的各线路」，导致点第 1 集播错集。
// 【v1.3.4 修复】两处同类问题：
//   (a) 分隔符 `_` 会与 videoId 自带的下划线冲突 —— `encodeURIComponent` **不转义下划线**，
//       所以《庆余年_第一季》这种片名，search_xxx 里的 `_` 会让「从尾部切两段」仍然切错。
//       换用 `§`（encodeURIComponent 会转义成 %C2%A7，且片名里几乎不出现）作分隔符。
//   (b) 集键用的是**线路内下标 eIdx**。各线路集数/顺序并不保证一致（一条 46 集、另一条 24 集，
//       或中间缺一集），按下标对齐会把「第 5 集的线路A 直链」和「第 5 集的线路B 直链」错配成
//       不同集 —— 用户点第 5 集拿到的是另一条线路的第 6 集。
//       改用 extractEpisode(ep.name) 抽出的**真实集号**做键；抽不出集号的条目退回下标并加 `i` 前缀，
//       与真实集号区分开，避免「第 3 集」和「第 4 行」混进同一个桶。
//
// ⚠️ 前缀必须同步升级为 v3：v2 的 map 用「线路内下标」做键，与 v3 的「集号」数值区间重叠，
// 沿用旧前缀会把「第 3 行」当成「第 3 集」，直接播错集。
const MULTI_LINE_CACHE_PREFIX = "ymck:multi:v3";
const MULTI_LINE_TTL_SECONDS = 6 * 3600;

/** fid 分隔符：§ 会被 encodeURIComponent 转义，片名里几乎不出现，比 `_` 安全 */
const FID_SEP = "§";

/** 构造多线路用的 fid：`${videoId}${SEP}${sIdx}${SEP}${epKey}` */
function buildFid(videoId, sIdx, epKey) {
  return `${String(videoId == null ? "" : videoId)}${FID_SEP}${sIdx}${FID_SEP}${epKey}`;
}

/**
 * 从 episode 名里抽真实集号作为多线路对齐键；抽不出则回退「线路内下标」并加 `i` 前缀。
 * 加前缀是为了与真实集号区分：`i3`（第 4 行，无集号）与 `3`（第 3 集）不是同一集。
 */
function resolveEpKey(ep, eIdx) {
  const epNum = extractEpisode(ep?.name || "");
  const n = parseInt(epNum, 10);
  if (Number.isInteger(n) && n > 0) return String(n);
  return `i${eIdx}`;
}

/** 从fid 解析：videoId 可能自带分隔符，只能从尾部切 */
function parseFid(fid) {
  const parts = String(fid || "").split(FID_SEP);
  if (parts.length < 3) return null;
  return {
    videoId: parts.slice(0, -2).join(FID_SEP),
    sIdx: parts[parts.length - 2],
    epKey: parts[parts.length - 1],
  };
}

function buildMultiLineCacheKey(videoId) {
  return `${MULTI_LINE_CACHE_PREFIX}:${String(videoId || "")}`;
}

/** 从 detail 的 playSources 抽「集序号 → 各线路直链」；只收真直链，页面地址仍交给各自的解析器 */
function buildMultiLineMap(playSources) {
  const map = {};
  for (const source of playSources || []) {
    const lineName = String(source?.name || "线路");
    for (const ep of source?.episodes || []) {
      const raw = String(ep?.playId || "").split("|||")[0];
      if (!/^https?:\/\//i.test(raw) || !MEDIA_URL_RE.test(raw)) continue;
      const fid = parseFid(ep?._fid);
      if (!fid) continue;
      const epKey = fid.epKey;
      if (!map[epKey]) map[epKey] = [];
      map[epKey].push({ l: lineName, u: raw });
    }
  }
  // 同一集的去重按 **地址** 来（不同线路名可能指向同一个 CDN 地址，实测「飞快TV · rym3u8」
  // 与「如意资源 · rym3u8」就是同一条），只保留首次出现的线路名。
  for (const key of Object.keys(map)) {
    const seenUrl = new Set();
    map[key] = map[key].filter((it) => {
      if (seenUrl.has(it.u)) return false;
      seenUrl.add(it.u);
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
    logInfo("多线路清单已落盘", { videoId, 覆盖集数: epKeys.length, 首集线路数: map[epKeys[0]].length });
  } catch (e) {
    logWarn("多线路清单落盘失败", e);
  }
}

async function loadMultiLineMap(videoId) {
  try {
    const raw = await OmniBox.getCache(buildMultiLineCacheKey(videoId));
    if (!raw) return null;
    const map = typeof raw === "string" ? JSON.parse(raw) : raw;
    return map && typeof map === "object" ? map : null;
  } catch (e) {
    return null;
  }
}

/**
 * 命中多线路清单时把该集在所有线路上的直链一次返回（当前线路排第一）。
 * 返回 null 表示用不上清单（没有缓存 / 只有一条 / 不是直链），调用方走原逻辑。
 */
async function resolveMultiLinePlay(rawPlayId, playMeta) {
  const fid = parseFid(playMeta?.fid);
  if (!fid) return null;
  const map = await loadMultiLineMap(fid.videoId);
  const list = map?.[fid.epKey];
  if (!Array.isArray(list) || list.length <= 1) return null;

  const current = list.find((it) => it.u === rawPlayId);
  const ordered = current ? [current, ...list.filter((it) => it !== current)] : list;

  return {
    urls: ordered.map((it) => ({ name: it.l, url: it.u })),
    parse: 0,
    // 这些 CDN 直链实测裸请求即 200，不依赖 Referer；随手带站内 Referer 反而可能被判跨域
    header: { "User-Agent": DEFAULT_HEADERS["User-Agent"] },
  };
}

function toAbsUrl(url, base = HOST) {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return "https:" + url;
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

async function fetchWithCookieRedirect(url, customHeaders = {}, timeoutMs = 4000) {
  let headers = { "User-Agent": DEFAULT_HEADERS["User-Agent"], ...customHeaders };
  
  let res = await axiosInstance.get(url, {
    headers: headers,
    timeout: timeoutMs,
    maxRedirects: 0,
    validateStatus: status => status >= 200 && status < 400
  });

  if (res.status === 301 || res.status === 302) {
    const cookies = res.headers['set-cookie'];
    const location = res.headers['location'];
    
    let baseUrl = url;
    try { baseUrl = new URL(url).origin; } catch (e) {}
    const nextUrl = location ? toAbsUrl(location, baseUrl) : url;
    
    if (cookies) {
      headers["Cookie"] = cookies.map(c => c.split(';')[0]).join('; ');
    }
    res = await axiosInstance.get(nextUrl, { headers: headers, timeout: timeoutMs, maxRedirects: 0 });
  }
  return res;
}

// ==================== 刮削与弹幕辅助模块 ====================
const RE_CLEAN_1 = /4[kK]|[xX]26[45]|720[pP]|1080[pP]|2160[pP]|1280x720|1920x1080/g;
const RE_CLEAN_2 = /[hH]\.?26[45]/g;
const RE_CLEAN_3 = /BluRay|WEB-DL|HDR|REMUX/gi;
const RE_CLEAN_4 = /\.mp4|\.mkv|\.avi|\.flv/gi;
const RE_SE = /[Ss](?:\d{1,2})?[-._\s]*[Ee](\d{1,3})/i;
const RE_CN = /第\s*([零一二三四五六七八九十0-9]+)\s*[集话章节回期]/;
const RE_EP = /\b(?:EP|E)[-._\s]*(\d{1,3})\b/i;
const RE_STANDALONE = /(?:^|[\s\-\._\[\]])(\d{1,3})(?![0-9pP])/g;

function preprocessTitle(title) {
    if (!title) return "";
    return title
        .replace(RE_CLEAN_1, " ")
        .replace(RE_CLEAN_2, " ")
        .replace(RE_CLEAN_3, " ")
        .replace(RE_CLEAN_4, " ");
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
    const seMatch = processedTitle.match(RE_SE);
    if (seMatch) return seMatch[1];
    const cnMatch = processedTitle.match(RE_CN);
    if (cnMatch) return String(chineseToArabic(cnMatch[1]));
    const epMatch = processedTitle.match(RE_EP);
    if (epMatch) return epMatch[1];
    const standaloneMatches = processedTitle.match(RE_STANDALONE);
    if (standaloneMatches) {
        const candidates = standaloneMatches.map(m => m.match(/\d+/)[0]).filter(n => parseInt(n) > 0 && parseInt(n) < 300);
        if (candidates.length > 0) return candidates[0];
    }
    return "";
}

function extractSeason(title) {
    if (!title) return 1;
    const cnMatch = title.match(/第\s*([零一二三四五六七八九十0-9]+)\s*季/);
    if (cnMatch) return chineseToArabic(cnMatch[1]);
    const enMatch = title.match(/Season\s*(\d+)/i) || title.match(/S(\d+)/i);
    if (enMatch) return parseInt(enMatch[1]);
    return 1;
}

function buildFileNameForDanmu(vodName, episodeTitle, seasonNum, episodeNum) {
    if (!vodName) return "";
    if (!episodeTitle || episodeTitle === '正片' || episodeTitle === '播放') return vodName;
    
    let s = seasonNum > 0 ? seasonNum : 1;
    let e = episodeNum;

    if (e === undefined || e === null) {
        const digits = extractEpisode(episodeTitle);
        if (digits) e = parseInt(digits, 10);
    }

    if (e > 0) {
        const sStr = s < 10 ? `S0${s}` : `S${s}`;
        const eStr = e < 10 ? `E0${e}` : `E${e}`;
        return `${vodName} ${sStr}${eStr}`;
    }
    return vodName;
}

const buildScrapedEpisodeName = (scrapeData, mapping, originalName) => {
    if (!mapping || mapping.episodeNumber === 0 || (mapping.confidence && mapping.confidence < 0.5)) {
        return originalName;
    }
    if (mapping.episodeName) {
        return `${mapping.episodeNumber}.${mapping.episodeName}`;
    }
    if (scrapeData && Array.isArray(scrapeData.episodes)) {
        const hit = scrapeData.episodes.find(
            ep => ep.episodeNumber === mapping.episodeNumber && ep.seasonNumber === mapping.seasonNumber
        );
        if (hit?.name) {
            return `${hit.episodeNumber}.${hit.name}`;
        }
    }
    return originalName;
};

async function matchDanmu(fileName) {
    if (!DANMU_API || !fileName) return [];
    try {
        const matchUrl = `${DANMU_API}/api/v2/match`;
        const response = await OmniBox.request(matchUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": DEFAULT_HEADERS["User-Agent"] },
            body: JSON.stringify({ fileName: fileName }),
        });
        if (response.statusCode !== 200) return [];
        const matchData = JSON.parse(response.body);
        if (!matchData.isMatched || !matchData.matches || matchData.matches.length === 0) return [];
        
        const firstMatch = matchData.matches[0];
        const episodeId = firstMatch.episodeId;
        const danmakuName = firstMatch.animeTitle && firstMatch.episodeTitle ? `${firstMatch.animeTitle} - ${firstMatch.episodeTitle}` : (firstMatch.animeTitle || firstMatch.episodeTitle || "弹幕");
        
        if (!episodeId) return [];
        return [{ name: danmakuName, url: `${DANMU_API}/api/v2/comment/${episodeId}?format=xml` }];
    } catch (error) {
        return [];
    }
}

// ==================== 详情页并发解析策略 ====================

async function parse03yySource(url) {
  if (await isChannelDead("03yy")) {
    logInfo("[03影院] 通道处于拉黑期内，本次跳过详情解析");
    return null;
  }
  try {
    const res = await fetchWithCookieRedirect(url, { "Referer": "https://www.03yy.live/" }, 4000);
    const $$ = cheerio.load(res.data);
    const tabs = [];
    const sources = [];
    $$("#playlist li").each((_, el) => { tabs.push($$(el).text().replace(/[\uE000-\uF8FF]/g, '').trim()); });

    $$(".play-box .play_list").each((index, el) => {
      const episodes = [];
      $$(el).find("ul li a").each((_, a) => {
        episodes.push({ name: $$(a).text().trim(), playId: toAbsUrl($$(a).attr("href"), "https://www.03yy.live") });
      });
      if (episodes.length > 0) sources.push({ name: `03影院 - ${tabs[index] || '线路'+(index+1)}`, episodes });
    });

    if (sources.length === 0) throw new Error("03yy未匹配到任何剧集");
    return { type: '03yy', sources };
  } catch (e) {
    if (isChannelNetworkFailure(e)) await markChannelDead("03yy", e);
    throw e;
  }
}

// 【核心修复】增强版真狼解析器，增加 URL 去重，防止集数重复
async function parseZhenlangSource(url) {
  const res = await fetchWithCookieRedirect(url, { "Referer": "https://www.zhenlang.cc/" }, 4000);
  const $$ = cheerio.load(res.data);
  const sources = [];

  // 1. 尝试通用 MacCMS 结构抓取线路名称
  const tabs = [];
  $$(".nav-tabs li a, .stui-vodlist__head h3, .myui-panel__head h3, .module-tab-item, .play_source_tab a").each((_, el) => {
     let text = $$(el).text().replace(/[\uE000-\uF8FF]/g, '').trim();
     if (text) tabs.push(text);
  });

  // 2. 尝试通用 MacCMS 结构抓取播放列表
  const lists = $$(".stui-content__playlist, .myui-content__list, .module-play-list-content, .content_playlist, [id^='playlist']");
  lists.each((index, el) => {
    const episodes = [];
    const seenUrls = new Set(); // 【新增】用于记录已经提取过的链接，防止重复

    $$(el).find("a").each((_, a) => {
      const href = $$(a).attr("href");
      if (href && (href.includes("/play") || href.includes("/vodplay") || href.includes("vod-play"))) {
        const playId = toAbsUrl(href, "https://www.zhenlang.cc");
        
        // 【核心修复】如果这个链接还没被提取过，才加入列表
        if (!seenUrls.has(playId)) {
            seenUrls.add(playId);
            let epName = $$(a).text().trim() || "播放";
            // 清理可能存在的多余换行符
            epName = epName.replace(/\s+/g, ' '); 
            episodes.push({ name: epName, playId: playId });
        }
      }
    });
    
    if (episodes.length > 0) {
        let tabName = tabs[index] || `线路${index + 1}`;
        sources.push({ name: `真狼 - ${tabName}`, episodes });
    }
  });

  // 3. 尝试旧版结构兜底
  if (sources.length === 0) {
    $$(".play_list_box").each((index, el) => {
      let tabName = `线路${index + 1}`;
      const tipMatch = ($$(el).find(".player_infotip").text() || "").match(/当前资源由(.*?)提供/);
      if (tipMatch && tipMatch[1]) tabName = tipMatch[1].trim();

      const episodes = [];
      const seenUrls = new Set(); // 旧版结构也加上去重

      $$(el).find(".content_playlist a").each((_, a) => {
        const href = $$(a).attr("href");
        if (href) {
            const playId = toAbsUrl(href, "https://www.zhenlang.cc");
            if (!seenUrls.has(playId)) {
                seenUrls.add(playId);
                episodes.push({ name: $$(a).text().trim(), playId: playId });
            }
        }
      });
      if (episodes.length > 0) sources.push({ name: `真狼 - ${tabName}`, episodes });
    });
  }

  if (sources.length === 0) throw new Error("真狼网页结构变更，未匹配到任何剧集");
  
  return { type: 'zhenlang', sources };
}

async function parseKaixinSource(url) {
  const res = await axiosInstance.get(url, { headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"] }, timeout: 4000 });
  const $$ = cheerio.load(res.data);
  const tabs = [];
  const sources = [];
  
  $$("ul.nav-tabs li a").each((_, el) => {
    const tabName = $$(el).text().replace(/\s*\d+$/, '').trim();
    const targetId = $$(el).attr("href");
    if (tabName && targetId) tabs.push({ name: tabName, id: targetId });
  });

  tabs.forEach(tab => {
    if (!tab.id || !tab.id.startsWith('#')) return;
    try {
      const episodes = [];
      $$(tab.id).find(".btn-group a").each((_, a) => {
        episodes.push({ name: $$(a).text().trim(), playId: toAbsUrl($$(a).attr("href"), "https://www.kxyytv.com") });
      });
      if (episodes.length > 0) sources.push({ name: `开心 - ${tab.name}`, episodes });
    } catch (e) { logWarn(`[开心] 线路[${tab?.name}]解析失败: ${e.message}`); }
  });
  
  if (sources.length === 0) throw new Error("开心未匹配到任何剧集");
  return { type: 'kaixin', sources };
}

// ==================== 核心接口 ====================

// 【v1.3.6】首页短 TTL 缓存。客户端每次切源都是新进程，且本源单次首页要打
// ymck.pro/api.php/xiao/vod —— 实测该接口单次响应 5~6s，是最慢的一环。缓存后二次进入 <0.3s。
const HOME_CACHE_KEY = "ymck:home:v1";
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

async function home(params) {
  const classes = [
    { type_id: "1", type_name: "电影" },
    { type_id: "2", type_name: "电视剧" },
    { type_id: "5", type_name: "综艺" },
    { type_id: "4", type_name: "动漫" },
    { type_id: "3", type_name: "纪录片" }
  ];
  
  const filters = {
    "1": [{ key: "cateId", name: "类型", value: [{ name: "最新", value: "1" }, { name: "动作", value: "6" }, { name: "喜剧", value: "7" }, { name: "爱情", value: "8" }, { name: "科幻", value: "9" }, { name: "恐怖", value: "10" }, { name: "剧情", value: "11" }, { name: "战争", value: "12" }] }],
    "2": [{ key: "cateId", name: "类型", value: [{ name: "最新", value: "2" }, { name: "国产剧", value: "13" }, { name: "港台剧", value: "14" }, { name: "日韩剧", value: "15" }, { name: "海外剧", value: "16" }] }],
    "4": [{ key: "cateId", name: "类型", value: [{ name: "最新", value: "4" }, { name: "国产动漫", value: "24" }, { name: "日韩动漫", value: "25" }, { name: "港台动漫", value: "26" }, { name: "欧美动漫", value: "27" }] }],
    "5": [{ key: "cateId", name: "类型", value: [{ name: "最新", value: "5" }, { name: "大陆综艺", value: "17" }, { name: "港台综艺", value: "18" }, { name: "日韩综艺", value: "20" }, { name: "欧美综艺", value: "21" }] }],
    "3": [{ key: "cateClass", name: "类型", value: [{ name: "最新", value: "" }, { name: "记录", value: "记录" }, { name: "传记", value: "传记" }, { name: "历史", value: "历史" }, { name: "音乐", value: "音乐" }, { name: "运动", value: "运动" }, { name: "犯罪", value: "犯罪" }, { name: "情", value: "情" }, { name: "战争", value: "战争" }, { name: "冒险", value: "冒险" }, { name: "灾难", value: "灾难" }] }]
  };

  try {
    const cached = await readHomeCache();
    if (cached) {
      logInfo(`首页命中缓存 ${cached.list.length} 条`);
      return cached;
    }

    const url = `${HOST}/api.php/xiao/vod?page=1&limit=20`;
    const res = await axiosInstance.get(url, { 
        headers: { ...DEFAULT_HEADERS, "X-Requested-With": "XMLHttpRequest" } 
    });
    
    let list = [];
    if (res.data && res.data.list) {
        list = res.data.list.map(item => ({
            vod_id: item.vod_id.toString(),
            vod_name: item.vod_name,
            vod_pic: item.vod_pic,
            vod_remarks: parseFloat(item.vod_score) > 0 ? item.vod_score.toString() : ""
        }));
    }
    
    const result = { class: classes, filters: filters, list: list, page: 1, pagecount: res.data.pagecount || 99, limit: 20, total: res.data.total || 999 };
    await writeHomeCache(result);
    return result;
  } catch (e) { 
    logWarn(`首页获取失败: ${e.message || e}`);
    return { class: classes, filters: filters, list: [], page: 1, pagecount: 1 }; 
  }
}


async function category(params) {
  let tid = params?.categoryId || params?.id || "1";
  const pg = parseInt(params?.page, 10) || 1;
  let filterClass = "";

  if (params?.filters) {
      if (params.filters.cateId) {
          tid = params.filters.cateId;
      }
      if (params.filters.cateClass) {
          filterClass = encodeURIComponent(params.filters.cateClass);
      }
  }

  try {
    let url = `${HOST}/api.php/xiao/vod?type=${tid}&page=${pg}&limit=20`;
    if (filterClass) {
        url += `&class=${filterClass}`;
    }

    const res = await axiosInstance.get(url, { 
        headers: { 
            ...DEFAULT_HEADERS, 
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest" 
        } 
    });
    
    const data = res.data;
    let list = [];
    
    if (data && data.list) {
        list = data.list.map(item => ({
            vod_id: item.vod_id.toString(),
            vod_name: item.vod_name,
            vod_pic: item.vod_pic,
            vod_remarks: parseFloat(item.vod_score) > 0 ? item.vod_score.toString() : ""
        }));
    }

    return { 
        list: list, 
        page: parseInt(data.page || pg), 
        pagecount: parseInt(data.pagecount || 99), 
        limit: 20, 
        total: parseInt(data.total || 999) 
    };
  } catch (e) { 
    return { list: [], page: 1, pagecount: 1 }; 
  }
}

async function search(params) {
  const wd = String(params?.keyword || params?.wd || "").trim();
  const pg = parseInt(params?.page, 10) || 1;
  
  if (pg > 1) return { list: [], page: pg, pagecount: 1 };

  try {
    const apiUrl = `${HOST}/API/v2.php?q=${encodeURIComponent(wd)}&size=50`;
    const apiRes = await axiosInstance.get(apiUrl, { headers: { ...DEFAULT_HEADERS, "Accept": "*/*" } });
    
    let apiData = [];
    try {
        const parsed = JSON.parse(d64(apiRes.data));
        apiData = Array.isArray(parsed) ? parsed : (parsed.data || []);
    } catch (e) {
        logWarn("搜索API数据解析失败", e);
    }

    const groups = {};
    for (let i = 0; i < apiData.length; i++) {
        const item = apiData[i];
        if (typeof item === 'object' && item.text && item.url) {
            // 站内个别条目把两个片名用 `$` 接成一条（实测「庆余年，全世界都以为我是废物太子$庆余年之大凉太子爷」），
            // 那是采集上游时留下的脏数据，取前半段当片名即可，顺带和正常条目合并去重。
            const title = String(item.text).trim().split("$")[0].trim();
            if (title && !groups[title]) {
                groups[title] = {
                    // 片名可能含 / # 等字符，直接拼进 vod_id 会破坏传递，编码后再拼
                    vod_id: `search_${encodeURIComponent(title)}`,
                    vod_name: title,
                    vod_pic: SEARCH_PLACEHOLDER_PIC,
                    vod_remarks: "全网聚合"
                };
            }
        }
    }

    const rawList = Object.values(groups);

    // 【v1.3.2】聚合索引命中太脏（任意位置含关键词即算命中），先按片名相关度提纯+重排，
    // 只保留真正像目标片名的条目；过滤后为空则自动回退原始列表。
    const list = wd && SEARCH_STRICT ? rankSearchResults(rawList, wd) : rawList;
    if (list.length !== rawList.length) {
      logInfo(`搜索提纯: 原始 ${rawList.length} 条 → 保留 ${list.length} 条`, { wd });
    }

    // 【v1.3.0】上游精确检索补搜
    // 影猫的聚合索引是子串关键词索引，会漏掉自己已收录的片名
    // （实测站内有《大夏守墓人》movie/123570.html，但搜「大夏守墓人」0 命中）。
    // 用上游 MacCMS 的 `wd=` 精确检索补一份，让「站内搜不到的片」也能被找到。
    if (wd) {
      try {
        const hits = await searchExactUpstreams(wd, 3);
        const seen = new Set(list.map((i) => normName(i.vod_name)));
        hits.forEach((h) => {
          const v = h.vod || {};
          const title = String(v.vod_name || "").trim();
          const key = normName(title);
          if (!title || seen.has(key)) return;
          seen.add(key);
          list.unshift({
            vod_id: `up_${encodeURIComponent(title)}`,
            vod_name: title,
            vod_pic: toAbsUrl(v.vod_pic || "", h.host.origin) || SEARCH_PLACEHOLDER_PIC,
            vod_remarks: `${h.host.name} · 可播`,
          });
        });
        if (hits.length > 0) logInfo(`搜索补搜命中原站 ${hits.length} 个`);
      } catch (e) {
        logWarn(`搜索补搜异常: ${e.message}`);
      }
    }

    return { list: list, page: 1, pagecount: 1, limit: 50, total: list.length };
  } catch (e) { 
    return { list: [], page: 1, pagecount: 1 }; 
  }
}

async function detail(params) {
  const t0 = Date.now();
  const id = params?.videoId || params?.id || "";
  if (!id) return { list: [] };

  try {
    let vodName = "";
    let vodPic = "";
    let vodContent = "";
    let vodYear = "";
    let vodActor = "";
    let vodDirector = "";
    // 上游精确检索结果（`up_` 详情页会提前算好复用，避免二次请求）
    let exactHits = null;

    if (id.startsWith("search_")) {
        const rawTitle = id.replace("search_", "");
        try { vodName = decodeURIComponent(rawTitle); } catch (e) { vodName = rawTitle; }
        vodPic = SEARCH_PLACEHOLDER_PIC;
        vodContent = "全网聚合搜索结果，正在通过 TMDB 刮削获取详细信息...";
    } else if (id.startsWith("up_")) {
        // 「上游精确检索」搜出来的片 —— 影猫自己的聚合索引里没有它，
        // 所以既没有本站详情页可抓，也没有海报/简介；直接用上游 MacCMS 的元信息补。
        const rawTitle = id.slice(3);
        try { vodName = decodeURIComponent(rawTitle); } catch (e) { vodName = rawTitle; }
        vodPic = SEARCH_PLACEHOLDER_PIC;
        try {
            exactHits = await searchExactUpstreams(vodName);            if (exactHits.length > 0) {
                const h = exactHits[0];
                const v = h.vod || {};
                const pic = toAbsUrl(v.vod_pic || "", h.host.origin);
                if (pic) vodPic = pic;
                vodContent = String(v.vod_content || v.vod_blurb || "")
                    .replace(/<[^>]+>/g, " ")
                    .replace(/&nbsp;/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();
                vodYear = String(v.vod_year || "").slice(0, 4);
                if (vodYear === "1970") vodYear = "";
                vodActor = String(v.vod_actor || "").trim();
                vodDirector = String(v.vod_director || "").trim();
            }
        } catch (e) {
            logWarn(`[上游] up_ 详情预取失败: ${e.message}`);
        }
    } else {
        let targetUrl = id;
        if (/^\d+$/.test(id)) {
            targetUrl = `${HOST}/movie/${id}.html`;
        } else if (!id.startsWith("http")) {
            targetUrl = toAbsUrl(id);
        }

        const res = await axiosInstance.get(targetUrl, { headers: DEFAULT_HEADERS });
        const $ = cheerio.load(res.data);

        vodName = $(".movie-title").first().text().trim().replace(/影片信息$/, "").trim();
        if (!vodName) return { list: [] };
        
        vodPic = toAbsUrl($(".poster img").attr("src"));
        vodContent = $(".summary.detailsTxt").last().text().replace("简介：", "").trim();
    }

    let playSources = [];
    let parsedFlags = { '03yy': false, 'zhenlang': false, 'kaixin': false };

    // 【v1.3.0】上游精确检索与聚合 API **并行**跑：
    // 影猫的聚合接口偶发 522 / 十几秒无响应，串行会让「精确检索补位」白等一倍时间。
    // 并行后总等待 = max(聚合, 精确检索) 而不是两者之和；专用解析器命中时这份结果直接丢弃。
    let exactPromise = null;
    if (!exactHits) {
      exactPromise = searchExactUpstreams(vodName).catch((e) => {
        logWarn(`上游精确检索异常: ${e.message}`);
        return [];
      });
    }

    const tApi = Date.now();
    const apiUrl = `${HOST}/API/v2.php?q=${encodeURIComponent(vodName)}&size=50`;
    try {
      const apiRes = await axiosInstance.get(apiUrl, { headers: { ...DEFAULT_HEADERS, "Accept": "*/*" }, timeout: 10000 });
      
      let apiData = [];
      try {
          const parsed = JSON.parse(d64(apiRes.data));
          apiData = Array.isArray(parsed) ? parsed : (parsed.data || []);
      } catch (e) {
          logWarn("聚合API数据解析失败", e);
      }

      const target03yy = apiData.find(item => item && item.url && item.url.includes("03yy.live"));
      const targetZhenlang = apiData.find(item => item && item.url && item.url.includes("zhenlang.cc"));
      const targetKaixin = apiData.find(item => item && item.url && item.url.includes("kxyytv.com"));

      const tSource = Date.now();
      const tasks = [];

      const wrapTask = async (name, taskPromise) => {
          const tStart = Date.now();
          try {
              const res = await taskPromise;
              return { name, status: '成功', time: Date.now() - tStart, data: res };
          } catch (e) {
              return { name, status: '失败', time: Date.now() - tStart };
          }
      };

      if (target03yy) tasks.push(wrapTask('03影院', parse03yySource(target03yy.url)));
      if (targetZhenlang) tasks.push(wrapTask('真狼', parseZhenlangSource(targetZhenlang.url)));
      if (targetKaixin) tasks.push(wrapTask('开心', parseKaixinSource(targetKaixin.url)));

      if (tasks.length > 0) {
        const results = await Promise.all(tasks);
        
        let logDetails = [];
        results.forEach(r => {
            // 【核心修复】必须确保 sources 里面真的有数据，才算真正成功
            if (r.status === '成功' && r.data && r.data.sources && r.data.sources.length > 0) {
                logDetails.push(`${r.name}:成功(${r.time}ms)`);
                playSources.push(...r.data.sources);
                parsedFlags[r.data.type] = true;
            } else {
                logDetails.push(`${r.name}:无数据/失败(${r.time}ms)`);
            }
        });
        logInfo(`源站解析完成, 耗时: ${Date.now() - tSource}ms, 详情: [ ${logDetails.join(' | ')} ]`);
      }

      // 【v1.3.0 修复】备用源必须过片名校验
      // 聚合 API 的 `q=` 是子串关键词索引，搜「大夏守墓人」会回 51 条「大夏*」相似片，
      // 一条都不是本片。旧版把这些错配片全塞进「全网聚合备用源」，
      // 用户点哪条都播不了（play 里被片名校验拒绝 → 空等 16~18s）。
      // 【v1.3.2】判据换成 searchRelevance：要求「名字被完整包含」，
      // 旧版 isNameLike 允许「前 2 字相同」，所以「大夏无双/大夏拳王」这类照样混进来。
      const fallbackEpisodes = [];
      let rejected = 0;
      for (let i = 0; i < apiData.length; i++) {
        const item = apiData[i];
        if (item && item.website && item.url) {
          if (parsedFlags['03yy'] && item.url.includes("03yy.live")) continue;
          if (parsedFlags['zhenlang'] && item.url.includes("zhenlang.cc")) continue;
          if (parsedFlags['kaixin'] && item.url.includes("kxyytv.com")) continue;
          if (item.text && searchRelevance(item.text, vodName) <= 0) { rejected++; continue; }
          fallbackEpisodes.push({ name: `${item.website}`, playId: item.url });
        }
      }
      if (rejected > 0) logWarn(`聚合备用源片名不符已丢弃 ${rejected} 条（索引是子串匹配，非标题匹配）`);

      // 【v1.3.0 修复】聚合索引命中不了本片时，改走上游 MacCMS 精确标题检索。
      // 这是本次「大夏守墓人播不了」的根因修复：影猫自己收录了这部片，但索引搜不到，
      // 而飞快TV/爱奇艺/如意/电影天堂 用 `wd=片名` 都能精确搜到并直出 m3u8。
      if (playSources.length === 0) {
        const tExact = Date.now();
        try {
          if (!exactHits) exactHits = (await exactPromise) || [];
          const exactSources = exactHitsToSources(exactHits);
          if (exactSources.length > 0) {
            playSources.push(...exactSources);
            logInfo(`上游精确检索命中 ${exactHits.length} 站 / ${exactSources.length} 条线路, 等待: ${Date.now() - tExact}ms, 站点: [ ${exactHits.map(h => h.host.name).join(' | ')} ]`);
          } else {
            logWarn(`上游精确检索未命中（${EXACT_UPSTREAMS.length} 站均无《${vodName}》）`);
          }
        } catch (e) {
          logWarn(`上游精确检索异常: ${e.message}`);
        }
      }

      // 聚合兜底：片名校验通过、但没被上游精确检索覆盖的第三方站，仍保留为「备用源」。
      // 精确检索命中时它会排在后面（前面的才是直出 m3u8 的可靠线路）。
      if (fallbackEpisodes.length > 0) {
        const covered = new Set((exactHits || []).map((h) => h.host.origin));
        const rest = fallbackEpisodes.filter((e) => {
          try { return !covered.has(new URL(e.playId).origin); } catch (err) { return true; }
        });
        if (rest.length > 0) playSources.push({ name: "全网聚合备用源", episodes: rest });
      }

    } catch (e) {
      logWarn("聚合API请求失败", e);
      // 聚合 API 本身挂了（实测偶发 522）时，上游精确检索仍是可用兜底
      if (playSources.length === 0) {
        try {
          if (!exactHits) exactHits = (exactPromise ? await exactPromise : await searchExactUpstreams(vodName)) || [];
          playSources.push(...exactHitsToSources(exactHits));
          if (playSources.length > 0) logInfo(`聚合API失败，已由上游精确检索兜底 ${playSources.length} 条线路`);
        } catch (e2) { logWarn(`聚合API与上游兜底均失败: ${e2.message}`); }
      }
    }

    // ================= 2. 刮削处理 =================
    const tScrape = Date.now();
    let scrapeData = null;
    let videoMappings = [];
    const scrapeCandidates = [];

    const currentSeason = extractSeason(vodName);
    const sStr = currentSeason < 10 ? `S0${currentSeason}` : `S${currentSeason}`;

    playSources.forEach((source, sIdx) => {
        source.episodes.forEach((ep, eIdx) => {
            //【v1.3.4】集键用真实集号，不用线路内下标 —— 各线路集数不一致时按下标对齐会播错集。
            // fid 是刮削用的 file_id，也是多线路清单的键来源，这里定错下面全错。
            const epKey = resolveEpKey(ep, eIdx);
            const fid = buildFid(id, sIdx, epKey);
            ep._fid = fid;
            ep._epKey = epKey;
            
            const epNumStr = extractEpisode(ep.name);
            let fileNameForScrape = `${vodName} ${ep.name}`; 
            
            if (epNumStr) {
                const epNum = parseInt(epNumStr, 10);
                const eStr = epNum < 10 ? `E0${epNum}` : `E${epNum}`;
                fileNameForScrape = `${vodName} ${sStr}${eStr}`;
            }

            scrapeCandidates.push({
                fid: fid, 
                file_id: fid, 
                file_name: fileNameForScrape, 
                name: ep.name, 
                format_type: "video"
            });
        });
    });

    if (scrapeCandidates.length > 0) {
        try {
            await OmniBox.processScraping(id, vodName, vodName, scrapeCandidates);
            const metadata = await OmniBox.getScrapeMetadata(id);
            scrapeData = metadata?.scrapeData || null;
            videoMappings = metadata?.videoMappings || [];
            
            if (scrapeData) {
                vodName = scrapeData.title || vodName;
                if (scrapeData.posterPath) vodPic = `https://image.tmdb.org/t/p/w500${scrapeData.posterPath}`;
                if (scrapeData.overview) vodContent = scrapeData.overview;
                if (scrapeData.releaseDate) vodYear = String(scrapeData.releaseDate).substring(0, 4);
                const actors = (scrapeData.credits?.cast || []).slice(0, 5).map(c => c?.name).filter(Boolean).join(",");
                if (actors) vodActor = actors;
                const directors = (scrapeData.credits?.crew || []).filter(c => c?.job === "Director").slice(0, 3).map(c => c?.name).filter(Boolean).join(",");
                if (directors) vodDirector = directors;
            }

            playSources.forEach(source => {
                source.episodes.forEach(ep => {
                    let meta = { fid: ep._fid, v: vodName, e: ep.name };
                    const mapping = videoMappings.find(m => m?.fileId === ep._fid);
                    
                    if (mapping) {
                        const newName = buildScrapedEpisodeName(scrapeData, mapping, ep.name);
                        if (newName && newName !== ep.name) ep.name = newName;
                        meta.s = mapping.seasonNumber;
                        meta.n = mapping.episodeNumber;
                        meta.e = ep.name;
                        
                        ep._s = mapping.seasonNumber;
                        ep._n = mapping.episodeNumber;
                    }
                    ep.playId = `${ep.playId}|||${encodeMeta(meta)}`;
                });

                const hasEpisodeNumber = source.episodes.some(ep => ep._n !== undefined);
                // 【v1.3.4】集键已改用真实集号，排序不再影响 _fid 的语义（epKey 跟着 ep 走）。
                // 但若该线路有条目抽不出集号（_epKey 是 `i<下标>` 形式），重排会让下标与展示行脱节，
                // 这类线路干脆不排序，保持站点原序。
                const hasIndexKey = source.episodes.some(ep => String(ep._epKey || "").charAt(0) === "i");
                
                if (hasEpisodeNumber && !hasIndexKey) {
                    source.episodes.sort((a, b) => {
                        const seasonA = a._s || 0;
                        const seasonB = b._s || 0;
                        if (seasonA !== seasonB) return seasonA - seasonB;
                        const episodeA = a._n || 0;
                        const episodeB = b._n || 0;
                        return episodeA - episodeB;
                    });
                }
            });
        } catch (e) { logWarn(`[详情] 刮削元数据处理失败: ${e.message}`); }
    }

    logInfo(`详情页加载完成, 影片: ${vodName}, 刮削耗时: ${Date.now() - tScrape}ms, 总耗时: ${Date.now() - t0}ms`);

    // 把「同一集在各条线路上的直链」落盘，供 play() 一次把全部线路都返回
    await saveMultiLineMap(id, playSources);

    return { 
        list: [{ 
            vod_id: id, vod_name: vodName, vod_pic: vodPic, vod_content: vodContent, 
            vod_year: vodYear, vod_actor: vodActor, vod_director: vodDirector,
            vod_play_sources: playSources 
        }] 
    };
  } catch (e) { 
    return { list: [] }; 
  }
}

// ==================== 播放页策略模式解析器 ====================

async function play03yy(url, baseResult) {
  if (await isChannelDead("03yy")) {
    logInfo("[03影院] 通道处于拉黑期内，跳过播放解析");
    return null;
  }
  try {
    logInfo(`[03影院] 开始解析播放页: ${url}`);
    const res = await fetchWithCookieRedirect(url, { "Referer": "https://www.03yy.live/" }, 5000);
    const html = res.data;

    const nowMatch = html.match(/var now=base64decode\("([^"]+)"\)/);
    const pnMatch = html.match(/var pn="([^"]+)"/);

    if (nowMatch && nowMatch[1]) {
      const nowStr = d64(nowMatch[1]);
      const pn = pnMatch ? pnMatch[1] : "未知";
      
      logInfo(`[03影院] 提取参数成功 -> pn: ${pn}, now: ${nowStr}`);

      if (pn === "btiyikk" || pn === "03yyhd") {
        logInfo(`[03影院] 匹配为【高速线路】(${pn}), 准备请求 btiyikk 接口...`);
        const apiUrl = `https://www.03yy.live/api/btiyikk.php?url=${encodeURIComponent(nowStr)}&ref=${encodeURIComponent(url)}`;
        const apiRes = await fetchWithCookieRedirect(apiUrl, { "Referer": url }, 5000);
        const videoMatch = apiRes.data.match(/const videoUrl\s*=\s*"([^"]+)"/);
        
        if (videoMatch && videoMatch[1]) {
          const finalUrl = videoMatch[1].replace(/\\\//g, '/');
          logInfo(`[03影院] 高速线路解析成功: ${finalUrl}`);
          baseResult.urls = [{ name: "03高速直链", url: finalUrl }];
          return baseResult;
        }
      } 
            else if (pn === "qq") {
        logInfo(`[03影院] 匹配为【高清备用】(${pn}), 准备请求 playlink 接口...`);
        const apiUrl = `https://www.03yy.live/api/playlink.php?url=${encodeURIComponent(nowStr)}`;
        const apiRes = await fetchWithCookieRedirect(apiUrl, { "Referer": url }, 5000);
        const videoMatch = apiRes.data.match(/const videoUrl\s*=\s*"([^"]+)"/);
        
        if (videoMatch && videoMatch[1]) {
          const finalUrl = videoMatch[1].replace(/\\\//g, '/');
          logInfo(`[03影院] 高清备用解析成功: ${finalUrl}`);
          baseResult.urls = [{ name: "03高清备用", url: finalUrl }];
          baseResult.header = { "Referer": "https://www.03yy.live/", "User-Agent": DEFAULT_HEADERS["User-Agent"] };
          return baseResult;
        }
      }
      else if (pn === "1080zyk") {
        logInfo(`[03影院] 匹配为【普通线路】(${pn}), 准备请求 e1080 接口...`);
        const apiUrl = `https://www.03yy.live/api/e1080.php?url=${encodeURIComponent(nowStr)}`;
        const apiRes = await fetchWithCookieRedirect(apiUrl, { "Referer": url }, 5000);
        const videoMatch = apiRes.data.match(/var videoUrl\s*=\s*"([^"]+)"/);
        
        if (videoMatch && videoMatch[1]) {
          const finalUrl = videoMatch[1].replace(/\\\//g, '/');
          logInfo(`[03影院] 普通线路解析成功: ${finalUrl}`);
          baseResult.urls = [{ name: "03普线直链", url: finalUrl }];
          baseResult.header = { "Referer": "https://www.03yy.live/", "User-Agent": DEFAULT_HEADERS["User-Agent"] };
          return baseResult;
        }
      } 
      else {
        logInfo(`[03影院] 未知的线路标识 pn: ${pn}，尝试原生直链兜底`);
      }

      if (nowStr.includes(".m3u8") || nowStr.includes(".mp4")) {
        logInfo(`[03影院] 触发原生直链兜底成功: ${nowStr}`);
        baseResult.urls = [{ name: "03原生直链", url: nowStr }];
        return baseResult;
      }
    } else {
      logWarn(`[03影院] 网页源码中未找到 now 变量，可能网页结构已改变`);
    }
  } catch (e) {
    if (isChannelNetworkFailure(e)) await markChannelDead("03yy", e);
    logWarn(`[03影院] 播放解析发生代码异常: ${e.message}`);
  }
  
  logInfo(`[03影院] 所有直链尝试均失败，交由外层嗅探器处理`);
  return null; 
}

async function playKaixin(url, baseResult) {
  try {
    const res = await axiosInstance.get(url, { headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"] }, timeout: 5000 });
    const playerMatch = res.data.match(/var player_data\s*=\s*(\{[\s\S]+?\})\s*;?\s*</);
    if (playerMatch && playerMatch[1]) {
      const playerObj = JSON.parse(playerMatch[1]);
      let targetUrl = playerObj.url;
      let encrypt = playerObj.encrypt || 0;
      if (encrypt === 1) targetUrl = safeDecode(targetUrl);
      else if (encrypt === 2) targetUrl = safeDecode(Buffer.from(targetUrl, "base64").toString("utf8"));
      if (targetUrl) {
        baseResult.urls = [{ name: "直链秒播", url: targetUrl }];
        return baseResult;
      }
      logWarn("[真狼] 未取到直链");
    }
  } catch (e) { logWarn(`[真狼] 解析失败: ${e.message}`); }
  return null;
}

async function playZhenlang(url, baseResult) {
  try {
    const res = await axiosInstance.get(url, { headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"] }, timeout: 5000 });
    let targetUrl = "";
    let encrypt = 0;
    const playerMatch = res.data.match(/var player_aaaa\s*=\s*(\{[\s\S]+?\})\s*;?\s*</);
    if (playerMatch && playerMatch[1]) {
      try {
        const playerObj = JSON.parse(playerMatch[1]);
        targetUrl = playerObj.url;
        encrypt = playerObj.encrypt;
      } catch (e) {
        const uMatch = playerMatch[1].match(/"url":"([^"]+)"/);
        const eMatch = playerMatch[1].match(/"encrypt":(\d)/);
        if (uMatch) targetUrl = uMatch[1];
        if (eMatch) encrypt = parseInt(eMatch[1]);
      }
    }
    
    if (targetUrl) {
      if (encrypt === 1) targetUrl = safeDecode(targetUrl);
      else if (encrypt === 2) targetUrl = safeDecode(Buffer.from(targetUrl, "base64").toString("utf8"));
      
      if (targetUrl.includes(".m3u8") || targetUrl.includes(".mp4")) {
        baseResult.urls = [{ name: "直链秒播", url: targetUrl }];
        return baseResult;
      }

      if (await isChannelDead("playr")) {
        logInfo("[嗅探] super.playr.top 处于拉黑期内，跳过嗅探通道");
      } else {
        try {
          const sniffUrl = `https://super.playr.top/?url=${encodeURIComponent(targetUrl)}`;
          const playerRes = await axiosInstance.get(sniffUrl, { headers: { "Referer": "https://www.zhenlang.cc/" }, timeout: 5000 });
          const keyMatch = playerRes.data.match(/var\s+precomputedKey\s*=\s*['"]([^'"]+)['"]/);
          const ivMatch = playerRes.data.match(/var\s+precomputedIv\s*=\s*['"]([^'"]+)['"]/);

          if (keyMatch && ivMatch) {
            const dynamicKey = keyMatch[1];
            const dynamicIv = ivMatch[1];
            const tokenRes = await axiosInstance.get(`https://super.playr.top/token.php?url=${encodeURIComponent(targetUrl)}`, { headers: { "Referer": "https://www.zhenlang.cc/" }, timeout: 5000 });
            if (tokenRes.data && tokenRes.data.code === 0) {
              const apiRes = await axiosInstance.get(`https://super.playr.top/api.php?url=${encodeURIComponent(targetUrl)}&token=${tokenRes.data.token}&t=${tokenRes.data.t}`, { headers: { "Referer": "https://www.zhenlang.cc/" }, timeout: 5000 });
              if (apiRes.data && apiRes.data.e === 1 && apiRes.data.d) {
                const decipher = crypto.createDecipheriv("aes-128-cbc", Buffer.from(dynamicKey), Buffer.from(dynamicIv));
                let decrypted = decipher.update(apiRes.data.d, "base64", "utf8");
                decrypted += decipher.final("utf8");
                const parsedData = JSON.parse(decrypted);
                if (parsedData.url) {
                  baseResult.urls = [{ name: "逆向秒播", url: parsedData.url }];
                  return baseResult;
                }
              } else if (apiRes.data && apiRes.data.url) {
                baseResult.urls = [{ name: "逆向秒播", url: apiRes.data.url }];
                return baseResult;
              }
            }
          }
        } catch (crackErr) {
          if (isChannelNetworkFailure(crackErr)) await markChannelDead("playr", crackErr);
          logWarn(`[逆向] 解析失败: ${crackErr.message}`);
        }

        const sniffUrl = `https://super.playr.top/?url=${encodeURIComponent(targetUrl)}`;
        const sniffResult = await OmniBox.sniffVideo(sniffUrl);
        if (sniffResult && sniffResult.url) {
            baseResult.urls = [{ name: "嗅探线路", url: sniffResult.url }];
            baseResult.header = sniffResult.header || DEFAULT_HEADERS;
            return baseResult;
        }
        logWarn("[嗅探] 未返回有效地址");
      }
    }
  } catch (e) { logWarn(`[嗅探] 异常: ${e.message}`); }
  return null;
}

/**
 * 从 MacCMS 的 vod_play_url 里取一个真实可播地址
 * 格式：`线路1$$$线路2`，线路内 `第1集$url#第2集$url`
 */
function pickPlayUrlFromMaccms(vodPlayUrl) {
  const cands = [];
  for (const line of String(vodPlayUrl || "").split("$$$")) {
    for (const ep of line.split("#")) {
      if (!ep) continue;
      const idx = ep.indexOf("$");
      const u = (idx === -1 ? ep : ep.slice(idx + 1)).replace(/\\\//g, "/").trim();
      if (/^https?:\/\//i.test(u)) cands.push(u);
    }
  }
  return cands.find((u) => /\.(m3u8|mp4|flv|ts)(\?|#|$)/i.test(u)) || cands[0] || "";
}

/**
 * 片名相似度粗判
 * 聚合 API 的匹配质量参差 —— 实测搜「大夏守墓人」会返回
 * `https://www.lvsc168.com/movie/2719.html`，而该页标题是《大夏剑主动态漫画》。
 * 播错片比播不了更糟，所以解析成功后必须校验一次片名。
 */
function isNameLike(a, b) {
  const norm = (s) =>
    String(s || "")
      .replace(/[\s·:：\-—_《》()（）\[\]【】,，.。!！?？'"`|]/g, "")
      .toLowerCase();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return true; // 拿不到名字时不拦截
  if (x.includes(y) || y.includes(x)) return true;
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i >= Math.min(4, Math.ceil(Math.min(x.length, y.length) * 0.5));
}

/** 归一化片名（去空白/标点/大小写），用于打分与去重 */
function normName(s) {
  return String(s || "")
    .replace(/[\s·:：\-—_《》()（）\[\]【】,，.。!！?？'"`|$#]/g, "")
    .toLowerCase();
}

/** 更宽的归一化：再把中文里纯连接作用的「的/之」去掉，用于吸掉《隐秘的角落》↔《隐秘角落》这类差异 */
function softNorm(s) {
  return normName(s).replace(/[的之]/g, "");
}

/** 字符多重集 Dice 相似度（2×交集 / 总长），用于兜住「字基本一样、顺序或连接词不同」的片名 */
function diceChars(a, b) {
  if (!a || !b) return 0;
  const pool = new Map();
  for (const ch of a) pool.set(ch, (pool.get(ch) || 0) + 1);
  let common = 0;
  for (const ch of b) {
    const n = pool.get(ch) || 0;
    if (n > 0) {
      common += 1;
      pool.set(ch, n - 1);
    }
  }
  return (2 * common) / (a.length + b.length);
}

/**
 * ★ 搜索相关度（v1.3.2）—— 比 `isNameLike` 严得多，专供搜索结果提纯用
 * ---------------------------------------------------------------------------
 * `isNameLike` 的判据是「公共前缀 ≥ min(4, 片名一半)」，对 4 字片名就等于
 * **只要前 2 个字一样就算相似** —— 这正是搜《大夏守墓人》被塞一屏「大夏无双 /
 * 大夏拳王 / 大夏神官」的原因（它们和《大夏守墓人》没有任何关系）。
 * 这里改为「名字真的被完整包含」才算，另用 Dice 兜住连接词差异：
 *   100 归一化后完全相同
 *    96 片名以关键词开头（「庆余年第一季」之于「庆余年」）
 *    90 片名里完整含有关键词（「独家三体」含「三体」）
 *    85 关键词里完整含有片名（用户多打了后缀），但片名不能太短（挡住 1 字的「三」）
 *    70 字符 Dice ≥ 0.8（「隐秘的角落」↔「隐秘角落」）
 *     0 淘汰
 */
function searchRelevance(title, query) {
  const t = softNorm(title);
  const q = softNorm(query);
  if (!t || !q) return 0;
  if (t === q) return 100;
  if (q.length >= 2 && t.startsWith(q)) return 96;
  if (q.length >= 2 && t.includes(q)) return 90;
  if (t.length >= 2 && 2 * t.length >= q.length && q.includes(t)) return 85;
  if (diceChars(t, q) >= 0.8) return 70;
  return 0;
}

/**
 * 【v1.3.4】原先这里还有一个 scoreName(name, query)（100 全等 / 80 前缀 / 60 isNameLike / 0 淘汰），
 * v1.3.2 起 search/detail/play 已全部改用 searchRelevance，它**全文无调用点**，且注释还在
 * 误导后续维护（isNameLike 那套「前 2 字相同即相似」正是被废弃的宽松判据）。已删除。
 */

/**
 * 搜索结果提纯（v1.3.2）
 * ---------------------------------------------------------------------------
 * 聚合 API（`API/v2.php?q=`）的命中规则是「名字里任意位置含有关键词」，不是标题检索，
 * 于是搜「大夏守墓人」会混进「大夏第一憨王 / 大夏双骄 / 大夏拳王…」，
 * 搜「庆余年」会混进「万千星辉贺台庆 / 人间逍遥西门庆 / 庆余生」——这些条目
 * 既不是用户要找的片，点进去也播不了，白白淹掉真正的结果。
 *
 * 做法：
 *   1. 逐条按片名算相关度（`searchRelevance`），得 0 分的直接淘汰；
 *   2. 同名（仅标点/空白差异，如「庆余年 第一季」vs「庆余年第一季」）只留更干净的一条；
 *   3. 排序：分数降序 → 片名短的在前 → 保持原始先后。
 * 兜底：过滤后一条不剩时，回退原始列表 —— 宁可多给，也不能因为过滤把能搜到的片弄丢。
 */
function rankSearchResults(items, query) {
  const q = softNorm(query);
  if (!q || !Array.isArray(items) || items.length === 0) return items || [];

  const byKey = new Map();
  items.forEach((it, idx) => {
    const title = String((it && it.vod_name) || "").trim();
    if (!title) return;
    const key = normName(title);
    if (!key) return;
    const score = searchRelevance(title, query);
    if (score <= 0) return;

    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { it, score, key, idx });
      return;
    }
    // 同名片：留更短（更干净）的那个，但排序位置沿用先出现者的
    if (title.length < String((prev.it && prev.it.vod_name) || "").trim().length) {
      byKey.set(key, { it, score, key, idx: prev.idx });
    } else if (score > prev.score) {
      prev.score = score;
    }
  });

  if (byKey.size === 0) return items;

  const scored = Array.from(byKey.values());
  scored.sort((a, b) => (b.score - a.score) || (a.key.length - b.key.length) || (a.idx - b.idx));
  return scored.map((s) => s.it);
}

/**
 * 把 MacCMS 的 vod_play_url 拆成结构化线路
 *   vod_play_from: "dyttm3u8$$$bfzym3u8"      （线路名）
 *   vod_play_url : "第01集$url#第02集$url$$$…" （线路内 集名$地址 用 # 分隔）
 * 只保留**媒体直链**：电影天堂/如意资源会掺 `/share/xxxx` 这类分享页（返回 text/html），
 * 不做过滤的话会被当成播放地址发给播放器（必播失败）。
 */
function splitMaccmsLines(vod) {
  const froms = String((vod && vod.vod_play_from) || "").split("$$$");
  const urls = String((vod && vod.vod_play_url) || "").split("$$$");
  const lines = [];
  urls.forEach((raw, i) => {
    const episodes = [];
    for (const ep of raw.split("#")) {
      if (!ep) continue;
      const k = ep.indexOf("$");
      if (k === -1) continue;
      const name = ep.slice(0, k).trim() || `第${episodes.length + 1}集`;
      const url = ep.slice(k + 1).replace(/\\\//g, "/").trim();
      if (!/^https?:\/\//i.test(url)) continue;
      if (!MEDIA_URL_RE.test(url)) continue;
      episodes.push({ name, url });
    }
    if (episodes.length > 0) {
      const lineName = String(froms[i] || "").trim() || `线路${i + 1}`;
      lines.push({ name: lineName, episodes });
    }
  });
  return lines;
}

/** 按上一层的集名/集号，在候选线路里挑出对应那一集 */
function pickEpisodeByHint(episodes, hint) {
  if (!episodes || episodes.length === 0) return null;
  const h = normName(hint);
  if (h) {
    const exact = episodes.find((e) => normName(e.name) === h);
    if (exact) return exact;
    const inc = episodes.find((e) => {
      const n = normName(e.name);
      return n && (n.includes(h) || h.includes(n));
    });
    if (inc) return inc;
  }
  const hn = extractEpisode(hint || "");
  if (hn) {
    const byNum = episodes.find((e) => extractEpisode(e.name) === String(hn));
    if (byNum) return byNum;
  }
  return episodes[0];
}

/** 在单个上游站做精确标题检索，命中则连线路一起返回 */
async function queryUpstreamExact(host, keyword) {
  const url = `${host.origin}${host.api}/?ac=videolist&wd=${encodeURIComponent(keyword)}`;
  const res = await axiosInstance.get(url, {
    headers: { ...DEFAULT_HEADERS, Referer: `${host.origin}/`, Accept: "*/*" },
    timeout: 8000,
  });
  const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
  const list = Array.isArray(data && data.list) ? data.list : [];
  let best = null;
  let bestScore = 0;
  for (const v of list) {
    // 【v1.3.2】判据与搜索提纯统一：必须「名字被完整包含」才算命中。
    // 旧版用的 isNameLike 允许「前 2 字相同」，会把《大夏无双》当成《大夏守墓人》的替代品返回，
    // 用户点进去播的是另一部片 —— 播错片比播不了更糟。
    const s = searchRelevance(v && v.vod_name, keyword);
    if (s <= 0) continue;
    const shorter = best && normName(v && v.vod_name).length < normName(best.vod_name).length;
    if (s > bestScore || (s === bestScore && shorter)) {
      best = v;
      bestScore = s;
    }
  }
  if (!best || bestScore < 70) return null;
  const lines = splitMaccmsLines(best);
  if (lines.length === 0) return null;
  return { host, vod: best, lines };
}

/**
 * 多上游并发精确检索
 * @returns [{ host, vod, lines }] —— 只含「片名匹配 + 真的解析出媒体直链」的站
 */
async function searchExactUpstreams(keyword, maxHosts = MAX_EXACT_HOSTS) {
  const kw = String(keyword || "").trim();
  if (!kw) return [];
  const hosts = EXACT_UPSTREAMS.slice(0, maxHosts);
  const rs = await Promise.allSettled(hosts.map((h) => queryUpstreamExact(h, kw)));
  const out = [];
  rs.forEach((r, i) => {
    if (r.status === "fulfilled") {
      if (r.value) out.push(r.value);
    } else {
      logWarn(`[上游] ${hosts[i].origin} 精确检索失败: ${r.reason && r.reason.message}`);
    }
  });
  return out;
}

/** 把精确检索结果铺平成 OmniBox 的 vod_play_sources（每站每线路一条） */
function exactHitsToSources(hits) {
  const sources = [];
  (hits || []).forEach((h) => {
    h.lines.forEach((line) => {
      sources.push({
        name: `${h.host.name} · ${line.name}`,
        episodes: line.episodes.map((e) => ({ name: e.name, playId: e.url })),
      });
    });
  });
  return sources;
}

/**
 * 上游站解析（v1.2.0 新增）—— 「全网聚合备用源」的播放修复
 * ---------------------------------------------------------------------------
 * 备用源来自 `https://www.ymck.pro/API/v2.php?q=片名&size=50`，返回的是一批
 * **第三方站点详情页地址**（如 `https://feikuai.in/voddetail/261118.html`、
 * `https://www.lvsc168.com/movie/2719.html`）。
 *
 * 旧版 play 对这类 playId 没有任何专门处理：三个专用解析器只认
 * 03yy/kxyytv/zhenlang，匹配不上就直接把**详情页 HTML 地址**当播放地址返回
 * （parse:1 交给客户端嗅探）——详情页里并没有可直接播放的媒体流，
 * 嗅探几乎必然失败，表现就是「点播放没反应」。
 *
 * 实测这些上游绝大多数是 MacCMS 站，可直接调采集接口拿真实 m3u8：
 *   GET {origin}/api.php/provide/vod/?ac=detail&ids={id}
 *   → list[0].vod_play_url = "HD$https://xxx.com/..../index.m3u8"
 * 若采集接口不可用（实测部分站已改路径返回 404，或根本不是 MacCMS），
 * 退化为抓详情页 HTML 里的 m3u8。
 */
async function playUpstream(url, baseResult, vodName) {
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch (e) {
    return null;
  }
  const hdrs = { ...DEFAULT_HEADERS, Referer: `${origin}/` };
  const idMatch = String(url).match(/(\d+)\.html/);
  const id = idMatch ? idMatch[1] : "";

  // 1) MacCMS 采集接口（最快最稳）
  if (id) {
    for (const api of [
      `${origin}/api.php/provide/vod/?ac=detail&ids=${id}`,
      `${origin}/api.php/provide/vod?ac=videolist&ids=${id}`,
    ]) {
      try {
        const r = await axiosInstance.get(api, { headers: hdrs, timeout: 8000 });
        const data = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
        const v = (data && data.list && data.list[0]) || null;
        if (v && !isNameLike(v.vod_name, vodName)) {
          logWarn(`[上游] ${origin} 片名不匹配（${v.vod_name} ≠ ${vodName}），跳过`);
          continue;
        }
        const playUrl = pickPlayUrlFromMaccms(v && v.vod_play_url);
        if (playUrl) {
          logInfo(`[上游] ${origin} 采集接口解析成功`);
          baseResult.urls = [{ name: "上游直链", url: playUrl }];
          baseResult.header = hdrs;
          baseResult.parse = 0;
          return baseResult;
        }
      } catch (e) { logWarn(`[上游:${origin}] 采集接口解析失败: ${e.message}`); }
    }
  }

  // 2) 兜底：抓详情页 HTML 直接匹配 m3u8/mp4
  try {
    const r = await axiosInstance.get(url, { headers: hdrs, timeout: 8000 });
    const html = String(r.data || "");
    const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
    if (vodName && title && !isNameLike(title, vodName)) {
      logWarn(`[上游] ${origin} 页面片名不匹配（${title.slice(0, 24)}…），跳过`);
      return null;
    }
    const m3 = html.match(/https?:\/\/[^"'\s\\]+\.(?:m3u8|mp4)[^"'\s\\]*/gi);
    if (m3 && m3.length) {
      logInfo(`[上游] ${origin} 页面解析成功`);
      baseResult.urls = [{ name: "上游直链", url: m3[0].replace(/\\\//g, "/") }];
      baseResult.header = hdrs;
      baseResult.parse = 0;
      return baseResult;
    }
    logWarn(`[上游:${origin}] 页面解析未取到直链`);
  } catch (e) { logWarn(`[上游:${origin}] 页面解析失败: ${e.message}`); }

  logWarn(`[上游] ${origin} 未能解析出播放地址`);
  return null;
}

/**
 * 备用源解析 + 跨源兜底
 * 当前源解析失败时，用片名重取聚合列表，换其它上游再试（优先已验证可解析的站）。
 * 最多换 3 个不同域名，避免首播等待过久。
 * 【v1.3.0】全都失败时，再用片名做一次**上游精确标题检索**并按集名对齐取直链 ——
 * 聚合索引是子串匹配，遇到它没收录的片名（如「大夏守墓人」）必然全军覆没，
 * 只有上游 `wd=` 精确检索能救回来。
 */
async function playUpstreamWithFallback(url, baseResult, vodName, episodeName) {
  const own = await playUpstream(url, baseResult, vodName);
  if (own) return own;

  let origin0 = "";
  try {
    origin0 = new URL(url).origin;
  } catch (e) {}

  let list = [];
  try {
    const r = await axiosInstance.get(
      `${HOST}/API/v2.php?q=${encodeURIComponent(vodName || "")}&size=50`,
      { headers: { ...DEFAULT_HEADERS, Accept: "*/*" }, timeout: 10000 }
    );
    const parsed = JSON.parse(d64(r.data));
    list = Array.isArray(parsed) ? parsed : parsed.data || [];
  } catch (e) {
    logWarn(`[上游] 兜底取源失败: ${e.message}`);
  }

  // 飞快TV 是实测稳定可解析的 MacCMS 标准站（采集接口直接给 m3u8），优先试
  const rank = (u) => (String(u || "").includes("feikuai.in") ? 0 : 1);
  const tried = new Set([origin0]);
  for (const item of list.filter((i) => i && i.url).sort((a, b) => rank(a.url) - rank(b.url))) {
    let o = "";
    try {
      o = new URL(item.url).origin;
    } catch (e) {
      continue;
    }
    if (tried.has(o) || tried.size >= 4) continue;
    tried.add(o);
    const r = await playUpstream(item.url, baseResult, vodName);
    if (r) {
      logInfo(`[上游] 兜底换源命中: ${o} (${item.website || ""})`);
      return r;
    }
    await new Promise((res) => setTimeout(res, 150));
  }

  // 【v1.3.0】最后一道：上游精确标题检索 + 集名对齐
  try {
    const hits = await searchExactUpstreams(vodName);
    for (const h of hits) {
      for (const line of h.lines) {
        const ep = pickEpisodeByHint(line.episodes, episodeName);
        if (!ep) continue;
        baseResult.urls = [{ name: `上游直链 · ${h.host.name}`, url: ep.url }];
        baseResult.header = { ...DEFAULT_HEADERS, Referer: `${h.host.origin}/` };
        baseResult.parse = 0;
        logInfo(`[上游] 精确检索兜底命中: ${h.host.name} · ${line.name} · ${ep.name}`);
        return baseResult;
      }
    }
  } catch (e) {
    logWarn(`[上游] 精确检索兜底异常: ${e.message}`);
  }

  logWarn("[上游] 兜底换源也未解析出可播地址");
  return null;
}

/** 播放地址本身就是媒体直链时直接返回（不再当成详情页去下钻） */
function playDirectMedia(url, baseResult) {
  baseResult.urls = [{ name: "上游直链", url }];
  baseResult.header = { ...DEFAULT_HEADERS };
  try {
    baseResult.header.Referer = new URL(url).origin + "/";
  } catch (e) {}
  baseResult.parse = 0;
  return baseResult;
}

async function play(params) {
  const t0 = Date.now();
  const playId = params?.playId || params?.id || "";
  if (!playId) return { urls: [] };

  let rawPlayId = playId;
  let playMeta = {};
  if (playId.includes('|||')) {
      const parts = playId.split('|||');
      rawPlayId = parts[0];
      playMeta = decodeMeta(parts[1] || "");
  }

  let playResult = { urls: [], parse: 0, header: DEFAULT_HEADERS };

  let danmakuPromise = Promise.resolve([]);
  if (DANMU_API) {
      let vodName = params.vodName || playMeta.v || "";
      let episodeName = params.episodeName || playMeta.e || "";
      const fileName = buildFileNameForDanmu(vodName, episodeName, playMeta.s, playMeta.n);
      if (fileName) danmakuPromise = matchDanmu(fileName).catch(() => []);
  }

  let specificResultPromise = Promise.resolve(null);
  if (MEDIA_URL_RE.test(rawPlayId)) {
    // 【v1.3.0】detail 的上游精确检索会直接把真实 m3u8 写进 playId
    // （这些 CDN 直链不需要 Referer，实测裸请求即 200 + application/vnd.apple.mpegurl），
    // 这种「已经是媒体流」的地址必须 parse:0 直出；当成详情页去下钻会白等十几秒。
    // 【v1.3.1】同时查一次 detail 落盘的多线路清单：命中就把该集在所有线路上的直链一起返回，
    // 某条 CDN 挂了用户还能在播放器里直接切下一条。
    specificResultPromise = (async () => {
      try {
        const multi = await resolveMultiLinePlay(rawPlayId, playMeta);
        if (multi) {
          logInfo(`命中多线路清单，一次返回 ${multi.urls.length} 条`, { 当前: rawPlayId.slice(0, 80) });
          return multi;
        }
      } catch (e) {
        logWarn("多线路清单读取失败，退回单条直出", e);
      }
      logInfo(`直出媒体直链: ${rawPlayId.slice(0, 110)}`);
      return playDirectMedia(rawPlayId, playResult);
    })();
  }
  else if (rawPlayId.includes("03yy.live")) specificResultPromise = play03yy(rawPlayId, playResult);
  else if (rawPlayId.includes("kxyytv.com")) specificResultPromise = playKaixin(rawPlayId, playResult);
  else if (rawPlayId.includes("zhenlang.cc")) specificResultPromise = playZhenlang(rawPlayId, playResult);
  // 其余情况都是「全网聚合备用源」里的第三方站详情页地址 —— 必须走下钻解析，
  // 否则会把 HTML 详情页当播放地址返回，客户端必然播不了。
  // 单站解析失败时还会用片名换其它上游重试（聚合 API 存在错配源）。
  else if (/^https?:\/\//i.test(rawPlayId))
    specificResultPromise = playUpstreamWithFallback(
      rawPlayId,
      playResult,
      playMeta.v || params?.vodName || "",
      playMeta.e || params?.episodeName || ""
    );

  const [specificResult, danmakuList] = await Promise.all([specificResultPromise, danmakuPromise]);

  if (danmakuList && danmakuList.length > 0) {
      if (specificResult) specificResult.danmaku = danmakuList;
      playResult.danmaku = danmakuList;
  }

  if (specificResult && specificResult.urls.length > 0) {
      logInfo(`播放解析完成 (直链), 耗时: ${Date.now() - t0}ms`);
      return specificResult;
  }

  try {
    const sniffResult = await OmniBox.sniffVideo(rawPlayId);
    if (sniffResult && sniffResult.url) {
      playResult.urls = [{ name: "嗅探线路", url: sniffResult.url }];
      playResult.header = sniffResult.header || DEFAULT_HEADERS;
      logInfo(`播放解析完成 (嗅探), 耗时: ${Date.now() - t0}ms`);
      return playResult;
    }
    logWarn(`播放解析失败（嗅探未命中）: ${rawPlayId.slice(0, 80)}`);
  } catch (e) { logWarn(`播放解析异常: ${e.message}`); }

  // 兜底：交由客户端嗅探。
  // 注意这是上游**详情页**地址而不是播放地址，只有支持嗅探的客户端（如 ok影视）能处理；
  // 其余客户端会忽略 parse 字段、把 HTML 当媒体流去播，必然失败 —— 所以打 warn 便于定位。
  playResult.urls = [{ name: "网页解析", url: rawPlayId }];
  playResult.parse = 1;
  try {
    playResult.header = { ...DEFAULT_HEADERS, Referer: new URL(rawPlayId).origin + "/" };
  } catch (e) {}
  logWarn(`[play] 所有直链解析均失败，回退页面嗅探: ${rawPlayId}`);
  logInfo(`播放解析完成 (交由播放器), 耗时: ${Date.now() - t0}ms`);
  return playResult;
}

module.exports = { home, category, detail, search, play };
const runner = require("spider_runner");
runner.run(module.exports);
