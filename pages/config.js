/**
 * 部署前唯一需要改的文件。
 *
 * apiBase: 你的 Worker 地址，例如
 *   https://random-image-bed-api.your-name.workers.dev
 *   或绑定后的自定义域名 https://img-api.example.com
 *
 * 如果 Worker 和 Pages 挂在同一个域名下（Worker 路由 /api/* 和 /img/*），
 * 把 apiBase 留空字符串即可，前端会用相对路径。
 */
window.IMAGE_BED = {
  apiBase: 'https://random-image-bed-api.YOUR-SUBDOMAIN.workers.dev',
  siteName: '随机图床',
  siteDesc: '每次请求 /api/random 都会从图库里随机返回一张图片。图片存在 GitHub 仓库，API 跑在 Cloudflare Workers，前端在 Pages。',
};
