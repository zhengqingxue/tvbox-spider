// @name 斗鱼直播
// @author 
// @description 关注直播间由环境变量 DOUYU_FOLLOWED_ROOMS 配置（逗号分隔房间号，可写 房间号:备注名）
// @dependencies: axios, crypto-js
// @version 1.3.0
// @downloadURL https://gh-proxy.org/https://github.com/MoraGG/OmniBox-Spider/raw/refs/heads/main/直播/斗鱼直播.js

/**
 * ============================================================================
 * 斗鱼直播 - OmniBox 爬虫脚本
 * ============================================================================
 * v1.1.0：新增环境变量 DOUYU_FOLLOWED_ROOMS，用房间号配置首页「关注直播间」
 *   - 例：DOUYU_FOLLOWED_ROOMS=3484,7546,660002
 *   - 支持备注名：DOUYU_FOLLOWED_ROOMS=3484:SCBOY,7546:Macsed
 *   - 不配置时回退到 DEFAULT_FOLLOWED_ROOMS
 *
 * v1.2.0：修复「直播只能播 30 多秒就停」
 *   - 原因：play() 返回了 header，OmniBox 前端会据此把播放地址包装成
 *     /api/spider-source/proxy-play?url=...，而后端代理对单个请求有 30 秒硬超时，
 *     到点即切断 HTTP-FLV 长连接（实测 30.00s 精确复现），前端 flv.js 又无自动重连。
 *   - 修复：默认不再返回 header，让播放器直连 CDN（斗鱼 CDN 已开启
 *     Access-Control-Allow-Origin: *，跨域可直接播）；需要走代理时设
 *     DOUYU_PLAY_VIA_PROXY=1 回退旧行为。
 *
 * v1.3.0：修复「每次播放到 5 分 03 秒左右卡住」
 *   - 原因：斗鱼 H5 接口返回的播放地址自带 expire 有效期参数，默认清晰度
 *     （rate>=4，蓝光 4M 及以上）给的地址是 expire=300 —— 连接跑到 300 秒时
 *     CDN 会主动关闭这条 HTTP-FLV 长连接（实测 300.33s 精确复现）；而 OmniBox
 *     前端 flv.js 对直播流不做自动重连（提前 EOF 会直接报错停止），于是画面停在
 *     300 秒出头（加上缓冲正是「5 分 03 秒」）。
 *   - 关键发现：request 里指定 rate=2/3（高清 900k / 超清 2000k）时，斗鱼返回的是
 *     expire=0 的长效地址，实测连续拉流 420 秒不被切断；rate>=4 恒定 expire=300。
 *   - 修复：play() 默认返回两条线路 ——
 *       ①超清 720P（expire=0 长效，不会断，默认播放）
 *       ②蓝光4M 1080P（画质更好，但地址 300 秒到期，到点需重进）
 *     也可用环境变量 DOUYU_RATE 锁定单一清晰度（如 DOUYU_RATE=3 / 高清 / 蓝光4M）。
 * ============================================================================
 */
const axios = require("axios");
const CryptoJS = require("crypto-js");
const OmniBox = require("omnibox_sdk");

// ========== 全局配置 ==========
const host = "https://m.douyu.com";
const did = "10000000000000000000000000001501";

const def_headers = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'
};

// ========== 分类映射 ==========
const categories = {
  'yqk': '娱乐天地',
  'LOL': '网游竞技',
  'TVgame': '单机热游',
  'wzry': '手游休闲',
  'yz': '颜值',
  'smkj': '科技文化',
  'yiqiwan': '语音互动',
  'yyzs': '语音直播',
  'znl': '正能量'
};

// ========== 日志工具 ==========
const logInfo = (message, data = null) => {
  const output = data ? `${message}: ${JSON.stringify(data)}` : message;
  OmniBox.log("info", `[DOUYU-DEBUG] ${output}`);
};

const logError = (message, error) => {
  OmniBox.log("error", `[DOUYU-DEBUG] ${message}: ${error.message || error}`);
};

// ========== 关注直播间（环境变量配置） ==========
// 优先环境变量 DOUYU_FOLLOWED_ROOMS / DOUYU_ROOMS，未配置时回退到下面的默认值
const FOLLOWED_ROOMS_ENV_KEYS = ["DOUYU_FOLLOWED_ROOMS", "DOUYU_ROOMS"];
const DEFAULT_FOLLOWED_ROOMS = "3484:SCBOY";

