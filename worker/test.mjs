// Worker 接口测试：mock Cloudflare 运行时（caches / fetch），跑一遍核心路径
import worker from './src/index.js';

const IMAGES = [
  { type: 'file', name: 'cat.jpg', path: 'images/cat.jpg', size: 102400, sha: 'sha-cat' },
  { type: 'file', name: 'nature-01.jpg', path: 'images/nature-01.jpg', size: 204800, sha: 'sha-n1' },
  { type: 'file', name: 'nature-02.png', path: 'images/nature-02.png', size: 512000, sha: 'sha-n2' },
  { type: 'dir', name: 'sub', path: 'images/sub', size: 0, sha: 'sha-sub' },
  { type: 'file', name: 'readme.txt', path: 'images/readme.txt', size: 10, sha: 'sha-txt' },
];

const calls = [];

globalThis.caches = {
  default: {
    _store: new Map(),
    async match(key) {
      const k = typeof key === 'string' ? key : key.url;
      return this._store.get(k);
    },
    async put(key, res) {
      const k = typeof key === 'string' ? key : key.url;
      this._store.set(k, res);
    },
    async delete(key) {
      const k = typeof key === 'string' ? key : key.url;
      this._store.delete(k);
    },
  },
};

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, method: init.method || 'GET' });

  // GitHub 目录列表
  if (u.includes('/contents/images?ref=')) {
    return new Response(JSON.stringify(IMAGES), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // GitHub 单个文件 GET（查 sha）
  if (/\/contents\/images\/[^?]+\?ref=/.test(u)) {
    const name = decodeURIComponent(u.split('/contents/images/')[1].split('?')[0]);
    const found = IMAGES.find((i) => i.name === name && i.type === 'file');
    if (!found) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify(found), { status: 200 });
  }

  // GitHub PUT 上传
  if (u.includes('/contents/images/') && init.method === 'PUT') {
    const body = JSON.parse(init.body);
    if (!body.content || !body.message) return new Response('{"message":"bad"}', { status: 422 });
    return new Response(
      JSON.stringify({ content: { sha: 'new-sha', path: 'images/x' }, commit: { sha: 'c1' } }),
      { status: 201 }
    );
  }

  // GitHub DELETE
  if (u.includes('/contents/images/') && init.method === 'DELETE') {
    return new Response(JSON.stringify({ commit: { sha: 'c2' } }), { status: 200 });
  }

  // raw.githubusercontent.com
  if (u.includes('raw.githubusercontent.com')) {
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': '4' },
    });
  }

  return new Response('unmocked: ' + u, { status: 500 });
};

const env = {
  GITHUB_TOKEN: 'ghp_fake',
  GITHUB_OWNER: 'tester',
  GITHUB_REPO: 'random-image-bed',
  GITHUB_BRANCH: 'main',
  IMAGE_DIR: 'images',
  ALLOWED_ORIGIN: '*',
  CDN_BASE: '',
  ADMIN_PASSWORD: 'lilytt00@',
  TOKEN_SECRET: 'test-secret-abc',
};

const ctx = { waitUntil: () => {} };
const BASE = 'https://api.example.com';

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? '  →  ' + JSON.stringify(extra) : ''));
  }
}

async function call(path, init) {
  const req = new Request(BASE + path, init);
  return worker.fetch(req, env, ctx);
}

console.log('\n=== 1. 服务信息 ===');
{
  const res = await call('/');
  const data = await res.json();
  check('GET / 返回 200', res.status === 200, res.status);
  check('含 endpoints', Boolean(data.endpoints && data.endpoints.random));
}

console.log('\n=== 2. 登录 ===');
let token = '';
{
  const res = await call('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  check('错误密码 401', res.status === 401, res.status);

  const res2 = await call('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'lilytt00@' }),
  });
  const d = await res2.json();
  check('正确密码 200', res2.status === 200, res2.status);
  check('返回 token', typeof d.token === 'string' && d.token.includes('.'));
  check('token 有效期 7 天', d.exp - Date.now() > 6 * 864e5);
  token = d.token;
}

console.log('\n=== 3. token 校验 ===');
{
  const res = await call('/api/auth/check', { headers: { Authorization: 'Bearer ' + token } });
  check('有效 token 200', res.status === 200, res.status);

  const bad = await call('/api/auth/check', { headers: { Authorization: 'Bearer abc.def' } });
  check('伪造 token 401', bad.status === 401, bad.status);

  const forged = token.split('.')[0] + '.deadbeef';
  const res2 = await call('/api/auth/check', { headers: { Authorization: 'Bearer ' + forged } });
  check('篡改签名 401', res2.status === 401, res2.status);
}

