// @name 荐片APP
// @author 
// @description 刮削：支持，弹幕：支持，嗅探：支持
// @version 1.0.12
// @downloadURL https://gh-proxy.org/https://github.com/xiaohu1949/OmniBox-Spider/raw/refs/heads/main/影视/采集/荐片.js
/**
 * ============================================================================
 * 荐片APP - OmniBox 爬虫脚本
 * ============================================================================
 *
 * 功能说明:
 * - 提供荐片视频APP源的 OmniBox 格式接口
 * - 支持分类浏览、搜索、详情、播放等功能
 * - 集成 Netflix 分类(放在分类列表最后)
 * - 自动屏蔽 FTP/边下边播线路,保留其他线路
 * - 搜索过滤功能,精准匹配搜索结果
 *
 * 主要特性:
 * 1. 分类支持:电影、电视剧、动漫、综艺、短剧、纪录片、Netflix
 * 2. 筛选功能:支持类型、地区、年份、排序等筛选条件
 * 3. 线路过滤:自动过滤包含"FTP"、"边下边播"、"VIP"关键字的线路
 * 4. 图片域名:自动处理图片 URL,支持多域名
 * 5. 搜索过滤:精准匹配结果,删除多余无关条目
 *
 * 日期:2025.02.27
 * ============================================================================
 */

const OmniBox = require("omnibox_sdk");
const https = require("https");

/**
 * 【v1.0.12】图片总开关：默认关闭（用户要求：不要图片，保证流畅）
 * 荐片三个图床域名整体 DNS 剧烈抖动（dnsjp.cc 服务大面积 SERVFAIL，实测 80% 失败），
 * 封面时好时坏且拖慢列表；设环境变量 JP_IMAGES=1 可恢复封面。
 */
const JP_NO_IMAGES = process.env.JP_IMAGES !== "1";

/**
 * 配置信息
 */
const jpConfig = {
  // 主 API 域名
  host: "https://h5.jianpianips1.com",
  // 图片域名【v1.0.8 起不再使用此固定值】
  // 站点已下线该域名，改为由 /api/v2/settings/resourceDomainConfig 动态下发，
  // 见下方 IMG_HOST_FALLBACK / ensureImgHost()。此处仅作历史说明保留。
  imgHost: "https://img.ypfbj.com",
  // 请求头
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Origin': 'https://h5.jianpianips1.com',
    'Referer': 'https://h5.jianpianips1.com/'
  },
  // 超时时间(毫秒)
  timeout: 10000
};

// 播放请求头
const PLAY_HEADERS = {
  'User-Agent': jpConfig.headers['User-Agent'],
  'Referer': jpConfig.host,
  'Origin': jpConfig.host
};

// 弹幕API配置（预留占位，**当前未接入** —— 全文无调用点，
// 也没有任何 danmaku 字段输出。头部注解里的「弹幕：支持」对本源不成立，以本注释为准）
const DANMU_API = process.env.DANMU_API || "";

/**
 * 分类映射表
 */
const categoryMap = {
  '1': '电影',
  '2': '电视剧',
  '3': '动漫',
  '4': '综艺',
  '67': '短剧',
  '50': '纪录片',
  'netflix': 'Netflix'
};

/**
 * 日志工具函数
 */
const logInfo = (message, data = null) => {
  if (data) {
    OmniBox.log("info", `[荐片APP] ${message}: ${JSON.stringify(data)}`);
  } else {
    OmniBox.log("info", `[荐片APP] ${message}`);
  }
};

const logError = (message, error) => {
  OmniBox.log("error", `[荐片APP] ${message}: ${error.message || error}`);
};

const logWarn = (message) => {
  OmniBox.log("warn", `[荐片APP] ${message}`);
};

/**
 * 元数据编解码，用于透传刮削/弹幕信息
 */
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

/* ============================================================================
 * 多线路解析（v1.0.6 新增）
 *
 * 荐片详情接口 /api/video/detailv2 一次就返回 source_list_source（实测 7 组：
 * VIP线路 / 极速蓝光 / 高速蓝光 / 高清线路1 / 高清线路2 / WJ线路 / RY线路），
 * 每组里的 url 已经是 CDN 真实 m3u8 —— 也就是**天然多线路**，不需要嗅探。
 * 但 handlePlay() 过去只把「用户点中的那一条」返回，该条 CDN 挂了这一集就放不了。
 * 所以：detail 阶段把「集序号 → 各线路直链」落盘，play 阶段一次全部列出。
 * 客户端每次调用都是新进程，状态必须落盘（OmniBox.setCache）。
 * ========================================================================== */
/**
 * 【v1.0.7】fid 分隔符从 `#` 换成 `§`：`#` 可能出现在派生的 vodId 里，
 *   `§` 会被 encodeURIComponent 转义成 %C2%A7，片名里几乎不出现，比 `#` 安全。
 *   解析一律「从尾部切」（vodId = 去掉末两段后重新拼回），对纯数字 id 与旧逻辑一致。
 * ⚠️ 前缀同步升到 v2：v1 用「线路内下标」做键，与 v2 的「集号」数值区间重叠，
 *   沿用旧前缀会把「第 3 行」当成「第 3 集」，直接播错集。
 */
