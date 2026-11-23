// ==UserScript==
// @name         M-Team 女优身高标注 + 列表大图
// @namespace    mteam
// @version      1.8.8
// @description  在种子列表/详情页的标题与副标题中，女优名字后面追加身高（如「三上悠亜 159cm」）；同时放大列表缩略图（240/360/480 可切换）、种子名完整显示不被省略号截断；并支持收藏当前页面、给已订阅女优加「已订阅」标签。身高数据内嵌，订阅名单只在订阅页点按钮时从页面读取，脚本不发任何网络请求。
// @author       Cola.Kot
// @license      MIT
// @match        https://*.m-team.cc/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

// 身高标注部分：数据来自 DMM/FANZA 公开演员库，已内嵌进脚本。
// 列表大图部分：移植自 XMXM 的「m-team 列表大图」(SleazyFork #495505, MIT License)。
// @downloadURL / @updateURL 发布到 GreasyFork 后由平台自动生成，不要手写

(function () {
'use strict';

/* ============================================================
 * 配置区
 * ============================================================ */
const OPTIONS = {
    // 名字最短长度（小于该长度不参与匹配，避免误伤）
    minNameLength: 2,
    // true = 名字必须处于「词边界」才认（中日文名至少一侧不是文字字符；
    //        拉丁名两侧都不能是字母/数字），可避免 "Ray" 命中 "BluRay"
    requireBoundary: true,
    // 身高显示模板：{h} 会被替换为数字
    suffixTemplate: ' {h}cm',
    // 除默认锚点外，额外需要扫描的容器选择器
    extraSelectors: [],
    // 是否显示右下角的开关面板
    enablePanel: true,
};

// 列表标题锚点：新版界面 /detail/，旧版界面 details.php
// 同时覆盖副标题与详情页标题
const TARGET_SELECTORS = [
    // 列表页标题链接（新版 /detail/，旧版 details.php）
    'a[href*="/detail/"]',
    'a[href*="details.php"]',
    // 列表页副标题（新版：标题链接后紧跟 br+div，副标题文本在该 div 内）
    'a[href*="/detail/"] + br + div',
    // 详情页标题（旧版 NexusPHP：h1#top）
    '#top',
];

// 是否启用身高标注（可在面板中切换）
const ENABLED_KEY = 'mt_height_enabled';

// 列表视图：隐藏已订阅 / 按身高排序（面板按钮切换，记住状态）
const HIDE_SUB_KEY = 'mt_hide_subscribed';
const HEIGHT_SORT_KEY = 'mt_height_sort';
// 番号排重：同番号只留一个，按标题/副标里的版本标记打分选最优
const DEDUP_KEY = 'mt_dedup';

/* ---- 现场排障开关（默认全开，普通用户用不到）----
 * 卡顿时想确定是哪个功能引起的，控制台执行下面任意几条后刷新即可：
 *   localStorage.mt_off = 'title'        只关「种子名完整显示」
 *   localStorage.mt_off = 'thumb'        只关「缩略图缩放」
 *   localStorage.mt_off = 'badge'        只关「身高标签」
 *   localStorage.mt_off = 'title,thumb'  关多个
 *   localStorage.mt_off = 'all'          一次关掉全部（用来判断卡顿是不是我们引起的）
 * 恢复：localStorage.removeItem('mt_off')
 */
const FEATURE_OFF = (function () {
    const set = Object.create(null);
    let raw = '';
    try { raw = String(localStorage.getItem('mt_off') || ''); } catch (e) { raw = ''; }
    raw.split(',').forEach((k) => {
        const t = k.trim();
        if (t === 'all') { set.title = set.thumb = set.badge = 1; return; }
        if (t) set[t] = 1;
    });
    return set;
})();

// ---- 列表大图：缩略图尺寸（短边像素） ----
const THUMB_SIZES = [240, 360, 480];
const THUMB_SIZE_KEY = 'mt_big_thumb_size';

// ---- 收藏：保存的页面列表 ----
const FAV_KEY = 'mt_fav_list';

// ---- 订阅：M-Team「女优展示（showcase）」收藏列表 ----
// 唯一来源：用户自己打开 /showcase?action=fav 订阅页并点「已订阅」按钮时，
// 从页面卡片 DOM 读取名字。脚本不主动监测、不发任何接口请求，避免 CORS / 403 报错与卡顿。
const SUB_KEY = 'mt_subscribed_actresses';  // 缓存 { ts, names: [...], total, source }
const SUB_BADGE_TEXT = '已订阅';
// 女优卡片链接：站点改版换过详情页路径，多留几套，命中哪套用哪套
const SUB_DOM_SELECTORS = [
    'a[href*="/showcaseDetail"]',
    'a[href*="/showcase/"]',
    'a[href*="/actress"]',
    'a[href*="/star"]',
];
// 页面上这些文字不是女优名，别混进订阅名单
const SUB_UI_WORDS = /^(首页|我的|收藏|已订阅|全部|更多|加载中|加载更多|搜索|登录|注册|订阅|取消订阅|返回|上一页|下一页|没有更多了?)$/;

/* ============================================================
 * 自检：本文件是「模板」，核心逻辑与身高数据由 tools/build-userscript.mjs 注入。
 * 直接安装模板会缺少 buildAutomaton / normalizeStr 等函数，导致整脚本 ReferenceError。
 * 这里提前拦住，给出可读提示，避免页面上一堆 "xxx is not defined"。
 * ============================================================ */
if (typeof buildAutomaton !== 'function' || typeof normalizeStr !== 'function') {
    try {
        // eslint-disable-next-line no-console
        console.error(
            '[M-Team 女优身高标注] 安装的是未构建的模板（缺少核心逻辑/数据）。\n' +
            '请安装 dist/m-team-actress-height.user.js，而不是 src/userscript.template.js。',
        );
    } catch (e) {
        /* ignore */
    }
    return;
}

/* ============================================================
 * 内嵌数据集：{ 女优名: 身高(cm) }
 * 由 tools/build-userscript.mjs 自动注入
 * ============================================================ */
const ACTRESS_HEIGHT = /* @__DATA__ */ {};

/* ============================================================
 * 核心匹配逻辑（Aho-Corasick 多模式串匹配）
 * 由 tools/build-userscript.mjs 从 src/core.mjs 内联
 * ============================================================ */
/* @__CORE__ */

// 构建归一化后的身高表与模式串。
// 数据集中部分名字使用全角英数（如「ＡＩＫＡ」），而 M-Team 标题中可能用半角（AIKA），
// 反之亦然。对模式和待扫描文本统一做全角→半角归一化后，两侧字符集一致才能命中。
// 归一化保持字符串长度不变（1:1 字符映射），因此匹配偏移量可直接用于原始 DOM 锚点。
// 明确不参与匹配的名字。数据集里仍保留（`build/actress-height.json` 不动），随时可恢复。
// 「AI」「AN」在标题里绝大多数是标签词/缩写（AI破解、AN 修复等），极易误标，
// 标错的代价（多出 166cm、把该行顶到身高排序前面）比漏标大得多。
const IGNORED_NAMES = ['AI', 'AN'];
const _ignoredNorm = Object.create(null);
IGNORED_NAMES.forEach((n) => { _ignoredNorm[normalizeStr(n)] = 1; });

const NORMALIZED_HEIGHT = Object.create(null);
const _patterns = [];
for (const _name in ACTRESS_HEIGHT) {
    const _norm = normalizeStr(_name);
    if (_norm.length < OPTIONS.minNameLength) continue;
    if (_ignoredNorm[_norm]) continue;
    if (!(_norm in NORMALIZED_HEIGHT)) {
        NORMALIZED_HEIGHT[_norm] = ACTRESS_HEIGHT[_name];
        _patterns.push(_norm);
    }
}
const AC = buildAutomaton(_patterns);

/* ============================================================
 * 订阅：M-Team「女优展示（showcase）」收藏
 * ------------------------------------------------------------
 * 唯一来源是订阅页（showcase?action=fav）的卡片 DOM：用户打开订阅页、
 * 点一下面板上的「已订阅」按钮，脚本才去读一次并缓存。
 * 脚本自身不发任何网络请求（不请求 /api、不 hook 页面 fetch/XHR），
 * 因此不会产生 CORS / 403 报错，也不会有后台轮询带来的卡顿。
 *
 * 拿到名字后单独建一台 Aho-Corasick，与身高标注各走各的：
 * 即使某个女优还没有身高数据，只要在订阅列表里，标题照样能被识别并加「已订阅」标签。
 * ============================================================ */
let subNames = [];       // 订阅女优的原始名字（用于匹配）
let subCount = 0;        // 订阅条目数（面板上显示的数量）
let subPatterns = [];    // 归一化后的匹配模式
let SUB_AC = null;       // 订阅女优自动机（无订阅时为 null）
let subVersion = 0;      // 集合版本：变化后强制重扫已标注元素
let subEngineError = '';  // 订阅匹配引擎自身的异常（如核心函数缺失）
let subDomWarned = false; // 收藏页读不到卡片时的结构诊断，也只打一次

// 去掉括号补充说明（「三上悠亜（みかみゆあ）」→「三上悠亜」）并做全角→半角归一化
function subNormalizeName(name) {
    return normalizeStr(String(name))
        .replace(/[（(][^）)]*[）)]/g, '')
        .trim();
}

// 由订阅名字生成匹配模式：原名 + 去空白版本（标题里常写「三上悠亜」而数据里是「三上 悠亜」）
function buildSubPatterns(names) {
    const out = [];
    const seen = new Set();
    const push = (s) => {
        if (!s || s.length < 2 || seen.has(s)) return;
        seen.add(s);
        out.push(s);
    };
    for (const raw of names) {
        const base = subNormalizeName(raw);
        if (!base) continue;
        push(base);
        const compact = base.replace(/[\s\u3000]+/g, '');
        if (compact.length >= 3 && compact !== base) push(compact);
    }
    return out;
}

// 应用一份订阅名单；返回是否真的发生变化
function applySubNames(names) {
    const list = Array.isArray(names)
        ? names.filter((n) => typeof n === 'string' && n.trim())
        : [];
    const patterns = buildSubPatterns(list).sort();
    const changed =
        patterns.length !== subPatterns.length ||
        patterns.some((p, i) => p !== subPatterns[i]);
    subNames = list;
    if (changed) {
        subPatterns = patterns;
        SUB_AC = buildSubAutomaton(patterns);
        subVersion++; // 强制 processElement 重新扫描（签名里带了 subVersion）
    }
    return changed;
}

// 构建订阅自动机：核心函数缺失或异常时降级为「不标记」，
// 绝不让一个可选的订阅功能把整个脚本（尤其是 async 链路）带崩。
function buildSubAutomaton(patterns) {
    if (!patterns.length) return null;
    if (typeof buildAutomaton !== 'function') {
        subEngineError = '核心匹配函数缺失（脚本可能未完整安装）';
        return null;
    }
    try {
        return buildAutomaton(patterns);
    } catch (e) {
        subEngineError = (e && e.message) || '构建订阅自动机失败';
        return null;
    }
}

// 订阅匹配：任何异常都吞掉，返回空命中
function subMatchesOf(normText) {
    if (!SUB_AC || typeof pickMatches !== 'function') return [];
    try {
        return pickMatches(SUB_AC, normText, OPTIONS) || [];
    } catch (e) {
        return [];
    }
}

function subCacheRead() {
    let raw = null;
    try {
        if (typeof GM_getValue === 'function') raw = GM_getValue(SUB_KEY, null);
        else raw = localStorage.getItem(SUB_KEY);
    } catch (e) {
        raw = null;
    }
    if (!raw) return null;
    try {
        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!obj || !Array.isArray(obj.names)) return null;
        return obj;
    } catch (e) {
        return null;
    }
}

