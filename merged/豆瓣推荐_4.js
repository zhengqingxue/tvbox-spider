// @name 豆瓣推荐
// @indexs 1
// @author lampon
// @description 豆瓣推荐爬虫脚本（本地增强：点开自动匹配片源 + 播放直出 + 搜索改走 rexxar）
// @version 1.1.3
// @downloadURL https://gh-proxy.org/https://github.com/xiaohu1949/OmniBox-Spider/raw/refs/heads/main/模板/JavaScript/豆瓣推荐.js

const OmniBox = require("omnibox_sdk");

// 导出接口
module.exports = {
  home,
  category,
  detail,
  search,
  play,
};

// 使用公共 runner 处理标准输入/输出
const runner = require("spider_runner");

/* ============================================================================
 * 短 TTL 缓存（v1.1.3 新增）
 * 客户端每次调用都是新进程，首页/分类同一份数据会被反复打上游。
 * 首页 + 分类页加 5 分钟缓存；空结果绝不入缓存（项目铁律）。
 * ============================================================================ */
const HOME_CACHE_TTL = 300; // 5 分钟
const CAT_CACHE_TTL = 300; // 5 分钟

async function readCache(key) {
  try {
    const raw = await OmniBox.getCache(key);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

async function writeCache(key, value, ttl) {
  try {
    if (!value || !Array.isArray(value.list) || value.list.length === 0) return;
    await OmniBox.setCache(key, JSON.stringify(value), ttl);
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

const safeCacheKey = (s) =>
  String(s).slice(0, 40).replace(/[^\w\u4e00-\u9fa5.-]/g, "_");

function buildDoubanSubjectLink(vodId) {
  return `https://movie.douban.com/subject/${vodId}`;
}


/**
 * 获取首页数据
 * @param {Object} params - 参数对象
 * @returns {Object} 返回分类列表和推荐视频列表
 */
async function home(params, context) {
  const cacheKey = `db:home:v1:${safeCacheKey((context && context.baseURL) || "")}`;
  try {
    const cached = await readCache(cacheKey);
    if (cached) return cached;

    // 构建分类列表
    const classes = [
      { type_id: "movie", type_name: "选电影" },
      { type_id: "tv", type_name: "选剧集" },
      { type_id: "show", type_name: "选综艺" },
      { type_id: "movie_filter", type_name: "电影筛选" },
      { type_id: "tv_filter", type_name: "电视剧筛选" },
      { type_id: "show_filter", type_name: "综艺筛选" },
    ];

    // 获取Banner数据（直接请求腾讯接口）
    let banner = [];
    try {
      const baseURL = context.baseURL || "";
      const tencentBannerUrl = "https://pbaccess.video.qq.com/trpc.vector_layout.page_view.PageService/getPage?video_appid=3000010&vversion_platform=2";

      // 构建请求体
      const requestData = {
        page_params: {
          page_type: "channel",
          page_id: "100113",
          scene: "channel",
          new_mark_label_enabled: "1",
          vl_to_mvl: "",
          free_watch_trans_info: "{\"ad_frequency_control_time_list\":{}}",
          ad_exp_ids: "100000",
          ams_cookies: "lv_play_index=26; o_minduid=CpGFdExDeM8uP-XHCyma_0PzurMADpcf; appuser=83C1297D3AE9DEFF",
          ad_trans_data: "{\"game_sessions\":[]}",
          skip_privacy_types: "0",
          support_click_scan: "1",
        },
        page_bypass_params: {
          params: {
            platform_id: "2",
            caller_id: "3000010",
            data_mode: "default",
            user_mode: "default",
            specified_strategy: "",
            page_type: "channel",
            page_id: "100113",
            scene: "channel",
            new_mark_label_enabled: "1",
          },
          scene: "channel",
          app_version: "",
          abtest_bypass_id: "aa836e91e1411155",
        },
        page_context: null,
      };

      const tencentBannerResponse = await OmniBox.request(tencentBannerUrl, {
        method: "POST",
        body: JSON.stringify(requestData),
      });

      if (tencentBannerResponse.statusCode === 200 && tencentBannerResponse.body) {
        let tencentBannerBodyStr = typeof tencentBannerResponse.body === "string" ? tencentBannerResponse.body : String(tencentBannerResponse.body);
        const tencentBannerData = JSON.parse(tencentBannerBodyStr);

        // 解析腾讯响应数据，提取轮播图卡片
        if (tencentBannerData.data && tencentBannerData.data.CardList && Array.isArray(tencentBannerData.data.CardList)) {
          for (const cardList of tencentBannerData.data.CardList) {
            // 只处理轮播图类型的卡片
            if (cardList.type === "pc_carousel" && cardList.children_list && cardList.children_list.list && cardList.children_list.list.cards) {
              const cards = cardList.children_list.list.cards;

              for (const card of cards) {
                // 只提取有背景图片的内容（pic_ori_2880x900）
                if (card.params && card.params.pic_ori_2880x900) {
                  // 处理背景图片URL
                  let backgroundImage = card.params.pic_ori_2880x900 || card.params.image_url || "";

                  // 如果图片URL是外部URL，需要通过代理
                  if (backgroundImage && baseURL && !backgroundImage.includes(baseURL) && backgroundImage.startsWith("http")) {
                    const urlWithHeaders = `${backgroundImage}@Referer=https://v.qq.com`;
                    const encodedUrl = encodeURIComponent(urlWithHeaders);
                    backgroundImage = `${baseURL}/api/proxy/image?url=${encodedUrl}`;
                  }

                  // 解析演员信息（从topic_label中提取）
                  let actors = "";
                  if (card.params.topic_label) {
                    const topicLabel = card.params.topic_label;
                    // topic_label格式可能是 "演员1 / 演员2" 或类似格式
                    const parts = topicLabel.split(" / ");
                    if (parts.length > 1) {
                      // 通常演员信息在后面的部分
                      actors = parts.slice(1).join(" / ");
                    } else {
                      actors = topicLabel;
                    }
                  }

                  banner.push({
                    title: card.params.title || card.params.title_pc || "",
                    subtitle: card.params.stitle_pc || card.params.material_video_subtitle || "",
                    backgroundImage: backgroundImage,
                    genre: card.params.main_genre || "",
                    actors: actors,
                    description: card.params.rec_normal_reason || "",
                  });

                  // 最多取5个
                  if (banner.length >= 5) {
                    break;
                  }
                }
              }

              // 如果已经取够5个，跳出外层循环
              if (banner.length >= 5) {
                break;
              }
            }
          }
        }
      }
    } catch (bannerError) {
      // Banner获取失败不影响首页数据返回
      await OmniBox.log("warn", `获取Banner数据失败: ${bannerError.message}`);
    }

    // 构建筛选条件
    // 选电影分类的筛选器
    const filters = {
      movie: [
        // 类型筛选器（category）
        {
          key: "category",
          name: "类型",
          init: "热门", // 默认值
          value: [
            { name: "热门", value: "热门" },
            { name: "最新", value: "最新" },
            { name: "豆瓣高分", value: "豆瓣高分" },
            { name: "冷门佳片", value: "冷门佳片" },
          ],
        },
        // 地区筛选器（type）
        {
          key: "type",
          name: "地区",
          init: "全部", // 默认值
          value: [
            { name: "全部", value: "全部" },
            { name: "华语", value: "华语" },
            { name: "欧美", value: "欧美" },
            { name: "韩国", value: "韩国" },
            { name: "日本", value: "日本" },
          ],
        },
      ],
      // 选剧集的筛选器
      tv: [
        {
          key: "type",
          name: "类型",
          init: "tv", // 默认值：国产剧
          value: [
            { name: "综合", value: "tv" },
            { name: "国产剧", value: "tv_domestic" },
            { name: "欧美剧", value: "tv_american" },
            { name: "日剧", value: "tv_japanese" },
            { name: "韩剧", value: "tv_korean" },
            { name: "动漫", value: "tv_animation" },
            { name: "纪录片", value: "tv_documentary" },
          ],
        },
      ],
      // 选综艺的筛选器
      show: [
        {
          key: "type",
          name: "类型",
          init: "show", // 默认值：综合
          value: [
            { name: "综合", value: "show" },
            { name: "国内", value: "show_domestic" },
            { name: "国外", value: "show_foreign" },
          ],
        },
      ],
      // 电影筛选的筛选器
      movie_filter: [
        // 类型筛选器
        {
          key: "genre",
          name: "类型",
          init: "", // 默认值：全部（空字符串）
          value: [
            { name: "全部", value: "" },
            { name: "喜剧", value: "喜剧" },
            { name: "爱情", value: "爱情" },
            { name: "动作", value: "动作" },
            { name: "科幻", value: "科幻" },
            { name: "动画", value: "动画" },
            { name: "悬疑", value: "悬疑" },
            { name: "犯罪", value: "犯罪" },
            { name: "惊悚", value: "惊悚" },
            { name: "冒险", value: "冒险" },
            { name: "音乐", value: "音乐" },
            { name: "历史", value: "历史" },
            { name: "奇幻", value: "奇幻" },
            { name: "恐怖", value: "恐怖" },
            { name: "战争", value: "战争" },
            { name: "传记", value: "传记" },
            { name: "歌舞", value: "歌舞" },
            { name: "武侠", value: "武侠" },
            { name: "情色", value: "情色" },
            { name: "灾难", value: "灾难" },
            { name: "西部", value: "西部" },
            { name: "纪录片", value: "纪录片" },
            { name: "短片", value: "短片" },
          ],
        },
        // 地区筛选器
        {
          key: "region",
          name: "地区",
          init: "", // 默认值：全部（空字符串）
          value: [
            { name: "全部", value: "" },
            { name: "华语", value: "华语" },
            { name: "欧美", value: "欧美" },
            { name: "韩国", value: "韩国" },
            { name: "日本", value: "日本" },
            { name: "中国大陆", value: "中国大陆" },
            { name: "美国", value: "美国" },
            { name: "中国香港", value: "中国香港" },
            { name: "中国台湾", value: "中国台湾" },
            { name: "英国", value: "英国" },
            { name: "法国", value: "法国" },
            { name: "德国", value: "德国" },
            { name: "意大利", value: "意大利" },
            { name: "西班牙", value: "西班牙" },
            { name: "印度", value: "印度" },
            { name: "泰国", value: "泰国" },
            { name: "俄罗斯", value: "俄罗斯" },
            { name: "加拿大", value: "加拿大" },
            { name: "澳大利亚", value: "澳大利亚" },
            { name: "爱尔兰", value: "爱尔兰" },
            { name: "瑞典", value: "瑞典" },
            { name: "巴西", value: "巴西" },
            { name: "丹麦", value: "丹麦" },
          ],
        },
        // 年代筛选器
        {
          key: "year",
          name: "年代",
          init: "", // 默认值：全部（空字符串）
          value: [
            { name: "全部", value: "" },
            { name: "2026", value: "2026" },
            { name: "2025", value: "2025" },
            { name: "2024", value: "2024" },
            { name: "2023", value: "2023" },
            { name: "2022", value: "2022" },
            { name: "2021", value: "2021" },
            { name: "2020", value: "2020" },
            { name: "2019", value: "2019" },
            { name: "2020年代", value: "2020年代" },
            { name: "2010年代", value: "2010年代" },
            { name: "2000年代", value: "2000年代" },
            { name: "90年代", value: "90年代" },
            { name: "80年代", value: "80年代" },
            { name: "70年代", value: "70年代" },
            { name: "60年代", value: "60年代" },
            { name: "更早", value: "更早" },
          ],
        },
        // 排序筛选器
        {
          key: "sort",
          name: "排序",
          init: "U", // 默认值：热度
          value: [
            { name: "热度", value: "U" },
            { name: "评分", value: "S" },
            { name: "时间", value: "R" },
          ],
        },
      ],
      // 电视剧筛选的筛选器
      tv_filter: [
        // 类型筛选器
        {
          key: "genre",
          name: "类型",
          init: "", // 默认值：全部（空字符串）
          value: [
            { name: "全部", value: "" },
            { name: "喜剧", value: "喜剧" },
            { name: "爱情", value: "爱情" },
            { name: "悬疑", value: "悬疑" },
            { name: "动画", value: "动画" },
            { name: "武侠", value: "武侠" },
            { name: "古装", value: "古装" },
            { name: "家庭", value: "家庭" },
            { name: "犯罪", value: "犯罪" },
            { name: "科幻", value: "科幻" },
            { name: "恐怖", value: "恐怖" },
            { name: "历史", value: "历史" },
            { name: "战争", value: "战争" },
            { name: "动作", value: "动作" },
            { name: "冒险", value: "冒险" },
            { name: "传记", value: "传记" },
            { name: "剧情", value: "剧情" },
            { name: "奇幻", value: "奇幻" },
            { name: "惊悚", value: "惊悚" },
            { name: "灾难", value: "灾难" },
            { name: "歌舞", value: "歌舞" },
            { name: "音乐", value: "音乐" },
          ],
        },
        // 地区筛选器
        {
          key: "region",
          name: "地区",
          init: "", // 默认值：全部（空字符串）
          value: [
            { name: "全部", value: "" },
            { name: "华语", value: "华语" },
            { name: "欧美", value: "欧美" },
            { name: "国外", value: "国外" },
            { name: "韩国", value: "韩国" },
            { name: "日本", value: "日本" },
            { name: "中国大陆", value: "中国大陆" },
            { name: "中国香港", value: "中国香港" },
            { name: "美国", value: "美国" },
            { name: "英国", value: "英国" },
            { name: "泰国", value: "泰国" },
            { name: "中国台湾", value: "中国台湾" },
            { name: "意大利", value: "意大利" },
            { name: "法国", value: "法国" },
            { name: "德国", value: "德国" },
            { name: "西班牙", value: "西班牙" },
            { name: "俄罗斯", value: "俄罗斯" },
            { name: "瑞典", value: "瑞典" },
            { name: "巴西", value: "巴西" },
            { name: "丹麦", value: "丹麦" },
            { name: "印度", value: "印度" },
            { name: "加拿大", value: "加拿大" },
            { name: "爱尔兰", value: "爱尔兰" },
            { name: "澳大利亚", value: "澳大利亚" },
          ],
        },
        // 年代筛选器
        {
          key: "year",
          name: "年代",
          init: "", // 默认值：全部（空字符串）
          value: [
            { name: "全部", value: "" },
            { name: "2026", value: "2026" },
            { name: "2025", value: "2025" },
            { name: "2024", value: "2024" },
            { name: "2023", value: "2023" },
            { name: "2022", value: "2022" },
            { name: "2021", value: "2021" },
            { name: "2020", value: "2020" },
            { name: "2019", value: "2019" },
            { name: "2020年代", value: "2020年代" },
            { name: "2010年代", value: "2010年代" },
            { name: "2000年代", value: "2000年代" },
            { name: "90年代", value: "90年代" },
            { name: "80年代", value: "80年代" },
            { name: "70年代", value: "70年代" },
            { name: "60年代", value: "60年代" },
            { name: "更早", value: "更早" },
          ],
        },
        // 平台筛选器
        {
          key: "platform",
          name: "平台",
          init: "", // 默认值：全部（空字符串）
          value: [
            { name: "全部", value: "" },
            { name: "腾讯视频", value: "腾讯视频" },
            { name: "爱奇艺", value: "爱奇艺" },
            { name: "优酷", value: "优酷" },
            { name: "湖南卫视", value: "湖南卫视" },
            { name: "Netflix", value: "Netflix" },
            { name: "HBO", value: "HBO" },
            { name: "BBC", value: "BBC" },
            { name: "NHK", value: "NHK" },
            { name: "CBS", value: "CBS" },
            { name: "NBC", value: "NBC" },
            { name: "tvN", value: "tvN" },
          ],
        },
        // 排序筛选器
        {
          key: "sort",
          name: "排序",
          init: "U", // 默认值：热度
          value: [
            { name: "热度", value: "U" },
            { name: "评分", value: "S" },
            { name: "时间", value: "R" },
          ],
        },
      ],
      // 综艺筛选的筛选器
      show_filter: [
        // 类型筛选器（只有4个选项）
        {
          key: "genre",
          name: "类型",
          init: "", // 默认值：全部（空字符串）
          value: [
            { name: "全部", value: "" },
            { name: "真人秀", value: "真人秀" },
            { name: "脱口秀", value: "脱口秀" },
            { name: "音乐", value: "音乐" },
            { name: "歌舞", value: "歌舞" },
          ],
        },
        // 地区筛选器（和电视剧筛选一样）
        {
          key: "region",
          name: "地区",
          init: "", // 默认值：全部（空字符串）
          value: [
            { name: "全部", value: "" },
            { name: "华语", value: "华语" },
            { name: "欧美", value: "欧美" },
            { name: "国外", value: "国外" },
            { name: "韩国", value: "韩国" },
            { name: "日本", value: "日本" },
            { name: "中国大陆", value: "中国大陆" },
            { name: "中国香港", value: "中国香港" },
            { name: "美国", value: "美国" },
            { name: "英国", value: "英国" },
            { name: "泰国", value: "泰国" },
            { name: "中国台湾", value: "中国台湾" },
            { name: "意大利", value: "意大利" },
            { name: "法国", value: "法国" },
            { name: "德国", value: "德国" },
            { name: "西班牙", value: "西班牙" },
            { name: "俄罗斯", value: "俄罗斯" },
            { name: "瑞典", value: "瑞典" },
            { name: "巴西", value: "巴西" },
            { name: "丹麦", value: "丹麦" },
            { name: "印度", value: "印度" },
            { name: "加拿大", value: "加拿大" },
            { name: "爱尔兰", value: "爱尔兰" },
            { name: "澳大利亚", value: "澳大利亚" },
          ],
        },
        // 年代筛选器（和电视剧筛选一样）
        {
          key: "year",
          name: "年代",
          init: "", // 默认值：全部（空字符串）
          value: [
            { name: "全部", value: "" },
            { name: "2026", value: "2026" },
            { name: "2025", value: "2025" },
            { name: "2024", value: "2024" },
            { name: "2023", value: "2023" },
            { name: "2022", value: "2022" },
            { name: "2021", value: "2021" },
            { name: "2020", value: "2020" },
            { name: "2019", value: "2019" },
            { name: "2020年代", value: "2020年代" },
            { name: "2010年代", value: "2010年代" },
            { name: "2000年代", value: "2000年代" },
            { name: "90年代", value: "90年代" },
            { name: "80年代", value: "80年代" },
            { name: "70年代", value: "70年代" },
            { name: "60年代", value: "60年代" },
            { name: "更早", value: "更早" },
          ],
        },
        // 平台筛选器（和电视剧筛选一样）
        {
          key: "platform",
          name: "平台",
          init: "", // 默认值：全部（空字符串）
          value: [
            { name: "全部", value: "" },
            { name: "腾讯视频", value: "腾讯视频" },
            { name: "爱奇艺", value: "爱奇艺" },
            { name: "优酷", value: "优酷" },
            { name: "湖南卫视", value: "湖南卫视" },
            { name: "Netflix", value: "Netflix" },
            { name: "HBO", value: "HBO" },
            { name: "BBC", value: "BBC" },
            { name: "NHK", value: "NHK" },
            { name: "CBS", value: "CBS" },
            { name: "NBC", value: "NBC" },
            { name: "tvN", value: "tvN" },
          ],
        },
        // 排序筛选器（和电视剧筛选一样）
        {
          key: "sort",
          name: "排序",
          init: "U", // 默认值：热度
          value: [
            { name: "热度", value: "U" },
            { name: "评分", value: "S" },
            { name: "时间", value: "R" },
          ],
        },
      ],
    };

    // 获取首页推荐列表（选剧集的综合数据）
    let list = [];
    try {
      const tvListUrl = "https://m.douban.com/rexxar/api/v2/subject/recent_hot/tv?start=0&limit=20&category=tv&type=tv";
      const tvListResponse = await OmniBox.request(tvListUrl, {
        method: "GET",
        headers: {
          "Accept": "*/*",
          "Accept-Encoding": "gzip, deflate, br",
          "Connection": "keep-alive",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "referer": "https://movie.douban.com/tv/",
        },
      });

      if (tvListResponse.statusCode === 200 && tvListResponse.body) {
        let tvListBodyStr = typeof tvListResponse.body === "string" ? tvListResponse.body : String(tvListResponse.body);
        const tvListData = JSON.parse(tvListBodyStr);

        if (tvListData.items && Array.isArray(tvListData.items)) {
          const baseURL = context.baseURL || "";

          list = tvListData.items.map((item) => {
            // 从 card_subtitle 提取年份信息
            let vod_year = "";
            const cardSubtitle = item.card_subtitle || "";
            const yearMatch = cardSubtitle.match(/^(\d{4})/);
            if (yearMatch) {
              vod_year = yearMatch[1];
            }

            // 构建备注信息
            let vod_remarks = "";
            if (item.episodes_info && item.episodes_info.trim()) {
              vod_remarks = item.episodes_info.trim();
            } else if (item.is_new) {
              vod_remarks = "新剧";
            }


            // 处理图片URL
            let vod_pic = item.pic?.large || item.pic?.normal || "";
            if (vod_pic) {
              const urlWithHeaders = `${vod_pic}@Referer=https://m.douban.com`;
              if (baseURL) {
                const encodedUrl = encodeURIComponent(urlWithHeaders);
                vod_pic = `${baseURL}/api/proxy/image?url=${encodedUrl}`;
              } else {
                vod_pic = urlWithHeaders;
              }
            }

            // 构建副标题（从card_subtitle提取，去除年份部分）
            let vod_subtitle = "";
            if (cardSubtitle) {
              const parts = cardSubtitle.split(" / ");
              if (parts.length > 1) {
                vod_subtitle = parts.slice(1).join(" / ");
              } else {
                vod_subtitle = cardSubtitle;
              }
            }

            return {
              vod_id: item.id || `douban_${item.uri}`,
              link: buildDoubanSubjectLink(item.id || `douban_${item.uri}`),
              vod_name: item.title || "",
              vod_pic: vod_pic,
              type_id: "tv",
              search: true,
              type_name: "选剧集",
              vod_remarks: vod_remarks,
              vod_year: vod_year,
              vod_douban_score: item.rating?.value ? item.rating.value.toString() : "",
              vod_subtitle: vod_subtitle,
            };
          });
        }
      }
    } catch (listError) {
      // 列表获取失败不影响首页数据返回
      await OmniBox.log("warn", `获取首页列表数据失败: ${listError.message}`);
    }

    const result = {
      class: classes,
      list: list, // 返回选剧集的综合数据
      filters: filters,
      banner: banner, // 返回Banner数据
    };
    await writeCache(cacheKey, result, HOME_CACHE_TTL);
    return result;
  } catch (error) {
    return {
      class: [],
      list: [],
      filters: {},
    };
  }
}

/**
 * 获取分类数据
 * @param {Object} params - 参数对象
 *   - categoryId: 分类ID（必填，movie、tv 或 show）
 *   - page: 页码（必填，默认1）
 *   - filters: 筛选条件（可选，JSON对象）
 *     格式：{ "category": "热门", "type": "全部" } 或 { "type": "tv_domestic" }
 * @returns {Object} 返回视频列表
 *   - list: 视频列表
 *   - page: 当前页码
 *   - pagecount: 总页数
 *   - total: 总记录数
 */
async function category(params, context) {
  try {
    const categoryId = params.categoryId || "movie";
    const page = params.page || 1;
    const filters = params.filters || {};
    const cacheKey = `db:cat:v1:${safeCacheKey(categoryId)}:${page}:${safeCacheKey(JSON.stringify(filters))}`;
    const cached = await readCache(cacheKey);
    if (cached) return cached;

    const limit = 20; // 每页数量
    const start = (page - 1) * limit;
    let url = "";
    let referer = "";

    // 根据分类ID构建不同的请求URL和referer
    if (categoryId === "movie") {
      // 电影分类
      const category = filters.category || "热门";
      const type = filters.type || "全部";
      url = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/movie?start=${start}&limit=${limit}&category=${encodeURIComponent(category)}&type=${encodeURIComponent(type)}`;
      referer = "https://movie.douban.com/explore";
    } else if (categoryId === "tv" || categoryId === "show") {
      // 剧集和综艺使用同一个接口，但category参数不同
      const category = categoryId; // tv 或 show
      const type = filters.type || (categoryId === "tv" ? "tv_domestic" : "show");
      url = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/tv?start=${start}&limit=${limit}&category=${encodeURIComponent(category)}&type=${encodeURIComponent(type)}`;
      referer = categoryId === "tv" ? "https://movie.douban.com/tv/" : "https://movie.douban.com/tv/";
    } else if (categoryId === "movie_filter") {
      // 电影筛选分类
      const genre = filters.genre || ""; // 类型，全部为空字符串
      const region = filters.region || ""; // 地区，全部为空字符串
      const year = filters.year || ""; // 年代，全部为空字符串
      const sort = filters.sort || "U"; // 排序，默认热度

      // 构建 selected_categories JSON
      const selectedCategories = {};
      if (genre) selectedCategories["类型"] = genre;
      if (region) selectedCategories["地区"] = region;
      const selectedCategoriesStr = JSON.stringify(selectedCategories);

      // 构建 tags 参数（逗号分隔：类型,地区,年份）
      const tagsArray = [];
      if (genre) tagsArray.push(genre);
      if (region) tagsArray.push(region);
      if (year) tagsArray.push(year);
      const tags = tagsArray.join(",");

      // 构建完整URL
      url = `https://m.douban.com/rexxar/api/v2/movie/recommend?refresh=0&start=${start}&count=${limit}&selected_categories=${encodeURIComponent(selectedCategoriesStr)}&uncollect=false&score_range=0,10&tags=${encodeURIComponent(tags)}&sort=${sort}`;
      referer = "https://movie.douban.com/explore";
    } else if (categoryId === "tv_filter") {
      // 电视剧筛选分类
      const genre = filters.genre || ""; // 类型，全部为空字符串
      const region = filters.region || ""; // 地区，全部为空字符串
      const year = filters.year || ""; // 年代，全部为空字符串
      const platform = filters.platform || ""; // 平台，全部为空字符串
      const sort = filters.sort || "U"; // 排序，默认热度

      // 构建 selected_categories JSON（形式固定为"电视剧"）
      const selectedCategories = { "形式": "电视剧" };
      if (genre) selectedCategories["类型"] = genre;
      if (region) selectedCategories["地区"] = region;
      const selectedCategoriesStr = JSON.stringify(selectedCategories);

      // 构建 tags 参数（逗号分隔：类型,地区,年份,平台）
      const tagsArray = [];
      if (genre) tagsArray.push(genre);
      if (region) tagsArray.push(region);
      if (year) tagsArray.push(year);
      if (platform) tagsArray.push(platform);
      const tags = tagsArray.join(",");

      // 构建完整URL
      url = `https://m.douban.com/rexxar/api/v2/tv/recommend?refresh=0&start=${start}&count=${limit}&selected_categories=${encodeURIComponent(selectedCategoriesStr)}&uncollect=false&score_range=0,10&tags=${encodeURIComponent(tags)}&sort=${sort}`;
      referer = "https://movie.douban.com/tv/";
    } else if (categoryId === "show_filter") {
      // 综艺筛选分类（使用和电视剧筛选相同的接口）
      const genre = filters.genre || ""; // 类型，全部为空字符串
      const region = filters.region || ""; // 地区，全部为空字符串
      const year = filters.year || ""; // 年代，全部为空字符串
      const platform = filters.platform || ""; // 平台，全部为空字符串
      const sort = filters.sort || "U"; // 排序，默认热度

      // 构建 selected_categories JSON（形式固定为"综艺"）
      const selectedCategories = { "形式": "综艺" };
      if (genre) selectedCategories["类型"] = genre;
      if (region) selectedCategories["地区"] = region;
      const selectedCategoriesStr = JSON.stringify(selectedCategories);

      // 构建 tags 参数（逗号分隔：类型,地区,年份,平台）
      const tagsArray = [];
      if (genre) tagsArray.push(genre);
      if (region) tagsArray.push(region);
      if (year) tagsArray.push(year);
      if (platform) tagsArray.push(platform);
      const tags = tagsArray.join(",");

      // 构建完整URL（使用和电视剧筛选相同的接口）
      url = `https://m.douban.com/rexxar/api/v2/tv/recommend?refresh=0&start=${start}&count=${limit}&selected_categories=${encodeURIComponent(selectedCategoriesStr)}&uncollect=false&score_range=0,10&tags=${encodeURIComponent(tags)}&sort=${sort}`;
      referer = "https://movie.douban.com/tv/";
    } else {
      throw new Error(`未知的分类ID: ${categoryId}`);
    }
    // 发送请求
    // SDK 现在支持自动解压 gzip/br 压缩数据
    const response = await OmniBox.request(url, {
      method: "GET",
      headers: {
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "referer": referer,
      },
    });

    // 检查响应状态
    if (response.statusCode !== 200) {
      throw new Error(`HTTP请求失败: ${response.statusCode}`);
    }

    // 检查响应体
    if (!response.body) {
      throw new Error("响应体为空");
    }

    // SDK 已自动处理 gzip/br/deflate 解压，response.body 应该是字符串
    let bodyStr = typeof response.body === "string" ? response.body : String(response.body);

    // 尝试解析响应数据
    let data;
    try {
      data = JSON.parse(bodyStr);
    } catch (parseError) {
      throw new Error(`JSON解析失败: ${parseError.message}`);
    }

    // 检查数据格式（movie_filter和tv_filter返回的字段名是items，其他是items）
    if (!data.items || !Array.isArray(data.items)) {
      throw new Error("API返回数据格式错误");
    }

    // 根据分类ID确定分类名称
    const categoryNames = {
      movie: "选电影",
      tv: "选剧集",
      show: "选综艺",
      movie_filter: "电影筛选",
      tv_filter: "电视剧筛选",
      show_filter: "综艺筛选",
    };
    const typeName = categoryNames[categoryId] || "未知分类";

    // 转换数据格式
    const list = data.items.map((item) => {
      // 从 card_subtitle 提取年份信息
      // 格式示例: "2025 / 中国香港 中国大陆 / 剧情 犯罪 / 麦浚龙 / 金城武 刘青云"
      // 或: "2026 / 中国大陆 / 剧情 / 孙皓 / 赵丽颖 黄晓明"
      let vod_year = "";
      const cardSubtitle = item.card_subtitle || "";
      const yearMatch = cardSubtitle.match(/^(\d{4})/);
      if (yearMatch) {
        vod_year = yearMatch[1];
      }

      // 构建备注信息
      let vod_remarks = "";

      // 对于剧集和综艺，优先显示集数信息
      if (item.episodes_info && item.episodes_info.trim()) {
        vod_remarks = item.episodes_info.trim();
      } else if (item.is_new) {
        vod_remarks = categoryId === "movie" ? "新片" : "新剧";
      }


      // 处理图片URL，使用通用图片代理接口
      // 通过环境变量获取baseURL（脚本执行时会自动注入）
      const baseURL = context.baseURL || "";
      let vod_pic = item.pic?.large || item.pic?.normal || "";
      if (vod_pic) {
        // 构建带headers的URL格式: url@Referer=value
        const urlWithHeaders = `${vod_pic}@Referer=https://m.douban.com`;

        // 如果有baseURL，拼接完整的代理接口地址
        if (baseURL) {
          // 编码URL参数
          const encodedUrl = encodeURIComponent(urlWithHeaders);
          vod_pic = `${baseURL}/api/proxy/image?url=${encodedUrl}`;
        } else {
          // 如果没有baseURL，返回带headers的原始格式（兼容旧版本）
          vod_pic = urlWithHeaders;
        }
      }

      // 构建副标题（从card_subtitle提取，去除年份部分）
      let vod_subtitle = "";
      if (cardSubtitle) {
        // 格式: "2025 / 中国香港 中国大陆 / 剧情 犯罪 / 麦浚龙 / 金城武 刘青云"
        // 副标题：去除年份，保留其他信息
        const parts = cardSubtitle.split(" / ");
        if (parts.length > 1) {
          vod_subtitle = parts.slice(1).join(" / ");
        } else {
          // 如果没有年份，直接使用整个card_subtitle
          vod_subtitle = cardSubtitle;
        }
      }

      return {
        vod_id: item.id || `douban_${item.uri}`,
        link: buildDoubanSubjectLink(item.id || `douban_${item.uri}`),
        vod_name: item.title || "",
        search: true,
        vod_pic: vod_pic,
        type_id: categoryId,
        type_name: typeName,
        vod_remarks: vod_remarks,
        vod_year: vod_year,
        vod_douban_score: item.rating?.value ? item.rating.value.toString() : "",
        vod_subtitle: vod_subtitle, // 添加副标题
      };
    });

    // 计算总页数（movie_filter和tv_filter返回的字段名是total，其他可能不同）
    const total = data.total || data.count || list.length;
    const pagecount = Math.ceil(total / limit);
    const result = {
      page: page,
      pagecount: pagecount,
      total: total,
      list: list,
    };
    await writeCache(cacheKey, result, CAT_CACHE_TTL);
    return result;
  } catch (error) {
    return {
      page: params.page || 1,
      pagecount: 0,
      total: 0,
      list: [],
    };
  }
}

/* ============================================================================
 * 点开即播：详情（detail）与源内搜索（search）
 * ----------------------------------------------------------------------------
 * 豆瓣本身只有元数据、没有片源，所以这里做「豆瓣选片 → 自动匹配可播线路」：
 *   1. 用豆瓣 subject id 取片名/年份/简介；
 *   2. 拿片名去荐片（h5.jianpianips1.com）搜索；
 *   3. 用荐片的 douban_id 字段与豆瓣 id 精确比对（该字段就是豆瓣 subject id）；
 *   4. 命中后取其直连 m3u8 线路作为播放线路返回。
 * 全部失败时降级为「只返回豆瓣信息」，不会报错。
 * ============================================================================ */

// 片源后端：荐片
const JP_HOST = "https://h5.jianpianips1.com";
const JP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "Origin": JP_HOST,
  "Referer": JP_HOST + "/",
};

// 豆瓣移动端（rexxar）接口请求头
const DB_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Accept": "*/*",
  "Referer": "https://m.douban.com/",
};

// 与「荐片」源一致的垃圾线路过滤（VIP/FTP/常规线路不可稳定播放）
const BLOCK_LINE_RE = /vip|ftp|常规/i;

const REQ_TIMEOUT = 12000;

// 播放请求头（这些 CDN 直链实测裸 UA 即可取流，Referer 按各自 origin 补齐）
const PLAY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// 判断一个地址是不是媒体流直链（可 parse:0 直接交给播放器）
const MEDIA_URL_RE = /\.(m3u8|mp4|flv|ts|mkv)(\?|#|$)/i;

// 从 playId 中剥出真正的媒体地址
function normalizePlayUrl(rawPlayId) {
  let url = String(rawPlayId || "").trim();
  if (!url) return "";
  // 兼容 url|||metaB64 透传格式
  if (url.includes("|||")) url = url.split("|||")[0];
  // 兼容 `线路名$地址` 与 `m3u8$地址` 前缀
  const dollar = url.lastIndexOf("$");
  if (dollar >= 0 && dollar < url.length - 1) {
    const tail = url.slice(dollar + 1);
    if (/^https?:\/\//i.test(tail) || /^\/\//.test(tail)) url = tail;
  }
  if (url.startsWith("//")) url = "https:" + url;
  return url.trim();
}

async function httpJson(url, headers, timeout) {
  const response = await OmniBox.request(url, {
    method: "GET",
    headers: headers,
    timeout: timeout || REQ_TIMEOUT,
  });
  const bodyStr =
    typeof response.body === "string" ? response.body : String(response.body || "");
  if (response.statusCode !== 200) {
    throw new Error(`HTTP ${response.statusCode}`);
  }
  return JSON.parse(bodyStr);
}

// 归一化片名，用于比对（去掉不可见字符、标点、年份、常见后缀）
function stripTitle(str) {
  return String(str || "")
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "")
    .toLowerCase()
    .replace(/[\s·・:：\-—–_()（）\[\]【】!！?？,，.。'"“”‘’]/g, "")
    .replace(/(19|20)\d{2}$/, "")
    .replace(/(国语|粤语|英语|中字|中英|双语|高清|超清|蓝光|正片|完整版)+$/g, "");
}

// 取豆瓣单片信息（电影/剧集都试一遍）
async function getDoubanSubject(id) {
  const types = ["movie", "tv"];
  for (const type of types) {
    try {
      const data = await httpJson(
        `https://m.douban.com/rexxar/api/v2/${type}/${id}`,
        DB_HEADERS
      );
      if (data && (data.title || data.name)) return data;
    } catch (e) {
      // 换下一个类型
    }
  }
  return null;
}

// 荐片搜索
async function jpSearch(keyword) {
  const params = new URLSearchParams();
  params.append("keyword", keyword);
  params.append("page", 1);
  const data = await httpJson(
    `${JP_HOST}/api/v2/search/videoV2?key=${params.toString()}`,
    JP_HEADERS
  );
  if (!data || data.code !== 1 || !Array.isArray(data.data)) return [];
  return data.data.filter((item) => item && item.id && String(item.id) !== "0");
}

// 荐片单片详情
async function jpDetail(videoId) {
  const data = await httpJson(
    `${JP_HOST}/api/video/detailv2?id=${encodeURIComponent(videoId)}`,
    JP_HEADERS
  );
  if (!data || data.code !== 1 || !data.data) return null;
  return data.data;
}

/**
 * 用豆瓣 id + 片名在荐片里找可播片源
 * @returns {Promise<{data: Object, matchedBy: string}|null>}
 */
async function matchPlayable(doubanId, title, year) {
  const wanted = stripTitle(title);
  if (!wanted) return null;

  const candidates = await jpSearch(title);
  if (!candidates.length) return null;

  const exact = candidates.filter((item) => stripTitle(item.title) === wanted);
  const pool = (exact.length ? exact : candidates).slice(0, 6);

  const details = await Promise.all(
    pool.map((item) => jpDetail(item.id).catch(() => null))
  );

  // 1) douban_id 完全一致（最可信）
  const byDoubanId = details.find(
    (d) =>
      d &&
      String(d.douban_id || "") === String(doubanId) &&
      (d.source_list_source || []).length > 0
  );
  if (byDoubanId) return { data: byDoubanId, matchedBy: "douban_id" };

  // 2) 片名一致 + 年份一致
  const byNameYear = details.find(
    (d) =>
      d &&
      (d.source_list_source || []).length > 0 &&
      stripTitle(d.title) === wanted &&
      (!year || !d.year || String(d.year) === String(year))
  );
  if (byNameYear) return { data: byNameYear, matchedBy: "title+year" };

  // 3) 仅片名一致
  const byName = details.find(
    (d) =>
      d && (d.source_list_source || []).length > 0 && stripTitle(d.title) === wanted
  );
  if (byName) return { data: byName, matchedBy: "title" };

  return null;
}

// 解析播放地址：detail 里写入的 playId 已经是可直连的 m3u8，play 只做透传 + 补请求头
async function play(params, context) {
  const p = params || {};
  const flag = p.flag || "play";
  try {
    const rawPlayId = p.playId || p.url || p.id || "";
    const url = normalizePlayUrl(rawPlayId);
    if (!url) {
      await OmniBox.log("warn", "[豆瓣推荐] play 收到空地址");
      return { url: "", flag, urls: [], parse: 1, header: {} };
    }

    const header = { "User-Agent": PLAY_UA };
    try {
      header.Referer = new URL(url).origin + "/";
    } catch (e) {
      /* 非标准 URL，忽略 */
    }

    // 网页端（影视仓 Web/模拟器）不吃自定义请求头，交给宿主自己处理
    const isWeb = context && context.from === "web";
    const finalHeader = isWeb ? {} : header;

    // 只有「确认是媒体流」的地址才 parse:0 直出；
    // 其余 http 地址（可能是 HTML 详情页/解析页）一律 parse:1 交给宿主嗅探，
    // 否则客户端会把网页当视频播，报"无法播放"。
    if (MEDIA_URL_RE.test(url)) {
      await OmniBox.log("info", `[豆瓣推荐] 播放直出 url=${url.slice(0, 110)}`);
      return {
        flag,
        urls: [{ name: p.episodeName || p.flag || "播放", url }],
        parse: 0,
        header: finalHeader,
        playId: url,
      };
    }

    // 非媒体直链：退回解析模式，交给宿主嗅探
    await OmniBox.log("info", `[豆瓣推荐] 播放转解析 url=${url.slice(0, 110)}`);
    return {
      flag,
      urls: [{ name: p.episodeName || p.flag || "播放", url }],
      parse: 1,
      header: finalHeader,
    };
  } catch (error) {
    await OmniBox.log("error", `[豆瓣推荐] 播放失败: ${error.message}`);
    return { url: "", flag, urls: [], parse: 1, header: {} };
  }
}

// 荐片的 source_list_source -> OmniBox vod_play_sources（只保留 http(s) 直链）
function buildPlaySources(sourceListSource) {
  const playSources = [];
  const seen = {}; // 线路内容去重：多条线路指向同一批地址时只保留第一条
  for (const line of sourceListSource || []) {
    const lineName = line && line.name ? String(line.name) : "线路";
    if (BLOCK_LINE_RE.test(lineName)) continue;
    const rawEpisodes = Array.isArray(line && line.source_list) ? line.source_list : [];
    const episodes = [];
    for (let i = 0; i < rawEpisodes.length; i++) {
      const ep = rawEpisodes[i] || {};
      const url = ep.url || "";
      if (!url || !/^https?:\/\//i.test(url)) continue;
      episodes.push({
        name: ep.source_name || `第${i + 1}集`,
        playId: url,
        episodeName: ep.source_name || `第${i + 1}集`,
      });
    }
    if (episodes.length === 0) continue;

    const signature = episodes.map((e) => e.playId).join("|");
    if (seen[signature]) continue;
    seen[signature] = true;
    playSources.push({ name: lineName, episodes: episodes });
  }
  return playSources;
}

// 豆瓣图片走宿主图片代理（豆瓣图需要 Referer）
function proxifyPic(picUrl, baseURL) {
  if (!picUrl) return "";
  if (!baseURL || picUrl.indexOf(baseURL) === 0 || !/^https?:\/\//i.test(picUrl)) {
    return picUrl;
  }
  return `${baseURL}/api/proxy/image?url=${encodeURIComponent(
    `${picUrl}@Referer=https://m.douban.com`
  )}`;
}

/**
 * 详情（点开条目）：豆瓣元数据 + 自动匹配的可播线路
 */
async function detail(params, context) {
  try {
    const rawIds = params.videoId || params.ids || params.id || "";
    const rawId = String(Array.isArray(rawIds) ? rawIds[0] : rawIds).split(",")[0];
    const idHit = rawId.match(/\d{4,}/);
    if (!idHit) return { list: [] };

    const doubanId = idHit[0];
    const baseURL = (context && context.baseURL) || "";

    const subject = await getDoubanSubject(doubanId).catch(() => null);
    const title = (subject && (subject.title || subject.name)) || "";
    const year = (subject && subject.year) || "";

    let matched = null;
    if (title) {
      matched = await matchPlayable(doubanId, title, year).catch(() => null);
    }

    const playSources = matched
      ? buildPlaySources(matched.data.source_list_source)
      : [];

    await OmniBox.log(
      "info",
      `[豆瓣推荐] 点开 id=${doubanId} 片名=${title || "-"} 匹配=${
        matched ? matched.matchedBy : "无"
      } 线路=${
        playSources.map((s) => `${s.name}(${s.episodes.length})`).join(" ") || "无"
      }`
    );

    const dd = (matched && matched.data) || {};
    const cast = subject && Array.isArray(subject.actors) ? subject.actors : [];
    const directors =
      subject && Array.isArray(subject.directors) ? subject.directors : [];
    const rating =
      (subject && subject.rating && subject.rating.value) ||
      dd.score ||
      "";

    const vod = {
      vod_id: doubanId,
      vod_name: dd.title || title || String(doubanId),
      vod_pic: proxifyPic(
        (subject && subject.pic && (subject.pic.large || subject.pic.normal)) ||
          dd.tvimg ||
          dd.thumbnail ||
          "",
        baseURL
      ),
      vod_content: (subject && subject.intro) || dd.description || "",
      vod_year: String(year || dd.year || ""),
      vod_area:
        (subject && subject.regions && subject.regions.join(" ")) ||
        (subject && subject.countries && subject.countries.join(" ")) ||
        "",
      vod_actor: cast
        .map((a) => (a && (a.name || a.latin_name)) || "")
        .filter(Boolean)
        .join(" "),
      vod_director: directors
        .map((d) => (d && d.name) || "")
        .filter(Boolean)
        .join(" "),
      vod_douban_score: rating ? String(rating) : "",
      vod_remarks: playSources.length
        ? `已匹配 ${playSources.length} 条线路`
        : "暂无片源",
      type_name: "豆瓣推荐",
    };
    if (playSources.length > 0) vod.vod_play_sources = playSources;

    return { list: [vod] };
  } catch (error) {
    await OmniBox.log("error", `[豆瓣推荐] 详情失败: ${error.message}`);
    return { list: [] };
  }
}

/**
 * 源内搜索：豆瓣联想接口，结果点开后同样会自动匹配可播片源
 */
async function search(params, context) {
  const empty = { page: 1, pagecount: 0, total: 0, list: [] };
  try {
    const keyword = String(params.keyword || params.wd || "").trim();
    const page = params.page || 1;
    if (!keyword) return empty;

    const baseURL = (context && context.baseURL) || "";
    // 🔴 v1.1.2：豆瓣 /j/subject_suggest 已失效（恒返回 200 + []，10-08 全网实测），
    //    换移动端 rexxar 搜索 /rexxar/api/v2/search/movie?q=（免登录，同 detail 一族接口）
    const data = await httpJson(
      `https://m.douban.com/rexxar/api/v2/search/movie?q=${encodeURIComponent(keyword)}`,
      DB_HEADERS
    );
    const raw = Array.isArray(data && data.items) ? data.items : [];
    if (raw.length === 0) return empty;

    const list = [];
    for (const item of raw) {
      const t = (item && item.target) || {};
      const id = String(t.id || item.target_id || "");
      if (!/^\d+$/.test(id)) continue;
      list.push({
        vod_id: id,
        vod_name: t.title || "",
        vod_pic: proxifyPic(t.cover_url || "", baseURL),
        vod_year: t.year ? String(t.year) : "",
        vod_remarks: (t.card_subtitle || "").split("/").slice(0, 2).join("/").trim() || "豆瓣",
        type_id: "movie",
        type_name: "豆瓣推荐",
        search: true,
      });
    }

    await OmniBox.log(
      "info",
      `[豆瓣推荐] 搜索 keyword=${keyword} 命中=${list.length}`
    );

    return {
      page: parseInt(page, 10) || 1,
      pagecount: list.length > 0 ? parseInt(page, 10) || 1 : 0,
      total: list.length,
      list: list,
    };
  } catch (error) {
    await OmniBox.log("error", `[豆瓣推荐] 搜索失败: ${error.message}`);
    return empty;
  }
}

// 使用公共 runner 处理标准输入/输出
runner.run(module.exports);