const MULTI_LINE_CACHE_PREFIX = "jp:multi:v2";
const MULTI_LINE_TTL_SECONDS = 6 * 3600;
const MEDIA_URL_RE = /\.(m3u8|mp4|flv|ts|mkv|avi)(\?|#|$)/i;
const FID_SEP = "§";

function buildFid(vodId, lineName, epKey) {
  return `${String(vodId == null ? "" : vodId)}${FID_SEP}${lineName}${FID_SEP}${epKey}`;
}

/**
 * 【v1.0.7】集键优先用真实集号，不用线路内下标 ——
 * 荐片各线路（VIP/极速蓝光/高清线路…）集数与顺序并不一致（VIP 30 集、蓝光 60 集很常见），
 * 按下标对齐会把「第 3 集的线路A」和「第 3 集的线路B」错配成不同集，用户点第 3 集拿到第 4 集。
 * 抽不出集号时回退下标并加 `i` 前缀，与真实集号区分开。
 */
function resolveEpKey(epName, epIdx) {
  const n = parseInt(extractEpisode(epName || ""), 10);
  if (Number.isInteger(n) && n > 0) return String(n);
  return `i${epIdx}`;
}

function buildMultiLineCacheKey(videoId) {
  return `${MULTI_LINE_CACHE_PREFIX}:${String(videoId || "")}`;
}

/** 从 vod_play_sources 抽「集序号 → 各线路直链」；fid 形如 <vodId>§<线路名>§<集键> */
function buildMultiLineMap(playSources) {
  const map = {};
  for (const source of playSources || []) {
    const lineName = String(source?.name || "线路");
    for (const ep of source?.episodes || []) {
      const [rawPart, metaPart] = String(ep?.playId || "").split("|||");
      let url = rawPart || "";
      try {
        url = decodeURIComponent(url);
      } catch {
        /* 保持原值 */
      }
      if (!/^https?:\/\//i.test(url) || !MEDIA_URL_RE.test(url)) continue;
      const meta = decodeMeta(metaPart || "");
      const fidParts = String(meta?.fid || "").split(FID_SEP);
      if (fidParts.length < 3) continue;
      const epKey = fidParts[fidParts.length - 1];
      if (!map[epKey]) map[epKey] = [];
      map[epKey].push({ l: lineName, u: url });
    }
  }
  // 同集按地址去重（不同线路名可能指向同一 CDN 地址）
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
    logInfo("多线路清单已落盘", { videoId, 覆盖集数: epKeys.length, 首集线路数: map[epKeys[0]].length });
  } catch (error) {
    logWarn("多线路清单落盘失败: " + (error.message || error));
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
  const fidParts = String(playMeta?.fid || "").split(FID_SEP);
  if (fidParts.length < 3) return null;
  // 【v1.0.7】从尾部切，vodId 自身可能含分隔符
  const vodId = fidParts.slice(0, -2).join(FID_SEP);
  const map = await loadMultiLineMap(vodId);
  const list = map?.[fidParts[fidParts.length - 1]];
  if (!Array.isArray(list) || list.length <= 1) return null;

  const current = list.find((it) => it.u === rawPlayId);
  const ordered = current ? [current, ...list.filter((it) => it !== current)] : list;
  return {
    urls: ordered.map((it) => ({ name: it.l, url: it.u })),
    parse: 0,
  };
}

/**
 * 预处理标题,去掉常见干扰项
 */
function preprocessTitle(title) {
  if (!title) return "";
  return title
    .replace(/4[kK]|[xX]26[45]|720[pP]|1080[pP]|2160[pP]/g, " ")
    .replace(/[hH]\.?26[45]/g, " ")
    .replace(/BluRay|WEB-DL|HDR|REMUX/gi, " ")
    .replace(/\.mp4|\.mkv|\.avi|\.flv/gi, " ");
}

/**
 * 将中文数字转换为阿拉伯数字
 */
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

/**
 * 从标题中提取集数数字
 */
function extractEpisode(title) {
  if (!title) return "";

  const processedTitle = preprocessTitle(title).trim();

  // 1. 中文格式:第XX集/话
  const cnMatch = processedTitle.match(/第\s*([零一二三四五六七八九十0-9]+)\s*[集话章节回期]/);
  if (cnMatch) return String(chineseToArabic(cnMatch[1]));

  // 2. S01E03 格式
  const seMatch = processedTitle.match(/[Ss](?:\d{1,2})?[-._\s]*[Ee](\d{1,3})/i);
  if (seMatch) return seMatch[1];

  // 3. EP/E 格式
  const epMatch = processedTitle.match(/\b(?:EP|E)[-._\s]*(\d{1,3})\b/i);
  if (epMatch) return epMatch[1];

  // 4. 括号格式 [03]
  const bracketMatch = processedTitle.match(/[\[\(【(](\d{1,3})[\]\)】)]/);
  if (bracketMatch) {
    const num = bracketMatch[1];
    if (!["720", "1080", "480"].includes(num)) return num;
  }

  return "";
}

/**
 * 构建用于弹幕匹配的文件名(后续扩展)
 */
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
      } else {
        return `${vodName} S01E${epNum}`;
      }
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

/**
 * 发送HTTP请求
 * @param {string} url - 请求URL
 * @param {Object} options - 请求选项
 * @returns {Promise<Object>} 响应数据
 */
async function request(url, options = {}) {
  try {
    const response = await OmniBox.request(url, {
      method: options.method || "GET",
      headers: options.headers || jpConfig.headers,
      timeout: options.timeout || jpConfig.timeout,
      body: options.body
    });

    if (response.statusCode !== 200) {
      throw new Error(`HTTP ${response.statusCode}: ${response.body}`);
    }

    return JSON.parse(response.body);
  } catch (error) {
    logError(`请求失败: ${url}`, error);
    throw error;
  }
}

/* ============================================================================
 * 【v1.0.8】图片域名：改为**动态下发**
 * 【v1.0.10】图片域名：动态下发 + **并发探活选优**
 * ----------------------------------------------------------------------------
 * 站点已下线写死的 img.jgsfnl.com，改由接口下发一组可用域名：
 *   GET /api/v2/settings/resourceDomainConfig → { data: { imgDomain: "a,b,c" } }
 * 实测（2026-10-15，容器内）：下发 [img.ypfbj.com, img.cqkgy.com, img.bptpw.com]，
 * 其中首个 img.ypfbj.com 最慢最不稳（样本图 3 次 2 次 12s 超时、偶发 ECONNRESET），
 * img.bptpw.com 反而全部 200 且最快（~360ms）。**只取首个会固定选到最差的域名，
 * 表现为「图片打不开 + 加载很慢」**。故改为：
 *   1) 落盘健康域名（跨进程，优先用上次验证过的最快域名）——冷启动不乱选坏域名；
 *   2) 接口取下发列表；
 *   3) 对每个域名**并发探活**一张真实样图，选最快且成功者（只对网络层失败降级，
 *      404 也算域名可达，避免路径问题误杀）；
 *   4) 全失败 → 静态兜底（按实测稳定性排序，bptpw 排首）。
 * 任何一步失败都只降级不抛错，保证「接口挂了也还有图」。
 * ========================================================================== */
const IMG_HOST_OK_KEY = "jp:imgdomain:ok:v2";   // 探活验证过、最快可用的域名（落盘，跨进程）
const IMG_HOST_OK_TTL = 6 * 3600;               // 图床整体抖动剧烈，6h 即可，故障能较快恢复重探
const IMG_HOST_API = "/api/v2/settings/resourceDomainConfig";
// 静态兜底：按 2026-10-15 实测稳定性排序（bptpw 最稳、ypfbj 偶发 12s 超时排末）
const IMG_HOST_FALLBACK = ["img.bptpw.com", "img.cqkgy.com", "img.ypfbj.com"];

let imgHost = `https://${IMG_HOST_FALLBACK[0]}`;
let imgHostPromise = null;

/** 把各种形态的域名归一成 `https://host` */
const normalizeImgHost = (raw) => {
  if (!raw || typeof raw !== 'string') return '';
  let s = String(raw).split(',')[0].trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  return s.replace(/\/+$/, '');
};

/** 取一张真实图片路径用于探活（轻量，仅冷启动健康缓存未命中时调用一次） */
async function pickSamplePicPath() {
  try {
    const res = await request(`${jpConfig.host}/api/dyTag/hand_data?category_id=88`);
    const arr = (res && (res.data && res.data.list)) || (res && res.list) || [];
    for (const it of (Array.isArray(arr) ? arr : [])) {
      const p = it && (it.path || it.tvimg || it.tagimg);
      if (p) return p.startsWith('/') ? p : '/' + p;
    }
  } catch (_) { /* 忽略，退化到 favicon */ }
  return null;
}

/**
 * 探活单个域名：用 Node 原生 https 发请求，只看状态码、不下载 body（不依赖
 * OmniBox.request，它对图片二进制响应无可靠超时会挂死）。只看网络层可达 +
 * 2xx/3xx；404 也说明域名在（路径问题不算域名坏）。无样本路径时用根「/」
 * （比 favicon 更能反映域名本身是否可达）。返回 { ok, ms, net? }
 */
function probeImgHost(domain, samplePath) {
  return new Promise((resolve) => {
    const url = `https://${domain}${samplePath || '/'}`;
    const t = Date.now();
    const req = https.get(
      url,
      { headers: jpConfig.headers, timeout: 6000, rejectUnauthorized: false },
      (res) => {
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        res.resume(); // 丢弃 body，避免缓冲挂起
        resolve({ ok, ms: Date.now() - t });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: Date.now() - t, net: true }); });
    req.on('error', () => { resolve({ ok: false, ms: Date.now() - t, net: true }); });
  });
}

