// @name 七味
// @author https://github.com/hjdhnx/drpy-node/blob/main/spider/js/%E4%B8%83%E5%91%B3%5B%E4%BC%98%5D.js
// @description 刮削：支持，弹幕：支持，嗅探：支持
// @dependencies: axios, cheerio
// @version 1.4.3
// @downloadURL https://gh-proxy.org/https://github.com/xiaohu1949/OmniBox-Spider/raw/refs/heads/main/影视/采集/七味.js

// 注意：本源是「普通采集源」，刻意不声明 indexs / push 这两个特殊路由标记
// （此处连 @ 符号都不写，避免客户端用宽松子串匹配时把注释误认成注解）。
// 语义（见官方模板）：indexs=1 表「推荐索引源」（官方 豆瓣推荐.js，只实现 home/category，
// 返回项被标记 search:true）；push=1 表「推送入口」（官方 推送脚本.js）。
// 采集源一旦带上 indexs 就会被框架按索引源路由，从而不参与聚合搜索；带上 push 则会在
// 客户端爬虫列表里被标成「推送脚本」—— 两者都会让它从搜索源里消失，请勿再加回。

/**
 * ============================================================================
 * 七味 (QW)
 * 站点族：qwmkv / qwfilm / qwfun / gmp4 / qwmp4 / qncool / qwshow（发布页 https://www.qn63.com/）
 *
 * 说明：
 * - 由旧版 drpy rule 脚本转换为 OmniBox 标准五接口格式
 * - 保留原站分类筛选 URL 规则与详情页播放线路解析逻辑
 * - 增强日志输出，便于排查线路、解析和故障切换问题
 *
 * 搜索说明（v1.3.2 重点）：
 * - 站点搜索受 MacCMS 自带「系统安全验证」保护，命中验证页会自动过码：
 *   抓验证码图 → 内置离线识别器解出 4 位数字 → 提交校验 → 带原会话重搜
 * - 识别器自包含（自写 inflate/PNG 解码 + 旋转扫角 + ZNCC 模板匹配），零外部依赖
 * - 通过后 PHPSESSID 落盘复用（OmniBox.setCache），会话内后续搜索免验证
 *
 * 域名说明（v1.4.1）：静态池已按实测延迟重排并删掉不可用域名；
 *  - 首选 qwmkv / qwfilm / qwfun（1.7~2.2s），删掉 qnnull(000 不可用) / qnhot(残缺页) / qmp4(回 0B)
 *  - **新增「从发布页重新获取域名」**：https://www.qn63.com/check.js 里的 urlData 就是官方域名清单，
 *    冷启动优先读落盘缓存，全部域名失败时自动强刷发布页（探活+按延迟排序+落盘）再试一轮
 *  - 冷启动会沿用「上次真的供过内容的域名」，并收敛单次超时/尝试数 ⇒ 首页不再被僵死域名拖住
 *
 * 播放说明（v1.3.9）：单集默认把本站全部线路都解析出来（MAX_PLAY_SOURCES=0）。
 * - 每张播放页 /py/<vid>-<线路>-<集>.html 内联的 player_aaaa.url 就是真实 m3u8，无需嗅探
 * - 各条线路来自不同 CDN，互为备份；实测同集常出现某条 502、其余 200 的情况，
 *   所以默认全列，播不动时在播放器里手动换一条即可
 * - 线路清单取自详情页 .py-tabs（播放页本身不带列表），在 detail 阶段落盘、
 *   play 阶段按清单并行解析，并发上限 PLAY_SOURCE_CONCURRENCY=6
 * ============================================================================
 */

const axios = require("axios");
const cheerio = require("cheerio");
const OmniBox = require("omnibox_sdk");

// 弹幕接口地址；留空表示不启用弹幕匹配；示例：https://danmu.example.com
const DANMU_API = process.env.DANMU_API || "";
function splitConfigList(value) {
    return String(value || "")
        .split(/[;,]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

// 单个网盘链接最多生成多少条可用路线；同时也作为同一种网盘最多处理多少个成功分享的阈值；正整数；默认 3
const MAX_PAN_VALID_ROUTES = (() => {
    const raw = String(process.env.MAX_PAN_VALID_ROUTES || "3").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 3;
})();
// 需要展开“本地代理/服务端代理/直连”多路线的网盘类型；分号或逗号分隔；示例：quark;uc
const DRIVE_TYPE_CONFIG = splitConfigList(process.env.DRIVE_TYPE_CONFIG || "quark;uc");
// 可供网盘检测与播放使用的路线名称；分号或逗号分隔；示例：本地代理;服务端代理;直连
const SOURCE_NAMES_CONFIG = splitConfigList(process.env.SOURCE_NAMES_CONFIG || "本地代理;服务端代理;直连");
// 是否允许外网地址使用服务端代理；填 true 或 false；默认 false
const EXTERNAL_SERVER_PROXY_ENABLED = String(process.env.EXTERNAL_SERVER_PROXY_ENABLED || "false").toLowerCase() === "true";
// 网盘线路排序优先级；分号或逗号分隔；示例：baidu;tianyi;quark;uc;115;xunlei;ali;123pan
const DRIVE_ORDER = splitConfigList(process.env.DRIVE_ORDER || "baidu;tianyi;quark;uc;115;xunlei;ali;123pan").map((s) => s.toLowerCase());
// 七味网盘文件与刮削元数据缓存时长，单位秒；默认 43200（12 小时）
const QIWEI_CACHE_EX_SECONDS = Number(process.env.QIWEI_CACHE_EX_SECONDS || 43200);
const PAN_ROUTE_NAMES = SOURCE_NAMES_CONFIG.slice(0, MAX_PAN_VALID_ROUTES);

// 是否解析详情页里的网盘链接并展开为播放线路；填 true 或 false；默认 false
// 关闭后：只解析站内在线播放线路（py-tabs / bd ul.player），不会去扫正文里的网盘分享、
// 也不会调用 getDriveInfo / getDriveFileList 等网盘接口（省掉大量请求，详情页显著变快）。
const ENABLE_PAN_PARSE = String(process.env.ENABLE_PAN_PARSE || "false").toLowerCase() === "true";

// 单集一次最多解析并返回多少条线路的播放地址；默认 0（= 不限制，把本站全部线路都返回）。
// 说明：本机每张播放页 /py/<vid>-<线路>-<集>.html 里直接放着真实 m3u8，
//      多条线路来自不同 CDN（ffzy / bfzy / wj / gs / xigua 等），互为备份源；
//      实测同一集的线路会有的挂（502）有的正常（200），全列出来才能随时手动切。
// 取值：
//  0 / all / -1  → 不限，按详情页里的线路清单把所有线路都解析返回
//  1             → 只解析当前线路（请求最少、最快）
//  n             → 最多 n 条（当前线路优先，其余按站点顺序补齐）
const MAX_PLAY_SOURCES = (() => {
    const raw = String(process.env.MAX_PLAY_SOURCES || "0").trim().toLowerCase();
    if (raw === "0" || raw === "all" || raw === "-1" || raw === "") {
        return 0;
    }
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 3;
})();
// 多线路并行解析时，单页请求的超时上限，单位毫秒；默认 8000
const PLAY_SOURCE_TIMEOUT = (() => {
    const raw = String(process.env.PLAY_SOURCE_TIMEOUT || "8000").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 8000;
})();
// 多线路并行解析时的并发上限（同时发出多少个播放页请求）；默认 8。
// 线路很多时（本站单集 10+ 条线路）一次性全打容易触发站点风控，分批更稳。
// 实测同一集 13 条线路：并发 6 → 5.9s，并发 8 → 4.4s，并发 13 → 3.9s（收益递减且有风控风险）。
const PLAY_SOURCE_CONCURRENCY = (() => {
    const raw = String(process.env.PLAY_SOURCE_CONCURRENCY || "8").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 12) : 6;
})();
// 拿不到线路清单（缓存被清 / 直接拿旧播放页调 play）时的兜底：
// 从当前线路往后最多顺延试几条。站点实际没有这么多线路时，多出来的请求会因为
// 页面里没有 player_aaaa 被跳过，不会再往下走。默认 20。
const MAX_LINE_SCAN_FALLBACK = (() => {
    const raw = String(process.env.MAX_LINE_SCAN_FALLBACK || "20").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 40) : 20;
})();

// ==================== 全局配置 ====================
// 域名池（2026-10-13 重新逐个实测，每个域连打 3 次首页）：
//   第一梯队 1.7~2.2s：qwmkv(1.74/1.76/1.90)  qwfilm(1.81/1.86/2.00)  qwfun(1.92/2.06/2.19)
//   第二梯队 1.7~8.5s：gmp4(1.71/6.17/6.21)    qwmp4(1.96/7.17/8.47)
//   尾部兜底 6~10s  ：qncool(~6.0)             qwshow(6.89/7.85/10.01)
//   ⚠ 顺序即优先级：**按实测延迟从快到慢排**，第一个就是最稳最快的 qwmkv。
// 【2026-10-13 删除的三个域名（用户要求「把没用的地址删掉」）】
//   - qnnull.com：实测 HTTP 000，6s 超时都拿不到任何响应 ⇒ 完全不可用
//   - qnhot.com ：只返回 161701B 的**残缺首页**（正常 203283B），且要 6s+，首页列表会缺条目
//   - qmp4.com  ：发布页标注的「永久地址（需科学上网）」，本网络实测回 0B ⇒ 留在池里纯属浪费一次 failover
// 注：静态池只是**兜底**。运行时会优先用「从发布页重新获取」的域名（见下方 ensureHostPool），
//     本地缓存 12h；只有发布页也拿不到时才退回这份静态清单。
// 换域名 = 换 PHPSESSID ⇒ 切换后首次搜索要重新过一次码（会话按 origin 隔离落盘）。
const HOSTS = [
    "https://www.qwmkv.com",
    "https://www.qwfilm.com",
    "https://www.qwfun.com",
    "https://www.gmp4.com",
    "https://www.qwmp4.com",
    "https://www.qncool.com",
    "https://www.qwshow.com",
];

let currentHostIndex = 0;

/* ============================================================================
 * 发布页动态取址（v1.4.1 新增）
 * ----------------------------------------------------------------------------
 * 站点会不定期整族换域名，写死的池子迟早全死。这里补上「从发布页重新获取」能力：
 *   发布页 https://www.qn63.com/ 是静态壳，真正的域名清单在
 *   https://www.qn63.com/check.js 里的 `const urlData = [{url:'https://www.xxx.com'}, ...]`。
 * 取址流程：解析 check.js → **并发**逐域名探活 → 剔除残缺/超时 → 按延迟排序 → 落盘缓存。
 * 触发时机（不拖慢正常请求）：
 *   ① 冷启动时优先读落盘缓存（命中就是一次本地 sqlite 读，几乎零开销）
 *   ② **所有**静态域名都失败时才强刷发布页，并用新域名再试一轮（真正的自愈）
 * ③ 顺带记住「上次真的供过内容的域名」，冷启动直接把它排到第一位。
 * ========================================================================== */
const PUBLISH_PAGE_ORIGIN = "https://www.qn63.com";
const PUBLISH_LIST_PATH = "/check.js";
const HOST_POOL_CACHE_KEY = "qw:hostPool:v2";
const HOST_OK_CACHE_KEY = "qw:hostOk:v2";
const HOST_POOL_TTL_SECONDS = (() => {
    const n = parseInt(process.env.QW_HOST_POOL_TTL || "43200", 10); // 默认 12h
    return Number.isFinite(n) && n >= 300 ? n : 43200;
})();
// 探活单次超时：首页约 203KB，6s 够快域名返回，慢域名直接判死（避免拖住首页）
const HOST_PROBE_TIMEOUT = (() => {
    const n = parseInt(process.env.QW_HOST_PROBE_TIMEOUT || "6000", 10);
    return Number.isFinite(n) && n >= 1000 ? n : 6000;
})();
// 单次 failover 最多试几个域名（池子再长也不无限耗下去）
const HOST_TRY_LIMIT = (() => {
    const n = parseInt(process.env.QW_HOST_TRY_LIMIT || "4", 10);
    return Number.isFinite(n) && n > 0 ? n : 4;
})();
// 单次 failover 尝试的超时：比 axios 全局的 15s 短，撞上僵死域名不至于久等。
// 首页正常 1.7~2.2s，8s 足够判定「这个域名今天不行，换下一个」。
const FAILOVER_TIMEOUT_MS = (() => {
    const n = parseInt(process.env.QW_FAILOVER_TIMEOUT || "8000", 10);
    return Number.isFinite(n) && n >= 2000 ? n : 8000;
})();
// 完整首页的下限字节数：低于此判为残缺页（实测完整 203283B / qnhot 残缺 161701B）
const HOST_HOME_MIN_BYTES = 170000;

/** 从 check.js 文本里抽域名：匹配 url: 'https://xxx' / url: "https://xxx" */
function parsePublishHostList(js) {
    const out = [];
    const re = /url\s*:\s*['"](https?:\/\/[^'"\s]+)['"]/gi;
    let m;
    while ((m = re.exec(String(js || "")))) {
        const u = m[1].replace(/\/+$/, "");
        if (u && !out.includes(u)) out.push(u);
    }
    return out;
}

