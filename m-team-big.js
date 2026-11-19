// ==UserScript==
// @name         m-team 列表大图
// @namespace    mteam
// @version      0.4.0
// @description  种子列表/详情/演员列表 小图预览，适配 2025 新版界面；右下角可切换大图尺寸 240 / 360 / 480，切换即时生效；列表种子名不再被省略号截断，可自动换行显示完整。
// @author       Cola.Kot
// @license      MIT
// @match        https://*.m-team.cc/*
// ==/UserScript==

// 基于 XMXM 的「m-team 列表大图」(SleazyFork #495505, MIT License) 修改而来
// @downloadURL / @updateURL 发布到 GreasyFork 后由平台自动生成，不要手写

// ---------------- 大图尺寸设置 ----------------
const THUMB_SIZES = [240, 360, 480];
const THUMB_SIZE_KEY = 'mt_big_thumb_size';

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

// 列表图按短边 thumbSize 等比缩放：横图压高度、竖图压宽度
function applyListThumbSize() {
    const size = thumbSize;
    document.querySelectorAll('.torrent-list__thumbnail').forEach((img) => {
        const src = img.currentSrc || img.src || '';
        if (img.dataset.mtFitSize === String(size) && img.dataset.mtFitSrc === src) return;

        const fit = () => {
            const s = thumbSize; // 取实时值，避免切换尺寸后个别图被旧回调改回去
            const w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) return;
            if (w >= h) {
                img.style.setProperty('height', s + 'px', 'important');
                img.style.setProperty('width', 'auto', 'important');
            } else {
                img.style.setProperty('width', s + 'px', 'important');
                img.style.setProperty('height', 'auto', 'important');
            }
            img.dataset.mtFitSize = String(s);
            img.dataset.mtFitSrc = img.currentSrc || img.src || '';
        };

        if (img.complete && img.naturalWidth) {
            fit();
        } else {
            img.addEventListener('load', fit, { once: true });
        }
    });

    // 列表已经渲染出来（或有图）就挂上尺寸按钮
    if (document.querySelector('.torrent-list__thumbnail')) createSizePanel();
}

// ---------------- 种子名完整显示（去掉省略号 / line-clamp 截断，允许换行） ----------------
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
    if (document.getElementById(FULL_TITLE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = FULL_TITLE_STYLE_ID;
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
            word-break: break-word !important;
            overflow-wrap: anywhere !important;
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
            word-break: break-word !important;
            overflow-wrap: anywhere !important;
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

// 找到列表行里被截断的标题元素及其外层容器，打上标记类放开显示
function applyFullTitles() {
    injectFullTitleStyle();

    const mark = (el) => {
        if (el && el.classList && !el.classList.contains(FULL_TITLE_CLASS) && isClippedElement(el)) {
            el.classList.add(FULL_TITLE_CLASS);
        }
    };

    document.querySelectorAll(TITLE_LINK_SELECTOR).forEach((link) => {
        if (!inTorrentListRow(link)) return;

        mark(link);
        link.querySelectorAll('*').forEach(mark);

        // 标题链接向上 1~4 层：覆盖「外层 div 负责裁切」的情况
        let p = link.parentElement;
        for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
            mark(p);
        }
    });
}

// 列表是前端异步渲染的，DOM 有变化时补处理新出现的图 / 标题
function watchListThumbnails() {
    applyListThumbSize();
    applyFullTitles();
    let timer = null;
    new MutationObserver(() => {
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            applyListThumbSize();
            applyFullTitles();
        }, 200);
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });
}

// ---------------- 右下角尺寸切换按钮 ----------------
function injectSizePanelStyle() {
    if (document.getElementById('mt-big-size-style')) return;
    const style = document.createElement('style');
    style.id = 'mt-big-size-style';
    style.textContent = `
        #mt-big-size-panel {
            position: fixed;
            right: 16px;
            bottom: 16px;
            z-index: 99999;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 10px;
            border-radius: 999px;
            background: rgba(0, 0, 0, 0.72);
            color: #fff;
            font-size: 12px;
            line-height: 1;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        }
        #mt-big-size-panel .mt-big-size-label {
            opacity: 0.75;
        }
        .mt-big-size-btn {
            appearance: none;
            border: 1px solid rgba(255, 255, 255, 0.35) !important;
            background: transparent !important;
            color: #fff !important;
            padding: 3px 10px;
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
    `;
    (document.head || document.documentElement).appendChild(style);
}

function renderSizePanel() {
    const panel = document.getElementById('mt-big-size-panel');
    if (!panel) return;
    panel.querySelectorAll('.mt-big-size-btn').forEach((btn) => {
        btn.classList.toggle('mt-active', btn.dataset.size === String(thumbSize));
    });
}

function createSizePanel() {
    if (document.getElementById('mt-big-size-panel')) return;
    injectSizePanelStyle();

    const panel = document.createElement('div');
    panel.id = 'mt-big-size-panel';

    const label = document.createElement('span');
    label.className = 'mt-big-size-label';
    label.textContent = '大图尺寸';
    panel.appendChild(label);

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
        panel.appendChild(btn);
    });

    (document.body || document.documentElement).appendChild(panel);
    renderSizePanel();
}

function nextSite() {
    createSizePanel(); // 新版界面固定显示尺寸切换
    watchListThumbnails();
}

function oldSite() {
     let dmm_check_count = 0;

    function smallPreview(){
        dmm_check_count++

        if (dmm_check_count > 60) {
            return
        }

        let s = document.createElement("style");
        s.innerHTML=".mx-auto table thead tr th:nth-of-type(2){width: auto !important;}"
        document.querySelector("html>head").appendChild(s);
        let s1 = document.createElement("style");
        s1.innerHTML=".ant-image .torrent-list__thumbnail{height: auto !important;}"
        document.querySelector("html>head").appendChild(s1);
        let s2 = document.createElement("style");
        s2.innerHTML=".mx-auto table colgroup col:nth-of-type(2){width: auto !important;}"
        document.querySelector("html>head").appendChild(s2);

        let dmm_right_box = document.querySelector('.duration-300');
        if (!dmm_right_box){
            setTimeout(smallPreview, 1000);
            return
        }
        let dmm_box = dmm_right_box.querySelector('img[src^="https://pics.dmm.co.jp/digital/video/"]').parentElement.parentElement.parentElement;
        dmm_box.classList.remove('grid');
        let dmm_imgs = dmm_box.querySelectorAll('img[src^="https://pics.dmm.co.jp/digital/video/"]');
        const pattern = /https:\/\/pics\.dmm\.co\.jp\/digital\/video\/(\w+)\/(\w+)-(\d+)\.jpg/;
        dmm_imgs.forEach((item) => {
            item.src = item.src.replace(pattern, 'https://pics.dmm.co.jp/digital/video/$1/$2jp-$3.jpg')
        })

        applyListThumbSize();
    }

    watchListThumbnails();
    setTimeout(smallPreview, 500);
}

// ---------------- 启动 ----------------
(function() {
    "use strict";
    let domain = window.location.hostname;
    if (domain == "next.m-team.cc" || domain == "kp.m-team.cc") {
        nextSite();
    } else {
        oldSite();
    }
})();