/** 解析图片域名（幂等：同一进程只真正跑一次；跨进程靠落盘健康缓存） */
async function ensureImgHost() {
  if (imgHostPromise) return imgHostPromise;
  imgHostPromise = (async () => {
    // 1) 落盘健康域名（跨进程，优先用上次验证过的最快域名，绝不沿用上次切换到的坏域名）
    try {
      const cached = await OmniBox.getCache(IMG_HOST_OK_KEY);
      const h = normalizeImgHost(cached);
      if (h) {
        imgHost = h;
        logInfo('图片域名命中健康缓存', { imgHost });
        return imgHost;
      }
    } catch (_) { /* ignore */ }

    // 2) 接口下发域名列表
    let domains = [];
    try {
      const res = await request(`${jpConfig.host}${IMG_HOST_API}`);
      const raw = (res && res.data && res.data.imgDomain) || '';
      domains = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    } catch (e) {
      logWarn(`图片域名接口失败，改用兜底: ${e.message || e}`);
    }
    if (!domains.length) domains = IMG_HOST_FALLBACK.slice();

    // 3) 并发探活选优（取最快成功者；只对网络层失败降级，404 也算可达）
    const samplePath = await pickSamplePicPath();
    const probes = await Promise.all(
      domains.map(async (d) => ({ d, r: await probeImgHost(d, samplePath) }))
    );
    probes.sort((a, b) => (a.r.ok ? a.r.ms : 1e9) - (b.r.ok ? b.r.ms : 1e9));
    const best = probes.find((p) => p.r.ok);
    if (best) {
      imgHost = `https://${best.d}`;
      logInfo('图片域名探活选优', {
        imgHost,
        ms: best.r.ms,
        all: probes.map((p) => `${p.d}:${p.r.ok ? p.r.ms + 'ms' : 'FAIL'}`).join(','),
      });
      try { await OmniBox.setCache(IMG_HOST_OK_KEY, imgHost, IMG_HOST_OK_TTL); } catch (_) {}
      return imgHost;
    }

    // 4) 全失败 → 静态兜底（按稳定性排序）。兜底也写入健康缓存，但 TTL 较短，
    //    让图床整体抖动恢复后能较快重新探活（避免 24h 内一直用可能挂的域名）。
    logWarn('所有图片域名探活失败，用静态兜底');
    imgHost = `https://${IMG_HOST_FALLBACK[0]}`;
    try { await OmniBox.setCache(IMG_HOST_OK_KEY, imgHost, 3600); } catch (_) {}
    return imgHost;
  })();
  return imgHostPromise;
}

/**
 * 获取完整图片 URL
 * @param {string} path - 图片路径
 * @returns {string} 完整图片 URL
 */
const getPicUrl = (path) => {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const normalizedPath = path.startsWith('/') ? path : '/' + path;
  // 【v1.0.8】域名由 ensureImgHost() 动态解析（各公开入口已先 await）
  return `${imgHost}${normalizedPath}`;
};

/**
 * 格式化视频列表数据
 * @param {Array} data - 原始数据
 * @returns {Array} 格式化后的列表
 */
const formatList = (data) => {
  //【v1.0.7】部分接口返回的是 {list:[...]} / {data:[...]} 包装而非裸数组，
  // 原先直接判非数组就返回空 ⇒ 表现为「搜不到」。这里做一层兼容。
  if (data && !Array.isArray(data) && typeof data === 'object') {
    const inner = data.list || data.data || data.items;
    if (Array.isArray(inner)) data = inner;
  }
  if (!Array.isArray(data)) {
    logWarn('formatList 接收到的数据不是数组: ' + typeof data);
    return [];
  }

  return data.filter(i => i.id && String(i.id) !== '0').map(i => {
    const picPath = i.path || i.tvimg || i.tagimg || '';
    return {
      vod_id: String(i.id),
      vod_name: i.title || '未知标题',
      vod_pic: JP_NO_IMAGES ? '' : getPicUrl(picPath),
      vod_remarks: i.mask || (i.score ? `评分:${i.score}` : '')
    };
  });
};

/* ============================================================================
 * Netflix 相关功能
 * ============================================================================ */

/**
 * Netflix API 地址映射表
 */