/**
 * 解析关注房间字符串
 * 支持格式：3484,7546 / 3484:SCBOY / 3484=SCBOY / 3484 SCBOY(换行、分号均可)
 * 只保留纯数字房间号，避免脏配置导致请求异常
 */
function parseFollowedRooms(raw) {
  if (!raw) return [];
  const list = [];
  const seen = {};
  String(raw)
    .split(/[,，;；\r\n\t ]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(item => {
      const parts = item.split(/[:=]/);
      const rid = (parts[0] || "").trim();
      const name = (parts[1] || "").trim();
      if (!/^\d+$/.test(rid)) {
        OmniBox.log("error", `[DOUYU-DEBUG] 忽略非法房间号配置: ${item}`);
        return;
      }
      if (seen[rid]) return;
      seen[rid] = true;
      list.push({ rid, name });
    });
  return list;
}

/**
 * 读取环境变量中的关注房间列表
 */
function getFollowedRoomsFromEnv() {
  let raw = "";
  let fromKey = "";
  for (const key of FOLLOWED_ROOMS_ENV_KEYS) {
    const val = process.env[key];
    if (val && String(val).trim()) {
      raw = String(val).trim();
      fromKey = key;
      break;
    }
  }
  if (!raw) {
    OmniBox.log("info", `[DOUYU-DEBUG] 未配置 ${FOLLOWED_ROOMS_ENV_KEYS.join(" / ")}，使用默认关注房间`);
    raw = DEFAULT_FOLLOWED_ROOMS;
    fromKey = "DEFAULT";
  }
  const rooms = parseFollowedRooms(raw);
  OmniBox.log("info", `[DOUYU-DEBUG] 关注房间配置来源=${fromKey}, 解析出 ${rooms.length} 个: ${rooms.map(r => r.rid).join(",")}`);
  return rooms;
}

// ========== 播放清晰度（环境变量配置） ==========
// 斗鱼 H5 播放地址自带 expire 参数（有效期，单位秒）：
//   rate >= 4（蓝光 8M / 蓝光 4M / 原画） -> expire=300，连接跑到 300 秒被 CDN 掐断
//   rate = 2 / 3（高清 900k / 超清 2000k） -> expire=0，长效，实测 420 秒不断
// OmniBox 前端 flv.js 对直播流没有自动重连逻辑，地址一到期画面就永久停住，
// 所以默认用 rate=3，保证长时间观看；要更高画质需自行接受「约 5 分钟断一次」。
const RATE_ALIASES = {
  "原画": 0, "best": 0, "source": 0, "原画2k60": 0,
  "蓝光8m": 8, "蓝光8M": 8,
  "蓝光": 4, "蓝光4m": 4, "蓝光4M": 4,
  "超清": 3, "hd": 3,
  "高清": 2, "sd": 2,
  "流畅": 1, "smooth": 1
};
const RATE_LABELS = { 0: "原画", 1: "流畅", 2: "高清", 3: "超清", 4: "蓝光4M", 8: "蓝光8M" };
// 各清晰度大致分辨率（实测 rate=3 -> 1280x720，rate=4 -> 1920x1080）
const RATE_RES = { 0: "1080P+", 1: "360P", 2: "540P", 3: "720P", 4: "1080P", 8: "1080P" };
const DEFAULT_RATE = 3;        // 未配置时的默认清晰度（长效地址）
const DEFAULT_LINE_RATE = 3;   // 未显式配置 DOUYU_RATE 时：默认线路（长效）
const HIGH_QUALITY_RATE = 4;   // 未显式配置 DOUYU_RATE 时：附加的高画质线路（300 秒限时）

/**
 * 读取环境变量 DOUYU_RATE（支持数字或中文/英文别名）
 * 未配置时返回 { rate: DEFAULT_RATE, explicit: false } —— 表示允许返回多线路
 */
function getRateFromEnv() {
  const raw = String(process.env.DOUYU_RATE || "").trim();
  if (!raw) {
    return { rate: DEFAULT_RATE, explicit: false, from: "默认(未设置 DOUYU_RATE)" };
  }
  if (/^-?\d+$/.test(raw)) {
    return { rate: parseInt(raw, 10), explicit: true, from: "DOUYU_RATE" };
  }
  const key = raw.replace(/\s+/g, "");
  if (RATE_ALIASES[key] !== undefined) {
    return { rate: RATE_ALIASES[key], explicit: true, from: "DOUYU_RATE" };
  }
  OmniBox.log("error", `[DOUYU-DEBUG] 无法识别的 DOUYU_RATE=${raw}，回退 rate=${DEFAULT_RATE}`);
  return { rate: DEFAULT_RATE, explicit: false, from: "默认(DOUYU_RATE 非法)" };
}

/**
 * 解析播放地址里的 expire（秒）；0 = 长效
 */
function getUrlExpire(url) {
  const m = /[?&]expire=(\d+)/.exec(String(url || ""));
  return m ? parseInt(m[1], 10) : null;
}

/**
 * 查询单个直播间状态（是否在播 + 直播间信息）
 * 注意：betard 的 room.status 恒为字符串 '1'，不是开播标志；
 *       真正开播标志是 room.show_status === 1（2=未开播）。
 */
async function fetchRoomStatus(rid) {
  const result = { rid, isLive: false, roomName: "", nickname: "", roomPic: "" };
  try {
    const resp = await req(`https://www.douyu.com/betard/${rid}`);
    const data = JSON.parse(resp.content);
    const room = data.room || {};
    const showStatus = parseInt(room.show_status);
    const endTime = parseInt(room.end_time) || 0;
    const now = Math.floor(Date.now() / 1000);
    if (!isNaN(showStatus)) {
      result.isLive = showStatus === 1;
    } else {
      result.isLive = endTime > now;
    }
    result.roomName = room.room_name || "";
    result.nickname = room.nickname || room.owner_name || "";
    result.roomPic = room.room_pic
      || (room.avatar && (room.avatar.big || room.avatar.middle || room.avatar.small))
      || room.avatar_mid || "";
    logInfo(`房间 ${rid} 状态`, { showStatus, endTime, isLive: result.isLive, roomName: result.roomName, nickname: result.nickname });
  } catch (e) {
    logError(`查询房间 ${rid} 状态失败`, e);
  }
  return result;
}

/**
 * 构建首页「关注直播间」列表（限并发，避免被风控）
 */
async function buildFollowedList(rooms, concurrency = 4) {
  const list = [];
  for (let i = 0; i < rooms.length; i += concurrency) {
    const batch = rooms.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(r => fetchRoomStatus(r.rid)));
    results.forEach((st, idx) => {
      const conf = batch[idx];
      const displayName = conf.name || st.nickname || st.roomName || `直播间${st.rid}`;
      list.push({
        "vod_id": st.rid,
        "vod_name": displayName,
        "vod_pic": st.roomPic || `https://apic.douyucdn.com/upload/${st.rid}/live.jpg`,
        "vod_remarks": st.isLive ? '🔴 直播中' : '⚫ 未开播',
        "style": { "type": "rect", "ratio": 1.33 }
      });
    });
  }
  return list;
}

