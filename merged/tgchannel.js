// @name TG频道网盘源
// @version 3.1.0
// @downloadURL https://raw.githubusercontent.com/Silent1566/OmniBox-Spider-Skills/main/JS/omnibox/tgchannel.js
// @indexs 1
// @push 0
// @dependencies cheerio
// UC／123 分享使用专用免登录目录和播放，其他网盘使用 OmniBox SDK。
// 修改 .dev 中的实现后运行 build.cjs；此文件可单独导入 OmniBox。
"use strict";

let OmniBox;
try { OmniBox = require("omnibox_sdk"); }
catch (error) {
  if (error.code !== "MODULE_NOT_FOUND" || !error.message.includes("'omnibox_sdk'")) throw error;
  // 仅用于本地加载，缺少 SDK 时关键方法会安全报错，不伪造网盘播放结果。
  OmniBox = { async log(level, message) { console.error(`[${level}] ${message}`); } };
}
let runner;
try { runner = require("spider_runner"); }
catch (error) {
  if (error.code !== "MODULE_NOT_FOUND" || !error.message.includes("'spider_runner'")) throw error;
  runner = { run() {} };
}

// 站点地址: TG_HOST (可选默认地址见 sourceConfiguration)。
const sourceConfiguration = {
  "id": "tgchannel",
  "name": "TG频道",
  "adapter": "tg",
  "hostEnv": "TG_HOST",
  "hosts": [
    "https://t.me"
  ],
  "categories": [],
  "mode": "channel",
  "defaultChannels": "",
  "userAgent": "MoZhao"
};
const siteAdapter = createTgAdapter(sourceConfiguration);
module.exports = createOmniBoxSpider(OmniBox, sourceConfiguration, siteAdapter, createDirectDriveResolver);
runner.run(module.exports);

