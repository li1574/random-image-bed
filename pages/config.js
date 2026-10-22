/**
 * 部署配置。
 *
 * 两种访问方式都支持：
 *   1. https://photo.li1574.ccwu.cc  —— 前端页面 + API 同域，apiBase 留空，用相对路径
 *   2. https://random-image-bed.pages.dev —— Pages 直连，API 走 img.li1574.ccwu.cc（跨域）
 *
 * 换域名时改 SAME_ORIGIN_HOSTS 即可。
 */
(function () {
  var SAME_ORIGIN_HOSTS = ['photo.li1574.ccwu.cc'];
  var API_ORIGIN = 'https://img.li1574.ccwu.cc';

  window.IMAGE_BED = {
    apiBase: SAME_ORIGIN_HOSTS.indexOf(location.hostname) >= 0 ? '' : API_ORIGIN,
    siteName: '随机图床',
    siteDesc:
      '每次请求 /api/random 都会从图库里随机返回一张图片。图片存在 GitHub 仓库，API 跑在 Cloudflare Workers，前端在 Pages。',
  };
})();
