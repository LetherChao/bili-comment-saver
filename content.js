// content.js —— v1.2 · 在 B 站视频页注入收藏按钮，采集评论数据
(function() {
    'use strict';
    const STORAGE_KEY = 'bili_saved_comments';

    function injectMainWorldScript() {
        try {
            const script = document.createElement('script');
            script.src = chrome.runtime.getURL('inject.js');
            script.onload = () => script.remove();
            (document.head || document.documentElement).appendChild(script);
        } catch (e) {
            console.warn('[B站评论收藏] inject.js 注入失败', e);
        }
    }
    injectMainWorldScript();

    const ctimeMap = new Map();
    const rpidMap = new Map();
    const rootMap = new Map();
    const parentMap = new Map();
    let currentOid = '';

    function normalizeCommentText(t) {
        if (!t) return '';
        return String(t)
            .replace(/\[.*?\]/g, '')
            .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '')
            .replace(/\s+/g, '')
            .trim()
            .toLowerCase();
    }

    window.addEventListener('message', (e) => {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.source !== 'bili-saver-inject' || d.type !== 'comment-ctime-batch') return;
        let added = 0;
        (d.data || []).forEach(item => {
            if (!item) return;
            const key = normalizeCommentText(item.message);
            if (key && item.ctime) {
                if (!ctimeMap.has(key)) added++;
                ctimeMap.set(key, item.ctime);
                if (item.rpid) rpidMap.set(key, String(item.rpid));
                if (item.root) rootMap.set(key, String(item.root));
                if (item.parent) parentMap.set(key, String(item.parent));
            }
            if (item.oid) currentOid = item.oid;
        });
        if (added > 0) console.log('[B站评论收藏] 新增缓存', added, '条, oid=', currentOid);
    });

    function tsToStr(ts) {
        const d = new Date(ts * 1000);
        const p = n => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate())
             + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    function getVideoTitle() {
        const el = document.querySelector('h1.video-title') || document.querySelector('[class*="video-title"]');
        return el ? el.innerText.trim() : document.title;
    }
    function getVideoUrl() { return window.location.href.split('?')[0]; }

    // ============ 扩展是否可用检测 ============
    function isExtensionAlive() {
        try {
            return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
        } catch (e) {
            return false;
        }
    }

    // ============ 保存评论（加固版） ============
    function saveComment(record, cb) {
        if (!isExtensionAlive()) {
            console.warn('[B站评论收藏] 扩展已更新或重载，请刷新页面后再收藏');
            if (cb) cb(false, 'ext-invalidated');
            return;
        }
        try {
            chrome.storage.local.get([STORAGE_KEY], (result) => {
                if (chrome.runtime.lastError) {
                    console.warn('[B站评论收藏]', chrome.runtime.lastError.message);
                    if (cb) cb(false, 'storage-error');
                    return;
                }
                const list = result[STORAGE_KEY] ? JSON.parse(result[STORAGE_KEY]) : [];
                list.push(record);
                chrome.storage.local.set({ [STORAGE_KEY]: JSON.stringify(list) }, () => {
                    if (chrome.runtime.lastError) {
                        console.warn('[B站评论收藏]', chrome.runtime.lastError.message);
                        if (cb) cb(false, 'storage-error');
                        return;
                    }
                    if (cb) cb(true);
                });
            });
        } catch (e) {
            console.warn('[B站评论收藏] 保存失败', e);
            if (cb) cb(false, 'exception');
        }
    }

    function normalizeUrl(url) {
        if (!url) return '';
        if (url.startsWith('//')) return 'https:' + url;
        if (url.startsWith('http://')) return 'https://' + url.slice(7);
        return url;
    }

    function looksLikeTime(text) {
        if (!text) return false;
        const t = text.trim();
        if (t.length > 25) return false;
        return /^\d{4}-\d{1,2}-\d{1,2}/.test(t)
            || /^\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}/.test(t)
            || /^\d{1,2}:\d{2}/.test(t)
            || /^\d+[天小时分秒]前/.test(t)
            || /^刚刚$/.test(t)
            || /^昨天/.test(t)
            || /^\d{1,2}月\d{1,2}日/.test(t);
    }

    function resolveTime(text) {
        if (!text) return '';
        const t = text.trim();
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const fmt = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
                       + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());

        if (/^\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}/.test(t)) return t;
        if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) return t;
        if (/^刚刚$/.test(t)) return fmt(now);
        let m;
        m = t.match(/^(\d+)\s*秒前/); if (m) return fmt(new Date(now.getTime() - parseInt(m[1], 10) * 1000));
        m = t.match(/^(\d+)\s*分钟前/); if (m) return fmt(new Date(now.getTime() - parseInt(m[1], 10) * 60 * 1000));
        m = t.match(/^(\d+)\s*小时前/); if (m) return fmt(new Date(now.getTime() - parseInt(m[1], 10) * 3600 * 1000));
        m = t.match(/^(\d+)\s*天前/); if (m) return fmt(new Date(now.getTime() - parseInt(m[1], 10) * 86400 * 1000));
        if (/^昨天/.test(t)) {
            const d = new Date(now.getTime() - 86400 * 1000);
            const tm = t.match(/昨天\s*(\d{1,2}):(\d{2})/);
            if (tm) d.setHours(parseInt(tm[1], 10), parseInt(tm[2], 10));
            return fmt(d);
        }
        if (/^前天/.test(t)) {
            const d = new Date(now.getTime() - 2 * 86400 * 1000);
            const tm = t.match(/前天\s*(\d{1,2}):(\d{2})/);
            if (tm) d.setHours(parseInt(tm[1], 10), parseInt(tm[2], 10));
            return fmt(d);
        }
        m = t.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
        if (m) return now.getFullYear() + '-' + pad(m[1]) + '-' + pad(m[2]) + ' ' + pad(m[3]) + ':' + m[4] + ':00';
        m = t.match(/^(\d{1,2})-(\d{1,2})$/);
        if (m) return now.getFullYear() + '-' + pad(m[1]) + '-' + pad(m[2]);
        m = t.match(/^(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
        if (m) return now.getFullYear() + '-' + pad(m[1]) + '-' + pad(m[2]) + ' ' + pad(m[3]) + ':' + m[4] + ':00';
        m = t.match(/^(\d{1,2})月(\d{1,2})日/);
        if (m) return now.getFullYear() + '-' + pad(m[1]) + '-' + pad(m[2]);
        m = t.match(/^(\d{1,2}):(\d{2})$/);
        if (m) return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
                   + ' ' + pad(m[1]) + ':' + m[2] + ':00';
        return t;
    }

    function findTimeText(root) {
        if (!root) return '';
        let raw = '';
        const action = root.querySelector && root.querySelector('bili-comment-action-buttons-renderer');
        if (action && action.shadowRoot) {
            const pd = action.shadowRoot.querySelector('#pubdate');
            if (pd) {
                const title = pd.getAttribute('title');
                if (title) raw = title.trim();
                if (!raw) raw = (pd.textContent || '').trim();
            }
        }
        if (!raw) {
            function findPubdate(node) {
                if (!node) return null;
                const found = node.querySelector && node.querySelector('#pubdate');
                if (found) return found;
                const all = node.querySelectorAll ? node.querySelectorAll('*') : [];
                for (const el of all) {
                    if (el.shadowRoot) {
                        const r = findPubdate(el.shadowRoot);
                        if (r) return r;
                    }
                }
                return null;
            }
            const pd2 = findPubdate(root);
            if (pd2) {
                const title = pd2.getAttribute('title');
                if (title) raw = title.trim();
                if (!raw) raw = (pd2.textContent || '').trim();
            }
        }
        if (!raw) {
            let found = '';
            const walk = (node) => {
                if (found) return;
                const children = node.children || [];
                for (const el of children) {
                    if (el.classList && el.classList.contains('bili-save-btn-wrap')) continue;
                    const txt = (el.textContent || '').trim();
                    if (looksLikeTime(txt)) { found = txt; return; }
                    if (el.shadowRoot) walk(el.shadowRoot);
                    walk(el);
                    if (found) return;
                }
            };
            walk(root);
            raw = found;
        }
        return raw;
    }

    function findLikeCount(renderer) {
        if (!renderer) return '';
        const action = renderer.querySelector('bili-comment-action-buttons-renderer');
        if (!action) return '';
        const root = action.shadowRoot || action;
        const likeEl = root.querySelector('#like #count');
        if (likeEl) {
            const t = likeEl.textContent.trim();
            if (t) return t;
        }
        const all = root.querySelectorAll('*');
        for (const el of all) {
            const cls = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
            const id = (el.id || '').toLowerCase();
            if (cls.indexOf('like') !== -1 || id.indexOf('like') !== -1) {
                const txt = el.textContent.trim();
                const m = txt.match(/(\d+(?:\.\d+)?[万wW]?)/);
                if (m && m[1]) return m[1];
            }
        }
        for (const el of all) {
            if (el.children.length > 0) continue;
            const t = (el.textContent || '').trim();
            if (/^\d{1,8}$/.test(t)) return t;
            if (/^\d+(?:\.\d+)?[万wW]$/.test(t)) return t;
        }
        return '';
    }

    function extractRichText(richTextEl) {
        const out = { text: '', images: [] };
        if (!richTextEl) return out;
        const root = richTextEl.shadowRoot || richTextEl;
        const contents = root.querySelector('#contents') || root;
        contents.querySelectorAll('img').forEach(img => {
            let src = img.getAttribute('src') || img.src || '';
            if (src && !src.startsWith('data:')) out.images.push(normalizeUrl(src));
        });
        const clone = contents.cloneNode(true);
        clone.querySelectorAll('style, script, link').forEach(n => n.remove());
        clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
        out.text = (clone.innerText || clone.textContent || '').trim();
        return out;
    }

    function extractPictures(renderer) {
        const imgs = [];
        const picRenderer = renderer.querySelector('bili-comment-pictures-renderer');
        if (picRenderer) {
            const root = picRenderer.shadowRoot || picRenderer;
            root.querySelectorAll('img').forEach(img => {
                let src = img.getAttribute('src') || img.src || '';
                if (src && !src.startsWith('data:')) imgs.push(normalizeUrl(src));
            });
        }
        return imgs;
    }

    function extractAvatarUrl(el) {
        if (!el) return '';
        function tryBiliAvatar(ba) {
            if (!ba) return '';
            if (ba.shadowRoot) {
                const img = ba.shadowRoot.querySelector('img');
                if (img) {
                    const src = img.getAttribute('src') || img.src || '';
                    if (src && !src.startsWith('data:')) return normalizeUrl(src);
                }
            }
            const img = ba.querySelector && ba.querySelector('img');
            if (img) {
                const src = img.getAttribute('src') || img.src || '';
                if (src && !src.startsWith('data:')) return normalizeUrl(src);
            }
            const attrs = ['src', 'data-src', 'data-avatar'];
            for (const a of attrs) {
                const v = ba.getAttribute && ba.getAttribute(a);
                if (v && !v.startsWith('data:')) return normalizeUrl(v);
            }
            return '';
        }
        if (el.tagName === 'BILI-AVATAR') return tryBiliAvatar(el);
        const ba = el.querySelector && el.querySelector('bili-avatar');
        if (ba) { const u = tryBiliAvatar(ba); if (u) return u; }
        if (el.tagName === 'IMG') {
            const src = el.getAttribute('src') || el.src || '';
            if (src && !src.startsWith('data:')) return normalizeUrl(src);
        }
        const img = el.querySelector && el.querySelector('img');
        if (img) {
            const src = img.getAttribute('src') || img.src || '';
            if (src && !src.startsWith('data:')) return normalizeUrl(src);
        }
        if (el.style && el.style.backgroundImage) {
            const m = el.style.backgroundImage.match(/url\(["']?(.+?)["']?\)/);
            if (m && m[1]) return normalizeUrl(m[1]);
        }
        return '';
    }

    function extractFromRenderer(renderer) {
        const result = { name: '', avatar: '', spaceUrl: '', time: '', content: '', images: [], likeCount: '', rpid: '', root: '', parent: '' };
        if (!renderer || !renderer.shadowRoot) return result;
        const s = renderer.shadowRoot;

        const userInfo = s.querySelector('bili-comment-user-info');
        if (userInfo && userInfo.shadowRoot) {
            const us = userInfo.shadowRoot;
            const nameEl = us.querySelector('#user-name, .user-name, [class*="user-name"]');
            if (nameEl) result.name = nameEl.textContent.trim();
            const linkEl = us.querySelector('a[href*="space.bilibili"], a[href*="//space"]');
            if (linkEl) {
                const href = linkEl.getAttribute('href') || linkEl.href || '';
                if (href) result.spaceUrl = normalizeUrl(href);
            }
        }

        const avatarEl = s.querySelector('#user-avatar, a[href*="space.bilibili"], bili-avatar');
        if (avatarEl) {
            if (!result.spaceUrl) {
                const href = avatarEl.getAttribute('href') || avatarEl.href || '';
                if (href && href.indexOf('space') !== -1) result.spaceUrl = normalizeUrl(href);
            }
            result.avatar = extractAvatarUrl(avatarEl);
        }

        const richText = s.querySelector('bili-rich-text');
        const rt = extractRichText(richText);
        result.content = rt.text;
        result.images = rt.images;
        extractPictures(s).forEach(src => {
            if (!result.images.includes(src)) result.images.push(src);
        });

        const norm = normalizeCommentText(result.content);
        if (norm && ctimeMap.has(norm)) {
            result.time = tsToStr(ctimeMap.get(norm));
            if (rpidMap.has(norm)) result.rpid = rpidMap.get(norm);
            if (rootMap.has(norm)) result.root = rootMap.get(norm);
            if (parentMap.has(norm)) result.parent = parentMap.get(norm);
        } else {
            const raw = findTimeText(s);
            result.time = resolveTime(raw);
        }

        result.likeCount = findLikeCount(s);
        return result;
    }

    function makeButton(text, onClick, inline) {
        const btn = document.createElement('button');
        btn.textContent = text;
        if (inline) {
            btn.style.cssText = 'padding:0 4px;margin:0 0 0 4px;font-size:13px;line-height:1.6;cursor:pointer;background:transparent;color:#61666d;border:none;white-space:nowrap;vertical-align:middle;font-family:inherit;outline:none;';
            btn.onmouseenter = () => { if (!btn.disabled) btn.style.color = '#00aeec'; };
            btn.onmouseleave = () => { if (!btn.disabled) btn.style.color = '#61666d'; };
        } else {
            btn.style.cssText = 'padding:4px 12px;font-size:12px;cursor:pointer;background:#00aeec;color:#fff;border:none;border-radius:4px;';
            btn.onmouseenter = () => { btn.style.background = '#0098d1'; };
            btn.onmouseleave = () => { btn.style.background = '#00aeec'; };
        }
        btn.onclick = (e) => { e.stopPropagation(); e.preventDefault(); onClick(btn); };
        return btn;
    }

    // ============ flashBtn 支持失败提示 ============
    function flashBtn(btn, ok) {
        const orig = btn.getAttribute('data-orig') || btn.textContent;
        const origColor = btn.style.color;
        btn.setAttribute('data-orig', orig);

        if (ok === false) {
            // 失败：显示"请刷新页面"，红色
            btn.textContent = '请刷新页面';
            btn.style.color = '#f56c6c';
            btn.disabled = true;
            setTimeout(() => {
                btn.textContent = orig;
                btn.style.color = origColor;
                btn.disabled = false;
            }, 3000);
            return;
        }

        // 成功
        btn.textContent = '已收藏 ✓';
        btn.style.color = '#1aad5b';
        btn.disabled = true;
        setTimeout(() => {
            btn.textContent = orig;
            btn.style.color = origColor;
            btn.disabled = false;
        }, 1500);
    }

    function collectReplies(threadShadow) {
        const replies = [];
        const rr = threadShadow.querySelector('bili-comment-replies-renderer');
        if (!rr || !rr.shadowRoot) return replies;
        rr.shadowRoot.querySelectorAll('bili-comment-reply-renderer').forEach(r => {
            const d = extractFromRenderer(r);
            if (d.content || d.images.length) replies.push(d);
        });
        return replies;
    }

    function findTextElement(root, text) {
        if (!root) return null;
        const all = root.querySelectorAll('*');
        for (const el of all) {
            if (el.children.length > 0) continue;
            if ((el.textContent || '').trim() === text) return el;
        }
        for (const el of all) {
            if (el.shadowRoot) {
                const f = findTextElement(el.shadowRoot, text);
                if (f) return f;
            }
        }
        return null;
    }

    // ============ API 全量拉取回复 ============
    function apiReplyToRecord(r) {
        const content = (r.content && r.content.message) || '';
        const images = [];
        if (r.content && Array.isArray(r.content.pictures)) {
            r.content.pictures.forEach(p => {
                if (p && p.img_src) images.push(normalizeUrl(p.img_src));
            });
        }
        const member = r.member || {};
        return {
            name: member.uname || '未知',
            avatar: member.avatar ? normalizeUrl(member.avatar) : '',
            spaceUrl: member.mid ? ('https://space.bilibili.com/' + member.mid) : '',
            time: r.ctime ? tsToStr(r.ctime) : '',
            content: content,
            images: images,
            likeCount: (r.like !== undefined && r.like !== null) ? String(r.like) : '',
            rpid: r.rpid ? String(r.rpid) : '',
            root: r.root ? String(r.root) : '',
            parent: r.parent ? String(r.parent) : ''
        };
    }

    async function fetchAllReplies(rootRpid, oid) {
        const all = [];
        let pn = 1;
        const ps = 20;
        const maxPages = 200;
        while (pn <= maxPages) {
            const url = 'https://api.bilibili.com/x/v2/reply/reply?type=1&oid=' + encodeURIComponent(oid)
                      + '&root=' + encodeURIComponent(rootRpid)
                      + '&pn=' + pn + '&ps=' + ps + '&sort=2';
            let json;
            try {
                const resp = await fetch(url, { credentials: 'include' });
                json = await resp.json();
            } catch (e) {
                console.warn('[B站评论收藏] 拉取回复失败', e);
                break;
            }
            if (!json || json.code !== 0) break;
            const data = json.data || {};
            const replies = data.replies || [];
            replies.forEach(r => { all.push(apiReplyToRecord(r)); });
            const page = data.page || {};
            const total = page.count || 0;
            if (all.length >= total) break;
            if (replies.length < ps) break;
            pn++;
            await new Promise(r => setTimeout(r, 150));
        }
        return all;
    }

    function processThread(thread) {
        if (thread.__biliSaveProcessed) return;
        const shadow = thread.shadowRoot;
        if (!shadow) return;
        const mainRenderer = shadow.querySelector('bili-comment-renderer#comment')
                          || shadow.querySelector('bili-comment-renderer');
        if (!mainRenderer) return;
        const mShadow = mainRenderer.shadowRoot;
        if (!mShadow) return;
        const actionButtons = mShadow.querySelector('bili-comment-action-buttons-renderer');
        if (!actionButtons) return;

        const inject = () => {
            if (thread.__biliSaveProcessed) return true;
            const abRoot = actionButtons.shadowRoot;
            if (!abRoot) return false;

            const btnComment = makeButton('仅评论', (btn) => {
                const m = extractFromRenderer(mainRenderer);
                saveComment({
                    type: 'comment',
                    videoTitle: getVideoTitle(), videoUrl: getVideoUrl(),
                    savedAt: new Date().toLocaleString('zh-CN'),
                    author: m, replies: []
                }, (ok) => flashBtn(btn, ok));
            }, true);

            const btnWithReplies = makeButton('评论+回复', async (btn) => {
                const origText = '评论+回复';
                const origColor = btn.style.color;
                btn.setAttribute('data-orig', origText);
                btn.textContent = '拉取中…';
                btn.disabled = true;
                btn.style.color = '#f5a623';

                const m = extractFromRenderer(mainRenderer);
                let replies = collectReplies(shadow);
                const pageCount = replies.length;

                const key = normalizeCommentText(m.content);
                const rpid = rpidMap.get(key);
                if (rpid && currentOid) {
                    try {
                        const apiReplies = await fetchAllReplies(rpid, currentOid);
                        if (apiReplies && apiReplies.length > replies.length) {
                            replies = apiReplies;
                        }
                    } catch (e) {
                        console.warn('[B站评论收藏] 全量回复拉取失败，使用页面已有数据', e);
                    }
                } else {
                    console.log('[B站评论收藏] 未找到 rpid，无法拉取全量。当前页面抓到', pageCount, '条，内容片段：', m.content.slice(0, 30));
                }

                saveComment({
                    type: 'comment_with_replies',
                    videoTitle: getVideoTitle(), videoUrl: getVideoUrl(),
                    savedAt: new Date().toLocaleString('zh-CN'),
                    author: m, replies: replies
                }, (ok) => {
                    if (ok === false) {
                        btn.textContent = '请刷新页面';
                        btn.style.color = '#f56c6c';
                        setTimeout(() => {
                            btn.textContent = origText;
                            btn.style.color = origColor;
                            btn.disabled = false;
                        }, 3000);
                        return;
                    }
                    btn.textContent = '已收藏 ' + replies.length + ' 条';
                    btn.style.color = '#1aad5b';
                    setTimeout(() => {
                        btn.textContent = origText;
                        btn.style.color = origColor;
                        btn.disabled = false;
                    }, 2000);
                });
            }, true);

            const replyDiv = abRoot.querySelector('#reply');
            if (replyDiv) {
                replyDiv.appendChild(btnComment);
                replyDiv.appendChild(btnWithReplies);
                thread.__biliSaveProcessed = true;
                return true;
            }
            const replyBtn = findTextElement(abRoot, '回复');
            if (replyBtn && replyBtn.parentNode) {
                replyBtn.parentNode.insertBefore(btnComment, replyBtn.nextSibling);
                replyBtn.parentNode.insertBefore(btnWithReplies, btnComment.nextSibling);
                thread.__biliSaveProcessed = true;
                return true;
            }
            return false;
        };

        if (inject()) return;
        let tries = 0;
        const timer = setInterval(() => {
            tries++;
            if (inject() || tries > 10) clearInterval(timer);
        }, 1000);
    }

    function scanReplyButtons() {
        const biliComments = document.querySelector('bili-comments');
        if (!biliComments || !biliComments.shadowRoot) return;
        const feed = biliComments.shadowRoot.querySelector('#feed');
        if (!feed) return;

        feed.querySelectorAll('bili-comment-thread-renderer').forEach(thread => {
            const shadow = thread.shadowRoot;
            if (!shadow) return;
            const mainRenderer = shadow.querySelector('bili-comment-renderer#comment')
                              || shadow.querySelector('bili-comment-renderer');
            if (!mainRenderer) return;

            const rr = shadow.querySelector('bili-comment-replies-renderer');
            if (!rr || !rr.shadowRoot) return;

            rr.shadowRoot.querySelectorAll('bili-comment-reply-renderer').forEach(replyRenderer => {
                if (replyRenderer.__biliReplyBtnInjected) return;

                const btn = makeButton('收藏', (b) => {
                    const m = extractFromRenderer(mainRenderer);
                    const r = extractFromRenderer(replyRenderer);
                    saveComment({
                        type: 'reply_only',
                        videoTitle: getVideoTitle(), videoUrl: getVideoUrl(),
                        savedAt: new Date().toLocaleString('zh-CN'),
                        parentInfo: { name: m.name, content: (m.content || '').slice(0, 120) },
                        author: r, replies: []
                    }, (ok) => flashBtn(b, ok));
                }, true);

                const rShadow = replyRenderer.shadowRoot;
                if (!rShadow) {
                    replyRenderer.parentNode.insertBefore(btn, replyRenderer.nextSibling);
                    replyRenderer.__biliReplyBtnInjected = true;
                    return;
                }

                const actionButtons = rShadow.querySelector('bili-comment-action-buttons-renderer');
                const injectReply = () => {
                    if (replyRenderer.__biliReplyBtnInjected) return true;
                    if (!actionButtons) return false;
                    const abRoot = actionButtons.shadowRoot;
                    if (!abRoot) return false;
                    const replyDiv = abRoot.querySelector('#reply');
                    if (replyDiv) {
                        replyDiv.appendChild(btn);
                        replyRenderer.__biliReplyBtnInjected = true;
                        return true;
                    }
                    const replyBtn = findTextElement(abRoot, '回复');
                    if (replyBtn && replyBtn.parentNode) {
                        replyBtn.parentNode.insertBefore(btn, replyBtn.nextSibling);
                        replyRenderer.__biliReplyBtnInjected = true;
                        return true;
                    }
                    return false;
                };

                if (injectReply()) return;
                let tries = 0;
                const t2 = setInterval(() => {
                    tries++;
                    if (injectReply() || tries > 10) clearInterval(t2);
                }, 1000);
            });
        });
    }

    function scan() {
        const biliComments = document.querySelector('bili-comments');
        if (!biliComments || !biliComments.shadowRoot) return;
        const feed = biliComments.shadowRoot.querySelector('#feed');
        if (!feed) return;
        feed.querySelectorAll('bili-comment-thread-renderer').forEach(processThread);
    }

    function startScan() {
        setInterval(() => { scan(); scanReplyButtons(); }, 2000);
        setTimeout(() => { scan(); scanReplyButtons(); }, 1500);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startScan);
    } else {
        startScan();
    }

    console.log('%c[B站评论收藏] v1.2 已启动', 'color:#1aad5b;font-weight:bold;');
})();