/**
 * 核心:解析播放源字符串为结构化数组 [1]
 */
const parsePlaySources = (fromStr, urlStr) => {
  logInfo("开始解析播放源字符串", { from: fromStr, url: urlStr });
  const playSources = [];
  if (!fromStr || !urlStr) return playSources;

  const froms = fromStr.split('$$$');
  const urls = urlStr.split('$$$');

  for (let i = 0; i < froms.length; i++) {
    const sourceName = froms[i] || `线路${i + 1}`;
    const sourceItems = urls[i] ? urls[i].split('#') : [];

    const episodes = sourceItems.map(item => {
      const parts = item.split('$');
      return {
        name: parts[0] || '正片',
        playId: parts[1] || parts[0]
      };
    }).filter(e => e.playId);

    if (episodes.length > 0) {
      playSources.push({
        name: sourceName,
        episodes: episodes
      });
    }
  }
  logInfo("播放源解析结果", playSources);
  return playSources;
};

/**
 * 通用请求函数
 */
async function req(url, options = {}) {
  try {
    const response = await axios({
      url: url,
      method: options.method || 'GET',
      headers: options.headers || def_headers,
      data: options.body || null,
      timeout: options.timeout || 15000,
    });
    return {
      content: typeof response.data === 'object' ? JSON.stringify(response.data) : response.data
    };
  } catch (error) {
    logError(`请求失败 URL: ${url}`, error);
    return { content: "{}" };
  }
}

// ========== 接口实现 ==========

async function home(params) {
  logInfo("进入斗鱼直播首页");

  let classes = Object.keys(categories).map(key => ({
    'type_id': key,
    'type_name': categories[key]
  }));

  // 关注直播间：从环境变量读取房间号，并实时判断是否在播
  let followedList = [];
  try {
    const followedRooms = getFollowedRoomsFromEnv();
    followedList = await buildFollowedList(followedRooms);
    logInfo(`关注直播间列表构建完成，共 ${followedList.length} 个`);
  } catch (e) {
    logError("获取关注列表失败", e);
  }

  return {
    class: classes,
    list: followedList
  };
}