const netflixApiMap = {
  hot_movie: 'https://api.zxfmj.com/api/dyTag/tpl1_data?id=70&page=',
  hot_tv: 'https://api.zxfmj.com/api/dyTag/tpl1_data?id=73&page=',
  hot_love: 'https://api.zxfmj.com/api/dyTag/tpl2_data?id=74&page=',
  hot_thriller: 'https://api.zxfmj.com/api/dyTag/tpl2_data?id=76&page=',
  hot_action: 'https://api.zxfmj.com/api/dyTag/tpl1_data?id=71&page=',
  top_movie: 'https://api.zxfmj.com/api/dyTag/tpl1_data?id=72&page=',
  classic_movie: 'https://api.zxfmj.com/api/special/detail?id=134',
  classic_tv: 'https://api.zxfmj.com/api/special/detail?id=131'
};

/**
 * 获取 Netflix 分类列表
 * @param {string} subType - 子分类类型
 * @param {number} page - 页码
 * @returns {Object} 列表数据
 */
const getNetflixList = async (subType, page = 1) => {
  try {
    logInfo('获取Netflix列表', { subType, page });

    const url = netflixApiMap[subType];
    if (!url) {
      logWarn(`未知的Netflix子类型: ${subType}`);
      return { list: [], page, pagecount: 1, total: 0 };
    }

    let fullUrl = url + page;
    // 经典分类不需要分页参数
    if (subType.startsWith('classic')) fullUrl = url;

    const res = await request(fullUrl);

    let data = res.data || [];
    if (!Array.isArray(data) && data.list) data = data.list;

    const list = data.map(item => ({
      vod_id: (item.id || item._id?.$oid)?.toString() + '@netflix',
      vod_name: item.title,
      vod_pic: JP_NO_IMAGES ? '' : getPicUrl(item.tvimg || item.path),
      vod_remarks: (item.mask || '') + (item.score ? ` ⭐${item.score}` : '')
    }));

    logInfo('Netflix列表获取成功', { count: list.length });

    return {
      list,
      page: parseInt(page),
      pagecount: list.length ? parseInt(page) + 1 : parseInt(page),
      limit: list.length,
      total: list.length ? 9999 : 0
    };
  } catch (e) {
    logError('Netflix列表获取失败', e);
    return { list: [], page: parseInt(page), pagecount: 1, limit: 0, total: 0 };
  }
};

/* ============================================================================
 * 首页和分类功能
 * ============================================================================ */

/**
 * 获取首页内容和分类
 * @returns {Object} 分类和筛选数据
 */
const getHomeContent = async () => {
  try {
    logInfo('========== 开始获取首页分类 ==========');

    const res = await request(`${jpConfig.host}/api/v2/settings/homeCategory`);

    if (res.code !== 1) {
      throw new Error(res.msg || '获取分类失败');
    }

    OmniBox.log('info', `[荐片APP] 分类数据: ${JSON.stringify({
      code: res.code,
      dataLength: res.data?.length
    })}`);

    const classes = [];
    const filters = {};

    // 【v1.0.7】原先在循环里逐个 await 拉筛选选项（每个分类最坏 10s 超时），
    // 5~6 个分类串行 ⇒ 首页最坏 60s，用户表现为「首页一直转圈」。
    // 改为：先把所有分类的筛选**并发**拉回来，再顺序解析。
    const normalCategories = res.data
      .filter((item) => item.id !== 88 && item.id !== 99)
      .map((item) => ({ tid: String(item.id), tName: categoryMap[String(item.id)] || item.name }));

    for (const cat of normalCategories) {
      classes.push({ type_id: cat.tid, type_name: cat.tName });
    }

    // 并发预取各分类筛选（单个失败不影响其它，也不阻塞首页）
    const filterResults = await Promise.allSettled(
      normalCategories.map((cat) => request(`${jpConfig.host}/api/crumb/filterOptions?fcate_pid=${cat.tid}`))
    );
    filterResults.forEach((r, idx) => {
      const cat = normalCategories[idx];
      // 获取该分类的筛选选项
      try {
        OmniBox.log('info', `\n[荐片APP] ===== 获取分类[${cat.tName}(${cat.tid})]筛选选项 =====`);

        if (r.status !== 'fulfilled') {
          throw new Error(r.reason?.message || '筛选请求失败');
        }
        const filterRes = r.value;

        OmniBox.log('info', `[荐片APP] 响应code: ${filterRes.code}, hasData: ${!!filterRes.data}`);

        if (filterRes.code === 1 && filterRes.data && Array.isArray(filterRes.data)) {
          OmniBox.log('info', `[荐片APP] 筛选数据keys: ${JSON.stringify(filterRes.data.map(f => f.key))}`);

          const fts = [];
          const filterData = filterRes.data;

          // 类型筛选
          const typeFilter = filterData.find(f => f.key === 'type');
          if (typeFilter && typeFilter.data && Array.isArray(typeFilter.data)) {
            const options = typeFilter.data
              .map(t => ({ name: t.name, value: String(t.id) }))  // 改为 name/value
              .filter(t => t.name !== '全部');
            options.unshift({ name: '全部', value: '' });
            fts.push({
              name: '类型',
              key: 'type',
              init: '',  // 添加默认值
              value: options
            });
          }

          // 地区筛选
          const areaFilter = filterData.find(f => f.key === 'area');
          if (areaFilter && areaFilter.data && Array.isArray(areaFilter.data)) {
            const options = areaFilter.data
              .map(a => ({ name: a.name, value: String(a.id) }))  // 改为 name/value
              .filter(a => a.name !== '全部');
            options.unshift({ name: '全部', value: '' });
            fts.push({
              name: '地区',
              key: 'area',
              init: '',  // 添加默认值
              value: options
            });
          }

          // 年份筛选
          const yearFilter = filterData.find(f => f.key === 'year');
          if (yearFilter && yearFilter.data && Array.isArray(yearFilter.data)) {
            const options = yearFilter.data
              .map(y => ({ name: y.name, value: String(y.id) }))  // 改为 name/value
              .filter(y => y.name !== '全部');
            options.unshift({ name: '全部', value: '' });
            fts.push({
              name: '年份',
              key: 'year',
              init: '',  // 添加默认值
              value: options
            });
          }

          // 排序筛选
          const sortFilter = filterData.find(f => f.key === 'sort');
          if (sortFilter && sortFilter.data && Array.isArray(sortFilter.data)) {
            const options = sortFilter.data
              .map(s => ({ name: s.name, value: String(s.id) }))  // 改为 name/value
              .filter(s => s.name !== '全部');
            options.unshift({ name: '默认', value: '' });
            fts.push({
              name: '排序',
              key: 'sort',
              init: '',  // 添加默认值
              value: options
            });
          }

          if (fts.length > 0) {
            filters[cat.tid] = fts;
            OmniBox.log('info', `[荐片APP] ✅ 分类[${cat.tName}]筛选项已添加: ${fts.length}个`);
          }
        }
      } catch (e) {
        OmniBox.log('error', `[荐片APP] ❌ 获取分类[${cat.tName}]筛选失败: ${e.message}`);
      }
    });

    // Netflix 分类
    classes.push({ type_id: 'netflix', type_name: 'Netflix' });
    filters['netflix'] = [{
      key: "cateId",
      name: "Netflix分类",
      value: [
        { n: "热播电影", v: "hot_movie" },
        { n: "热播电视剧", v: "hot_tv" },
        { n: "热播爱情片", v: "hot_love" },
        { n: "热播惊悚片", v: "hot_thriller" },
        { n: "热播动作片", v: "hot_action" },
        { n: "高分电影", v: "top_movie" },
        { n: "经典电影", v: "classic_movie" },
        { n: "经典电视剧", v: "classic_tv" }
      ]
    }];

    OmniBox.log('info', `[荐片APP] ========== 首页获取完成 ==========`);
    OmniBox.log('info', `[荐片APP] 分类数: ${classes.length}, 筛选项数: ${Object.keys(filters).length}`);

    return { class: classes, filters: filters };
  } catch (e) {
    OmniBox.log('error', `[荐片APP] ❌ 获取首页失败: ${e.message}`);
    return { class: [], filters: {} };
  }
};

