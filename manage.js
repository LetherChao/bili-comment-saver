// manage.js —— v1.1 · 管理页逻辑：搜索、点评、分页、导出、本地文件同步
const STORAGE_KEY = 'bili_saved_comments';
const IDB_NAME = 'bili_saver_db';
const IDB_STORE = 'handles';
const HANDLE_KEY = 'local_html_file';
const PER_PAGE = 10;
const LONG_RATIO = 2;

let DATA = [];
let editingPath = null;
let editingText = '';
let fileHandle = null;
let writeTimer = null;
let replyState = {};

// ==================== IndexedDB ====================
function idbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(IDB_STORE)) {
                req.result.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function idbSet(key, val) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
    });
}
async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const r = tx.objectStore(IDB_STORE).get(key);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}
async function idbDel(key) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
    });
}

// ==================== 数据 ====================
function loadData(cb) {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
        DATA = result[STORAGE_KEY] ? JSON.parse(result[STORAGE_KEY]) : [];
        cb && cb();
    });
}
function saveData() {
    chrome.storage.local.set({ [STORAGE_KEY]: JSON.stringify(DATA) });
    scheduleFileWrite();
}
function normalizeData() {
    DATA = DATA.map(item => {
        if (typeof item.author === 'string') {
            return {
                type: 'comment_with_replies',
                videoTitle: item.videoTitle,
                videoUrl: item.videoUrl,
                savedAt: item.savedAt,
                author: { name: item.author, content: item.content || '', time: item.time || '', images: item.images || [], avatar: '', spaceUrl: '', likeCount: '', rpid: '', root: '', parent: '' },
                replies: (item.replies || []).map(r => ({
                    name: r.author || r.name || '',
                    content: r.text || r.content || '',
                    time: r.time || '',
                    images: r.images || [],
                    avatar: '',
                    spaceUrl: '',
                    likeCount: '',
                    rpid: '',
                    root: '',
                    parent: ''
                }))
            };
        }
        return item;
    });
}

// ==================== 跳转链接生成 ====================
function buildJumpUrl(videoUrl, author) {
    if (!author || !author.rpid) return '';
    const m = (videoUrl || '').match(/\/video\/(BV[\w]+)/);
    if (!m) return '';
    const bv = m[1];
    const rpid = author.rpid;
    const root = author.root;
    if (root && String(root) !== '0' && String(root) !== '') {
        // 楼中楼回复
        return 'https://www.bilibili.com/video/' + bv
             + '?comment_on=1'
             + '&comment_root_id=' + root
             + '&comment_secondary_id=' + rpid
             + '#reply' + rpid;
    }
    // 主评论
    return 'https://www.bilibili.com/video/' + bv + '#reply' + rpid;
}

// ==================== 渲染工具 ====================
function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderImages(images) {
    if (!images || !images.length) return '';
    return '<div class="images">' + images.map(src => {
        const f = src.indexOf('//') === 0 ? 'https:' + src : src.replace(/^http:/, 'https:');
        return '<img src="' + escapeHtml(f) + '" loading="lazy" class="zoomable">';
    }).join('') + '</div>';
}
function renderAuthor(a, small, videoUrl) {
    a = a || {};
    const av = a.avatar
        ? '<img src="' + escapeHtml(a.avatar) + '" class="avatar" loading="lazy">'
        : '<span class="avatar-placeholder">👤</span>';
    const cls = 'avatar-link' + (small ? ' avatar-link-sm' : '');
    const avTag = a.spaceUrl
        ? '<a href="' + escapeHtml(a.spaceUrl) + '" target="_blank" class="' + cls + '">' + av + '</a>'
        : '<span class="' + cls + '">' + av + '</span>';
    const nmTag = a.spaceUrl
        ? '<a href="' + escapeHtml(a.spaceUrl) + '" target="_blank" class="author-name">' + escapeHtml(a.name || '未知') + '</a>'
        : '<span class="author-name">' + escapeHtml(a.name || '未知') + '</span>';
    const likeTag = a.likeCount
        ? '<span class="like-badge" title="点赞数">👍 ' + escapeHtml(a.likeCount) + '</span>'
        : '';

    // 跳转链接
    const jumpUrl = buildJumpUrl(videoUrl || '', a);
    const jumpTag = jumpUrl
        ? '<a href="' + escapeHtml(jumpUrl) + '" target="_blank" class="jump-link" title="跳转到 B 站原评论">🔗</a>'
        : '';

    return '<div class="author-block' + (small ? ' author-block-sm' : '') + '">' + avTag +
        '<div class="author-info">' + nmTag + jumpTag +
        (a.time ? '<span class="time">' + escapeHtml(a.time) + '</span>' : '') +
        likeTag + '</div></div>';
}
function typeLabel(t) {
    if (t === 'comment') return '<span class="type-badge type-comment">仅评论</span>';
    if (t === 'reply_only') return '<span class="type-badge type-reply">单条回复</span>';
    return '<span class="type-badge type-full">评论+回复</span>';
}
function renderNote(target, path) {
    if (!target) return '';
    let h = '<div class="note-section">';
    if (editingPath === path) {
        h += '<div class="note-editor">';
        h += '<textarea class="note-input" placeholder="写下你的点评…">' + escapeHtml(editingText) + '</textarea>';
        h += '<div class="note-editor-actions">';
        h += '<button class="note-save-btn" data-action="save-note" data-path="' + path + '">💾 保存点评</button>';
        h += '<button class="note-cancel-btn" data-action="cancel-note">取消</button>';
        h += '</div></div>';
    } else if (target.note) {
        h += '<div class="note-display">';
        h += '<span class="note-label">📝 我的点评：</span>';
        h += '<div class="note-content">' + escapeHtml(target.note) + '</div>';
        h += '<div class="note-actions">';
        h += '<button data-action="edit-note" data-path="' + path + '">编辑</button>';
        h += '<button data-action="del-note" data-path="' + path + '">删除</button>';
        h += '</div></div>';
    } else {
        h += '<button class="note-add-btn" data-action="add-note" data-path="' + path + '">✏️ 添加点评</button>';
    }
    h += '</div>';
    return h;
}

function renderOneReply(r, path, videoUrl) {
    let h = '<div class="reply">' + renderAuthor(r, true, videoUrl);
    if (r.content) h += '<blockquote>' + escapeHtml(r.content) + '</blockquote>';
    h += renderImages(r.images);
    h += renderNote(r, path);
    h += '</div>';
    return h;
}