function subCacheWrite(obj) {
    const raw = JSON.stringify(obj);
    try {
        if (typeof GM_setValue === 'function') GM_setValue(SUB_KEY, raw);
        else localStorage.setItem(SUB_KEY, raw);
    } catch (e) {
        /* ignore */
    }
}

/* ---------------- 唯一途径：直接读订阅页的女优卡片 ---------------- */

// 当前是否在「女优展示 → 收藏」标签页。
// 注意：/showcase 有三个 tab（首页 all / 我的 my / 收藏 fav），首页也会显示一整页女优，
// 所以**不能只看 URL 有没有 action=fav**（SPA 切 tab 时 URL 可能没及时更新），
// 优先看 antd Tabs 当前激活的那一项的 data-node-key。
function isShowcaseFavPage() {
    let href = '';
    try {
        href = String(window.location.href || '');
    } catch (e) {
        return false;
    }

    // 路径必须是 /showcase 本身（排除 /showcaseDetail?id=...）
    let pathname = '';
    try {
        pathname = new URL(href).pathname;
    } catch (e) {
        pathname = href.split(/[?#]/)[0];
    }
    if (!/\/showcase\/?$/i.test(pathname)) return false;

    // 1) 有 Tabs：以「激活的 tab」为准（data-node-key 与语言无关）
    let tab = null;
    try {
        tab = document.querySelector('.ant-tabs-tab-active');
    } catch (e) {
        tab = null;
    }
    if (tab) {
        const attr = tab.getAttribute ? tab.getAttribute.bind(tab) : null;
        const key = (attr && (attr('data-node-key') || attr('data-key') || attr('data-tab-key'))) || '';
        if (key) return /^fav$/i.test(key) || /[-_]fav$/i.test(key);
        // 老版本 antd 没有 data-node-key 时退回文案判断
        return /收藏|已订阅|最愛|favorite|\bfav\b/i.test(tab.textContent || '');
    }

    // 2) 没有 Tabs（单页渲染）：退回 URL 参数
    try {
        const u = new URL(href);
        return (u.searchParams.get('action') || '') === 'fav';
    } catch (e) {
        return /[?&]action=fav(?:&|$)/i.test(href);
    }
}

// 当前激活的 TabPane 容器（没有就退回 document），保证只读「收藏」这一屏的卡片
function subActivePane() {
    try {
        const pane = document.querySelector('.ant-tabs-tabpane-active');
        if (pane && pane.querySelectorAll) return pane;
    } catch (e) {
        /* ignore */
    }
    return document;
}

// 卡片结构（见前端 showcase.*.chunk.js）：
//   <a href="/showcaseDetail?id=xx"><img alt="三上悠亜"></a>       ← 无文本，取 img alt 兜底
//   <a href="/showcaseDetail?id=xx">三上悠亜</a>                  ← 名字链接，取 textContent
// 站点改版换过路径，所以多套选择器都试；全不命中时再用卡片图片 alt 兜底。
// 从某个根节点里抓女优名：先按卡片链接取文本/图片 alt，链接一套都不命中时再用图片 alt 兜底
function collectDomNames(root) {
    const names = [];
    const seen = new Set();
    const push = (v) => {
        const t = String(v || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 40) return; // 过滤超长说明 / 空文本
        if (SUB_UI_WORDS.test(t)) return;
        if (/^(https?:|\/)/i.test(t)) return;
        if (/logo|avatar|icon|banner|placeholder/i.test(t)) return;
        if (seen.has(t)) return;
        seen.add(t);
        names.push(t);
    };
    const each = (sel, fn) => {
        let nodes;
        try { nodes = root.querySelectorAll(sel); } catch (e) { nodes = null; }
        if (!nodes) return;
        const list = typeof nodes.forEach === 'function' ? nodes : Array.prototype.slice.call(nodes);
        list.forEach(fn);
    };

    // 1) 卡片链接：文本优先，其次链接里的图片 alt
    SUB_DOM_SELECTORS.forEach((sel) => {
        each(sel, (a) => {
            if (!a) return;
            const text = String(a.textContent || '').replace(/\s+/g, ' ').trim();
            if (text) return push(text);
            let img = null;
            try { img = a.querySelector ? a.querySelector('img') : null; } catch (e) { img = null; }
            if (img && img.getAttribute) push(img.getAttribute('alt'));
        });
    });

    // 2) 兜底：卡片封面图的 alt 通常就是女优名（站点把卡片做成 div / 没有 href 时靠这个）
    //    只在前面一套都没命中时启用，避免把页面上无关图片的 alt 混进来
    if (!names.length) {
        each('img', (img) => {
            const alt = img && img.getAttribute ? img.getAttribute('alt') : '';
            if (alt) push(alt);
        });
    }

    return names;
}

function subDomNames() {
    const pane = subActivePane();
    // 激活 pane 优先：首页/我的里的卡片即使还在 DOM 里也不会被算进来
    const fromPane = collectDomNames(pane);
    if (fromPane.length) return fromPane;
    // 站点会把收藏列表渲染在 antd pane 之外（实测 pane 里一张卡都没有）：
    // 这时退回整页再抓一次，否则明明页面上有卡片却读不到
    if (pane && pane !== document) {
        const fromDoc = collectDomNames(document);
        if (fromDoc.length) return fromDoc;
    }
    return fromPane;
}

// 把 DOM 抓到的名字写进缓存。
// - replace=true（用户主动点按钮刷新）：以当前页为准，可直接清掉之前混进来的脏数据
// - replace=false 且存在分页控件（订阅超过一页）：做并集，避免只读第一页就把后面的覆盖掉
// - 其余情况：以 DOM 为准（这样取消订阅也能反映出来）
function applyDomSubNames(names, replace) {
    const uniq = [];
    const seen = new Set();
    for (const n of names) {
        if (n && !seen.has(n)) {
            seen.add(n);
            uniq.push(n);
        }
    }
    if (!uniq.length) return false;

    let multiPage = false;
    try {
        multiPage = !!document.querySelector('.ant-pagination');
    } catch (e) {
        multiPage = false;
    }

    let finalNames = uniq;
    if (!replace && multiPage) {
        const prev = subCacheRead();
        if (prev && Array.isArray(prev.names)) {
            const merged = [];
            const mseen = new Set();
            for (const n of prev.names.concat(uniq)) {
                if (n && !mseen.has(n)) {
                    mseen.add(n);
                    merged.push(n);
                }
            }
            finalNames = merged;
        }
    }

    const changed = applySubNames(finalNames);
    const prevCount = subCount;
    subCount = finalNames.length;
    // 名单没变化就不重复写存储（scanAll 会频繁调用）
    if (changed || prevCount !== subCount) {
        subCacheWrite({ ts: Date.now(), names: finalNames, total: subCount, source: 'dom' });
    }
    return changed || prevCount !== subCount;
}

// 载入订阅名单。脚本绝不发网络请求，也绝不自动监测页面：
// - force=false（仅 boot 时调用一次）：只读本地缓存，让名单秒开；不读 DOM、不轮询。
// - force=true（用户点面板「已订阅」按钮）：
//     · 在订阅页：从页面卡片 DOM 读一次，读到就覆盖旧缓存；
//     · 不在订阅页：只读缓存；若名单为 0，弹提示引导去订阅页点一次。
function refreshSubscriptions(force) {
    let changed = false;

    if (force && isShowcaseFavPage()) {
        // 订阅页：DOM 是唯一真相源，一个网络请求都不发
        let domNames = [];
        try { domNames = subDomNames(); } catch (e) { domNames = []; }
        if (domNames.length) {
            changed = applyDomSubNames(domNames, true);
            subDomWarned = false;
        } else {
            // 卡片还没渲染出来：打一次结构诊断，提示稍后再点，绝不退回接口
            if (!subDomWarned) {
                subDomWarned = true;
                warnNoSubCards();
            }
            showSubToast('还没读到订阅名单，等卡片加载出来后再点一次「' + SUB_BADGE_TEXT + '」。', false);
        }
    } else {
        // 非订阅页 / boot：只读本地缓存，不发请求、不读 DOM
        try {
            const cached = subCacheRead();
            if (cached && Array.isArray(cached.names)) {
                applySubNames(cached.names);
                subCount = cached.total > 0 ? cached.total : cached.names.length;
                changed = true;
            }
        } catch (e) {
            /* 订阅是可选增强，异常只影响它自己 */
        }
        if (force && subCount === 0) {
            showSubToast('还没有订阅名单，请到「女优订阅页」点一次「' + SUB_BADGE_TEXT + '」按钮同步。', true);
        }
    }

    renderSubUI();
    if (changed || subCount) scanAll();
}

/* ============================================================
 * 一键把「带已订阅标记的种子」收藏到 M-Team 站点自己的收藏夹
 * 做法：模拟点击站点列表行里的 star 按钮，由站点自己发请求。
 * 脚本自身依旧不发任何网络请求。
 * 站点实测：未收藏 = span.anticon-star 的 inline style 为 color: var(--mt-icon-color)
 *           已收藏 = color: gold
 * ============================================================ */
const SITE_FAV_GAP_MS = 350; // 两次点击的间隔：太快容易被站点当成机器人
let siteFavRunning = false;
let siteFavTimer = null;

// 站点已收藏：inline style 里有 gold，或计算样式是金色
function siteStarFaved(icon) {
    if (!icon) return false;
    const inline = String(icon.getAttribute && icon.getAttribute('style') || '');
    if (/\bgold\b|#ffd700|rgb\(\s*255\s*,\s*215\s*,\s*0\s*\)/i.test(inline)) return true;
    try {
        const st = getComputedStyle(icon);
        const c = String((st && st.color) || '');
        if (/\bgold\b|255\s*,\s*215\s*,\s*0/i.test(c)) return true;
    } catch (e) { /* ignore */ }
    return false;
}

// 找出一行里站点自己的 star 按钮（不是面板里的星星）
function siteStarButtonOfRow(row) {
    if (!row || !row.querySelectorAll) return null;
    const icons = row.querySelectorAll('.anticon-star');
    for (let i = 0; i < icons.length; i++) {
        const icon = icons[i];
        // 站点 star 图标带 aria-label="star"；面板里的 mt-fav-star 是纯文本，不会有它
        if (icon.getAttribute && icon.getAttribute('aria-label') !== 'star') continue;
        const btn = icon.closest && icon.closest('button');
        if (btn) return { btn, icon };
    }
    return null;
}

// 当前列表里待收藏的行：带 .mt-sub-badge 且站点星标还没变金
// 统计带「已订阅」标记、且行内有站点收藏按钮的种子：
// total = 可收藏总数，faved = 其中站点已收藏，pending = 还没收藏的按钮
function siteFavScan() {
    const pending = [];
    let total = 0;
    let faved = 0;
    const seen = (typeof WeakSet === 'function') ? new WeakSet() : null;
    const badges = document.querySelectorAll('.mt-sub-badge');
    for (let i = 0; i < badges.length; i++) {
        const row = badges[i].closest && badges[i].closest('tr');
        if (!row) continue;
        if (seen) {
            if (seen.has(row)) continue;
            seen.add(row);
        }
        const star = siteStarButtonOfRow(row);
        if (!star) continue; // 行内没有站点收藏按钮，不计入可收藏
        total++;
        if (siteStarFaved(star.icon)) faved++;
        else pending.push(star.btn);
    }
    return { total, faved, pending };
}

function siteFavBtnEl() {
    try { return document.querySelector('#mt-height-panel .mt-site-fav-btn'); }
    catch (e) { return null; }
}

function renderSiteFavUI() {
    const btn = siteFavBtnEl();
    if (!btn) return;
    const s = siteFavScan();
    const left = s.total - s.faved;
    btn.textContent = siteFavRunning ? '收藏中…' : `收藏已订阅 (${s.faved}/${s.total})`;
    btn.classList.toggle('mt-fav-busy', siteFavRunning);
    btn.title = siteFavRunning
        ? '正在把带「已订阅」标记的种子加入 M-Team 收藏夹'
        : `已收藏 ${s.faved} / 可收藏 ${s.total}，还剩 ${left} 条未收藏。`
        + '点此把未收藏的加入 M-Team 收藏夹；已收藏的会自动跳过。';
}

// 串行点击，每次点完等站点渲染完星标再处理下一条
function startSiteFav() {
    if (siteFavRunning) return;
    const queue = siteFavScan().pending;
    if (!queue.length) {
        showSubToast('当前列表没有待收藏的「已订阅」种子（可能都已收藏）。', false);
        renderSiteFavUI();
        return;
    }
    siteFavRunning = true;
    renderSiteFavUI();
    let idx = 0;
    const step = () => {
        if (idx >= queue.length) {
            siteFavRunning = false;
            siteFavTimer = null;
            renderSiteFavUI();
            showSubToast(`已提交收藏 ${queue.length} 条种子到 M-Team 收藏夹。`, false);
            return;
        }
        const btn = queue[idx++];
        try {
            // 站点可能已把这行重渲染，重新确认还没收藏再点
            const icon = btn.querySelector && btn.querySelector('.anticon-star');
            if (btn.isConnected !== false && !siteStarFaved(icon)) btn.click();
        } catch (e) { /* 单行失败不影响其它行 */ }
        const btnEl = siteFavBtnEl();
        if (btnEl) btnEl.textContent = `收藏中 ${idx}/${queue.length}`;
        siteFavTimer = setTimeout(step, SITE_FAV_GAP_MS);
    };
    step();
}

/* ============================================================
 * 列表视图：隐藏已订阅 / 按身高从高到低排序
 * 两者都只操作<tr>，不碰数据、不发请求；刷新页面后按记住的状态重放。
 * ============================================================ */
const LIST_VIEW_STYLE_ID = 'mt-list-view-style';

function readBoolFlag(key) {
    try { return localStorage.getItem(key) === '1'; } catch (e) { return false; }
}
function writeBoolFlag(key, on) {
    try { localStorage.setItem(key, on ? '1' : '0'); } catch (e) { /* ignore */ }
}

let hideSubscribed = readBoolFlag(HIDE_SUB_KEY);
let heightSortOn = readBoolFlag(HEIGHT_SORT_KEY);
let dedupOn = readBoolFlag(DEDUP_KEY);

/* ---- 番号排重：同番号只留最优版本 ----
 * 番号：字母+数字+连字符，如 SSIS-001 / JUR-478 / FC2-PPV-123456。
 * 标题优先，标题取不到再看副标（列表页副标紧跟在标题链接后的 br+div）。
 * 版本打分：4k+LTX(5) > 4k(4) > LTX(3) > 破解(2) > 中字(1) > 其它(0)。
 */
const CODE_RE = /[A-Za-z]{2,10}-[0-9]{2,8}(?:-[A-Za-z0-9]{2,8})?/g;

function rowTitleText(row) {
    if (!row || !row.querySelector) return '';
    const a = row.querySelector('a[href*="/detail/"], a[href*="details.php"]');
    return a && a.textContent ? a.textContent : '';
}

// 列表页副标：标题链接后紧跟 br + div（与 TARGET_SELECTORS 里的副标结构一致）
function rowSubText(row) {
    const a = row && row.querySelector
        ? row.querySelector('a[href*="/detail/"], a[href*="details.php"]') : null;
    if (!a) return '';
    let n = a.nextSibling;
    if (n && n.nodeType === 1 && n.tagName === 'BR') n = n.nextSibling;
    if (n && n.nodeType === 1 && n.tagName === 'DIV') return n.textContent || '';
    return '';
}

function extractCode(text) {
    if (!text) return '';
    CODE_RE.lastIndex = 0;
    const m = CODE_RE.exec(text);
    return m ? m[0].toUpperCase() : '';
}

function versionScore(titleText, subText) {
    const text = (titleText || '') + ' ' + (subText || '');
    const has4k = /4\s*k/i.test(text);
    const hasLtx = /ltx/i.test(text);
    if (has4k && hasLtx) return 5;
    if (has4k) return 4;
    if (hasLtx) return 3;
    if (/破解/.test(text)) return 2;
    if (/中字|中文字幕/.test(text)) return 1;
    return 0;
}

function injectListViewStyle() {
    if (document.getElementById(LIST_VIEW_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = LIST_VIEW_STYLE_ID;
    style.textContent = `
        tr.mt-hide-row { display: none !important; }
        tr.mt-dup-row { display: none !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
}

// 只取<tr>直接子节点（真实浏览器有 children，测试迷你 DOM 没有，统一遍历 childNodes）
function childRows(parent) {
    const out = [];
    if (!parent || !parent.childNodes) return out;
    for (let i = 0; i < parent.childNodes.length; i++) {
        const n = parent.childNodes[i];
        if (n.nodeType === 1 && n.tagName === 'TR') out.push(n);
    }
    return out;
}

// 所有种子行：带 /detail/ 或 details.php 链接的<tr>，按它们所属的父节点分组
function listRowGroups() {
    const links = document.querySelectorAll('a[href*="/detail/"], a[href*="details.php"]');
    const groups = []; // { parent, rows }
    const seenParent = (typeof WeakSet === 'function') ? new WeakSet() : null;
    for (let i = 0; i < links.length; i++) {
        const row = links[i].closest && links[i].closest('tr');
        if (!row || !row.parentNode) continue;
        const parent = row.parentNode;
        if (seenParent) {
            if (seenParent.has(parent)) continue;
            seenParent.add(parent);
        } else if (groups.some((g) => g.parent === parent)) {
            continue;
        }
        groups.push({ parent, rows: childRows(parent) });
    }
    return groups;
}

// 一行里所有身高取最大值；没有任何身高标记返回 -1（排序时沉底）
function rowMaxHeight(row) {
    const badges = row.querySelectorAll('.mt-height-badge');
    let max = -1;
    for (let i = 0; i < badges.length; i++) {
        const v = parseInt(badges[i].getAttribute('data-mt-height'), 10);
        if (!isNaN(v) && v > max) max = v;
    }
    return max;
}

// 记住每行的原始顺序：排序开关关掉时按这个顺序还原。
// 用 row 自身当 key，SPA 替换出的新行不在表里，会按当前 DOM 顺序追加到末尾。
const _rowOriginalOrder = (typeof WeakMap === 'function') ? new WeakMap() : null;

function rememberOriginalOrder(parent, rows) {
    if (!_rowOriginalOrder) return;
    let arr = _rowOriginalOrder.get(parent);
    if (!arr) {
        arr = rows.slice();
        _rowOriginalOrder.set(parent, arr);
        return;
    }
    // 新出现的行（加载更多）按当前顺序补进去；已经不在 DOM 里的丢掉
    const present = new Set(rows);
    for (let i = 0; i < rows.length; i++) if (arr.indexOf(rows[i]) < 0) arr.push(rows[i]);
    for (let i = arr.length - 1; i >= 0; i--) if (!present.has(arr[i])) arr.splice(i, 1);
}

function restoreOriginalOrder(parent) {
    if (!_rowOriginalOrder) return;
    const arr = _rowOriginalOrder.get(parent);
    if (!arr) return;
    arr.forEach((row) => {
        if (row.parentNode === parent) parent.appendChild(row); // 移到末尾即重排
    });
}

function applyListView() {
    injectListViewStyle();
    const groups = listRowGroups();

    // ① 隐藏已订阅：给所在行打类，不删节点（订阅标签还要留在 DOM 里参与匹配）
    const subBadges = document.querySelectorAll('.mt-sub-badge');
    const subRows = (typeof WeakSet === 'function') ? new WeakSet() : null;
    document.querySelectorAll('tr.mt-hide-row').forEach((tr) => tr.classList.remove('mt-hide-row'));
    for (let i = 0; i < subBadges.length; i++) {
        const row = subBadges[i].closest && subBadges[i].closest('tr');
        if (!row) continue;
        if (subRows) subRows.add(row);
        if (hideSubscribed) row.classList.add('mt-hide-row');
    }

    // ② 身高排序：只在开着的时候动 DOM，关掉时按记住的原始顺序还原
    for (let i = 0; i < groups.length; i++) {
        const { parent, rows } = groups[i];
        rememberOriginalOrder(parent, rows);
        if (!heightSortOn) {
            restoreOriginalOrder(parent);
            continue;
        }
        const sorted = rows.slice().sort((a, b) => {
            const ha = rowMaxHeight(a);
            const hb = rowMaxHeight(b);
            if (ha < 0 && hb < 0) return 0;
            if (ha < 0) return 1;  // 没有身高的沉底
            if (hb < 0) return -1;
            return hb - ha;        // 从高到低
        });
        // 顺序没变就不写 DOM，避免自己触发 MutationObserver 造成反复扫描
        let changed = sorted.length !== rows.length;
        if (!changed) {
            for (let k = 0; k < rows.length; k++) {
                if (rows[k] !== sorted[k]) { changed = true; break; }
            }
        }
        if (changed) sorted.forEach((row) => parent.appendChild(row));
    }

    // ③ 番号排重：同番号只留版本最优的一条，其余加隐藏类（不删节点，可恢复）
    //    放在排序之后：无论行怎么移动，分组与选优都基于当前 DOM 顺序，平局留最前。
    const dupRows = document.querySelectorAll('tr.mt-dup-row');
    for (let i = 0; i < dupRows.length; i++) dupRows[i].classList.remove('mt-dup-row');
    if (!dedupOn) return;

    for (let i = 0; i < groups.length; i++) {
        const { rows } = groups[i];
        const best = Object.create(null); // code -> { row, score }
        for (let k = 0; k < rows.length; k++) {
            const row = rows[k];
            const title = rowTitleText(row);
            const sub = rowSubText(row);
            const code = extractCode(title) || extractCode(sub);
            if (!code) continue;
            const score = versionScore(title, sub);
            const cur = best[code];
            if (!cur) {
                best[code] = { row, score };
            } else if (score > cur.score) {
                // 后来者更优：隐藏旧的那条，自己顶上（平局不动 → 留最前）
                cur.row.classList.add('mt-dup-row');
                best[code] = { row, score };
            } else {
                row.classList.add('mt-dup-row');
            }
        }
    }
}

function toggleDedup() {
    dedupOn = !dedupOn;
    writeBoolFlag(DEDUP_KEY, dedupOn);
    refreshListViewUI();
    applyListView();
}

function toggleHideSubscribed() {
    hideSubscribed = !hideSubscribed;
    writeBoolFlag(HIDE_SUB_KEY, hideSubscribed);
    refreshListViewUI();
    applyListView();
}

function toggleHeightSort() {
    heightSortOn = !heightSortOn;
    writeBoolFlag(HEIGHT_SORT_KEY, heightSortOn);
    refreshListViewUI();
    applyListView();
}

function refreshListViewUI() {
    const hideBtn = document.querySelector('#mt-height-panel .mt-hide-sub-btn');
    if (hideBtn) {
        hideBtn.textContent = hideSubscribed ? '显示全部' : '隐藏已订阅';
        hideBtn.classList.toggle('mt-on', hideSubscribed);
        hideBtn.title = hideSubscribed
            ? '当前已隐藏带「已订阅」标记的种子，点此恢复显示'
            : '隐藏列表中所有带「已订阅」标记的种子';
    }
    const sortBtn = document.querySelector('#mt-height-panel .mt-height-sort-btn');
    if (sortBtn) {
        sortBtn.textContent = heightSortOn ? '恢复原序' : '身高排序';
        sortBtn.classList.toggle('mt-on', heightSortOn);
        sortBtn.title = heightSortOn
            ? '当前按身高从高到低排列（无身高的在最后），点此恢复原顺序'
            : '按身高从高到低排列种子，一行多个女优取最高值；无身高的放最后';
    }
    const dupBtn = document.querySelector('#mt-height-panel .mt-dedup-btn');
    if (dupBtn) {
        dupBtn.textContent = dedupOn ? '恢复重复' : '番号排重';
        dupBtn.classList.toggle('mt-on', dedupOn);
        dupBtn.title = dedupOn
            ? '同番号只保留版本最优的一条（4k+LTX > 4k > LTX > 破解 > 中字），点此恢复全部显示'
            : '同一番号的多条种子只留最优版本，隐藏其余（不删除），按标题/副标的版本标记判定';
    }
}

// 收藏页读不到卡片时，打印一份页面结构，方便定位选择器是否要更新
function warnNoSubCards() {
    try {
        const tab = document.querySelector('.ant-tabs-tab-active');
        const hrefs = Array.prototype.slice
            .call(document.querySelectorAll('a[href]')).slice(0, 12)
            .map((a) => a.getAttribute('href'));
        const alts = Array.prototype.slice
            .call(document.querySelectorAll('img[alt]')).slice(0, 12)
            .map((i) => i.getAttribute('alt'));
        // eslint-disable-next-line no-console
        console.warn(
            '[M-Team 订阅] 收藏页暂时读不到卡片。下面这份页面结构可直接定位选择器：\n' +
            JSON.stringify({
                href: String(window.location.href || ''),
                tab: tab ? {
                    key: tab.getAttribute('data-node-key') || tab.getAttribute('data-key') || '',
                    text: String(tab.textContent || '').trim().slice(0, 20),
                } : null,
                pane: (function () {
                    try {
                        const p = subActivePane();
                        return {
                            isDocument: p === document,
                            imgs: p.querySelectorAll('img').length,
                            links: p.querySelectorAll('a[href]').length,
                        };
                    } catch (e) { return null; }
                })(),
                hrefs,
                alts,
            }, null, 1),
        );
    } catch (e) { /* ignore */ }
}

/* ============================================================
 * 身高标签渲染
 * ============================================================ */
function makeBadge(name, height) {
    const span = document.createElement('span');
    span.className = 'mt-height-badge';
    span.textContent = OPTIONS.suffixTemplate.replace('{h}', String(height));
    span.title = `${name} · ${height}cm`;
    span.setAttribute('data-mt-height', String(height));
    return span;
}

// 「订」标签：方形绿标，表示该女优在 M-Team 女优展示里被我订阅
function makeSubBadge() {
    const span = document.createElement('span');
    span.className = 'mt-sub-badge';
    span.textContent = SUB_BADGE_TEXT;
    span.title = '已订阅该女优';
    span.setAttribute('data-mt-sub', '1');
    return span;
}

function injectStyle() {
    if (document.getElementById('mt-height-style')) return;
    const style = document.createElement('style');
    style.id = 'mt-height-style';
    style.textContent = `
        .mt-height-badge {
            display: inline-block;
            margin: 0 2px;
            padding: 0 4px;
            border-radius: 4px;
            font-size: 0.78em;
            font-weight: 600;
            line-height: 1.5;
            vertical-align: 1px;
            color: #0b7a75;
            background: rgba(11, 122, 117, 0.12);
            border: 1px solid rgba(11, 122, 117, 0.35);
            white-space: nowrap;
            cursor: help;
        }
        html.mt-dark .mt-height-badge {
            color: #4dd0c8;
            background: rgba(77, 208, 200, 0.14);
            border-color: rgba(77, 208, 200, 0.38);
        }
        /* 「已订阅」= M-Team 女优展示收藏标签：绿色圆角标 */
        .mt-sub-badge {
            display: inline-block;
            box-sizing: border-box;
            margin: 0 2px;
            padding: 0 5px;
            border-radius: 2px;
            font-size: 0.7em;
            font-weight: 700;
            line-height: 1.45;
            text-align: center;
            vertical-align: 1px;
            color: #fff;
            background: #18a058;
            border: 1px solid #0f7a40;
            white-space: nowrap;
            cursor: help;
        }
        html.mt-dark .mt-sub-badge {
            color: #d9ffe9;
            background: rgba(24, 160, 88, 0.55);
            border-color: rgba(80, 220, 150, 0.7);
        }
    `;
    (document.head || document.documentElement).appendChild(style);
}

/* ============================================================
 * 文本节点 & 偏移映射（支持跨节点插入）
 * ============================================================ */
function textNodesOf(el) {
    const out = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            if (n.parentElement && n.parentElement.closest('.mt-height-badge, .mt-sub-badge')) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    while (walker.nextNode()) out.push(walker.currentNode);
    return out;
}

function processElement(el) {
    if (!el || el.nodeType !== 1) return;
    const nodes = textNodesOf(el);
    if (!nodes.length) return;

    // 第一步：只拼文本 + 算签名，不分配任何对象。
    // 早期版本在这里就为每个字符建 {node, off}，列表页每条标题几十字符 × 上千条，
    // 即便文本没变（签名相同会早退）也已分配完，制造海量垃圾 → GC 抖动 → 页面假死。
    let text = '';
    for (const n of nodes) text += n.nodeValue;
    if (!text) return;

    const sig = hash(text) + ':' + subVersion + ':' + (isEnabled() ? '1' : '0');
    if (el.getAttribute('data-mt-height-sig') === sig) return;

    // 文本确实变了才往下走：先清旧标签，再匹配
    el.querySelectorAll('.mt-height-badge, .mt-sub-badge').forEach((b) => b.remove());

    const normText = normalizeStr(text);
    const matches = (isEnabled() && !FEATURE_OFF.badge) ? pickMatches(AC, normText, OPTIONS) : [];
    const subHits = subMatchesOf(normText);
    if (!matches.length && !subHits.length) {
        el.setAttribute('data-mt-height-sig', sig);
        return;
    }

    // 惰性构建字符→节点映射：只有真正要插标签时才建，
    // 且只在命中附近建（用每个节点的字符区间推导），不再为每个字符单独建对象。
    const spans = []; // {node, start, end}
    let cursor = 0;
    for (const n of nodes) {
        const len = n.nodeValue.length;
        spans.push({ node: n, start: cursor, end: cursor + len });
        cursor += len;
    }
    const anchorAt = (idx) => {
        for (let i = 0; i < spans.length; i++) {
            const s = spans[i];
            if (idx >= s.start && idx < s.end) return { node: s.node, off: idx - s.start };
        }
        return null;
    };

    // 从后往前插入，保证前面锚点偏移仍有效
    matches.sort((a, b) => b.end - a.end);
    for (const m of matches) {
        const anchor = anchorAt(m.end - 1);
        if (!anchor || !anchor.node.isConnected) continue;
        const name = AC.patterns[m.p];
        const height = NORMALIZED_HEIGHT[name];
        if (!height) continue;
        const badge = makeBadge(name, height);
        try {
            const range = document.createRange();
            range.setStart(anchor.node, anchor.off + 1);
            range.collapse(true);
            range.insertNode(badge);
        } catch (e) {
            /* 忽略异常节点 */
        }
    }

    if (subHits.length) el.appendChild(makeSubBadge());

    el.setAttribute('data-mt-height-sig', sig);
}

// 轻量字符串哈希（仅用于变更检测）
function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return String(h);
}

/* ============================================================
 * 列表大图（一）：缩略图按短边等比缩放
 * ============================================================ */
function readThumbSize() {
    try {
        const v = parseInt(localStorage.getItem(THUMB_SIZE_KEY), 10);
        return THUMB_SIZES.indexOf(v) >= 0 ? v : 240;
    } catch (e) {
        return 240;
    }
}

let thumbSize = readThumbSize(); // 当前生效的短边像素

function writeThumbSize(v) {
    try {
        localStorage.setItem(THUMB_SIZE_KEY, String(v));
    } catch (e) {
        /* ignore */
    }
}

// 已注册过 load 回调的图片：懒加载图在 complete 之前 mtFitSize 一直是空的，
// 若每次 scanAll 都注册一个 load 监听器，滚动时图片陆续加载 → 回调成百上千地累积，
// 图片一加载完就批量触发 setProperty + 读 naturalWidth（强制布局）→ 页面假死。
const _thumbLoadHooked = (typeof WeakSet === 'function') ? new WeakSet() : null;

/* 缩略图缩放队列：两个卡顿源分别对付。
 * ① 每张图的回调里「读一张 naturalWidth → 写一张 style」交替进行，浏览器被迫反复同步布局
 *    （layout thrashing）。改成「先集中读、再集中写」，重排从 N 次降到 1 次。
 * ② 表格里改图片宽高会让整张表重新布局（列宽依赖内容宽度）。滚动时一次涌入几十上百张图，
 *    若边滚边改尺寸，就是几十上百次全表重排 → 电脑直接卡死。
 *    所以滚动期间只入队不落地，滚动停下（160ms 无 scroll）后再一次性处理。
 */
const _fitQueue = [];
// 排队去重：靠数组 indexOf 在大批量入队时是 O(n²)，换成 WeakSet 做 O(1)
const _fitQueued = (typeof WeakSet === 'function') ? new WeakSet() : null;
let _fitScheduled = false;
let _fitTimer = null;

const FIT_IDLE_MS = 160;
let _lastScrollAt = 0;
try {
    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
        // scroll 不冒泡，但捕获阶段能从任意滚动容器传到 window，所以用 capture
        window.addEventListener('scroll', () => { _lastScrollAt = Date.now(); }, { passive: true, capture: true });
    }
} catch (e) { /* ignore */ }

function flushFitQueue() {
    if (!_fitQueue.length) return;
    const batch = _fitQueue.splice(0);
    const s = thumbSize; // 取实时值，切换尺寸后不回退
    const n = batch.length;
    // 第一段：集中读，中间不穿插任何写
    const ws = new Array(n);
    const hs = new Array(n);
    for (let i = 0; i < n; i++) {
        ws[i] = batch[i].naturalWidth;
        hs[i] = batch[i].naturalHeight;
    }
    // 第二段：集中写
    for (let i = 0; i < n; i++) {
        const img = batch[i];
        if (_fitQueued) _fitQueued.delete(img); // 以后还能重新入队（换尺寸 / 被移除后重新插入）
        const w = ws[i];
        const h = hs[i];
        if (!w || !h || !img.isConnected) continue;
        // 异步解码：DMM 封面动辄 800×1200，同步解码会卡在渲染那一步。
        // 我们又把图放大了，重解码的分辨率更高，100 张图串起来就是主线程级别的卡顿。
        try { img.decoding = 'async'; } catch (e) { /* ignore */ }
        // 宽高都算成具体像素，不用 width:auto —— 否则布局要依赖图片的固有比例，
        // 图片还没解码完时浏览器可能先按 0 排一次、解码后再排一次，等于两次全表重排。
        if (w >= h) {
            img.style.setProperty('height', s + 'px', 'important');
            img.style.setProperty('width', Math.round((s * w) / h) + 'px', 'important');
        } else {
            img.style.setProperty('width', s + 'px', 'important');
            img.style.setProperty('height', Math.round((s * h) / w) + 'px', 'important');
        }
        img.dataset.mtFitSize = String(s);
        img.dataset.mtFitSrc = img.currentSrc || img.src || '';
    }
}

function runFitFlush() {
    if (!_fitQueue.length) {
        _fitScheduled = false;
        return;
    }
    // 首屏还没加载完（或还在滚动）：先不落地。
    // 首屏阶段每张图加载完就改一次尺寸，等于每张图触发一次整表重排，100 张图就是 100 次；
    // 攒到 load 之后一次性处理，重排次数从 100 降到 1。
    if (pageStillLoading() || Date.now() - _lastScrollAt < FIT_IDLE_MS) {
        if (_fitTimer === null) {
            _fitTimer = setTimeout(() => {
                _fitTimer = null;
                runFitFlush();
            }, 300);
        }
        return;
    }
    _fitScheduled = false;
    flushFitQueue();
}

function scheduleFitFlush() {
    if (_fitScheduled) return;
    _fitScheduled = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(runFitFlush);
    else setTimeout(runFitFlush, 0);
}

function enqueueFit(img) {
    if (!img) return;
    if (_fitQueued) {
        if (_fitQueued.has(img)) return;
        _fitQueued.add(img);
    } else if (_fitQueue.indexOf(img) >= 0) {
        return;
    }
    _fitQueue.push(img);
    scheduleFitFlush();
}

// 列表图按短边 thumbSize 等比缩放：横图压高度、竖图压宽度
function applyListThumbSize() {
    if (FEATURE_OFF.thumb) return; // 排障开关
    const size = thumbSize;
    document.querySelectorAll('.torrent-list__thumbnail').forEach((img) => {
        const src = img.currentSrc || img.src || '';
        if (img.dataset.mtFitSize === String(size) && img.dataset.mtFitSrc === src) return;

        if (img.complete && img.naturalWidth) {
            enqueueFit(img);
        } else if (!_thumbLoadHooked || !_thumbLoadHooked.has(img)) {
            // 每张图只注册一次 load；加载完也走队列批量处理
            if (_thumbLoadHooked) _thumbLoadHooked.add(img);
            img.addEventListener('load', () => enqueueFit(img), { once: true });
        }
    });
}

/* ============================================================
 * 列表大图（二）：种子名完整显示（去掉省略号 / line-clamp 截断，允许换行）
 * ============================================================ */
const FULL_TITLE_CLASS = 'mt-full-title';
const FULL_TITLE_STYLE_ID = 'mt-full-title-style';

// 新版界面：a[href*="/detail/"]（标题在 <strong> 里）；旧版界面：a[href*="details.php"]
const TITLE_LINK_SELECTOR = 'a[href*="/detail/"], a[href*="details.php"]';

// 只处理「种子列表里的一行」，避免影响详情页 / 演员页等其它链接
function inTorrentListRow(link) {
    if (link.closest('tr')) return true;
    return !!link.closest('[class*="torrent-list" i]');
}

function injectFullTitleStyle() {
    if (FEATURE_OFF.title) return; // 排障开关
    if (document.getElementById(FULL_TITLE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = FULL_TITLE_STYLE_ID;
    // 注意：这里一律用 overflow-wrap: break-word，不要用 anywhere。
    // anywhere 会把「最小内容宽度」算成一个字符宽，表格（table-layout:auto）每次算列宽
    // 都要对每个单元格重算内在尺寸 —— 几千行的表能算出 1 秒以上的主线程阻塞。
    // break-word 只在实在放不下时才断词，不参与内在尺寸计算，效果一样但便宜得多。
    style.textContent = `
        /* 新版界面已知结构：直接放开标题，避免首屏渲染时的闪烁 */
        .app-content__inner table.w-full tbody a[href*="/detail/"],
        .app-content__inner table.w-full tbody a[href*="/detail/"] strong {
            white-space: normal !important;
            overflow: visible !important;
            text-overflow: clip !important;
            -webkit-line-clamp: unset !important;
            line-clamp: unset !important;
            max-height: none !important;
            overflow-wrap: break-word !important;
        }
        /* 运行时检测到被截断的元素（含外层包裹容器），统一放开 */
        .${FULL_TITLE_CLASS},
        .${FULL_TITLE_CLASS} * {
            white-space: normal !important;
            overflow: visible !important;
            text-overflow: clip !important;
            -webkit-line-clamp: unset !important;
            line-clamp: unset !important;
            max-height: none !important;
            -webkit-mask-image: none !important;
            mask-image: none !important;
            overflow-wrap: break-word !important;
        }
        /* 上面的 * 会连身高标签一起放开换行，这里单独压回去 */
        .${FULL_TITLE_CLASS} .mt-height-badge {
            white-space: nowrap !important;
        }
    `;
    (document.head || document.documentElement).appendChild(style);
}

// 用计算样式判断某个元素是否真的在被截断（Tailwind truncate / line-clamp / 手动 nowrap）
function isClippedElement(el) {
    let st;
    try {
        st = getComputedStyle(el);
    } catch (e) {
        return false;
    }
    if (!st) return false;
    const clamp = st.getPropertyValue('-webkit-line-clamp') || st.webkitLineClamp || '';
    return (
        st.textOverflow === 'ellipsis' ||
        (clamp && clamp !== 'none') ||
        (st.whiteSpace === 'nowrap' && st.overflow === 'hidden') ||
        (st.getPropertyValue('-webkit-mask-image') || st.maskImage || 'none') !== 'none'
    );
}

// 已检测过截断的节点：getComputedStyle 会强制同步样式重算，列表页每条标题+子元素+4层父元素
// 都调用它是主要卡顿来源。检测结果缓存起来；SPA 替换节点后是新对象，会自然重新检测。
const _fullChecked = (typeof WeakSet === 'function') ? new WeakSet() : null;

// 表格骨架标签：绝不能给它们打 .mt-full-title。
// 继承给 tr/td 后，`.mt-full-title *` 会把这一行（甚至整个 tbody）里所有元素都套上
// white-space/overflow 的 !important 规则 —— 样式重算面积从「一个标题」变成「一整页」，
// 滚动时每次新行进来都要重算，主线程就是这么被堵死 1 秒的。
const STRUCT_TAGS = {
    TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1, TR: 1, TD: 1, TH: 1, COLGROUP: 1, COL: 1,
};

// 找到列表行里被截断的标题元素及其外层容器，打上标记类放开显示
//
// 必须分三段做（登记 → 集中读 → 集中写），不能边检测边加类：
// getComputedStyle 会同步重算样式，而加类又会让样式失效；两者交错时每加一个类就要把整页
// 样式重算一遍。滚动加载几百行时这里有上万个候选节点，就是上万次全量重算 → 页面假死。
function applyFullTitles() {
    if (FEATURE_OFF.title) return; // 排障开关
    injectFullTitleStyle();

    // ① 只遍历登记本轮新出现、尚未检测过的节点：不读样式、不写 DOM
    const fresh = [];
    const collect = (el) => {
        if (!el || !el.classList) return;
        if (STRUCT_TAGS[el.tagName]) return; // 表格骨架不参与（见上面注释）
        if (el.closest && el.closest('.mt-height-badge')) return; // 身高标签不参与
        if (_fullChecked) {
            if (_fullChecked.has(el)) return;
            _fullChecked.add(el);
        }
        if (!el.classList.contains(FULL_TITLE_CLASS)) fresh.push(el);
    };

    document.querySelectorAll(TITLE_LINK_SELECTOR).forEach((link) => {
        if (!inTorrentListRow(link)) return;

        collect(link);
        link.querySelectorAll('*').forEach(collect);

        // 标题链接向上 1~4 层：覆盖「外层 div 负责裁切」的情况
        let p = link.parentElement;
        for (let i = 0; i < 4 && p; i++, p = p.parentElement) collect(p);
    });
    if (!fresh.length) return;

    // ② 集中读：全程只调 getComputedStyle，中间不做任何样式写入
    const clipped = [];
    for (let i = 0; i < fresh.length; i++) {
        if (isClippedElement(fresh[i])) clipped.push(fresh[i]);
    }
    if (!clipped.length) return;

    // ③ 集中写：一次性加类，浏览器只需重算一次样式
    for (let i = 0; i < clipped.length; i++) clipped[i].classList.add(FULL_TITLE_CLASS);
}

/* ============================================================
 * 列表大图（三）：旧版界面补充处理（表格宽度 + DMM 小图）
 * ============================================================ */
function injectOldSiteStyles() {
    if (document.getElementById('mt-oldsite-style')) return;
    const s = document.createElement('style');
    s.id = 'mt-oldsite-style';
    s.textContent = `
        .mx-auto table thead tr th:nth-of-type(2) { width: auto !important; }
        .ant-image .torrent-list__thumbnail { height: auto !important; }
        .mx-auto table colgroup col:nth-of-type(2) { width: auto !important; }
    `;
    (document.head || document.documentElement).appendChild(s);
}

// 旧版界面：把 DMM 缩略图大图换成更小的 jp 版本，并去掉 grid 布局
function fixOldSiteThumbs() {
    const rightBox = document.querySelector('.duration-300');
    if (!rightBox) return;

    const probe = rightBox.querySelector('img[src^="https://pics.dmm.co.jp/digital/video/"]');
    if (probe && probe.parentElement && probe.parentElement.parentElement && probe.parentElement.parentElement.parentElement) {
        probe.parentElement.parentElement.parentElement.classList.remove('grid');
    }

    const pattern = /https:\/\/pics\.dmm\.co\.jp\/digital\/video\/(\w+)\/(\w+)-(\d+)\.jpg/;
    document.querySelectorAll('img[src^="https://pics.dmm.co.jp/digital/video/"]').forEach((item) => {
        // 幂等保护：URL 已被替换过就跳过，避免反复追加 "jp"
        if (item.dataset.mtDmmFixed === '1') return;
        const next = item.src.replace(pattern, 'https://pics.dmm.co.jp/digital/video/$1/$2jp-$3.jpg');
        if (next !== item.src) {
            item.src = next;
            item.dataset.mtDmmFixed = '1';
        }
    });
}

/* ============================================================
 * 扫描调度
 * ============================================================ */
// 选择器串只拼一次：每次 scanAll 都 concat+join 会白白产生一堆临时字符串
const TARGET_SELECTOR_LIST = TARGET_SELECTORS.concat(OPTIONS.extraSelectors).join(',');

function selectorAll() {
    return document.querySelectorAll(TARGET_SELECTOR_LIST);
}

/**
 * 动态查找无法用纯 CSS 选择器表达的扫描目标：
 * - 新版详情页标题（h2 内含 span.align-middle）
 * - 详情页副标题（Ant Design / NexusPHP 表格中标签为「副標題」「副标题」等的单元格）
 */

// 详情页路径判定（列表页无需找副标题的 XPath）
function isDetailPage() {
    try {
        const href = String(window.location.href || '');
        return /\/detail\/|details\.php/i.test(href);
    } catch (e) {
        return false;
    }
}

// XPath 是否可用：探测一次并缓存结果，避免每次扫描都抛异常再 catch
let _xpathOk = null;
function xpathAvailable() {
    if (_xpathOk !== null) return _xpathOk;
    _xpathOk = !!(typeof document.evaluate === 'function' && typeof XPathResult !== 'undefined');
    return _xpathOk;
}

function findDynamicTargets() {
    const results = [];

    // 下面两类目标都只存在于详情页：列表页直接返回，省掉一次全文档 h2 查询 + 5 次 XPath
    if (!isDetailPage()) return results;

    // 新版详情页标题 h2（含 span.align-middle）
    document.querySelectorAll('h2 span.align-middle').forEach((span) => {
        const h2 = span.parentElement;
        if (h2 && h2.tagName === 'H2' && !results.includes(h2)) results.push(h2);
    });

    if (!xpathAvailable()) return results;

    // 详情页副标题：XPath 查找标签单元格旁的内容单元格
    // 覆盖新版 Ant Design（td/th 标签）与旧版 NexusPHP（td 标签）
    try {
        const labels = ['副標題', '副标题', 'Small Description', '小标题', '副題'];
        for (const label of labels) {
            const it = document.evaluate(
                `//td[normalize-space()="${label}"]/following-sibling::td[1]` +
                ` | //th[normalize-space()="${label}"]/following-sibling::td[1]`,
                document, null, XPathResult.UNORDERED_NODE_ITERATOR_TYPE, null,
            );
            let node;
            while ((node = it.iterateNext())) {
                if (node.textContent.trim() && !results.includes(node)) results.push(node);
            }
        }
    } catch (e) {
        _xpathOk = false;
    }

    return results;
}

function scanAll() {
    // 列表大图 / 种子名完整显示 / 旧版处理：始终生效，与身高开关无关
    applyListThumbSize();
    applyFullTitles();
    if (!IS_NEXT_SITE) fixOldSiteThumbs();
    syncFavStar(); // SPA 切页后同步星星的亮/灭
    // 订阅不再自动监测：只在用户点面板按钮时读一次（refreshSubscriptions）。
    // 这里只同步按钮文字，不抓 DOM、不发请求。
    syncSubUI();

    // 身高标签受开关控制（在 processElement 内判断）；「已订阅」标签只看订阅集合
    // querySelectorAll 返回 NodeList（无 concat），先转真数组再合并
    const targets = Array.prototype.slice.call(selectorAll()).concat(findDynamicTargets());
    targets.forEach(processElement);
    // 身高标签插完后再做视图变换：排序要读 data-mt-height，隐藏要读 .mt-sub-badge
    applyListView();
}

let timer = null;
let _lastScanMs = 0;

// 页面还在首屏加载阶段？这时站点自己也在狂渲染（React 首次渲染 + 图片解码），
// 我们再插标签、改图片尺寸，就会和它互相放大：我们改一次 → 它重排一次 → 又一次。
// 超过 8 秒还没 load 完就不再干等（有些站点有长轮询，永远到不了 complete）。
let _bootAt = 0;
function pageStillLoading() {
    try {
        const rs = document.readyState;
        if (rs !== 'loading' && rs !== 'interactive') return false;
        return !(_bootAt && Date.now() - _bootAt > 8000);
    } catch (e) {
        return false;
    }
}

function runScheduledScan() {
    timer = null;
    if (pageStillLoading()) {
        // 首屏还没结束：先攒着，load 之后再扫。boot 里已经同步扫过一次，标签不会缺席。
        timer = setTimeout(runScheduledScan, 500);
        return;
    }
    const t0 = Date.now();
    scanAll();
    _lastScanMs = Date.now() - t0;
}

function scheduleScan() {
    if (timer) return;
    // 单次扫描变慢时自动降频：宁可标签晚一点出现，也不能每秒烧掉好几秒 CPU。
    const delay = _lastScanMs > 150 ? 1000 : 250;
    timer = setTimeout(runScheduledScan, delay);
}

function startObserver() {
    const mo = new MutationObserver((records) => {
        for (const r of records) {
            // 忽略由本脚本插入的节点引起的变更
            if (r.target && r.target.nodeType === 1 &&
                r.target.closest && r.target.closest('.mt-height-badge, .mt-sub-badge')) continue;
            scheduleScan();
            return;
        }
    });
    // 只监听节点增删：列表页的做种数/下载量等文本频繁变动，若监听 characterData
    // 会把每次数字刷新都变成一次全量 scanAll，是卡顿主因。SPA 换文本通常伴随子节点
    // 增删（childList），少量纯文本场景由 boot 的 800/2000/5000ms 兜底扫描覆盖。
    mo.observe(document.body, { childList: true, subtree: true });
}

/* ============================================================
 * 身高开关
 * ============================================================ */
function isEnabled() {
    try {
        const v = localStorage.getItem(ENABLED_KEY);
        return v === null ? true : v === '1';
    } catch (e) {
        return true;
    }
}

function setEnabled(on) {
    try {
        localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
    } catch (e) {
        /* ignore */
    }
    document.querySelectorAll('.mt-height-badge').forEach((b) => {
        b.style.display = on ? '' : 'none';
    });
    if (on) scanAll();
}

/* ============================================================
 * 右下角统一面板：身高开关 + 大图尺寸
 * ============================================================ */
function injectPanelStyle() {
    if (document.getElementById('mt-helper-style')) return;
    const style = document.createElement('style');
    style.id = 'mt-helper-style';
    style.textContent = `
        #mt-height-panel {
            position: fixed;
            right: 14px;
            bottom: 14px;
            z-index: 99999;
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
            max-width: 260px;
            padding: 6px 10px;
            border-radius: 8px;
            font-size: 12px;
            line-height: 1;
            background: rgba(0, 0, 0, 0.72);
            color: #fff;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
            user-select: none;
            font-family: system-ui, -apple-system, sans-serif;
            cursor: move;
            touch-action: none;
        }
        /* 拖动中：禁止选中文字，光标改成抓取态 */
        #mt-height-panel.mt-dragging,
        #mt-height-panel.mt-dragging * {
            cursor: grabbing !important;
            user-select: none !important;
        }
        /* 面板里的按钮/开关点击时仍是手型，不要被 move 光标误导 */
        #mt-height-panel button,
        #mt-height-panel label,
        #mt-height-panel input,
        #mt-height-panel .mt-close {
            cursor: pointer;
        }
        #mt-height-panel label {
            display: flex;
            align-items: center;
            gap: 4px;
            cursor: pointer;
        }
        #mt-height-panel .mt-panel-label {
            opacity: 0.75;
        }
        #mt-height-panel .mt-panel-sep {
            width: 1px;
            height: 14px;
            background: rgba(255, 255, 255, 0.3);
        }
        #mt-height-panel .mt-close {
            cursor: pointer;
            color: #bbb;
            padding: 0 2px;
        }
        .mt-big-size-btn {
            appearance: none;
            border: 1px solid rgba(255, 255, 255, 0.35) !important;
            background: transparent !important;
            color: #fff !important;
            padding: 2px 8px;
            border-radius: 999px;
            cursor: pointer;
            font-size: 12px;
            line-height: 1.4;
            transition: all 0.2s ease;
        }
        .mt-big-size-btn:hover {
            border-color: #177ddc !important;
            color: #177ddc !important;
        }
        .mt-big-size-btn.mt-active {
            background: #177ddc !important;
            border-color: #177ddc !important;
            color: #fff !important;
        }
        #mt-height-panel .mt-fav-star {
            appearance: none;
            border: none !important;
            background: transparent !important;
            color: #8a8a8a !important;
            font-size: 15px;
            line-height: 1;
            padding: 0 2px;
            cursor: pointer;
        }
        #mt-height-panel .mt-fav-star:hover {
            color: #f5c518 !important;
        }
        #mt-height-panel .mt-fav-star.mt-fav-on {
            color: #f5c518 !important;
            text-shadow: 0 0 6px rgba(245, 197, 24, 0.75);
        }
        #mt-height-panel .mt-fav-list-btn {
            appearance: none;
            border: 1px solid rgba(255, 255, 255, 0.35) !important;
            background: transparent !important;
            color: #fff !important;
            padding: 2px 8px;
            border-radius: 999px;
            cursor: pointer;
            font-size: 12px;
            line-height: 1.4;
        }
        #mt-height-panel .mt-fav-list-btn:hover {
            border-color: #f5c518 !important;
            color: #f5c518 !important;
        }
        #mt-height-panel .mt-hide-sub-btn,
        #mt-height-panel .mt-height-sort-btn,
        #mt-height-panel .mt-dedup-btn {
            appearance: none;
            border: 1px solid rgba(255, 255, 255, 0.35) !important;
            background: transparent !important;
            color: #fff !important;
            padding: 2px 8px;
            border-radius: 999px;
            cursor: pointer;
            font-size: 12px;
            line-height: 1.4;
        }
        #mt-height-panel .mt-hide-sub-btn.mt-on {
            border-color: #7ee2a8 !important;
            color: #7ee2a8 !important;
            background: rgba(24, 160, 88, 0.2) !important;
        }
        #mt-height-panel .mt-height-sort-btn.mt-on {
            border-color: #f5c518 !important;
            color: #f5c518 !important;
            background: rgba(245, 197, 24, 0.2) !important;
        }
        #mt-height-panel .mt-dedup-btn.mt-on {
            border-color: #69c0ff !important;
            color: #69c0ff !important;
            background: rgba(24, 144, 255, 0.2) !important;
        }
        #mt-height-panel .mt-site-fav-btn {
            appearance: none;
            border: 1px solid rgba(245, 197, 24, 0.6) !important;
            background: transparent !important;
            color: #f5c518 !important;
            padding: 2px 8px;
            border-radius: 999px;
            cursor: pointer;
            font-size: 12px;
            line-height: 1.4;
        }
        #mt-height-panel .mt-site-fav-btn:hover {
            background: rgba(245, 197, 24, 0.2) !important;
            border-color: #f5c518 !important;
        }
        #mt-height-panel .mt-site-fav-btn.mt-fav-busy {
            opacity: 0.6;
            cursor: progress;
        }
        #mt-height-panel .mt-sub-btn {
            appearance: none;
            border: 1px solid rgba(24, 160, 88, 0.6) !important;
            background: transparent !important;
            color: #7ee2a8 !important;
            padding: 2px 8px;
            border-radius: 999px;
            cursor: pointer;
            font-size: 12px;
            line-height: 1.4;
        }
        #mt-height-panel .mt-sub-btn:hover,
        #mt-height-panel .mt-sub-btn.mt-sub-on {
            background: rgba(24, 160, 88, 0.22) !important;
            border-color: #18a058 !important;
            color: #fff !important;
        }
        #mt-height-panel .mt-sub-btn.mt-loading {
            opacity: 0.55;
            cursor: progress;
        }
        /* 接口读不到时在按钮上留一个可见的「!」，具体原因放在 title / 控制台 */
        #mt-height-panel .mt-sub-btn.mt-sub-error {
            border-color: #d4380d !important;
            color: #ffb3a1 !important;
        }
        #mt-height-panel .mt-sub-btn.mt-sub-error::after {
            content: ' !';
            color: #ff7875;
        }
        #mt-fav-panel {
            position: fixed;
            right: 14px;
            bottom: 56px;
            z-index: 99999;
            width: 300px;
            max-height: 60vh;
            overflow: auto;
            padding: 8px 10px;
            border-radius: 8px;
            font-size: 12px;
            line-height: 1.5;
            background: rgba(0, 0, 0, 0.86);
            color: #fff;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
            font-family: system-ui, -apple-system, sans-serif;
        }
        #mt-fav-panel .mt-fav-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-weight: 600;
            margin-bottom: 4px;
        }
        #mt-fav-panel .mt-close {
            cursor: pointer;
            color: #bbb;
            padding: 0 2px;
        }
        #mt-fav-panel .mt-fav-empty {
            opacity: 0.6;
            padding: 6px 0;
        }
        #mt-fav-panel .mt-fav-item {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 5px 0;
            border-top: 1px solid rgba(255, 255, 255, 0.12);
        }
        #mt-fav-panel .mt-fav-link {
            flex: 1;
            color: #9fd0ff;
            text-decoration: none;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        #mt-fav-panel .mt-fav-link:hover {
            text-decoration: underline;
        }
        #mt-fav-panel .mt-fav-del {
            appearance: none;
            border: none !important;
            background: transparent !important;
            color: #bbb !important;
            font-size: 14px;
            line-height: 1;
            cursor: pointer;
            padding: 0 2px;
        }
        #mt-fav-panel .mt-fav-del:hover {
            color: #ff6b6b !important;
        }
    `;
    (document.head || document.documentElement).appendChild(style);
}

function renderSizePanel() {
    const panel = document.getElementById('mt-height-panel');
    if (!panel) return;
    panel.querySelectorAll('.mt-big-size-btn').forEach((btn) => {
        btn.classList.toggle('mt-active', btn.dataset.size === String(thumbSize));
    });
}

/* ============================================================
 * 面板拖动：右下角浮窗会挡住站点自己的翻页按钮，允许拖到任意位置并记住
 * ============================================================ */
const PANEL_POS_KEY = 'mt_panel_pos';

function readPanelPos() {
    try {
        const raw = localStorage.getItem(PANEL_POS_KEY);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (o && typeof o.left === 'number' && typeof o.top === 'number' &&
            isFinite(o.left) && isFinite(o.top)) return o;
    } catch (e) { /* ignore */ }
    return null;
}

function writePanelPos(pos) {
    try {
        localStorage.setItem(PANEL_POS_KEY, JSON.stringify({
            left: Math.round(pos.left),
            top: Math.round(pos.top),
        }));
    } catch (e) { /* ignore */ }
}

// 限制在视口内，保证整个面板都能被抓到（拿不到视口尺寸时不限制，交给浏览器）
function clampPanelPos(left, top, w, h) {
    const vw = (typeof window !== 'undefined' && window && window.innerWidth) || 0;
    const vh = (typeof window !== 'undefined' && window && window.innerHeight) || 0;
    if (!vw || !vh) return { left: Math.max(0, left), top: Math.max(0, top) };
    const maxL = Math.max(0, vw - Math.min(w || 0, vw));
    const maxT = Math.max(0, vh - Math.min(h || 0, vh));
    return {
        left: Math.min(Math.max(0, left), maxL),
        top: Math.min(Math.max(0, top), maxT),
    };
}

function applyPanelPos(panel, pos) {
    if (!panel || !pos || !panel.style) return;
    panel.style.setProperty('left', Math.round(pos.left) + 'px', 'important');
    panel.style.setProperty('top', Math.round(pos.top) + 'px', 'important');
    // 一旦用 left/top 定位，必须把 right/bottom 让开，否则会互相牵制
    panel.style.setProperty('right', 'auto', 'important');
    panel.style.setProperty('bottom', 'auto', 'important');
}

const PANEL_DRAG_THRESHOLD = 4; // 位移小于它视为点击，不影响按钮

function makePanelDraggable(panel) {
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, startL = 0, startT = 0;
    let lastPos = null;

    const saved = readPanelPos();
    if (saved) applyPanelPos(panel, saved);

    const rectOf = () => (panel.getBoundingClientRect
        ? panel.getBoundingClientRect()
        : { left: 0, top: 0, width: 0, height: 0 });

    const onDown = (ev) => {
        if (ev && ev.button != null && ev.button > 0) return; // 只响应左键 / 触摸
        const rect = rectOf();
        startX = ev && ev.clientX != null ? ev.clientX : 0;
        startY = ev && ev.clientY != null ? ev.clientY : 0;
        startL = rect.left || 0;
        startT = rect.top || 0;
        dragging = true;
        moved = false;
        lastPos = null;
        panel.classList.add('mt-dragging');
    };

    const onMove = (ev) => {
        if (!dragging || !ev) return;
        const dx = (ev.clientX || 0) - startX;
        const dy = (ev.clientY || 0) - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < PANEL_DRAG_THRESHOLD) return;
        moved = true;
        lastPos = clampPanelPos(
            startL + dx,
            startT + dy,
            panel.offsetWidth || 0,
            panel.offsetHeight || 0,
        );
        applyPanelPos(panel, lastPos);
    };

    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        panel.classList.remove('mt-dragging');
        if (moved && lastPos) writePanelPos(lastPos);
    };

    panel.addEventListener('pointerdown', onDown);
    // 移动/抬起挂在 document 上：鼠标拖出面板范围也能继续跟随
    if (typeof document !== 'undefined' && document && document.addEventListener) {
        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('pointerup', onUp, true);
        document.addEventListener('pointercancel', onUp, true);
    }
    // 拖动结束会紧跟着一个 click：吞掉它，避免误触按钮
    panel.addEventListener('click', (ev) => {
        if (!moved) return;
        moved = false;
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (ev && ev.preventDefault) ev.preventDefault();
    }, true);

    // 窗口尺寸变化后，把面板拉回可视区域
    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
        window.addEventListener('resize', () => {
            const cur = readPanelPos();
            if (!cur) return;
            applyPanelPos(panel, clampPanelPos(
                cur.left, cur.top, panel.offsetWidth || 0, panel.offsetHeight || 0,
            ));
        });
    }
}