/**
 * 【v1.0.7】原先本文件里home() 定义了两次（这里一份、文件尾部一份），
 * 后者覆盖前者 ⇒ 前面这 20 行是死代码。已删除，只保留尾部那一份。
 */


/**
 * 【v1.0.7】取出筛选条件的实际值。
 * `extend.type` 等字段在 home 里定义的是**选项数组**（`value: options`），
 * 直接 `params.append('category_id', extend.type)` 会把数组 toString 成 `[object Object]`
 * 发给接口（且同一字段被 append 两次）。这里兼容三种形态：
 *   - 字符串/数字 → 原值
 *   - {value}对象 → 取 .value
 *   - 数组 → 取匹配 name 的那项.value，都不匹配则取 init/首项/空串
 */
const pickFilterValue = (raw) => {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  if (Array.isArray(raw)) {
    if (raw.length === 0) return '';
    const first = raw[0];
    if (first && typeof first === 'object') {
      // 带选中标记的优先（部分客户端回传 {name, value, selected}）
      const picked = raw.find((o) => o && (o.selected === true || o.checked === true));
      const target = picked || first;
      return String(target?.value ?? '');
    }
    return String(first);
  }
  if (typeof raw === 'object') {
    if (raw.value !== undefined) return String(raw.value);
    if (raw.id !== undefined) return String(raw.id);
    return '';
  }
  return String(raw);
};

/**
 * 获取分类视频列表
 * @param {string} tid - 分类 ID
 * @param {number} pg - 页码
 * @param {Object} extend - 扩展筛选参数
 * @returns {Object} 视频列表
 */
const getCategoryList = async (tid, pg = 1, extend = {}) => {
  try {
    logInfo('获取分类列表', { tid, pg, extend });

    const params = new URLSearchParams();
    params.append('fcate_pid', tid);
    params.append('page', pg);
    // 【v1.0.8】★ 修复「分类标签下什么都没有」★
    // `type` 是服务端**强依赖**参数：缺失时 PHP 直接抛「未定义数组索引: type」并返回整页
    // 异常 HTML ⇒ 列表恒为空。v1.0.7 误判它是重复参数而删掉，本版补回。
    // 同时纠正维度：`type` 才是「类型」筛选（与 filterOptions 的 type 选项 id 一致：
    // 剧情=1、爱情=2、动画=3…，实测 type=1 返回的片子 types 含「剧情」）；
    // `category_id` 是另一个维度（服务端不传时默认 1），不是类型，故不再传。
    params.append('type', pickFilterValue(extend.type));
    params.append('area', pickFilterValue(extend.area));
    params.append('year', pickFilterValue(extend.year));
    params.append('sort', pickFilterValue(extend.sort));

    const res = await request(`${jpConfig.host}/api/crumb/list?${params.toString()}`);

    if (res.code !== 1) {
      throw new Error(res.msg || '获取列表失败');
    }

    const list = formatList(res.data);
    const hasMore = list.length >= 15;

    if (list.length > 0) {
      logInfo('列表首条数据图片', {
        name: list[0].vod_name,
        pic: list[0].vod_pic.substring(0, 80) + '...'
      });
    }

    logInfo('分类列表获取成功', { count: list.length, page: pg });

    return {
      list: list,
      page: parseInt(pg),
      pagecount: hasMore ? parseInt(pg) + 1 : parseInt(pg),
      limit: 15
    };
  } catch (e) {
    logError('获取分类列表失败', e);
    return { list: [], page: pg, pagecount: pg, limit: 15 };
  }
};

/**
 * 获取首页推荐视频
 * @returns {Array} 推荐视频列表
 */
const getRecommendList = async () => {
  try {
    logInfo('正在获取首页推荐');

    const res = await request(`${jpConfig.host}/api/dyTag/hand_data?category_id=88`);

    if (res.code !== 1 || !res.data) {
      logWarn('获取推荐数据失败或为空');
      return [];
    }

    let list = [];
    for (const key in res.data) {
      if (Array.isArray(res.data[key])) {
        list = list.concat(res.data[key]);
      }
    }

    const formatted = formatList(list);

    // 首页裁到 60 条：hand_data 返回 327 条，327 张图床封面（小站自建、单张 200ms~2s）
    // 是「加载慢」的主因；60 条覆盖首屏+滚动两屏，其余走分类按需加载
    const trimmed = formatted.slice(0, 60);

    if (trimmed.length > 0) {
      logInfo('推荐首条数据图片', {
        name: trimmed[0].vod_name,
        pic: trimmed[0].vod_pic.substring(0, 80) + '...'
      });
    }

    logInfo('首页推荐获取成功', { count: trimmed.length, raw: formatted.length });
    return trimmed;
  } catch (e) {
    logError('获取首页推荐失败', e);
    return [];
  }
};

/**
 * 搜索视频
 * @param {string} wd - 搜索关键词
 * @param {number} pg - 页码
 * @returns {Object} 搜索结果
 */