function renderRepliesPage(container, item, index, page) {
    const replies = item.replies;
    const total = replies.length;
    const totalPages = Math.ceil(total / PER_PAGE) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    const start = (page - 1) * PER_PAGE;
    const slice = replies.slice(start, start + PER_PAGE);

    let h = '';
    slice.forEach((r, i) => {
        const realIdx = start + i;
        h += renderOneReply(r, index + '-r-' + realIdx, item.videoUrl);
    });

    if (totalPages > 1) {
        h += '<div class="pagination">';
        h += '<button class="page-btn" data-action="goto-page" data-idx="' + index + '" data-page="' + (page - 1) + '"' + (page === 1 ? ' disabled' : '') + '>上一页</button>';

        const startP = Math.max(1, page - 2);
        const endP = Math.min(totalPages, page + 2);

        if (startP > 1) {
            h += '<button class="page-btn" data-action="goto-page" data-idx="' + index + '" data-page="1">1</button>';
            if (startP > 2) h += '<span class="page-ellipsis">…</span>';
        }
        for (let i = startP; i <= endP; i++) {
            h += '<button class="page-btn' + (i === page ? ' active' : '') + '" data-action="goto-page" data-idx="' + index + '" data-page="' + i + '">' + i + '</button>';
        }
        if (endP < totalPages) {
            if (endP < totalPages - 1) h += '<span class="page-ellipsis">…</span>';
            h += '<button class="page-btn" data-action="goto-page" data-idx="' + index + '" data-page="' + totalPages + '">' + totalPages + '</button>';
        }

        h += '<button class="page-btn" data-action="goto-page" data-idx="' + index + '" data-page="' + (page + 1) + '"' + (page === totalPages ? ' disabled' : '') + '>下一页</button>';
        h += '<span class="page-info">第 ' + page + ' / ' + totalPages + ' 页</span>';
        h += '</div>';
    }

    container.innerHTML = h;
}

function renderCard(item, index) {
    let h = '<div class="comment"><div class="card-header">';
    h += '<a class="video-title" href="' + escapeHtml(item.videoUrl) + '" target="_blank">' + escapeHtml(item.videoTitle) + '</a>';
    h += typeLabel(item.type);
    h += '<span class="meta">收藏于 ' + escapeHtml(item.savedAt) + '</span>';
    h += '<button class="delete-btn" data-action="del-item" data-index="' + index + '">🗑️ 删除</button>';
    h += '</div>';
    if (item.type === 'reply_only') {
        if (item.parentInfo) {
            h += '<div class="section-title">回复上下文</div>';
            h += '<div class="context"><span class="context-author">' + escapeHtml(item.parentInfo.name || '未知') + '</span> 的原评论：';
            h += '<blockquote class="context-quote">' + escapeHtml(item.parentInfo.content || '') + '</blockquote></div>';
        }
        h += '<div class="section-title">收藏的回复</div>' + renderAuthor(item.author, false, item.videoUrl);
        if (item.author && item.author.content) h += '<blockquote>' + escapeHtml(item.author.content) + '</blockquote>';
        h += renderImages(item.author && item.author.images) + renderNote(item.author, index + '-a');
    } else {
        h += '<div class="section-title">主评论</div>' + renderAuthor(item.author, false, item.videoUrl);
        if (item.author && item.author.content) h += '<blockquote>' + escapeHtml(item.author.content) + '</blockquote>';
        h += renderImages(item.author && item.author.images) + renderNote(item.author, index + '-a');
        if (item.replies && item.replies.length) {
            h += '<div class="reply-toggle-wrap">';
            h += '<button class="reply-toggle-btn" data-action="toggle-replies" data-idx="' + index + '">共 ' + item.replies.length + ' 条回复 <span class="arrow">▼</span></button>';
            h += '</div>';
            h += '<div class="replies-container" data-idx="' + index + '"></div>';
        }
    }
    h += '</div>';
    return h;
}

function getSearchText(item) {
    const p = [item.videoTitle || '',
        item.author && item.author.name || '',
        item.author && item.author.content || '',
        item.author && item.author.note || '',
        item.parentInfo && item.parentInfo.name || '',
        item.parentInfo && item.parentInfo.content || ''];
    (item.replies || []).forEach(r => { p.push(r.name || ''); p.push(r.content || ''); p.push(r.note || ''); });
    return p.join(' ').toLowerCase();
}
function getByPath(path) {
    const parts = path.split('-');
    const i = parseInt(parts[0], 10);
    if (parts[1] === 'r') return DATA[i].replies[parseInt(parts[2], 10)];
    return DATA[i].author;
}

function render() {
    const q = (document.getElementById('search-box').value || '').toLowerCase().trim();
    const listEl = document.getElementById('list');
    let h = '', v = 0;
    DATA.forEach((item, index) => {
        if (q && getSearchText(item).indexOf(q) === -1) return;
        v++;
        h += renderCard(item, index);
    });
    listEl.innerHTML = v === 0
        ? '<p class="empty">' + (DATA.length === 0 ? '还没有收藏任何评论。去 B 站点一下评论旁的收藏按钮吧。' : '没有匹配的记录。') + '</p>'
        : h;

    Object.keys(replyState).forEach(function(idxStr) {
        const st = replyState[idxStr];
        if (!st || !st.open) return;
        const idx = parseInt(idxStr, 10);
        const container = listEl.querySelector('.replies-container[data-idx="' + idx + '"]');
        const btn = listEl.querySelector('.reply-toggle-btn[data-idx="' + idx + '"]');
        if (container && DATA[idx] && DATA[idx].replies) {
            container.classList.add('open');
            if (btn) btn.classList.add('open');
            renderRepliesPage(container, DATA[idx], idx, st.page);
        }
    });

    document.getElementById('stats-total').textContent = DATA.length;
    document.getElementById('stats-visible').textContent = v;

    if (editingPath) {
        const ta = document.querySelector('.note-input');
        if (ta) ta.focus();
    }
}