function buildPanel() {
    if (!OPTIONS.enablePanel || document.getElementById('mt-height-panel')) return;
    injectPanelStyle();

    const wrap = document.createElement('div');
    wrap.id = 'mt-height-panel';

    // 身高开关
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = isEnabled();
    cb.addEventListener('change', () => setEnabled(cb.checked));
    label.appendChild(cb);
    label.appendChild(document.createTextNode('女优身高'));
    wrap.appendChild(label);

    const sep = document.createElement('span');
    sep.className = 'mt-panel-sep';
    wrap.appendChild(sep);

    // 收藏：星星切换当前页，旁边的按钮打开收藏列表
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'mt-fav-star';
    star.textContent = '☆';
    star.addEventListener('click', toggleFav);
    wrap.appendChild(star);

    const favBtn = document.createElement('button');
    favBtn.type = 'button';
    favBtn.className = 'mt-fav-list-btn';
    favBtn.textContent = '收藏列表';
    favBtn.addEventListener('click', toggleFavList);
    wrap.appendChild(favBtn);

    // 订阅：显示已订阅女优数量；点击才读一次（订阅页读 DOM，其它页只读缓存）
    const subBtn = document.createElement('button');
    subBtn.type = 'button';
    subBtn.className = 'mt-sub-btn';
    subBtn.textContent = `${SUB_BADGE_TEXT} 0`;
    subBtn.title = '在订阅页点此读取名单；其它页面点此可查看当前缓存';
    subBtn.addEventListener('click', () => refreshSubscriptions(true));
    wrap.appendChild(subBtn);

    // 一键把带「已订阅」标记的种子收藏到 M-Team 自己的收藏夹（点站点的 star 按钮）
    const siteFavBtn = document.createElement('button');
    siteFavBtn.type = 'button';
    siteFavBtn.className = 'mt-site-fav-btn';
    siteFavBtn.textContent = '收藏已订阅 (0/0)';
    siteFavBtn.title = '已收藏 / 可收藏（带「已订阅」标记的种子）；点此把未收藏的加入 M-Team 收藏夹';
    siteFavBtn.addEventListener('click', startSiteFav);
    wrap.appendChild(siteFavBtn);

    // 列表视图：隐藏已订阅 / 按身高排序
    const hideSubBtn = document.createElement('button');
    hideSubBtn.type = 'button';
    hideSubBtn.className = 'mt-hide-sub-btn';
    hideSubBtn.addEventListener('click', toggleHideSubscribed);
    wrap.appendChild(hideSubBtn);

    const sortBtn = document.createElement('button');
    sortBtn.type = 'button';
    sortBtn.className = 'mt-height-sort-btn';
    sortBtn.addEventListener('click', toggleHeightSort);
    wrap.appendChild(sortBtn);

    // 番号排重：同番号只留最优版本
    const dedupBtn = document.createElement('button');
    dedupBtn.type = 'button';
    dedupBtn.className = 'mt-dedup-btn';
    dedupBtn.addEventListener('click', toggleDedup);
    wrap.appendChild(dedupBtn);

    const sep2 = document.createElement('span');
    sep2.className = 'mt-panel-sep';
    wrap.appendChild(sep2);

    // 大图尺寸
    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'mt-panel-label';
    sizeLabel.textContent = '大图';
    wrap.appendChild(sizeLabel);

    THUMB_SIZES.forEach((s) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mt-big-size-btn';
        btn.dataset.size = String(s);
        btn.textContent = String(s);
        btn.addEventListener('click', () => {
            if (thumbSize === s) return;
            thumbSize = s;
            writeThumbSize(s);
            renderSizePanel();
            applyListThumbSize(); // 立即按新尺寸重绘，不需要刷新页面
        });
        wrap.appendChild(btn);
    });

    const close = document.createElement('span');
    close.className = 'mt-close';
    close.textContent = '×';
    close.addEventListener('click', () => wrap.remove());
    wrap.appendChild(close);

    (document.body || document.documentElement).appendChild(wrap);
    makePanelDraggable(wrap);
    renderSizePanel();
    renderFavUI();
}

