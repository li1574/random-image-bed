/**
 * Random Image Bed — Cloudflare Worker API
 *
 * 存储层：GitHub 仓库（图片以普通文件形式提交）
 * 读：GitHub Contents API（带 Cache API 缓存，60s）
 * 写：GitHub Contents API PUT / DELETE
 * 随机：从文件列表里抽样，302 跳转到 jsDelivr / raw.githubusercontent.com
 * 图片代理：/img/:name 走 Worker 边缘缓存，适合国内访问
 *
 * 环境变量（wrangler.toml [vars]）
 *   GITHUB_OWNER      GitHub 用户名 / 组织
 *   GITHUB_REPO       仓库名
 *   GITHUB_BRANCH     分支，默认 main
 *   IMAGE_DIR         图片目录，默认 images
 *   ALLOWED_ORIGIN    CORS 白名单，默认 *
 *   CDN_BASE          可选，自建 CDN 前缀（如 https://img.example.com）
 *
 * Secrets（wrangler secret put）
 *   GITHUB_TOKEN      GitHub PAT，需 Contents: Read and write
 *   ADMIN_PASSWORD    后台密码
 *   TOKEN_SECRET      token 签名密钥（随便一串长随机串）
 */

const TEXT_ENCODER = new TextEncoder();
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg|ico)$/i;
const LIST_CACHE_TTL = 60; // 秒
const RAW_HOST = 'https://raw.githubusercontent.com';
const JSDELIVR_HOST = 'https://cdn.jsdelivr.net';
const BIG_FILE_BYTES = 40 * 1024 * 1024; // jsDelivr 对 >50MB 文件会 403，提前切 raw

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const cors = corsHeaders(env, request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (pathname === '/' || pathname === '/api') {
        return json(
          {
            ok: true,
            service: 'random-image-bed',
            endpoints: {
              random: 'GET /api/random',
              list: 'GET /api/list',
              stats: 'GET /api/stats',
              auth: 'POST /api/auth',
              authCheck: 'GET /api/auth/check',
              upload: 'POST /api/upload',
              delete: 'DELETE /api/delete?name=xxx',
              imageProxy: 'GET /img/:name',
            },
          },
          200,
          cors
        );
      }

      if (pathname === '/api/random') return await handleRandom(request, env);
      if (pathname === '/api/list') return await handleList(request, env);
      if (pathname === '/api/stats') return await handleStats(request, env);
      if (pathname === '/api/auth') {
        if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405, cors);
        return await handleAuth(request, env);
      }
      if (pathname === '/api/auth/check') return await handleAuthCheck(request, env);
      if (pathname === '/api/upload') {
        if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405, cors);
        return await handleUpload(request, env);
      }
      if (pathname === '/api/delete') {
        if (request.method !== 'DELETE' && request.method !== 'POST') {
          return json({ error: 'Method Not Allowed' }, 405, cors);
        }
        return await handleDelete(request, env);
      }
      if (pathname.startsWith('/img/')) return await handleImageProxy(request, env, ctx);

      return json({ error: 'Not Found', path: pathname }, 404, cors);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500, cors);
    }
  },
};

/* ============================ 基础工具 ============================ */