const searchVod = async (wd, pg = 1) => {
  try {
    logInfo('执行搜索', { keyword: wd, page: pg });

    const params = new URLSearchParams();
    params.append('keyword', wd);
    params.append('page', pg);

    const res = await request(`${jpConfig.host}/api/v2/search/videoV2?key=${params.toString()}`);

    if (res.code !== 1) {
      logWarn('搜索接口返回错误: ' + res.msg);
      return { list: [], page: pg, pagecount: pg };
    }

    // 原始格式化
    let list = formatList(res.data);

    // =========================
    // 🔍 搜索词二次过滤(核心)
    // =========================
    const keyword = String(wd).trim().toLowerCase();

    list = list.filter(item => {
      const name = (item.vod_name || item.name || item.title || '').toLowerCase();
      return name.includes(keyword);
    });

    const hasMore = list.length >= 15;

    logInfo('搜索完成(已过滤)', {
      keyword: wd,
      count: list.length
    });

    return {
      list,
      page: parseInt(pg),
      pagecount: hasMore ? parseInt(pg) + 1 : parseInt(pg)
    };
  } catch (e) {
    logError('搜索失败', e);
    return { list: [], page: pg, pagecount: pg };
  }
};

/* ============================================================================
 * 详情和播放功能
 * ============================================================================ */

/**
 * 检查线路是否需要屏蔽
 * 屏蔽包含 VIP、FTP、常规 关键字的线路
 * @param {string} sourceName - 线路名称
 * @returns {boolean} 是否屏蔽
 */
const shouldBlockSource = (sourceName) => {
  if (!sourceName) return false;
  const name = sourceName.toLowerCase();
  return name.includes('vip') ||
    name.includes('ftp') ||
    name === '常规线路' ||
    name === '常规';
};

/**
 * 将旧格式的播放源转换为新格式(vod_play_sources)
 * @param {Array} sourceListSource - 原始播放源列表
 * @param {string} vodId - 视频ID
 * @returns {Array} 新格式的播放源列表
 */
function convertToPlaySources(sourceListSource, vodId, vodName = "") {
  const playSources = [];

  if (!sourceListSource || !Array.isArray(sourceListSource)) {
    return playSources;
  }

  for (const source of sourceListSource) {
    // 跳过需要屏蔽的线路
    if (shouldBlockSource(source.name)) {
      logInfo(`屏蔽线路: ${source.name}`);
      continue;
    }

    if (source.source_list && source.source_list.length > 0) {
      const episodes = source.source_list.map((item, index) => {
        const episodeName = item.source_name || `第${index + 1}集`;
        // 【v1.0.7】集键用真实集号，不用线路内下标 —— 各线路集数不一致时按下标对齐会播错集。
        // 【v1.0.7】url 缺失时直接跳过：否则 encodeURIComponent("") 得到空串，
        // 会产出一个 url 为空的死条目，客户端点了必然播放失败。
        if (!item.url) return null;
        const fid = buildFid(vodId, source.name || "线路", resolveEpKey(episodeName, index));
        const safeUrl = encodeURIComponent(item.url || "");
        const playId = `${safeUrl}|||${encodeMeta({ sid: vodId, fid, v: vodName || "", e: episodeName })}`;
        return {
          name: episodeName,
          playId,
          _fid: fid,
          _rawName: episodeName,
        };
      }).filter(Boolean);

      playSources.push({
        name: source.name,
        episodes: episodes
      });
    }
  }

  return playSources;
}

/**
 * 嗅探播放页，兜底提取真实视频地址
 */
const sniffJianpianPlay = async (playUrl) => {
  if (!playUrl) return null;
  try {
    logInfo("尝试嗅探播放页", playUrl);
    const sniffed = await OmniBox.sniffVideo(playUrl);
    if (sniffed && sniffed.url) {
      logInfo("嗅探成功", sniffed.url);
      return {
        urls: [{ name: "嗅探线路", url: sniffed.url }],
        parse: 0,
        header: sniffed.header || { ...PLAY_HEADERS, "Referer": playUrl }
      };
    }
  } catch (error) {
    logInfo(`嗅探失败: ${error.message}`);
  }
  return null;
};

/**
 * 获取视频详情
 * @param {string} ids - 视频 ID(可能包含 @netflix 后缀)
 * @returns {Object} 详情数据
 */