/* ============================================================
 * 收藏：把当前页面存下来，面板上的星星可切换、收藏列表可查看
 * ============================================================ */
// GM_* 能跨 m-team 各子域共享；没有 GM_*（或调用失败）时退回 localStorage
function favRead() {
    let raw = null;
    try {
        if (typeof GM_getValue === 'function') raw = GM_getValue(FAV_KEY, null);
        else raw = localStorage.getItem(FAV_KEY);
    } catch (e) {
        raw = null;
    }
    if (!raw) return [];
    try {
        const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        return [];
    }
}

function favWrite(list) {
    const raw = JSON.stringify(list);
    try {
        if (typeof GM_setValue === 'function') GM_setValue(FAV_KEY, raw);
        else localStorage.setItem(FAV_KEY, raw);
    } catch (e) {
        /* ignore */
    }
    lastRaw = raw; // 同步更新本页快照，避免读回来又被当成「别的页面改了」
}

let favs = favRead();

/* ============================================================
 * 收藏数据同步（多标签页）
 * ------------------------------------------------------------
 * 问题：favs 原先只在脚本启动时读一次，之后每个标签页各持一份内存副本。
 * 两个页面同时开着时，B 页基于旧副本写入，就会把 A 页刚加的收藏覆盖掉。
 *
 * 对策（以「存储为唯一真相源」）：
 *  1) 每次操作/渲染前都重新读一次存储，把结果作为权威列表；
 *  2) 写入前先把「存储里的最新数据 + 本页的这次操作」合到一起再落盘，
 *     这样对端新增不会丢；
 *  3) 本页的删除记进墓碑（tombstone），合并时不会被对端旧数据复活；
 *  4) GM 环境用 GM_addValueChange、网页环境用 storage 事件做即时同步，
 *     切回页面（visibilitychange / focus）时再补一次兜底。
 * ============================================================ */
