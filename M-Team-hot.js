// ==UserScript==
// @name         M-Team 高级搜索助手
// @namespace    http://tampermonkey.net/
// @version      5.0.0
// @description  在高级搜索区添加「最近热度」和「X-Y年前热度」按钮，并提供独立样式；新增同片排重，按 DoVi/HDR10+ 优先级只保留一条
// @author       Cola.Kot
// @match        https://*.m-team.cc/browse*
// @grant        none
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

// 基于 Zola 的「M-Team 高级搜索助手」(GreasyFork #550786, MIT License) 修改而来
// @downloadURL / @updateURL 请不要手写，发布到 GreasyFork 后由平台自动生成

(function () {
'use strict';

const PARAMS = {
    SORT: 'sort',
    SORT_VALUE: 'seeders:descend',
    START_DATE: 'uploadDateStart',
    END_DATE: 'uploadDateEnd'
};

// --- 注入独立样式，去除跟随系统的暗色模式，强制深色字体 ---
function injectStyles() {
    if (document.getElementById('mt-custom-styles')) return;
    const style = document.createElement('style');
    style.id = 'mt-custom-styles';
    style.textContent = `
        .mt-custom-btn {
            background: #ffffff !important;
            border: 1px solid #d9d9d9 !important;
            color: #333333 !important; /* 强制深灰/黑色字体，避免白底白字 */
            padding: 4px 15px;
            font-size: 14px;
            border-radius: 6px;
            cursor: pointer;
            margin: 4px;
            transition: all 0.3s cubic-bezier(0.645, 0.045, 0.355, 1);
            line-height: 1.5715;
            box-shadow: 0 2px 0 rgba(0, 0, 0, 0.015);
        }
        .mt-custom-btn:hover {
            color: #177ddc !important; /* 鼠标悬浮变蓝 */
            border-color: #177ddc !important;
        }
        .mt-custom-btn.mt-active {
            color: #177ddc !important;
            border-color: #177ddc !important;
            background: #f0f7ff !important;
        }
        .mt-custom-wrap {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 4px;
        }
    `;
    document.head.appendChild(style);
}

function waitForElement(selector) {
    return new Promise((resolve) => {
        const hit = document.querySelector(selector);
        if (hit) return resolve(hit);
        const mo = new MutationObserver(() => {
            const el = document.querySelector(selector);
            if (el) {
                mo.disconnect();
                resolve(el);
            }
        });
        mo.observe(document.body, { childList: true, subtree: true });
    });
}

function createDateSortButton(text, amount, unit) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.className = 'mt-custom-btn';
    btn.addEventListener('click', () => {
        const today = new Date();
        const past = new Date(today);

        switch (unit) {
            case 'days':
                past.setDate(today.getDate() - amount);
                break;
            case 'months':
                past.setMonth(today.getMonth() - amount);
                break;
            case 'years':
                past.setFullYear(today.getFullYear() - amount);
                break;
        }

        const start = Math.floor(past.getTime() / 1000);
        const end = Math.floor(today.getTime() / 1000);

        const url = new URL(location.href);
        const sp = url.searchParams;
        sp.set(PARAMS.SORT, PARAMS.SORT_VALUE);
        sp.set(PARAMS.START_DATE, String(start));
        sp.set(PARAMS.END_DATE, String(end));
        sp.set('pageNumber', '1');
        location.href = url.toString();
    });
    return btn;
}

function createYearRangeSortButton(text, startYearsAgo, endYearsAgo) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.className = 'mt-custom-btn';
    btn.addEventListener('click', () => {
        const today = new Date();
        const rangeEnd = new Date(today);
        const rangeStart = new Date(today);

        rangeEnd.setFullYear(today.getFullYear() - startYearsAgo);
        rangeStart.setFullYear(today.getFullYear() - endYearsAgo);

        const start = Math.floor(rangeStart.getTime() / 1000);
        const end = Math.floor(rangeEnd.getTime() / 1000);

        const url = new URL(location.href);
        const sp = url.searchParams;
        sp.set(PARAMS.SORT, PARAMS.SORT_VALUE);
        sp.set(PARAMS.START_DATE, String(start));
        sp.set(PARAMS.END_DATE, String(end));
        sp.set('pageNumber', '1');
        location.href = url.toString();
    });
    return btn;
}

function createSortOnlyButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '全部热度';
    btn.className = 'mt-custom-btn';
    btn.addEventListener('click', () => {
        const url = new URL(location.href);
        const sp = url.searchParams;
        sp.set(PARAMS.SORT, PARAMS.SORT_VALUE);
        sp.delete(PARAMS.START_DATE);
        sp.delete(PARAMS.END_DATE);
        sp.set('pageNumber', '1');
        location.href = url.toString();
    });
    return btn;
}

function createClearAllButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '取消排名';
    btn.className = 'mt-custom-btn';
    btn.addEventListener('click', () => {
        const url = new URL(location.href);
        const sp = url.searchParams;
        sp.delete(PARAMS.SORT);
        sp.delete(PARAMS.START_DATE);
        sp.delete(PARAMS.END_DATE);
        sp.set('pageNumber', '1');
        location.href = url.toString();
    });
    return btn;
}

/* ============================ 同片排重 ============================ */
/* 同一部片子的多个版本（仅画质标记不同）只保留一条，优先级：
   DoVi+HDR10+ > DoVi+HDR10 > 仅DoVi > 仅HDR10+ > 仅HDR10 > 都没有 */
const DEDUP = {
    STORAGE_KEY: 'mt_dedup_enabled',
    MERGE_ACROSS_RESOLUTION: false, // true = 同一影片的不同分辨率也只保留一条
    RE_DOVI: /\bdovi\b|\bdolby\s*vision\b|\bdv\b/i,
    RE_HDR10PLUS: /\bhdr10\s*\+|\bhdr10plus\b|\bhdr10\s*plus\b/i,
    RE_HDR10: /\bhdr10\b(?!\s*\+)|\bhdr\b(?!\d)/i,
    RE_RES: /\b(4320p|2160p|1080p|1080i|720p|576p|480p|4k|uhd)\b/i,
    // 计算分组 key 时统一剔除的标记，保证只有画质不同的版本归为一组
    STRIP: [
        /\bdolby\s*vision\b/gi,
        /\bdovi\b/gi,
        /\bdv\b/gi,
        /\bhdr10\s*\+/gi,
        /\bhdr10\s*plus\b/gi,
        /\bhdr10plus\b/gi,
        /\bhdr10\b/gi,
        /\bhdr\b/gi,
        /\bhlg\b/gi,
        /\bsdr\b/gi
    ],
    STRIP_RES: [/\b(4320p|2160p|1080p|1080i|720p|576p|480p|4k|uhd)\b/gi],
    SKIP_SELECTOR: 'aside, [class*="sidebar" i], [class*="recommend" i], [class*="hot-list" i], [class*="toplist" i]'
};

const dedupState = {
    enabled: readDedupFlag(),
    hidden: 0
};

let refreshDedupButton = null;
let dedupTimer = null;

function readDedupFlag() {
    try {
        const v = localStorage.getItem(DEDUP.STORAGE_KEY);
        return v === null ? true : v === '1'; // 默认开启
    } catch (e) {
        return true;
    }
}

function writeDedupFlag(v) {
    try {
        localStorage.setItem(DEDUP.STORAGE_KEY, v ? '1' : '0');
    } catch (e) {
        /* ignore */
    }
}

function cleanText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
}