const getDetail = async (ids) => {
  try {
    logInfo('获取详情', { id: ids });

    // 处理 Netflix 类型的详情(移除 @netflix 后缀)
    const realId = ids.replace('@netflix', '');

    const res = await request(`${jpConfig.host}/api/video/detailv2?id=${realId}`);

    if (res.code !== 1 || !res.data) {
      throw new Error(res.msg || '获取详情失败');
    }

    const v = res.data;

    const picPath = v.tvimg || v.thumbnail || v.path || '';
    const fullPicUrl = getPicUrl(picPath);

    logInfo('详情图片处理', {
      original: picPath.substring(0, 50),
      full: fullPicUrl.substring(0, 80)
    });

    // 转换为新格式的播放源
    const vodPlaySources = convertToPlaySources(v.source_list_source, realId, v.title || "");

    // 刮削处理
    let scrapeData = null;
    let videoMappings = [];
    let scrapeType = "";
    const scrapeCandidates = [];
    for (const source of vodPlaySources) {
      for (const ep of source.episodes || []) {
        const metaPart = (ep.playId || "").split('|||')[1] || "";
        const meta = decodeMeta(metaPart);
        // 【v1.0.7】meta 解析失败时**不能**退回 ep.playId —— 那是 encodeURIComponent 后的整段 URL，
        // 会污染后续 videoMappings.find（file_id 变成超长串且永远匹配不上）。
        const fid = meta?.fid;
        if (!fid) continue;
        scrapeCandidates.push({
          fid,
          file_id: fid,
          file_name: ep.name || "正片",
          name: ep.name || "正片",
          format_type: "video"
        });
      }
    }

    if (scrapeCandidates.length > 0) {
      try {
        const scrapingResult = await OmniBox.processScraping(realId, v.title || "", v.title || "", scrapeCandidates);
        OmniBox.log("info", `[荐片APP] 刮削处理完成,结果: ${JSON.stringify(scrapingResult || {}).substring(0, 200)}`);
        const metadata = await OmniBox.getScrapeMetadata(realId);
        scrapeData = metadata?.scrapeData || null;
        videoMappings = metadata?.videoMappings || [];
        scrapeType = metadata?.scrapeType || "";
      } catch (error) {
        logError("刮削处理失败", error);
      }
    }

    for (const source of vodPlaySources) {
      for (const ep of source.episodes || []) {
        const metaPart = (ep.playId || "").split('|||')[1] || "";
        const meta = decodeMeta(metaPart);
        const fid = meta?.fid;
        if (!fid) continue;
        const mapping = videoMappings.find((m) => m?.fileId === fid);
        if (!mapping) continue;
        const oldName = ep.name;
        const newName = buildScrapedEpisodeName(scrapeData, mapping, oldName);
        if (newName && newName !== oldName) {
          ep.name = newName;
          OmniBox.log("info", `[荐片APP] 应用刮削后源文件名: ${oldName} -> ${newName}`);
        }
        meta.e = ep.name;
        meta.s = mapping.seasonNumber;
        meta.n = mapping.episodeNumber;
        ep.playId = `${(ep.playId || "").split('|||')[0]}|||${encodeMeta(meta)}`;
      }

      const hasEpisodeNumber = (source.episodes || []).some(
        (ep) => {
          const metaPart = (ep.playId || "").split('|||')[1] || "";
          const meta = decodeMeta(metaPart);
          return meta?.n !== undefined && meta?.n !== null;
        }
      );
      if (hasEpisodeNumber) {
        // 【v1.0.7】集键已改为「真实集号」并随 ep 对象走（buildFid 时就定死），
        // 所以这里重排不会让 _fid 与展示行脱节 —— 这正是原先按下标做键时的踩坑点。
        source.episodes.sort((a, b) => {
          const metaA = decodeMeta((a.playId || "").split('|||')[1] || "");
          const metaB = decodeMeta((b.playId || "").split('|||')[1] || "");
          const seasonA = metaA?.s || 0;
          const seasonB = metaB?.s || 0;
          if (seasonA !== seasonB) return seasonA - seasonB;
          const episodeA = metaA?.n || 0;
          const episodeB = metaB?.n || 0;
          return episodeA - episodeB;
        });
      }
    }

    logInfo('详情获取成功', {
      name: v.title,
      pic: fullPicUrl.substring(0, 50) + '...',
      sourcesCount: vodPlaySources.length
    });

    // 把「同一集在各条线路上的直链」落盘，供 play() 一次把全部线路都返回
    await saveMultiLineMap(realId, vodPlaySources);

    return {
      list: [{
        vod_id: ids,
        vod_name: scrapeData?.title || v.title || '未知标题',
        vod_pic: JP_NO_IMAGES ? '' : (scrapeData?.posterPath ? `https://image.tmdb.org/t/p/w500${scrapeData.posterPath}` : fullPicUrl),
        vod_content: scrapeData?.overview || v.description || '',
        vod_play_sources: vodPlaySources.length > 0 ? vodPlaySources : undefined,
        vod_remarks: v.mask || (v.score ? `评分:${v.score}` : ''),
        vod_year: v.year || '',
        vod_area: v.area || '',
        // 【v1.0.7】actors 可能是数组，也可能是字符串（该接口两种形态都出现过）。
        // 字符串时 .map 抛错 ⇒ 整个 getDetail 走 catch 返回 {list:[]} ⇒ 整部片打不开。
        vod_actor: Array.isArray(v.actors)
          ? v.actors.map(a => (typeof a === 'string' ? a : a?.name)).filter(Boolean).join(' ')
          : (typeof v.actors === 'string' ? v.actors : ''),
        vod_douban_score: v.score || ''
      }]
    };
  } catch (e) {
    logError('获取详情失败', e);
    return { list: [] };
  }
};

/**
 * 处理播放请求
 * @param {string} playId - 播放地址
 * @returns {Object} 播放信息
 */
const handlePlay = async (playId, vodId = "", context = {}) => {
  try {
    logInfo('处理播放请求', { url: playId.substring(0, 50) + '...' });

    const from = context?.from || "web";
    const isWeb = from === "web";

    let rawPlayId = playId;
    let playMeta = {};
    let vodName = "";
    let episodeName = "";

    // 解析透传参数
    if (rawPlayId && rawPlayId.includes('|||')) {
      const [mainPlayId, metaB64] = rawPlayId.split('|||');
      rawPlayId = mainPlayId;
      playMeta = decodeMeta(metaB64 || "");
      vodName = playMeta.v || "";
      episodeName = playMeta.e || "";
      logInfo(`解析透传信息 - 视频: ${vodName}, 集数: ${episodeName}`);
    }

    try {
      rawPlayId = decodeURIComponent(rawPlayId || "");
    } catch (error) {
      logInfo(`playId 解码失败，按原值继续: ${error.message}`);
    }

    let scrapedDanmuFileName = "";
    try {
      const videoIdForScrape = vodId ? String(vodId).replace('@netflix', '') : (playMeta?.sid ? String(playMeta.sid) : "");
      if (videoIdForScrape) {
        const metadata = await OmniBox.getScrapeMetadata(videoIdForScrape);
        if (metadata && metadata.scrapeData) {
          const mapping = (metadata.videoMappings || []).find((m) => m?.fileId === playMeta?.fid);
          if (metadata.scrapeData.title) {
            vodName = metadata.scrapeData.title;
          }
          if (mapping?.episodeName) {
            episodeName = mapping.episodeName;
          }
          scrapedDanmuFileName = buildFileNameForDanmu(vodName, episodeName);
        }
      }
    } catch (error) {
      logInfo(`读取刮削元数据失败: ${error.message}`);
    }

    // 构造播放响应
    // 【v1.0.7】原先用无锚点的 /\.(m3u8|...)/i，形如 /play/1.mp4.html、/list?next=a.ts
    // 的页面地址会被误判成媒体直链。改用文件顶部已定义的带锚点的 MEDIA_URL_RE。
    const isDirectPlayable = /^https?:\/\//i.test(rawPlayId) && MEDIA_URL_RE.test(rawPlayId);
    if (isDirectPlayable) {
      // 命中 detail 落盘的多线路清单时，一次把该集在所有线路上的直链都返回（当前线路排第一）
      try {
        const multi = await resolveMultiLinePlay(rawPlayId, playMeta);
        if (multi) {
          logInfo(`命中多线路清单，一次返回 ${multi.urls.length} 条`);
          return {
            ...multi,
            header: isWeb ? {} : PLAY_HEADERS
          };
        }
      } catch (error) {
        logInfo(`多线路清单读取失败，退回单条: ${error.message}`);
      }
      return {
        urls: [{ name: "直接播放", url: rawPlayId }],
        parse: 0,
        header: isWeb ? {} : PLAY_HEADERS
      };
    }

    const sniffResult = await sniffJianpianPlay(rawPlayId);
    if (sniffResult) {
      if (isWeb) {
        return {
          ...sniffResult,
          header: {}
        };
      }
      return sniffResult;
    }

    return {
      urls: [{ name: "播放", url: rawPlayId }],
      parse: 1,
      header: isWeb ? {} : PLAY_HEADERS
    };
  } catch (e) {
    logError('处理播放失败', e);
    return {
      urls: [],
      parse: 0,
      header: {}
    };
  }
};