let lastRaw = null;   // 本页最后一次读到的原始字符串
let tombstones = new Map(); // 本页显式删除过的 url -> 时间戳，防止被远端合并复活

function favRaw() {
    let raw = null;
    try {
        if (typeof GM_getValue === 'function') raw = GM_getValue(FAV_KEY, null);
        else raw = localStorage.getItem(FAV_KEY);
    } catch (e) {
        raw = null;
    }
    if (raw == null) return null;
    return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

// 收藏是 m-team 站内链接，统一主机名后再比较，避免 next.m-team.cc / kp.m-team.cc 互认不出
function favKeyOf(url) {
    try {
        const u = new URL(url);
        u.hostname = _host || u.hostname;
        return u.href;
    } catch (e) {
        return url;
    }
}

// 用存储里的数据重建本页内存列表（存储是唯一真相源）
// 被本页显式删除的条目（墓碑）不复活；返回是否有变化
function favMerge(raw) {
    if (raw == null || raw === lastRaw) return false;
    lastRaw = raw;
    let remote;
    try {
        remote = JSON.parse(raw);
    } catch (e) {
        return false;
    }
    if (!Array.isArray(remote)) return false;

    const prev = favs.slice();
    const next = [];
    const seen = new Set();
    remote.forEach((f) => {
        if (!f || !f.url) return;
        const k = favKeyOf(f.url);
        if (seen.has(k)) return;
        if (tombstones.has(k)) return; // 本页删掉的，不被远端复活
        // 保留本页条目对象（可能带本地字段），否则用远端的
        const local = prev.find((x) => favKeyOf(x.url) === k);
        next.push(local || { ...f, url: k });
        seen.add(k);
    });

    const changed = next.length !== prev.length || next.some((f, i) => favKeyOf(f.url) !== favKeyOf(prev[i] && prev[i].url));
    favs = next;
    return changed;
}

// 从存储重新读一次并合并；返回是否有变化
function favRefresh(force) {
    const raw = favRaw();
    if (!force && raw === lastRaw) return false;
    return favMerge(raw);
}

function favIndex(url) {
    const key = favKeyOf(url);
    return favs.findIndex((f) => f && favKeyOf(f.url) === key);
}

// 当前页面的地址与名称，拿不到就返回空，避免在异常环境里抛错
function currentPage() {
    let url = '';
    let name = '';
    try {
        url = window.location.href;
    } catch (e) {
        /* ignore */
    }
    try {
        name = (document.title || '').trim();
    } catch (e) {
        /* ignore */
    }
    // 去掉站名尾巴，如「SSIS-001 xxx - M-Team - 分享率...」
    name = name.split(/\s*[-–|]\s*M-Team\b/i)[0].trim();
    if (!name && url) {
        try {
            name = window.location.pathname;
        } catch (e) {
            /* ignore */
        }
    }
    return { url, name };
}

function isCurrentFavored() {
    const { url } = currentPage();
    return !!url && favIndex(url) >= 0;
}

// 收藏 / 取消收藏当前页
// 关键：先 favRefresh 把「别的标签页刚写进去的数据」拉进来，再改动、再落盘，
// 否则会基于旧副本写入，把对端的新增覆盖掉。
function toggleFav() {
    const { url, name } = currentPage();
    if (!url) return;
    favRefresh(); // 合并远端最新数据（A 页刚收藏的那条会在这里被拉进来）
    const key = favKeyOf(url);
    const i = favs.findIndex((f) => favKeyOf(f.url) === key);
    if (i >= 0) {
        tombstones.set(key, Date.now()); // 记墓碑：本页删掉的条目不复活
        favs.splice(i, 1);
    } else {
        tombstones.delete(key);
        favs.push({ url, name, ts: Date.now() });
    }
    favWrite(favs);
    renderFavUI();
}

function renderFavList() {
    const box = document.getElementById('mt-fav-panel');
    if (!box) return;
    const list = box.querySelector('.mt-fav-items');
    if (!list) return;
    list.textContent = '';

    if (!favs.length) {
        const empty = document.createElement('div');
        empty.className = 'mt-fav-empty';
        empty.textContent = '还没有收藏';
        list.appendChild(empty);
        return;
    }

    favs.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).forEach((f) => {
        const item = document.createElement('div');
        item.className = 'mt-fav-item';

        const link = document.createElement('a');
        link.className = 'mt-fav-link';
        link.href = f.url;
        link.textContent = f.name || f.url;
        link.title = f.name || f.url;

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'mt-fav-del';
        del.textContent = '×';
        del.title = '删除';
        del.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            favRefresh(); // 先对齐远端，避免误删刚同步到的条目
            const key = favKeyOf(f.url);
            tombstones.set(key, Date.now());
            favs = favs.filter((x) => favKeyOf(x.url) !== key);
            favWrite(favs);
            renderFavUI();
        });

        item.appendChild(link);
        item.appendChild(del);
        list.appendChild(item);
    });
}