// ==================== 事件 ====================
document.getElementById('list').addEventListener('click', (e) => {
    const t = e.target;
    const action = t.getAttribute && t.getAttribute('data-action');
    if (!action) return;

    if (action === 'del-item') {
        e.preventDefault();
        const idx = parseInt(t.getAttribute('data-index'), 10);
        if (!confirm('确定删除这条收藏吗？')) return;
        DATA.splice(idx, 1);
        replyState = {};
        saveData(); render();
    } else if (action === 'toggle-replies') {
        e.preventDefault();
        const idx = parseInt(t.getAttribute('data-idx'), 10);
        const container = document.querySelector('.replies-container[data-idx="' + idx + '"]');
        if (!container || !DATA[idx] || !DATA[idx].replies) return;
        const st = replyState[idx] || (replyState[idx] = { open: false, page: 1 });
        st.open = !st.open;
        if (st.open) {
            container.classList.add('open');
            t.classList.add('open');
            renderRepliesPage(container, DATA[idx], idx, st.page);
        } else {
            container.classList.remove('open');
            t.classList.remove('open');
        }
    } else if (action === 'goto-page') {
        e.preventDefault();
        const idx = parseInt(t.getAttribute('data-idx'), 10);
        const page = parseInt(t.getAttribute('data-page'), 10);
        const container = document.querySelector('.replies-container[data-idx="' + idx + '"]');
        if (!container) return;
        const st = replyState[idx] || (replyState[idx] = { open: true, page: 1 });
        st.page = page;
        renderRepliesPage(container, DATA[idx], idx, page);
        container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (action === 'add-note') {
        e.preventDefault();
        editingPath = t.getAttribute('data-path');
        editingText = '';
        render();
    } else if (action === 'edit-note') {
        e.preventDefault();
        const path = t.getAttribute('data-path');
        const target = getByPath(path);
        editingPath = path;
        editingText = (target && target.note) || '';
        render();
    } else if (action === 'del-note') {
        e.preventDefault();
        if (!confirm('确定删除这条点评吗？')) return;
        const target = getByPath(t.getAttribute('data-path'));
        if (target) { delete target.note; saveData(); render(); }
    } else if (action === 'save-note') {
        e.preventDefault();
        const path = t.getAttribute('data-path');
        const ta = document.querySelector('.note-input');
        const target = getByPath(path);
        if (target && ta) {
            const v = ta.value.trim();
            if (v) target.note = v; else delete target.note;
        }
        editingPath = null; editingText = '';
        saveData(); render();
    } else if (action === 'cancel-note') {
        e.preventDefault();
        editingPath = null; editingText = '';
        render();
    }
});

document.getElementById('search-box').addEventListener('input', render);

// ==================== 图片灯箱 ====================
const lb = document.getElementById('lightbox');
const lbImg = document.getElementById('lightbox-img');
const lh = document.getElementById('loading-hint');
const lbStage = document.getElementById('lightbox-stage');
const lbPrevBtn = document.getElementById('lb-prev');
const lbNextBtn = document.getElementById('lb-next');
const lbCounter = document.getElementById('lb-counter');

let lbImages = [];
let lbIndex = 0;
let lbDragging = false;
let lbDragStart = null;
let lbMouseDownPos = null;

function getOrig(u) { return u ? u.replace(/@[^/]*$/, '') : ''; }

function openLightbox(images, idx) {
    lbImages = images || [];
    lbIndex = idx || 0;
    lb.classList.add('active');
    document.body.style.overflow = 'hidden';
    showLightboxImage();
}

function showLightboxImage() {
    if (!lbImages.length) return;
    var src = lbImages[lbIndex];
    var original = getOrig(src);

    if (lbPrevBtn) lbPrevBtn.disabled = (lbIndex <= 0);
    if (lbNextBtn) lbNextBtn.disabled = (lbIndex >= lbImages.length - 1);
    if (lbCounter) {
        lbCounter.textContent = lbImages.length > 1 ? (lbIndex + 1) + ' / ' + lbImages.length : '';
    }

    if (lbStage) lbStage.classList.remove('long-image');
    lb.scrollTop = 0;
    lb.scrollLeft = 0;
    lh.style.display = 'block';
    lbImg.style.opacity = '0.3';
    lbImg.src = '';
    lbImg.style.width = '';
    lbImg.style.height = '';

    var img = new Image();
    img.onload = function() {
        lbImg.src = original;
        lbImg.style.opacity = '1';
        lh.style.display = 'none';
        setTimeout(function() { applyImageSize(img); }, 20);
    };
    img.onerror = function() {
        lbImg.src = src;
        lbImg.style.opacity = '1';
        lh.style.display = 'none';
        setTimeout(function() {
            var fake = { naturalWidth: lbImg.naturalWidth, naturalHeight: lbImg.naturalHeight };
            applyImageSize(fake);
        }, 20);
    };
    img.src = original;
}

function applyImageSize(loaded) {
    if (!lbStage || !lbImg) return;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var padding = 80;
    var nw = loaded.naturalWidth || lbImg.naturalWidth;
    var nh = loaded.naturalHeight || lbImg.naturalHeight;
    if (!nw || !nh) return;

    var ratio = nh / nw;

    if (ratio > LONG_RATIO) {
        var w = nw;
        var h = nh;
        if (w > vw - padding) {
            var scale = (vw - padding) / w;
            w = Math.round(w * scale);
            h = Math.round(h * scale);
        }
        lbImg.style.width = w + 'px';
        lbImg.style.height = h + 'px';
        lbStage.classList.add('long-image');
    } else {
        var scale2 = Math.min((vw - padding) / nw, (vh - padding) / nh, 1);
        lbImg.style.width = Math.round(nw * scale2) + 'px';
        lbImg.style.height = Math.round(nh * scale2) + 'px';
        lbStage.classList.remove('long-image');
    }

    lb.scrollTop = 0;
    lb.scrollLeft = 0;
}

function closeLightbox() {
    lb.classList.remove('active');
    lbImg.src = '';
    lbImg.style.width = '';
    lbImg.style.height = '';
    document.body.style.overflow = '';
    lh.style.display = 'none';
    lbImages = [];
    lbIndex = 0;
    lbDragging = false;
    lbMouseDownPos = null;
}

function lbPrev() { if (lbIndex > 0) { lbIndex--; showLightboxImage(); } }
function lbNext() { if (lbIndex < lbImages.length - 1) { lbIndex++; showLightboxImage(); } }

document.addEventListener('click', function(e) {
    var z = e.target.closest && e.target.closest('img.zoomable');
    if (!z) return;
    e.preventDefault();
    e.stopPropagation();

    var wrap = z.closest('.images');
    var images = [];
    if (wrap) {
        images = Array.prototype.slice.call(wrap.querySelectorAll('img.zoomable')).map(function(im) { return im.src; });
    }
    if (!images.length) images = [z.src];
    var idx = images.indexOf(z.src);
    if (idx < 0) idx = 0;
    openLightbox(images, idx);
});

lb.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    lbMouseDownPos = { x: e.clientX, y: e.clientY };
    if (!lbStage.classList.contains('long-image')) return;
    if (e.target !== lbImg) return;
    lbDragging = true;
    lbDragStart = { x: e.clientX, y: e.clientY, sl: lb.scrollLeft, st: lb.scrollTop };
    e.preventDefault();
});

document.addEventListener('mousemove', function(e) {
    if (!lbDragging) return;
    lb.scrollLeft = lbDragStart.sl - (e.clientX - lbDragStart.x);
    lb.scrollTop = lbDragStart.st - (e.clientY - lbDragStart.y);
});