/* ============================================================================
 * OmniBox 接口实现
 * ============================================================================ */

/**
 * 获取首页数据
 * @param {Object} params - 参数对象
 * @returns {Object} 返回分类列表和推荐视频列表
 */
// 【v1.0.9】首页短 TTL 缓存。客户端每次切源都是新进程，而本源首页要串起
// homeCategory(≈1.9s) + 6 个 filterOptions(并发) + hand_data(≈1.5s) 共 8 个请求，
// 实测单次 4~6s。缓存后二次进入 <0.3s，与豆瓣/哔哩系对齐。
const HOME_CACHE_KEY = 'jp:home:v1';
const HOME_CACHE_TTL_SECONDS = 300; // 5 分钟

async function readHomeCache() {
  try {
    const raw = await OmniBox.getCache(HOME_CACHE_KEY);
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
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
      logInfo('首页命中缓存', { count: cached.list.length });
      return cached;
    }
    logInfo('处理首页请求');
    // 【v1.0.8】先解析图片域名（失败自动降级到静态兜底，不影响首页出片）
    if (!JP_NO_IMAGES) await ensureImgHost(); // 图片关闭时跳过探活（抖动 DNS 下探活要 5~13s）
    const homeData = await getHomeContent();
    const recommendList = await getRecommendList();

    logInfo('首页数据组装完成', {
      classCount: homeData.class.length,
      recommendCount: recommendList.length
    });

    const result = {
      class: homeData.class,
      filters: homeData.filters,
      list: recommendList
    };
    await writeHomeCache(result);
    return result;
  } catch (error) {
    logError('获取首页数据失败', error);
    return {
      class: [],
      filters: {},
      list: []
    };
  }
}

/**
 * 获取分类数据
 */
async function category(params) {
  try {
    const categoryId = params.categoryId;
    const page = params.page || 1;
    const filters = params.filters || {};

    if (!categoryId) {
      throw new Error("分类ID不能为空");
    }

    logInfo(`获取分类数据: categoryId=${categoryId}, page=${page}`);

    // 【v1.0.8】解析图片域名（Netflix 分支与普通分类都要用封面）
    if (!JP_NO_IMAGES) await ensureImgHost(); // 图片关闭时跳过探活（抖动 DNS 下探活要 5~13s）

    // 处理 Netflix 分类
    if (categoryId === 'netflix') {
      let subType = filters.cateId || 'hot_movie';
      const result = await getNetflixList(subType, page);

      // 只在第一页返回筛选选项
      if (page === 1) {
        result.filters = [
          {
            key: "cateId",
            name: "Netflix分类",
            value: [
              { n: "热播电影", v: "hot_movie" },
              { n: "热播电视剧", v: "hot_tv" },
              { n: "热播爱情片", v: "hot_love" },
              { n: "热播惊悚片", v: "hot_thriller" },
              { n: "热播动作片", v: "hot_action" },
              { n: "高分电影", v: "top_movie" },
              { n: "经典电影", v: "classic_movie" },
              { n: "经典电视剧", v: "classic_tv" }
            ]
          }
        ];
      }

      return result;
    }

    // 处理普通分类
    const result = await getCategoryList(categoryId, page, filters);

    return result;
  } catch (error) {
    logError('获取分类数据失败', error);
    return {
      page: 1,
      pagecount: 0,
      total: 0,
      list: []
    };
  }
}

/**
 * 获取视频详情
 * @param {Object} params - 参数对象
 *   - videoId: 视频ID(必填)
 * @returns {Object} 返回视频详情
 */
async function detail(params) {
  try {
    const videoId = params.videoId;

    if (!videoId) {
      throw new Error("视频ID不能为空");
    }

    logInfo(`获取视频详情: videoId=${videoId}`);

    // 【v1.0.8】解析图片域名（详情封面）
    if (!JP_NO_IMAGES) await ensureImgHost(); // 图片关闭时跳过探活（抖动 DNS 下探活要 5~13s）

    return await getDetail(videoId);
  } catch (error) {
    logError('获取视频详情失败', error);
    return {
      list: []
    };
  }
}

/**
 * 搜索视频
 * @param {Object} params - 参数对象
 *   - keyword: 搜索关键词(必填)
 *   - page: 页码(可选,默认1)
 * @returns {Object} 返回搜索结果
 */
async function search(params) {
  try {
    const keyword = params.keyword || params.wd || "";
    const page = params.page || 1;

    if (!keyword) {
      return {
        page: 1,
        pagecount: 0,
        total: 0,
        list: []
      };
    }

    logInfo(`搜索视频: keyword=${keyword}, page=${page}`);

    // 【v1.0.8】解析图片域名（搜索结果封面）
    if (!JP_NO_IMAGES) await ensureImgHost(); // 图片关闭时跳过探活（抖动 DNS 下探活要 5~13s）

    return await searchVod(keyword, page);
  } catch (error) {
    logError('搜索视频失败', error);
    return {
      page: 1,
      pagecount: 0,
      total: 0,
      list: []
    };
  }
}

/**
 * 获取播放地址
 * @param {Object} params - 参数对象
 *   - playId: 播放地址ID(必填)
 *   - flag: 播放源标识(可选)
 * @returns {Object} 返回播放地址信息
 */
async function play(params, context) {
  try {
    const playId = params.playId;
    const vodId = params.vodId || "";

    if (!playId) {
      throw new Error("播放地址ID不能为空");
    }

    logInfo(`获取播放地址: playId=${playId}`);

    return await handlePlay(playId, vodId, context);
  } catch (error) {
    logError('获取播放地址失败', error);
    return {
      urls: [],
      parse: 0,
      header: {}
    };
  }
}

// 导出接口
module.exports = {
  home,
  category,
  search,
  detail,
  play
};

// 使用 OmniBox runner
const runner = require("spider_runner");
runner.run(module.exports);