// 开关收藏列表面板
function toggleFavList() {
    const exist = document.getElementById('mt-fav-panel');
    if (exist) {
        exist.remove();
        return;
    }
    const box = document.createElement('div');
    box.id = 'mt-fav-panel';

    const head = document.createElement('div');
    head.className = 'mt-fav-head';
    const title = document.createElement('span');
    title.textContent = '我的收藏';
    const close = document.createElement('span');
    close.className = 'mt-close';
    close.textContent = '×';
    close.addEventListener('click', () => box.remove());
    head.appendChild(title);
    head.appendChild(close);

    const list = document.createElement('div');
    list.className = 'mt-fav-items';

    box.appendChild(head);
    box.appendChild(list);
    (document.body || document.documentElement).appendChild(box);
    renderFavList();
}

// 同步星星状态、列表按钮上的数量，以及（若已展开）列表内容
// 渲染前强制回读一次存储，保证永远显示别的标签页刚写入的结果
function renderFavUI() {
    favRefresh();
    const star = document.querySelector('#mt-height-panel .mt-fav-star');
    if (star) {
        const on = isCurrentFavored();
        star.dataset.mtFavOn = on ? '1' : '0';
        star.textContent = on ? '★' : '☆';
        star.classList.toggle('mt-fav-on', on);
        star.title = on ? '取消收藏当前页' : '收藏当前页';
    }
    const btn = document.querySelector('#mt-height-panel .mt-fav-list-btn');
    if (btn) btn.textContent = `收藏列表 (${favs.length})`;
    renderFavList();
}