// 从详情页链接里取种子 id，取不到就用链接本身当标识
function torrentIdOf(anchor) {
    const href = anchor.getAttribute('href') || anchor.href || '';
    const m = href.match(/\/detail\/(\d+)/i);
    if (m) return m[1];
    const m2 = href.match(/detail[^?#]*/i);
    return m2 ? m2[0].toLowerCase() : null;
}

function detailIdsIn(el) {
    const ids = new Set();
    el.querySelectorAll('a[href*="/detail/" i]').forEach((a) => {
        const id = torrentIdOf(a);
        if (id) ids.add(id);
    });
    return ids;
}

function isSkippedRegion(el) {
    try {
        return !!el.closest(DEDUP.SKIP_SELECTOR);
    } catch (e) {
        return !!el.closest('aside');
    }
}

// 向上找到「只包含这一个种子」的容器，即列表里的一行
function findRowContainer(anchor) {
    const id = torrentIdOf(anchor);

    const tr = anchor.closest('tr');
    if (tr) return tr;

    let el = anchor.parentElement || anchor;
    for (let i = 0; i < 12; i++) {
        const p = el.parentElement;
        if (!p || p === document.body || p === document.documentElement) break;

        const tag = p.tagName;
        if (tag === 'TBODY' || tag === 'TABLE' || tag === 'UL' || tag === 'OL' || tag === 'MAIN') break;

        const ids = detailIdsIn(p);
        if (ids.size > 1) break;
        if (id && ids.size === 1 && !ids.has(id)) break;

        el = p;
        if (el.tagName === 'LI' || el.tagName === 'ARTICLE' || el.tagName === 'SECTION') break;
    }
    return el;
}

// 行标题：优先取该行里最长的详情链接文字（一般就是种子标题）
function rowTitleText(row, id) {
    let best = '';
    row.querySelectorAll('a[href*="/detail/" i]').forEach((a) => {
        if (id && torrentIdOf(a) !== id) return;
        const t = cleanText(a.textContent);
        if (t.length > best.length) best = t;
    });
    if (best) return best;

    const named = row.querySelector('[class*="title" i], [class*="name" i]');
    if (named) {
        const t = cleanText(named.textContent);
        if (t) return t;
    }
    return cleanText(row.textContent);
}

function normalizeKeyText(s) {
    return (s || '')
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildGroupKey(title, rowText) {
    let t = String(title || '');
    DEDUP.STRIP.forEach((re) => {
        t = t.replace(re, ' ');
    });

    let res = '';
    if (!DEDUP.MERGE_ACROSS_RESOLUTION) {
        const m = String(title || '').match(DEDUP.RE_RES) || String(rowText || '').match(DEDUP.RE_RES);
        res = m ? m[1].toLowerCase() : '';
        if (res) {
            DEDUP.STRIP_RES.forEach((re) => {
                t = t.replace(re, ' ');
            });
        }
    }

    const base = normalizeKeyText(t);
    if (!base) return '';
    return res ? base + '|' + res : base;
}

// 画质优先级打分：5 = DoVi+HDR10+ ... 0 = 都没有
function hdrTier(text) {
    const s = String(text || '');
    const dovi = DEDUP.RE_DOVI.test(s);
    const hdr10plus = DEDUP.RE_HDR10PLUS.test(s);
    const hdr10 = DEDUP.RE_HDR10.test(s);

    if (dovi && hdr10plus) return 5;
    if (dovi && hdr10) return 4;
    if (dovi) return 3;
    if (hdr10plus) return 2;
    if (hdr10) return 1;
    return 0;
}

function collectRows() {
    const rows = [];
    const seen = new Set();
    document.querySelectorAll('a[href*="/detail/" i]').forEach((a) => {
        const id = torrentIdOf(a);
        if (!id || isSkippedRegion(a)) return;
        const row = findRowContainer(a);
        if (!row || seen.has(row)) return;
        seen.add(row);
        rows.push({ id: id, row: row });
    });
    return rows;
}

function hideDedupRow(row) {
    if (row.dataset.mtDedupHidden === '1') return;
    row.dataset.mtDedupHidden = '1';
    row.dataset.mtDedupPrevDisplay = row.style.display || '';
    row.style.display = 'none';
}

function showDedupRow(row) {
    if (row.dataset.mtDedupHidden !== '1') return;
    row.style.display = row.dataset.mtDedupPrevDisplay || '';
    delete row.dataset.mtDedupHidden;
    delete row.dataset.mtDedupPrevDisplay;
}

function applyDedup() {
    const rows = collectRows();
    const toHide = new Set();

    if (dedupState.enabled) {
        const groups = new Map();

        rows.forEach((r) => {
            const rowText = r.row.textContent || '';
            const key = buildGroupKey(rowTitleText(r.row, r.id), rowText);
            if (!key) return;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ row: r.row, tier: hdrTier(rowText) });
        });

        groups.forEach((list) => {
            let best = list[0];
            list.forEach((it) => {
                if (it.tier > best.tier) best = it; // 同分保留列表里靠前（即热度更高）的那条
            });
            list.forEach((it) => {
                if (it !== best) toHide.add(it.row);
            });
        });
    }

    // 之前隐藏、本次不需要隐藏的恢复显示
    document.querySelectorAll('[data-mt-dedup-hidden="1"]').forEach((el) => {
        if (!toHide.has(el)) showDedupRow(el);
    });
    toHide.forEach(hideDedupRow);

    dedupState.hidden = toHide.size;
    return dedupState.hidden;
}

function scheduleDedup() {
    if (dedupTimer) clearTimeout(dedupTimer);
    dedupTimer = setTimeout(() => {
        applyDedup();
        if (refreshDedupButton) refreshDedupButton();
    }, 250);
}

function createDedupButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mt-custom-btn mt-dedup-btn';

    const render = () => {
        if (dedupState.enabled) {
            btn.textContent = dedupState.hidden > 0 ? '排重：开（隐藏 ' + dedupState.hidden + '）' : '排重：开';
        } else {
            btn.textContent = '排重：关';
        }
        btn.classList.toggle('mt-active', dedupState.enabled);
        btn.title = '同一部片子只保留画质最好的一条：DoVi+HDR10+ > DoVi+HDR10 > 仅DoVi > 仅HDR10+ > 仅HDR10 > 无';
    };

    btn.addEventListener('click', () => {
        dedupState.enabled = !dedupState.enabled;
        writeDedupFlag(dedupState.enabled);
        applyDedup();
        render();
    });

    refreshDedupButton = render;
    render();
    return btn;
}

