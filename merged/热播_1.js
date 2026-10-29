// @name 热播
// @author 
// @description 刮削：支持，弹幕：支持，嗅探：支持
// @description 多线路：同一集在各条线路上的地址一次全列（当前线路优先）
// @dependencies: axios, crypto-js
// @version 1.0.6
// @downloadURL https://gh-proxy.org/https://github.com/xiaohu1949/OmniBox-Spider/raw/refs/heads/main/影视/采集/热播.js

/**
 * OmniBox 爬虫脚本 - 热播（APP 接口）
 *
 * 说明：
 * 1. 本脚本基于 `本地调试/热播.js` 逻辑转换为 OmniBox 标准 JS 模板结构。
 * 2. 接口包含：`home` / `category` / `search` / `detail` / `play`。
 * 3. 详情接口将旧式播放数据转换为 `vod_play_sources`，供播放器直接识别。
 * 4. `playId` 使用 Base64(JSON) 透传，播放阶段再解码并按原逻辑解析。
 *
 * 环境变量：
 * - `REBANG_HOST`：站点 Host，默认 `http://v.rbotv.cn`
 * - `REBANG_MULTI_LINES`：是否开启多线路（默认 `true`，设 `false` 退回只给当前线路）
 * - `MAX_PLAY_SOURCES`：一次最多返回几条线路，默认 `0`（0 = 全部线路）
 * - `PLAY_SOURCE_TIMEOUT`：单条线路解析超时（毫秒），默认 `8000`
 *
 * 兼容说明：
 * - 保留了原脚本签名算法（`sign + timestamp`）与 multipart/form-data 请求体构造。
 * - 保留了原脚本的解析回退逻辑：解析接口失败时返回 `parse=1`。
 */

const axios = require("axios");
const http = require("http");
const https = require("https");
const CryptoJS = require("crypto-js");
const OmniBox = require("omnibox_sdk");

// ==================== 配置区域 ====================
const HOST = process.env.REBANG_HOST || "http://v.rbotv.cn";
const DANMU_API = process.env.DANMU_API || "";
const UA = "okhttp-okgo/jeasonlzy";
const FORM_BOUNDARY = "18a7affc-a82a-4dc2-a848-7b0658d7665c";

const DEFAULT_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "zh-CN,zh;q=0.8",
  Referer: HOST,
};

const PLAY_HEADERS = {
  "User-Agent": UA,
  Referer: HOST,
};