// 扫描时只做「状态真的变了才写」的轻量同步，否则频繁改 DOM 会自己触发扫描
function syncFavStar() {
    const star = document.querySelector('#mt-height-panel .mt-fav-star');
    if (!star) return;
    const on = isCurrentFavored();
    if (star.dataset.mtFavOn === (on ? '1' : '0')) return;
    star.dataset.mtFavOn = on ? '1' : '0';
    star.textContent = on ? '★' : '☆';
    star.classList.toggle('mt-fav-on', on);
    star.title = on ? '取消收藏当前页' : '收藏当前页';
}

/* ============================================================
 * 订阅 UI：面板按钮上的已订阅数量与加载状态
 * ============================================================ */
// 手动点「已订阅」失败时给一个几秒后自动消失的提示：不常驻、不打扰浏览
function showSubToast(msg, withLink) {
    try {
        const old = document.getElementById('mt-sub-toast');
        if (old && old.remove) old.remove();
        const box = document.createElement('div');
        box.id = 'mt-sub-toast';
        box.setAttribute('style', [
            'position:fixed', 'left:50%', 'bottom:64px', 'transform:translateX(-50%)',
            'z-index:100000', 'max-width:min(520px,90vw)', 'padding:8px 12px',
            'border-radius:8px', 'background:rgba(24,24,28,.95)', 'color:#fff',
            'font-size:12px', 'line-height:1.5', 'box-shadow:0 6px 24px rgba(0,0,0,.35)',
        ].join(';'));
        const text = document.createElement('span');
        text.textContent = msg;
        box.appendChild(text);
        if (withLink) {
            const a = document.createElement('a');
            a.setAttribute('href', '/showcase?action=fav');
            a.setAttribute('style', 'color:#7ee2a8;margin-left:8px;text-decoration:underline;cursor:pointer;');
            a.textContent = '打开收藏页同步';
            box.appendChild(a);
        }
        (document.body || document.documentElement).appendChild(box);
        setTimeout(() => {
            try { if (box.remove) box.remove(); } catch (e) { /* ignore */ }
        }, 6000);
    } catch (e) {
        /* 提示失败不影响主流程 */
    }
}