async function mountOnce() {
    const form =
        (await waitForElement('form.torrent-search-panel')) ||
        (await waitForElement('form.ant-form[class*="torrent-search-panel"]')) ||
        (await waitForElement('form.ant-form'));

    if (!form || form.dataset.mtBtnsMounted) return;
    form.dataset.mtBtnsMounted = '1';

    if (document.getElementById('custom-search-buttons-container')) return;

    injectStyles(); // 注入自定义样式

    const wrap = document.createElement('div');
    wrap.id = 'custom-search-buttons-container';
    wrap.style.margin = '10px 0';

    // 1. 最近区间热度按钮
    const recentWrap = document.createElement('div');
    recentWrap.className = 'mt-custom-wrap';
    recentWrap.style.marginBottom = '8px';
    recentWrap.style.borderBottom = '1px dashed #eee';
    recentWrap.style.paddingBottom = '8px';

    [
        { text: '一周', amount: 7, unit: 'days' },
        { text: '一月', amount: 1, unit: 'months' },
        { text: '季度', amount: 3, unit: 'months' },
        { text: '半年', amount: 6, unit: 'months' },
        { text: '一年', amount: 12, unit: 'months' },
        { text: '三年', amount: 3, unit: 'years' },
        { text: '五年', amount: 5, unit: 'years' },
        { text: '十年', amount: 10, unit: 'years' }
    ].forEach((cfg) => recentWrap.appendChild(createDateSortButton(cfg.text, cfg.amount, cfg.unit)));

    wrap.appendChild(recentWrap);

    // 2. 按年前区间热度按钮
    const yearRangeWrap = document.createElement('div');
    yearRangeWrap.className = 'mt-custom-wrap';

    yearRangeWrap.appendChild(createYearRangeSortButton('1-2年前热度', 1, 2));
    yearRangeWrap.appendChild(createYearRangeSortButton('2-3年前热度', 2, 3));
    yearRangeWrap.appendChild(createYearRangeSortButton('3-4年前热度', 3, 4));
    yearRangeWrap.appendChild(createYearRangeSortButton('4-5年前热度', 4, 5));
    yearRangeWrap.appendChild(createYearRangeSortButton('5-10年前热度', 5, 10));
    yearRangeWrap.appendChild(createYearRangeSortButton('10-20年前热度', 10, 20));

    yearRangeWrap.appendChild(createSortOnlyButton());
    yearRangeWrap.appendChild(createClearAllButton());
    yearRangeWrap.appendChild(createDedupButton()); // 排重开关

    wrap.appendChild(yearRangeWrap);

    form.insertAdjacentElement('afterend', wrap);

    scheduleDedup();
}

mountOnce();

const obs = new MutationObserver(() => mountOnce());
obs.observe(document.body, { childList: true, subtree: true });

// 列表刷新（翻页/重新排序/懒加载）后自动重新排重
const dedupObs = new MutationObserver((mutations) => {
    for (let i = 0; i < mutations.length; i++) {
        const t = mutations[i].target;
        if (t && t.nodeType === 1 && t.closest && t.closest('#custom-search-buttons-container')) continue;
        scheduleDedup();
        return;
    }
});
dedupObs.observe(document.body, { childList: true, subtree: true });

scheduleDedup();
})();