function corsHeaders(env, request) {
  const allow = String(env.ALLOWED_ORIGIN || '*').trim();
  const origin = request.headers.get('Origin') || '';
  let allowOrigin = '*';
  if (allow !== '*') {
    const list = allow.split(',').map((s) => s.trim()).filter(Boolean);
    allowOrigin = list.includes(origin) ? origin : list[0] || '*';
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

function b64urlFromBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlFromString(str) {
  return b64urlFromBytes(TEXT_ENCODER.encode(str));
}

function stringFromB64url(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacSign(env, data) {
  const secret = env.TOKEN_SECRET || env.ADMIN_PASSWORD || 'change-me-please';
  const key = await crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, TEXT_ENCODER.encode(data));
  return b64urlFromBytes(new Uint8Array(sig));
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 清洗文件名：保留中英文/数字/下划线/连字符/点，其余替换为 - */
function sanitizeFilename(raw) {
  const name = String(raw || '').trim().replace(/^.*[\\/]/, '');
  const dot = name.lastIndexOf('.');
  let base = dot > 0 ? name.slice(0, dot) : name;
  let ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';

  base = base.replace(/[^\p{L}\p{N}_\-.]+/gu, '-');
  base = base.replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');

  if (!base) base = 'image';
  if (!ext || !/^[a-z0-9]{1,8}$/.test(ext)) ext = 'jpg';

  return `${base.slice(0, 120)}.${ext}`;
}

/** Fisher-Yates 抽样 */
function sample(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(1, n));
}

/* ============================ GitHub 访问 ============================ */

function imageDir(env) {
  return String(env.IMAGE_DIR || 'images').replace(/^\/+|\/+$/g, '');
}

function repoPath(env) {
  return `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

async function ghFetch(env, path, init = {}) {
  if (!env.GITHUB_TOKEN) throw new Error('未配置 GITHUB_TOKEN，请执行 wrangler secret put GITHUB_TOKEN');
  if (!env.GITHUB_OWNER || !env.GITHUB_REPO) throw new Error('未配置 GITHUB_OWNER / GITHUB_REPO');

  const reqInit = {
    method: init.method || 'GET',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'random-image-bed-worker',
      ...(init.headers || {}),
    },
  };
  if (init.body !== undefined) reqInit.body = init.body;

  return fetch(`https://api.github.com${path}`, reqInit);
}

function listCacheKey(env) {
  const dir = imageDir(env);
  const branch = env.GITHUB_BRANCH || 'main';
  return `https://imgbed-cache.internal/list/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${branch}/${dir}`;
}

async function purgeListCache(env) {
  try {
    await caches.default.delete(listCacheKey(env));
  } catch (_) {
    /* 缓存删除失败不影响主流程 */
  }
}

async function getImageList(env, { fresh = false } = {}) {
  const cache = caches.default;
  const key = listCacheKey(env);

  if (!fresh) {
    const hit = await cache.match(key);
    if (hit) {
      try {
        return await hit.json();
      } catch (_) {
        /* 缓存损坏，继续回源 */
      }
    }
  }

  const dir = imageDir(env);
  const branch = env.GITHUB_BRANCH || 'main';
  const apiPath = dir
    ? `/repos/${repoPath(env)}/contents/${encodePath(dir)}?ref=${encodeURIComponent(branch)}`
    : `/repos/${repoPath(env)}/contents?ref=${encodeURIComponent(branch)}`;

  const res = await ghFetch(env, apiPath);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`读取 GitHub 目录失败 (${res.status})：${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const files = (Array.isArray(data) ? data : [])
    .filter((it) => it.type === 'file' && IMAGE_EXT_RE.test(it.name))
    .map((it) => ({ name: it.name, path: it.path, size: it.size, sha: it.sha }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  const payload = { files, dir, branch, updatedAt: new Date().toISOString() };

  const cacheRes = new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `max-age=${LIST_CACHE_TTL}`,
    },
  });
  try {
    await cache.put(key, cacheRes);
  } catch (_) {
    /* ignore */
  }

  return payload;
}

/* ============================ URL 生成 ============================ */

function buildImageUrl(env, file, opts = {}) {
  const branch = env.GITHUB_BRANCH || 'main';
  const path = file.path || `${imageDir(env)}/${file.name}`;
  const encodedPath = encodePath(path);
  const src = String(opts.src || 'auto').toLowerCase();

  if (env.CDN_BASE && (src === 'auto' || src === 'cdn')) {
    return `${String(env.CDN_BASE).replace(/\/+$/, '')}/${encodedPath}`;
  }
  if (src === 'proxy' && opts.origin) {
    return `${opts.origin}/img/${encodeURIComponent(file.name)}`;
  }
  if (src === 'raw') {
    return `${RAW_HOST}/${repoPath(env)}/${branch}/${encodedPath}`;
  }
  if (src === 'jsdelivr') {
    return `${JSDELIVR_HOST}/gh/${repoPath(env)}@${branch}/${encodedPath}`;
  }

  // auto：大文件走 raw（jsDelivr 有 50MB 单文件上限）
  return (file.size || 0) > BIG_FILE_BYTES
    ? `${RAW_HOST}/${repoPath(env)}/${branch}/${encodedPath}`
    : `${JSDELIVR_HOST}/gh/${repoPath(env)}@${branch}/${encodedPath}`;
}

/* ============================ 认证 ============================ */

async function issueToken(env) {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 天
  const payload = b64urlFromString(JSON.stringify({ exp }));
  const sig = await hmacSign(env, payload);
  return { token: `${payload}.${sig}`, exp };
}

async function requireAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, error: '缺少 Authorization 令牌' };

  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, error: '令牌格式错误' };

  const [payload, sig] = parts;
  const expected = await hmacSign(env, payload);
  if (!safeEqual(sig, expected)) return { ok: false, error: '令牌无效' };

  let data;
  try {
    data = JSON.parse(stringFromB64url(payload));
  } catch (_) {
    return { ok: false, error: '令牌内容损坏' };
  }
  if (!data.exp || data.exp < Date.now()) return { ok: false, error: '令牌已过期，请重新登录' };

  return { ok: true, exp: data.exp };
}

async function handleAuth(request, env) {
  const cors = corsHeaders(env, request);

  if (!env.ADMIN_PASSWORD) {
    return json({ error: '服务端未设置 ADMIN_PASSWORD' }, 500, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: '请求体必须是 JSON' }, 400, cors);
  }

  const password = String((body && body.password) || '');
  if (!password || !safeEqual(password, String(env.ADMIN_PASSWORD))) {
    // 简单延迟，抬高暴力破解成本
    await new Promise((r) => setTimeout(r, 600));
    return json({ error: '密码错误' }, 401, cors);
  }

  const { token, exp } = await issueToken(env);
  return json({ ok: true, token, exp }, 200, cors);
}

async function handleAuthCheck(request, env) {
  const cors = corsHeaders(env, request);
  const auth = await requireAuth(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401, cors);
  return json({ ok: true, exp: auth.exp }, 200, cors);
}

/* ============================ 接口实现 ============================ */

async function handleRandom(request, env) {
  const url = new URL(request.url);
  const cors = corsHeaders(env, request);
  const { files } = await getImageList(env);

  if (!files.length) {
    return json({ error: '图库为空，请先在后台上传图片', code: 'EMPTY_LIBRARY' }, 404, cors);
  }

  const prefix = (url.searchParams.get('prefix') || '').toLowerCase();
  const tag = (url.searchParams.get('tag') || '').toLowerCase();
  const src = (url.searchParams.get('src') || 'auto').toLowerCase();
  const count = Math.min(Math.max(parseInt(url.searchParams.get('count') || '1', 10) || 1, 1), 20);
  const asJson = ['1', 'true', 'json'].includes((url.searchParams.get('json') || '').toLowerCase());

  let pool = files;
  if (prefix) pool = pool.filter((f) => f.name.toLowerCase().startsWith(prefix));
  if (tag) pool = pool.filter((f) => f.name.toLowerCase().includes(tag));

  if (!pool.length) {
    return json({ error: '没有匹配条件的图片', prefix, tag }, 404, cors);
  }

  const picked = sample(pool, Math.min(count, pool.length));
  const origin = url.origin;

  if (asJson) {
    const items = picked.map((f) => ({
      name: f.name,
      path: f.path,
      size: f.size,
      url: buildImageUrl(env, f, { src, origin }),
    }));
    const body =
      count === 1 && items.length === 1
        ? { ...items[0], matched: pool.length, total: files.length }
        : { images: items, matched: pool.length, total: files.length };
    return json(body, 200, cors);
  }

  const target = buildImageUrl(env, picked[0], { src, origin });
  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'CDN-Cache-Control': 'no-store',
      ...cors,
    },
  });
}

async function handleList(request, env) {
  const url = new URL(request.url);
  const cors = corsHeaders(env, request);
  const fresh = url.searchParams.get('fresh') === '1';
  const src = (url.searchParams.get('src') || 'auto').toLowerCase();
  const withUrl = url.searchParams.get('url') !== '0';

  const { files, updatedAt, dir, branch } = await getImageList(env, { fresh });
  const origin = url.origin;

  const images = files.map((f) => {
    const item = { name: f.name, path: f.path, size: f.size, sha: f.sha };
    if (withUrl) item.url = buildImageUrl(env, f, { src, origin });
    return item;
  });

  return json({ total: images.length, dir, branch, updatedAt, images }, 200, cors);
}

async function handleStats(request, env) {
  const cors = corsHeaders(env, request);
  const { files, updatedAt, dir, branch } = await getImageList(env);

  const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
  const largest = files.reduce((max, f) => Math.max(max, f.size || 0), 0);

  return json(
    {
      total: files.length,
      totalSize,
      largest,
      dir,
      branch,
      repo: repoPath(env),
      updatedAt,
    },
    200,
    cors
  );
}

async function handleUpload(request, env) {
  const cors = corsHeaders(env, request);
  const auth = await requireAuth(request, env);
  if (!auth.ok) return json({ error: auth.error }, 401, cors);

  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) {
    return json({ error: '请用 application/json 提交 { filename, content }' }, 415, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ error: `JSON 解析失败：${err.message}` }, 400, cors);
  }

  const filename = body && body.filename;
  const rawContent = body && body.content;
  if (!filename || !rawContent) {
    return json({ error: '缺少 filename 或 content' }, 400, cors);
  }

  const base64 = String(rawContent)
    .replace(/^data:[^;]+;base64,/, '')
    .replace(/\s+/g, '');

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return json({ error: 'content 不是合法的 base64' }, 400, cors);
  }

  // base64 长度换算字节数，扣掉 padding
  const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const approxBytes = Math.floor((base64.length * 3) / 4) - pad;
  // GitHub Contents API 单文件硬上限 100MB；Worker 内存 128MB，留足余量
  if (approxBytes > 95 * 1024 * 1024) {
    return json(
      { error: `文件约 ${(approxBytes / 1048576).toFixed(1)} MB，超过 GitHub Contents API 100MB 上限` },
      413,
      cors
    );
  }

  const safeName = sanitizeFilename(filename);
  const dir = imageDir(env);
  const path = dir ? `${dir}/${safeName}` : safeName;
  const encodedPath = encodePath(path);
  const branch = env.GITHUB_BRANCH || 'main';

  // 同名文件 → 取 sha 覆盖
  let sha;
  const existRes = await ghFetch(env, `/repos/${repoPath(env)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`);
  if (existRes.ok) {
    try {
      sha = (await existRes.json()).sha;
    } catch (_) {
      /* ignore */
    }
  } else if (existRes.status !== 404) {
    const text = await existRes.text();
    return json({ error: `检查同名文件失败 (${existRes.status})：${text.slice(0, 200)}` }, 502, cors);
  }

  const putBody = {
    message: `upload: ${safeName}${sha ? ' (overwrite)' : ''}`,
    content: base64,
    branch,
  };
  if (sha) putBody.sha = sha;

  const putRes = await ghFetch(env, `/repos/${repoPath(env)}/contents/${encodedPath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(putBody),
  });

  if (!putRes.ok) {
    const text = await putRes.text();
    return json({ error: `GitHub 上传失败 (${putRes.status})：${text.slice(0, 300)}` }, 502, cors);
  }

  const result = await putRes.json();
  const fileInfo = {
    name: safeName,
    path,
    size: approxBytes,
    sha: (result.content && result.content.sha) || null,
  };

  await purgeListCache(env);

  return json(
    {
      ok: true,
      overwritten: Boolean(sha),
      ...fileInfo,
      url: buildImageUrl(env, fileInfo, { src: 'auto', origin: new URL(request.url).origin }),
    },
    200,
    cors
  );
}

async function handleDelete(request, env) {
  const cors = corsHeaders(env, request);
  const auth = await requireAuth(request, env);
  if (!auth.ok) return json({ error: auth.error }, 401, cors);

  const url = new URL(request.url);
  let name = url.searchParams.get('name') || '';
  if (!name) {
    try {
      const body = await request.json();
      name = (body && body.name) || '';
    } catch (_) {
      /* ignore */
    }
  }
  if (!name) return json({ error: '缺少 name 参数' }, 400, cors);

  const safeName = sanitizeFilename(name);
  const dir = imageDir(env);
  const path = dir ? `${dir}/${safeName}` : safeName;
  const encodedPath = encodePath(path);
  const branch = env.GITHUB_BRANCH || 'main';

  const infoRes = await ghFetch(env, `/repos/${repoPath(env)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`);
  if (!infoRes.ok) {
    return json({ error: `文件不存在 (${infoRes.status})` }, 404, cors);
  }
  const info = await infoRes.json();

  const delRes = await ghFetch(env, `/repos/${repoPath(env)}/contents/${encodedPath}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `delete: ${safeName}`, sha: info.sha, branch }),
  });

  if (!delRes.ok) {
    const text = await delRes.text();
    return json({ error: `删除失败 (${delRes.status})：${text.slice(0, 300)}` }, 502, cors);
  }

  await purgeListCache(env);
  return json({ ok: true, deleted: safeName }, 200, cors);
}

async function handleImageProxy(request, env, ctx) {
  const url = new URL(request.url);
  const name = decodeURIComponent(url.pathname.slice('/img/'.length));

  if (!name || name.includes('/') || name.includes('..')) {
    return new Response('Bad Request', { status: 400 });
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const branch = env.GITHUB_BRANCH || 'main';
  const dir = imageDir(env);
  const rawPath = dir ? `${dir}/${name}` : name;
  const rawUrl = `${RAW_HOST}/${repoPath(env)}/${branch}/${encodePath(rawPath)}`;

  const upstream = await fetch(rawUrl, { headers: { 'User-Agent': 'random-image-bed-worker' } });
  if (!upstream.ok) {
    return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Access-Control-Allow-Origin', '*');
  const len = upstream.headers.get('Content-Length');
  if (len) headers.set('Content-Length', len);

  const response = new Response(upstream.body, { status: 200, headers });

  ctx.waitUntil(
    cache.put(cacheKey, response.clone()).catch(() => {
      /* ignore */
    })
  );

  return response;
}