function createTgAdapter(configuration = {}) {
  const mode = configuration.mode === "service" ? "service" : "channel";
  const pageCacheTtlSeconds = 45;
  const maximumCursorBackfillPages = 20;
  const maximumDetailVisits = 3;
  const usernamePattern = /^[A-Za-z0-9_]{5,32}$/;

  function getPage(params) {
    const requestedPage = Number(params.page || 1);
    return Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  }

  function getResultCount(helpers) {
    const configuredCount = helpers.getSetting("TG_RESULT_COUNT", 2);
    const requestedCount = String(configuredCount ?? "").trim() ? Number(configuredCount) : 2;
    return Number.isFinite(requestedCount) ? Math.min(5, Math.max(1, Math.floor(requestedCount))) : 2;
  }

  function shouldShowPictures(helpers) {
    return /^(?:true|1|yes|on)$/i.test(String(helpers.getSetting("TG_SHOW_PICTURES", false)).trim());
  }

  /** 仅接受公开用户名，禁止把消息路径、查询参数或凭证混入频道配置。 */
  function parseChannels(value, required) {
    const channelEntries = String(value || "").split(/[,，\r\n]+/).map(entry => entry.trim()).filter(Boolean);
    if (required && channelEntries.length === 0) throw new Error("请配置 PANSOU_CHANNELS 公开频道");
    const channelsByUsername = new Map();
    for (const entry of channelEntries) {
      const separatorIndex = entry.indexOf("|");
      let username = (separatorIndex < 0 ? entry : entry.slice(0, separatorIndex)).trim();
      const displayName = separatorIndex < 0 ? "" : entry.slice(separatorIndex + 1).trim();
      if (username.startsWith("@")) username = username.slice(1);
      if (/^(?:https?:\/\/)?t\.me\//i.test(username)) {
        const channelUrl = new URL(/^https?:\/\//i.test(username) ? username : `https://${username}`);
        const matchedPath = channelUrl.pathname.match(/^\/([A-Za-z0-9_]{5,32})\/?$/);
        if (channelUrl.hostname !== "t.me" || channelUrl.username || channelUrl.password || channelUrl.port
          || channelUrl.search || channelUrl.hash || !matchedPath) throw new Error("PANSOU_CHANNELS 包含无效公开频道");
        username = matchedPath[1];
      }
      if (!usernamePattern.test(username)) throw new Error("PANSOU_CHANNELS 包含无效公开频道");
      const identity = username.toLowerCase();
      if (!channelsByUsername.has(identity)) channelsByUsername.set(identity, { username, displayName: displayName || username });
    }
    return [...channelsByUsername.values()];
  }

  function getConfiguredChannels(helpers) {
    const fallback = mode === "service" ? configuration.defaultChannels || "" : "";
    const setting = helpers.getSetting("PANSOU_CHANNELS", fallback);
    return parseChannels(mode === "service" ? setting || fallback : setting, mode === "channel");
  }

  function normalizePicture(value, host) {
    try {
      const pictureUrl = new URL(value, host);
      return ["http:", "https:"].includes(pictureUrl.protocol) && !pictureUrl.username && !pictureUrl.password ? pictureUrl.href : "";
    } catch {
      return "";
    }
  }

  /** 支持带方括号和省略方括号的可选 @pic 字段。 */
  function parseServiceLink(value, host) {
    const bracketedPicture = value.match(/^(.*?)\[@(.*?)\]$/);
    if (bracketedPicture) return { url: bracketedPicture[1], pic: normalizePicture(bracketedPicture[2], host) };
    const pictureSeparatorIndex = value.indexOf("@http");
    return pictureSeparatorIndex < 0 ? { url: value, pic: "" } : {
      url: value.slice(0, pictureSeparatorIndex), pic: normalizePicture(value.slice(pictureSeparatorIndex + 1), host),
    };
  }

  /** 先限制服务返回的频道条数，再过滤非网盘链接，避免越过 count。 */
  function parseServiceResources(payload, count, keyword, host, helpers) {
    const results = payload?.results ?? payload?.data?.results;
    if (!Array.isArray(results)) throw new Error("TG 服务响应格式无效");
    const consumedByChannel = new Map();
    const resources = [];
    for (const channelResult of results) {
      if (typeof channelResult !== "string") continue;
      const channelSeparatorIndex = channelResult.indexOf("$$$");
      if (channelSeparatorIndex < 1) continue;
      const channel = channelResult.slice(0, channelSeparatorIndex).trim();
      const channelIdentity = channel.toLowerCase();
      let consumedEntries = consumedByChannel.get(channelIdentity) || 0;
      for (const entry of channelResult.slice(channelSeparatorIndex + 3).split("##")) {
        if (consumedEntries >= count) break;
        consumedEntries++;
        const titleSeparatorIndex = entry.indexOf("$$");
        if (titleSeparatorIndex < 0) continue;
        const title = entry.slice(titleSeparatorIndex + 2).trim() || keyword;
        const link = parseServiceLink(entry.slice(0, titleSeparatorIndex).trim(), host);
        const normalizedShare = helpers.normalizeShare(link.url, "", title);
        if (!normalizedShare) continue;
        const shares = helpers.mergeShares([normalizedShare], helpers.extractShares(`${link.url}\n${title}`, title));
        for (const share of shares) resources.push({
          id: `${configuration.id || "tgsou"}:${helpers.hash(`${channel}:${share.provider}:${share.shareId || share.url}`)}`,
          title, pic: link.pic, remark: channel, content: title, shares: [share],
        });
      }
      consumedByChannel.set(channelIdentity, consumedEntries);
    }
    return resources;
  }

  async function searchService(params, helpers) {
    const page = getPage(params);
    const keyword = String(params.keyword ?? params.wd ?? "").trim();
    if (!keyword || page !== 1) return helpers.paginate([], page, { total: 0, pagecount: 1, hasNext: false });
    if (!String(helpers.getSetting(configuration.hostEnv || "SITE_API", "") || "").trim()) {
      throw new Error("请配置 TG 搜索服务 SITE_API");
    }
    const host = await helpers.getHost();
    if (!host) throw new Error("请配置 TG 搜索服务 SITE_API");
    const query = new URLSearchParams({
      pic: String(shouldShowPictures(helpers)), count: String(getResultCount(helpers)),
      channelUsername: getConfiguredChannels(helpers).map(channel => channel.username).join(","), keyword,
    });
    const servicePath = await helpers.resolveSitePath(`${host.replace(/\/+$/, "")}/?${query}`);
    const payload = await helpers.fetchJson(servicePath, { method: "GET", ttl: 0, headers: { Accept: "application/json" } });
    const resources = parseServiceResources(payload, getResultCount(helpers), keyword, host, helpers);
    return helpers.paginate(resources.map(resource => helpers.createVod(resource)), page,
      { total: resources.length, pagecount: 1, hasNext: false });
  }

  /** 文章只允许 HTTPS telegra.ph 的单段公开路径，显式端口也不接受。 */
  function normalizeArticle(value) {
    const candidate = String(value || "").trim();
    if (!/^https:\/\/telegra\.ph\/[^\s?#]+(?:#[^\s]*)?$/i.test(candidate)) return null;
    try {
      const articleUrl = new URL(candidate);
      const decodedSlug = decodeURIComponent(articleUrl.pathname.slice(1));
      if (articleUrl.protocol !== "https:" || articleUrl.hostname !== "telegra.ph" || articleUrl.username
        || articleUrl.password || articleUrl.port || !decodedSlug || decodedSlug.length > 512
        || decodedSlug === "." || decodedSlug === ".." || /[\\\/%?#\x00-\x20\x7f]/.test(decodedSlug)) return null;
      articleUrl.hash = "";
      return articleUrl.href;
    } catch {
      return null;
    }
  }

  /** 公共 TG 链接映射为当前站点路径，请求时绝不转向任意外部域名。 */
  function normalizeForward(value, host) {
    try {
      const messageUrl = new URL(value, host);
      const isSiteOrigin = messageUrl.origin === new URL(host).origin;
      const isPublicTelegram = messageUrl.protocol === "https:" && messageUrl.hostname === "t.me" && !messageUrl.port;
      const matchedPath = messageUrl.pathname.match(/^\/(?:s\/)?([A-Za-z0-9_]{5,32})\/([1-9][0-9]*)\/?$/);
      const messageId = Number(matchedPath?.[2]);
      if ((!isSiteOrigin && !isPublicTelegram) || messageUrl.username || messageUrl.password || !matchedPath
        || !Number.isSafeInteger(messageId)) return null;
      return {
        username: matchedPath[1], messageId,
        identity: `${matchedPath[1].toLowerCase()}/${messageId}`,
        url: `https://t.me/${matchedPath[1]}/${messageId}`, path: `/${matchedPath[1]}/${messageId}`,
      };
    } catch {
      return null;
    }
  }

  function getMessageTitle(text, channel, messageId) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      const namedTitle = line.match(/(?:资源名称|影片名称|片名|名称)\s*[:：]\s*(.+)/);
      if (namedTitle && !/https?:\/\//i.test(namedTitle[1])) return namedTitle[1].trim();
    }
    return lines.find(line => !/https?:\/\/|(?:^|\s)t\.me\//i.test(line)) || `${channel.displayName} ${messageId}`;
  }

  /** 游标统计所有有效消息；资源过滤与游标计算必须相互独立。 */
  async function parseChannelPage(html, channel, host, helpers) {
    const document = await helpers.loadHtml(html);
    const resourcesByMessage = new Map();
    let minimumMessageId = 0;
    let messageCount = 0;
    for (const rowElement of document(".tgme_widget_message[data-post]").toArray()) {
      const row = document(rowElement);
      const message = normalizeForward(`/${row.attr("data-post")}`, host);
      if (!message || message.username.toLowerCase() !== channel.username.toLowerCase()) continue;
      messageCount++;
      minimumMessageId = minimumMessageId ? Math.min(minimumMessageId, message.messageId) : message.messageId;
      const textNode = row.find(".tgme_widget_message_text").first().clone();
      textNode.find("br").replaceWith("\n");
      const content = textNode.text().replace(/\u00a0/g, " ").trim();
      const title = getMessageTitle(content, channel, message.messageId);
      const rowHtml = document.html(row);
      const shares = helpers.mergeShares(await helpers.extractSharesFromHtml(rowHtml), helpers.extractShares(content, title))
        .map(share => ({ ...share, title: share.title || title }));
      const links = row.find("a[href]").toArray().map(anchor => document(anchor).attr("href"))
        .concat([...content.matchAll(/https?:\/\/[^\s<>"']+/g)].map(matchedUrl => matchedUrl[0].replace(/[),，。]+$/, "")));
      const forwardsByIdentity = new Map();
      const articles = new Set();
      for (const link of links) {
        const forwardedMessage = normalizeForward(link, host);
        if (forwardedMessage && forwardedMessage.identity !== message.identity) {
          forwardsByIdentity.set(forwardedMessage.identity, forwardedMessage.url);
        }
        const articleUrl = normalizeArticle(link);
        if (articleUrl) articles.add(articleUrl);
      }
      if (!shares.length && !forwardsByIdentity.size && !articles.size) continue;
      const photoStyle = row.find(".tgme_widget_message_photo_wrap[style], .tgme_widget_message_video_thumb[style]")
        .first().attr("style") || "";
      const photoMatch = photoStyle.match(/background-image\s*:\s*url\(\s*['"]?([^'"()]+)['"]?\s*\)/i);
      resourcesByMessage.set(message.identity, {
        id: `${configuration.id || "tgchannel"}:${message.identity}`, title,
        pic: photoMatch ? normalizePicture(photoMatch[1].trim(), host) : "", remark: channel.displayName,
        content, path: message.path, typeId: channel.username, typeName: channel.displayName, shares,
        meta: { channel: channel.username, messageId: message.messageId,
          forwards: [...forwardsByIdentity.values()], articles: [...articles] },
      });
    }
    return {
      resources: [...resourcesByMessage.values()].sort((firstResource, secondResource) => secondResource.meta.messageId - firstResource.meta.messageId),
      nextBefore: minimumMessageId, messageCount, hasNext: minimumMessageId > 1,
    };
  }

  /** 每个页面缓存资源和 before 游标，跳页只补取缺失的前置页面。 */
  async function loadChannelPage(channel, keyword, requestedPage, helpers, resultCount = 0) {
    const host = await helpers.getHost() || "https://t.me";
    const origin = new URL(host).origin;
    async function loadPageByNumber(page, missingPredecessorDepth) {
      const identity = JSON.stringify([origin, channel.username.toLowerCase(), keyword, page, resultCount]);
      return helpers.cached("tg-channel-page", identity, pageCacheTtlSeconds, async () => {
        if (missingPredecessorDepth > maximumCursorBackfillPages) throw new Error("TG 跨页跳转最多补取 20 页");
        let before = 0;
        if (page > 1) {
          const previousPage = await loadPageByNumber(page - 1, missingPredecessorDepth + 1);
          if (!previousPage.hasNext || !previousPage.nextBefore) return { resources: [], nextBefore: 0, messageCount: 0, hasNext: false };
          before = previousPage.nextBefore;
        }
        const query = new URLSearchParams();
        if (keyword) query.set("q", keyword);
        if (before) query.set("before", String(before));
        const pagePath = await helpers.resolveSitePath(`${origin}/s/${channel.username}${query.size ? `?${query}` : ""}`);
        const html = await helpers.fetchText(pagePath, { method: "GET", ttl: 0, headers: { Accept: "text/html" } });
        const result = await parseChannelPage(html, channel, origin, helpers);
        if (resultCount > 0 && result.resources.length > resultCount) {
          const resources = result.resources.slice(0, resultCount);
          // 未展示的消息仍留在下一个 before 窗口中，不能推进到整页最小消息 ID。
          const nextBefore = resources[resources.length - 1].meta.messageId;
          return { ...result, resources, nextBefore, hasNext: nextBefore > 1 };
        }
        return result;
      }, record => Boolean(record && Array.isArray(record.resources) && Number.isSafeInteger(record.nextBefore)));
    }
    return loadPageByNumber(requestedPage, 0);
  }

  async function getCategories(helpers) {
    return mode === "service" ? [] : getConfiguredChannels(helpers)
      .map(channel => ({ type_id: channel.username, type_name: channel.displayName }));
  }

  async function category(params = {}, helpers) {
    const page = getPage(params);
    if (mode === "service") return helpers.paginate([], page, { total: 0, pagecount: 1, hasNext: false });
    const channels = getConfiguredChannels(helpers);
    const categoryId = String(params.typeId ?? params.categoryId ?? params.type_id ?? params.id ?? channels[0].username);
    const channel = channels.find(entry => entry.username.toLowerCase() === categoryId.toLowerCase());
    if (!channel) throw new Error("未配置该公开 TG 频道");
    const result = await loadChannelPage(channel, "", page, helpers);
    return helpers.paginate(result.resources.map(resource => helpers.createVod(resource)), page,
      { hasNext: result.hasNext, pagecount: page + Number(result.hasNext) });
  }

  /** 最多三个频道并发；单频道失败不影响成功结果，全部失败才上抛。 */
  async function search(params = {}, helpers) {
    if (mode === "service") return searchService(params, helpers);
    const page = getPage(params);
    const keyword = String(params.keyword ?? params.wd ?? "").trim();
    const channels = getConfiguredChannels(helpers);
    if (!keyword) return helpers.paginate([], page, { total: 0, pagecount: 1, hasNext: false });
    const count = getResultCount(helpers);
    const results = await helpers.mapLimit(channels, 3, async channel => {
      try { return { success: true, result: await loadChannelPage(channel, keyword, page, helpers, count) }; }
      catch { return { success: false }; }
    });
    const succeededResults = results.filter(result => result.success);
    if (!succeededResults.length) throw new Error("TG 频道搜索暂不可用");
    if (succeededResults.length !== results.length) {
      try { await helpers.log("warn", "search", "部分 TG 频道读取失败，已保留成功结果"); } catch {}
    }
    const resources = succeededResults.flatMap(entry => entry.result.resources);
    const hasNext = succeededResults.some(entry => entry.result.hasNext);
    return helpers.paginate(resources.map(resource => helpers.createVod(resource)), page,
      { hasNext, pagecount: page + Number(hasNext) });
  }

  /** embed 不可用时回退公开频道页，但仅取指定消息，不能借用相邻分享。 */
  async function readForwardedMessage(message, host, helpers) {
    const channel = { username: message.username, displayName: message.username };
    for (const messagePath of [`${message.path}?embed=1&mode=tme`, `/s${message.path}`]) {
      try {
        const sitePath = await helpers.resolveSitePath(messagePath);
        const html = await helpers.fetchText(sitePath, { method: "GET", ttl: 0, headers: { Accept: "text/html" } });
        const result = await parseChannelPage(html, channel, host, helpers);
        const resource = result.resources.find(entry => entry.meta.messageId === message.messageId);
        if (resource) return resource;
      } catch {}
    }
    return null;
  }

  /** 外部文章使用无网站 Cookie 的 request，且只在正文范围提取分享。 */
  async function readArticleShares(articleUrl, title, helpers) {
    const response = await helpers.request(articleUrl, { method: "GET", headers: { Accept: "text/html" } });
    const statusCode = Number(response.statusCode);
    if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) throw new Error("TG 文章读取失败");
    const document = await helpers.loadHtml(response.body);
    const articleContent = document(".tl_article_content").first();
    if (!articleContent.length) return [];
    const textNode = articleContent.clone();
    textNode.find("br").replaceWith("\n");
    return helpers.mergeShares(await helpers.extractSharesFromHtml(document.html(articleContent), ".tl_article_content"),
      helpers.extractShares(textNode.text(), title));
  }

  /** 转发和文章各最多访问三处，防循环且保留部分成功的分享。 */
  async function detail(resource, helpers) {
    const existingShares = helpers.mergeShares(resource.shares || []);
    if (existingShares.length || mode === "service") return { ...resource, shares: existingShares };
    const host = await helpers.getHost() || "https://t.me";
    const forwardQueue = Array.isArray(resource.meta?.forwards) ? [...resource.meta.forwards] : [];
    const articleQueue = Array.isArray(resource.meta?.articles) ? [...resource.meta.articles] : [];
    const currentMessage = normalizeForward(resource.path || "", host);
    const hasInitialReferences = Boolean(forwardQueue.length || articleQueue.length);
    if (!hasInitialReferences && currentMessage) forwardQueue.push(currentMessage.url);
    const visitedMessages = new Set();
    const visitedArticles = new Set();
    const shareLists = [];
    while (forwardQueue.length && visitedMessages.size < maximumDetailVisits) {
      const message = normalizeForward(forwardQueue.shift(), host);
      if (!message || visitedMessages.has(message.identity)
        || (hasInitialReferences && message.identity === currentMessage?.identity)) continue;
      visitedMessages.add(message.identity);
      const forwardedResource = await readForwardedMessage(message, host, helpers);
      if (!forwardedResource) continue;
      if (forwardedResource.shares.length) {
        shareLists.push(forwardedResource.shares);
      } else {
        forwardQueue.push(...forwardedResource.meta.forwards);
        articleQueue.push(...forwardedResource.meta.articles);
      }
    }
    while (articleQueue.length && visitedArticles.size < maximumDetailVisits) {
      const articleUrl = normalizeArticle(articleQueue.shift());
      if (!articleUrl || visitedArticles.has(articleUrl)) continue;
      visitedArticles.add(articleUrl);
      try { shareLists.push(await readArticleShares(articleUrl, resource.title, helpers)); } catch {}
    }
    return { ...resource, shares: helpers.mergeShares(...shareLists) };
  }

  return { getCategories, category, search, detail };
}

function createDirectDriveResolver({ request, log }) {
  const pageSize = 100;
  const maximumDirectoryPages = 1000;
  const ucTokens = new Map();
  const pendingUcTokens = new Map();
  const ucUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";
  const ucHeaders = { "User-Agent": ucUserAgent, Referer: "https://drive.uc.cn" };
  const pan123Headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    platform: "android", "app-version": "3", Referer: "https://www.123pan.cn/", Origin: "https://www.123pan.cn",
  };

  function supports(provider) { return provider === "uc" || provider === "123"; }

  function createError(message, status = 0, responseMessage = "") {
    const error = new Error(message);
    error.status = status;
    const tokenRelated = /token|stoken|令牌|share_fid_token/i.test(responseMessage);
    const expiredShare = !tokenRelated && /(?:分享|共享|链接|連結)[^。\n]{0,20}(?:过期|失效|取消|删除|不存在)|share(?:d)?(?: link)?[^.\n]{0,30}(?:expired|cancelled|deleted|not found)/i.test(responseMessage);
    error.code = expiredShare || status === 410 ? "SHARE_EXPIRED" : status === 429 ? "RATE_LIMITED" : status === 401 ? "AUTH_FAILED" : "UPSTREAM_ERROR";
    return error;
  }

  /** 业务错误只输出安全摘要，不能把分享令牌或下载签名写入日志。 */
  async function requestJson(url, options, label) {
    const response = await request(url, options);
    let payload;
    try { payload = JSON.parse(response.body); }
    catch (_) { throw createError(`${label}未返回有效 JSON`, response.statusCode); }
    const businessStatus = Number(payload?.status || 0);
    const businessCode = payload?.code == null ? 0 : Number(payload.code);
    const status = response.statusCode >= 400 ? response.statusCode : businessStatus >= 400 ? businessStatus : [401, 410, 429].includes(businessCode) ? businessCode : 0;
    if (response.statusCode < 200 || response.statusCode >= 300 || businessStatus && businessStatus !== 200 || businessCode !== 0) {
      throw createError(`${label}请求失败${status ? ` (HTTP ${status})` : ""}`, status, String(payload?.message || payload?.msg || ""));
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw createError(`${label}响应结构无效`);
    return payload;
  }

  function normalizeUcToken(token) {
    return /^[A-Za-z0-9+/_-]+={0,2}$/.test(token) ? token.replace(/\+/g, "-").replace(/\//g, "_") : token;
  }

  /** 短期合并同分享的 token 请求；强制刷新时不复用已被拒绝的令牌。 */
  async function getUcToken(share, rejectedToken = "") {
    const tokenKey = JSON.stringify([share.shareId, share.passcode || ""]);
    const current = ucTokens.get(tokenKey);
    if (current && current.expiresAt > Date.now() && (!rejectedToken || current.token !== rejectedToken)) return current.token;
    if (pendingUcTokens.has(tokenKey)) return pendingUcTokens.get(tokenKey);
    const pending = (async () => {
      const payload = await requestJson("https://pc-api.uc.cn/1/clouddrive/share/sharepage/token?pr=UCBrowser&fr=pc", {
        method: "POST", headers: { ...ucHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ pwd_id: share.shareId, passcode: share.passcode || "" }),
      }, "UC 分享令牌");
      const token = payload.data?.stoken;
      if (typeof token !== "string" || !token || token.length > 8192 || /[\x00-\x20\x7f]/.test(token)) throw createError("UC 分享缺少有效令牌，请检查链接和提取码");
      ucTokens.set(tokenKey, { token, expiresAt: Date.now() + 60000 });
      if (ucTokens.size > 128) ucTokens.delete(ucTokens.keys().next().value);
      return token;
    })();
    pendingUcTokens.set(tokenKey, pending);
    try { return await pending; }
    finally { pendingUcTokens.delete(tokenKey); }
  }

  function readTotal(data, payload) {
    for (const value of [data?.total, data?._total, data?.total_count, data?.metadata?._total, payload?.metadata?._total]) {
      if (value == null || value === "") continue;
      const total = Number(value);
      if (!Number.isSafeInteger(total) || total < 0) throw createError("分享目录总量无效");
      return total;
    }
    return null;
  }

  /** UC _count 表示分页消费槽位，123 Next 表示游标；都不能只按视频条数结束。 */
  async function readDirectoryPages(readPage, getFileId) {
    const files = [];
    const seenFileIds = new Set();
    let scannedCount = 0;
    let hasNativeCount = false;
    let expectedTotal = null;
    let nextCursor = 0;
    for (let page = 1; page <= maximumDirectoryPages; page++) {
      const result = await readPage(page, nextCursor);
      if (!Array.isArray(result.files)) throw createError("分享目录缺少文件列表");
      const count = result.count == null ? result.files.length : Number(result.count);
      if (!Number.isSafeInteger(count) || count < result.files.length) throw createError("分享目录分页数量无效");
      hasNativeCount = hasNativeCount || result.count != null;
      if (expectedTotal !== null && result.total !== null && result.total !== expectedTotal) throw createError("分享目录总量在分页期间发生变化");
      if (result.total !== null) expectedTotal = result.total;
      let addedCount = 0;
      for (const file of result.files) {
        const fileId = file && getFileId(file);
        if (fileId == null || fileId === "") throw createError("分享目录文件缺少 ID");
        if (!seenFileIds.has(String(fileId))) { seenFileIds.add(String(fileId)); files.push(file); addedCount++; }
      }
      if (result.files.length && addedCount === 0) throw createError("分享目录分页重复，停止读取");
      scannedCount += count;
      // UC 使用原生消费量，其他目录用去重后的文件数，不能累计重叠条目提前结束。
      const consumedCount = hasNativeCount ? scannedCount : seenFileIds.size;
      if (expectedTotal !== null && consumedCount >= expectedTotal) return files;
      if (String(result.next) === "-1") {
        if (expectedTotal !== null && consumedCount < expectedTotal) throw createError("分享目录分页提前结束");
        return files;
      }
      if (count === 0) {
        if (expectedTotal !== null && consumedCount < expectedTotal) throw createError("分享目录尚未完成却返回空页");
        return files;
      }
      if (expectedTotal === null && result.next == null && count < pageSize) return files;
      nextCursor = result.next ?? 0;
    }
    throw createError("分享目录分页超过安全上限，停止读取");
  }

  async function readUcDirectory(share, parentId, token) {
    const files = await readDirectoryPages(async page => {
      const query = new URLSearchParams({
        pr: "UCBrowser", fr: "pc", pwd_id: share.shareId, stoken: normalizeUcToken(token),
        pdir_fid: parentId, force: "0", _page: String(page), _size: String(pageSize),
        _fetch_total: "1", _sort: "file_type:asc,file_name:asc",
      });
      const payload = await requestJson(`https://pc-api.uc.cn/1/clouddrive/share/sharepage/detail?${query}`, { method: "GET", headers: ucHeaders }, "UC 分享目录");
      return { files: payload.data?.list, total: readTotal(payload.data, payload), count: payload.metadata?._count ?? payload.data?.metadata?._count };
    }, file => file.fid);
    return { files: files.map(file => ({
      fid: String(file.fid), file_name: String(file.file_name || file.server_filename || ""), size: Number(file.size || 0),
      dir: file.dir === true || file.dir === 1 || file.dir === "1",
      format_type: file.obj_category === "video" || String(file.category) === "1" ? "video" : "",
      directFile: { provider: "uc", parentId: String(file.pdir_fid ?? parentId), stoken: token, shareFidToken: file.share_fid_token || "" },
    })) };
  }

  async function readPan123Directory(share, parentId) {
    const files = await readDirectoryPages(async (page, next) => {
      const query = new URLSearchParams({
        limit: String(pageSize), next: String(next), orderBy: "file_name", orderDirection: "asc",
        shareKey: share.shareId, SharePwd: share.passcode || "", ParentFileId: parentId, Page: String(page),
      });
      const payload = await requestJson(`https://www.123684.com/b/api/share/get?${query}`, { method: "GET", headers: pan123Headers }, "123 分享目录");
      return { files: payload.data?.InfoList, total: readTotal(payload.data, payload), next: payload.data?.Next };
    }, file => file.FileId);
    return { files: files.map(file => ({
      fid: String(file.FileId), file_name: String(file.FileName || ""), size: Number(file.Size || 0),
      dir: Number(file.Type) === 1, format_type: Number(file.Category) === 2 ? "video" : "",
      directFile: { provider: "123", parentId: String(parentId), downloadUrl: String(file.DownloadUrl || "") },
    })) };
  }

  /** 根目录和子目录使用相同协议，UC 缓存令牌失效最多修复一次。 */
  async function getFileList(share, parentId = "0") {
    if (share.provider === "123") return readPan123Directory(share, String(parentId));
    const token = await getUcToken(share);
    try { return await readUcDirectory(share, String(parentId), token); }
    catch (error) {
      if (error.code !== "AUTH_FAILED") throw error;
      return readUcDirectory(share, String(parentId), await getUcToken(share, token));
    }
  }

  function isHttpUrl(value) {
    try { const address = new URL(value); return ["http:", "https:"].includes(address.protocol) && !address.username && !address.password; }
    catch (_) { return false; }
  }

  /** 只选择匹配 fid 的下载结果；单项无 fid 响应是原接口的兼容形态。 */
  async function downloadUcFile(share, fileId, fileInfo) {
    const payload = await requestJson("https://pc-api.uc.cn/1/clouddrive/file/download?pr=UCBrowser&fr=pc", {
      method: "POST", headers: { ...ucHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ fids: [fileId], fids_token: [fileInfo.shareFidToken], pwd_id: share.shareId, stoken: normalizeUcToken(fileInfo.stoken), speedup_session: "" }),
    }, "UC 免登录下载");
    const results = Array.isArray(payload.data) ? payload.data : [payload.data];
    const target = results.find(file => file && String(file.fid) === fileId) || (results.length === 1 && results[0]?.fid == null ? results[0] : null);
    if (!target || !isHttpUrl(target.download_url)) throw createError("UC 分享未返回目标视频的免登录地址");
    return target.download_url;
  }

  /** 刷新只读取已知父目录，不重新扫全集，也不触发登录或转存。 */
  async function refreshUcFile(share, fileId, fileInfo) {
    if (fileInfo.parentId == null) throw createError("UC 播放上下文缺少父目录，请重新打开详情");
    const token = await getUcToken(share, fileInfo.stoken || "");
    const directory = await readUcDirectory(share, String(fileInfo.parentId), token);
    const file = directory.files.find(entry => entry.fid === fileId && !entry.dir);
    if (!file?.directFile.shareFidToken) throw createError("UC 分享文件已失效或缺少下载令牌");
    return file.directFile;
  }

  async function playUcFile(share, fileId, fileInfo) {
    let activeFile = fileInfo;
    let url;
    if (activeFile.stoken && activeFile.shareFidToken) {
      try { url = await downloadUcFile(share, fileId, activeFile); }
      catch (error) {
        if (["RATE_LIMITED", "SHARE_EXPIRED"].includes(error.code)) throw error;
        await log("info", "play", "UC 下载令牌失效，刷新目标父目录后重试一次");
      }
    }
    if (!url) {
      activeFile = await refreshUcFile(share, fileId, activeFile);
      url = await downloadUcFile(share, fileId, activeFile);
    }
    // UC 防盗链要求原始下载地址后追加一个反斜杠，不解码、不改写签名。
    return { urls: [{ name: "UC原画", url }], header: { "User-Agent": ucUserAgent, Referer: url + "\\", "Accept-Encoding": "identity" }, parse: 0 };
  }

  /** Range 仅读取响应头即销毁流，避免服务端忽略 Range 时下载整个视频。 */
  function probeRange(url) {
    return new Promise((resolve, reject) => {
      const address = new URL(url);
      const transport = require(address.protocol === "https:" ? "node:https" : "node:http");
      let timeoutTimer;
      const outgoing = transport.request(address, { method: "GET", headers: { "User-Agent": pan123Headers["User-Agent"], Referer: pan123Headers.Referer, Range: "bytes=0-0" } }, response => {
        clearTimeout(timeoutTimer);
        resolve({ statusCode: response.statusCode, headers: response.headers });
        response.destroy();
        outgoing.destroy();
      });
      outgoing.once("error", error => { clearTimeout(timeoutTimer); reject(error); });
      timeoutTimer = setTimeout(() => outgoing.destroy(new Error("123 直链跳转探测超时")), 10000);
      outgoing.end();
    });
  }

  /** 原分享已提供直链，跳转探测失败仍返回原地址让播放器处理，不走登录接口。 */
  async function playPan123File(share, fileId, fileInfo) {
    let downloadUrl = fileInfo.downloadUrl;
    if (!downloadUrl) {
      const directory = await readPan123Directory(share, String(fileInfo.parentId ?? "0"));
      downloadUrl = directory.files.find(file => file.fid === fileId && !file.dir)?.directFile.downloadUrl;
    }
    const rawUrl = String(downloadUrl || "").replace("_24_24", "")
      .replace("&cache_type=1&w=24&h=24&trade_key=123pan-thumbnail&type=video", "")
      .replace("?cache_type=1&w=24&h=24&trade_key=123pan-thumbnail&type=video", "");
    if (!isHttpUrl(rawUrl)) throw createError("123 分享未提供免登录视频地址");
    let url = rawUrl;
    const visited = new Set();
    try {
      for (let redirectIndex = 0; redirectIndex < 5; redirectIndex++) {
        if (!isHttpUrl(url) || visited.has(url)) throw createError("123 直链跳转无效或循环");
        visited.add(url);
        const response = await probeRange(url);
        if (response.statusCode >= 200 && response.statusCode < 300) break;
        if (response.statusCode < 300 || response.statusCode >= 400) throw createError("123 直链跳转读取失败");
        if (!response.headers.location) break;
        url = new URL(response.headers.location, url).href;
      }
      if (!isHttpUrl(url)) throw createError("123 直链跳转协议无效");
    } catch (_) { url = rawUrl; await log("info", "play", "123 跳转探测失败，保留原免登录地址"); }
    return { urls: [{ name: "123原画", url }], header: { "User-Agent": pan123Headers["User-Agent"], Referer: pan123Headers.Referer }, parse: 0 };
  }

  async function play(share, fileId, fileInfo) {
    return share.provider === "uc" ? playUcFile(share, String(fileId), fileInfo) : playPan123File(share, String(fileId), fileInfo);
  }

  return { supports, getFileList, play };
}

function createOmniBoxSpider(OmniBox, configuration, adapter, createDirectDriveResolver) {
  const crypto = require("node:crypto");
  const memoryCache = new Map();
  const pendingCache = new Map();
  const hostStates = new Map();
  const sessions = new Map();
  // 轮换式刷新令牌只能消费一次，同账号的并发 401 必须共用刷新任务。
  const sessionRefreshes = new Map();
  const userAgent = configuration.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const providerNames = { quark: "夸克网盘", baidu: "百度网盘", uc: "UC网盘", "115": "115网盘", "123": "123网盘", xunlei: "迅雷网盘", guangya: "光鸭网盘", yidong: "移动云盘", tianyi: "天翼云盘", aliyun: "阿里云盘" };
  const videoExtension = /\.(?:mp4|mkv|m4v|mov|avi|wmv|flv|webm|ts|m2ts|mts|mpg|mpeg|vob|rmvb|rm|strm)$/i;
  const naturalOrder = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
  const directDrive = createDirectDriveResolver({ request, log });

  /** 日志不输出 Cookie、令牌、请求体或分享提取码。 */
  async function log(level, method, message) {
    const safeMessage = String(message || "")
      .replace(/([?&](?:pwd|password|passcode|accessCode|SharePwd|stoken|token|apikey|key|auth)=)[^&\s]*/gi, "$1***")
      .replace(/((?:Cookie|Authorization|BDUSS|SEID|mys_at|mys_rt)\s*[:=]\s*)[^\s,;]+/gi, "$1***");
    try { await OmniBox.log(level, `[${configuration.id}][${method}] ${safeMessage.slice(0, 1500)}`); }
    catch (_) { /* 日志故障不能阻塞采集或启播。 */ }
  }

  function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
  function getSetting(name, fallback = "") { return String(process.env[name] ?? fallback).trim(); }
  function normalizePage(value) { const page = Number(value || 1); return Number.isSafeInteger(page) && page >= 1 && page <= 10000 ? page : 1; }
  function loadHtml(value) { return require("cheerio").load(String(value || "")); }

  /** 缓存键统一短哈希；进程内合并并发请求，SDK 缓存负责跨调用复用。 */
  async function cached(scope, kind, identity, ttlSeconds, loader, isCacheable) {
    const cacheKey = `omx:${configuration.id}:${kind}:${hash([scope, identity])}`;
    const current = memoryCache.get(cacheKey);
    if (current && current.expiresAt > Date.now() && (!isCacheable || isCacheable(current.value))) return current.value;
    if (pendingCache.has(cacheKey)) return pendingCache.get(cacheKey);
    const pending = (async () => {
      if (typeof OmniBox.getCache === "function") {
        try {
          const saved = await OmniBox.getCache(cacheKey);
          const record = typeof saved === "string" ? JSON.parse(saved) : saved;
          if (record && record.schema === 1 && record.expiresAt > Date.now() && Object.prototype.hasOwnProperty.call(record, "value") && (!isCacheable || isCacheable(record.value))) {
            memoryCache.set(cacheKey, record);
            return record.value;
          }
        } catch (error) { await log("error", "cache", `读取缓存失败，回退请求: ${error.message}`); }
      }
      const value = await loader();
      const canCache = isCacheable ? isCacheable(value) : value != null && (!Array.isArray(value) || value.length > 0) && (typeof value !== "string" || value.length > 0);
      if (canCache && ttlSeconds > 0) {
        const record = { schema: 1, expiresAt: Date.now() + ttlSeconds * 1000, value };
        memoryCache.set(cacheKey, record);
        if (memoryCache.size > 512) memoryCache.delete(memoryCache.keys().next().value);
        if (typeof OmniBox.setCache === "function") {
          try { await OmniBox.setCache(cacheKey, JSON.stringify(record), ttlSeconds); }
          catch (error) { await log("error", "cache", `写入缓存失败: ${error.message}`); }
        }
      }
      return value;
    })();
    pendingCache.set(cacheKey, pending);
    try { return await pending; }
    finally { pendingCache.delete(cacheKey); }
  }

  function absoluteUrl(value, host) {
    if (!value) return "";
    try {
      const parsed = new URL(String(value), `${host.replace(/\/+$/, "")}/`);
      return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : "";
    } catch (_) { return ""; }
  }

  function validateHost(value) {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || (!configuration.allowHostPath && parsed.pathname !== "/")) {
      throw new Error("站点地址必须为 HTTP(S) 根地址，不能包含认证信息、查询串或片段");
    }
    return parsed.href.replace(/\/+$/, "");
  }

  function parseJson(response) {
    try { return typeof response.body === "string" ? JSON.parse(response.body) : response.body; }
    catch (_) { throw new Error("上游未返回有效 JSON"); }
  }

  function assertHttp(response) {
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`上游 HTTP ${response.statusCode}`);
    return response;
  }

  /** 外部请求不继承网站会话，避免网盘链接或 TG 文章收到站点凭证。 */
  async function request(url, options = {}) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("请求地址不安全");
    await log("info", "request", `${options.method || "GET"} ${url}`);
    if (typeof OmniBox.request !== "function") throw new Error("当前环境缺少 OmniBox.request");
    const response = await OmniBox.request(url, {
      method: options.method || "GET",
      headers: { "User-Agent": userAgent, ...options.headers },
      ...(options.body == null ? {} : { body: options.body }),
    });
    return {
      statusCode: Number(response.statusCode ?? response.status ?? 200),
      headers: response.headers || {},
      body: typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? response.data ?? ""),
    };
  }

  /** 保留网站下发的 Set-Cookie，支持数组及含 Expires 逗号的响应头。 */
  function mergeCookies(currentCookie, responseHeaders) {
    const cookies = new Map(String(currentCookie || "").split(";").map(entry => entry.trim()).filter(Boolean).map(entry => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
    const headerName = Object.keys(responseHeaders).find(name => name.toLowerCase() === "set-cookie");
    const headers = headerName ? responseHeaders[headerName] : [];
    for (const header of Array.isArray(headers) ? headers : String(headers).split(/,(?=\s*[^;,=\s]+=)/)) {
      const pair = String(header).split(";")[0].trim();
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) cookies.set(name, value); else cookies.delete(name);
    }
    return Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; ");
  }

  function isCloudflare(response) {
    return /cf-chl-|challenge-platform|Just a moment|Attention Required.*Cloudflare/i.test(response.body) ||
      Object.entries(response.headers).some(([name, value]) => name.toLowerCase() === "cf-mitigated" && String(value).includes("challenge"));
  }

  function isRestrictedPage(response) {
    return Boolean(configuration.auth?.restrictedPattern && new RegExp(configuration.auth.restrictedPattern).test(response.body));
  }

  /** 站点缓存不能复用旧的空白、挑战或登录限制响应。 */
  function isUsableSiteResponse(response) {
    return Boolean(response && response.statusCode >= 200 && response.statusCode < 300 && typeof response.body === "string" && response.body.trim() && !isCloudflare(response) && !isRestrictedPage(response));
  }

  /** HTTP 200 不代表解盾或网站鉴权成功，新页面和旧缓存都需要校验。 */
  function isUsableCfPage(response) {
    return Boolean(response && response.statusCode === 200 && isUsableSiteResponse(response));
  }

  /** 仅配置 FLARESOLVERR_URL 时启用，直接复用完整页面，不拿 Cookie 自行重试。 */
  async function solveCloudflare(url, scope) {
    const endpointValue = getSetting("FLARESOLVERR_URL");
    if (!endpointValue) return null;
    return cached(scope, "cf-page", url, 300, async () => {
      const endpoint = new URL(endpointValue);
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("FLARESOLVERR_URL 地址无效");
      endpoint.pathname = endpoint.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1";
      const response = assertHttp(await request(endpoint.href, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60000 }),
      }));
      const data = parseJson(response);
      const solution = data && data.solution;
      if (data.status !== "ok" || !solution || typeof solution.response !== "string" || Number(solution.status) !== 200) throw new Error("FlareSolverr 未返回成功页面");
      if (solution.url && new URL(solution.url).origin !== new URL(url).origin) throw new Error("FlareSolverr 返回了跨站页面");
      const solvedResponse = { statusCode: Number(solution.status), headers: solution.headers || {}, body: solution.response };
      if (!isUsableCfPage(solvedResponse)) throw new Error("FlareSolverr 返回空白、挑战或受限页面");
      return solvedResponse;
    }, isUsableCfPage);
  }

  /** 每次 handler 使用独立缓存作用域，避免用全局变量保存调用上下文。 */
  function createHelpers(context) {
    const scope = String(context.sourceId || "default");
    const cache = (kind, identity, ttlSeconds, loader, isCacheable) => cached(scope, kind, identity, ttlSeconds, loader, isCacheable);

    async function getHostState() {
      const manual = getSetting(configuration.hostEnv || "__NO_SITE_ENV__");
      const stateKey = manual || "auto";
      if (hostStates.has(stateKey)) return hostStates.get(stateKey);
      const state = { manual: Boolean(manual), candidates: [], current: "" };
      if (manual) state.candidates = [validateHost(manual)];
      else {
        if (configuration.monitorName) {
          try {
            const discovered = await cache("monitor", configuration.monitorName, 3600, async () => {
              for (const monitorPath of ["/api/data", "/assets/data/monitor_data.json"]) {
                try {
                  const data = parseJson(assertHttp(await request(`https://pan-site-monitor.douer.me${monitorPath}`)));
                  const site = (data.sites || data.data?.sites || {})[configuration.monitorName];
                  if (site) return [site.best_url, ...(site.urls || []).filter(entry => entry.has_keyword !== false).map(entry => entry.url)].filter(Boolean);
                } catch (error) { await log("error", "domain", `域名监测失败: ${error.message}`); }
              }
              return [];
            });
            state.candidates.push(...discovered);
          } catch (error) { await log("error", "domain", `回退内置域名: ${error.message}`); }
        }
        state.candidates.push(...(configuration.hosts || []));
        state.candidates = state.candidates.flatMap(value => {
          try { return [validateHost(String(value))]; } catch (_) { return []; }
        });
      }
      state.candidates = Array.from(new Set(state.candidates));
      if (!state.candidates.length) throw new Error(`请配置 ${configuration.hostEnv || "站点地址"}`);
      state.current = state.candidates[0];
      hostStates.set(stateKey, state);
      return state;
    }

    async function getHost() { return (await getHostState()).current; }

    async function resolveSitePath(value) {
      const host = await getHost();
      const parsed = new URL(String(value), `${host}/`);
      if (parsed.origin !== new URL(host).origin || parsed.username || parsed.password || !["http:", "https:"].includes(parsed.protocol)) throw new Error("详情路径不能跨站");
      return parsed.pathname + parsed.search;
    }

    function readCredentials(host) {
      const auth = configuration.auth;
      if (!auth) return { key: "anonymous", cookie: "", username: "", password: "" };
      const credentials = { cookie: getSetting(auth.cookieEnv), username: getSetting(auth.usernameEnv), password: getSetting(auth.passwordEnv) };
      if (/[\x00-\x1f\x7f]/.test(credentials.cookie + credentials.username + credentials.password)) throw new Error("网站凭证包含控制字符");
      if (Boolean(credentials.username) !== Boolean(credentials.password)) throw new Error("网站账号和密码需同时配置");
      return { ...credentials, key: hash([host, credentials]) };
    }

    async function login(host, credentials) {
      const auth = configuration.auth;
      if (!credentials.username || !credentials.password) throw new Error(`请更新 ${auth.cookieEnv}，或配置网站账号密码`);
      const payload = { [auth.loginFields[0]]: credentials.username, [auth.loginFields[1]]: credentials.password };
      const response = assertHttp(await request(`${host}${auth.loginPath}`, {
        method: "POST", headers: { Referer: `${host}/`, "Content-Type": auth.json ? "application/json" : "application/x-www-form-urlencoded" },
        body: auth.json ? JSON.stringify(payload) : new URLSearchParams(payload).toString(),
      }));
      const data = parseJson(response);
      if (Number(data.code) !== auth.successCode) throw new Error("网站登录失败，请检查账号或权限");
      const cookie = mergeCookies("", response.headers);
      if (!cookie) throw new Error(`网站未下发会话，请手动配置 ${auth.cookieEnv}`);
      return { cookie };
    }

    async function getSession(host, credentials) {
      if (!configuration.auth) return { cookie: "" };
      if (sessions.has(credentials.key)) return sessions.get(credentials.key);
      const session = credentials.cookie ? { cookie: credentials.cookie } : credentials.username ?
        await cache("session", credentials.key, 900, () => login(host, credentials)) : { cookie: "" };
      sessions.set(credentials.key, session);
      return session;
    }

    /** 迟到的 401 优先复用已更新会话，不再次消费旧刷新令牌。 */
    async function refreshSession(host, credentials, session, rejectedCookie) {
      if (session.cookie !== rejectedCookie) return;
      if (sessionRefreshes.has(credentials.key)) return sessionRefreshes.get(credentials.key);
      const renewal = (async () => {
        const auth = configuration.auth;
        if (auth.refreshPath && session.cookie) {
          try {
            const response = assertHttp(await request(`${host}${auth.refreshPath}`, { method: "POST", headers: { Cookie: session.cookie, Referer: `${host}/` } }));
            const data = parseJson(response);
            const cookie = mergeCookies(session.cookie, response.headers);
            if (Number(data.code) === auth.successCode && cookie) { session.cookie = cookie; return; }
          } catch (error) { await log("error", "auth", `刷新网站会话失败: ${error.message}`); }
        }
        const renewed = await login(host, credentials);
        session.cookie = renewed.cookie;
      })();
      sessionRefreshes.set(credentials.key, renewal);
      try { await renewal; }
      finally { sessionRefreshes.delete(credentials.key); }
    }

    /** Cookie 只发往当前站点；401 或登录提示最多刷新一次，不缓存失败页。 */
    async function requestSite(sitePath, options = {}) {
      const state = await getHostState();
      const orderedHosts = [state.current, ...state.candidates.filter(host => host !== state.current)];
      let lastResponse;
      let lastError;
      for (const host of orderedHosts) {
        const url = absoluteUrl(sitePath, host);
        if (!url || new URL(url).origin !== new URL(host).origin) throw new Error("站点请求不能跨域");
        const credentials = readCredentials(host);
        const session = await getSession(host, credentials);
        if (options.requireAuth && !session.cookie) throw new Error(`取链需要网站登录，请配置 ${configuration.auth?.cookieEnv || "网站会话"}`);
        const work = async () => {
          let sentCookie;
          const send = () => {
            sentCookie = session.cookie;
            return request(url, {
              ...options,
              headers: { Referer: `${host}/`, ...(sentCookie ? { Cookie: sentCookie } : {}), ...options.headers },
            });
          };
          let response = await send();
          const restricted = isRestrictedPage(response);
          if (configuration.auth && (response.statusCode === 401 || restricted)) {
            await refreshSession(host, credentials, session, sentCookie);
            response = await send();
          }
          if (session.cookie === sentCookie) session.cookie = mergeCookies(session.cookie, response.headers);
          if ((!options.method || options.method === "GET") && isCloudflare(response) && getSetting("FLARESOLVERR_URL")) {
            response = await solveCloudflare(url, scope);
          }
          if (isRestrictedPage(response)) throw new Error("网站登录后仍无资源访问权限");
          return response;
        };
        try {
          lastResponse = options.ttl > 0 ? await cache("http", [url, options.method || "GET", options.body || "", credentials.key], options.ttl, work, isUsableSiteResponse) : await work();
          if (lastResponse.statusCode >= 200 && lastResponse.statusCode < 300 && !isCloudflare(lastResponse)) { state.current = host; return lastResponse; }
          if (lastResponse.statusCode === 429 || state.manual) return lastResponse;
          await log("error", "domain", `当前域名 HTTP ${lastResponse.statusCode}，尝试备用域名`);
        } catch (error) {
          lastError = error;
          if (state.manual || configuration.auth) throw error;
          await log("error", "domain", `域名请求失败，尝试备用: ${error.message}`);
        }
      }
      if (lastResponse) return lastResponse;
      throw lastError || new Error("所有站点域名均不可用");
    }

    async function fetchText(sitePath, options = {}) { return assertHttp(await requestSite(sitePath, options)).body; }
    async function fetchJson(sitePath, options = {}) { return parseJson(assertHttp(await requestSite(sitePath, options))); }

    return { getHost, request, requestSite, fetchText, fetchJson, cached: cache, loadHtml, extractShares, extractSharesFromHtml, normalizeShare, mergeShares, createVod, paginate, absoluteUrl, resolveSitePath, mapLimit, hash, getSetting, log };
  }

  /** 统一分享身份与提取码，去除仅影响展示的伪参数。 */
  function normalizeShare(value, suppliedPassword = "", title = "") {
    try {
      const parsed = new URL(String(value || "").replace(/&amp;/g, "&").replace(/\\\//g, "/"));
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      let provider = "";
      let shareId = "";
      const normalPath = parsed.pathname.match(/^\/s\/([A-Za-z0-9_-]+)/);
      const hostProviders = { "pan.quark.cn": "quark", "drive.uc.cn": "uc", "pan.baidu.com": "baidu", "115.com": "115", "anxia.com": "115", "115cdn.com": "115", "123pan.com": "123", "123pan.cn": "123", "123684.com": "123", "123912.com": "123", "123865.com": "123", "pan.xunlei.com": "xunlei", "guangyapan.com": "guangya", "aliyundrive.com": "aliyun", "alipan.com": "aliyun" };
      if (hostProviders[host] && normalPath) { provider = hostProviders[host]; shareId = normalPath[1]; }
      if (/^(?:[a-z0-9-]+\.)*(?:123pan|123684|123865|123912|123952|123592)\.(?:com|cn)$/.test(host)) {
        const pan123Path = parsed.pathname.match(/^\/(?:s|ps|123pan)\/([A-Za-z0-9_-]+)\/?$/);
        if (pan123Path) { provider = "123"; shareId = pan123Path[1]; }
      }
      if (host === "pan.baidu.com" && /^\/share\/init/.test(parsed.pathname) && parsed.searchParams.get("surl")) {
        provider = "baidu"; shareId = "1" + parsed.searchParams.get("surl");
        parsed.pathname = `/s/${shareId}`; parsed.searchParams.delete("surl");
      }
      if (host === "cloud.189.cn") { provider = "tianyi"; shareId = parsed.pathname.match(/^\/t\/([A-Za-z0-9_-]+)/)?.[1] || parsed.searchParams.get("code") || ""; }
      if (["yun.139.com", "caiyun.139.com"].includes(host)) { provider = "yidong"; shareId = (parsed.pathname + parsed.hash).match(/\/(?:w|m)\/i(?:\/|\?)([A-Za-z0-9_-]+)/)?.[1] || ""; }
      if (!provider || !shareId || !/^[A-Za-z0-9_-]+$/.test(shareId)) return null;
      const passwordNames = ["pwd", "password", "passcode", "accessCode", "access_code", "receive_code"];
      const barePassword = provider === "123" && /^\?[A-Za-z0-9]{4,8}$/.test(parsed.search) ? parsed.search.slice(1) : "";
      let passcode = passwordNames.map(name => parsed.searchParams.get(name)).find(Boolean) || suppliedPassword || barePassword || "";
      if (barePassword) parsed.search = "";
      if (!passcode && provider !== "tianyi") passcode = parsed.searchParams.get("code") || "";
      if (!passcode && provider === "guangya" && /^#[A-Za-z0-9]{4,8}$/.test(parsed.hash)) passcode = parsed.hash.slice(1);
      passcode = String(passcode).trim();
      if (passcode && !/^[A-Za-z0-9_-]{1,32}$/.test(passcode)) return null;
      for (const name of ["dn", "displayName", "filename", "title", "from", "utm_source", "utm_medium", "utm_campaign"]) parsed.searchParams.delete(name);
      for (const name of passwordNames) parsed.searchParams.delete(name);
      if (provider !== "tianyi") parsed.searchParams.delete("code");
      if (provider !== "yidong") parsed.hash = "";
      if (passcode) parsed.searchParams.set(provider === "115" ? "password" : "pwd", passcode);
      parsed.protocol = "https:";
      parsed.searchParams.sort();
      return { provider, shareId, passcode, url: parsed.href, title: String(title || "").trim(), key: `${provider}:${shareId}:${passcode}` };
    } catch (_) { return null; }
  }

  /** 冲突密码保留为独立分享；无密码重复项可被同身份的有密码项补齐。 */
  function mergeShares(...groups) {
    const shares = [];
    for (const entry of groups.flat()) {
      if (!entry) continue;
      const share = normalizeShare(typeof entry === "string" ? entry : entry.url, entry.passcode || entry.password, entry.title || entry.note);
      if (!share) continue;
      const sameIdentity = candidate => candidate.provider === share.provider && candidate.shareId === share.shareId;
      const existing = shares.find(candidate => sameIdentity(candidate) && (candidate.passcode === share.passcode || !candidate.passcode || !share.passcode));
      if (!existing) shares.push(share);
      else {
        if (!existing.passcode && share.passcode) Object.assign(existing, { url: share.url, passcode: share.passcode, key: share.key });
        if (share.title.length > existing.title.length) existing.title = share.title;
      }
    }
    return shares;
  }

  /** 只读取当前行或紧邻的密码行，遇下一链接停止，避免串用密码。 */
  function extractShares(value, titleHint = "") {
    const text = String(value || "").replace(/\\\//g, "/").replace(/&amp;/g, "&");
    const expression = /https?:\/\/[^\s<>"'`\\，。；、（）\[\]]+/gi;
    const matches = Array.from(text.matchAll(expression));
    const shares = matches.map((match, index) => {
      const url = match[0].replace(/[.,;!?)]+$/, "");
      const end = Math.min(matches[index + 1]?.index ?? text.length, match.index + match[0].length + 100);
      const nearbyLines = text.slice(match.index + match[0].length, end).split(/\r?\n/);
      const passwordLine = nearbyLines[1] && /^\s*(?:提取码|提取碼|访问码|訪問碼|密码|密碼|pass(?:word|code))/i.test(nearbyLines[1]) ? nearbyLines[1] : "";
      const nearby = nearbyLines[0] + " " + passwordLine;
      const passcode = nearby.match(/(?:提取码|提取碼|访问码|訪問碼|密码|密碼|pass(?:word|code))\s*[:：=]?\s*([A-Za-z0-9_-]{4,8})/i)?.[1] || "";
      return normalizeShare(url, passcode, titleHint);
    });
    return mergeShares(shares);
  }

  /** 保留下载行中的 URL、复制属性和换行边界，再做统一规范化去重。 */
  function extractSharesFromHtml(html, preferredSelector = "") {
    const document = loadHtml(html);
    function serializeNode(node) {
      if (node.type === "text") return node.data || "";
      if (["script", "style"].includes(node.name)) return "";
      const attributes = node.attribs || {};
      const urls = [attributes.href, attributes["data-clipboard-text"], attributes["data-url"]].filter(value => value && /https?:\/\//i.test(value));
      const content = (node.children || []).map(serializeNode).join("");
      const separator = ["p", "div", "li", "br", "section", "article"].includes(node.name) ? "\n" : " ";
      return urls.join(" ") + (urls.length ? " " : "") + content + separator;
    }
    function extractFromRoots(roots) {
      const shares = [];
      roots.each((index, element) => {
        const root = document(element);
        const anchors = root.find("a[href], [data-clipboard-text], [data-url]").addBack("a[href], [data-clipboard-text], [data-url]");
        anchors.each((anchorIndex, anchorElement) => {
          const anchor = document(anchorElement);
          const row = anchor.closest("li, .down-card, .pan-link-meta, .module-row-info, .module-row-one, p");
          const container = row.length ? row : anchor.parent();
          const label = String(anchor.attr("title") || anchor.text() || "").trim();
          const title = /^(?:百度|夸克|UC|115|123|迅雷|天翼|移动|光鸭|阿里)?(?:网盘|云盘)?(?:下载|链接|复制|打开)?$/i.test(label) ? "" : label;
          shares.push(...extractShares(serializeNode(container[0] || anchorElement), title));
        });
        shares.push(...extractShares(serializeNode(element)));
      });
      return mergeShares(shares);
    }
    if (preferredSelector) {
      const preferred = extractFromRoots(document(preferredSelector));
      if (preferred.length) return preferred;
    }
    return extractFromRoots(document.root());
  }

  function encodeValue(kind, value) { return `omx:${configuration.id}:${kind}:` + Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
  function decodeValue(kind, value) {
    const prefix = `omx:${configuration.id}:${kind}:`;
    if (typeof value !== "string" || !value.startsWith(prefix)) return null;
    try {
      const decoded = JSON.parse(Buffer.from(value.slice(prefix.length), "base64url").toString("utf8"));
      return decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded : null;
    } catch (_) { return null; }
  }

  function createVod(resource) {
    return {
      vod_id: encodeValue("vod", resource), vod_name: String(resource.title || resource.id || configuration.name),
      vod_pic: String(resource.pic || ""), vod_remarks: String(resource.remark || ""), vod_year: String(resource.year || ""),
      type_id: String(resource.typeId || ""), type_name: String(resource.typeName || ""), vod_tag: "video",
    };
  }

  function paginate(list, page, options = {}) {
    const currentPage = normalizePage(page);
    const pagecount = Number(options.pagecount) || (options.hasNext ? currentPage + 1 : list.length ? currentPage : Math.max(0, currentPage - 1));
    return { page: currentPage, pagecount, total: Number(options.total) || list.length, list };
  }

  async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await worker(items[index], index);
      }
    }));
    return results;
  }

  function readJsonSetting(name) {
    const value = getSetting(name);
    if (!value) return {};
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : {}; }
    catch (_) { void log("error", "config", `${name} 不是有效 JSON，使用默认配置`); return {}; }
  }

  function isProviderEnabled(provider) {
    const settings = readJsonSetting("DRIVE_TYPE_CONFIG");
    if (Array.isArray(settings)) return settings.includes(provider);
    const setting = settings[provider];
    return setting !== false && setting !== "disabled" && !(setting && setting.enabled === false);
  }

  /** 同分享内部串行扫目录，UC／123 直接读分享，其他网盘仍使用 SDK。 */
  async function loadDriveFiles(share, helpers) {
    const useDirectDrive = directDrive.supports(share.provider);
    if (!useDirectDrive && typeof OmniBox.getDriveFileList !== "function") throw new Error("当前宿主不支持网盘目录 SDK");
    // 新命名空间避免旧的 SDK 目录缓存缺少原生文件令牌却继续命中。
    return helpers.cached(useDirectDrive ? "direct-files-v1" : "drive-files", share.key, 300, async () => {
      const directories = ["0"];
      const visitedDirectories = new Set();
      const videoFiles = new Map();
      let complete = true;
      for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex++) {
        const directoryId = directories[directoryIndex];
        if (visitedDirectories.has(directoryId)) continue;
        if (visitedDirectories.size >= 1000) { complete = false; await log("error", "detail", "目录数超过安全上限，停止递归"); break; }
        visitedDirectories.add(directoryId);
        let response;
        try { response = useDirectDrive ? await directDrive.getFileList(share, directoryId) : await OmniBox.getDriveFileList(share.url, directoryId); }
        catch (error) {
          if (directoryId === "0") throw error;
          complete = false; await log("error", "detail", `子目录 ${directoryId} 读取失败，保留其他视频: ${error.message}`); continue;
        }
        const files = Array.isArray(response) ? response : response?.files || response?.list || response?.data?.files;
        if (!Array.isArray(files)) {
          if (directoryId === "0") throw new Error("网盘 SDK 未返回文件列表");
          complete = false;
          await log("error", "detail", `子目录 ${directoryId} 返回异常结构，保留其他视频`);
          continue;
        }
        if (response.has_more || response.hasMore) { complete = false; await log("error", "detail", "SDK 返回未完整分页目录，请检查宿主网盘适配器"); }
        for (const file of files) {
          if (!file || typeof file !== "object") continue;
          const fileId = String(file.fid ?? file.file_id ?? file.fileId ?? file.id ?? "");
          const fileName = String(file.file_name ?? file.fileName ?? file.name ?? "");
          if (!fileId) continue;
          const folder = file.dir === true || file.dir === 1 || file.is_dir === true || file.is_dir === 1 || file.is_dir === "1" || ["folder", "directory", "dir"].includes(file.format_type || file.type) || (file.file_type === 0 && file.format_type !== "video");
          if (folder) { if (!visitedDirectories.has(fileId)) directories.push(fileId); continue; }
          if (file.format_type === "video" || String(file.mime_type || file.mimeType || "").startsWith("video/") || videoExtension.test(fileName)) {
            videoFiles.set(fileId, { fileId, fileName: fileName || `视频-${fileId}`, size: Number(file.size || file.file_size || 0), ...(useDirectDrive ? { directFile: file.directFile } : {}) });
          }
        }
      }
      return { complete, files: Array.from(videoFiles.values()).sort((left, right) => naturalOrder.compare(left.fileName, right.fileName)) };
    }, result => result.complete && result.files.length > 0);
  }

  function formatPeople(value) {
    if (Array.isArray(value)) return value.map(person => typeof person === "string" ? person : person.name || "").filter(Boolean).join(" / ");
    return value == null ? "" : String(value);
  }

  function applyMetadata(video, metadata) {
    const scraped = metadata?.scrapeData || {};
    video.vod_name = String(scraped.title || scraped.name || video.vod_name);
    video.vod_pic = String(scraped.posterUrl || scraped.poster || scraped.posterPath || video.vod_pic);
    video.vod_content = String(scraped.overview || scraped.description || video.vod_content);
    video.vod_year = String(scraped.year || scraped.releaseDate?.slice(0, 4) || video.vod_year || "");
    video.vod_actor = formatPeople(scraped.actors || scraped.actor || video.vod_actor);
    video.vod_director = formatPeople(scraped.directors || scraped.director || video.vod_director);
    video.vod_area = formatPeople(scraped.area || scraped.country || scraped.countries || video.vod_area);
    video.vod_lang = formatPeople(scraped.language || scraped.lang || video.vod_lang);
    video.type_name = formatPeople(scraped.genres || scraped.typeName || video.type_name);
    video.vod_douban_score = String(scraped.voteAverage || scraped.rating || video.vod_douban_score || "");
    const mappings = metadata?.videoMappings || [];
    for (const source of video.vod_play_sources) {
      for (const episode of source.episodes) {
        const play = decodeValue("play", episode.playId);
        const mapping = mappings.find(entry => (entry.fileId || entry.file_id) === `${play.shareURL}|${play.fileId}`);
        if (!mapping) continue;
        if (mapping.episodeName) episode.name = mapping.episodeName;
        for (const field of ["episodeName", "episodeOverview", "episodeAirDate", "episodeStillPath", "episodeVoteAverage", "episodeRuntime"]) {
          if (mapping[field] != null) episode[field] = mapping[field];
        }
      }
    }
  }

  async function getCategories(helpers) { return adapter.getCategories ? await adapter.getCategories(helpers) : configuration.categories || []; }

  /** 首页保持真实分类；上游不可用时仍可展示分类入口。 */
  async function home(params = {}, context = {}) {
    const helpers = createHelpers(context);
    const filters = configuration.filters || {};
    let categories = configuration.categories || [];
    try {
      await log("info", "home", `from=${context.from || "web"}`);
      categories = await getCategories(helpers);
      const result = categories.length && adapter.category ? await adapter.category({ categoryId: categories[0].type_id, page: 1 }, helpers) : { list: [] };
      await log("info", "home", `分类=${categories.length} 推荐=${result.list.length}`);
      return { class: categories, list: result.list, filters };
    } catch (error) { await log("error", "home", error.message); return { class: categories, list: [], filters }; }
  }

  /** 分类参数只送入当前站点适配器，兼容宿主的筛选字段别名。 */
  async function category(params = {}, context = {}) {
    const page = normalizePage(params.page);
    try {
      await log("info", "category", `categoryId=${params.categoryId || ""} page=${page} from=${context.from || "web"}`);
      if (!adapter.category) return paginate([], page);
      const result = await adapter.category({ ...params, page, filters: params.filters || params.extend || params.ext || {} }, createHelpers(context));
      await log("info", "category", `返回=${result.list.length}`);
      return result;
    } catch (error) { await log("error", "category", error.message); return paginate([], page); }
  }

  /** 搜索结果是详情项，不让宿主误当文件夹继续钻取。 */
  async function search(params = {}, context = {}) {
    const page = normalizePage(params.page);
    const keyword = String(params.keyword || params.wd || "").trim();
    try {
      const loggedKeyword = /https?:\/\//i.test(keyword) ? `shareTextHash=${hash(keyword).slice(0, 16)}` : `keyword=${keyword.slice(0, 100)}`;
      await log("info", "search", `${loggedKeyword} page=${page} from=${context.from || "web"}`);
      if (!keyword || !adapter.search) return paginate([], page);
      const result = await adapter.search({ ...params, keyword, page }, createHelpers(context));
      await log("info", "search", `返回=${result.list.length}`);
      return result;
    } catch (error) { await log("error", "search", error.message); return paginate([], page); }
  }

  /** 分享展开、刮削和播放标识使用同构的 shareURL|fileId。 */
  async function detail(params = {}, context = {}) {
    try {
      const videoId = String(params.videoId || params.id || "");
      if (!videoId) return { list: [] };
      await log("info", "detail", `videoIdHash=${hash(videoId).slice(0, 16)} from=${context.from || "web"}`);
      const helpers = createHelpers(context);
      const pushedShares = extractShares(videoId);
      let resource = decodeValue("vod", videoId) || (pushedShares.length ? { id: videoId, title: params.title || "网盘资源", shares: pushedShares } : { id: videoId });
      if (!resource.shares?.length && adapter.detail) resource = { ...resource, ...await adapter.detail(resource, helpers) };
      let shares = mergeShares(resource.shares || []).filter(share => isProviderEnabled(share.provider));
      if (configuration.allowedProviders && !pushedShares.length) shares = shares.filter(share => configuration.allowedProviders.includes(share.provider));
      const driveOrder = getSetting("DRIVE_ORDER").split(/[,，\s]+/).filter(Boolean);
      if (driveOrder.length) shares.sort((left, right) => {
        const leftRank = driveOrder.indexOf(left.provider); const rightRank = driveOrder.indexOf(right.provider);
        return (leftRank < 0 ? driveOrder.length : leftRank) - (rightRank < 0 ? driveOrder.length : rightRank);
      });
      const maxRoutes = Number(getSetting("MAX_PAN_VALID_ROUTES", "0"));
      if (Number.isSafeInteger(maxRoutes) && maxRoutes > 0) shares = shares.slice(0, maxRoutes);
      if (!shares.length) throw new Error("未发现已启用网盘的有效分享链接");
      const video = { ...createVod(resource), vod_id: videoId, vod_content: String(resource.content || resource.remark || ""), vod_play_sources: [] };
      const candidates = [];
      const names = readJsonSetting("SOURCE_NAMES_CONFIG");
      const sources = await mapLimit(shares, 4, async share => {
        try {
          const catalog = await loadDriveFiles(share, helpers);
          if (!catalog.files.length) return null;
          let driveInfo = {};
          if (!directDrive.supports(share.provider) && typeof OmniBox.getDriveInfoByShareURL === "function") {
            try { driveInfo = await helpers.cached("drive-info", share.key, 3600, () => OmniBox.getDriveInfoByShareURL(share.url)); }
            catch (error) { await log("error", "detail", `网盘名称识别失败，使用本地名称: ${error.message}`); }
          }
          const name = names[share.provider] || driveInfo?.displayName || providerNames[share.provider] || share.provider;
          const episodes = catalog.files.map(file => {
            const fileKey = `${share.url}|${file.fileId}`;
            candidates.push({ fid: fileKey, file_id: fileKey, file_name: file.fileName, name: file.fileName, format_type: "video" });
            return {
              name: file.fileName, size: file.size,
              playId: encodeValue("play", { shareURL: share.url, fileId: file.fileId, fileName: file.fileName, vodId: videoId, title: resource.title || video.vod_name, pic: resource.pic || "" }),
            };
          });
          return { name: share.title ? `${name} - ${share.title}` : name, episodes };
        } catch (error) { await log("error", "detail", `${share.provider} 分享展开失败: ${error.message}`); return null; }
      });
      const lineCounts = new Map();
      video.vod_play_sources = sources.filter(Boolean).map(source => {
        const count = (lineCounts.get(source.name) || 0) + 1;
        lineCounts.set(source.name, count);
        return { ...source, name: count === 1 ? source.name : `${source.name} #${count}` };
      });
      if (!video.vod_play_sources.length) throw new Error("分享中未展开可播放视频，请检查宿主网盘账号或 SDK");
      if (typeof OmniBox.processScraping === "function") {
        try { await log("info", "detail", `刮削候选=${candidates.length}`); await OmniBox.processScraping(videoId, video.vod_name, video.vod_name, candidates); }
        catch (error) { await log("error", "detail", `刮削失败，保留网盘线路: ${error.message}`); }
      }
      if (typeof OmniBox.getScrapeMetadata === "function") {
        try { applyMetadata(video, await OmniBox.getScrapeMetadata(videoId)); }
        catch (error) { await log("error", "detail", `元数据回填失败: ${error.message}`); }
      }
      await log("info", "detail", `分享=${shares.length} 线路=${video.vod_play_sources.length} 视频=${candidates.length}`);
      return { list: [video] };
    } catch (error) { await log("error", "detail", error.message); return { list: [] }; }
  }

  /** 辅助 SDK 未公开取消接口，仅限制等待时间并清理本地计时器。 */
  async function waitWithinTimeBudget(operation, timeoutMilliseconds) {
    let timeoutTimer;
    const timeout = new Promise((resolve, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error("播放辅助链路超时")), timeoutMilliseconds);
    });
    try { return await Promise.race([operation, timeout]); }
    finally { clearTimeout(timeoutTimer); }
  }

  /** 原生令牌和下载地址只能来自可信目录缓存，不能信任客户端透传的上下文。 */
  async function getVideoPlayInfo(playData, flag, helpers) {
    const share = normalizeShare(playData.shareURL);
    if (directDrive.supports(share.provider)) {
      const catalog = await loadDriveFiles(share, helpers);
      const fileInfo = catalog.files.find(file => file.fileId === String(playData.fileId))?.directFile;
      if (!fileInfo) throw new Error("免登录分享中找不到原视频，请重新打开详情");
      await log("info", "play", `${share.provider} 使用专用免登录分享链路`);
      return directDrive.play(share, String(playData.fileId), fileInfo);
    }
    if (typeof OmniBox.getDriveVideoPlayInfo !== "function") throw new Error("当前宿主不支持网盘播放 SDK");
    return OmniBox.getDriveVideoPlayInfo(playData.shareURL, String(playData.fileId), flag);
  }

  /** 主播放与元数据/弹幕并行，辅助链路最多等待 2 秒，观看记录异步写入。 */
  async function play(params = {}, context = {}) {
    const flag = String(params.flag || "");
    try {
      const playData = decodeValue("play", params.playId);
      if (!playData || !normalizeShare(playData.shareURL) || !playData.fileId) throw new Error("播放标识无效，请重新打开详情");
      await log("info", "play", `fileId=${playData.fileId} flag=${flag} from=${context.from || "web"}`);
      const playPromise = getVideoPlayInfo(playData, flag, createHelpers(context));
      const metadataPromise = (async () => {
        let mapping;
        if (typeof OmniBox.getScrapeMetadata === "function") {
          try {
            const metadata = await OmniBox.getScrapeMetadata(playData.vodId);
            mapping = (metadata?.videoMappings || []).find(entry => (entry.fileId || entry.file_id) === `${playData.shareURL}|${playData.fileId}`);
          } catch (error) { await log("error", "play", `读取元数据失败: ${error.message}`); }
        }
        const fileName = mapping?.episodeName ? `${playData.title} ${mapping.episodeName}` : playData.fileName;
        const danmaku = typeof OmniBox.getDanmakuByFileName === "function" && fileName ? await OmniBox.getDanmakuByFileName(fileName) : [];
        return { mapping, danmaku };
      })();
      const [mainResult, metadataResult] = await Promise.allSettled([playPromise, waitWithinTimeBudget(metadataPromise, 2000)]);
      if (mainResult.status === "rejected") throw mainResult.reason;
      if (metadataResult.status === "rejected") await log("error", "play", `弹幕增强失败，继续播放: ${metadataResult.reason?.message}`);
      const playInfo = mainResult.value || {};
      const auxiliary = metadataResult.status === "fulfilled" ? metadataResult.value : { danmaku: [] };
      const rawUrls = playInfo.urls || (Array.isArray(playInfo.url) ? playInfo.url : playInfo.url?.values || [playInfo.url]);
      const urls = rawUrls.map((entry, index) => typeof entry === "string" ? { name: `播放${index + 1}`, url: entry } : entry).filter(entry => entry && typeof entry.url === "string" && entry.url);
      if (!urls.length) throw new Error("网盘 SDK 未返回播放地址");
      const header = playInfo.header || playInfo.headers || {};
      const danmaku = [...(Array.isArray(playInfo.danmaku) ? playInfo.danmaku : []), ...(Array.isArray(auxiliary.danmaku) ? auxiliary.danmaku : [])].filter((entry, index, entries) => entry?.url && entries.findIndex(candidate => candidate?.url === entry.url) === index);
      if (typeof OmniBox.addPlayHistory === "function") {
        Promise.resolve().then(() => OmniBox.addPlayHistory({
          vodId: playData.vodId, title: playData.title, episode: params.playId, pic: playData.pic,
          episodeName: auxiliary.mapping?.episodeName || playData.fileName, episodeNumber: auxiliary.mapping?.episodeNumber,
          playUrl: urls[0].url, playHeader: header,
        })).then(added => log("info", "history", added ? "观看记录已新增" : "观看记录已存在")).catch(error => log("error", "history", `添加记录失败: ${error.message}`));
      }
      await log("info", "play", `地址=${urls.length} 弹幕=${danmaku.length}`);
      return { ...playInfo, urls, flag: playInfo.flag || flag, header, parse: 0, danmaku };
    } catch (error) { await log("error", "play", error.message); return { urls: [], flag, header: {}, parse: 0, danmaku: [] }; }
  }

  return { home, category, detail, search, play };
}