document.addEventListener('mouseup', function() {
    lbDragging = false;
});

lb.addEventListener('click', function(e) {
    if (e.target.closest && e.target.closest('.lb-nav')) return;
    if (lbMouseDownPos) {
        var dx = Math.abs(e.clientX - lbMouseDownPos.x);
        var dy = Math.abs(e.clientY - lbMouseDownPos.y);
        lbMouseDownPos = null;
        if (dx > 5 || dy > 5) return;
    }
    closeLightbox();
});

if (lbPrevBtn) lbPrevBtn.addEventListener('click', function(e) { e.stopPropagation(); lbPrev(); });
if (lbNextBtn) lbNextBtn.addEventListener('click', function(e) { e.stopPropagation(); lbNext(); });

document.addEventListener('keydown', function(e) {
    if (!lb.classList.contains('active')) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') lbPrev();
    else if (e.key === 'ArrowRight') lbNext();
    else if (e.key === 'ArrowUp') { lb.scrollTop -= 100; e.preventDefault(); }
    else if (e.key === 'ArrowDown') { lb.scrollTop += 100; e.preventDefault(); }
});

window.addEventListener('resize', function() {
    if (!lb.classList.contains('active')) return;
    if (lbImg.naturalWidth && lbImg.naturalHeight) {
        applyImageSize({ naturalWidth: lbImg.naturalWidth, naturalHeight: lbImg.naturalHeight });
    }
});

// ==================== 文件关联 ====================
function supportsFS() {
    return typeof window.showSaveFilePicker === 'function' || typeof window.showOpenFilePicker === 'function';
}
function setFileStatus(text, cls) {
    const el = document.getElementById('file-status');
    el.textContent = text;
    el.className = 'file-status' + (cls ? ' ' + cls : '');
}
function updateFileButtons() {
    const linked = !!fileHandle;
    const unlinkBtn = document.getElementById('btn-unlink');
    if (unlinkBtn) unlinkBtn.style.display = linked ? '' : 'none';
    const linkBtn = document.getElementById('btn-link-file');
    if (linkBtn) linkBtn.textContent = linked ? '🔗 更换本地文件' : '🔗 关联本地 HTML 文件';
}
async function checkPermission() {
    if (!fileHandle) return 'no-handle';
    try {
        return await fileHandle.queryPermission({ mode: 'readwrite' });
    } catch (e) { return 'error'; }
}
async function linkFile() {
    if (!supportsFS()) {
        alert('此浏览器不支持文件关联功能。请用 Chrome 或 Edge 打开管理页面。');
        return;
    }
    try {
        fileHandle = await window.showSaveFilePicker({
            suggestedName: 'B站评论收藏.html',
            types: [{ description: 'HTML 文件', accept: { 'text/html': ['.html'] } }]
        });
        await idbSet(HANDLE_KEY, fileHandle);
        await writeFileNow();
        updateFileButtons();
        setFileStatus('已关联：' + fileHandle.name, 'linked');
    } catch (e) {
        if (e.name !== 'AbortError') alert('关联失败：' + e.message);
    }
}
async function resumePermission() {
    if (!fileHandle) return;
    try {
        const p = await fileHandle.requestPermission({ mode: 'readwrite' });
        if (p === 'granted') {
            await writeFileNow();
            setFileStatus('已关联：' + fileHandle.name, 'linked');
            const btn = document.getElementById('btn-resume-permission');
            if (btn) btn.style.display = 'none';
        } else {
            setFileStatus('未授权写入', 'need-permission');
        }
    } catch (e) {
        setFileStatus('授权失败', 'error');
    }
}
async function unlinkFile() {
    if (!confirm('确定取消与该本地文件的关联吗？取消后修改不会再自动同步到该文件。')) return;
    fileHandle = null;
    try { await idbDel(HANDLE_KEY); } catch (e) {}
    setFileStatus('未关联任何本地文件', '');
    updateFileButtons();
    const btn = document.getElementById('btn-resume-permission');
    if (btn) btn.style.display = 'none';
}
async function writeFileNow() {
    if (!fileHandle) return;
    let perm = await checkPermission();
    if (perm !== 'granted') {
        setFileStatus('需要重新授权（点旁边按钮）', 'need-permission');
        const btn = document.getElementById('btn-resume-permission');
        if (btn) btn.style.display = '';
        return;
    }
    try {
        const html = buildExportHtml();
        const w = await fileHandle.createWritable();
        await w.write(html);
        await w.close();
        setFileStatus('已同步到：' + fileHandle.name + ' · ' + new Date().toLocaleTimeString('zh-CN'), 'linked');
        const btn = document.getElementById('btn-resume-permission');
        if (btn) btn.style.display = 'none';
    } catch (e) {
        console.warn('写入失败', e);
        setFileStatus('写入失败：' + e.message, 'error');
    }
}
function scheduleFileWrite() {
    if (!fileHandle) return;
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => { writeFileNow(); }, 500);
}
async function tryRestoreHandle() {
    try {
        const h = await idbGet(HANDLE_KEY);
        if (h) {
            fileHandle = h;
            updateFileButtons();
            const perm = await checkPermission();
            if (perm === 'granted') {
                setFileStatus('已关联：' + h.name, 'linked');
                writeFileNow();
            } else {
                setFileStatus('已关联：' + h.name + '（需重新授权）', 'need-permission');
                const btn = document.getElementById('btn-resume-permission');
                if (btn) btn.style.display = '';
            }
        }
    } catch (e) { console.warn('恢复文件句柄失败', e); }
}

document.getElementById('btn-link-file').addEventListener('click', linkFile);
const resumePermBtn = document.getElementById('btn-resume-permission');
if (resumePermBtn) resumePermBtn.addEventListener('click', resumePermission);
const unlinkBtnEl = document.getElementById('btn-unlink');
if (unlinkBtnEl) unlinkBtnEl.addEventListener('click', unlinkFile);