function applyHostPool(list, from = "") {
    const clean = (Array.isArray(list) ? list : [])
        .map((h) => String(h || "").replace(/\/+$/, ""))
        .filter((h) => /^https?:\/\//i.test(h));
    if (clean.length === 0) return false;
    HOSTS.length = 0;
    clean.forEach((h) => HOSTS.push(h));
    currentHostIndex = 0;
    logInfo("域名池已应用", {
        from,
        hosts: HOSTS.map((h) => h.replace(/^https?:\/\//, "")),
    });
    return true;
}

/** 探活：直连 axios（不经过 requestHtml，避免依赖 currentHostIndex 与 Cookie） */
async function probeHost(host) {
    const t0 = Date.now();
    try {
        const res = await axiosInstance.get(`${host}/`, {
            headers: { ...DEFAULT_HEADERS, Referer: `${host}/` },
            timeout: HOST_PROBE_TIMEOUT,
            maxRedirects: 3,
        });
        const html = String(res.data || "");
        const ms = Date.now() - t0;
        if (res.status === 200 && html.length >= HOST_HOME_MIN_BYTES && html.includes("七味")) {
            return { host, ms, ok: true, bytes: html.length };
        }
        return { host, ms, ok: false, why: `内容不可用(status=${res.status}, ${html.length}B)` };
    } catch (error) {
        return { host, ms: Date.now() - t0, ok: false, why: error.message || String(error) };
    }
}

/** 拉发布页 → 探活 → 按延迟排序；失败返回 null（调用方回退静态池） */
async function refreshHostPoolFromPublishPage() {
    const listUrl = `${PUBLISH_PAGE_ORIGIN}${PUBLISH_LIST_PATH}`;
    try {
        logInfo("从发布页获取域名清单", { url: listUrl });
        const res = await axiosInstance.get(listUrl, {
            headers: { ...DEFAULT_HEADERS, Referer: `${PUBLISH_PAGE_ORIGIN}/` },
            timeout: HOST_PROBE_TIMEOUT,
            maxRedirects: 3,
        });
        const candidates = parsePublishHostList(res.data || "");
        if (candidates.length === 0) {
            logWarn("发布页未解析到任何域名", { bytes: String(res.data || "").length });
            return null;
        }
        logInfo("发布页域名候选", { count: candidates.length, candidates });

        const probes = await Promise.all(candidates.map((h) => probeHost(h)));
        const alive = probes.filter((p) => p.ok).sort((a, b) => a.ms - b.ms);
        logInfo("域名探活结果", {
            alive: alive.map((p) => `${p.host.replace(/^https?:\/\//, "")}~${p.ms}ms`),
            dead: probes.filter((p) => !p.ok).map((p) => `${p.host.replace(/^https?:\/\//, "")}(${p.why})`),
        });
        if (alive.length === 0) {
            logWarn("发布页域名全部探活失败");
            return null;
        }
        return alive.map((p) => p.host);
    } catch (error) {
        logWarn("发布页获取失败", { url: listUrl, error: error.message || String(error) });
        return null;
    }
}

/** 记住「真的供过内容」的域名，下次冷启动直接排第一（绝不记失败切换的目标） */
let healthyHostRemembered = false;
async function rememberHealthyHost(host) {
    if (!host || healthyHostRemembered) return;
    healthyHostRemembered = true; // 每个进程只写一次，避免每次请求都落盘
    try {
        // TTL 24h：万一某一刻某个域名抽风，一天后自动让它重新竞争，不会被永久打偏
        await OmniBox.setCache(HOST_OK_CACHE_KEY, host, 24 * 3600);
        logInfo("已记住健康域名", { host });
    } catch {
        // 无 runner 上下文时忽略
    }
}

async function preferRememberedHealthyHost() {
    try {
        const ok = await OmniBox.getCache(HOST_OK_CACHE_KEY);
        if (!ok || !HOSTS.includes(ok)) return;
        const i = HOSTS.indexOf(ok);
        if (i > 0) {
            HOSTS.splice(i, 1);
            HOSTS.unshift(ok);
        }
        currentHostIndex = 0;
        logInfo("冷启动沿用上次供过内容的域名", { host: ok });
    } catch {
        // 忽略
    }
}

let hostPoolPromise = null;

/**
 * 冷启动入口：命中落盘缓存就用缓存（一次本地读），否则**保持静态池**。
 * 刻意不在这里强刷发布页 —— 不能让「首次访问」去等一轮探活。
 * 真正需要换血时由 requestHtmlWithFailover 在「全部失败」后触发。
 */
async function ensureHostPool() {
    if (hostPoolPromise) return hostPoolPromise;
    hostPoolPromise = (async () => {
        // 【手动强制重新获取】设 QW_FORCE_HOST_REFRESH=1 时忽略缓存，直接去发布页取一遍。
        // 运维用得上：怀疑域名池过期时，跑一次带该变量的调用即可刷新落盘缓存。
        const force = ["1", "true", "yes"].includes(
            String(process.env.QW_FORCE_HOST_REFRESH || "").toLowerCase()
        );
        if (force) {
            logInfo("QW_FORCE_HOST_REFRESH=1 ⇒ 强制从发布页重新获取域名");
            const refreshed = await forceRefreshHostPool();
            if (refreshed) return HOSTS;
            logWarn("强制刷新失败，回退到缓存/静态池");
        }

        const cached = await getCachedJSON(HOST_POOL_CACHE_KEY);
        const arr = Array.isArray(cached) ? cached : (cached && Array.isArray(cached.hosts) ? cached.hosts : null);
        if (arr && arr.length > 0) {
            applyHostPool(arr, "落盘缓存");
        }
        await preferRememberedHealthyHost();
        return HOSTS;
    })();
    return hostPoolPromise;
}

/** 全部域名失败后的自救：强刷发布页一次并落盘 */
async function forceRefreshHostPool() {
    const fresh = await refreshHostPoolFromPublishPage();
    if (!fresh || fresh.length === 0) return false;
    const applied = applyHostPool(fresh, "发布页强刷");
    if (applied) {
        await setCachedJSON(HOST_POOL_CACHE_KEY, HOSTS.slice(0, 8), HOST_POOL_TTL_SECONDS);
    }
    return applied;
}

const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Connection": "keep-alive",
};

const CLASSES = [
    { type_id: "1", type_name: "电影" },
    { type_id: "2", type_name: "剧集" },
    { type_id: "3", type_name: "综艺" },
    { type_id: "4", type_name: "动漫" },
    { type_id: "30", type_name: "短剧" },
];

const FULL_TYPE_OPTIONS = [
    "剧情", "科幻", "动作", "喜剧", "爱情", "冒险", "儿童", "歌舞", "音乐", "奇幻", "动画", "恐怖", "惊悚", "丧尸", "战争", "传记", "纪录", "犯罪", "悬疑", "西部", "灾难", "古装", "武侠", "家庭", "短片", "校园", "文艺", "运动", "青春", "同性", "励志", "人性", "美食", "女性", "治愈", "历史",
];
const FULL_YEAR_OPTIONS = ["2026", "2025", "2024", "2023", "2022", "2021", "2020", "2019", "2018", "2017", "2016", "2015", "2014", "2013", "2012", "2011", "2010"];
const FULL_AREA_OPTIONS = ["大陆", "香港", "台湾", "日本", "韩国", "泰国", "美国", "英国", "法国", "德国", "印度", "丹麦", "瑞典", "荷兰", "加拿大", "俄罗斯", "意大利", "比利时", "西班牙", "澳大利亚", "其他"];
const FULL_LANG_OPTIONS = ["国语", "粤语", "英语", "法语", "日语", "韩语", "泰语", "德语", "俄语", "闽南语", "丹麦语", "波兰语", "瑞典语", "印地语", "挪威语", "意大利语", "西班牙语", "无对白", "其他"];
const FULL_SORT_OPTIONS = [
    { name: "按时间", value: "time" },
    { name: "按人气", value: "hits" },
    { name: "按评分", value: "score" },
];

function buildFilterOptionList(list = []) {
    return [{ name: "全部", value: "" }, ...list.map((item) => ({ name: item, value: item }))];
}

function buildCategoryFilters({ includeType = true, includeYear = true, includeArea = true, includeLang = true } = {}) {
    const filters = [
        {
            key: "sort",
            name: "排序",
            init: "time",
            value: FULL_SORT_OPTIONS,
        },
    ];
    if (includeType) {
        filters.push({
            key: "type",
            name: "类型",
            init: "",
            value: buildFilterOptionList(FULL_TYPE_OPTIONS),
        });
    }
    if (includeYear) {
        filters.push({
            key: "year",
            name: "年代",
            init: "",
            value: buildFilterOptionList(FULL_YEAR_OPTIONS),
        });
    }
    if (includeArea) {
        filters.push({
            key: "area",
            name: "地区",
            init: "",
            value: buildFilterOptionList(FULL_AREA_OPTIONS),
        });
    }
    if (includeLang) {
        filters.push({
            key: "lang",
            name: "语言",
            init: "",
            value: buildFilterOptionList(FULL_LANG_OPTIONS),
        });
    }
    return filters;
}

const FILTERS = {
    "1": buildCategoryFilters(),
    "2": buildCategoryFilters(),
    "3": buildCategoryFilters({ includeYear: false, includeArea: false, includeLang: false }),
    "4": buildCategoryFilters({ includeArea: false, includeLang: false }),
    "30": buildCategoryFilters({ includeArea: false, includeLang: false }),
};

const axiosInstance = axios.create({
    timeout: 15000,
    validateStatus: (status) => status >= 200 && status < 500,
    responseType: "text",
});

// ==================== 日志工具 ====================
function logInfo(message, data = null) {
    const suffix = data == null ? "" : `: ${JSON.stringify(data)}`;
    OmniBox.log("info", `[七味] ${message}${suffix}`);
}

function logWarn(message, data = null) {
    const suffix = data == null ? "" : `: ${JSON.stringify(data)}`;
    OmniBox.log("warn", `[七味] ${message}${suffix}`);
}

function logError(message, error) {
    OmniBox.log("error", `[七味] ${message}: ${error?.message || error}`);
}

function encodeMeta(obj) {
    try {
        return Buffer.from(JSON.stringify(obj || {}), "utf8").toString("base64");
    } catch {
        return "";
    }
}

function decodeMeta(str) {
    try {
        const raw = Buffer.from(str || "", "base64").toString("utf8");
        return JSON.parse(raw || "{}");
    } catch {
        return {};
    }
}

function extractEpisode(title) {
    if (!title) return "";
    const processedTitle = title.trim();
    const seMatch = processedTitle.match(/[Ss](?:\d{1,2})?[-._\s]*[Ee](\d{1,3})/i);
    if (seMatch) return seMatch[1];
    const cnMatch = processedTitle.match(/第\s*([0-9]+)\s*[集话章节回期]/);
    if (cnMatch) return cnMatch[1];
    const epMatch = processedTitle.match(/\b(?:EP|E)[-._\s]*(\d{1,3})\b/i);
    if (epMatch) return epMatch[1];
    const bracketMatch = processedTitle.match(/[\[\(【（](\d{1,3})[\]\)】）]/);
    if (bracketMatch) {
        const num = bracketMatch[1];
        if (!["720", "1080", "480"].includes(num)) return num;
    }
    return "";
}

function buildFileNameForDanmu(vodName, episodeTitle) {
    if (!vodName) return "";
    if (!episodeTitle || episodeTitle === "正片" || episodeTitle === "播放") {
        return vodName;
    }
    const digits = extractEpisode(episodeTitle);
    if (digits) {
        const epNum = parseInt(digits, 10);
        if (epNum > 0) {
            return `${vodName} S01E${String(epNum).padStart(2, "0")}`;
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
    if (!DANMU_API || !fileName) {
        return [];
    }

    try {
        logInfo("匹配弹幕", { fileName });
        const response = await OmniBox.request(`${DANMU_API}/api/v2/match`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
            body: JSON.stringify({ fileName }),
        });

        if (response.statusCode !== 200) {
            logWarn("弹幕匹配失败", { statusCode: response.statusCode });
            return [];
        }

        const data = JSON.parse(response.body || "{}");
        if (!data.isMatched) {
            return [];
        }

        const first = (data.matches || [])[0] || {};
        if (!first.episodeId) {
            return [];
        }

        const animeTitle = first.animeTitle || "";
        const episodeTitle = first.episodeTitle || "";
        let danmakuName = "弹幕";
        if (animeTitle && episodeTitle) {
            danmakuName = `${animeTitle} - ${episodeTitle}`;
        } else if (animeTitle) {
            danmakuName = animeTitle;
        } else if (episodeTitle) {
            danmakuName = episodeTitle;
        }

        return [{ name: danmakuName, url: `${DANMU_API}/api/v2/comment/${first.episodeId}?format=xml` }];
    } catch (error) {
        logWarn("弹幕匹配异常", { error: error.message || String(error) });
        return [];
    }
}

// ==================== 网盘类型与线路工具 ====================
function inferDriveTypeFromSourceName(name = "") {
    const raw = String(name || "").toLowerCase();
    if (raw.includes("百度")) return "baidu";
    if (raw.includes("天翼")) return "tianyi";
    if (raw.includes("夸克")) return "quark";
    if (raw === "uc" || raw.includes("uc")) return "uc";
    if (raw.includes("115")) return "115";
    if (raw.includes("迅雷")) return "xunlei";
    if (raw.includes("阿里")) return "ali";
    if (raw.includes("123")) return "123pan";
    return raw;
}

function isPanSourceName(name = "") {
    const value = String(name || "");
    if (!value) return false;
    return ["百度", "天翼", "夸克", "UC", "115", "迅雷", "阿里", "123"].some((keyword) => value.includes(keyword));
}

function sortPlaySourcesByDriveOrder(playSources = []) {
    if (!Array.isArray(playSources) || playSources.length <= 1) {
        return playSources;
    }
    const orderMap = new Map(DRIVE_ORDER.map((name, index) => [name, index]));
    return [...playSources].sort((a, b) => {
        const aIsPan = isPanSourceName(a?.name || "");
        const bIsPan = isPanSourceName(b?.name || "");
        if (aIsPan !== bIsPan) {
            return aIsPan ? 1 : -1;
        }
        if (!aIsPan && !bIsPan) {
            return 0;
        }
        if (DRIVE_ORDER.length === 0) {
            return 0;
        }
        const aType = inferDriveTypeFromSourceName(a?.name || "");
        const bType = inferDriveTypeFromSourceName(b?.name || "");
        const aOrder = orderMap.has(aType) ? orderMap.get(aType) : Number.MAX_SAFE_INTEGER;
        const bOrder = orderMap.has(bType) ? orderMap.get(bType) : Number.MAX_SAFE_INTEGER;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return 0;
    });
}

function resolveCallerSource(params = {}, context = {}) {
    return String(context?.from || params?.source || "").toLowerCase();
}

function getBaseURLHost(context = {}) {
    const baseURL = String(context?.baseURL || "").trim();
    if (!baseURL) return "";
    try {
        return new URL(baseURL).hostname.toLowerCase();
    } catch {
        return baseURL.toLowerCase();
    }
}

function isPrivateHost(hostname = "") {
    const host = String(hostname || "").toLowerCase();
    if (!host) return false;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return true;
    if (/^(10\.|192\.168\.|169\.254\.)/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
    if (host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal") || host.endsWith(".intra")) return true;
    if (host.includes(":")) return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
    return false;
}

function canUseServerProxy(context = {}) {
    if (EXTERNAL_SERVER_PROXY_ENABLED) return true;
    return isPrivateHost(getBaseURLHost(context));
}

function filterSourceNamesForCaller(sourceNames = [], callerSource = "", context = {}) {
    let filtered = Array.isArray(sourceNames) ? [...sourceNames] : [];
    const allowServerProxy = canUseServerProxy(context);

    if (callerSource === "web") {
        filtered = filtered.filter((name) => name !== "本地代理");
    } else if (callerSource === "emby") {
        if (allowServerProxy) {
            filtered = filtered.filter((name) => name === "服务端代理");
        } else {
            filtered = filtered.filter((name) => name !== "服务端代理");
        }
    } else if (callerSource === "uz") {
        filtered = filtered.filter((name) => name !== "本地代理");
    }

    if (!allowServerProxy) {
        filtered = filtered.filter((name) => name !== "服务端代理");
    }

    return filtered.length > 0 ? filtered : ["直连"];
}

function resolveRouteType(flag = "", callerSource = "", context = {}) {
    const allowServerProxy = canUseServerProxy(context);
    const validRouteTypes = new Set(["本地代理", "服务端代理", "直连"]);
    let routeType = "直连";

    if (callerSource === "web" || callerSource === "emby") {
        routeType = allowServerProxy ? "服务端代理" : "直连";
    }

    if (flag) {
        if (flag.includes("-")) {
            const flagParts = flag.split("-");
            routeType = flagParts[flagParts.length - 1];
        } else {
            routeType = flag;
        }
    }

    if (!validRouteTypes.has(routeType)) {
        routeType = "直连";
    }

    if (!allowServerProxy && routeType === "服务端代理") {
        routeType = "直连";
    }

    if (callerSource === "uz" && routeType === "本地代理") {
        routeType = "直连";
    }

    return routeType;
}

// ==================== 基础工具 ====================
function getCurrentHost() {
    return HOSTS[currentHostIndex] || HOSTS[0];
}

function rotateHost() {
    currentHostIndex = (currentHostIndex + 1) % HOSTS.length;
    return getCurrentHost();
}

function fixJsonWrappedHtml(html) {
    if (html == null) {
        return "";
    }
    if (typeof html === "object") {
        try {
            return JSON.stringify(html);
        } catch {
            return "";
        }
    }
    const raw = String(html);
    const trimmed = raw.trim();
    if (!trimmed) {
        return "";
    }
    if (trimmed.startsWith("<") || trimmed.startsWith("<!DOCTYPE")) {
        return trimmed;
    }
    if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === "string") {
                return parsed.trim();
            }
        } catch {
            return trimmed;
        }
    }
    return trimmed;
}

function safeJsonParse(value, fallback = null) {
    if (value == null || value === "") {
        return fallback;
    }
    if (typeof value === "object") {
        return value;
    }
    try {
        return JSON.parse(String(value));
    } catch {
        return fallback;
    }
}

function isAbsoluteUrl(url) {
    return /^https?:\/\//i.test(String(url || ""));
}

function fixUrl(url, host = getCurrentHost()) {
    const value = String(url || "").trim();
    if (!value) {
        return "";
    }
    if (isAbsoluteUrl(value)) {
        return value;
    }
    if (value.startsWith("//")) {
        return `https:${value}`;
    }
    if (value.startsWith("/")) {
        return `${host}${value}`;
    }
    return `${host}/${value}`;
}

function normalizeImage(url, host = getCurrentHost()) {
    const normalized = fixUrl(url, host);
    return normalized || "";
}

function parsePage(value, fallback = 1) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseFilters(params = {}) {
    const merged = {};
    const candidates = [params.filters, params.extend, params.ext];
    for (const item of candidates) {
        if (!item) {
            continue;
        }
        if (typeof item === "object") {
            Object.assign(merged, item);
            continue;
        }
        if (typeof item === "string") {
            try {
                const parsed = JSON.parse(item);
                if (parsed && typeof parsed === "object") {
                    Object.assign(merged, parsed);
                }
            } catch {
                // ignore invalid filter json
            }
        }
    }
    const normalized = {};
    for (const [key, value] of Object.entries(merged)) {
        if (!["sort", "type", "area", "lang", "year"].includes(key)) {
            continue;
        }
        normalized[key] = String(value || "").trim();
    }
    if (!FULL_SORT_OPTIONS.some((item) => item.value === normalized.sort)) {
        normalized.sort = "time";
    }
    return normalized;
}

/**
 * 统一 HTTP GET：带上/回收本域 Cookie（搜索过码会话 PHPSESSID 依赖它跨请求保持）。
 */
async function requestHtml(url, options = {}) {
    const origin = qwOriginOf(url);
    await qwEnsureCookiesLoaded();
    const cookie = qwCookieHeader(origin);
    const response = await axiosInstance.get(url, {
        ...options,
        headers: {
            ...DEFAULT_HEADERS,
            Referer: `${getCurrentHost()}/`,
            Origin: getCurrentHost(),
            ...(cookie ? { Cookie: cookie } : {}),
            ...(options.headers || {}),
        },
    });
    qwMergeSetCookies(origin, response.headers && (response.headers["set-cookie"] || response.headers["Set-Cookie"]));
    return fixJsonWrappedHtml(response.data || "");
}

/**
 * 单轮：从 currentHostIndex 开始，最多试 HOST_TRY_LIMIT 个域名，成功即返回。
 * 【v1.4.1】抽成独立函数，便于「全部失败 → 换一批域名再试一轮」。
 */
async function tryHostsOnce(pathOrUrl, options = {}, roundLabel = "") {
    let lastError = null;
    const startIndex = currentHostIndex;
    const attempts = Math.max(1, Math.min(HOSTS.length, HOST_TRY_LIMIT));

    for (let i = 0; i < attempts; i++) {
        const host = HOSTS[currentHostIndex];
        const url = fixUrl(pathOrUrl, host);
        try {
            logInfo("请求页面", { round: roundLabel, host, path: pathOrUrl });
            const html = await requestHtml(url, {
                ...options,
                // 【v1.4.1】收敛单次超时（调用方显式给的优先，如播放页的 PLAY_SOURCE_TIMEOUT）
                timeout: options.timeout || FAILOVER_TIMEOUT_MS,
                headers: {
                    ...(options.headers || {}),
                    Referer: `${host}/`,
                    Origin: host,
                },
            });

            if (html) {
                const trimmed = String(html).trim();
                const isHtml = trimmed.includes("<html") || trimmed.startsWith("<!DOCTYPE");
                const isJson = trimmed.startsWith("{") || trimmed.startsWith("[");
                if (isHtml || isJson) {
                    if (i > 0) {
                        logInfo("站点切换成功", { from: HOSTS[startIndex], to: host });
                    }
                    logInfo("页面请求成功", { host, bytes: trimmed.length });
                    // 【v1.4.1】记住"真的供过内容"的域名（必须 await：客户端每次调用都是新进程，
                    // 不 await 的话落盘还没完成进程就退出了）
                    await rememberHealthyHost(host);
                    return { html, host };
                }
            }

            lastError = new Error("empty or invalid html");
            logWarn("页面内容异常，切换下一个 host", { host });
        } catch (error) {
            lastError = error;
            logWarn("请求失败，切换下一个 host", { host, error: error.message || String(error) });
        }

        rotateHost();
    }

    throw lastError || new Error("all hosts failed");
}

/**
 * 按 host 列表自动重试。
 * - 绝对 URL：直接请求一次
 * - 相对 URL：从当前 host 开始轮询，成功即返回
 *
 * 【v1.4.1 提速要点】
 *  ① 冷启动先 ensureHostPool()：命中落盘缓存时只是一次本地读，并把「上次真的供过内容的域名」
 *     排到第一位 ⇒ 第一发就打在最稳的域名上，不再靠运气。
 *  ② 单轮最多试 HOST_TRY_LIMIT（默认 4）个域名，单次超时 FAILOVER_TIMEOUT_MS（默认 8s），
 *     彻底避免「撞上僵死域名 → 15s 超时 × 整池」这种首页卡十几秒的情况。
 *  ③ **全部失败**时才去「发布页」重新取一批域名（探活 + 按延迟排序 + 落盘）再试一轮 ⇒ 自愈。
 */
async function requestHtmlWithFailover(pathOrUrl, options = {}) {
    if (isAbsoluteUrl(pathOrUrl)) {
        return requestHtml(pathOrUrl, options);
    }

    await ensureHostPool().catch(() => {});

    let lastError = null;
    try {
        return await tryHostsOnce(pathOrUrl, options, "首轮");
    } catch (error) {
        lastError = error;
    }

    // 首轮全军覆没 ⇒ 从发布页换一批新域名再来
    logWarn("所有域名均失败，尝试从发布页重新获取域名", {
        path: pathOrUrl,
        lastError: lastError && (lastError.message || String(lastError)),
    });
    const refreshed = await forceRefreshHostPool().catch(() => false);
    if (refreshed) {
        try {
            return await tryHostsOnce(pathOrUrl, options, "换源重试");
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error("all hosts failed");
}

// ==================== 列表解析 ====================
function pickFirstText($root, selectors = []) {
    for (const selector of selectors) {
        const value = $root.find(selector).first().text().trim();
        if (value) {
            return value;
        }
    }
    return "";
}

function pickFirstAttr($root, selectors = [], attrName = "href") {
    for (const selector of selectors) {
        const value = $root.find(selector).first().attr(attrName);
        if (value) {
            return String(value).trim();
        }
    }
    return "";
}

function parsePosterItem($, element, host) {
    const $item = $(element);

    const title =
        pickFirstAttr($item, ["h3 a", ".title a", ".li-img a", "a"], "title") ||
        pickFirstText($item, ["h3 a", ".title a", "a"]);

    if (!title) {
        return null;
    }

    const desc = pickFirstText($item, [".tag", ".label", ".remark"]);
    const img = pickFirstAttr($item, [".li-img img", "img"], "src");
    const href = pickFirstAttr($item, ["h3 a", ".title a", ".li-img a", "a"], "href");

    if (!href) {
        return null;
    }

    return {
        vod_id: fixUrl(href, host),
        vod_name: title,
        vod_pic: normalizeImage(img, host),
        vod_remarks: desc || "",
    };
}

function parseVideoList(html, host) {
    const $ = cheerio.load(html || "");
    const nodes = $(".content-list li");
    const list = [];
    nodes.each((_, element) => {
        const item = parsePosterItem($, element, host);
        if (item) {
            list.push(item);
        }
    });
    return list;
}

/**
 * 搜索结果页专用解析器。
 * 注意：搜索页结构与首页不是一套模板（首页 .content-list li，搜索页 .sr_lists > dl），
 * 复用首页解析器会恒 0 条，因此这里单独实现，认不出时再兜底回首页解析器。
 */
function parseSearchList(html, host) {
    const $ = cheerio.load(html || "");
    const list = [];
    $(".sr_lists dl").each((_, element) => {
        const $item = $(element);
        const $link = $item.find("dd p strong a").first();
        const href = String($link.attr("href") || "").trim();
        const title = String($link.text() || "").trim();
        if (!href || !title) {
            return;
        }
        const img = $item.find("dt img").first().attr("src") || "";
        const remarks = String($item.find("dd span.ss1").first().text() || "").trim();
        list.push({
            vod_id: fixUrl(href, host),
            vod_name: title,
            vod_pic: normalizeImage(img, host),
            vod_remarks: remarks,
        });
    });
    return list.length > 0 ? list : parseVideoList(html, host);
}

/** 搜索结果是否存在超出当前页的分页 */
function hasSearchNextPage(html, currentPage) {
    const $ = cheerio.load(html || "");
    let maxPage = currentPage;
    $("a[href]").each((_, element) => {
        const href = String($(element).attr("href") || "");
        const match = href.match(/[?&]page=(\d+)/);
        if (match) {
            const value = parseInt(match[1], 10);
            if (Number.isFinite(value) && value > maxPage) {
                maxPage = value;
            }
        }
    });
    return maxPage > currentPage;
}

function buildCategoryPath(categoryId, page, filters = {}) {
    const area = encodeURIComponent(String(filters.area || "").trim());
    const sort = String(filters.sort || "time").trim() || "time";
    const type = encodeURIComponent(String(filters.type || "").trim());
    const lang = encodeURIComponent(String(filters.lang || "").trim());
    const year = encodeURIComponent(String(filters.year || "").trim());
    return `/ms/${categoryId}-${area}-${sort}-${type}-${lang}-------${year}.html?page=${page}`;
}

function parsePanTypeKey(url) {
    const source = String(url || "").toLowerCase();
    if (!source) {
        return "";
    }
    const mapping = {
        "pan.baidu.com": "baidu",
        "pan.baiduimg.com": "baidu",
        "pan.quark.cn": "quark",
        "drive.uc.cn": "uc",
        "cloud.189.cn": "tianyi",
        "yun.139.com": "mobile",
        "alipan.com": "ali",
        "pan.aliyun.com": "ali",
        "115.com": "115",
        "115cdn.com": "115",
    };

    for (const [key, type] of Object.entries(mapping)) {
        if (source.includes(key)) {
            return type;
        }
    }
    return "";
}

function parsePanType(url) {
    const typeKey = parsePanTypeKey(url);
    const typeMap = {
        baidu: "百度",
        quark: "夸克",
        uc: "UC",
        tianyi: "天翼",
        mobile: "移动",
        ali: "阿里",
        115: "115",
    };
    return typeMap[typeKey] || "其他";
}

function isPanUrl(url) {
    const source = String(url || "");
    if (!source) {
        return false;
    }
    return [
        "pan.baidu.com",
        "pan.baiduimg.com",
        "pan.quark.cn",
        "drive.uc.cn",
        "cloud.189.cn",
        "yun.139.com",
        "alipan.com",
        "pan.aliyun.com",
        "115.com",
        "115cdn.com",
    ].some((key) => source.includes(key));
}

function isDirectVideoUrl(url) {
    if (!url) {
        return false;
    }
    return /\.(m3u8|mp4|flv|avi|mkv|ts|mov|webm)(\?|$)/i.test(String(url));
}

function normalizeShareUrl(url) {
    if (!url) {
        return "";
    }
    let value = String(url).trim();
    if (value.startsWith("push://")) {
        value = value.slice("push://".length);
    }
    if (value.startsWith("push:")) {
        value = value.slice("push:".length);
    }
    const dnIndex = value.toLowerCase().indexOf("&dn=");
    if (dnIndex !== -1) {
        value = value.slice(0, dnIndex);
    }
    return value.trim();
}

function isVideoFile(file) {
    if (!file || !file.file_name) {
        return false;
    }
    const fileName = String(file.file_name).toLowerCase();
    const videoExtensions = [".mp4", ".mkv", ".avi", ".flv", ".mov", ".wmv", ".m3u8", ".ts", ".webm", ".m4v"];
    for (const ext of videoExtensions) {
        if (fileName.endsWith(ext)) {
            return true;
        }
    }
    if (file.format_type) {
        const formatType = String(file.format_type).toLowerCase();
        if (formatType.includes("video") || formatType.includes("mpeg") || formatType.includes("h264")) {
            return true;
        }
    }
    return false;
}

function getFileId(file) {
    return file?.fid || file?.file_id || "";
}

function getFileName(file) {
    return file?.file_name || file?.name || "";
}

async function getAllVideoFiles(shareURL, files) {
    const videoFiles = [];
    for (const file of files || []) {
        if (file.file && isVideoFile(file)) {
            videoFiles.push(file);
        } else if (file.dir) {
            try {
                const subFileId = getFileId(file);
                if (!subFileId) {
                    continue;
                }
                const subFileList = await OmniBox.getDriveFileList(shareURL, subFileId);
                if (subFileList && Array.isArray(subFileList.files)) {
                    const subVideos = await getAllVideoFiles(shareURL, subFileList.files);
                    videoFiles.push(...subVideos);
                }
            } catch (error) {
                logWarn("获取网盘子目录文件失败", { shareURL, fileId: getFileId(file), error: error.message || String(error) });
            }
        }
    }
    return videoFiles;
}

// ==================== 网盘缓存 ====================
function buildCacheKey(prefix, value) {
    return `${prefix}:${String(value || "")}`;
}

async function getCachedJSON(key) {
    try {
        return await OmniBox.getCache(key);
    } catch (error) {
        logWarn("读取缓存失败", { key, error: error.message || String(error) });
        return null;
    }
}

async function setCachedJSON(key, value, exSeconds = QIWEI_CACHE_EX_SECONDS) {
    try {
        await OmniBox.setCache(key, value, exSeconds);
    } catch (error) {
        logWarn("写入缓存失败", { key, error: error.message || String(error) });
    }
}

async function getDriveInfoCached(shareURL) {
    const cacheKey = buildCacheKey("qiwei:driveInfo", shareURL);
    let driveInfo = await getCachedJSON(cacheKey);
    if (!driveInfo) {
        driveInfo = await OmniBox.getDriveInfoByShareURL(shareURL);
        if (driveInfo) {
            await setCachedJSON(cacheKey, driveInfo);
        }
    } else {
        logInfo("命中网盘信息缓存", { shareURL });
    }
    return driveInfo;
}

async function getRootFileListCached(shareURL) {
    const cacheKey = buildCacheKey("qiwei:rootFiles", shareURL);
    let fileList = await getCachedJSON(cacheKey);
    if (!fileList) {
        fileList = await OmniBox.getDriveFileList(shareURL, "0");
        if (fileList && Array.isArray(fileList.files)) {
            await setCachedJSON(cacheKey, fileList);
        }
    } else {
        logInfo("命中网盘根目录缓存", { shareURL, count: Array.isArray(fileList?.files) ? fileList.files.length : 0 });
    }
    return fileList;
}

async function getAllVideoFilesCached(shareURL, rootFiles = []) {
    const cacheKey = buildCacheKey("qiwei:videoFiles", shareURL);
    let videos = await getCachedJSON(cacheKey);
    if (!Array.isArray(videos) || videos.length === 0) {
        videos = await getAllVideoFiles(shareURL, rootFiles);
        if (Array.isArray(videos) && videos.length > 0) {
            await setCachedJSON(cacheKey, videos);
        }
    } else {
        logInfo("命中网盘视频文件缓存", { shareURL, count: videos.length });
    }
    return Array.isArray(videos) ? videos : [];
}

async function getMergedMetadataCached(videoId, vodName, scrapeCandidates = []) {
    const metadataCacheKey = buildCacheKey("qiwei:metadata", videoId);
    const metadataRefreshLockKey = buildCacheKey("qiwei:metadataRefreshLock", videoId);

    let scrapeData = null;
    let videoMappings = [];
    let scrapeType = "";
    const cachedMetadata = await getCachedJSON(metadataCacheKey);

    if (cachedMetadata) {
        scrapeData = cachedMetadata.scrapeData || null;
        videoMappings = Array.isArray(cachedMetadata.videoMappings) ? cachedMetadata.videoMappings : [];
        scrapeType = cachedMetadata.scrapeType || "";
        logInfo("命中刮削元数据缓存", { videoId, mappingCount: videoMappings.length, scrapeType });
    }

    const refreshMetadataInBackground = async () => {
        const refreshLock = await getCachedJSON(metadataRefreshLockKey);
        if (refreshLock || scrapeCandidates.length === 0) {
            return;
        }
        await setCachedJSON(metadataRefreshLockKey, { refreshing: true }, QIWEI_CACHE_EX_SECONDS);
        try {
            logInfo("后台刷新刮削元数据", { videoId, candidateCount: scrapeCandidates.length });
            await OmniBox.processScraping(String(videoId || ""), vodName || "", vodName || "", scrapeCandidates);
            const metadata = await OmniBox.getScrapeMetadata(String(videoId || ""));
            const freshData = metadata?.scrapeData || null;
            const freshMappings = metadata?.videoMappings || [];
            // 【v1.4.0】同样只在真有内容时覆盖缓存
            if (freshData || freshMappings.length > 0) {
                await setCachedJSON(metadataCacheKey, {
                    scrapeData: freshData,
                    videoMappings: freshMappings,
                    scrapeType: metadata?.scrapeType || "",
                }, QIWEI_CACHE_EX_SECONDS);
            }
        } catch (error) {
            logWarn("后台刷新刮削元数据失败", { videoId, error: error.message || String(error) });
            // 【v1.4.0】失败时必须释放锁：锁 TTL 是 12 小时，不释放等于这段时间彻底不再刮削
            try {
                await OmniBox.delCache?.(metadataRefreshLockKey);
            } catch (unlockError) {
                logWarn("释放刮削刷新锁失败", { videoId, error: unlockError.message || String(unlockError) });
            }
        }
    };

    if (!cachedMetadata && scrapeCandidates.length > 0) {
        try {
            logInfo("未命中刮削元数据缓存，开始同步刮削", { videoId, candidateCount: scrapeCandidates.length });
            const scrapingResult = await OmniBox.processScraping(String(videoId || ""), vodName || "", vodName || "", scrapeCandidates);
            logInfo("刮削处理完成", { videoId, length: JSON.stringify(scrapingResult || {}).length });
            const metadata = await OmniBox.getScrapeMetadata(String(videoId || ""));
            scrapeData = metadata?.scrapeData || null;
            videoMappings = metadata?.videoMappings || [];
            scrapeType = metadata?.scrapeType || "";
            // 【v1.4.0】原先无论有没有结果都写缓存 ⇒ 刮削失败时把「空元数据」缓存 12 小时，
            // 之后每次 detail 都命中空缓存，只能靠后台刷新兜底；而后台刷新失败时锁不释放
            // （见 refreshMetadataInBackground 的 catch），实际是 12 小时内彻底不再刮削。
            // 现在只在真的拿到内容时才写缓存。
            if (scrapeData || videoMappings.length > 0) {
                await setCachedJSON(metadataCacheKey, {
                    scrapeData,
                    videoMappings,
                    scrapeType,
                }, QIWEI_CACHE_EX_SECONDS);
            } else {
                logWarn("刮削未返回任何结果，不写入缓存", { videoId });
            }
            logInfo("刮削元数据读取完成", { videoId, hasScrapeData: !!scrapeData, mappingCount: videoMappings.length, scrapeType });
        } catch (error) {
            logWarn("刮削处理失败", { videoId, error: error.message || String(error) });
        }
    } else if (cachedMetadata) {
        refreshMetadataInBackground().catch((error) => {
            logWarn("异步刷新刮削元数据失败", { videoId, error: error.message || String(error) });
        });
    }

    return {
        scrapeData,
        videoMappings,
        scrapeType,
        cachedMetadata,
    };
}

const panRouteCache = new Map();

async function loadPanFiles(shareURL) {
    if (!shareURL) {
        return null;
    }
    try {
        await getDriveInfoCached(shareURL);
        const fileList = await getRootFileListCached(shareURL);
        const files = Array.isArray(fileList?.files) ? fileList.files : [];
        const videos = await getAllVideoFilesCached(shareURL, files);
        return { videos };
    } catch (error) {
        logWarn("读取网盘文件失败", { shareURL, error: error.message || String(error) });
        return null;
    }
}

function extractRouteTypeFromFlag(flag) {
    const value = String(flag || "").trim();
    if (!value) {
        return "";
    }
    if (value.includes("-")) {
        const last = value.split("-").pop();
        return String(last || "").trim();
    }
    return value;
}

function hasValidPlayUrls(playInfo) {
    return Array.isArray(playInfo?.url) && playInfo.url.some((item) => item?.url);
}

async function detectValidPanRoutes(shareURL, videos = [], callerSource = "", context = {}, maxNeeded = MAX_PAN_VALID_ROUTES) {
    const routeLimit = Math.max(1, Math.min(MAX_PAN_VALID_ROUTES, parseInt(maxNeeded, 10) || MAX_PAN_VALID_ROUTES));
    const filteredCandidates = filterSourceNamesForCaller(PAN_ROUTE_NAMES.length > 0 ? PAN_ROUTE_NAMES : ["直连"], callerSource, context);
    const cacheKey = `${shareURL}::${callerSource || "default"}::${routeLimit}::${filteredCandidates.join(",")}`;
    if (panRouteCache.has(cacheKey)) {
        return panRouteCache.get(cacheKey);
    }

    const sample = (videos || []).find((x) => getFileId(x));
    if (!sample) {
        const fallback = filteredCandidates.length > 0 ? filteredCandidates : ["直连"];
        const result = fallback.slice(0, routeLimit);
        panRouteCache.set(cacheKey, result);
        return result;
    }

    const sampleFileId = getFileId(sample);
    const validRoutes = [];

    for (const routeName of filteredCandidates.slice(0, routeLimit)) {
        try {
            const playInfo = await OmniBox.getDriveVideoPlayInfo(shareURL, sampleFileId, routeName);
            if (hasValidPlayUrls(playInfo)) {
                validRoutes.push(routeName);
            }
        } catch (error) {
            logWarn("网盘线路有效性检测失败", { shareURL, routeName, error: error.message || String(error) });
        }
    }

    const result = validRoutes.slice(0, routeLimit);
    panRouteCache.set(cacheKey, result);
    logInfo("网盘线路有效性检测完成", {
        shareURL,
        callerSource,
        candidates: filteredCandidates,
        validRoutes: result,
        routeLimit,
    });
    return result;
}

function isBlockedLineName(name) {
    if (!name) {
        return false;
    }
    return String(name).includes("磁力");
}

/**
 * 把 "/py/160552-1-1.html" 这类播放页的路径，还原成 {videoId, lineIndex, episodeIndex}。
 * lineIndex / episodeIndex 均为 0 起算（与 playId 里的语义一致）。
 */
function parsePlayPagePath(pathOrUrl) {
    const value = String(pathOrUrl || "");
    const match = value.match(/\/py\/(\d+)-(\d+)-(\d+)\.html/);
    if (!match) {
        return null;
    }
    const videoId = match[1];
    const lineIndex = parseInt(match[2], 10) - 1;
    const episodeIndex = parseInt(match[3], 10) - 1;
    if (!Number.isFinite(lineIndex) || !Number.isFinite(episodeIndex) || lineIndex < 0 || episodeIndex < 0) {
        return null;
    }
    return { videoId, lineIndex, episodeIndex };
}

/**
 * 播放页把真实地址放在内联脚本的 `player_aaaa={...}` 里，url 字段就是直链。
 * 有些源会把多个地址用 $$$ 串起来，这里统一拆开；全部返回空的兜底再扫一遍现成的视频后缀链接。
 */
function extractPlayUrlsFromPage(html) {
    const source = String(html || "");
    if (!source) {
        return [];
    }

    let raw = "";
    const matched = source.match(/player_aaaa\s*=\s*(\{.*\})/);
    if (matched) {
        try {
            const parsed = JSON.parse(matched[1]);
            raw = String(parsed?.url || "");
        } catch {
            raw = "";
        }
    }

    if (!raw) {
        const hit = source.replace(/\\\//g, "/").match(/https?:\/\/[^\s"'<>\\]+?\.(m3u8|mp4|flv|mkv|ts|mov|webm|m4v)(\?[^\s"'<>\\]*)?/i);
        raw = hit ? hit[0] : "";
    }

    if (!raw) {
        return [];
    }

    const list = [];
    const seen = new Set();
    for (const piece of String(raw).replace(/\\\//g, "/").split(/\$\$\$/)) {
        const one = String(piece || "").trim();
        if (!one || !/^https?:\/\//i.test(one)) {
            continue;
        }
        if (seen.has(one)) {
            continue;
        }
        seen.add(one);
        list.push(one);
    }
    return list;
}

/**
 * 解析同一集的多个播放线路，全部作为候选地址返回（互为备份源）。
 * - 默认 MAX_PLAY_SOURCES=0：把详情页里的全部线路都解析出来
 * - 顺序上当前线路排第一（用户点哪条先给哪条），其余按站点原始线路顺序补齐
 * - 名称用站点真实线路名（西瓜 / 天堂 / 暴风…），与详情页线路列表一一对应
 * - 分批并发请求（PLAY_SOURCE_CONCURRENCY），失败/拿不到地址的直接跳过，
 *   绝不让单条线路拖垮整体
 * - 返回 [] 表示一条都没拿下，调用方应回退到嗅探
 */
function resolveLineCandidates(lineIndex, lineDirectory) {
    const directory = (Array.isArray(lineDirectory) ? lineDirectory : [])
        .filter((item) => item && Number.isFinite(Number(item.index)))
        .map((item) => Number(item.index))
        .filter((n) => n >= 0);

    const candidates = [];
    const seenLine = new Set();
    const push = (line) => {
        if (line < 0 || seenLine.has(line)) {
            return;
        }
        seenLine.add(line);
        candidates.push(line);
    };

    // 当前线路优先
    push(lineIndex);

    if (directory.length > 0) {
        // 有清单：其余线路按站点原始顺序全部补齐
        for (const line of [...directory].sort((a, b) => a - b)) {
            push(line);
        }
    } else {
        // 无清单：从当前线路往后顺延兜底
        for (let offset = 1; offset < MAX_LINE_SCAN_FALLBACK; offset += 1) {
            push(lineIndex + offset);
        }
    }

    return MAX_PLAY_SOURCES > 0 ? candidates.slice(0, MAX_PLAY_SOURCES) : candidates;
}

/**
 * 小批量并发：每批最多 PLAY_SOURCE_CONCURRENCY 个请求，避免一次打十几条被站点判突发。
 */
async function mapWithConcurrency(items, worker) {
    const concurrency = Math.max(1, PLAY_SOURCE_CONCURRENCY);
    const output = [];
    for (let start = 0; start < items.length; start += concurrency) {
        const batch = items.slice(start, start + concurrency);
        const settled = await Promise.allSettled(batch.map((item) => worker(item)));
        for (const outcome of settled) {
            if (outcome.status === "fulfilled") {
                output.push(outcome.value);
            }
        }
    }
    return output;
}

async function collectLinePlayUrls(route, lineDirectory = []) {
    const { videoId, lineIndex, episodeIndex } = route;
    const nameOfLine = (line) => {
        const hit = (Array.isArray(lineDirectory) ? lineDirectory : []).find((item) => Number(item?.index) === line);
        return String(hit?.name || `线路${line + 1}`);
    };

    const candidates = resolveLineCandidates(lineIndex, lineDirectory);

    const results = await mapWithConcurrency(candidates, async (line) => {
        const path = `/py/${videoId}-${line + 1}-${episodeIndex + 1}.html`;
        try {
            const { html } = await requestHtmlWithFailover(path, { timeout: PLAY_SOURCE_TIMEOUT });
            return { line, urls: extractPlayUrlsFromPage(html) };
        } catch (error) {
            logWarn("播放线路解析失败，跳过", { path, error: error?.message || String(error) });
            return { line, urls: [] };
        }
    });

    // 【v1.4.0】原先跨线路直接平铺、不去重：不同线路常返回同一个 m3u8
    //（extractPlayUrlsFromPage 只在单页内用 seen 去重），
    // 播放器里会出现 2~3 条同名同址的「备选」，用户以为切换其实没换。
    // 这里按地址全局去重，只保留首次出现的线路名。
    const seenGlobal = new Set();
    const result = [];
    for (const item of results) {
        const baseName = nameOfLine(item.line);
        const urls = item.urls || [];
        if (urls.length === 0) {
            continue;
        }
        urls.forEach((url, pos) => {
            if (seenGlobal.has(url)) return;
            seenGlobal.add(url);
            // 同一线路若吐出多个地址，追加序号区分（用「源」字样避免与集号混淆）
            result.push({ name: urls.length > 1 ? `${baseName} 源${pos + 1}` : baseName, url });
        });
    }
    logInfo("多线路播放地址解析完成", { videoId, lineIndex: lineIndex + 1, episodeIndex: episodeIndex + 1, 候选线路: candidates.map((n) => n + 1), 命中数: result.length });
    return result;
}

/**
 * 统一解析本次播放的弹幕列表（直解分支与嗅探分支共用）。
 * 依赖 DANMU_API，没配置就返回空数组；刮削元数据读取失败也不影响出片。
 */
async function resolvePlayDanmaku(params, playMeta) {
    let danmaku = [];
    if (!DANMU_API) {
        return danmaku;
    }

    let vodName = String(params.vodName || "").trim();
    let episodeName = String(params.episodeName || playMeta?.e || "").trim();
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
        logWarn("读取刮削元数据失败", { error: error?.message || String(error) });
    }

    const fileName = scrapedDanmuFileName || buildFileNameForDanmu(vodName, episodeName);
    if (fileName) {
        danmaku = await matchDanmu(fileName);
        if (danmaku.length > 0) {
            logInfo("弹幕匹配成功", { count: danmaku.length, fileName });
        }
    }
    return danmaku;
}

// ==================== 标准接口 ====================
// 【v1.4.2】首页短 TTL 缓存。
// 客户端每次切源都是新进程，首页会被反复打上游；实测首页 HTML 182KB、解析出 100+ 条要 1.3s 以上，
// 叠加域名池探活后单次 2.6~3.0s。加缓存后二次进入 <0.3s，与豆瓣/哔哩系对齐。
const HOME_CACHE_KEY = "qw:home:v1";
const HOME_CACHE_TTL_SECONDS = 300; // 5 分钟

async function readHomeCache() {
    const raw = await getCachedJSON(HOME_CACHE_KEY);
    if (!raw) return null;
    try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        // 空结果绝不采用（可能来自历史脏数据）
        if (parsed && Array.isArray(parsed.list) && parsed.list.length > 0) return parsed;
    } catch (error) {
        logWarn("首页缓存解析失败，按未命中处理", { error: error.message || String(error) });
    }
    return null;
}

async function writeHomeCache(value) {
    // 空结果绝不入缓存（项目铁律）
    if (!value || !Array.isArray(value.list) || value.list.length === 0) return;
    await setCachedJSON(HOME_CACHE_KEY, value, HOME_CACHE_TTL_SECONDS);
}

async function home(params) {
    try {
        const cached = await readHomeCache();
        if (cached) {
            logInfo("首页命中缓存", { count: cached.list.length });
            return cached;
        }
        const { html, host } = await requestHtmlWithFailover("/");
        // 首页裁到 60 条：站点首页返回 168 条，配小站图床(单张 400ms+)会一张张慢出，
        // 60 条已覆盖首屏+滚动两屏，其余走分类页按需加载
        const list = parseVideoList(html, host).slice(0, 60);
        logInfo("首页加载完成", { host, count: list.length });
        const result = {
            class: CLASSES,
            filters: FILTERS,
            list,
        };
        await writeHomeCache(result);
        return result;
    } catch (error) {
        logError("首页加载失败", error);
        return {
            class: CLASSES,
            filters: FILTERS,
            list: [],
        };
    }
}

async function category(params) {
    const categoryId = String(params.categoryId || "1");
    const page = parsePage(params.page, 1);
    const filters = parseFilters(params);

    try {
        const path = buildCategoryPath(categoryId, page, filters);
        const { html, host } = await requestHtmlWithFailover(path);
        const list = parseVideoList(html, host);
        logInfo("分类加载完成", { categoryId, page, host, count: list.length, filters });
        return {
            page,
            pagecount: list.length >= 20 ? page + 1 : page,
            total: list.length,
            list,
        };
    } catch (error) {
        logError("分类加载失败", error);
        return {
            page,
            pagecount: page,
            total: 0,
            list: [],
        };
    }
}

/**
 * 搜索结果快照。
 * 客户端聚合搜索通常给每个源一个较短的预算超时，而本站首次/会话失效后首次搜索要先过验证码
 * （约 5s、4 个请求），极端情况下会被判定为「无结果」。这里把成功的搜索结果落盘：
 * 空结果/失败时若命中快照就出昨日的片子，而不是给用户一个空列表。
 */
const SEARCH_SNAPSHOT_KEY_PREFIX = "qw:searchSnapshot:";
const SEARCH_SNAPSHOT_TTL_SECONDS = 12 * 3600;

function buildSearchSnapshotCacheKey(keyword, page) {
    // 关键：cache key 必须是纯 ASCII。若存储后端把 key 当文件名落地并把非 ASCII 字符归一化，
    // 所有中文关键词会塌缩成同一个 key（实测测试桩就塌成 "___"），
    // 结果就是搜「繁花」可能读回「沙丘」的快照。故这里做编码 + 超长截断。
    const raw = String(keyword || "").trim().slice(0, 64);
    let safe = "";
    for (const ch of raw) {
        safe += ch.codePointAt(0) > 127 ? encodeURIComponent(ch) : ch;
    }
    const tail = safe.length > 120 ? String(safe.length) + ":" + safe.slice(-60) : safe;
    return `${SEARCH_SNAPSHOT_KEY_PREFIX}${page}:${tail}`;
}

async function readSearchSnapshot(key) {
    try {
        let snap = await getCachedJSON(key);
        if (typeof snap === "string") {
            snap = safeJsonParse(snap, null);
        }
        if (snap && Array.isArray(snap.list) && snap.list.length > 0) {
            return snap;
        }
    } catch {
        // 快照不可用则忽略
    }
    return null;
}

/**
 * 搜索：走站内搜索页（/vs/-------------.html?wd=xx&page=N）。
 * 站点在会话未验证时会返回「系统安全验证」小页，此时过一次码即可，
 * 通过后同一 PHPSESSID 会话内持续免验证（Cookie 已落盘跨进程复用）。
 */
async function search(params) {
    const keyword = String(params.keyword || params.wd || "").trim();
    const page = parsePage(params.page, 1);

    if (!keyword) {
        logWarn("搜索关键词为空");
        return {
            page,
            pagecount: page,
            total: 0,
            list: [],
        };
    }

    const path = `/vs/-------------.html?wd=${encodeURIComponent(keyword)}&page=${page}`;
    const snapshotKey = buildSearchSnapshotCacheKey(keyword, page);
    const emptyResult = { page, pagecount: page, total: 0, list: [] };
    // 本次拿不到结果时的兜底：用上一次成功快照出片
    const fallbackToSnapshot = async (reason) => {
        const snap = await readSearchSnapshot(snapshotKey);
        if (snap) {
            logWarn("本次搜索无结果，改用快照出片", { reason, keyword, page, count: snap.list.length });
            return {
                page,
                pagecount: snap.pagecount || page,
                total: snap.total || snap.list.length,
                list: snap.list,
            };
        }
        return emptyResult;
    };

    try {
        let { html, host } = await requestHtmlWithFailover(path);

        if (isVerifyPage(html)) {
            logWarn("搜索触发安全验证，开始自动过码", { host, keyword });
            const passed = await passSearchCaptcha(host);
            if (passed) {
                // 同一会话重搜。站点偶发「黑洞式挂起」（既不返回也不被拒），
                // 实测重发一次通常立刻成功，故给一次带间隔的重试；
                // 重试失败时必须保留原 html 之外的内容，绝不能把验证页当结果。
                let retryHtml = "";
                for (let attempt = 1; attempt <= 2; attempt++) {
                    try {
                        retryHtml = await requestHtml(fixUrl(path, host), {
                            timeout: CAP_FETCH_TIMEOUT_MS,
                            headers: { Referer: `${host}/`, Origin: host },
                        });
                        if (retryHtml && !isVerifyPage(retryHtml)) {
                            html = retryHtml;
                            break;
                        }
                    } catch (retryError) {
                        logWarn("过码后搜索重试失败", { attempt, error: retryError?.message || String(retryError) });
                    }
                    retryHtml = "";
                    if (attempt < 2) await qwSleep(CAP_RETRY_GAP_MS);
                }
                if (!retryHtml) {
                    logWarn("过码后仍未拿到搜索结果页", { host, keyword });
                }
            } else {
                logWarn("自动过码未通过，本次搜索结果可能为空", { host, keyword });
            }
        }

        if (isVerifyPage(html)) {
            logWarn("仍处于安全验证页，放弃本次搜索", { host, keyword });
            return await fallbackToSnapshot("still_verify");
        }

        const list = parseSearchList(html, host);
        const hasNext = hasSearchNextPage(html, page);
        logInfo("搜索完成", { keyword, page, host, count: list.length, hasNext });

        if (list.length === 0) {
            return await fallbackToSnapshot("empty_parse");
        }

        const result = {
            page,
            pagecount: hasNext ? page + 1 : page,
            total: list.length,
            list,
        };
        // 空结果绝不入缓存，避免把空列表固化下来
        await setCachedJSON(snapshotKey, result, SEARCH_SNAPSHOT_TTL_SECONDS);
        return result;
    } catch (error) {
        logError("搜索失败", error);
        return await fallbackToSnapshot("exception");
    }
}

function parseDetailInfo(html, host) {
    const $ = cheerio.load(html || "");

    const title =
        $(".main-ui-meta h1").first().clone().children("span").remove().end().text().trim() ||
        $(".detail-title").first().text().trim() ||
        "";

    let typeName = "";
    const typeBox = html.match(/<div><span>类型：<\/span>[\s\S]*?<\/div>/);
    if (typeBox && typeBox[0]) {
        const names = [...typeBox[0].matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
        typeName = [...new Set(names)].join("/");
    }

    let area = "";
    const areaBox = html.match(/<div><span>地区：<\/span>[\s\S]*?<\/div>/);
    if (areaBox && areaBox[0]) {
        const names = [...areaBox[0].matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
        area = [...new Set(names)].join("/");
    }

    const showContent = $(".movie-introduce .zkjj_a").first().text().replace(/\s*\[展开全部\]/g, "").trim();
    const hideContent = $(".movie-introduce .sqjj_a").first().text().replace(/\s*\[收起部分\]/g, "").trim();

    const directorMatch = html.match(/<div>[\s\S]*?导演：[\s\S]*?<\/div>/);
    const director = directorMatch?.[0]?.match(/<a[^>]*>([^<]+)<\/a>/)?.[1] || "";

    return {
        vod_name: title,
        type_name: typeName || $(".main-ui-meta div:nth-child(9) a").first().text().trim(),
        vod_pic: normalizeImage($(".img img").first().attr("src"), host),
        vod_content: hideContent || showContent || $(".detail-content").first().text().trim() || "",
        vod_remarks: $(".otherbox").first().text().trim() || "",
        vod_year: ($(".main-ui-meta h1 span.year").first().text() || "").replace(/[()]/g, "").trim(),
        vod_area: area || $(".main-ui-meta div:nth-child(11) a").first().text().trim(),
        vod_actor: ($(".main-ui-meta div.text-overflow").first().text() || "").replace(/^主演：/, "").trim(),
        vod_director: director,
    };
}

function normalizeCollectLineName(name = "") {
    return String(name || "")
        .replace(/[\u00a0\u2000-\u200f\u2028-\u202f\u205f\u3000]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/\s+(\d+)$/u, "")
        .trim();
}

function formatPanSourceName(type = "", index = 0) {
    const baseName = String(type || "").trim() || "网盘";
    const suffix = index > 0 ? ` ${index + 1}` : "";
    return `${baseName}${suffix}`;
}

// ==================== 站点线路清单 ====================
// 播放页 /py/<vid>-<线路>-<集>.html 里只有当前这一集的 m3u8，并不带线路列表；
// 完整的线路名（西瓜 / 天堂 / 暴风 / …）只出现在详情页 /mv/<vid>.html 的 .py-tabs 里。
// 所以：detail 阶段顺手把 [{index, name}] 清单落盘，play 阶段直接读来把全部线路都解析出来。
// 万一读不到（缓存被清、或客户端拿旧的播放页直接调 play），就回头抓一次详情页现算。
const LINE_DIRECTORY_CACHE_PREFIX = "qiwei:lineDirectory";
const LINE_DIRECTORY_TTL_SECONDS = 12 * 3600;

/**
 * 从详情页 HTML 提取线路清单：[{index, name}]，index 为站点线路序号（0 起算）。
 * 重名线路会追加序号（与详情页里展示的名字保持一致），磁力线路直接剔除。
 */
function extractLineDirectory(html) {
    if (!html) {
        return [];
    }
    const $ = cheerio.load(html);
    const tabItems = $(".py-tabs li").toArray();
    const episodeContainers = $(".bd ul.player").toArray();
    const count = Math.min(tabItems.length, episodeContainers.length);
    const rawNames = tabItems.slice(0, count).map((tab, index) => normalizeCollectLineName($(tab).text().trim()) || `线路${index + 1}`);

    const duplicateStat = rawNames.reduce((acc, name) => {
        acc.set(name, (acc.get(name) || 0) + 1);
        return acc;
    }, new Map());
    const seen = new Map();
    const result = [];
    rawNames.forEach((baseName, index) => {
        const current = (seen.get(baseName) || 0) + 1;
        seen.set(baseName, current);
        const lineName = (duplicateStat.get(baseName) || 0) > 1 ? `${baseName} ${current}` : baseName;
        if (isBlockedLineName(lineName)) {
            return;
        }
        result.push({ index, name: lineName });
    });
    return result;
}

function buildLineDirectoryCacheKey(videoId) {
    return buildCacheKey(LINE_DIRECTORY_CACHE_PREFIX, videoId);
}

async function saveLineDirectory(videoId, html) {
    const directory = extractLineDirectory(html);
    if (!videoId || directory.length === 0) {
        return directory;
    }
    await setCachedJSON(buildLineDirectoryCacheKey(videoId), directory, LINE_DIRECTORY_TTL_SECONDS);
    return directory;
}

async function loadLineDirectory(videoId) {
    if (!videoId) {
        return [];
    }
    let cached = await getCachedJSON(buildLineDirectoryCacheKey(videoId));
    if (typeof cached === "string") {
        cached = safeJsonParse(cached, null);
    }
    if (Array.isArray(cached) && cached.length > 0) {
        return cached
            .filter((item) => item && Number.isFinite(Number(item.index)))
            .map((item) => ({ index: Number(item.index), name: String(item.name || `线路${Number(item.index) + 1}`) }));
    }
    try {
        const { html } = await requestHtmlWithFailover(`/mv/${videoId}.html`, { timeout: PLAY_SOURCE_TIMEOUT });
        return await saveLineDirectory(videoId, html);
    } catch (error) {
        logWarn("线路清单读取失败，回退顺序顺延", { videoId, error: error?.message || String(error) });
        return [];
    }
}

async function parsePlaySources(html, videoId, host, callerSource = "", context = {}) {
    const $ = cheerio.load(html || "");
    const playSources = [];

    const episodeContainers = $(".bd ul.player").toArray();
    // 线路清单统一由 extractLineDirectory 产出（0 起算的站点序号 + 展示名，已剔除磁力线路），
    // play() 那边用的是同一份逻辑，保证详情页线路与播放返回的线路名一一对应。
    const directory = extractLineDirectory(html);

    for (const entry of directory) {
        const i = entry.index;
        const lineName = entry.name;

        const episodes = [];
        $(episodeContainers[i])
            .find("a")
            .each((idx, node) => {
                const name = $(node).text().trim() || `第${idx + 1}集`;
                const fid = `${videoId}#${i}#${idx}`;
                episodes.push({
                    name,
                    playId: `${videoId}|${i}|${idx}|||${encodeMeta({ sid: String(videoId || ""), fid, e: name })}`,
                    _fid: fid,
                    _rawName: name,
                });
            });

        if (episodes.length === 0) {
            const fid = `${videoId}#${i}#0`;
            episodes.push({
                name: "正片",
                playId: `${videoId}|${i}|0|||${encodeMeta({ sid: String(videoId || ""), fid, e: "正片" })}`,
                _fid: fid,
                _rawName: "正片",
            });
        }

        playSources.push({
            name: lineName,
            episodes,
        });
    }

    // ===== 网盘解析（ENABLE_PAN_PARSE 开关控制，默认关闭）=====
    if (ENABLE_PAN_PARSE) {
        // 网盘链接
        const panRegex = /https?:\/\/(pan\.baidu\.com|pan\.quark\.cn|drive\.uc\.cn|cloud\.189\.cn|yun\.139\.com|alipan\.com|pan\.aliyun\.com|115\.com|115cdn\.com)\/[^"'\s>]+/g;
        const htmlPanLinks = html.match(panRegex) || [];
        const anchorPanLinks = $("a")
            .toArray()
            .flatMap((a) => {
                const links = [];
                const href = $(a).attr("href") || "";
                const clipboard = $(a).attr("data-clipboard-text") || "";
                if (isPanUrl(href)) {
                    links.push(href);
                }
                if (isPanUrl(clipboard)) {
                    links.push(clipboard);
                }
                return links;
            });

        const allPanLinks = [...new Set([...htmlPanLinks, ...anchorPanLinks])];
        const grouped = {};

        for (const link of allPanLinks) {
            const type = parsePanType(link);
            if (type === "其他") {
                continue;
            }
            if (!grouped[type]) {
                grouped[type] = [];
            }
            grouped[type].push(link);
        }

        for (const [type, links] of Object.entries(grouped)) {
            const maxRoutesPerLink = Math.max(1, MAX_PAN_VALID_ROUTES);
            const maxShareCount = maxRoutesPerLink;
            let builtShareCount = 0;

            for (let index = 0; index < links.length; index++) {
                if (builtShareCount >= maxShareCount) {
                    logInfo("已达到同类网盘分享阈值，跳过后续分享", { type, maxShareCount, skipped: links.length - index });
                    break;
                }

                const link = links[index];
                const shareURL = normalizeShareUrl(link);
                if (!isPanUrl(shareURL)) {
                    continue;
                }

                const sourceName = formatPanSourceName(type, builtShareCount);
                const driveTypeKey = parsePanTypeKey(shareURL);
                const multiRouteEnabled = driveTypeKey && DRIVE_TYPE_CONFIG.includes(driveTypeKey);

                const panInfo = await loadPanFiles(shareURL);
                const files = panInfo?.videos || [];
                if (!files.length) {
                    logInfo("网盘分享未解析到有效视频文件，跳过当前分享", { type, shareURL });
                    continue;
                }

                const panEpisodes = [];

                for (const file of files) {
                    const fileId = getFileId(file);
                    if (!fileId) {
                        continue;
                    }
                    const fileName = getFileName(file) || sourceName;
                    const fid = `${videoId}#pan#${builtShareCount}#${fileId}`;
                    const combinedId = `${shareURL}|${fileId}|||${encodeMeta({ sid: String(videoId || ""), fid, e: fileName })}`;
                    panEpisodes.push({
                        name: fileName,
                        playId: combinedId,
                        _fid: fid,
                        _rawName: fileName,
                    });
                }

                if (panEpisodes.length === 0) {
                    logInfo("网盘分享视频文件缺少可用 fileId，跳过当前分享", { type, shareURL, files: files.length });
                    continue;
                }

                if (!multiRouteEnabled) {
                    playSources.push({
                        name: sourceName,
                        episodes: panEpisodes.map((ep) => ({
                            name: ep.name,
                            playId: ep.playId,
                            _fid: ep._fid,
                            _rawName: ep._rawName,
                        })),
                    });
                    builtShareCount += 1;
                    continue;
                }

                const validRoutes = await detectValidPanRoutes(shareURL, files, callerSource, context, maxRoutesPerLink);
                if (validRoutes.length === 0) {
                    logInfo("网盘分享未检测到有效播放路线，跳过当前分享", { type, shareURL });
                    continue;
                }

                for (const routeName of validRoutes.slice(0, maxRoutesPerLink)) {
                    playSources.push({
                        name: `${sourceName} ${routeName}`,
                        episodes: panEpisodes.map((ep) => ({
                            name: ep.name,
                            playId: ep.playId,
                            _fid: ep._fid,
                            _rawName: ep._rawName,
                        })),
                    });
                }
                builtShareCount += 1;
            }
        }
    }

    if (playSources.length === 0) {
        playSources.push({
            name: "默认线路",
            episodes: [
                {
                    name: "正片",
                    playId: `${videoId}|0|0|||${encodeMeta({ sid: String(videoId || ""), fid: `${videoId}#0#0`, e: "正片" })}`,
                    _fid: `${videoId}#0#0`,
                    _rawName: "正片",
                },
            ],
        });
    }

    logInfo("解析播放线路完成", { host, lines: playSources.length });
    return playSources;
}

function extractVideoId(urlOrId) {
    const value = String(urlOrId || "");
    const match = value.match(/\/mv\/(\d+)\.html/);
    return match ? match[1] : value;
}

async function detail(params, context = {}) {
    const inputId = params.videoId || "";
    const videoId = extractVideoId(inputId);

    if (!videoId) {
        logWarn("详情请求缺少有效 videoId", { inputId });
        return { list: [] };
    }

    const path = `/mv/${videoId}.html`;

    try {
        const { html, host } = await requestHtmlWithFailover(path);
        const info = parseDetailInfo(html, host);
        // 把本片的线路清单落盘，供 play() 把全部线路都解析出来（不阻塞主流程）
        saveLineDirectory(videoId, html).catch(() => {});
        const callerSource = resolveCallerSource(params, context);
        let playSources = await parsePlaySources(html, videoId, host, callerSource, context);

        let scrapeData = null;
        let videoMappings = [];
        let scrapeType = "";
        const scrapeCandidates = [];
        const seenFids = new Set();

        for (const source of playSources) {
            for (const ep of source.episodes || []) {
                if (!ep._fid) continue;
                if (seenFids.has(ep._fid)) continue;
                seenFids.add(ep._fid);
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
            ({ scrapeData, videoMappings, scrapeType } = await getMergedMetadataCached(
                String(videoId || ""),
                info.vod_name || "",
                scrapeCandidates
            ));
        }

        for (const source of playSources) {
            for (const ep of source.episodes || []) {
                const mapping = videoMappings.find((m) => m?.fileId === ep._fid);
                if (!mapping) continue;
                const newName = buildScrapedEpisodeName(scrapeData, mapping, ep.name);
                if (newName && newName !== ep.name) {
                    logInfo("应用刮削后源文件名", { old: ep.name, new: newName });
                    ep.name = newName;
                }
                ep._seasonNumber = mapping.seasonNumber;
                ep._episodeNumber = mapping.episodeNumber;
            }

            const hasEpisodeNumber = (source.episodes || []).some((ep) => ep._episodeNumber !== undefined && ep._episodeNumber !== null);
            if (hasEpisodeNumber) {
                source.episodes.sort((a, b) => {
                    const sa = a._seasonNumber || 0;
                    const sb = b._seasonNumber || 0;
                    if (sa !== sb) return sa - sb;
                    const ea = a._episodeNumber || 0;
                    const eb = b._episodeNumber || 0;
                    return ea - eb;
                });
            }
        }

        const normalizedPlaySources = sortPlaySourcesByDriveOrder(playSources).map((source) => ({
            name: source.name,
            episodes: (source.episodes || []).map((ep) => ({
                name: ep.name,
                playId: ep.playId,
            })),
        }));

        const vod = {
            vod_id: videoId,
            ...info,
            vod_play_sources: normalizedPlaySources,
        };

        if (scrapeData) {
            vod.vod_name = scrapeData.title || vod.vod_name;
            if (scrapeData.posterPath) {
                vod.vod_pic = `https://image.tmdb.org/t/p/w500${scrapeData.posterPath}`;
            }
            if (scrapeData.overview) {
                vod.vod_content = scrapeData.overview;
            }
            if (scrapeData.releaseDate) {
                vod.vod_year = String(scrapeData.releaseDate).substring(0, 4) || vod.vod_year || "";
            }
            const actors = (scrapeData.credits?.cast || []).slice(0, 5).map((c) => c?.name).filter(Boolean).join(",");
            if (actors) {
                vod.vod_actor = actors;
            }
            const directors = (scrapeData.credits?.crew || [])
                .filter((c) => c?.job === "Director" || c?.department === "Directing")
                .slice(0, 3)
                .map((c) => c?.name)
                .filter(Boolean)
                .join(",");
            if (directors) {
                vod.vod_director = directors;
            }
        }

        return {
            list: [vod],
        };
    } catch (error) {
        logError("详情解析失败", error);
        return { list: [] };
    }
}

async function play(params, context = {}) {
    let playId = String(params.playId || "").trim();
    const flag = String(params.flag || "").trim();
    const callerSource = resolveCallerSource(params, context);
    let playMeta = {};

    logInfo("开始播放解析", { playId, flag });

    if (!playId) {
        return {
            urls: [{ name: "解析失败", url: "" }],
            parse: 1,
            header: {
                ...DEFAULT_HEADERS,
                Referer: `${getCurrentHost()}/`,
            },
        };
    }

    if (playId.includes("|||")) {
        const [mainPlayId, metaB64] = playId.split("|||");
        playId = mainPlayId;
        playMeta = decodeMeta(metaB64 || "");
        logInfo("解析透传信息", { sid: playMeta.sid || "", fid: playMeta.fid || "", e: playMeta.e || "" });
    }

    if (ENABLE_PAN_PARSE && playId && playId.includes("|")) {
        const [rawShareURL, fileId] = playId.split("|");
        const shareURL = normalizeShareUrl(rawShareURL);
        if (shareURL && fileId && isPanUrl(shareURL)) {
            try {
                const routeType = resolveRouteType(flag, callerSource, context);
                logInfo("网盘播放路线解析", { shareURL, fileId, flag, callerSource, routeType });
                const playInfoPromise = OmniBox.getDriveVideoPlayInfo(shareURL, fileId, routeType);
                const metadataPromise = (async () => {
                    const result = {
                        danmakuList: [],
                        scrapeTitle: "",
                        scrapePic: "",
                        episodeNumber: null,
                        episodeName: String(params.episodeName || playMeta.e || "").trim(),
                    };

                    const videoIdForScrape = String(params.vodId || playMeta.sid || "").trim();
                    if (!videoIdForScrape) {
                        return result;
                    }

                    try {
                        const metadata = await OmniBox.getScrapeMetadata(videoIdForScrape);
                        if (!metadata || !metadata.scrapeData || !Array.isArray(metadata.videoMappings)) {
                            return result;
                        }

                        // 【v1.4.0 修复】这里原先用 `${shareURL}|${fileId}|${videoIdForScrape}` 去匹配 mapping.fileId，
                        // 但 detail 落盘时的 file_id 是 `${videoId}#pan#${shareCount}#${fileId}`（网盘分支），
                        // 两者格式完全不同 ⇒ mapping 恒为 undefined ⇒ 网盘影片的刮削剧名、集号、
                        // 弹幕全部失效，且每次白调一次 getScrapeMetadata。
                        // 正确做法：直接用 playMeta 透传的 fid（与本文件 1348 / 2254 行一致）。
                        const mapping = metadata.videoMappings.find((m) => m?.fileId === playMeta?.fid);
                        if (!mapping) {
                            return result;
                        }

                        const scrapeData = metadata.scrapeData;
                        result.scrapeTitle = scrapeData.title || "";
                        if (scrapeData.posterPath) {
                            result.scrapePic = `https://image.tmdb.org/t/p/w500${scrapeData.posterPath}`;
                        }
                        if (mapping.episodeNumber) {
                            result.episodeNumber = mapping.episodeNumber;
                        }
                        if (mapping.episodeName && !result.episodeName) {
                            result.episodeName = mapping.episodeName;
                        }

                        const fileName = buildScrapedDanmuFileName(
                            scrapeData,
                            metadata.scrapeType || "",
                            mapping,
                            String(params.vodName || playMeta.v || scrapeData.title || "").trim(),
                            result.episodeName
                        );
                        if (fileName) {
                            const matchedDanmaku = typeof OmniBox.getDanmakuByFileName === "function"
                                ? await OmniBox.getDanmakuByFileName(fileName)
                                : await matchDanmu(fileName);
                            if (Array.isArray(matchedDanmaku) && matchedDanmaku.length > 0) {
                                result.danmakuList = matchedDanmaku;
                            }
                        }
                    } catch (error) {
                        logWarn("读取网盘弹幕元数据失败", { error: error.message || String(error) });
                    }

                    return result;
                })();

                const [playInfoResult, metadataResult] = await Promise.allSettled([playInfoPromise, metadataPromise]);
                if (playInfoResult.status !== "fulfilled") {
                    throw playInfoResult.reason || new Error("无法获取播放地址");
                }

                const playInfo = playInfoResult.value;
                const urlList = Array.isArray(playInfo?.url) ? playInfo.url : [];
                logInfo("网盘播放信息返回", {
                    shareURL,
                    fileId,
                    flag,
                    callerSource,
                    routeType,
                    urlCount: urlList.length,
                    routeFlags: urlList.map((item) => item?.name || "播放").filter(Boolean),
                    hasHeader: !!playInfo?.header && Object.keys(playInfo.header || {}).length > 0,
                });
                const urlsResult = urlList.map((item) => ({
                    name: item.name || "播放",
                    url: item.url,
                }));
                if (urlsResult.length > 0) {
                    const header = playInfo?.header || {};
                    const shareURLLower = String(shareURL || "").toLowerCase();
                    const isUcDrive = shareURLLower.includes("drive.uc.cn") || shareURLLower.includes("pc-api.uc.cn") || shareURLLower.includes("uc.cn/s/");
                    logInfo("网盘播放结果出参", {
                        shareURL,
                        fileId,
                        flag,
                        callerSource,
                        routeType,
                        isUcDrive,
                        headerKeys: Object.keys(header || {}),
                        urlsPreview: urlsResult.map((item) => ({ name: item.name, url: String(item.url || "").slice(0, 160) })),
                    });

                    const metadataValue = metadataResult.status === "fulfilled" ? metadataResult.value : null;
                    const finalDanmaku = metadataValue?.danmakuList?.length ? metadataValue.danmakuList : (playInfo?.danmaku || []);

                    return {
                        urls: urlsResult,
                        header,
                        parse: 0,
                        danmaku: finalDanmaku,
                    };
                }
            } catch (error) {
                logWarn("网盘文件播放失败，回退 push", { shareURL, fileId, flag, callerSource, error: error.message || String(error) });
                const pushUrl = shareURL.startsWith("push://") ? shareURL : `push://${shareURL}`;
                return {
                    urls: [{ name: "网盘资源", url: pushUrl }],
                    parse: 0,
                    header: {},
                };
            }
        }
    }

    // 磁力直出
    if (playId.startsWith("magnet:")) {
        return {
            urls: [{ name: "磁力资源", url: playId }],
            parse: 0,
            header: {
                ...DEFAULT_HEADERS,
                Referer: `${getCurrentHost()}/`,
            },
        };
    }

    // 网盘走 push
    if (ENABLE_PAN_PARSE && isPanUrl(playId)) {
        const pushUrl = playId.startsWith("push://") ? playId : `push://${playId}`;
        return {
            urls: [{ name: "网盘资源", url: pushUrl }],
            parse: 0,
            header: {},
        };
    }

    // 常规剧集 ID: videoId|lineIndex|episodeIndex
    let resolvedPlayUrl = "";
    const parts = playId.split("|");
    if (parts.length === 3 && parts.every((x) => x !== "")) {
        const videoId = parts[0];
        const lineIndex = parseInt(parts[1], 10);
        const episodeIndex = parseInt(parts[2], 10);

        if (Number.isFinite(lineIndex) && Number.isFinite(episodeIndex)) {
            resolvedPlayUrl = `${getCurrentHost()}/py/${videoId}-${lineIndex + 1}-${episodeIndex + 1}.html`;
        }
    }

    if (!resolvedPlayUrl) {
        resolvedPlayUrl = fixUrl(playId, getCurrentHost());
    }

    const defaultHeader = {
        ...DEFAULT_HEADERS,
        Referer: `${getCurrentHost()}/`,
        Origin: getCurrentHost(),
    };

    // 直接视频地址不再二次嗅探
    if (isDirectVideoUrl(resolvedPlayUrl)) {
        logInfo("检测到直链视频，直接返回", { url: resolvedPlayUrl });
        return {
            urls: [{ name: "默认线路", url: resolvedPlayUrl }],
            parse: 0,
            header: defaultHeader,
        };
    }

    // 常规播放页：页面里自带真实直链，直接解开并把多条线路的地址一起返回
    const playRoute = parsePlayPagePath(resolvedPlayUrl);
    if (playRoute) {
        try {
            // 线路清单来自 detail 阶段落盘的缓存；读不到会自行抓一次详情页现算
            const lineDirectory = await loadLineDirectory(String(playRoute.videoId || ""));
            const urls = await collectLinePlayUrls(playRoute, lineDirectory);
            if (urls.length > 0) {
                const danmaku = await resolvePlayDanmaku(params, playMeta);
                logInfo("多线路直链解析成功，出片", { count: urls.length, first: urls[0]?.url });
                return {
                    urls,
                    parse: 0,
                    header: defaultHeader,
                    danmaku,
                };
            }
            logWarn("多线路直链均未命中，回退嗅探", { url: resolvedPlayUrl });
        } catch (error) {
            logWarn("多线路直链解析异常，回退嗅探", { error: error?.message || String(error) });
        }
    }

    // 非视频后缀：走嗅探提取真实地址
    try {
        logInfo("检测到非视频格式，开始嗅探", { url: resolvedPlayUrl });
        const sniffed = await OmniBox.sniffVideo(resolvedPlayUrl);
        if (sniffed && sniffed.url) {
            logInfo("嗅探成功", { url: sniffed.url });

            let danmaku = [];
            if (DANMU_API) {
                let vodName = String(params.vodName || "").trim();
                let episodeName = String(params.episodeName || playMeta.e || "").trim();
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
                    logWarn("读取刮削元数据失败", { error: error.message || String(error) });
                }

                const fileName = scrapedDanmuFileName || buildFileNameForDanmu(vodName, episodeName);
                if (fileName) {
                    danmaku = await matchDanmu(fileName);
                    if (danmaku.length > 0) {
                        logInfo("弹幕匹配成功", { count: danmaku.length, fileName });
                    }
                }
            }

            return {
                urls: [{ name: "嗅探线路", url: sniffed.url }],
                parse: 0,
                header: sniffed.header || defaultHeader,
                danmaku,
            };
        }
        logWarn("嗅探未返回有效直链，回退解析页", { url: resolvedPlayUrl });
    } catch (error) {
        logWarn("嗅探失败，回退解析页", { error: error.message || String(error) });
    }

    return {
        urls: [{ name: "默认线路", url: resolvedPlayUrl }],
        parse: 1,
        header: defaultHeader,
    };
}


// ==================== 验证码自动过码（MacCMS 数字验证码） ====================
// 站点搜索页受数字验证码保护（fontSize=16、4 位纯数字、6 字体随机、±40° 旋转）。
// 内置离线识别器（60 个正立字模 + 旋转扫角 + ZNCC 匹配），单次成功率约 80-90%，
// 失败自动换一张重试（最多 3 次）；通过后 PHPSESSID 落盘复用，会话内免验证。

// ============================================================================
// MacCMS 数字验证码求解器（自包含，无外部依赖）
// 原理：PNG 解码（内嵌 inflate）→ 软 alpha 图 → 连通域分割（含粘连切分）
//       → 双线性旋转扫角 → 与 60 个正立字模（6字体×0-9, 24x32, 4bit）做 ZNCC
// 生成于离线校准：字号 21（GD 16pt@96dpi），角度 -40..40，背景 (243,251,254)
// ============================================================================

// ---- 60 个正立字模 base64（font-major: f0d0..f0d9, f1d0.., ...；每模 384B=512b64字符）----
var CAP_TPL_B64 = "BZ3//u7v/u7//aYAB63//u7v/u7//rgACb7//u7v/u7//ssACb7//t3e3d7u/ssACb3u7bu8u7ze7csACb3u65iZmJvd3coACb3u63VVVWru7ssACs7/+lIRETnv/tsACs7/+kEQADn//twACs7/+kEQADn//twACc7/+UEQADnu/tsACb3u6UEQADju7ssACb3u6UEAADjd7coACb3u6UEQADju7ssACs7/+UEQADnv/tsACs7/+kEQADn//twACs7/+kEQADn//twACs7/+UEQADnv/tsACb3u6UEQADju7csACbzd2UEAADjd3coACb3u6UEQADju7csACc7/+UEQADnu/tsACs7/+kEQADn//twACs7/+kEQADn//twACs7/+lIRETnv/tsACb3u63ZVVXru7ssACb3u7Kmqqazd7csACb3u7cvMzM3u7csACb7//t3e7d7u/tsACb7//u7v/u7//soABq3//u7v/u7//bgABIzv/u7v/u7//ZYAAABq3//u7v/9gwAAAABq3//u7v/9gwAAAABq3//u7v/9gwAAAABq3//u7v/9gwAAAABq3//u7v/9gwAAAABZzu7d3v/9gwAAAAA1Z3eazf/9gwAAAAABERFHrP/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAAAAAAAABIvf/9gwAAAAAAAABa3v/9lQAAAAAAAABs///9lgAAAAAAAABa3v/9lAAAAAAAAABHrf/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAAAAAAAAA3rP/9gwAABZ3//u7v/u7//aYAB63//u7v/u7//rgACb7//u7v/u7//ssACb7//t3e3d7u/ssACb3u7bu8u7ze7csACb3u65iZmJvd3coACb3u63VVVWru7ssACs7/+lIRETnv/tsAB4qqpzEAADn//twAA0RVUxAAADn//twAASIzMhEREUnu/tsAASNERENERGru7ssAACRmZmZmZnrd7coABGiqqpmqqqzu7ssAB5zu7d3e7d7v/tsACL7//u7v/u7//ssACb7//u7v/u7//soACs7//t3e3d3d7KgACb3u7KmZmZmZmGQACbzd2nVVVVVVVCEACb3u6mQzMzMzMhAACc7/+lIREREREQAACs7/+kEQAAAAAAAACs7/+kEQAAAAAAAACs7/+lIREREREREACb3u63ZVVVVVVVQACb3u7KmqqZqqqpgACb3u7cvMzMzMzLkACc7//t3e7d3u7csACs7//u7v/u7//twACs7//u7v/u7//twACs7//u7v/u7//twABZ3//u7v/u7//aYAB63//u7v/u7//rgACb7//u7v/u7//ssACb7//t3e3d7u/ssACb3u7bu8u7ze7csACb3u65iZmJvd3coACb3u63VVVWru7ssACs7/+lIRETnv/tsAB4qqpzEAADn//twAA0RVUxAAADn//twAAREiIREREUnu/tsAABEREjM0RGru7csAAAAAAkVmZnrd7boAAAAAA2iaqqzu7agAAAAABJze7d7u7ZYAAAAABa3v/u7//ZYAAAAABa3v/u7//ZYAAAAABJze3d7u/acAAAAAA2iZmazu7bgAAAAAAjRVVXrd3boAAREREiMzM1nu7csAAiIzMhEREUnu/tsABFVmZCEAADn//twAB4q7tzEAADn//twACb7/+lIRETnv/tsACb3u63ZVVXru7ssACKzd3Kmqqazd7csACb3u7cvMzM3u7csACb3//t3e7d7u/tsACb7//u7v/u7//soABq3//u7v/u7//bgABIzv/u7v/u7//ZYAAAAAAAAUi9//t0IAAAAAAAEmrO//t0IAAAAAABJIze//t0IAAAAAABNpze//t0IAAAAAACWKze7ut0IAAAAAADerzd7upkIAAAAAEUnM3e7ut0IAAAAAEmv+3u//t0IAAAAANYz+7v//t0IAAAAASL3+7v//t0IAAAABWs7+3u//t0IAAAASa97tze7ut0IAAAEjjO7cvN7up0IAAAE2ne7cq97ut0IAAAJZvv7bit//t0IAABN7zu3Ked//t0IAASWc39uYed//t0IAAjat79qHed//uFMQA2i93tqIis7uyXVABIq83cuZm83dyphgFqzN3ty7vN7u3LqQOM7d7u7t3e//7cywWd/t7//+7v///t3Am+/t7//+7v///t3AvO7d3u7u3u//7tyweJmIiZmarN7u25hwNERDRERGec7uuGUwIiIiIiIkac7uuFMQERERERETac//t0IQAAAAAAATad//t0IAAAAAAAATad//t0IAAAAAAAATad//t0IACs7//u7v/u7//twACs7//u7v/u7//twACs7//u7v/u7//twACb7//t3e3d3d7coACb3u7bu8u7u7u6kACb3u65iZmImZmYcACb3u63VVVUVVVUQACs7/+lIRERERERAACs7/+kEQAAAAAAAACs7/+kEQAAAAAAAACc7/+lIhERERERAACb3u6mREREREMyAACb3u64ZmZmZmZTEACb3u7KqqqqqqqXUACs7//t3e7d3e7bgACs7//u7v/u7//soACs7//u7v/u7//tsACb3u7d3e3d7v/tsABnmZmZmZmazu7csAA0VVVVVVVXrd3coAAzRERDMzM1nu7csAAjMzMiEREUnu/tsABFVmZCAAADn//twAB4q7tzEAADn//twACs7/+lIRETnv/tsACb3u63ZVVXru7ssACb3u7Kmqqazd7csACb3u7cvMzM3u7csACb7//t3e7d7u/tsACb7//u7v/u7//soABq3//u7v/u7//bgABIzv/u7v/u7//ZYABZ3//u7v/u7//aYAB63//u7v/u7//rgACb7//u7v/u7//ssACb7//t3e3d7u/ssACb3u7bu8u7ze7csACb3u65iZmJvd3coACb3u63VVVWru7ssACs7/+lIRETnv/tsACs7/+kEQACaqqpgACs7/+kEQABNVVUQACc7/+lIhERIzMiEACb3u6mREREREQyEACb3u64ZmZmZmZTEACb3u7KqqqqqqqXUACs7//t3e7d3e7agACs7//u7v/u7//soACs7//u7v/u7//tsACs7//t3e3d7v/tsACb3u7KmZmazu7csACbzd2nVVVXrd3coACb3u6mQzM1nu7csACc7/+lIREUnu/tsACs7/+kEQADn//twACs7/+kEQADn//twACs7/+lIRETnv/tsACb3u63ZVVXru7ssACb3u7Kmqqazd7csACb3u7cvMzM3u7csACb7//t3e7d7u/tsACb7//u7v/u7//soABq3//u7v/u7//bgABIzv/u7v/u7//ZYACs7//u7v/u7//rgACs7//u7v/u7//ZYACs7//u7v/u7//YMACb3u7d3e7u7u62EAB5vMy7u8zd3dyVEABniZmYiavN3cp0AAA0RVVUV4rN7rhjAAAAERERJGnO7rdCAAAAAAAAJYve7qUhAAAAAAAAJrze7ZQQAAAAAAAAOM3t3HMAAAAAAAARSd3cuVIAAAAAAAASWe3clkEAAAAAAAAle+7shDEAAAAAAAA3rP7schAAAAAAAABIvf7bYRAAAAAAAAFazv7JUAAAAAAAABFq3v24QAAAAAAAASN73euWMAAAAAAAATWLzdpkIAAAAAAAAlis3dlSEAAAAAAAAnvN3ekxAAAAAAAAE43d3ccwAAAAAAABJZ7u26YgAAAAAAACNq/uynQQAAAAAAACWL7tuFMQAAAAAAADec7cpiEAAAAAAAAEm97clREAAAAAAAAWve/bhAAAAAAAAAAnz//JYwAAAAAAAABJ3/+3QgAAAAAAAAB63/+lIQAAAAAAAABZ3//u7v/u7//aYAB63//u7v/u7//rgACb7//u7v/u7//ssACb7//t3e3d7u/ssACb3u7bu8u7ze7csACb3u65iZmJvd3coACb3u63VVVWru7ssACs7/+lIRETnv/tsACs7/+kEQADn//twACs7/+kEQADn//twACc7/+lIhEUnu/tsACb3u6mRERGru7csACK3u64ZmZnrd7boABpzu7Kqqqqzu7agABYzu/t3e7d7u7ZYABIzv/u7v/u7//ZYABIz//u7v/u7//ZYABZ3v/t3e3d7u/acAB6zu7KmZmazu7bgACKzd2nVVVXrd3boACb3u6mQzM1nu7csACc7/+lIREUnu/tsACs7/+kEQADn//twACs7/+kEQADn//twACs7/+lIRETnv/tsACb3u63ZVVXru7ssACb3u7Kmqqazd7csACb3u7cvMzM3u7csACb7//t3e7d7u/tsACb7//u7v/u7//soABq3//u7v/u7//bgABIzv/u7v/u7//ZYABZ3//u7v/u7//aYAB63//u7v/u7//rgACb7//u7v/u7//ssACb7//t3e3d7u/ssACb3u7bu8u7ze7csACb3u65iZmJvd3coACb3u63VVVWru7ssACs7/+lIRETnv/tsACs7/+kEQADn//twACs7/+kEQADn//twACc7/+lIhEUnu/tsACb3u6mRERGru7ssACb3u64ZmZnrd7coACb3u7Kqqqqzu7ssACc7//t3e7d7v/tsACb7//u7v/u7//twACL7//u7v/u7//twABpzu7d3e3d7v/tsAA2iZmZmZmazu7csAACRVVVVVVXrd3coAASNERDMzM1nu7csAAiMzMiEREUnu/tsABFVmZCAAADn//twAB4q7tzEAADn//twACs7/+lIRETnv/tsACb3u63ZVVXru7ssACb3u7Kmqqazd7csACb3u7cvMzM3u7csACb7//t3e7d7u/tsACb7//u7v/u7//soABq3//u7v/u7//bgABIzv/u7v/u7//ZYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkes7u7JUgAAAAADWKze7/7spQAAAAEmrf7t7v//6BAAAAOL3uuFjO//+SAAATfO/shBa9//+SAAAnvv/ZMQW9//+RAAJa3/6lIAbO//6AABSN//5yABfv/+xwACjO/9tRATn//9lQAUvv/8gwAmv//8YwBHz//6QgBK3//qMQBr3//oIQFc7/7IIAGO//7GABN+//2UEAOv//2UACau/+tiAAa///tjADnf/8kwAAnP//pCAlvv/pUQAAvf//ohFI3/3FEAAAzv//oiSc7+pjAAAAzv//tmjO7bYhAAAArf//7d7u2UIAAAAAat7//u26hSEAAAAAFqzv7sp0EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABWL7/7KAAAAAAABJGi97/6nAAAAAAASR6zv//2EAAAAESNGit7//+xyAAABI1ebze///spRAAEkVorO/////adAARR5q83v/////IUgATa+////////+2IQA1nO//7////+2VEQBIvv/+7v///9uDAAFazMuqrO///8hSAAJ8y6hmad///7YxAAFYh2U1et//7ZQRAAEjMiImrO//23IAAAAAAAEnzv/+yVIAAAAAABJJ3v/+pjEAAAAAABR67//9gyAAAAAAACas//7bchAAAAAAACje//7JUAAAAAAAElnu//2mMAAAAAAAJHv///2DIAAAAAAANpz//utiEAAAAAAASM7//slBAAAAAAARWu7//acwAAAAAAAkfO///IQgAAAAAAA2nf//+lIQAAAAAABJvv/+2UEAAAAAAABs7//9tyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJZve7tlQAAAAAAFHq97v/+2lAAAAABOM7tzM7//ZAAAAATrf/IRGz//rAAAABI3v2DEmz//bAAAABr7tpQE43//ZAAAAFYq6YgN97/+1AAAAE0VVM0i///2SAAAAAAABFa7//+pQAAAAAAAlm9///bUgAAAAABNq3///2mIAAAAAAUrf///+lQAAAAABR73v//64QgAAAAAlnP///ttyEAAAABJ77v//63MQAAAAATe+///sljEAAAAAAn3////ZQiIRAAAAF87////ty7upMAAAW+/////////ZMAAArf////////+jEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATab3u7bhAAAAAACR6vN7//tyUAAAAEVnP/+7////HAAAANq3v/sze///JAAABWt/+yomt///IAAAUje/sYyRr//+1AAASWJmXMiWc/+2DAAAAABIiEkne/9lQAAAAAAFXiazu24QgAAAAAAJ77//+x0EAAAAAACWu////1zEAAAAAADabzf//2EEAAAAAACQ0We//6mEAAAAAABIROO//6mEAAAAAAAABN+//6VEARXeIUQACWu/+xiAAes3ekhATjP/9kwAAve7voxFIzv7ZQQAAzf//tmab7uyVEAAArf//7d3u/bcxAAAAat7v/+7cqGMQAAAAFZzv/tynQgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVrf/ZAAAAAAAAABN63v+1AAAAAAAAATa+//6SAAAAAAAAFJ3v/+1xAAAAAAADWc///+pQAAAAAAAWvv///9cwAAAAABSL3////sUQAAAAEkje/////aMAAAAAJa3v////+3IAAAATau//////+UEAAAA3z////v//5xAAACWc7//svO/+tQAAAlrf/+3Ii9/9gwAABr3v/slVjf/7QgAAOe///tp4rv/8hSEAa///////////+2IArf/////////+1yEAq8zMzN7//+3LlAAAMzMzNGr//6ZDIQAAAAAAAmv/7XIQAAAAAAAABL7/2lAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJs///////tAAAAABW+///////IAAAAATnv7czMzMyDAAAAAoz/xkMzMzMhAAAAJb7+oxAAAAAAAAAAWe/9kQAAAAAAAAASjP/+uId1IQAAAAAlv//+3d3JUgAAAABb3/////7txhAAABOO/+yqve//+CEAACfP/scxS9//+UEAABWKqVMROd//+TEAABNFVBAAOd//6CEAAAEREQAATO/+xgAAJFVVMQACbf/8gwAAWc3egxAVnv/6MQAAi+7ulBJJ3/6lEAAAnf//p0WN/tpSAAAAfP//7c3e7IQgAAAASc7v/+3bl0EAAAAABYzv/tuVMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACWKzu/spRAAAAACNprN7v/+2VAAAAAUe+7t3e///IAAAAJpzu2nZ8///aAAASat/9piI6///aAAAmrv/rUhE6///JAAFK3//aZFVYqYl1ABN9//65maqWMQAAACe+///czd3LlCAAATrv///+////2DEAA3z////c3v//6lEABq3//9uYm///62EAGO///6UyN+//6mEAOv//7HIRJ+//2EEAa///yUABOO//1iAAjP//tjACau/9pBAArf//tCATnf/qYgAArf//tTFIzv62IQAAnf//yHWL7tpzAAAAfP//7t3u/ZUhAAAASM3v/+7bp1IAAAAABIve/tyWMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfO/////////tAAASnv/////////IAAAlv/////////6kAABJ3////////+txAAA2iZmZrN//7KYwAAAAAAAAJr/+2DEAAAAAAAAUi9/bdBAAAAAAAAFIz+22EAAAAAAAABWt79pSAAAAAAAAAlne7ZUgAAAAAAAAFL7/2UAAAAAAAAABWd79lCAAAAAAAAAUnf/pUQAAAAAAAABJ3/21EAAAAAAAABN97+tiAAAAAAAAACe//tcQAAAAAAAAAlvf/YQAAAAAAAAABI3/60EAAAAAAAAAB87/tyAAAAAAAAAASu/+hBAAAAAAAAAAjP/tUQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATab3u/ttyAAAAACR6vN7v/+24AAAAAVnP/t3e///sAAAAJZ3u2mVq7//tAAABSd/+pyEp7//sAAASfe/9cxEp7//JAAAUnv/9dCRr//6lAAAmr//9l1jO/+xxAAAUnv/+3Lzu7JYwAAAUjv//////2VEAAAFHv///////2EEAASR73+7c3v//2EEAAlre/9uHi+//62EAFZ3/7ZZDWe//6mEAKe//2lAAFu//6VEAW///xzABOO/+xiAAnP//tCASau/9pAAAvf//tSE2vf/pUgAAvf//yGV63u2mIQAAnP//7t3e/thCAAAAWc3v/+7cuXQRAAAABIve7+24YwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASWL3u7slRAAAAACR5vN7//uyVAAAAAUjO7t3e///aAAAAJp3uyWZ8///sAAABWt/9lSI6///tAAAUnv/rQQEq///sAAA4z//IIAFK///bAAFM7/6VEANr///IAAN9//6UEBa9//+1ABSN//6VIknv//6SABWe///Kib3//+xxABSN///tze///9lQAAJt////7////7UgAAFIvN3dzf//7IMQAAATaaupiu//6VEAJXeJh2VFnP/9tiAASM3epSAUrf/rggAAa+7vtjJZzv7HMQAAe///yXac7tpzAAAAa///7t3u7JUhAAAAOM7v/+3Ll0IAAAAABZzu7tuGIQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJa3v/tuq3//+yCACe97//JZpz///6lAUv///6mI4z///+2A2z///6ENs7///+1BI3///50We////+jBa3///1knO////+RB87//+x2re///+2ACO///9uZm+///+xgKf///9u6iu///9pQOv///9vLaO///8hAa////+2Xee///8YgjP///+10e+///7QQrf///8lDnP///qIAzv///qUjrv//7YIA7///7XEUz///6mEAvf//7qZ53//ttzEAe+///+7v//7acgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABFIvu///////+piABFHve7//////+piAAE2rN7//////tlRAAA2nN7/////7tlAAAA2rN7/////7chAAAA3ve7////+3LdAAAA4zu/////+25YwABFIz//////+yoYwARJZ3//////+yXUgASNp3//////+uGQgATR63//////9p1MgAkWL3//////9pkIQAkeb7//////9lTIQA1is7//////9lBEAA2m97//////shBEAA3rN7/////7rcxAABIve/////+7acwAABIzu/////+3JYgAAFZ3v/////+y4UgAAFq7//////9ynUgAAJq7//////9uWQgAAR77//////9p1MQAAWL7//////8lkMQAAac7//////8lTIQAAis7//////8hCEQAAm97//////7cxEAAArN///////rcgAAAAvO/////+7aYgAAAA3e/////+3JUgAAAA7u/////+y4UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA63/////////62AAAkZnd3d3re///KAAAAAAAAAAXO///sAAAAAAAAAAbe///aAAAAAAAAABfv///IAAAAAAAAATn///+1ABNFVmZmZov///+jACas3u7u7u////6BA3re////////7clQBr7///7u7u7u24QQGN7//8p2ZmZmVDEQKf///7YgAAAAAAAASv///5QQAAAAAAAAe////4IQAAAAAAAAnP///3EAAAAAAAAAvf///7d3d3d2UhAA7v/////////+xiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABN73////////+yCATi97//Jd4v///6lAlv///6VETn///+2BIz///5zElr///+1A3q7u7pRA3v///+jASIzMzMQBJz///6RAAAAAAAABL3//+tgAAAAAAAABd///8cwAAAAAAABJ+///7UgEREREQABSe///7QQWJmZmVECau///7QQnP///3ECe////7QQvf//7WADnf///qIA3v//7FADrv//7YIA7///2lAUz///6mEAvf//7Jd53//ttzEAe+////////7acgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABa+///9lkn///+2ABau///8ZWr///+kABau///rRIz///+SACjO///JNK3///6BATrv//6mJc7//+xwA2z///6DJt///9pQBZ3//+1iN+///9hAB97//9tBSe///8YwKe///7cyau///7QgW////6UjjP///6MAnP///8mIvf///ZIAq93d3bqr7///7IEAVmZmZmVp3///6mEAIiIiIiJY3///2EEAAAAAAAFI3///1zEAAAAAAAFa7///xRAAAAAAAAF87//+tAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABHz////////////bAlz////bh3d3d3dlAUv///63IAAAAAAAAlz///6VEAAAAAAAA3z///6DEAAAAAAABZ3///5yEAAAAAAABr3///6nZmZmVUEAB87////u7u7u7JMQA2eIiIiIi+///rYwARERERAAJ+///8hAN5mZmWMRSO///8Ywa////5MSau///7QgnP///oECjP///qMQvf//7WADrf///ZIA3v//2lAUv///63EAvf//7Jd53//tt0EAjO////////7bcwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJa3v///////+2UACe97//Kd3d3d2ZCAUv///63MiIiIhEAA2z////cuqqqqXQgBI3///7bvO///rcwBa3///1zNs7//9pQB87//+tABc7//9tgCO///8lABd///9pQKf///7cwJu///9hAOv///6UhOO///8Ywa////5MRWe///7QgjP///4ESe+///6MQrf//7nACnP///pIAzv//7GADrv//7IEA7///2lAUz///6lEAvf//7Jd53//tpjEAe+////////7aYgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaKqqqqqrze////+lNFVVVVVXve///+6DABEREREUre///+1xAAAAAAE2vv///slQAAAAAAJp3////pUgAAAAABSc7///7HIQAAAAASa+///+yVEAAAAAAlnf///9ljAAAAAABJzv///schAAAAABJr7///7JUAAAAAACWN7///6WMAAAAAAEi+///+xzEAAAAAEWvf///slRAAAAAAI43////aYwAAAAAAN77///7HMQAAAAABW9///+2kEAAAAAAjje///9pjAAAAAAA2rv///8cxAAAAAAFaz///7JUhAAAAAAF97///2mIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJq3////////+yCACe97//Kd4v///6lAUv///6lISn///+2A2z///6EElr///+1BI3///5yE3v///+jBa3///1hA5z///6RBa3//+xQBL3//+tgBa3//+xABd///8cwBr7//8kxJ+///7UgF97//6YhSe///7QQWu///5QRWu///7QQjP///4ISe+///7QQrf//7nECnP///qIAzv//7GADrv//7YIA7///2lAUz///6mEAvf//7Jd53//ttzEAe+////////7acgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABas7////////+2UA2re//7Jd53///64Br3//+yTAEzv///bF97//+tyAWz////JKf///+piE33///+3Sv///9hBFJ3///+lav///9cxJq7///+Te////9YQOM7///+BnP///8UQOd7//+5wvf///rQAS+///9xg3v///ZMBXP///9pQ7v//7IMSbP///8hAzf///adnrf///7Ywe+///+7e7////6MgRomZmZms7////oIQARERERE4zv//7XEAJXd3d3eL3//tqEAAWv////////7bchAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACWL3v7sp0EAAAAANovN7//u25YwAAASa9///////9thAAA3ve///////+2TAAJb7/////////+2ABWd///////////ZASjO///tuqzu///cAUv////aUyfO///tA3z///6VIRWd///tBa3//+1hAAN8///uBs7//9pAAAN8///tCN7//7cwAASM///sGe///6UgAASt///bKf///5MQAAbO///aOv///4IQAAfu///ISv///4EAATj///+1Sv///3AAAlr///+jSv///5MRJa3//+2BSv///7ZDWN///+tgKf///9y6vO///8cwGe///////////aMQB97/////////6mIABZ3////////9pjAAAlvv///////qUgAAASas3u//7cqVIQAAAAFHre/+25UhAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABJ9///qYAAAAAAAATat///qUAAAAAAAEWrO///pQAAAABEjRpzv///oMAAAASNGi87////oIAACRVaJzu/////XEAAFm7zN7v////7WAAAH3/////////7GAAAX3////////+21AAAo7////////+yVAAA47////////+uEAABJ7////////+t0AABJ7////////9pjAABa7////////9lTAABHqqqr3////9hCAAASMzRGv////9cxAAAAAAAUr////8chAAAAAAElr////8YQAAAAAAE2v////8UAAAAAAAFHv////rUAAAAAAAJYz///7aQAAAAAAAJpz///7JQAAAAAAAJ63///24MAAAAAAAOL3///2nMAAAAAAAOd7///2WMAAAAAAAOe7///yFIAAAAAAASu////x0IAAAAAABW/////xzEAAAAAASW/////tiEAAAAAATbP////tREAAAAAAkfP////pBAAAAAAAljP///+pAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANqzu/tyFEAAAAAE3rN7//+7LdAAAABN87//////+xxAAASje////////6kAAA2v/////////+2AABc7///7u/////IAAJ+///qdnnf///HABSf//62MSXP//+1ACe///tzAAK+//+jACjO7ukxACXP/+2BACi8zMcQAUjf/9pQABNEREIAJZ3v/aUgAAAAAAEjat/+yWIAAAAAAAJa3v/rcxAAAAAAE1it7sqFMQAAAAABN73+3JUgAAAAAAA2rO7rhTIQAAAAABR73//rhlVVVUIQATnf/////u7u7sUgBIzv/////////9UQGN///////////8QAW+///////////rMAjP///////////qMAvf///////////ZIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABNpze/9yWMQAAAAJHq97v/+7blRAAABSc////////6TAAAVje////////+3AAE4z//////////aAAJc7//////////sABSN///tuqve///bABa+///JQiWd///aABarzMuEIRWt//+2ABWIiIgxESfO//6TAAIzMzM0eazu/slRAAAAAABHz////rYgAAAAAAFZ3////8cwAREREQFHrN7//9lQEjMzIhASNpz//+2BRoiIdjAAE3v///+Re///2lAAAlr///+SfP//7XIRJZz///+RfP///pQySN7///6Aa////9uqvO///+xgSv///////////9lAKe///////////rUgBr7////////+23IQA2z////////9tiEAATes3v//7tyoYxAAAAJIve/u3KdCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAmr///+RAAAAAAABNr3///6AAAAAAAACau///+1wAAAAAAA2rf///+xgAAAAABJq7////9pgAAAAADau/////9lQAAAAEmrf/////8hAAAAAJa7//+///8YwAAASat/+u+7//8UgAAAlr//seN7//7QQAAJq3/6nR+///6MAASWe/9tjN+///qIAAlrf7pUySO///ZIAFZ3/7YVFe+///aUyOe//26q73v///+2VW///7M3e//////+2e/////////////+ljP////////////+jrf////////////+Svf////////////+Rq8zMzMzN7///7cxwM0RERERY3///10QgAAAAAAAmz//+tAAAAAAAAAA33//9owAAAAAAAAFI3//9kwAAAAAAAAFZ3//8ggAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAbv/////////JAAASfv/////////IAAAUn/////////+2AAAmv/////////+1AAA5z/////////+kAABL7/////////+jAAFc///bqqqqqqphABN9//6VIREREREQABWe//6nZnd2VCAAABa+//6pze7tuFEAACje///d7v/+3JYwACrv/////////9pQAkv//////////+2BA3z//+7LvN7///+RBZ3//9t0NYz///+jA2iZmYYxEmr///+jAAERERAAAkn///+iAAAAAAABJIz///+RERERERESR87///6AVniJmaqqvO///+tgis3e7////////8hAe+7v/////////aQQWu/////////+2mIAGN7////////8lSAABHrN7//+7cunUgAAABWL3u/u25YxAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACWL3u7tuWMQAAAANovN7v/u3LpjAAASa9////////+1AAAnvu/////////aAAJb7//////////cABWd/////////u3cASjO///tuqqpmZiIAUv////JUxERERERA3z//+2nd3d2VCAABa3//+yGrO7tuEEAB87//+3L3v/+3JYwCO////7//////9pQKf///////////+2BOv///+7Lu87///+jSv///9t0NHv///+kW////7YxAkn///+1a////4EQASj///+ka////5MQE2v///+jW////7YyNr3///+SOv///9yqrN7//+1xKe///////////9tgF97//////////8YwBZ3/////////7JMQAlrv///////+yEEAASaLze///ty5dCAAAAAli97/7clzEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWv/////////////Ja//////////////Ie/////////////+2jP////////////+lnP////////////+Tvf///////////+2CrN3d3d3d7v///9thRWZmZmZmi9//7ZUwAAAAAAASWt7/2mEAAAAAAAAmre/tpSAAAAAAABJa3v/bYQAAAAAAACat7/62MQAAAAAAAkne/+yDEAAAAAAAFIzv/9lRAAAAAAABN77//rYxAAAAAAACWu//7IMQAAAAAAAVnP//2mEAAAAAAAAozv//xzEAAAAAAAJK7//+pBAAAAAAAAR8///sgwAAAAAAABat///aYgAAAAAAABju///XQQAAAAAAAkr////GIQAAAAAAA3v///60AAAAAAAABa3//+2TAAAAAAAABs7//+tyAAAAAAAAGO7//+liAAAAAAAAKf///9hBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUes3v7tyWIQAAASWKze7//+3LlRAAAlrv////////6TAAJa3/////////+3ABWe///////////aABjO///////////bACnv///cuqve///bACr///6nQiWd///ZACr///6EIRWt//+2ACrv//5zETe9//6SABat//7Kmaze/shRABSN/////////aUgABWd/////////rUgAljO/+3LvN7//8hABr3v/8lTNZz//+1xKN7//pQhEmr///+SW///7WAAATn///+jjP//7XIQFHv///+Srf///pQyN73///+Srf///9uqrO7//+1xnf///////////9pge////////////8YwSe7/////////7IMQFr7////////+xzEAA2m93v//7ty5YxAAABNpve//7KhSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE2m97v7bljEAAAAUebze///ty5YwAAFIz////////9phABSM7////////+2UACjO//////////+3Akvv///////////aA3z////bqqzv///sBZ3///6mMjfO///tBr7//+xzERWt///tB87//9pAAASc///uB87//9tRATfO///tBs7//+xzNHv////tBa3///7Lu87////bBIz////////////aAkrv///////////IASas3v/+3M3///+1AAFIre/tuXv///+SAAAjVnd3eK3//+2BAREREREjWN7//+tgNoiZmaqqvO///8cwWd3u7////////aQQSu//////////6mIAOe/////////9tjEABr7////////qYhAAA2m97v/+7cqFMQAAABR6zu/uyoUQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFpzv7slhAAAAAAAq////////ogAAAAf////+7////3AAAK///pMAAEn///oACP//wgAAAAAs//+AP//8EAAAAAABz//zr//zAAAAAAAAP//63//AAAAAAAAADP/9//+wAAAAAAAAC///3//AAAAAAAAADP/9r//zAAAAAAAAP//6P//8EAAAAAABz//zCf//wgAAAAAs//+AAK///pMAAEn///oAAAf////+7////3AAAAAq////////ogAAAAAAFpzv/slhAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAR3d3d1AAAAAAAAAVjMzMzIEAAAAAERJZz////6EAAAASNGm97////6EAAAVniazv/////6EAAAvv/////////6EAAArf/////////6EAAAi93d3f/////6EAAAV4h2WO/////6EAAAI0MyJd/////6EAAAAAAABN/////6EAAAAAAABN/////6EAAAAAAABN/////6EAAAAAAABN/////6EAAAAAAABN/////6EAAAAAAABN/////6EAAAAAAABN/////6EAAAAAAABN/////6EAAAAAAABN/////6EAAAAAAABN/////6EAAAAAAABN/////6EAAAiIiIiu/////9iIhk7u7u7v//////7u63///////////////H///////////////H///////////////HAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAmm83cunQQAAAtozne//////7rUACf/e7/////////6RPv////2VM0au///nF8////xiAAE4///9ATfO//61AAAV///+AAFHvv6TAAAo///7AAABR6gwAAON///UAAAAATIAE3rf/+pQAAAAAAEli9//63QAAAAAAUac7/7KdBESAAABR77/7bhSABaJAAAmzv/tpjAAAC//AAKe///YQzMzM1//AAjv///u7u7u7u//AD3/////////////AG3u7u7u7u7u7u//AAAAAAAAAAAAABd3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABN6zu/uyVIAAAAoRa3u/////uyCAACN3e///+7v///qMAPf///sdVVVeu/+kATP///pIAAAFK//sAJpvv/FF3dhA6/+oAABSLtxP//WWd/rUAAAACQgP//+///GEAAAAAAAP/////7IQQAAAAAAP///////6QAAAAAAP//1JI3//oAAAAWXMzMxASfv/9AAAFvtpQAAAAXf/+AABK7/xAAAAkrv/7AASu//2GZmeL7//VAAjf////7v///+txAAW+7e7///7t3JQAAABKpovN3cuXQgAAAAABEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAErd3d3dwAAAAAAABc//////4AAAAAABfP//////4AAAAAAY3/y////TMAAAAAKN/8V////AAAAAADnv+1F////AAAAABK7/tRB////AAAAAW+/7UQB////AAAAFv/+1EAB////AAAFs//tBAAB////BZQHf//lmZmav///n6wHv/////////////QC93d3d3d3v///93ABERERGd3i////nqBAAAAAJ7u7v///+7XAAAAAK/////////3AAAAAK/////////3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAr//QfN3d3d3d3d3d7//Qfv/////////////QWc7///7u7u7u///QE2z//7dmZmZmz//QADv//oM0VVVUiZmAACr//6eb3e3bhSEAABr//////////ZQQAAnu///u7u7///1gAAJHm9hSESSN///TAAARIyEQAAEWz//oAAADilEAAAACr//pAAA53scgAAACv//oAAOd//owAAE43//UADnf//uGVVet//2AAGz/////7v///sgQACje7u/////+6lEAAAF7ZZve7+24QQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATec3v/tyWMVmAAASd7u////7u3N7CAErv///+7//////oBK7//ah3ec////7IGd//x0EAAnzv/cljTf/9YhIiIketyEEAnv/rE3rN3cqFEAAAzv/sve7v/+7ttiAA7//+7///////7JQA////7KmIib3//+kw///+pjEAEljP//1w3//8IAAAAAJ///6wvv/qAAAAAABP///Afv/8IAAAAAFv//6gK+/+pjEAATfP//xQBr7/7Jh3eKz//9ggAWvv///+////7IMAAASd7v////7ttSAAAAATes3v7tuEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//+TAAAAAAAAAAAA///tzMzMzMzMzMzG///////////////n///////////////m///Zd3d3d3rv//2D///EAAAAAmrv/rYgzMykAAAAON//2UAAVVVBAAATrv/9ggAAAAAAAAE8///XEAAAAAAAAATf//1hAAAAAAAAAEz//+YQAAAAAAAABL///3IAAAAAAAAAOe//+zAAAAAAAAABff//5RAAAAAAAAAEr///sgAAAAAABVVZ3///plUgAAAADv////////9gAAAADv////////9gAAAADN3d3d3d3d1QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUes3v/tyWMQAAABa+7v/u7v/u2lAAAHzv/pVDNFnv/rYAAK7/7DEAABPO/+kAAJ7//EEAABTP/+oAAFvv/qdlVXrv/9cAABbP///u7v///ZIAATfO/u3d3d7v6UEAB9//6mMRETau/9ggbf/8URAAAAEVz/6zz//pEAAAAAABnv/q7//YAAAAAAAAjf/+z//pIAAAAAACnv/9ff/9dCEAABJI3//oGc7/64ZURWi+/+2SAVre7v/////u7aYQAAAlis3v7tynUgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASab3v/tynIQAAACat7u/////u2UAABJzv///+7////rYQKu//65h3d4m+/+tgfv/+lSEAABNZ7/6yz//sIAAAAAACz//m7//qEAAAAAABrv/r3//8IAAAAAACz//9nv/+tjIQASR77//+S+//7LqZmavf///+Ba3////////9///9ADe83u7u7ty67//rAAATeau8uXQ47//oAAABSWIREQFN///TAAAVztpgACa///2BAAJs//7Jmbzv/9ggACa////+7///7HMAADr//u///+7cpiAAACff66vNzLl0EAAAAAFskgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABN6zu7cqFIAAAABEjWc3d3cunQhAAABNFjO3MzMzKYyAAADVmjOuIiJrLhjAAAEmHjNhDJFi8uEAAAGunjNchAje9ylAAAX24jNchAkfO7GAAAX7IjNchAkjP7WAAAo7IjNchAkjP/XAAA57IjNchAkjP/nEABJ7IjNchAkjP/nEABJ7IjNchAkjP/nEABJ7IjNchAkjP/oEABJ7IjNchAkjP/oIABJ7IjNchAkjP/oIABJ7IjNchAkjP/oIABJ7IjNchAkjP/oIABJ7IjNchAkjP/oIABJ7IjNchAkjP/oIABJ7IjNchAkjP/oEABJ7IjNchAkjP/oEABJ7IjNchAkjP/nEAA57IjNchAkjP/nEAAo7IjNchAkjP/XAAAX7IjNchAkjP7WAAAX24jNcRAkjP7GAAAGuni8YRAkjO2lAAAEmGe8czJFneuEAAADZlesqIiavtljAAABNEaczMzN3scyAAABEjWKvN3dy5UhAAAAABNpve7uyWMAAAAAAAAAAX2UEAAAAAAAAAAAAX2UEAAAAAAAAAAAAX2UEAAAAAAAI1VVVq2UEAAAAAAAR7zMzN+kEAAAAAAASd7u7v+kEAAAAAAASM3d3e+kEAAAAAAANpq7ze+kEAAAAAAAE0V5vu+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAAAE2v/+kEAAAAAAAESNHv/+mMyEAAAAAJXdnv+25iHQQAAAAR7p4z+3MzLYQAAAASMuIz+7u7scQAAAASeyIz////9cgAAAAA1i97u7LcxAAAAABNYq83d3LlTMxAAADaKzMzMzMp1ZTAAAVmpmZiIm8uHiEAAA3y3ZmQkadyHq2AABJ63Z3MCSdyIvXEABJ7HeqUTSdyIzXEABJ7IjNYTSdyIznEAA43IjMYTWdyHzXEAAny3i7UTWdyHvXAAAUd1VmQlirp3q2AAABIiIiImqql3mVAAABERESRoqql2djAAAAAAACaZmrp2QyAAAAAAATjLm8p0MhAAAAAAElrsq+tiEQAAAAAAJHvsvNpREAAAAAAAN6zd3MgxAAAAAAABSdzN7KYgAAAAAAASa9zN63QQAAAAAAAkfO3N6UEQAAAAABNFe93cxzEjVkEAACVmes3slRE2rHEAAEiGes3qYxE2vXIAAWunet3YMQE2voIAAn23i9y2EAE3voIABI3InNp0EAE3voIABIzKrdlkIRJHrHEABHq8zcllVVVnmVEABGm97bl4iIiIh0EAA2nO7Lu7u7u7umEAA2rO663//////oIAAAACRpze7spzAAAAAAEkebzd3cuFIiAAAAI2q8zMzMymREAAABR5mquYmby3VoAAABfLh5liRp3IWcAAACjch5lQNZ3YWuAAADjsh7xhNZ3YavAAADjciL1xNZ3YavAAACa6d6pQNZ3YWuAAAAWYdohAJZ3YWdAAAAJUM0QgJZ3YRoAAAAAAAAAAJZ3HREAAAAAAATVVaJulIiAAAAAAAnqqu6pzAAAAAAAAA53d3cuVIQAAAAAAA67u7u7IUgAAAAAAA4zMzN3KdBAAAAAAATVVZ4q6lkAAAAAAAAAAI2mqqGAAAAAAAAAAJHvLqYAAAAAAAAAAJZ3sqpAAAAJUM0QgJZ3sqqAAAAWZdohAJZ3suqAAACa6d6tgNZ3sqqAAADjciL1xNZ3sqpAAADnsiLxhNZ3sqXAAADjsh5pQNZ3sqFAAACfbdoliRq3rljAAABa6dpuYms7aZBAAAASIZqzM3d7IQgAAAAJERpzd3cuFIQAAAAABJYze7rhSAAAAAAAAAAAjRouUEAAAAAAAAAFHdoqEEAAAAAAAAAFrloqEEQAAAAAAABONlouUEQAAAAAAASSepYylEQAAAAAAEjWvpY21EQAAAAABI0a/tp21EQAAAAABRWe/t521EQAAAAACeHe/t521EQAAAAAEm4e/t521EQAAAAE2vJe/t521EQAAAAJYzZe/t521EQAAAASKy4a/t521EQAAABW8uXavt521EQAAATfMl1Wvt521EQAAA2nbZEWvt521EQAABZvKQjWvt521EQAAF8unMTWvt521EQAAKNuFITWup521EQAAR6hSESR7hp21EQAAVoUhESNodp22IQAAqrqHd4mrlp3aiHQQ7v7u7u7vt53+7tgg7u7u7u7up53+7tcgzMzMzMzMlp3t3bcgiIiIiZq9pp3bmYUQMzMzNFe+p53HRDIAAAARI0avt523MhEAAAEkZ2a/tozKhlIAAAE2q4e/tovMyoQAAAE3vJe/t5zu25QAAAJHzZe/t53/7KUAAASe////////6CAAAASN7u7u7u7u1xAAAASMzMzMzMzMthAAAASNuJzd3d3dthAAAASepH3////txgAAAASek2zu7t3KdAAAAASek1rMzMuWMQAAAASek0Z3d3ZTEQAAAASekyIiIhERAAAAAASekyI0REMhAAAAAASekzV5qpdjAAAAAASek1i83cuVEQAAAASek2vu7u7HMQAAAASek1m7vNy4YwAAAASekyMzWKh4lAAAAAN7chAAJ5dZtgAAAAEkIQAAObh61wAAAAAAAAAAOcl75xAAAAAAAAAAOcl76BAAAAEAEiEQOcl76CAAAAMgSHUxOcl76CAAAAUgXLhSOcl76BAAAAYwXMpiOcl76BAAAAdAXMpyOcl75xAAAAdAW7hSOcl71wAAAAYxWpZCOch6tgAAAAQzWHZUWadolAAAAAI1VmZmeZZGYwAAAAE2iqq7vLdEMgAAAAA2ne7//shCAAAAAAATV4mZmHQhAAAAAAAAARM0MhAAAAAAAAAAFHre/tyWMAAAAAARNpvN3dyoUxAAAAASWbzMzMzKhTAAABI0asqIibqYh0AAACRWi8czJZhEeVAAADd3jMYRBJgyelAAAFmYnNcRBbkyi1AAAGu5ndchBspCelAAAX3JndchBagyaEAAAX7JnMchBIchRjAAAo62V3QRAkMRIxAAA56kEiIRAAAAAAAABJ6kNnd0E1QQAAAABJ6kWt3XJagwEQAABJ6kSLzHN8oxIyAABJ6kJFeGSNpBRjAABJ6lNFVVWdtCaEAABJ62aaY0WetCelAABJ7HjNckautDi2AABJ7HjNckautDjGEABJ7HjNckautDnHEABJ7HjNckautDnHEAA47HjNckautDnHEAAo63jNckautDnHEAAX23jNckautDnGEAAWy3jNckautCi2AAAFqWjNckautCelAAAEiGjNhFetpCaEAAACVVfOuJq8kxRjAAABI0e+3MzLgxNCAAAAEiWc3d3KcgEhAAAAABN6zu65YgAAAAAP/////////svMAAAO7u7u7u7t3My6AAAMzMzMzMzMu924AAAMupiIiIrMu92mAAANuGQiIie8u96UAAAOuFIAARfNvN2DAAAPuFIAATjdzN1xAAAPyFIAAknuzNxgAAAPyFIAFGre3MpQAAAOuFIAFYvd3KhAAAAHZCEAFrvN7JYwAAAAAAAAF9y87ZUgAAAAAAABKO287HMgAAAAAAABOf287GEQAAAAAAATWv3M21EAAAAAAAAUe/3MyUAAAAAAAAAlm+3MuDAAAAAAAAAnq83cljAAAAAAAAA4zL3shSAAAAAAAAFJ3L3rcxAAAAAAAAFK7b3rUhAAAAAAABNr7bzqQQAAAAAAACSM/bzZMAAAAAAAACac7cy4MAAAAAAAADes3dumIAAAAAAAAEm8zeuFIAAAAAAAAFrcvfpkEAAAAAAAEWzsvfpSEAAAAAAAE3zsvfkxAAAAAAAAJI3svOggAAAAAAAANp3cvMcgAAAAAAAASKzcy6YQAAAAAAAAABNqzu/tynMAAAABIzWc3d3dy5YyAAACRVjO3MzMzLlzAAAEiGjOuIiJrMuVAAAWynjNhDJFi93GAAAo3IjNchAje+7XEAA47IjNchAkfP/XEABJ7IjNhCAkfO7XEAA463e8qFEjas3XAAAn22aszHIzWKy2AAAVqWes3adUarqEAAADd2is3tyEa8hCAAACREeszN24iYUhAAAAEjWtu97clkIQAAAAASSczN7tuFIAAAAAABN7zu7u24QQAAAAESSLzdzf7bYxAAABI0asuqrO/tljAAACVVjNp3eu/+yVAAAEiGerdESM7+22EAAGymaZURFr3u7XIAAn23erYRFHre23MAA47IjNchAjfNynQABJ7IjNchATasy4QABJ7IjNchAkab3YMAA47IjNcRAkas7oMAAo3Ii8YRAke+7XEAAWyne8czJFne7GEAAEiGesqIiavuuEAAADVVeszMzd3tlSAAABMzWLzd3d3KYhAAAAARN6ze/uynMAAAAAAAJYve/bcwAAAAABIhNpvd3dlSEAAAACQySLvMzetzIAAAADdTSbqIi+x1QxAAAFqESbdDJ9yGZTAAAXyUWsYhBtyHiEAAAo2kWsYhBtyHmlAAA46kWsYhBtyHq2AABJ6kWsYhBtyIvWAABJ6kWsYhBtyIzXAABJ6kWsYhBtyIznEABJ6kWsYhBtyIzoEAA46kWsYhBtyIzoEAAo6kWsYhBtyIzoIAAWyUWsYiJZl3zoIAAFqEWsYjVVVXvoIAAEdjSbc1h1VGvoIAACMySbdYzLlWvoEAAAERN5dZ3dplvnEAAAAAFFQ1d3ZGvnEAAAAAAAABESM2vXAAACQxJEIABHdFrWAAAEdjR4QABspUnGAAAFqDSaUABttTilAAAG2kSrYRBttTeUAAAH2kSaUQBspCVzAAAGyUN4QABblBNCAAAFqVWIUzJrlBIhAAAEiZm7qIislBEQAAADab3d3d3MlBEAAAACNpvN7t25YxAAAAAAA2nO79yVMQAAAA";

// ---- base64 解码 ----
var CAP_B64 = (function () {
    var T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var tab = new Int16Array(128);
    for (var i = 0; i < 128; i++) tab[i] = -1;
    for (var j = 0; j < T.length; j++) tab[T.charCodeAt(j)] = j;
    return function (s) {
        var len = s.length, out = new Uint8Array(Math.floor(len / 4) * 3);
        var o = 0, buf = 0, bits = 0;
        for (var i = 0; i < len; i++) {
            var v = tab[s.charCodeAt(i) & 0x7f];
            if (v < 0) continue;
            buf = (buf << 6) | v; bits += 6;
            if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff; }
        }
        return out.subarray(0, o);
    };
})();

// ---- raw DEFLATE 解压（puff 风格） ----
function capInflateRaw(data, pos) {
    var p = pos || 0, bitbuf = 0, bitcnt = 0;
    function bits(n) {
        while (bitcnt < n) { bitbuf |= (data[p++] & 0xff) << bitcnt; bitcnt += 8; }
        var v = bitbuf & ((1 << n) - 1);
        bitbuf >>>= n; bitcnt -= n;
        return v;
    }
    function buildHuff(lengths) {
        var counts = new Int32Array(16), i;
        for (i = 0; i < lengths.length; i++) counts[lengths[i]]++;
        counts[0] = 0;
        var offs = new Int32Array(16);
        for (i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
        var symbols = new Int32Array(lengths.length);
        for (i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
        return { counts: counts, symbols: symbols };
    }
    function decodeSym(h) {
        var code = 0, first = 0, index = 0, len;
        for (len = 1; len <= 15; len++) {
            code |= bits(1);
            var count = h.counts[len];
            if (code - first < count) return h.symbols[index + (code - first)];
            index += count; first = (first + count) << 1; code <<= 1;
        }
        throw new Error("capInflate: bad code");
    }
    var LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
    var LEXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
    var DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
    var DEXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
    var out = new Uint8Array(4096), outLen = 0;
    function emit(b) {
        if (outLen === out.length) {
            var nb = new Uint8Array(out.length * 2); nb.set(out); out = nb;
        }
        out[outLen++] = b;
    }
    var fixedLit = null, fixedDist = null;
    function getFixed() {
        if (!fixedLit) {
            var ll = new Int32Array(288), i;
            for (i = 0; i < 144; i++) ll[i] = 8;
            for (i = 144; i < 256; i++) ll[i] = 9;
            for (i = 256; i < 280; i++) ll[i] = 7;
            for (i = 280; i < 288; i++) ll[i] = 8;
            fixedLit = buildHuff(ll);
            fixedDist = buildHuff(new Int32Array(30).fill(5));
        }
        return [fixedLit, fixedDist];
    }
    function block(litH, distH) {
        for (;;) {
            var sym = decodeSym(litH);
            if (sym < 256) { emit(sym); }
            else if (sym === 256) { return; }
            else {
                var k = sym - 257;
                if (k < 0 || k >= 29) throw new Error("capInflate: bad len sym");
                var length = LBASE[k] + bits(LEXT[k]);
                var ds = decodeSym(distH);
                if (ds < 0 || ds >= 30) throw new Error("capInflate: bad dist sym");
                var dist = DBASE[ds] + bits(DEXT[ds]);
                if (dist > outLen) throw new Error("capInflate: dist too far");
                for (var q = 0; q < length; q++) emit(out[outLen - dist]);
            }
        }
    }
    var final;
    do {
        final = bits(1);
        var type = bits(2);
        if (type === 0) {
            bitbuf = 0; bitcnt = 0;                       // 丢弃余位
            var len = data[p] | (data[p + 1] << 8);
            p += 4;                                       // LEN+NLEN
            for (var s = 0; s < len; s++) emit(data[p + s]);
            p += len;
        } else if (type === 1) {
            var f = getFixed(); block(f[0], f[1]);
        } else if (type === 2) {
            var hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
            var ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
            var cl = new Int32Array(19);
            for (var ci = 0; ci < hclen; ci++) cl[ORDER[ci]] = bits(3);
            var clH = buildHuff(cl);
            var lens = new Int32Array(hlit + hdist);
            var li = 0;
            while (li < hlit + hdist) {
                var sym2 = decodeSym(clH);
                if (sym2 < 16) lens[li++] = sym2;
                else if (sym2 === 16) {
                    if (li === 0) throw new Error("capInflate: no prev len");
                    var pv = lens[li - 1], rn = 3 + bits(2);
                    while (rn--) lens[li++] = pv;
                } else if (sym2 === 17) { var z1 = 3 + bits(3); while (z1--) lens[li++] = 0; }
                else { var z2 = 11 + bits(7); while (z2--) lens[li++] = 0; }
            }
            if (lens[256] === 0) throw new Error("capInflate: no EOB");
            block(buildHuff(lens.subarray(0, hlit)), buildHuff(lens.subarray(hlit)));
        } else {
            throw new Error("capInflate: bad block type");
        }
    } while (!final);
    return out.subarray(0, outLen);
}

// ---- PNG 解码（调色板/灰度/真彩，非隔行） ----
function capDecodePng(buf) {
    if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
        throw new Error("capPng: not a png");
    }
    var p = 8, w = 0, h = 0, bitDepth = 8, colorType = -1, interlace = 0;
    var palette = null, idat = [];
    while (p + 8 <= buf.length) {
        var len = (buf[p] << 24 | buf[p + 1] << 16 | buf[p + 2] << 8 | buf[p + 3]) >>> 0;
        var type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
        var dstart = p + 8;
        if (type === "IHDR") {
            w = (buf[dstart] << 24 | buf[dstart + 1] << 16 | buf[dstart + 2] << 8 | buf[dstart + 3]) >>> 0;
            h = (buf[dstart + 4] << 24 | buf[dstart + 5] << 16 | buf[dstart + 6] << 8 | buf[dstart + 7]) >>> 0;
            bitDepth = buf[dstart + 8]; colorType = buf[dstart + 9];
            interlace = buf[dstart + 12];
        } else if (type === "PLTE") {
            palette = buf.slice(dstart, dstart + len);
        } else if (type === "IDAT") {
            idat.push(buf.slice(dstart, dstart + len));
        } else if (type === "IEND") { break; }
        p = dstart + len + 4;
    }
    if (!w || !h || colorType < 0) throw new Error("capPng: missing IHDR");
    if (interlace) throw new Error("capPng: interlaced unsupported");
    var channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 4 ? 2 : 1;
    var raw = capInflateRaw(concatBufs(idat), 2);      // 跳过 zlib 头
    var bpp = Math.max(1, Math.floor((channels * bitDepth + 7) / 8));
    var stride = Math.floor((w * channels * bitDepth + 7) / 8);
    var img = new Uint8Array(h * stride);
    var q = 0, i, x, y, c;
    for (y = 0; y < h; y++) {
        var ft = raw[q]; q++;
        var line = raw.subarray(q, q + stride); q += stride;
        var prev = y > 0 ? img.subarray((y - 1) * stride, y * stride) : null;
        var cur = img.subarray(y * stride, (y + 1) * stride);
        for (i = 0; i < stride; i++) {
            var a = i >= bpp ? cur[i - bpp] : 0;
            var b = prev ? prev[i] : 0;
            var cc = prev && i >= bpp ? prev[i - bpp] : 0;
            var v = line[i], r;
            if (ft === 0) r = v;
            else if (ft === 1) r = (v + a) & 0xff;
            else if (ft === 2) r = (v + b) & 0xff;
            else if (ft === 3) r = (v + ((a + b) >> 1)) & 0xff;
            else {
                var pa = Math.abs(b - cc), pb2 = Math.abs(a - cc), pc = Math.abs(a + b - 2 * cc);
                var pred = (pa <= pb2 && pa <= pc) ? a : (pb2 <= pc ? b : cc);
                r = (v + pred) & 0xff;
            }
            cur[i] = r;
        }
    }
    // 展开为 RGB
    var rgb = new Uint8Array(w * h * 3);
    function idx(x, y) { return y * stride + Math.floor((x * channels * bitDepth) / 8); }
    function getChan(x, y, ch) {
        if (bitDepth === 8) return img[idx(x, y) + ch];
        // 子字节调色板位解包（bitDepth 1/2/4）
        var bitPos = (x * channels + ch) * bitDepth;
        var byte = img[y * stride + (bitPos >> 3)];
        var shift = 8 - bitDepth - (bitPos & 7);
        return (byte >> shift) & ((1 << bitDepth) - 1);
    }
    for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
            var o = (y * w + x) * 3;
            if (colorType === 3) {
                var pi = getChan(x, y, 0) * 3;
                rgb[o] = palette[pi]; rgb[o + 1] = palette[pi + 1]; rgb[o + 2] = palette[pi + 2];
            } else if (colorType === 0) {
                var g8 = bitDepth === 8 ? img[idx(x, y)] : Math.round(getChan(x, y, 0) * 255 / ((1 << bitDepth) - 1));
                rgb[o] = rgb[o + 1] = rgb[o + 2] = g8;
            } else if (colorType === 2) {
                rgb[o] = getChan(x, y, 0); rgb[o + 1] = getChan(x, y, 1); rgb[o + 2] = getChan(x, y, 2);
            } else if (colorType === 6) {
                rgb[o] = getChan(x, y, 0); rgb[o + 1] = getChan(x, y, 1); rgb[o + 2] = getChan(x, y, 2);
            } else if (colorType === 4) {
                var g82 = img[idx(x, y)];
                rgb[o] = rgb[o + 1] = rgb[o + 2] = g82;
            }
        }
    }
    return { w: w, h: h, rgb: rgb };
}

function concatBufs(list) {
    if (list.length === 1) return list[0];
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total), o = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; }
    return out;
}

// ---- 软 alpha 图 ----
function capAlphaMap(px) {
    var n = px.w * px.h, rgb = px.rgb;
    var freq = new Map();
    var keys = new Int32Array(n);
    for (var i = 0; i < n; i++) {
        var key = (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2];
        keys[i] = key;
        freq.set(key, (freq.get(key) || 0) + 1);
    }
    var bg = -1, bgCount = -1;
    freq.forEach(function (c, k) { if (c > bgCount) { bgCount = c; bg = k; } });
    var bgR = (bg >> 16) & 255, bgG = (bg >> 8) & 255, bgB = bg & 255;
    // 文字色：与背景曼哈顿距离 > 80 的最高频色
    var tr = -1, tg = -1, tb = -1, tCount = -1;
    freq.forEach(function (c, k) {
        var d = Math.abs(((k >> 16) & 255) - bgR) + Math.abs(((k >> 8) & 255) - bgG) + Math.abs((k & 255) - bgB);
        if (d > 80 && c > tCount) { tCount = c; tr = (k >> 16) & 255; tg = (k >> 8) & 255; tb = k & 255; }
    });
    if (tr < 0) return null;
    var vr = bgR - tr, vg = bgG - tg, vb = bgB - tb;
    var denom = vr * vr + vg * vg + vb * vb;
    if (denom <= 0) return null;
    var alpha = new Float32Array(n);
    for (var j = 0; j < n; j++) {
        var r = (keys[j] >> 16) & 255, g = (keys[j] >> 8) & 255, b = keys[j] & 255;
        var a = ((bgR - r) * vr + (bgG - g) * vg + (bgB - b) * vb) / denom;
        alpha[j] = a < 0 ? 0 : a > 1 ? 1 : a;
    }
    return { w: px.w, h: px.h, a: alpha };
}

// ---- 连通域分割 ----
function capSegments(am) {
    var w = am.w, h = am.h, a = am.a;
    var bin = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) bin[i] = a[i] > 0.30 ? 1 : 0;
    var seen = new Uint8Array(w * h);
    var comps = [];
    var stack = [];
    for (var sy = 0; sy < h; sy++) {
        for (var sx = 0; sx < w; sx++) {
            var s0 = sy * w + sx;
            if (!bin[s0] || seen[s0]) continue;
            var pts = [];
            stack.length = 0; stack.push(s0); seen[s0] = 1;
            var minX = sx, maxX = sx, minY = sy, maxY = sy;
            while (stack.length) {
                var cur = stack.pop();
                var cy = (cur / w) | 0, cx = cur - cy * w;
                pts.push(cur);
                if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
                if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
                for (var dy = -1; dy <= 1; dy++) {
                    var ny = cy + dy;
                    if (ny < 0 || ny >= h) continue;
                    for (var dx = -1; dx <= 1; dx++) {
                        var nx = cx + dx;
                        if (nx < 0 || nx >= w) continue;
                        var ni = ny * w + nx;
                        if (bin[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
                    }
                }
            }
            if (pts.length >= 6) {
                comps.push({ pts: pts, minX: minX, maxX: maxX, minY: minY, maxY: maxY });
            }
        }
    }
    comps.sort(function (p, q2) { return p.minX - q2.minX; });
    return comps;
}

// ---- 双线性旋转（undo deg） ----
function capRotate(crop, cw, ch, deg) {
    var out = new Float32Array(cw * ch);
    var r = -deg * Math.PI / 180;
    var cos = Math.cos(r), sin = Math.sin(r);
    var cy = (ch - 1) / 2, cx = (cw - 1) / 2;
    for (var y = 0; y < ch; y++) {
        var sy = y - cy;
        for (var x = 0; x < cw; x++) {
            var sx = x - cx;
            var ys = sy * cos - sx * sin + cy;
            var xs = sy * sin + sx * cos + cx;
            if (ys < 0 || ys > ch - 1 || xs < 0 || xs > cw - 1) continue;
            var y0 = Math.floor(ys), x0 = Math.floor(xs);
            var y1 = y0 + 1 > ch - 1 ? ch - 1 : y0 + 1;
            var x1 = x0 + 1 > cw - 1 ? cw - 1 : x0 + 1;
            var fy = ys - y0, fx = xs - x0;
            out[y * cw + x] =
                crop[y0 * cw + x0] * (1 - fy) * (1 - fx) +
                crop[y1 * cw + x0] * fy * (1 - fx) +
                crop[y0 * cw + x1] * (1 - fy) * fx +
                crop[y1 * cw + x1] * fy * fx;
        }
    }
    return out;
}

// ---- 双线性重采样到 tw x th 并居中 ----
function capNormalize(src, sw, sh, tw, th) {
    if (sw <= 0 || sh <= 0) return null;
    var s = Math.min(th / sh, tw / sw);
    var nw = Math.max(1, Math.round(sw * s)), nh = Math.max(1, Math.round(sh * s));
    var out = new Float32Array(tw * th);
    var ox = (tw - nw) >> 1, oy = (th - nh) >> 1;
    for (var j = 0; j < nh; j++) {
        var ys = (j * (sh - 1)) / (nh - 1 || 1);
        var y0 = Math.floor(ys), y1 = y0 + 1 > sh - 1 ? sh - 1 : y0 + 1;
        var fy = ys - y0;
        for (var i2 = 0; i2 < nw; i2++) {
            var xs = (i2 * (sw - 1)) / (nw - 1 || 1);
            var x0 = Math.floor(xs), x1 = x0 + 1 > sw - 1 ? sw - 1 : x0 + 1;
            var fx = xs - x0;
            var v =
                src[y0 * sw + x0] * (1 - fy) * (1 - fx) +
                src[y1 * sw + x0] * fy * (1 - fx) +
                src[y0 * sw + x1] * (1 - fy) * fx +
                src[y1 * sw + x1] * fy * fx;
            out[(oy + j) * tw + ox + i2] = v;
        }
    }
    return out;
}

// ---- 模板初始化 ----
var CAP_TW = 24, CAP_TH = 32, CAP_N = CAP_TW * CAP_TH;
var CAP_tm = null, CAP_invN = null;      // 每模板 (t-mean) 与 1/|t-mean|
function capInitTemplates() {
    if (CAP_tm) return;
    var raw = CAP_B64(CAP_TPL_B64);
    var NT = Math.floor(raw.length / (CAP_N >> 1));   // 每模板 CAP_N/2 字节（4bit）
    CAP_tm = new Float32Array(NT * CAP_N);
    CAP_invN = new Float32Array(NT);
    for (var k = 0; k < NT; k++) {
        var sum = 0, i;
        var base = k * (CAP_N >> 1);          // 每模板 CAP_N/2 字节（4bit 打包）
        for (i = 0; i < CAP_N; i++) {
            var b = raw[base + (i >> 1)];
            var v4 = ((i & 1) === 0 ? (b >> 4) : (b & 15)) / 15;
            CAP_tm[k * CAP_N + i] = v4;
            sum += v4;
        }
        var mean = sum / CAP_N, nrm = 0;
        for (i = 0; i < CAP_N; i++) {
            CAP_tm[k * CAP_N + i] -= mean;
            nrm += CAP_tm[k * CAP_N + i] * CAP_tm[k * CAP_N + i];
        }
        CAP_invN[k] = nrm > 0 ? 1 / Math.sqrt(nrm) : 0;
    }
}

// ---- 单字符识别：扫角 + ZNCC，返回 {digit, score} ----
function capMatchChar(alpha, w, h, pts) {
    capInitTemplates();
    var NT = CAP_invN.length;
    // 裁剪（pad 1）
    var minX = w, maxX = -1, minY = h, maxY = -1, i, q;
    for (i = 0; i < pts.length; i++) {
        var cur = pts[i], y = (cur / w) | 0, x = cur - y * w;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    minX = Math.max(0, minX - 1); maxX = Math.min(w - 1, maxX + 1);
    minY = Math.max(0, minY - 1); maxY = Math.min(h - 1, maxY + 1);
    var cw = maxX - minX + 1, chh = maxY - minY + 1;
    if (cw < 3 || chh < 3) return null;
    var crop = new Float32Array(cw * chh);
    for (var yy = 0; yy < chh; yy++) {
        for (var xx = 0; xx < cw; xx++) {
            crop[yy * cw + xx] = alpha[(minY + yy) * w + (minX + xx)];
        }
    }
    var best = null;
    for (var deg = -40; deg <= 40; deg += 4) {
        var rot = capRotate(crop, cw, chh, deg);
        // 旋转后的 bbox
        var bx0 = cw, bx1 = -1, by0 = chh, by1 = -1;
        for (i = 0; i < cw * chh; i++) {
            if (rot[i] > 0.15) {
                var ry = (i / cw) | 0, rx = i - ry * cw;
                if (rx < bx0) bx0 = rx; if (rx > bx1) bx1 = rx;
                if (ry < by0) by0 = ry; if (ry > by1) by1 = ry;
            }
        }
        if (bx1 < 0) continue;
        var sw = bx1 - bx0 + 1, sh = by1 - by0 + 1;
        if (sw < 3 || sh < 3) continue;
        var sub = new Float32Array(sw * sh);
        for (yy = 0; yy < sh; yy++) {
            for (xx = 0; xx < sw; xx++) sub[yy * sw + xx] = rot[(by0 + yy) * cw + (bx0 + xx)];
        }
        var nrm = capNormalize(sub, sw, sh, CAP_TW, CAP_TH);
        if (!nrm) continue;
        // ZNCC
        var sum = 0;
        for (i = 0; i < CAP_N; i++) sum += nrm[i];
        var mean = sum / CAP_N, nb = 0;
        for (i = 0; i < CAP_N; i++) { nrm[i] -= mean; nb += nrm[i] * nrm[i]; }
        nb = Math.sqrt(nb) || 1e-9;
        for (k = 0; k < NT; k++) {
            var dot = 0, base = k * CAP_N;
            for (i = 0; i < CAP_N; i++) dot += CAP_tm[base + i] * nrm[i];
            var sc = dot * CAP_invN[k] / nb;
            if (!best || sc > best.score) best = { score: sc, digit: k % 10 };
        }
    }
    return best;
}

// ---- 主入口：PNG Uint8Array -> {code, conf} 或 null ----
function capSolvePng(buf) {
    try {
        var px = capDecodePng(buf);
        if (px.w < 60 || px.w > 400 || px.h < 20 || px.h > 200) return null;
        var am = capAlphaMap(px);
        if (!am) return null;
        var comps = capSegments(am);
        var w = am.w, h = am.h;
        // 组件 > 4：合并 x 间距最小的相邻对
        while (comps.length > 4) {
            var bi = 0, bgap = Infinity;
            for (var i2 = 0; i2 < comps.length - 1; i2++) {
                var gap = comps[i2 + 1].minX - comps[i2].maxX;
                if (gap < bgap) { bgap = gap; bi = i2; }
            }
            comps[bi] = { pts: comps[bi].pts.concat(comps[bi + 1].pts),
                          minX: comps[bi].minX, maxX: comps[bi + 1].maxX,
                          minY: Math.min(comps[bi].minY, comps[bi + 1].minY),
                          maxY: Math.max(comps[bi].maxY, comps[bi + 1].maxY) };
            comps.splice(bi + 1, 1);
        }
        function compByX(a, b) { return a.minX - b.minX; }
        function splitWidest() {
            comps.sort(compByX);
            var wi = 0, wwid = -1;
            for (var k2 = 0; k2 < comps.length; k2++) {
                var wd = comps[k2].maxX - comps[k2].minX;
                if (wd > wwid) { wwid = wd; wi = k2; }
            }
            var blob = comps[wi];
            var colHas = {};
            for (var k3 = 0; k3 < blob.pts.length; k3++) {
                var yy3 = (blob.pts[k3] / w) | 0;
                colHas[blob.pts[k3] - yy3 * w] = 1;
            }
            var x0 = blob.minX, x1 = blob.maxX, bw = x1 - x0 + 1;
            var bestCut = null;
            for (var cut = x0 + Math.max(3, Math.floor(bw * 0.30));
                 cut <= x1 - Math.floor(bw * 0.30) + 1; cut++) {
                if (colHas[cut - 1] && colHas[cut]) continue;   // 实心列不切
                var L = [], R = [];
                for (var k4 = 0; k4 < blob.pts.length; k4++) {
                    var pt = blob.pts[k4], py = (pt / w) | 0, px2 = pt - py * w;
                    if (px2 < cut) L.push(pt); else R.push(pt);
                }
                if (L.length < 4 || R.length < 4) continue;
                var sL = capMatchChar(am.a, w, h, L), sR = capMatchChar(am.a, w, h, R);
                if (!sL || !sR) continue;
                var tot = sL.score + sR.score;
                if (!bestCut || tot > bestCut.tot) bestCut = { tot: tot, L: L, R: R };
            }
            if (bestCut) {
                comps[wi] = { pts: bestCut.L, minX: x0, maxX: bestCut.L.length ? 0 : 0, minY: blob.minY, maxY: blob.maxY };
                // 修正 maxX
                var m1 = -1, m2 = -1;
                for (var k5 = 0; k5 < bestCut.L.length; k5++) { var pxl = bestCut.L[k5] % w; if (pxl > m1) m1 = pxl; }
                for (var k6 = 0; k6 < bestCut.R.length; k6++) { var pxr = bestCut.R[k6] % w; if (pxr > m2) m2 = pxr; }
                comps[wi].maxX = m1;
                comps.splice(wi + 1, 0, { pts: bestCut.R, minX: blob.minX, maxX: m2, minY: blob.minY, maxY: blob.maxY });
            } else {
                var midCut = ((x0 + x1) >> 1);
                var LL = [], RR = [];
                for (var k7 = 0; k7 < blob.pts.length; k7++) {
                    var pt7 = blob.pts[k7] % w;
                    if (pt7 < midCut) LL.push(blob.pts[k7]); else RR.push(blob.pts[k7]);
                }
                comps[wi] = { pts: LL, minX: x0, maxX: midCut - 1, minY: blob.minY, maxY: blob.maxY };
                comps.splice(wi + 1, 0, { pts: RR, minX: midCut, maxX: x1, minY: blob.minY, maxY: blob.maxY });
            }
        }
        // 组件 < 4：反复切分最宽的粘连块
        while (comps.length < 4) {
            splitWidest();
        }
        comps.sort(compByX);
        if (comps.length !== 4) return null;
        var results = [];
        var confSum = 0;
        for (var c2 = 0; c2 < 4; c2++) {
            var m = capMatchChar(am.a, w, h, comps[c2].pts);
            if (!m) return null;
            results.push(m.digit);
            confSum += m.score;
        }
        return { code: results.join(""), conf: confSum / 4 };
    } catch (e) {
        return null;
    }
}


const CAP_COOKIE_CACHE_KEY = "qw:captcha:cookies:v1";
const CAP_COOKIE_TTL = 7 * 24 * 3600;   // 会话 cookie 缓存 7 天
const CAP_FETCH_TIMEOUT_MS = 10000;     // 单次抓码超时（短一点，失败靠重试补）
const CAP_RETRY_GAP_MS = 1200;          // 重试前的静默间隔：站点对突发敏感
const qwCookieJar = {};                  // origin -> { name: value }
let qwCookieLoaded = false;

function qwSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function qwOriginOf(url) {
    const m = String(url || "").match(/^https?:\/\/[^\/]+/i);
    return m ? m[0] : "";
}

async function qwEnsureCookiesLoaded() {
    if (qwCookieLoaded) return;
    qwCookieLoaded = true;
    try {
        const raw = await OmniBox.getCache(CAP_COOKIE_CACHE_KEY);
        if (raw) {
            const obj = JSON.parse(raw);
            if (obj && typeof obj === "object") {
                for (const k of Object.keys(obj)) qwCookieJar[k] = obj[k] || {};
            }
        }
    } catch {
        // 缓存不可用则从空开始
    }
}

async function qwSaveCookies() {
    try {
        await OmniBox.setCache(CAP_COOKIE_CACHE_KEY, JSON.stringify(qwCookieJar), CAP_COOKIE_TTL);
    } catch {
        // 忽略缓存写失败
    }
}

function qwMergeSetCookies(origin, setCookieArr) {
    if (!origin || !Array.isArray(setCookieArr)) return;
    if (!qwCookieJar[origin]) qwCookieJar[origin] = {};
    for (const sc of setCookieArr) {
        const pair = String(sc || "").split(";")[0] || "";
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (name) qwCookieJar[origin][name] = value;
    }
}

function qwCookieHeader(origin) {
    const jar = qwCookieJar[origin];
    if (!jar) return "";
    const pairs = Object.keys(jar).map((k) => `${k}=${jar[k]}`).join("; ");
    return pairs;
}

function isVerifyPage(html) {
    return typeof html === "string" && html.indexOf("系统安全验证") !== -1;
}

/** 抓验证码图片（返回 Uint8Array）。偶发黑洞式超时，故内置一次退避重取 */
async function fetchCaptchaImage(origin) {
    const url = `${origin}/index.php/verify/index.html?r=${Math.random()}`;
    let lastError = null;
    for (let i = 0; i < 2; i++) {
        try {
            const cookie = qwCookieHeader(origin);
            const response = await axiosInstance.get(url, {
                responseType: "arraybuffer",
                timeout: CAP_FETCH_TIMEOUT_MS,
                headers: {
                    ...DEFAULT_HEADERS,
                    Referer: `${origin}/`,
                    ...(cookie ? { Cookie: cookie } : {}),
                },
            });
            qwMergeSetCookies(origin, response.headers && (response.headers["set-cookie"] || response.headers["Set-Cookie"]));
            const body = Buffer.from(response.data);
            if (body.length > 100) return new Uint8Array(body);
            lastError = new Error(`验证码图过小 ${body.length}B`);
        } catch (error) {
            lastError = error;
        }
        if (i === 0) await qwSleep(CAP_RETRY_GAP_MS);
    }
    throw lastError || new Error("验证码图获取失败");
}

/** 提交验证码校验 */
async function submitVerifyCode(origin, code) {
    const cookie = qwCookieHeader(origin);
    const response = await axiosInstance.post(
        `${origin}/index.php/ajax/verify_check?type=search&verify=${encodeURIComponent(code)}`,
        null,
        {
            timeout: CAP_FETCH_TIMEOUT_MS,
            headers: {
                ...DEFAULT_HEADERS,
                Referer: `${origin}/`,
                "X-Requested-With": "XMLHttpRequest",
                ...(cookie ? { Cookie: cookie } : {}),
            },
        }
    );
    qwMergeSetCookies(origin, response.headers && (response.headers["set-cookie"] || response.headers["Set-Cookie"]));
    const text = String(response.data || "");
    return /["']?code["']?\s*[:=]\s*1\b/.test(text);
}

/** 自动过码：抓码→识别→校验，失败换一张重试（最多 3 次，逐次退避） */
async function passSearchCaptcha(origin) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) await qwSleep(CAP_RETRY_GAP_MS * attempt);
        try {
            const png = await fetchCaptchaImage(origin);
            const t0 = Date.now();
            const r = capSolvePng(png);
            if (!r || !r.code) {
                logWarn("验证码识别失败，换一张重试", { attempt, ms: Date.now() - t0 });
                continue;
            }
            const ok = await submitVerifyCode(origin, r.code);
            logWarn(`验证码识别 ${r.code} 置信=${r.conf.toFixed(3)} → ${ok ? "通过" : "服务器拒绝"}`, { attempt });
            if (ok) {
                // 过码会话必须落盘：客户端每次调用是新进程，进程内变量没有意义
                await qwSaveCookies();
                return true;
            }
        } catch (error) {
            logWarn("过码流程异常", { attempt, error: error?.message || String(error) });
        }
    }
    return false;
}

module.exports = { home, category, search, detail, play };

const runner = require("spider_runner");
runner.run(module.exports);
