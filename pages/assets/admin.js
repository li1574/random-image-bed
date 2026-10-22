/* 后台逻辑：登录 / 压缩与无损上传 / 图片管理 */
(function () {
  const cfg = window.IMAGE_BED || {};
  const API = String(cfg.apiBase || '').replace(/\/+$/, '');
  const TOKEN_KEY = 'imgbed_token';

  const LOSSLESS_WARN_BYTES = 45 * 1024 * 1024; // Worker 请求体 + 内存的安全线
  const LOSSLESS_HARD_BYTES = 95 * 1024 * 1024; // GitHub Contents API 上限

  const $ = (id) => document.getElementById(id);

  let token = localStorage.getItem(TOKEN_KEY) || '';
  let uploading = false;

  /* ================= 工具 ================= */

  function toast(msg, kind) {
    const host = $('toastHost');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 260);
    }, 2400);
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
      toast('复制失败', 'err');
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
    // apiBase 为空表示同域，用当前 origin 补成绝对地址
    return (API || location.origin) + (u.startsWith('/') ? '' : '/') + u;
  }

  async function apiFetch(path, init) {
    const opts = Object.assign({}, init);
    opts.headers = Object.assign({}, (init && init.headers) || {});
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch(API + path, opts);

    if (res.status === 401) {
      const data = await res.json().catch(() => ({}));
      logout();
      throw new Error(data.error || '登录已失效，请重新登录');
    }
    return res;
  }

  /* ================= 登录 ================= */

  const authGate = $('authGate');
  const app = $('app');
  const loginForm = $('loginForm');
  const loginBtn = $('loginBtn');
  const loginMsg = $('loginMsg');

  function showApp() {
    authGate.classList.add('hidden');
    app.style.display = '';
    if (cfg.siteName) $('brandName').textContent = cfg.siteName;
    refreshAll();
  }

  function logout() {
    token = '';
    localStorage.removeItem(TOKEN_KEY);
    app.style.display = 'none';
    authGate.classList.remove('hidden');
    $('pwd').value = '';
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginMsg.textContent = '';
    const pwd = $('pwd').value;
    if (!pwd) return;

    loginBtn.disabled = true;
    loginBtn.textContent = '验证中…';

    try {
      const res = await fetch(API + '/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) throw new Error(data.error || '登录失败');

      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      $('pwd').value = '';
      showApp();
      toast('已登录', 'ok');
    } catch (err) {
      loginMsg.textContent = err.message;
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = '进入后台';
    }
  });

  $('btnLogout').addEventListener('click', (e) => {
    e.preventDefault();
    logout();
    toast('已退出');
  });

  async function verifyToken() {
    if (!token) return false;
    try {
      const res = await fetch(API + '/api/auth/check', {
        headers: { Authorization: 'Bearer ' + token },
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  /* ================= 压缩 ================= */

  const COMPRESSIBLE = /^image\/(jpeg|jpg|png|webp|bmp)$/i;

  async function compressFile(file, { maxEdge, quality }) {
    // GIF 会丢动画、SVG 是矢量，都不压缩
    if (!COMPRESSIBLE.test(file.type)) return file;

    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) {
      try {
        bitmap = await createImageBitmap(file);
      } catch (err) {
        return file; // 浏览器解不了，退回原图
      }
    }

    let w = bitmap.width;
    let h = bitmap.height;
    if (maxEdge > 0 && Math.max(w, h) > maxEdge) {
      const scale = maxEdge / Math.max(w, h);
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
    if (!blob) return file;

    // 压缩反而变大（小图/已高度压缩），保留原图
    if (blob.size >= file.size) return file;

    const newName = file.name.replace(/\.[^.]+$/, '') + '.webp';
    return new File([blob], newName, { type: 'image/webp' });
  }

  /* ================= 读取 / 上传 ================= */

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const s = String(reader.result);
        const idx = s.indexOf(',');
        resolve(idx >= 0 ? s.slice(idx + 1) : s);
      };
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });
  }

  function uploadOne(filename, base64, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', API + '/api/upload');
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };

      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch (_) {}
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          reject(new Error(data.error || '上传失败 (HTTP ' + xhr.status + ')'));
        }
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.ontimeout = () => reject(new Error('请求超时'));

      xhr.send(JSON.stringify({ filename, content: base64 }));
    });
  }

  /* ================= 上传队列 UI ================= */

  const queue = $('queue');

  function addQueueItem(name) {
    const el = document.createElement('div');
    el.className = 'qitem';
    el.innerHTML =
      '<div class="qitem-top">' +
      '<span class="qitem-name"></span>' +
      '<span class="qitem-status">等待中</span>' +
      '</div>' +
      '<div class="bar"><i></i></div>';
    el.querySelector('.qitem-name').textContent = name;
    queue.appendChild(el);
    return {
      el,
      setProgress(p) {
        el.querySelector('.bar > i').style.width = Math.round(p * 100) + '%';
      },
      setStatus(text, kind) {
        const s = el.querySelector('.qitem-status');
        s.textContent = text;
        s.className = 'qitem-status' + (kind ? ' ' + kind : '');
      },
      done() {
        el.classList.add('done');
        el.querySelector('.bar > i').style.width = '100%';
      },
      fail() {
        el.classList.add('fail');
      },
    };
  }

  /* ================= 处理文件 ================= */

  const dropzone = $('dropzone');
  const fileInput = $('fileInput');
  const qualityInput = $('quality');
  const qualityVal = $('qualityVal');
  const maxEdgeSel = $('maxEdge');
  const compressOpts = $('compressOpts');

  qualityInput.addEventListener('input', () => {
    qualityVal.textContent = qualityInput.value + '%';
  });

  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.addEventListener('change', () => {
      const mode = document.querySelector('input[name="mode"]:checked').value;
      compressOpts.style.display = mode === 'compress' ? '' : 'none';
    });
  });

  function currentMode() {
    return document.querySelector('input[name="mode"]:checked').value;
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter((f) => /^image\//.test(f.type));
    if (!files.length) {
      toast('没有可上传的图片', 'err');
      return;
    }
    if (uploading) {
      toast('上一批还在传，等一下', 'err');
      return;
    }

    const mode = currentMode();
    const maxEdge = parseInt(maxEdgeSel.value, 10) || 0;
    const quality = (parseInt(qualityInput.value, 10) || 85) / 100;

    // 无损模式下检查体积
    if (mode === 'lossless') {
      const tooBig = files.filter((f) => f.size > LOSSLESS_HARD_BYTES);
      if (tooBig.length) {
        toast(
          `${tooBig.length} 个文件超过 95MB 硬上限，无法上传：${tooBig[0].name}`,
          'err'
        );
        return;
      }
      const warn = files.filter((f) => f.size > LOSSLESS_WARN_BYTES);
      if (warn.length) {
        const ok = confirm(
          `${warn.length} 个文件超过 45MB（${warn
            .map((f) => f.name + ' ' + fmtSize(f.size))
            .join('、')}）。\n\n` +
            'Cloudflare Workers 的请求体和内存限制可能导致上传失败。\n' +
            '继续尝试吗？（建议改用「压缩上传」，或直接在 GitHub 网页上传）'
        );
        if (!ok) return;
      }
    }

    uploading = true;
    let okCount = 0;
    let failCount = 0;

    for (const file of files) {
      const item = addQueueItem(file.name);
      let statusLabel = mode === 'lossless' ? '无损' : '压缩';

      try {
        item.setStatus('处理中…');

        let payloadFile = file;
        if (mode === 'compress') {
          payloadFile = await compressFile(file, { maxEdge, quality });
          if (payloadFile.size < file.size) {
            statusLabel = `压缩 ${fmtSize(file.size)} → ${fmtSize(payloadFile.size)}`;
          } else {
            statusLabel = '未压缩（已是最优）';
          }
        } else {
          statusLabel = `无损 ${fmtSize(file.size)}`;
        }

        item.setStatus('读取中…');
        const base64 = await fileToBase64(payloadFile);

        item.setStatus('上传中…');
        await uploadOne(payloadFile.name, base64, (p) => item.setProgress(p));

        item.done();
        item.setStatus('完成 · ' + statusLabel, 'ok');
        okCount++;
      } catch (err) {
        item.fail();
        item.setStatus(err.message, 'err');
        failCount++;
      }
    }

    uploading = false;
    if (okCount) toast(`上传完成 ${okCount} 张${failCount ? '，失败 ' + failCount + ' 张' : ''}`, 'ok');
    if (failCount && !okCount) toast('全部失败，看上面的错误', 'err');

    refreshAll();
  }

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
    });
  });
  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  /* ================= 统计 + 列表 ================= */

  async function loadStats() {
    try {
      const res = await apiFetch('/api/stats');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      $('stTotal').textContent = d.total;
      $('stSize').textContent = fmtSize(d.totalSize);
      $('stLargest').textContent = fmtSize(d.largest);
      $('stRepo').textContent = d.repo + ' / ' + d.dir;
      $('statsHint').textContent = '更新于 ' + new Date(d.updatedAt).toLocaleTimeString('zh-CN');
    } catch (err) {
      $('statsHint').textContent = '统计加载失败：' + err.message;
    }
  }

  const adminGrid = $('adminGrid');
  const adminEmpty = $('adminEmpty');

  async function loadList(fresh) {
    try {
      const res = await apiFetch('/api/list' + (fresh ? '?fresh=1' : ''));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      const items = d.images || [];

      adminGrid.innerHTML = '';
      $('manageHint').textContent = items.length ? items.length + ' 张' : '—';

      if (!items.length) {
        adminEmpty.style.display = '';
        return;
      }
      adminEmpty.style.display = 'none';

      const frag = document.createDocumentFragment();
      items.forEach((it) => {
        const card = document.createElement('div');
        card.className = 'thumb-card';

        const pic = document.createElement('div');
        pic.className = 'pic';
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = it.name;
        img.src = absUrl(it.url);
        pic.appendChild(img);

        const info = document.createElement('div');
        info.className = 'info';

        const nm = document.createElement('div');
        nm.className = 'nm';
        nm.textContent = it.name;
        nm.title = it.name;

        const sz = document.createElement('div');
        sz.className = 'sz';
        sz.textContent = fmtSize(it.size);

        const acts = document.createElement('div');
        acts.className = 'acts';

        const btnCopy = document.createElement('button');
        btnCopy.className = 'btn btn-sm';
        btnCopy.textContent = '复制';
        btnCopy.addEventListener('click', () => copyText(absUrl(it.url)));

        const btnDel = document.createElement('button');
        btnDel.className = 'btn btn-sm btn-danger';
        btnDel.textContent = '删除';
        btnDel.addEventListener('click', () => deleteImage(it.name, btnDel));

        acts.appendChild(btnCopy);
        acts.appendChild(btnDel);

        info.appendChild(nm);
        info.appendChild(sz);
        info.appendChild(acts);

        card.appendChild(pic);
        card.appendChild(info);
        frag.appendChild(card);
      });
      adminGrid.appendChild(frag);
    } catch (err) {
      toast('列表加载失败：' + err.message, 'err');
    }
  }

  async function deleteImage(name, btn) {
    if (!confirm(`删除 ${name}？\n\n会直接从 GitHub 仓库里移除，不可恢复。`)) return;
    btn.disabled = true;
    btn.textContent = '删除中';
    try {
      const res = await apiFetch('/api/delete?name=' + encodeURIComponent(name), { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      toast('已删除 ' + name, 'ok');
      refreshAll();
    } catch (err) {
      toast('删除失败：' + err.message, 'err');
      btn.disabled = false;
      btn.textContent = '删除';
    }
  }

  function refreshAll() {
    loadStats();
    loadList(true);
  }

  $('btnRefresh').addEventListener('click', () => {
    refreshAll();
    toast('已刷新');
  });

  /* ================= 启动 ================= */

  if (/YOUR-SUBDOMAIN/.test(String(cfg.apiBase || ''))) {
    loginMsg.textContent = '还没配置 API 地址，先编辑 pages/config.js';
    loginBtn.disabled = true;
    return;
  }

  verifyToken().then((valid) => {
    if (valid) showApp();
  });
})();