// ==================== 导出 HTML ====================
function b64Encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
function buildExportHtml() {
    const encoded = b64Encode(JSON.stringify(DATA));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>B站评论收藏</title>
<style>
:root{
  --bg:#18191c;--card:#212226;--text:#e3e5e7;--muted:#9499a0;--primary:#00aeec;
  --border:#2f3134;--quote-bg:#2b2d31;--note-bg:#3a2d10;--note-border:#f5a623;
}
*{box-sizing:border-box;}
body{margin:0;padding:40px 20px;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;}
.container{max-width:860px;margin:0 auto;}
h1{font-size:28px;margin:0 0 6px;color:#e3e5e7;}
.export-time{color:var(--muted);font-size:13px;margin:0 0 20px;}
.search-box{width:100%;padding:9px 14px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--card);color:var(--text);outline:none;font-family:inherit;margin-bottom:24px;}
.search-box:focus{border-color:var(--primary);}
.search-box::placeholder{color:#5c6169;}
.empty{text-align:center;color:var(--muted);padding:40px 0;}
.comment{background:var(--card);border-radius:12px;padding:24px 28px;margin-bottom:24px;box-shadow:0 1px 3px rgba(0,0,0,0.3);border:1px solid var(--border);}
.card-header{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin-bottom:8px;}
.video-title{font-size:15px;font-weight:600;color:var(--primary);text-decoration:none;}
.video-title:hover{text-decoration:underline;}
.meta{font-size:12px;color:var(--muted);}
.type-badge{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500;}
.type-comment{background:#1a3a4a;color:#6ec8f0;}
.type-full{background:#1f3a1a;color:#8ed070;}
.type-reply{background:#4a3520;color:#f0b060;}
.section-title{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin:22px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--border);}
.context{padding:12px 16px;background:var(--quote-bg);border-radius:8px;font-size:14px;}
.context-author{color:var(--primary);font-weight:600;}
.context-quote{margin:8px 0 0;padding:0;border:none;background:transparent;color:var(--muted);font-style:italic;font-size:13px;}
.author-block{display:flex;gap:10px;align-items:flex-start;margin-bottom:8px;}
.author-block-sm{gap:8px;}
.avatar-link{flex-shrink:0;display:block;width:40px;height:40px;border-radius:50%;overflow:hidden;border:1px solid var(--border);background:var(--quote-bg);text-decoration:none;transition:.15s;}
.avatar-link-sm{width:30px;height:30px;}
.avatar-link:hover{border-color:var(--primary);transform:scale(1.06);}
.avatar{width:100%;height:100%;object-fit:cover;display:block;}
.avatar-placeholder{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:18px;color:var(--muted);background:var(--quote-bg);}
.author-info{flex:1;min-width:0;}
.author-name{font-weight:600;font-size:15px;color:var(--text);text-decoration:none;margin-right:10px;}
.author-name:hover{color:var(--primary);}
.jump-link{font-size:13px;margin-right:8px;text-decoration:none;color:var(--muted);transition:color .15s;opacity:.7;}
.jump-link:hover{color:var(--primary);opacity:1;}
.time{font-size:13px;color:var(--muted);margin-right:10px;}
.like-badge{font-size:12px;color:#f5909e;background:#3a1f28;padding:1px 8px;border-radius:10px;font-weight:500;}
blockquote{margin:6px 0 0;padding:12px 16px;background:var(--quote-bg);border-left:3px solid var(--primary);border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:15px;}
.images{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}
.images img{max-width:200px;max-height:200px;border-radius:8px;border:1px solid var(--border);background:#fff;cursor:zoom-in;transition:.15s;}
.images img:hover{transform:scale(1.03);}
.reply{margin-top:14px;padding:14px 18px;background:var(--quote-bg);border-radius:8px;border-left:2px solid var(--border);}
.reply blockquote{background:transparent;border-left:none;padding:4px 0 0;}
.note-display{background:var(--note-bg);border-left:3px solid var(--note-border);padding:12px 16px;border-radius:6px;margin-top:14px;}
.reply .note-display{margin-top:10px;}
.note-label{font-weight:600;font-size:13px;color:#f5a623;margin-right:6px;}
.note-content{font-size:14px;white-space:pre-wrap;margin-top:4px;}
.reply-toggle-wrap{margin-top:16px;}
.reply-toggle-btn{padding:6px 14px;font-size:13px;background:transparent;color:var(--primary);border:1px solid var(--primary);border-radius:6px;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px;transition:.15s;}
.reply-toggle-btn:hover{background:var(--quote-bg);}
.reply-toggle-btn .arrow{font-size:10px;transition:transform .2s;display:inline-block;}
.reply-toggle-btn.open .arrow{transform:rotate(180deg);}
.replies-container{display:none;margin-top:8px;}
.replies-container.open{display:block;}
.pagination{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;align-items:center;margin-top:14px;padding-top:12px;border-top:1px dashed var(--border);}
.page-btn{padding:3px 10px;font-size:12px;background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-family:inherit;min-width:28px;text-align:center;}
.page-btn:hover:not(:disabled):not(.active){border-color:var(--primary);color:var(--primary);}
.page-btn.active{background:var(--primary);color:#fff;border-color:var(--primary);}
.page-btn:disabled{opacity:.4;cursor:not-allowed;}
.page-ellipsis{color:var(--muted);padding:0 2px;font-size:12px;}
.page-info{font-size:12px;color:var(--muted);margin-left:6px;}
.lightbox{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:9999;overflow:auto;}
.lightbox.active{display:block;}
.lightbox-stage{min-height:100%;display:flex;align-items:center;justify-content:center;padding:40px;box-sizing:border-box;}
.lightbox-stage.long-image{align-items:flex-start;}
.lightbox img{display:block;border-radius:4px;background:#fff;box-shadow:0 8px 60px rgba(0,0,0,.6);user-select:none;-webkit-user-drag:none;cursor:zoom-out;}
.lightbox-stage.long-image img{cursor:grab;}
.lightbox-stage.long-image img:active{cursor:grabbing;}
.lb-nav{position:fixed;top:50%;transform:translateY(-50%);width:48px;height:80px;background:rgba(0,0,0,.45);color:#fff;border:none;cursor:pointer;font-size:32px;line-height:1;z-index:10000;transition:background .15s;display:flex;align-items:center;justify-content:center;font-family:Georgia,serif;padding:0;}
.lb-nav:hover{background:rgba(0,0,0,.75);}
.lb-prev{left:16px;border-radius:6px;}
.lb-next{right:16px;border-radius:6px;}
.lb-nav:disabled{opacity:.15;cursor:not-allowed;}
.lb-counter{position:fixed;top:16px;left:50%;transform:translateX(-50%);color:#fff;font-size:13px;opacity:.85;background:rgba(0,0,0,.55);padding:4px 14px;border-radius:12px;z-index:10001;letter-spacing:1px;}
.lb-counter:empty{display:none;}
.lightbox .loading-hint{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);color:#fff;font-size:13px;opacity:.6;display:none;z-index:10001;}
</style>
</head>
<body>
<div class="container">
  <h1>B站评论收藏</h1>
  <p class="export-time">导出时间：${new Date().toLocaleString('zh-CN')} · 共 ${DATA.length} 条</p>
  <input type="text" class="search-box" id="search-box" placeholder="🔍 搜索...">
  <div id="list"></div>
</div>

<div class="lightbox" id="lightbox">
  <button class="lb-nav lb-prev" id="lb-prev" title="上一张">‹</button>
  <button class="lb-nav lb-next" id="lb-next" title="下一张">›</button>
  <span class="lb-counter" id="lb-counter"></span>
  <div class="lightbox-stage" id="lightbox-stage">
    <img id="lightbox-img" src="" alt="">
  </div>
  <span class="loading-hint" id="loading-hint">正在加载原图…</span>
</div>
<script id="collection-data" type="text/plain">${encoded}</script>
<script>
(function(){
  var PER_PAGE = 10;
  var LONG_RATIO = 2;
  var DATA;
  var replyState = {};

  function b64Decode(b64){var bin=atob(b64);var bytes=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);return new TextDecoder().decode(bytes);}
  var raw = document.getElementById('collection-data').textContent.trim();
  try{DATA=JSON.parse(b64Decode(raw));}catch(e){try{DATA=JSON.parse(raw);}catch(e2){DATA=[];}}

  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

  function buildJumpUrl(videoUrl, author){
    if(!author||!author.rpid) return '';
    var m=(videoUrl||'').match(/\/video\/(BV[\w]+)/);
    if(!m) return '';
    var bv=m[1];
    var rpid=author.rpid;
    var root=author.root;
    if(root&&String(root)!=='0'&&String(root)!==''){
      return 'https://www.bilibili.com/video/'+bv+'?comment_on=1&comment_root_id='+root+'&comment_secondary_id='+rpid+'#reply'+rpid;
    }
    return 'https://www.bilibili.com/video/'+bv+'#reply'+rpid;
  }

  function renderImages(images){if(!images||!images.length)return '';return '<div class="images">'+images.map(function(src){var f=src.indexOf('//')===0?'https:'+src:src.replace(/^http:/,'https:');return '<img src="'+esc(f)+'" loading="lazy" class="zoomable">';}).join('')+'</div>';}

  function renderAuthor(a,small,videoUrl){
    a=a||{};
    var av=a.avatar?'<img src="'+esc(a.avatar)+'" class="avatar" loading="lazy">':'<span class="avatar-placeholder">👤</span>';
    var cls='avatar-link'+(small?' avatar-link-sm':'');
    var avTag=a.spaceUrl?'<a href="'+esc(a.spaceUrl)+'" target="_blank" class="'+cls+'">'+av+'</a>':'<span class="'+cls+'">'+av+'</span>';
    var nmTag=a.spaceUrl?'<a href="'+esc(a.spaceUrl)+'" target="_blank" class="author-name">'+esc(a.name||'未知')+'</a>':'<span class="author-name">'+esc(a.name||'未知')+'</span>';
    var likeTag=a.likeCount?'<span class="like-badge" title="点赞数">👍 '+esc(a.likeCount)+'</span>':'';
    var jumpUrl=buildJumpUrl(videoUrl||'',a);
    var jumpTag=jumpUrl?'<a href="'+esc(jumpUrl)+'" target="_blank" class="jump-link" title="跳转到 B 站原评论">🔗</a>':'';
    return '<div class="author-block'+(small?' author-block-sm':'')+'">'+avTag+'<div class="author-info">'+nmTag+jumpTag+(a.time?'<span class="time">'+esc(a.time)+'</span>':'')+likeTag+'</div></div>';
  }

  function typeLabel(t){if(t==='comment')return '<span class="type-badge type-comment">仅评论</span>';if(t==='reply_only')return '<span class="type-badge type-reply">单条回复</span>';return '<span class="type-badge type-full">评论+回复</span>';}
  function renderNote(t){if(!t||!t.note)return '';return '<div class="note-display"><span class="note-label">📝 我的点评：</span><div class="note-content">'+esc(t.note)+'</div></div>';}
  function renderOneReply(r,videoUrl){var h = '<div class="reply">' + renderAuthor(r, true, videoUrl);if(r.content) h += '<blockquote>'+esc(r.content)+'</blockquote>';h += renderImages(r.images) + renderNote(r) + '</div>';return h;}
  function renderRepliesPage(container, replies, page, videoUrl){
    var total = replies.length;
    var totalPages = Math.ceil(total / PER_PAGE) || 1;
    if(page < 1) page = 1;
    if(page > totalPages) page = totalPages;
    var start = (page - 1) * PER_PAGE;
    var slice = replies.slice(start, start + PER_PAGE);
    var h = '';
    slice.forEach(function(r){ h += renderOneReply(r, videoUrl); });
    if(totalPages > 1){
      h += '<div class="pagination">';
      h += '<button class="page-btn" data-page="'+(page-1)+'"'+(page===1?' disabled':'')+'>上一页</button>';
      var startP = Math.max(1, page - 2);
      var endP = Math.min(totalPages, page + 2);
      if(startP > 1){
        h += '<button class="page-btn" data-page="1">1</button>';
        if(startP > 2) h += '<span class="page-ellipsis">…</span>';
      }
      for(var i = startP; i <= endP; i++){
        h += '<button class="page-btn'+(i===page?' active':'')+'" data-page="'+i+'">'+i+'</button>';
      }
      if(endP < totalPages){
        if(endP < totalPages - 1) h += '<span class="page-ellipsis">…</span>';
        h += '<button class="page-btn" data-page="'+totalPages+'">'+totalPages+'</button>';
      }
      h += '<button class="page-btn" data-page="'+(page+1)+'"'+(page===totalPages?' disabled':'')+'>下一页</button>';
      h += '<span class="page-info">第 '+page+' / '+totalPages+' 页</span>';
      h += '</div>';
    }
    container.innerHTML = h;
  }
  function renderCard(item, index){
    var h='<div class="comment"><div class="card-header">';
    h+='<a class="video-title" href="'+esc(item.videoUrl)+'" target="_blank">'+esc(item.videoTitle)+'</a>';
    h+=typeLabel(item.type);
    h+='<span class="meta">收藏于 '+esc(item.savedAt)+'</span></div>';
    if(item.type==='reply_only'){
      if(item.parentInfo){h+='<div class="section-title">回复上下文</div><div class="context"><span class="context-author">'+esc(item.parentInfo.name||'未知')+'</span> 的原评论：<blockquote class="context-quote">'+esc(item.parentInfo.content||'')+'</blockquote></div>';}
      h+='<div class="section-title">收藏的回复</div>'+renderAuthor(item.author,false,item.videoUrl);
      if(item.author&&item.author.content)h+='<blockquote>'+esc(item.author.content)+'</blockquote>';
      h+=renderImages(item.author&&item.author.images)+renderNote(item.author);
    } else {
      h+='<div class="section-title">主评论</div>'+renderAuthor(item.author,false,item.videoUrl);
      if(item.author&&item.author.content)h+='<blockquote>'+esc(item.author.content)+'</blockquote>';
      h+=renderImages(item.author&&item.author.images)+renderNote(item.author);
      if(item.replies&&item.replies.length){
        h+='<div class="reply-toggle-wrap">';
        h+='<button class="reply-toggle-btn" data-action="toggle-replies" data-idx="'+index+'">共 '+item.replies.length+' 条回复 <span class="arrow">▼</span></button>';
        h+='</div>';
        h+='<div class="replies-container" data-idx="'+index+'"></div>';
      }
    }
    h+='</div>';
    return h;
  }
  function getST(item){var p=[item.videoTitle||'',item.author&&item.author.name||'',item.author&&item.author.content||'',item.author&&item.author.note||'',item.parentInfo&&item.parentInfo.name||'',item.parentInfo&&item.parentInfo.content||''];(item.replies||[]).forEach(function(r){p.push(r.name||'');p.push(r.content||'');p.push(r.note||'');});return p.join(' ').toLowerCase();}
  function render(){
    var q=(document.getElementById('search-box').value||'').toLowerCase().trim();
    var listEl = document.getElementById('list');
    var html='';var v=0;
    DATA.forEach(function(item,index){
      if(q&&getST(item).indexOf(q)===-1)return;
      v++;html+=renderCard(item,index);
    });
    listEl.innerHTML = v===0 ? '<p class="empty">没有匹配的记录。</p>' : html;
    Object.keys(replyState).forEach(function(idx){
      var st = replyState[idx];
      if(!st || !st.open) return;
      var card = listEl.querySelector('.replies-container[data-idx="'+idx+'"]');
      var btn = listEl.querySelector('.reply-toggle-btn[data-idx="'+idx+'"]');
      if(card && DATA[idx] && DATA[idx].replies){
        card.classList.add('open');
        if(btn) btn.classList.add('open');
        renderRepliesPage(card, DATA[idx].replies, st.page, DATA[idx].videoUrl);
      }
    });
  }
  document.getElementById('search-box').addEventListener('input', render);
  document.addEventListener('click', function(e){
    var tb = e.target.closest && e.target.closest('[data-action="toggle-replies"]');
    if(tb){
      e.preventDefault();
      var idx = parseInt(tb.getAttribute('data-idx'), 10);
      var container = document.querySelector('.replies-container[data-idx="'+idx+'"]');
      if(!container || !DATA[idx] || !DATA[idx].replies) return;
      var st = replyState[idx] || (replyState[idx] = { open:false, page:1 });
      st.open = !st.open;
      if(st.open){
        container.classList.add('open');
        tb.classList.add('open');
        renderRepliesPage(container, DATA[idx].replies, st.page, DATA[idx].videoUrl);
      } else {
        container.classList.remove('open');
        tb.classList.remove('open');
      }
      return;
    }
    var pb = e.target.closest && e.target.closest('.page-btn');
    if(pb && !pb.disabled){
      e.preventDefault();
      var container = pb.closest('.replies-container');
      if(!container) return;
      var idx = parseInt(container.getAttribute('data-idx'), 10);
      var page = parseInt(pb.getAttribute('data-page'), 10);
      var st = replyState[idx] || (replyState[idx] = { open:true, page:1 });
      st.page = page;
      renderRepliesPage(container, DATA[idx].replies, page, DATA[idx].videoUrl);
      container.scrollIntoView({behavior:'smooth', block:'nearest'});
      return;
    }
  });

  // ===== 灯箱 =====
  var lb = document.getElementById('lightbox');
  var lbImg = document.getElementById('lightbox-img');
  var lh = document.getElementById('loading-hint');
  var lbStage = document.getElementById('lightbox-stage');
  var lbPrevBtn = document.getElementById('lb-prev');
  var lbNextBtn = document.getElementById('lb-next');
  var lbCounter = document.getElementById('lb-counter');

  var lbImages = [];
  var lbIndex = 0;
  var lbDragging = false;
  var lbDragStart = null;
  var lbMouseDownPos = null;

  function getOrig(u){return u?u.replace(/@[^/]*$/,''):'';}

  function showLightboxImage(){
    if(!lbImages.length) return;
    var src = lbImages[lbIndex];
    var original = getOrig(src);

    if(lbPrevBtn) lbPrevBtn.disabled = (lbIndex <= 0);
    if(lbNextBtn) lbNextBtn.disabled = (lbIndex >= lbImages.length - 1);
    if(lbCounter) lbCounter.textContent = lbImages.length > 1 ? (lbIndex + 1) + ' / ' + lbImages.length : '';

    if(lbStage) lbStage.classList.remove('long-image');
    lb.scrollTop = 0;
    lb.scrollLeft = 0;
    lh.style.display = 'block';
    lbImg.style.opacity = '0.3';
    lbImg.src = '';
    lbImg.style.width = '';
    lbImg.style.height = '';

    var img = new Image();
    img.onload = function(){
      lbImg.src = original;
      lbImg.style.opacity = '1';
      lh.style.display = 'none';
      setTimeout(function(){ applyImageSize(img); }, 20);
    };
    img.onerror = function(){
      lbImg.src = src;
      lbImg.style.opacity = '1';
      lh.style.display = 'none';
      setTimeout(function(){
        var fake = { naturalWidth: lbImg.naturalWidth, naturalHeight: lbImg.naturalHeight };
        applyImageSize(fake);
      }, 20);
    };
    img.src = original;
  }

  function applyImageSize(loaded){
    if(!lbStage || !lbImg) return;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var padding = 80;
    var nw = loaded.naturalWidth || lbImg.naturalWidth;
    var nh = loaded.naturalHeight || lbImg.naturalHeight;
    if(!nw || !nh) return;

    var ratio = nh / nw;

    if(ratio > LONG_RATIO){
      var w = nw;
      var h = nh;
      if(w > vw - padding){
        var scale = (vw - padding) / w;
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      lbImg.style.width = w + 'px';
      lbImg.style.height = h + 'px';
      lbStage.classList.add('long-image');
    } else {
      var scale2 = Math.min((vw - padding) / nw, (vh - padding) / nh, 1);
      lbImg.style.width = Math.round(nw * scale2) + 'px';
      lbImg.style.height = Math.round(nh * scale2) + 'px';
      lbStage.classList.remove('long-image');
    }

    lb.scrollTop = 0;
    lb.scrollLeft = 0;
  }

  function openLB(images, idx){
    lbImages = images || [];
    lbIndex = idx || 0;
    lb.classList.add('active');
    document.body.style.overflow = 'hidden';
    showLightboxImage();
  }

  function closeLB(){
    lb.classList.remove('active');
    lbImg.src = '';
    lbImg.style.width = '';
    lbImg.style.height = '';
    document.body.style.overflow = '';
    lh.style.display = 'none';
    lbImages = [];
    lbIndex = 0;
    lbDragging = false;
    lbMouseDownPos = null;
  }

  function lbPrev(){ if(lbIndex > 0){ lbIndex--; showLightboxImage(); } }
  function lbNext(){ if(lbIndex < lbImages.length - 1){ lbIndex++; showLightboxImage(); } }

  document.addEventListener('click', function(e){
    var z = e.target.closest && e.target.closest('img.zoomable');
    if(!z) return;
    e.preventDefault();
    e.stopPropagation();
    var wrap = z.closest('.images');
    var images = [];
    if(wrap){
      images = Array.prototype.slice.call(wrap.querySelectorAll('img.zoomable')).map(function(im){ return im.src; });
    }
    if(!images.length) images = [z.src];
    var idx = images.indexOf(z.src);
    if(idx < 0) idx = 0;
    openLB(images, idx);
  });

  lb.addEventListener('mousedown', function(e){
    if(e.button !== 0) return;
    lbMouseDownPos = { x: e.clientX, y: e.clientY };
    if(!lbStage.classList.contains('long-image')) return;
    if(e.target !== lbImg) return;
    lbDragging = true;
    lbDragStart = { x: e.clientX, y: e.clientY, sl: lb.scrollLeft, st: lb.scrollTop };
    e.preventDefault();
  });

  document.addEventListener('mousemove', function(e){
    if(!lbDragging) return;
    lb.scrollLeft = lbDragStart.sl - (e.clientX - lbDragStart.x);
    lb.scrollTop = lbDragStart.st - (e.clientY - lbDragStart.y);
  });

  document.addEventListener('mouseup', function(){
    lbDragging = false;
  });

  lb.addEventListener('click', function(e){
    if(e.target.closest && e.target.closest('.lb-nav')) return;
    if(lbMouseDownPos){
      var dx = Math.abs(e.clientX - lbMouseDownPos.x);
      var dy = Math.abs(e.clientY - lbMouseDownPos.y);
      lbMouseDownPos = null;
      if(dx > 5 || dy > 5) return;
    }
    closeLB();
  });

  if(lbPrevBtn) lbPrevBtn.addEventListener('click', function(e){ e.stopPropagation(); lbPrev(); });
  if(lbNextBtn) lbNextBtn.addEventListener('click', function(e){ e.stopPropagation(); lbNext(); });

  document.addEventListener('keydown', function(e){
    if(!lb.classList.contains('active')) return;
    if(e.key === 'Escape') closeLB();
    else if(e.key === 'ArrowLeft') lbPrev();
    else if(e.key === 'ArrowRight') lbNext();
    else if(e.key === 'ArrowUp'){ lb.scrollTop -= 100; e.preventDefault(); }
    else if(e.key === 'ArrowDown'){ lb.scrollTop += 100; e.preventDefault(); }
  });

  window.addEventListener('resize', function(){
    if(!lb.classList.contains('active')) return;
    if(lbImg.naturalWidth && lbImg.naturalHeight){
      applyImageSize({ naturalWidth: lbImg.naturalWidth, naturalHeight: lbImg.naturalHeight });
    }
  });

  render();
})();
</script>
</body>
</html>`;
}

// ==================== 导出按钮 ====================
document.getElementById('btn-export-html').addEventListener('click', () => {
    if (DATA.length === 0) { alert('还没有收藏任何评论。'); return; }
    const html = buildExportHtml();
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'B站评论收藏_' + new Date().toISOString().slice(0, 10) + '.html';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
});

document.getElementById('btn-export-md').addEventListener('click', () => {
    if (DATA.length === 0) { alert('还没有收藏任何评论。'); return; }
    let md = `# B站评论收藏\n\n导出时间：${new Date().toLocaleString('zh-CN')}\n\n---\n\n`;
    const renderAuthorMd = (a, videoUrl) => {
        let s = `- **发言人**：${a.name || '未知'}\n`;
        if (a.spaceUrl) s += `- **主页**：${a.spaceUrl}\n`;
        if (a.time) s += `- **发言时间**：${a.time}\n`;
        if (a.likeCount) s += `- **点赞数**：${a.likeCount}\n`;
        const ju = buildJumpUrl(videoUrl || '', a);
        if (ju) s += `- **原评论**：[跳转](${ju})\n`;
        return s;
    };
    DATA.forEach((item, i) => {
        md += `## ${i + 1}. ${item.videoTitle}\n\n- **视频链接**：${item.videoUrl}\n- **收藏时间**：${item.savedAt}\n\n`;
        if (item.type === 'reply_only') {
            if (item.parentInfo) md += `### 回复上下文\n\n- **原评论者**：${item.parentInfo.name || '未知'}\n\n> ${(item.parentInfo.content || '').replace(/\n/g, '\n> ')}\n\n`;
            md += `### 收藏的回复\n\n` + renderAuthorMd(item.author, item.videoUrl) + `\n`;
            if (item.author.content) md += `> ${item.author.content.replace(/\n/g, '\n> ')}\n\n`;
            (item.author.images || []).forEach(img => { md += `![图片](${img})\n\n`; });
            if (item.author.note) md += `**我的点评**：${item.author.note}\n\n`;
        } else {
            md += `### 主评论\n\n` + renderAuthorMd(item.author, item.videoUrl) + `\n`;
            if (item.author.content) md += `> ${item.author.content.replace(/\n/g, '\n> ')}\n\n`;
            (item.author.images || []).forEach(img => { md += `![图片](${img})\n\n`; });
            if (item.author.note) md += `**我的点评**：${item.author.note}\n\n`;
            if (item.replies && item.replies.length) {
                md += `### 回复（${item.replies.length} 条）\n\n`;
                item.replies.forEach((r, j) => {
                    md += `**回复 ${j + 1}**\n\n` + renderAuthorMd(r, item.videoUrl) + `\n`;
                    if (r.content) md += `> ${r.content.replace(/\n/g, '\n> ')}\n\n`;
                    (r.images || []).forEach(img => { md += `![图片](${img})\n\n`; });
                    if (r.note) md += `**我的点评**：${r.note}\n\n`;
                });
            }
        }
        md += `---\n\n`;
    });
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'B站评论收藏_' + new Date().toISOString().slice(0, 10) + '.md';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
});

// ==================== 初始化 ====================
loadData(() => {
    normalizeData();
    render();
    tryRestoreHandle();
});