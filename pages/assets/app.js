/* 首页逻辑：随机图展示 + API 示例填充 + 图库预览 */
(function () {
  const cfg = window.IMAGE_BED || {};
  const API = String(cfg.apiBase || '').replace(/\/+$/, '');

  const $ = (id) => document.getElementById(id);

  /* ---------- 通用 ---------- */
  function toast(msg, kind) {
    const host = $('toastHost');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 260);
    }, 2200);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast('已复制', 'ok');
    } catch (_) {
      toast('复制失败，手动选中吧', 'err');
    }
  }

  function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  }

  function absUrl(u) {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    return API + (u.startsWith('/') ? '' : '/') + u;
  }

  /* ---------- 站点文案 ---------- */
  if (cfg.siteName) {
    $('brandName').textContent = cfg.siteName;
    document.title = cfg.siteName + ' · Random Image Bed';
  }
  if (cfg.siteDesc) $('heroDesc').textContent = cfg.siteDesc;

  /* ---------- API 示例填充 ---------- */
  const randomApi = (API || '') + '/api/random';
  const listApi = (API || '') + '/api/list';
  const imgApi = (API || '') + '/img/example.jpg';

  $('exRandom').textContent = randomApi;
  $('exList').textContent = listApi;
  $('exImg').textContent = imgApi;
  document.querySelectorAll('.ex-random').forEach((el) => {
    el.textContent = randomApi;
  });

  /* ---------- 随机图 ---------- */
  const stageImg = $('stageImg');
  const stageMeta = $('stageMeta');
  let currentFile = null;
  let currentUrl = '';

  function setStageLoading(on) {
    if (on) stageImg.classList.add('loading');
    else stageImg.classList.remove('loading');
  }

  async function shuffle() {
    setStageLoading(true);
    stageMeta.textContent = '正在挑一张…';
    const bust = 'ts=' + Date.now();

    try {
      // 先拿 JSON 元信息，再换 img src —— 这样能显示文件名和大小
      const res = await fetch(`${randomApi}?json=1&src=proxy&${bust}`, { cache: 'no-store' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'HTTP ' + res.status);
      }
      const data = await res.json();
      currentFile = data;
      currentUrl = absUrl(data.url);

      await new Promise((resolve) => {
        const probe = new Image();
        probe.onload = resolve;
        probe.onerror = resolve;
        probe.src = currentUrl;
      });

      stageImg.src = currentUrl;
      stageImg.alt = data.name || '随机图片';
      stageImg.onload = () => setStageLoading(false);
      stageMeta.textContent = `${data.name} · ${fmtSize(data.size)} · 共 ${data.total} 张`;
    } catch (err) {
      setStageLoading(false);
      stageMeta.textContent = '加载失败：' + err.message;
      stageImg.removeAttribute('src');
    }
  }

  $('btnShuffle').addEventListener('click', shuffle);

  $('btnCopyUrl').addEventListener('click', () => {
    if (!currentUrl) return toast('还没加载出来', 'err');
    copyText(currentUrl);
  });

  $('btnCopyApi').addEventListener('click', () => copyText(randomApi));

  /* ---------- 图库 ---------- */
  const gallery = $('galleryGrid');
  const galleryEmpty = $('galleryEmpty');
  const galleryHint = $('galleryHint');

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const img = entry.target;
        io.unobserve(img);
        if (img.dataset.src) {
          img.src = img.dataset.src;
          delete img.dataset.src;
        }
      });
    },
    { rootMargin: '400px 0px' }
  );

  async function loadGallery() {
    try {
      const res = await fetch(`${listApi}?src=proxy`, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const items = data.images || [];

      gallery.innerHTML = '';
      galleryHint.textContent = items.length ? `${items.length} 张 · 点击看大图` : '—';

      if (!items.length) {
        galleryEmpty.style.display = '';
        return;
      }
      galleryEmpty.style.display = 'none';

      const frag = document.createDocumentFragment();
      items.forEach((it) => {
        const a = document.createElement('div');
        a.className = 'gallery-item';

        const img = document.createElement('img');
        img.alt = it.name;
        img.loading = 'lazy';
        img.dataset.src = absUrl(it.url);
        img.addEventListener('load', () => img.classList.add('loaded'));

        const cap = document.createElement('div');
        cap.className = 'cap';
        cap.textContent = it.name;

        a.appendChild(img);
        a.appendChild(cap);
        a.addEventListener('click', () => openLightbox(it));
        frag.appendChild(a);
        io.observe(img);
      });
      gallery.appendChild(frag);
    } catch (err) {
      galleryHint.textContent = '加载失败：' + err.message;
    }
  }

  /* ---------- lightbox ---------- */
  const lightbox = $('lightbox');
  const lbImg = $('lbImg');
  const lbName = $('lbName');
  let lbUrl = '';

  function openLightbox(item) {
    lbUrl = absUrl(item.url);
    lbImg.src = lbUrl;
    lbImg.alt = item.name;
    lbName.textContent = `${item.name} · ${fmtSize(item.size)}`;
    lightbox.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightbox.classList.remove('open');
    document.body.style.overflow = '';
    lbImg.removeAttribute('src');
  }

  $('lbClose').addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightbox.classList.contains('open')) closeLightbox();
  });
  $('lbCopy').addEventListener('click', () => lbUrl && copyText(lbUrl));

  /* ---------- 启动 ---------- */
  if (/YOUR-SUBDOMAIN/.test(String(cfg.apiBase || ''))) {
    stageMeta.textContent = '还没配置 API 地址 —— 打开 pages/config.js 填上你的 Worker 域名';
  } else {
    shuffle();
    loadGallery();
  }
})();
