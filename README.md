# 随机图床 · Random Image Bed

Cloudflare Workers + Pages + GitHub 仓库组成的随机图片床。

- **Worker**：API 层（随机、列表、上传、删除、图片代理）
- **Pages**：静态前端（首页使用说明 + 图库预览，`/admin.html` 管理后台）
- **GitHub 仓库**：图片存储层，每张图就是仓库里的一个文件

```
浏览器 / 第三方调用
      │
      ├─► Pages（静态页面）──► Worker API ──► GitHub Contents API
      │                                            │
      └─► /api/random ──302──► jsDelivr / raw ◄────┘
```

---

## 1. 建仓库

新建一个 **public** 仓库，比如 `random-image-bed`，把本项目所有文件推上去：

```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/<你的用户名>/random-image-bed.git
git push -u origin main
```

> 必须 public。private 仓库 jsDelivr 和 raw 都拿不到图，只能走 Worker 代理（`?src=proxy`），会消耗 Worker 请求额度。

`images/` 目录就是图片存放位置，代码仓库和图片仓库合并成一个，省事。

## 2. 建 GitHub Token

头像 → Settings → Developer settings → **Personal access tokens** → Fine-grained tokens → Generate new token

- Repository access：只选 `random-image-bed`
- Permissions → Repository permissions → **Contents: Read and write**

复制生成的 token（`github_pat_...`）。用 classic token 也行，勾 `repo` scope。

## 3. 部署 Worker

```bash
cd worker
npm install

# 改 wrangler.toml 里的 GITHUB_OWNER / GITHUB_REPO
npx wrangler login
```

填三个 secret：

```bash
npx wrangler secret put GITHUB_TOKEN       # 第 2 步的 token
npx wrangler secret put ADMIN_PASSWORD     # lilytt00@
npx wrangler secret put TOKEN_SECRET       # 随便一串 32 位以上随机字符串
```

部署：

```bash
npx wrangler deploy
```

会输出一个地址，比如 `https://random-image-bed-api.your-name.workers.dev`。先验证一下：

```bash
curl "https://random-image-bed-api.your-name.workers.dev/api/stats"
```

返回 JSON 就说明 Worker 通了。

## 4. 部署 Pages

改 `pages/config.js`：

```js
window.IMAGE_BED = {
  apiBase: 'https://random-image-bed-api.your-name.workers.dev',
  siteName: '随机图床',
  siteDesc: '跑在 Cloudflare 上的随机图片 API，图片存在 GitHub 仓库里。',
};
```

**方式 A：命令行直传（推荐）**

上传图片会往仓库提交 commit，如果用 Git 集成，每次传图都会触发 Pages 重新部署。直传就不会。

```bash
npx wrangler pages deploy pages --project-name=random-image-bed
```

**方式 B：Git 集成**

Cloudflare Dashboard → Workers & Pages → Create → Pages → 连 GitHub 仓库：

| 配置项 | 值 |
|---|---|
| Framework preset | None |
| Build command | 留空 |
| Build output directory | `pages` |

能跑，但传图会触发部署（纯静态，几秒完成，可接受）。

## 5. 挂域名

**Worker**：Dashboard → Workers & Pages → `random-image-bed-api` → Settings → Domains & Routes → Add custom domain，填 `img-api.你的域名.com`。

**Pages**：同位置 → Custom domains → 填 `img.你的域名.com`。

改完记得回来把 `pages/config.js` 的 `apiBase` 换成新域名，重新部署 Pages。

---

## 使用

### 后台

访问 `https://你的域名/admin.html`，输密码 `lilytt00@`。

上传时有两个选项：

- **压缩上传**：浏览器里转成 WebP，质量 50–100% 可调，最大边长可选。体积通常降到原图 1/5 ~ 1/10。GIF（保动画）和 SVG（矢量）自动跳过压缩。
- **无损上传**：原图直接提交，一个字节都不动。

### 分类

用文件名前缀。上传 `nature-001.jpg`、`nature-002.jpg`，就能这样随机取：

```
/api/random?prefix=nature
```

子目录不支持（GitHub Contents API 一次只列一层），靠文件名足够。

---

## API