console.log('\n=== 4. 列表 ===');
{
  const res = await call('/api/list');
  const d = await res.json();
  check('GET /api/list 200', res.status === 200, res.status);
  check('过滤掉非图片和目录', d.total === 3, d.total);
  check('每项有 url', d.images.every((i) => typeof i.url === 'string' && i.url.startsWith('https://')));
  check('小文件走 jsDelivr', d.images[0].url.includes('cdn.jsdelivr.net'), d.images[0].url);
}

console.log('\n=== 5. 随机 ===');
{
  const res = await call('/api/random');
  check('302 跳转', res.status === 302, res.status);
  check('有 Location', Boolean(res.headers.get('Location')));
  check('禁止缓存', (res.headers.get('Cache-Control') || '').includes('no-store'));

  const res2 = await call('/api/random?json=1');
  const d = await res2.json();
  check('json=1 返回 200', res2.status === 200, res2.status);
  check('含 name/url/total', Boolean(d.name && d.url && d.total === 3));

  const res3 = await call('/api/random?json=1&count=3');
  const d3 = await res3.json();
  check('count=3 返回 3 张', Array.isArray(d3.images) && d3.images.length === 3);

  const res4 = await call('/api/random?json=1&prefix=nature');
  const d4 = await res4.json();
  check('prefix 过滤生效', d4.matched === 2 && d4.name.startsWith('nature'), d4.name);

  const res5 = await call('/api/random?json=1&tag=zzz');
  check('无匹配返回 404', res5.status === 404, res5.status);

  const res6 = await call('/api/random?src=proxy');
  check('src=proxy 走 /img/', (res6.headers.get('Location') || '').includes('/img/'), res6.headers.get('Location'));

  // 随机性：跑 40 次应该出现多于一种结果
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const r = await call('/api/random?json=1');
    const j = await r.json();
    seen.add(j.name);
  }
  check('确实随机（>1 种结果）', seen.size > 1, [...seen]);
}

console.log('\n=== 6. 上传鉴权 ===');
{
  const res = await call('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'x.jpg', content: 'AAAA' }),
  });
  check('无 token 401', res.status === 401, res.status);

  const res2 = await call('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ filename: 'x.jpg' }),
  });
  check('缺 content 400', res2.status === 400, res2.status);
}

console.log('\n=== 7. 上传 ===');
{
  const res = await call('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ filename: '我的 照片 (1).JPG', content: 'aGVsbG8gd29ybGQ=' }),
  });
  const d = await res.json();
  check('上传 200', res.status === 200, res.status);
  check('文件名被清洗', d.name === '我的-照片-1.jpg', d.name);
  check('路径正确', d.path === 'images/我的-照片-1.jpg', d.path);
  check('返回 url', typeof d.url === 'string');
  check('size 由 base64 推算', d.size === 11, d.size);

  const putCall = calls.filter((c) => c.method === 'PUT').pop();
  check('确实调用了 GitHub PUT', Boolean(putCall) && putCall.url.includes('api.github.com'));
}

console.log('\n=== 8. 删除 ===');
{
  const res = await call('/api/delete?name=cat.jpg', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + token },
  });
  check('删除 200', res.status === 200, res.status);

  const res2 = await call('/api/delete?name=nope.jpg', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + token },
  });
  check('不存在 404', res2.status === 404, res2.status);

  const res3 = await call('/api/delete?name=cat.jpg', { method: 'DELETE' });
  check('无 token 401', res3.status === 401, res3.status);
}

console.log('\n=== 9. 图片代理 ===');
{
  const res = await call('/img/cat.jpg');
  check('代理 200', res.status === 200, res.status);
  check('Content-Type 透传', res.headers.get('Content-Type') === 'image/jpeg');
  check('长缓存', (res.headers.get('Cache-Control') || '').includes('immutable'));

  const res2 = await call('/img/..%2Fetc%2Fpasswd');
  check('路径穿越被拦', res2.status === 400, res2.status);
}

console.log('\n=== 10. 统计 & CORS ===');
{
  const res = await call('/api/stats');
  const d = await res.json();
  check('stats 200', res.status === 200, res.status);
  check('totalSize 正确', d.totalSize === 102400 + 204800 + 512000, d.totalSize);

  const opt = await call('/api/random', { method: 'OPTIONS', headers: { Origin: 'https://x.com' } });
  check('OPTIONS 204', opt.status === 204, opt.status);
  check('CORS 头存在', opt.headers.get('Access-Control-Allow-Origin') === '*');

  const nf = await call('/api/nope');
  check('未知路径 404', nf.status === 404, nf.status);
}

console.log(`\n${'='.repeat(40)}`);
console.log(`通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`失败 ${fail}`);
  process.exit(1);
}
