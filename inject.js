// inject.js —— v1.2 · 注入页面主世界，读取评论接口的精确时间与楼层关系
(function() {
    'use strict';

    const API_MATCH = 'api.bilibili.com/x/v2/reply';
    const sentRpids = new Set();
    const queue = [];

    function getOidFromUrl(url) {
        if (!url) return '';
        const m = String(url).match(/[?&]oid=(\d+)/);
        return m ? m[1] : '';
    }

    function extractFromJson(json, oidFromUrl) {
        if (!json || typeof json !== 'object') return;
        const data = json.data || json;
        const oid = data.oid || oidFromUrl || '';

        function handleList(list) {
            if (!Array.isArray(list)) return;
            list.forEach(r => {
                if (!r) return;
                if (r.rpid && r.ctime) {
                    const msg = (r.content && r.content.message) || '';
                    const key = String(r.rpid);
                    if (!sentRpids.has(key)) {
                        sentRpids.add(key);
                        queue.push({
                            rpid: key,
                            ctime: r.ctime,
                            message: msg,
                            oid: oid,
                            root: r.root || 0,
                            parent: r.parent || 0
                        });
                    }
                }
                if (r.replies && Array.isArray(r.replies)) {
                    handleList(r.replies);
                }
            });
        }

        if (Array.isArray(data.replies)) handleList(data.replies);
        if (Array.isArray(data.top_replies)) handleList(data.top_replies);
        if (Array.isArray(data.top)) handleList(data.top);
        if (Array.isArray(data.hots)) handleList(data.hots);

        flush();
    }

    function flush() {
        if (queue.length === 0) return;
        const payload = queue.splice(0, queue.length);
        window.postMessage({
            source: 'bili-saver-inject',
            type: 'comment-ctime-batch',
            data: payload
        }, '*');
    }

    function parseAndExtract(text, url) {
        if (!text) return;
        try {
            const json = JSON.parse(text);
            extractFromJson(json, getOidFromUrl(url));
        } catch (e) {}
    }

    const origFetch = window.fetch;
    if (origFetch) {
        window.fetch = function() {
            const args = arguments;
            let url = '';
            try {
                if (typeof args[0] === 'string') url = args[0];
                else if (args[0] && args[0].url) url = args[0].url;
            } catch (e) {}

            const promise = origFetch.apply(this, args);
            if (url && url.indexOf(API_MATCH) !== -1) {
                promise.then(resp => {
                    try {
                        resp.clone().text().then(t => parseAndExtract(t, url)).catch(()=>{});
                    } catch (e) {}
                }).catch(()=>{});
            }
            return promise;
        };
    }

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
        this.__biliSaverUrl = url || '';
        return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
        this.addEventListener('load', function() {
            try {
                const url = this.__biliSaverUrl || '';
                if (url.indexOf(API_MATCH) !== -1) {
                    parseAndExtract(this.responseText, url);
                }
            } catch (e) {}
        });
        return origSend.apply(this, arguments);
    };

    console.log('%c[B站评论收藏] inject.js v1.2 已注入', 'color:#00aeec;');
})();