// ==================== 多线路配置 ====================
// 热播的详情接口里，每条线路的每个剧集都自带一个 Base64(JSON) 的 playId，
// JSON 里就装着该集的 **真实播放地址**（url）、解析接口（p）、Referer（r）、UA（u）。
// 也就是说 —— 同一集在所有线路上的地址，**详情阶段就已经全部拿到了**，
// 不像七味那样还得逐条去抓播放页（零额外请求）。
// 过去 play() 只把「用户点中的那一条」返回，那条 CDN 挂了这一集就放不了；
// 实测本品 3 条线路分属不同 CDN（nby / lz / ff），互为备份。
// 做法：detail 阶段把「集序号 → 各线路 playId」落盘，play 阶段一次全解出来。
// 注意客户端每次调用都是新进程，状态必须落盘（OmniBox.setCache），进程内变量毫无意义。
const MULTI_LINE_ENABLED = String(process.env.REBANG_MULTI_LINES || "true").toLowerCase() !== "false";
const MULTI_LINE_TTL_SECONDS = 6 * 3600;
const MAX_PLAY_SOURCES = (() => {
  const n = parseInt(String(process.env.MAX_PLAY_SOURCES || "0").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0; // 0 = 全部线路
})();
const PLAY_SOURCE_TIMEOUT = (() => {
  const n = parseInt(String(process.env.PLAY_SOURCE_TIMEOUT || "8000").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 8000;
})();

const axiosInstance = axios.create({
  timeout: 20 * 1000,
  httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
  httpAgent: new http.Agent({ keepAlive: true }),
  headers: DEFAULT_HEADERS,
  responseType: "json",
});

// ==================== 日志工具 ====================
function logInfo(message, data = null) {
  const output = data ? `${message}: ${JSON.stringify(data)}` : message;
  OmniBox.log("info", `[热播] ${output}`);
}

function logError(message, error) {
  OmniBox.log("error", `[热播] ${message}: ${error?.message || error}`);
}

function logWarn(message, error) {
  OmniBox.log("warn", `[热播] ${message}${error ? `: ${error?.message || error}` : ""}`);
}

// ==================== 编解码与签名工具 ====================
/**
 * UTF8 -> Base64
 * @param {string} text 文本
 * @returns {string}
 */
function e64(text) {
  try {
    return CryptoJS.enc.Utf8.parse(String(text || "")).toString(CryptoJS.enc.Base64);
  } catch {
    return "";
  }
}

/**
 * Base64 -> UTF8
 * @param {string} encodedText Base64 文本
 * @returns {string}
 */
function d64(encodedText) {
  try {
    return CryptoJS.enc.Base64.parse(String(encodedText || "")).toString(CryptoJS.enc.Utf8);
  } catch {
    return "";
  }
}

/**
 * 生成 POST 请求体（multipart/form-data），沿用原站签名算法。
 * @param {Object} params 业务参数
 * @returns {{ body: string, headers: Object }}
 */
function buildSignedMultipartBody(params = {}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signStr = `7gp0bnd2sr85ydii2j32pcypscoc4w6c7g5spl${timestamp}`;
  const sign = CryptoJS.MD5(signStr).toString();

  let body = "";
  for (const [key, value] of Object.entries(params)) {
    body += `--${FORM_BOUNDARY}\r\n`;
    body += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
    body += `${value}\r\n`;
  }

  body += `--${FORM_BOUNDARY}\r\n`;
  body += `Content-Disposition: form-data; name="sign"\r\n\r\n`;
  body += `${sign}\r\n`;
  body += `--${FORM_BOUNDARY}\r\n`;
  body += `Content-Disposition: form-data; name="timestamp"\r\n\r\n`;
  body += `${timestamp}\r\n`;
  body += `--${FORM_BOUNDARY}--\r\n`;

  return {
    body,
    headers: {
      ...DEFAULT_HEADERS,
      "Content-Type": `multipart/form-data; boundary=${FORM_BOUNDARY}`,
    },
  };
}

/**
 * 请求热播接口
 * @param {string} url 接口地址
 * @param {string} method 请求方法
 * @param {Object} params 参数
 * @returns {Promise<Object|null>}
 */
async function requestApi(url, method = "GET", params = {}) {
  try {
    const options = {
      method,
      headers: { ...DEFAULT_HEADERS },
    };

    if (method.toUpperCase() === "POST") {
      const multipart = buildSignedMultipartBody(params);
      options.data = multipart.body;
      options.headers = { ...multipart.headers };
    }

    const response = await axiosInstance(url, options);
    return response.data;
  } catch (error) {
    logError(`请求失败: ${url}`, error);
    return null;
  }
}

// ==================== 数据转换工具 ====================
/**
 * 将接口列表数据转成 OmniBox 标准视频列表结构。
 * @param {Array} videos 原始数组
 * @returns {Array}
 */
function formatVideoList(videos) {
  return (videos || []).map((vod) => ({
    vod_id: String(vod.vod_id || ""),
    vod_name: vod.vod_name || "",
    vod_pic: vod.vod_pic || vod.vod_pic_thumb || "",
    vod_remarks: vod.vod_remarks || "",
    vod_year: vod.tag || "",
  }));
}

// ==================== 弹幕工具 ====================
function preprocessTitle(title) {
  if (!title) return "";
  return title
    .replace(/4[kK]|[xX]26[45]|720[pP]|1080[pP]|2160[pP]/g, " ")
    .replace(/[hH]\.?26[45]/g, " ")
    .replace(/BluRay|WEB-DL|HDR|REMUX/gi, " ")
    .replace(/\.mp4|\.mkv|\.avi|\.flv/gi, " ");
}

function chineseToArabic(cn) {
  const map = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (!isNaN(cn)) return parseInt(cn, 10);
  if (cn.length === 1) return map[cn] || cn;
  if (cn.length === 2) {
    if (cn[0] === "十") return 10 + map[cn[1]];
    if (cn[1] === "十") return map[cn[0]] * 10;
  }
  if (cn.length === 3) return map[cn[0]] * 10 + map[cn[2]];
  return cn;
}

function extractEpisode(title) {
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
}

function buildFileNameForDanmu(vodName, episodeTitle) {
  if (!vodName) return "";
  if (!episodeTitle || episodeTitle === "正片" || episodeTitle === "播放") return vodName;

  const digits = extractEpisode(episodeTitle);
  if (digits) {
    const epNum = parseInt(digits, 10);
    if (epNum > 0) {
      if (epNum < 10) return `${vodName} S01E0${epNum}`;
      return `${vodName} S01E${epNum}`;
    }
  }
  return vodName;
}

function buildScrapedEpisodeName(scrapeData, mapping, originalName) {
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
}

function buildScrapedDanmuFileName(scrapeData, scrapeType, mapping, fallbackVodName, fallbackEpisodeName) {
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
}

async function matchDanmu(fileName) {
  if (!DANMU_API || !fileName) return [];

  try {
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
    if (!matchData.isMatched) return [];

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
}

/**
 * 嗅探播放页，兜底提取真实视频地址
 */
async function sniffRebangPlay(playUrl) {
  if (!playUrl) return null;
  try {
    logInfo("尝试嗅探播放页", playUrl);
    const sniffed = await OmniBox.sniffVideo(playUrl);
    if (sniffed && sniffed.url) {
      logInfo("嗅探成功", sniffed.url);
      return {
        urls: [{ name: "嗅探线路", url: sniffed.url }],
        parse: 0,
        header: sniffed.header || { ...PLAY_HEADERS, Referer: playUrl },
      };
    }
  } catch (error) {
    logInfo(`嗅探失败: ${error.message}`);
  }
  return null;
}

/**
 * 将旧数据中的 `vod_play_list` 转换为 `vod_play_sources`。
 *
 * 每个剧集 `playId` 存储为 Base64(JSON)：
 * {
 *   url: 实际播放地址,
 *   p: 解析接口列表,
 *   r: Referer,
 *   u: User-Agent
 * }
 *
 * @param {Array} vodPlayList 原始播放列表
 * @returns {Array}
 */
function convertVodPlayListToSources(vodPlayList, vodName = "", videoId = "") {
  const playSources = [];

  (vodPlayList || []).forEach((line, index) => {
    const episodes = [];

    (line.urls || []).forEach((item, epIndex) => {
      // 【v1.0.5】集键用真实集号而非线路内下标 —— nby/lz/ff 各线路集数与顺序不一致，
      // 按下标对齐会把「第 3 集的线路A」和「第 3 集的线路B」错配成不同集（用户点第 3 集拿到第 4 集）。
      // 抽不出集号时回退下标并加 `i` 前缀，与真实集号区分开。
      const epName = item.name || `第${epIndex + 1}集`;
      const epKey = resolveEpKey(epName, epIndex);
      const fid = buildFid(videoId, index, epKey);
      const playData = {
        url: item.url,
        p: line.parse_urls,
        r: line.referer,
        u: line.ua,
        v: vodName,
        e: epName,
        sid: videoId,
        fid,
      };

      episodes.push({
        name: epName,
        playId: e64(JSON.stringify(playData)),
        _fid: fid,
        _epKey: epKey,
        _rawName: epName,
      });
    });

    if (episodes.length > 0) {
      playSources.push({
        name: `线路${index + 1}${line.flag ? `(${line.flag})` : ""}`,
        episodes,
      });
    }
  });

  return playSources;
}

// ==================== 多线路解析 ====================
/**
 * 【v1.0.5】fid 分隔符从 `#` 换成 `§`：`#` 可能出现在派生的 videoId 里，
 *   `§` 会被 encodeURIComponent 转义成 %C2%A7，片名里几乎不出现，比 `#` 安全。
 *   解析一律「从尾部切」（videoId = 去掉末两段后重新拼回），对纯数字 id 与旧逻辑一致。
 * ⚠️ 前缀同步升到 v2：v1 用「线路内下标」做键，与 v2 的「集号」数值区间重叠，
 *   沿用旧前缀会把「第 3 行」当成「第 3 集」，直接播错集。
 */
const MULTI_LINE_CACHE_PREFIX = "rb:multi:v2";
const FID_SEP = "§";

function buildFid(videoId, sIdx, epKey) {
  return `${String(videoId == null ? "" : videoId)}${FID_SEP}${sIdx}${FID_SEP}${epKey}`;
}

/** 集键优先用真实集号；抽不出才回退线路内下标并加 `i` 前缀（与真实集号区分） */
function resolveEpKey(epName, epIdx) {
  const n = parseInt(extractEpisode(epName || ""), 10);
  if (Number.isInteger(n) && n > 0) return String(n);
  return `i${epIdx}`;
}

function buildMultiLineCacheKey(videoId) {
  return `${MULTI_LINE_CACHE_PREFIX}:${String(videoId || "")}`;
}

/**
 * 从 detail 的 `vod_play_sources` 抽「集序号 → 各线路 playId」。
 *
 * ⚠️ 集序号必须取自 `_fid`（格式 `<videoId>§<线路号>§<集键>`），**不能用数组下标**：
 *    刮削之后 `episodes` 会被按季/集重新排序，下标和 fid 已经对不上（影猫那边踩过）。
 */
function buildMultiLineMapFromSources(playSources) {
  const map = {};
  for (const source of playSources || []) {
    const lineName = String(source?.name || "线路");
    for (const ep of source?.episodes || []) {
      const playId = String(ep?.playId || "");
      if (!playId) continue;
      const parts = String(ep?._fid || "").split(FID_SEP);
      if (parts.length < 3) continue;
      const epKey = parts[parts.length - 1];
      if (!map[epKey]) map[epKey] = [];
      map[epKey].push({ l: lineName, id: playId });
    }
  }
  return map;
}

async function saveMultiLineMap(videoId, playSources) {
  try {
    if (!MULTI_LINE_ENABLED || !videoId) return;
    const map = buildMultiLineMapFromSources(playSources);
    const epKeys = Object.keys(map);
    if (epKeys.length === 0) return;
    await OmniBox.setCache(buildMultiLineCacheKey(videoId), JSON.stringify(map), MULTI_LINE_TTL_SECONDS);
    logInfo("多线路清单已落盘", { videoId, 覆盖集数: epKeys.length, 首集线路数: map[epKeys[0]].length });
  } catch (error) {
    logWarn("多线路清单落盘失败", error);
  }
}

async function loadMultiLineMap(videoId) {
  try {
    const raw = await OmniBox.getCache(buildMultiLineCacheKey(videoId));
    if (!raw) return null;
    const map = typeof raw === "string" ? JSON.parse(raw) : raw;
    return map && typeof map === "object" ? map : null;
  } catch (error) {
    return null;
  }
}

/**
 * 把一条线路的 playData 解成可直接播放的地址。
 * 返回 `{url, header}`；解不出返回 `null`（调用方走原逻辑兜底）。
 */
async function resolvePlayDataToUrl(playData) {
  const headers = {};
  if (playData.r) headers.Referer = playData.r;
  if (playData.u) headers["User-Agent"] = playData.u;

  const rawUrl = String(playData.url || "");

  // 带解析接口的线路（如 nby：url 是 `NBY-xxxx`，要走 p[0] 换出真地址）
  if (Array.isArray(playData.p) && playData.p.length > 0) {
    const parseUrl = playData.p[0] + encodeURIComponent(rawUrl);
    try {
      const response = await axiosInstance({
        url: parseUrl,
        method: "GET",
        headers,
        responseType: "text",
        timeout: PLAY_SOURCE_TIMEOUT,
      });
      const parseData = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
      const parsedUrl = parseData?.url || parseData?.data?.url;
      if (parsedUrl) {
        if (parseData.UA) headers["User-Agent"] = parseData.UA;
        return { url: parsedUrl, header: headers };
      }
      logWarn("线路解析接口未返回播放地址");
    } catch (error) {
      logWarn("线路解析接口调用失败", error);
    }
    return null;
  }

  // 无解析接口 = 本身就是 CDN 直链（lz / ff 这类）
  if (/^https?:\/\//i.test(rawUrl)) {
    return { url: rawUrl, header: headers };
  }
  return null;
}

/**
 * 命中多线路清单时，把该集在所有线路上的地址一次解析出来（**当前线路排第一**）。
 * 返回 `null` 表示用不上清单（未开启 / 无缓存 / 只有一条），调用方走原单线路逻辑。
 */
async function resolveMultiLineResponse(ids, playId) {
  const parts = String(ids?.fid || "").split(FID_SEP);
  if (parts.length < 3) return null;

  // 【v1.0.5】从尾部切，videoId 自身可能含分隔符
  const videoId = parts.slice(0, -2).join(FID_SEP);
  const epKey = parts[parts.length - 1];
  const map = await loadMultiLineMap(videoId);
  const list = map?.[epKey];
  if (!Array.isArray(list) || list.length <= 1) return null;

  const current = list.find((it) => it.id === playId);
  const ordered = current ? [current, ...list.filter((it) => it !== current)] : list;
  const limit = MAX_PLAY_SOURCES > 0 ? Math.min(MAX_PLAY_SOURCES, ordered.length) : ordered.length;
  const picked = ordered.slice(0, limit);

  const settled = await Promise.allSettled(
    picked.map(async (it) => {
      const decoded = JSON.parse(d64(it.id));
      const resolved = await resolvePlayDataToUrl(decoded);
      return resolved ? { name: it.l, url: resolved.url, header: resolved.header } : null;
    })
  );

  // 按 **解析后的地址** 去重：不同线路名有时会指向同一个 CDN 地址
  const urls = [];
  const seen = new Set();
  let header = {};
  for (let i = 0; i < settled.length; i += 1) {
    const item = settled[i];
    if (item.status !== "fulfilled" || !item.value) continue;
    if (seen.has(item.value.url)) continue;
    seen.add(item.value.url);
    if (urls.length === 0) header = item.value.header || {};
    urls.push({ name: item.value.name, url: item.value.url });
  }

  if (urls.length === 0) return null;
  logInfo("多线路解析完成", { videoId, 集: epKey, 候选: picked.map((x) => x.l), 命中: urls.length });
  return { urls, parse: 0, header };
}

/**
 * 解析筛选配置（来自 `top_type`）
 * @param {Array} typeList 类型列表
 * @returns {{ classes: Array, filters: Object }}
 */
function buildClassesAndFilters(typeList) {
  const classes = [];
  const filters = {};

  (typeList || []).forEach((item) => {
    const typeId = String(item.type_id || "");
    if (!typeId) return;

    classes.push({
      type_id: typeId,
      type_name: item.type_name || typeId,
    });

    const fts = [];

    if (Array.isArray(item.extend) && item.extend.length > 0) {
      const value = item.extend
        .filter((v) => v && v !== "全部")
        .map((v) => ({ name: v, value: v }));
      if (value.length > 0) {
        fts.push({ key: "class", name: "类型", init: "", value: [{ name: "全部", value: "" }, ...value] });
      }
    }

    if (Array.isArray(item.area) && item.area.length > 0) {
      const value = item.area
        .filter((v) => v && v !== "全部")
        .map((v) => ({ name: v, value: v }));
      if (value.length > 0) {
        fts.push({ key: "area", name: "地区", init: "", value: [{ name: "全部", value: "" }, ...value] });
      }
    }

    if (Array.isArray(item.lang) && item.lang.length > 0) {
      const value = item.lang
        .filter((v) => v && v !== "全部")
        .map((v) => ({ name: v, value: v }));
      if (value.length > 0) {
        fts.push({ key: "lang", name: "语言", init: "", value: [{ name: "全部", value: "" }, ...value] });
      }
    }

    if (Array.isArray(item.year) && item.year.length > 0) {
      const value = item.year
        .filter((v) => v && v !== "全部")
        .map((v) => ({ name: v, value: v }));
      if (value.length > 0) {
        fts.push({ key: "year", name: "年份", init: "", value: [{ name: "全部", value: "" }, ...value] });
      }
    }

    fts.push({
      key: "by",
      name: "排序",
      init: "time",
      value: [
        { name: "按时间", value: "time" },
        { name: "按人气", value: "hits" },
        { name: "按评分", value: "score" },
      ],
    });

    if (fts.length > 0) {
      filters[typeId] = fts;
    }
  });

  return { classes, filters };
}

// ==================== OmniBox 标准接口实现 ====================
/**
 * 获取首页数据
 * @param {Object} params 参数对象
 * @returns {Promise<{class:Array,filters:Object,list:Array}>}
 */
// 【v1.0.6】首页短 TTL 缓存：客户端每次切源都是新进程，首页要打 top_type + tj_vod 两个 POST。
// 缓存后二次进入 <0.3s，与豆瓣/哔哩系对齐。
const HOME_CACHE_KEY = "rbotv:home:v1";
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
  try {
    const cached = await readHomeCache();
    if (cached) {
      logInfo(`首页命中缓存 ${cached.list.length} 条`);
      return cached;
    }

    logInfo("获取首页数据");

    const [typeData, homeVodData] = await Promise.all([
      requestApi(`${HOST}/v3/type/top_type`, "POST", { "": "" }),
      requestApi(`${HOST}/v3/type/tj_vod`, "POST", { "": "" }),
    ]);

    const { classes, filters } = buildClassesAndFilters(typeData?.data?.list || []);
    const allVideos = [...(homeVodData?.data?.cai || []), ...(homeVodData?.data?.loop || [])];
    const list = formatVideoList(allVideos.filter((i) => i.vod_id && String(i.vod_id) !== "0"));

    const result = { class: classes, filters, list };
    await writeHomeCache(result);
    return result;
  } catch (error) {
    logError("获取首页数据失败", error);
    return { class: [], filters: {}, list: [] };
  }
}

/**
 * 获取分类数据
 * @param {Object} params 参数对象
 * @returns {Promise<{list:Array,page:number,pagecount:number,limit:number,total:number}>}
 */
async function category(params) {
  try {
    const categoryId = params.categoryId;
    const page = parseInt(params.page, 10) || 1;
    const ext = params.filters || {};

    if (!categoryId) {
      return { list: [], page: 1, pagecount: 0, limit: 0, total: 0 };
    }

    const requestParams = {
      type_id: categoryId,
      limit: "12",
      page,
    };

    for (const [k, v] of Object.entries(ext)) {
      const key = k === "extend" ? "class" : k;
      requestParams[key] = v;
    }

    const data = await requestApi(`${HOST}/v3/home/type_search`, "POST", requestParams);
    const list = formatVideoList((data?.data?.list || []).filter((i) => i.vod_id && String(i.vod_id) !== "0"));

    // 【v1.0.5】原先写死 pagecount: 9999 / total: 999999，客户端会一直翻页无限打站点
    // （实际每页只有12 条、总共也就几页）。改成按实际返回条数推算：不满一页即到底。
    const PAGE_SIZE = 12;
    const hasMore = list.length >= PAGE_SIZE;
    const apiTotal = Number(data?.data?.total ?? data?.data?.count ?? 0);

    return {
      list,
      page,
      pagecount: hasMore ? page + 1 : page,
      limit: PAGE_SIZE,
      total: apiTotal > 0 ? apiTotal : list.length,
    };
  } catch (error) {
    logError("获取分类数据失败", error);
    return { list: [], page: 1, pagecount: 0, limit: 0, total: 0 };
  }
}

/**
 * 获取视频详情
 * @param {Object} params 参数对象
 * @returns {Promise<{list:Array}>}
 */
async function detail(params) {
  try {
    const ids = Array.isArray(params.videoId) ? params.videoId : [params.videoId];
    const result = [];

    for (const vodId of ids) {
      if (!vodId) continue;

      const videoIdForScrape = String(vodId || "");
      const data = await requestApi(`${HOST}/v3/home/vod_details`, "POST", { vod_id: vodId });
      const v = data?.data;
      if (!v) continue;

      const playSources = convertVodPlayListToSources(v.vod_play_list || [], v.vod_name || "", videoIdForScrape);

      let scrapeData = null;
      let videoMappings = [];
      let scrapeType = "";

      const scrapeCandidates = [];
      for (const source of playSources) {
        for (const ep of source.episodes || []) {
          if (!ep._fid) continue;
          scrapeCandidates.push({
            fid: ep._fid,
            file_id: ep._fid,
            file_name: ep._rawName || ep.name || "正片",
            name: ep._rawName || ep.name || "正片",
            format_type: "video",
          });
        }
      }

      if (scrapeCandidates.length > 0) {
        try {
          const scrapingResult = await OmniBox.processScraping(videoIdForScrape, v.vod_name || "", v.vod_name || "", scrapeCandidates);
          OmniBox.log("info", `[热播] 刮削处理完成,结果: ${JSON.stringify(scrapingResult || {}).substring(0, 200)}`);

          const metadata = await OmniBox.getScrapeMetadata(videoIdForScrape);
          scrapeData = metadata?.scrapeData || null;
          videoMappings = metadata?.videoMappings || [];
          scrapeType = metadata?.scrapeType || "";
          logInfo("刮削元数据读取完成", { mappingCount: videoMappings.length, hasScrapeData: !!scrapeData, scrapeType });
        } catch (error) {
          logError("刮削处理失败", error);
        }
      }

      if (videoMappings.length > 0) {
        for (const source of playSources) {
          for (const ep of source.episodes || []) {
            const mapping = videoMappings.find((m) => m?.fileId === ep._fid);
            if (!mapping) continue;
            const oldName = ep.name;
            const newName = buildScrapedEpisodeName(scrapeData, mapping, oldName);
            if (newName && newName !== oldName) {
              ep.name = newName;
              OmniBox.log("info", `[热播] 应用刮削后源文件名: ${oldName} -> ${newName}`);
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
      }

      // 落盘「集序号 → 各线路 playId」清单（此时 episodes 上还挂着 _fid，排序后下标已不可靠）
      await saveMultiLineMap(videoIdForScrape, playSources);

      const normalizedPlaySources = playSources.map((source) => ({
        name: source.name,
        episodes: (source.episodes || []).map((ep) => ({
          name: ep.name,
          playId: ep.playId,
        })),
      }));

      const vod = {
        vod_id: videoIdForScrape,
        vod_name: scrapeData?.title || v.vod_name || "",
        vod_pic: scrapeData?.posterPath ? `https://image.tmdb.org/t/p/w500${scrapeData.posterPath}` : (v.vod_pic || ""),
        type_name: v.type_name || "",
        vod_year: scrapeData?.releaseDate ? String(scrapeData.releaseDate).substring(0, 4) : (v.vod_year || ""),
        vod_area: v.vod_area || "",
        vod_remarks: v.vod_remarks || "",
        vod_actor: (scrapeData?.credits?.cast || []).slice(0, 5).map((c) => c?.name).filter(Boolean).join(",") || v.vod_actor || "",
        vod_director:
          (scrapeData?.credits?.crew || [])
            .filter((c) => c?.job === "Director" || c?.department === "Directing")
            .slice(0, 3)
            .map((c) => c?.name)
            .filter(Boolean)
            .join(",") ||
          v.vod_director ||
          "",
        vod_content: scrapeData?.overview || v.vod_content || "无",
        vod_play_sources: normalizedPlaySources,
      };

      result.push(vod);
    }

    return { list: result };
  } catch (error) {
    logError("获取详情失败", error);
    return { list: [] };
  }
}

/**
 * 搜索视频
 * @param {Object} params 参数对象
 * @returns {Promise<{list:Array,page:number,pagecount:number,limit:number,total:number}>}
 */
async function search(params) {
  try {
    const keyword = params.keyword || params.wd || "";
    const page = parseInt(params.page, 10) || 1;

    if (!keyword) {
      return { list: [], page: 1, pagecount: 0, limit: 0, total: 0 };
    }

    const data = await requestApi(`${HOST}/v3/home/search`, "POST", {
      limit: "12",
      page,
      keyword,
    });

    const list = formatVideoList((data?.data?.list || []).filter((i) => i.vod_id && String(i.vod_id) !== "0"));

    // 【v1.0.5】同category：不再返回 9999 页，按实际条数推算，不满一页即到底
    const PAGE_SIZE = 12;
    const hasMore = list.length >= PAGE_SIZE;
    const apiTotal = Number(data?.data?.total ?? data?.data?.count ?? 0);

    return {
      list,
      page,
      pagecount: hasMore ? page + 1 : page,
      limit: PAGE_SIZE,
      total: apiTotal > 0 ? apiTotal : list.length,
    };
  } catch (error) {
    logError("搜索失败", error);
    return { list: [], page: 1, pagecount: 0, limit: 0, total: 0 };
  }
}

/**
 * 解析播放地址
 * @param {Object} params 参数对象
 * @returns {Promise<{urls:Array,parse:number,header:Object}>}
 */
async function play(params) {
  const playId = params.playId || "";
  if (!playId) {
    return { urls: [], parse: 1, header: {} };
  }

  try {
    const decoded = d64(playId);
    const ids = JSON.parse(decoded);
    const headers = {};
    let vodName = ids.v || "";
    let episodeName = ids.e || "";
    let scrapedDanmuFileName = "";

    try {
      const videoIdFromParam = params.vodId ? String(params.vodId) : "";
      const videoIdFromMeta = ids.sid ? String(ids.sid) : "";
      const videoIdForScrape = videoIdFromParam || videoIdFromMeta;

      if (videoIdForScrape) {
        const metadata = await OmniBox.getScrapeMetadata(videoIdForScrape);
        if (metadata && metadata.scrapeData) {
          const mapping = (metadata.videoMappings || []).find((m) => m?.fileId === ids.fid);
          scrapedDanmuFileName = buildScrapedDanmuFileName(
            metadata.scrapeData,
            metadata.scrapeType || "",
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
    } catch (error) {
      logInfo(`读取刮削元数据失败: ${error.message}`);
    }

    let playResponse;

    if (ids.r) headers.Referer = ids.r;
    if (ids.u) headers["User-Agent"] = ids.u;

    // 先试多线路：命中 detail 落盘的清单就一次把该集所有线路都返回（当前线路排第一）
    if (MULTI_LINE_ENABLED) {
      try {
        playResponse = await resolveMultiLineResponse(ids, playId);
      } catch (error) {
        logWarn("多线路解析异常，退回单线路", error);
      }
    }

    if (!playResponse && Array.isArray(ids.p) && ids.p.length > 0) {
      const parseUrl = ids.p[0] + encodeURIComponent(ids.url);

      try {
        const response = await axiosInstance({
          url: parseUrl,
          method: "GET",
          headers,
          responseType: "text",
        });

        if (!response?.data) {
          throw new Error("解析请求无响应内容");
        }

        const parseData = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
        const parsedUrl = parseData.url || parseData?.data?.url;

        if (!parsedUrl) {
          throw new Error("解析接口未返回播放地址");
        }

        if (parseData.UA) {
          headers["User-Agent"] = parseData.UA;
        }

        playResponse = {
          urls: [{ name: "播放", url: parsedUrl }],
          parse: 0,
          header: headers,
        };
      } catch (parseError) {
        logError("解析接口调用失败，尝试嗅探", parseError);
        const sniffResult = await sniffRebangPlay(ids.url || parseUrl);
        if (sniffResult) {
          playResponse = sniffResult;
        } else {
          playResponse = {
            urls: [{ name: "解析", url: parseUrl }],
            parse: 1,
            header: headers,
          };
        }
      }
    } else if (!playResponse) {
      if (ids.url && ids.url.startsWith("http")) {
        playResponse = {
          urls: [{ name: "直连", url: ids.url }],
          parse: 0,
          header: headers,
        };
      } else {
        const sniffResult = await sniffRebangPlay(ids.url);
        playResponse =
          sniffResult ||
          {
            urls: [{ name: "直连", url: ids.url }],
            parse: 0,
            header: headers,
          };
      }
    }

    if (DANMU_API && vodName) {
      const fileName = scrapedDanmuFileName || buildFileNameForDanmu(vodName, episodeName);
      if (fileName) {
        const danmakuList = await matchDanmu(fileName);
        if (danmakuList.length > 0) {
          playResponse.danmaku = danmakuList;
        }
      }
    }

    return playResponse;
  } catch (error) {
    logError("播放解析失败", error);
    const fallbackSniff = await sniffRebangPlay(playId);
    if (fallbackSniff) {
      return fallbackSniff;
    }
    return {
      urls: [{ name: "回退", url: playId }],
      parse: 1,
      header: {},
    };
  }
}

// ==================== 模块导出 ====================
module.exports = {
  home,
  category,
  search,
  detail,
  play,
};

// 使用公共 runner 处理标准输入/输出
const runner = require("spider_runner");
runner.run(module.exports);