async function category(params) {
  const { categoryId, page } = params;
  const pg = parseInt(page) || 1;
  logInfo(`请求斗鱼分类: ${categoryId}, 页码: ${pg}`);
  
  try {
    const url = `${host}/api/room/list?page=${pg}&type=${categoryId}`;
    const resp = await req(url);
    const json = JSON.parse(resp.content);
    
    logInfo("分类接口返回数据", json);
    
    let list = (json.data.list || []).map(item => ({
      "vod_id": item.rid.toString(),
      "vod_name": item.roomName,
      "vod_pic": item.roomSrc,
      "vod_remarks": `🔥${item.hn} | ${item.nickname}`,
      "style": { "type": "rect", "ratio": 1.33 }
    }));
    
    return {
      list: list,
      page: pg,
      pagecount: 99
    };
  } catch (e) {
    logError("分类请求失败", e);
    return { list: [], page: pg, pagecount: 0 };
  }
}

async function search(params) {
  const wd = params.keyword || params.wd || "";
  const pg = parseInt(params.page) || 1;
  logInfo(`搜索斗鱼关键词: ${wd}, 页码: ${pg}`);
  
  try {
    const offset = (pg - 1) * 20;
    const url = `${host}/api/search/liveRoom?sk=${encodeURIComponent(wd)}&offset=${offset}&limit=20&did=${did}`;
    const resp = await req(url);
    const json = JSON.parse(resp.content);
    
    logInfo("搜索接口返回数据", json);
    
    let list = (json.data.list || []).map(item => ({
      "vod_id": item.rid.toString(),
      "vod_name": item.roomName,
      "vod_pic": item.roomSrc,
      "vod_remarks": item.nickname
    }));
    
    return {
      list: list,
      page: pg,
      pagecount: 10
    };
  } catch (e) {
    logError("搜索失败", e);
    return { list: [], page: pg, pagecount: 0 };
  }
}

async function detail(params) {
  const videoId = params.videoId;
  logInfo(`请求斗鱼直播间详情 ID: ${videoId}`);
  
  try {
    // ✅ 关键修正：使用 parsePlaySources 解析播放源 [1]
    const playSources = parsePlaySources("Douyu", `点击播放$${videoId}`);
    
    return {
      list: [{
        "vod_id": videoId,
        "vod_name": "直播间: " + videoId,
        "vod_play_sources": playSources,  // ✅ 必须返回此格式 [1]
        "vod_content": "斗鱼直播间"
      }]
    };
  } catch (e) {
    logError("详情获取失败", e);
    return { list: [] };
  }
}

/**
 * 按指定清晰度取一次真实流地址
 * @returns {Promise<{url:string, rate:number, cdn:string, expire:number|null}|null>}
 */
async function fetchStreamForRate(playId, rate) {
  const tt = Math.floor(Date.now() / 1000);

  // A. 获取动态加密脚本参数
  const encUrl = `https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption?did=${did}`;
  const encResp = await req(encUrl, {
    headers: {
      'Referer': `https://www.douyu.com/${playId}`,
      'User-Agent': def_headers['User-Agent']
    }
  });
  const encData = JSON.parse(encResp.content);
  if (!encData || encData.error !== 0) {
    logError("获取加密参数失败", new Error(`encData error: ${JSON.stringify(encData)}`));
    return null;
  }
  const sec = encData.data;

  // B. 斗鱼 MD5 签名：对 rand_str + key 迭代 enc_time 次
  let current = sec.rand_str;
  for (let i = 0; i < sec.enc_time; i++) {
    current = CryptoJS.MD5(current + sec.key).toString();
  }
  const auth = CryptoJS.MD5(current + sec.key + playId + tt).toString();

  // C. 请求真实 H5 流地址（rate 决定清晰度与地址有效期，见文件头 v1.3.0 说明）
  const streamUrl = `https://www.douyu.com/lapi/live/getH5PlayV1/${playId}`;
  const postData = `v=22032021&did=${did}&tt=${tt}&auth=${auth}&enc_data=${sec.enc_data}&rate=${rate}`;
  const streamResp = await req(streamUrl, {
    method: 'POST',
    body: postData,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `https://www.douyu.com/${playId}`,
      'User-Agent': def_headers['User-Agent']
    }
  });
  const streamData = JSON.parse(streamResp.content);
  if (!streamData || streamData.error !== 0 || !streamData.data || !streamData.data.rtmp_url) {
    logError(`请求清晰度 rate=${rate} 失败`, new Error(`streamData: ${JSON.stringify(streamData).slice(0, 200)}`));
    return null;
  }
  const url = `${streamData.data.rtmp_url}/${streamData.data.rtmp_live}`;
  const info = {
    url,
    rate: streamData.data.rate,
    cdn: streamData.data.rtmp_cdn,
    expire: getUrlExpire(url)
  };
  logInfo(`rate=${rate} -> 实际清晰度 ${info.rate}(${RATE_LABELS[info.rate] || "?"}) 线路 ${info.cdn} 有效期 ${info.expire === 0 ? "0(长效)" : info.expire + "秒"}`);
  return info;
}