Base：`https://img-api.你的域名.com`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/random` | 随机图，302 跳转 |
| GET | `/api/list` | 全部图片 |
| GET | `/api/stats` | 数量 / 体积统计 |
| GET | `/img/:name` | 图片代理（边缘缓存 1 年） |
| POST | `/api/auth` | 登录换 token |
| GET | `/api/auth/check` | 校验 token |
| POST | `/api/upload` | 上传（需 token） |
| DELETE | `/api/delete?name=` | 删除（需 token） |

### `/api/random` 参数

| 参数 | 说明 |
|---|---|
| `json=1` | 返回 JSON 不跳转 |
| `count=N` | 一次返回 N 张，1–20 |
| `prefix=xxx` | 文件名前缀筛选 |
| `tag=xxx` | 文件名包含筛选 |
| `src=auto\|jsdelivr\|raw\|proxy` | 图源选择 |

`src` 说明：

- `auto`（默认）：≤40MB 走 jsDelivr，>40MB 走 raw
- `jsdelivr`：`cdn.jsdelivr.net`，有 CDN 缓存，但单文件上限 50MB
- `raw`：`raw.githubusercontent.com`，国内常被墙
- `proxy`：走 Worker `/img/`，只要 Worker 域名能访问就行，最稳

### 示例

```bash
# 直接拿图
curl -L "https://img-api.example.com/api/random"

# JSON
curl "https://img-api.example.com/api/random?json=1"
# → { "name": "cat.jpg", "path": "images/cat.jpg", "size": 84321, "url": "...", "total": 42 }

# 三张，指定分类
curl "https://img-api.example.com/api/random?json=1&count=3&prefix=nature"
```

```html
<img src="https://img-api.example.com/api/random" alt="随机图">
<img src="https://img-api.example.com/api/random?prefix=nature" alt="随机风景">
```

```markdown
![随机图](https://img-api.example.com/api/random)
```

`<img>` 会跟随 302，每次都拿到不同的图。响应带 `Cache-Control: no-store`，不会被浏览器缓存成固定图。

### 上传（脚本调用）

```bash
TOKEN=$(curl -s -X POST "https://img-api.example.com/api/auth" \
  -H "Content-Type: application/json" \
  -d '{"password":"lilytt00@"}' | jq -r .token)

curl -X POST "https://img-api.example.com/api/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"filename\":\"photo.jpg\",\"content\":\"$(base64 -w0 photo.jpg)\"}"
```

---

## 限制（别指望突破）

| 项 | 上限 | 原因 |
|---|---|---|
| 压缩上传 | 基本无限制 | 压缩在浏览器里做，发出去已经是几 MB |
| 无损上传 | **单张约 45MB** | Worker 请求体 100MB + 内存 128MB，base64 膨胀 33% |
| 单文件硬顶 | 95MB | GitHub Contents API 100MB 上限 |
| 单目录文件数 | 1000 | GitHub Contents API 一次最多返回 1000 项 |

超过 45MB 的原图，后台会弹警告但允许你试。真要传超大的，直接去 GitHub 网页上传，然后后台点「刷新列表」。

## 安全

- 密码只存在 Worker 的 secret 里，前端拿不到
- 登录返回 HMAC-SHA256 签名的 token，有效期 7 天，存在 localStorage
- 所有写操作（上传/删除）都验 token
- `/admin.html` 带 `X-Robots-Tag: noindex`，不会进搜索引擎
- 建议把 `ALLOWED_ORIGIN` 从 `*` 改成你的 Pages 域名，避免别人跨域调用上传接口

## 自测

改完 Worker 代码跑一遍，43 项断言覆盖登录、鉴权、随机、筛选、上传、删除、代理、CORS：

```bash
cd worker && npm test
```

mock 了 `caches` 和 GitHub API，不需要真实网络。

## 目录

```
.
├── worker/
│   ├── src/index.js       API 全部逻辑
│   ├── test.mjs           接口测试（npm test）
│   ├── wrangler.toml      部署配置（改 GITHUB_OWNER/REPO）
│   └── package.json
├── pages/
│   ├── index.html         首页：使用说明 + 图库
│   ├── admin.html         后台：上传 + 管理
│   ├── config.js          ★ 唯一需要改的前端文件
│   ├── _headers           Pages 响应头
│   ├── 404.html
│   └── assets/
│       ├── style.css
│       ├── app.js
│       └── admin.js
└── images/                图片存放目录
```