function subButton() {
    try {
        return document.querySelector('#mt-height-panel .mt-sub-btn');
    } catch (e) {
        return null;
    }
}

function subButtonLabel() {
    if (subEngineError) return `${SUB_BADGE_TEXT} !`;
    return `${SUB_BADGE_TEXT} ${subCount}`;
}

function renderSubUI() {
    const btn = subButton();
    if (!btn) return;
    btn.textContent = subButtonLabel();
    btn.classList.toggle('mt-sub-on', subCount > 0);
    btn.title = subEngineError
        ? `订阅功能不可用：${subEngineError}`
        : subCount > 0
            ? `已订阅 ${subCount} 位女优 · 在订阅页点此可重新读取`
            : `还没有订阅名单 · 请打开女优订阅页（/showcase?action=fav）点一次此按钮`;
}

// 扫描时只改真正变化的部分，避免自己触发 MutationObserver 死循环
function syncSubUI() {
    const btn = subButton();
    if (!btn) return;
    const want = subButtonLabel();
    if (btn.textContent !== want) btn.textContent = want;
    const on = subCount > 0;
    if (btn.classList.contains('mt-sub-on') !== on) btn.classList.toggle('mt-sub-on', on);
    if (!siteFavRunning) renderSiteFavUI();
}

/* ============================================================
 * 跨标签页同步监听
 * ============================================================ */
function onFavExternalChange() {
    // 别的页面改了收藏：更新内存、刷新星星与列表
    favRefresh(true);
    renderFavUI();
}

function watchFavStorage() {
    // GM 环境：Tampermonkey 等支持 GM_addValueChange，跨标签页即时通知
    try {
        if (typeof GM_addValueChange === 'function') {
            GM_addValueChange(FAV_KEY, (name, oldValue, newValue, remote) => {
                if (!remote) return; // 忽略自己写的（自己已在 favWrite 里更新过内存）
                onFavExternalChange();
            });
        }
    } catch (e) {
        /* ignore */
    }

    // 网页环境：localStorage 变化会以 storage 事件广播给同源的其他标签页
    // （m-team 各子域不同源，跨子域靠 GM 通道；同子域的两个页面靠这里）
    try {
        window.addEventListener('storage', (e) => {
            if (e && e.key === FAV_KEY) onFavExternalChange();
        });
    } catch (e) {
        /* ignore */
    }

    // 兜底：切回本页 / 窗口获得焦点时补一次同步
    try {
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) onFavExternalChange();
        });
        window.addEventListener('focus', onFavExternalChange);
    } catch (e) {
        /* ignore */
    }
}

/* ============================================================
 * 站点判定 & 启动
 * ============================================================ */
let _host = '';
try {
    _host = (window.location && window.location.hostname) || '';
} catch (e) {
    /* ignore */
}
// 新版界面（Ant Design）固定显示面板；其余视为旧版 NexusPHP
const IS_NEXT_SITE = _host === 'next.m-team.cc' || _host === 'kp.m-team.cc';

function boot() {
    injectStyle();
    if (!IS_NEXT_SITE) injectOldSiteStyles();
    _bootAt = Date.now();
    startObserver();
    buildPanel();
    renderSiteFavUI();
    refreshListViewUI();
    watchFavStorage(); // 监听其它标签页的收藏改动
    // 订阅名单：只读本地缓存秒开，绝不自动联网、不监测页面接口。
    // 需要更新时，请打开订阅页（/showcase?action=fav）点一次「已订阅」按钮。
    refreshSubscriptions(false);

    const firstScan = () => {
        scanAll();
        // 兜底：部分 SPA 场景 MutationObserver 可能漏掉，做几次延迟扫描
        [800, 2000, 5000].forEach((t) => setTimeout(scanAll, t));
    };

    if (pageStillLoading() && typeof window !== 'undefined' && window &&
        typeof window.addEventListener === 'function') {
        // 首屏还在渲染（React 正在 hydration）：这时往标题里插 <span>、改图片尺寸，
        // 会打断站点的首次渲染，React 发现 DOM 对不上就整棵树重新渲染一遍 —— 首屏直接多出秒级阻塞。
        // 所以我们等 load 之后再动手（最多等 3 秒，避免长轮询站点永远等不到 load）。
        let started = false;
        const go = () => {
            if (started) return;
            started = true;
            firstScan();
        };
        window.addEventListener('load', () => setTimeout(go, 0), { once: true });
        setTimeout(go, 3000);
    } else {
        firstScan();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

})();