/**
 * 组装线路名，把「能不能长时间播」直接写进名字里，避免选错
 */
function buildLineName(info) {
  const label = RATE_LABELS[info.rate] || ("rate" + info.rate);
  const res = RATE_RES[info.rate] || "";
  if (info.expire === 0) {
    return `斗鱼直播·${label} ${res}(长效 ${info.cdn})`;
  }
  return `斗鱼直播·${label} ${res}(${info.cdn}·${info.expire}秒断)`;
}

async function play(params) {
  const playId = params.playId;
  logInfo(`准备播放斗鱼直播间 ID: ${playId}`);

  try {
    const rateInfo = getRateFromEnv();
    // 显式配置 DOUYU_RATE 时只返回该清晰度；未配置时返回两条线路供选择：
    //   线路1 = 超清(720P)，expire=0 长效，能一直播；
    //   线路2 = 蓝光4M(1080P)，画质更好但地址只有 300 秒有效期，到点会卡住需重进。
    const rates = rateInfo.explicit ? [rateInfo.rate] : [DEFAULT_LINE_RATE, HIGH_QUALITY_RATE];
    logInfo(`清晰度取流: ${rates.map(r => `rate=${r}`).join(" + ")}（来源: ${rateInfo.from}）`);

    const urls = [];
    for (const r of rates) {
      try {
        const info = await fetchStreamForRate(playId, r);
        if (!info) continue;
        if (info.expire !== 0 && !rateInfo.explicit) {
          OmniBox.log("info", `[DOUYU-DEBUG] 线路「${RATE_LABELS[info.rate] || info.rate}」地址有效期仅 ${info.expire} 秒，`
            + `到点会被 CDN 掐断且播放器不会自动重连（可用 DOUYU_RATE=${info.rate} 固定该清晰度）`);
        }
        const item = { name: buildLineName(info), url: info.url };
        // 同名线路去重（比如服务端把多个 rate 回落到同一档）
        if (!urls.some(u => u.url === item.url)) urls.push(item);
      } catch (e) {
        logError(`取流失败 rate=${r}`, e);
      }
    }

    if (!urls.length) {
      logError("获取流地址失败", new Error("所有清晰度取流均为空（可能未开播）"));
      return { urls: [], parse: 0, header: def_headers };
    }

    // ========== 播放方式（环境变量控制）==========
    // 默认：不返回 header —— OmniBox 前端只有在 header 非空时才会把地址包装成
    //        /api/spider-source/proxy-play?url=...，而后端代理对单个请求有 30 秒硬超时，
    //        HTTP-FLV 是长连接直播流，必然在 30 秒被切断（实测 30.0014/30.0020/30.0016s）。
    //        不返回 header 时前端直接使用该地址，flv.js 直连斗鱼 CDN；
    //        斗鱼 CDN 已返回 Access-Control-Allow-Origin: *，跨域可直接播放。
    // 回退：DOUYU_PLAY_VIA_PROXY=1 时保留旧行为（带 header 走 OmniBox 代理，会 30 秒断流）。
    const viaProxy = /^(1|true|yes|on)$/i.test(String(process.env.DOUYU_PLAY_VIA_PROXY || "").trim());
    const result = { urls, parse: 0 };
    if (viaProxy) {
      result.header = {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://www.douyu.com/'
      };
      logInfo("播放方式：经 OmniBox 代理（DOUYU_PLAY_VIA_PROXY=1，注意 30 秒断流限制）");
    } else {
      logInfo("播放方式：直连斗鱼 CDN（不返回 header，绕过 OmniBox 代理 30 秒超时）");
    }
    return result;
  } catch (e) {
    logError("播放地址解析失败", e);
    return {
      urls: [],
      parse: 0,
      header: def_headers
    };
  }
}

module.exports = { home, category, search, detail, play };

const runner = require("spider_runner");
runner.run(module.exports);
