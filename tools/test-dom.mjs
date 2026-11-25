#!/usr/bin/env node
/**
 * test-dom.mjs — 在最小 DOM 环境里真实执行构建产物，验证「名字后面插入身高标签」。
 *
 * 没有 jsdom 依赖，这里实现了一个够用的迷你 DOM（TextNode / Element / TreeWalker /
 * Range.insertNode / querySelectorAll 子集），用来跑 dist 里的最终脚本。
 *
 * 用法：node tools/test-dom.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'm-team-actress-height.user.js');

let DOC = null;

/* ============================ 迷你 DOM ============================ */
// 模拟浏览器 querySelectorAll 的返回值：有 length / 数字索引 / forEach / [Symbol.iterator]，
// 但没有 concat / map / slice / filter —— 真实 NodeList 同样没有这些方法。
class MockNodeList {
    constructor(items) {
        items.forEach((it, i) => { this[i] = it; });
        this.length = items.length;
    }
    forEach(fn, thisArg) {
        for (let i = 0; i < this.length; i++) fn.call(thisArg, this[i], i, this);
    }
    [Symbol.iterator]() {
        let i = 0;
        const self = this;
        return { next() { return i < self.length ? { value: self[i++], done: false } : { value: undefined, done: true }; } };
    }
}

class Node {
    constructor(nodeType) {
        this.nodeType = nodeType;
        this.childNodes = [];
        this.parentNode = null;
    }
    remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
    }
    get parentElement() {
        return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }
    get isConnected() {
        let n = this;
        while (n.parentNode) n = n.parentNode;
        return n === DOC;
    }
    get textContent() {
        if (this.nodeType === 3) return this.nodeValue;
        return this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(v) {
        if (this.nodeType === 3) {
            this.nodeValue = String(v);
            return;
        }
        this.childNodes.forEach((c) => (c.parentNode = null));
        this.childNodes = [];
        if (v !== '' && v != null) this.appendChild(new TextNode(String(v)));
    }
    appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
    }
    insertBefore(child, ref) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        if (ref == null) {
            this.childNodes.push(child);
            return child;
        }
        const i = this.childNodes.indexOf(ref);
        if (i < 0) throw new Error('insertBefore: 参考节点不是子节点');
        this.childNodes.splice(i, 0, child);
        return child;
    }
    removeChild(child) {
        const i = this.childNodes.indexOf(child);
        if (i >= 0) {
            this.childNodes.splice(i, 1);
            child.parentNode = null;
        }
        return child;
    }
    get prevSibling() {
        if (!this.parentNode) return null;
        const i = this.parentNode.childNodes.indexOf(this);
        return i > 0 ? this.parentNode.childNodes[i - 1] : null;
    }
    get nextSibling() {
        if (!this.parentNode) return null;
        const i = this.parentNode.childNodes.indexOf(this);
        return i >= 0 && i + 1 < this.parentNode.childNodes.length
            ? this.parentNode.childNodes[i + 1]
            : null;
    }
}

class TextNode extends Node {
    constructor(value) {
        super(3);
        this.nodeValue = value;
    }
    splitText(offset) {
        const tail = new TextNode(this.nodeValue.slice(offset));
        this.nodeValue = this.nodeValue.slice(0, offset);
        const i = this.parentNode.childNodes.indexOf(this);
        this.parentNode.childNodes.splice(i + 1, 0, tail);
        tail.parentNode = this.parentNode;
        return tail;
    }
}

/** 复合选择器片段：#id / .class / tag / [attr*=value]，可连写 */
function matchCompound(el, part) {
    const re = /([#.]?[\w-]+|\[[\w-]+\*=(["']?)(.*?)\2\])/g;
    let m;
    let any = false;
    while ((m = re.exec(part))) {
        const tok = m[1];
        any = true;
        if (tok.startsWith('#')) {
            if (el.id !== tok.slice(1)) return false;
        } else if (tok.startsWith('.')) {
            if (!el.classList.contains(tok.slice(1))) return false;
        } else if (tok.startsWith('[')) {
            const inner = tok.slice(1, -1);
            const eq = inner.indexOf('*=');
            const attr = inner.slice(0, eq);
            const val = inner.slice(eq + 2).replace(/^["']|["']$/g, '');
            const have = el.getAttribute(attr);
            if (have == null || !have.includes(val)) return false;
        } else if (el.tagName.toLowerCase() !== tok.toLowerCase()) {
            return false;
        }
    }
    return any;
}

/** 极简选择器：支持后代组合（"#id .class"）、同层复合、多选（","） */
function matchesSelector(el, sel) {
    for (const selPart of sel.split(',')) {
        const chain = selPart.trim().split(/\s+/).filter(Boolean);
        if (!chain.length) continue;
        if (!matchCompound(el, chain[chain.length - 1])) continue;
        let node = el.parentElement;
        let ok = true;
        for (let i = chain.length - 2; i >= 0; i--) {
            let found = false;
            while (node) {
                if (matchCompound(node, chain[i])) {
                    found = true;
                    node = node.parentElement;
                    break;
                }
                node = node.parentElement;
            }
            if (!found) {
                ok = false;
                break;
            }
        }
        if (ok) return true;
    }
    return false;
}

class Element extends Node {
    constructor(tagName) {
        super(1);
        this.tagName = tagName.toUpperCase();
        this.attributes = Object.create(null);
        this.classList = {
            _s: new Set(),
            add(c) {
                this._s.add(c);
            },
            contains(c) {
                return this._s.has(c);
            },
            remove(c) {
                this._s.delete(c);
            },
            toggle(c, force) {
                const want = force === undefined ? !this._s.has(c) : !!force;
                if (want) this._s.add(c);
                else this._s.delete(c);
                return want;
            },
            toString() {
                return [...this._s].join(' ');
            },
        };
        this.style = {
            _props: Object.create(null),
            setProperty(k, v) {
                this._props[k] = String(v);
            },
            getPropertyValue(k) {
                return this._props[k] || '';
            },
            removeProperty(k) {
                delete this._props[k];
            },
        };
        this.dataset = {};
        this._listeners = Object.create(null);
        this.id = '';
    }
    setAttribute(k, v) {
        this.attributes[k] = String(v);
        if (k === 'class') String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
        if (k === 'id') this.id = String(v);
        if (k === 'style') {
            // 站点收藏状态就写在 inline style 里（color: gold），测试里要能读到
            String(v).split(';').forEach((pair) => {
                const i = pair.indexOf(':');
                if (i < 0) return;
                this.style.setProperty(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
            });
        }
        if (k.indexOf('data-') === 0) {
            const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            this.dataset[camel] = String(v);
        }
    }
    getAttribute(k) {
        return k in this.attributes ? this.attributes[k] : null;
    }
    removeAttribute(k) {
        delete this.attributes[k];
    }
    get className() {
        return this.classList.toString();
    }
    set className(v) {
        this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean));
    }
    addEventListener(type, fn) {
        (this._listeners[type] || (this._listeners[type] = [])).push(fn);
    }
    dispatch(type, ev) {
        (this._listeners[type] || []).forEach((fn) => fn(ev || {}));
    }
    click() {
        this.dispatch('click', { target: this });
    }
    get isConnected() {
        let n = this;
        while (n.parentNode) n = n.parentNode;
        return n === DOC;
    }
    descendants() {
        const out = [];
        const walk = (n) => {
            for (const c of n.childNodes) {
                out.push(c);
                walk(c);
            }
        };
        walk(this);
        return out;
    }
    querySelectorAll(sel) {
        // 模拟浏览器 NodeList：有 length/索引/forEach，但没有 concat/map/slice。
        // 这样脚本若误用数组方法（如 selectorAll().concat()）会像真浏览器一样抛错。
        return new MockNodeList(
            this.descendants().filter((n) => n.nodeType === 1 && matchesSelector(n, sel)),
        );
    }
    querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
    }
    closest(sel) {
        let n = this;
        while (n && n.nodeType === 1) {
            if (matchesSelector(n, sel)) return n;
            n = n.parentNode;
        }
        return null;
    }
}

/* ---- 迷你 TreeWalker ---- */
class TreeWalker {
    constructor(root, whatToShow, filter) {
        this.filter = filter;
        this.nodes = root.descendants().filter((n) => n.nodeType === 3);
        this.i = -1;
        // 支持 REJECT：如果祖先链上有被 REJECT 的文本节点，则跳过（文本节点无子树，等价于 SKIP）
        if (filter && filter.acceptNode) {
            this.nodes = this.nodes.filter((n) => filter.acceptNode(n) !== 102); // REJECT = 102
        }
        this.currentNode = null;
    }
    nextNode() {
        this.i++;
        if (this.i >= this.nodes.length) return null;
        this.currentNode = this.nodes[this.i];
        return this.currentNode;
    }
}

/* ---- 迷你 Range ---- */
class Range {
    setStart(node, offset) {
        this.startContainer = node;
        this.startOffset = offset;
        return this;
    }
    collapse() {
        return this;
    }
    insertNode(newNode) {
        const container = this.startContainer;
        if (container.nodeType === 3) {
            const len = container.nodeValue.length;
            let ref;
            if (this.startOffset <= 0) {
                ref = container;
            } else if (this.startOffset < len) {
                ref = container.splitText(this.startOffset);
            } else {
                ref = container.nextSibling;
            }
            container.parentNode.insertBefore(newNode, ref);
        } else {
            container.insertBefore(newNode, container.childNodes[this.startOffset] || null);
        }
        return newNode;
    }
}

/* ============================ 构造文档 ============================ */
function buildDocument(opts = {}) {
    const doc = {
        nodeType: 9,
        childNodes: [],
        readyState: 'complete',
        _listeners: Object.create(null),
        addEventListener(type, fn) {
            (this._listeners[type] || (this._listeners[type] = [])).push(fn);
        },
        dispatch(type, ev) {
            (this._listeners[type] || []).forEach((fn) => fn(ev || {}));
        },
        createElement(tag) {
            const el = new Element(tag);
            return el;
        },
        createTextNode(v) {
            return new TextNode(v);
        },
        createRange() {
            return new Range();
        },
        createTreeWalker(root, whatToShow, filter) {
            return new TreeWalker(root, whatToShow, filter);
        },
        getElementById(id) {
            return doc.documentElement.queryAllById(id)[0] || null;
        },
        querySelectorAll(sel) {
            return doc.documentElement.querySelectorAll(sel);
        },
        querySelector(sel) {
            return doc.documentElement.querySelector(sel);
        },
    };

    const html = new Element('html');
    const head = new Element('head');
    const body = new Element('body');
    doc.documentElement = html;
    doc.head = head;
    doc.body = body;
    doc.appendChild = (c) => {
        c.parentNode = doc;
        doc.childNodes.push(c);
        return c;
    };
    doc.appendChild(html);
    html.appendChild(head);
    html.appendChild(body);
    html.queryAllById = (id) => html.descendants().filter((n) => n.nodeType === 1 && n.id === id);

    // 真实场景：列表页每个标题是一个指向 /detail/ 或 details.php 的 <a>
    const mk = (tag, attrs, text) => {
        const el = new Element(tag);
        Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
        if (text) el.appendChild(new TextNode(text));
        return el;
    };
    // 已下载完成的进度条：Ant Design 100% + check-circle
    const mkDoneBar = () => {
        const bar = mk('div', {
            class: 'ant-progress ant-progress-status-success ant-progress-line',
            role: 'progressbar', 'aria-valuenow': '100',
        });
        const indicator = mk('span', { class: 'ant-progress-indicator' });
        indicator.appendChild(mk('span', {
            role: 'img', 'aria-label': 'check-circle', class: 'anticon anticon-check-circle',
        }));
        bar.appendChild(indicator);
        return bar;
    };

    const a1 = mk('a', { href: '/detail/12345' }, 'SSIS-001 三上悠亜 激しい中出し 1080p');
    const a2 = mk('a', { href: 'details.php?id=6789' }, 'ABP-123 【葵つかさ】初共演スペシャル');
    const a3 = mk('a', { href: '/detail/99999' }, 'MIDV-999 橋本ありな 中文字幕');
    // 非目标元素：不应被标注
    const div = mk('div', {}, '三上悠亜 的个人资料页');
    // 无命中
    const a4 = mk('a', { href: '/detail/11111' }, 'HEYZO-0001 1080p BluRay x265 中文字幕');
    // 一条标题里出现两个女优名
    const a5 = mk('a', { href: '/detail/22222' }, 'SSIS-002 【三上悠亜】と葵つかさ 夢の共演');

    body.appendChild(a1);
    body.appendChild(a2);
    body.appendChild(a3);
    body.appendChild(div);
    body.appendChild(a4);
    body.appendChild(a5);

    // ---- 合并功能夹具：种子列表行（标题被截断，应放开）+ 缩略图（应按尺寸缩放）----
    const tr = new Element('tr');
    const tdTitle = new Element('td');
    const titleLink = mk('a', { href: '/detail/55555' }, 'SSIS-003 三上悠亜 中文字幕 完整标题');
    titleLink._computed = {
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maskImage: 'none',
        getPropertyValue: () => 'none',
    };
    // 真实站点上「裁切」也常落在单元格/行上（Tailwind 的 truncate 有时挂在外层 div）。
    // 这里把 td 和 tr 也标记成被裁切，用来验证脚本绝不会把 .mt-full-title 打到表格骨架上。
    const clippedCell = {
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maskImage: 'none',
        getPropertyValue: () => 'none',
    };
    tdTitle._computed = clippedCell;
    tr._computed = clippedCell;
    tdTitle.appendChild(titleLink);
    tr.appendChild(tdTitle);
    body.appendChild(tr);

    const thumb = new Element('img');
    thumb.setAttribute('class', 'torrent-list__thumbnail');
    thumb.setAttribute('src', 'https://example.com/thumb-a.jpg');
    thumb.complete = true;
    thumb.naturalWidth = 300;
    thumb.naturalHeight = 400;
    body.appendChild(thumb);

    // 懒加载中的缩略图：complete=false，数据还没到。用来验证「重复注册 load 监听器」回归。
    const lazyThumb = new Element('img');
    lazyThumb.setAttribute('class', 'torrent-list__thumbnail');
    lazyThumb.setAttribute('src', 'https://example.com/thumb-lazy.jpg');
    lazyThumb.complete = false;
    lazyThumb.naturalWidth = 0;
    lazyThumb.naturalHeight = 0;
    body.appendChild(lazyThumb);

    // manyClipped：模拟无限滚动后一次加载进来的多行截断标题。
    // 用来验证 applyFullTitles 是「先集中检测、再集中加类」，而不是检测一个加一个。
    const clipped = [];
    if (opts.manyClipped) {
        for (let i = 0; i < opts.manyClipped; i++) {
            const row = new Element('tr');
            const cell = new Element('td');
            const a = mk('a', { href: '/detail/80' + i }, 'SSIS-20' + i + ' 三上悠亜 很长的标题会被截断');
            a._computed = {
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maskImage: 'none',
                getPropertyValue: () => 'none',
            };
            cell.appendChild(a);
            row.appendChild(cell);
            body.appendChild(row);
            clipped.push(a);
        }
    }

    // ---- 站点收藏按钮夹具：列表行里站点的 star 按钮，验证「一键收藏已订阅」 ----
    // favStates 每项：{ sub: 是否带已订阅标记, gold: 是否已收藏, done: 是否已下载完成 }
    const favRows = [];
    if (opts.favStates) {
        opts.favStates.forEach((st, i) => {
            const row = new Element('tr');
            // 站点 star 按钮：anticon-star + aria-label，inline style 表示收藏状态
            const btn = new Element('button');
            btn.setAttribute('type', 'button');
            const icon = new Element('span');
            icon.setAttribute('role', 'img');
            icon.setAttribute('aria-label', 'star');
            icon.setAttribute('class', 'anticon anticon-star');
            icon.setAttribute('style', st.gold ? 'color: gold;' : 'color: var(--mt-icon-color);');
            btn.appendChild(icon);
            let clicks = 0;
            btn.addEventListener('click', () => {
                clicks++;
                btn._clicks = clicks;
                // 模拟站点：点完变金色
                icon.setAttribute('style', 'color: gold;');
            });
            btn._clicks = 0;
            row.appendChild(btn);
            const cell = new Element('td');
            if (st.sub) {
                const badge = new Element('span');
                badge.setAttribute('class', 'mt-sub-badge');
                badge.textContent = '已订阅';
                cell.appendChild(badge);
            }
            const link = mk('a', { href: '/detail/9000' + i }, 'SSIS-9' + i + ' 三上悠亜 测试标题');
            cell.appendChild(link);
            // 已完成下载的种子：Ant Design 进度条 100% + check-circle 对勾
            if (st.done) {
                const bar = new Element('div');
                bar.setAttribute('class', 'ant-progress ant-progress-status-success ant-progress-line');
                bar.setAttribute('role', 'progressbar');
                bar.setAttribute('aria-valuenow', '100');
                const indicator = new Element('span');
                indicator.setAttribute('class', 'ant-progress-indicator');
                const check = new Element('span');
                check.setAttribute('role', 'img');
                check.setAttribute('aria-label', 'check-circle');
                check.setAttribute('class', 'anticon anticon-check-circle');
                indicator.appendChild(check);
                bar.appendChild(indicator);
                cell.appendChild(bar);
            }
            row.appendChild(cell);
            body.appendChild(row);
            favRows.push({ row, btn, icon });
        });
    }

    // ---- AI 排除验证：数据集里有女优 AI，但标题里「AI 破解」是标签词 ----
    const aiTr = new Element('tr');
    const aiTd = new Element('td');
    const aiLink = mk('a', { href: '/detail/33333' }, 'AI 破解 中文字幕 4k x265');
    aiTd.appendChild(aiLink);
    const anLink = mk('a', { href: '/detail/33334' }, 'AN 修复 中文字幕');
    aiTr.appendChild(anLink);
    aiTr.appendChild(aiTd);
    body.appendChild(aiTr);

    // ---- 列表视图夹具：身高排序 / 隐藏已订阅 ----
    // heights: 每行的身高数组（空=无身高）；sub: 是否带已订阅标记
    const viewRows = [];
    const viewTbody = new Element('tbody');
    if (opts.viewRows) {
        opts.viewRows.forEach((st, i) => {
            const row = new Element('tr');
            const td = new Element('td');
            const link = mk('a', { href: '/detail/7000' + i }, 'SSIS-7' + i + ' 测试标题 ' + i);
            td.appendChild(link);
            (st.heights || []).forEach((h, j) => {
                const b = new Element('span');
                b.setAttribute('class', 'mt-height-badge');
                b.setAttribute('data-mt-height', String(h));
                b.textContent = ' ' + h + 'cm' + j;
                td.appendChild(b);
            });
            if (st.sub) {
                const badge = new Element('span');
                badge.setAttribute('class', 'mt-sub-badge');
                badge.textContent = '已订阅';
                td.appendChild(badge);
            }
            if (st.done) td.appendChild(mkDoneBar());
            row.appendChild(td);
            viewTbody.appendChild(row);
            viewRows.push(row);
        });
        body.appendChild(viewTbody);
    }

    // ---- 番号排重夹具：标题链接 + br + div 副标题 ----
    const dedupRows = [];
    const dedupTbody = new Element('tbody');
    if (opts.dedupRows) {
        opts.dedupRows.forEach((st, i) => {
            const row = new Element('tr');
            const td = new Element('td');
            td.appendChild(mk('a', { href: '/detail/D' + i }, st.title || ''));
            if (st.subtitle) {
                td.appendChild(mk('br', {}, ''));
                td.appendChild(mk('div', {}, st.subtitle));
            }
            if (st.done) td.appendChild(mkDoneBar());
            row.appendChild(td);
            dedupTbody.appendChild(row);
            dedupRows.push(row);
        });
        body.appendChild(dedupTbody);
    }

    // ---- 订阅页夹具：/showcase?action=fav 的女优卡片 ----
    // 结构照抄前端 showcase chunk：图片链接（无文本）+ 名字链接（有文本）
    const showcase = new Element('div');
    showcase.setAttribute('class', 'showcase-grid-list');
    // cardHref 可切换卡片详情页路径，用来验证站点改版后 DOM 解析是否还命中
    const cardBase = opts.cardHref || '/showcaseDetail';
    const mkCard = (name, id) => {
        const card = new Element('div');
        card.setAttribute('class', 'group flex flex-col rounded-xl');
        // cardNoLink：真实站点上卡片不是 <a>（诊断里 hrefs 全是导航链接，一张卡片链接都没有）
        const tag = opts.cardNoLink ? 'div' : 'a';
        const attrs = opts.cardNoLink ? {} : { href: `${cardBase}?id=${id}` };
        const picLink = new Element(tag);
        if (attrs.href) picLink.setAttribute('href', attrs.href);
        const img = new Element('img');
        img.setAttribute('alt', name); // 真实页面：图片无文本，靠 alt 兜底
        picLink.appendChild(img);
        card.appendChild(picLink);
        card.appendChild(mk(tag, attrs, name));
        return card;
    };
    // noCards：卡片还没渲染出来的场景，校验「点按钮给提示、不误写缓存」
    if (!opts.noCards) {
        showcase.appendChild(mkCard('三上悠亜', 101));
        showcase.appendChild(mkCard('葵つかさ', 102));
    }

    // 可选：模拟 /showcase 的三个 Tab（首页 all / 我的 my / 收藏 fav）
    if (opts.activeTab) {
        const tabs = new Element('div');
        tabs.setAttribute('class', 'ant-tabs');
        for (const key of ['all', 'my', 'fav']) {
            const t = new Element('div');
            t.setAttribute(
                'class',
                key === opts.activeTab ? 'ant-tabs-tab ant-tabs-tab-active' : 'ant-tabs-tab',
            );
            t.setAttribute('data-node-key', key);
            tabs.appendChild(t);
        }
        const pane = new Element('div');
        pane.setAttribute('class', 'ant-tabs-tabpane ant-tabs-tabpane-active');
        // cardOutsidePane：实测站点把收藏列表渲染在 antd pane 之外，pane 里一张卡都没有
        if (!opts.cardOutsidePane) pane.appendChild(showcase);
        tabs.appendChild(pane);
        body.appendChild(tabs);
        if (opts.cardOutsidePane) body.appendChild(showcase);
    } else {
        body.appendChild(showcase);
    }

    DOC = doc;
    return { doc, a1, a2, a3, a4, a5, div, titleLink, thumb, lazyThumb, showcase, clipped, favRows, viewRows, viewTbody, dedupRows, dedupTbody, aiLink, anLink };
}

/* ============================ 执行脚本 ============================ */
function run(opts = {}) {
    if (!fs.existsSync(DIST)) {
        console.error(`缺少构建产物：${DIST}\n请先运行 node tools/build-userscript.mjs`);
        process.exit(1);
    }
    const { doc, a1, a2, a3, a4, a5, div, titleLink, thumb, lazyThumb, clipped, favRows, viewRows, viewTbody, dedupRows, dedupTbody, aiLink, anLink } = buildDocument(opts);
    // 模拟「首屏还在加载」：脚本应当推迟动手，避免打断站点首次渲染
    if (opts.readyState) doc.readyState = opts.readyState;

    const store = new Map(Object.entries(opts.storage || {}));
    const pageWindow = opts.href
        ? { location: { href: opts.href, hostname: new URL(opts.href).hostname } }
        : {};
    // 视口尺寸：clampPanelPos 需要它把存档位置夹回可视区域
    pageWindow.innerWidth = opts.innerWidth || 1000;
    pageWindow.innerHeight = opts.innerHeight || 800;
    if (opts.siteXhr) pageWindow.XMLHttpRequest = opts.siteXhr;
    if (opts.siteFetch) pageWindow.fetch = opts.siteFetch;

    // window 事件：脚本会监听 scroll（滚动期间推迟缩略图缩放）/ storage / focus
    const winListeners = Object.create(null);
    pageWindow.addEventListener = (type, fn) => {
        (winListeners[type] || (winListeners[type] = [])).push(fn);
    };
    pageWindow.removeEventListener = () => {};
    pageWindow.fire = (type, ev) => {
        (winListeners[type] || []).forEach((fn) => {
            try { fn(ev || {}); } catch (e) { /* ignore */ }
        });
    };
    pageWindow.listenerCount = (type) => (winListeners[type] || []).length;

    // 定时器队列：测试里默认不自动执行（否则 boot 的兜底 scanAll 会打乱断言），
    // 需要时手动 drainTimers()。用于验证「滚动停止后才缩放缩略图」的延迟逻辑。
    const timers = [];
    let timerSeq = 0;
    const setTimeoutImpl = (fn, ms) => {
        timerSeq += 1;
        timers.push({ id: timerSeq, fn, ms: ms || 0 });
        return timerSeq;
    };
    const clearTimeoutImpl = (id) => {
        const i = timers.findIndex((x) => x.id === id);
        if (i >= 0) timers.splice(i, 1);
    };
    const drainTimers = () => {
        let guard = 0;
        while (timers.length && guard < 50) {
            guard += 1;
            timers.splice(0).forEach((x) => {
                try { x.fn(); } catch (e) { /* ignore */ }
            });
        }
    };

    const sandbox = {
        document: doc,
        window: pageWindow,
        URL,
        TextEncoder,
        crypto: opts.crypto,
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
        },
        MutationObserver: class {
            observe() {}
            disconnect() {}
        },
        NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
        // onStyleRead：记录每次 getComputedStyle 调用（用于验证「读」「写」没有交错）
        getComputedStyle: (el) => {
            if (opts.onStyleRead) opts.onStyleRead(el, doc);
            return (el && el._computed) || {
                whiteSpace: 'normal',
                overflow: 'visible',
                textOverflow: 'clip',
                maskImage: 'none',
                getPropertyValue: () => 'none',
            };
        },
        setTimeout: setTimeoutImpl,
        clearTimeout: clearTimeoutImpl,
        // 缩略图缩放用 rAF 批量处理；测试里同步执行以便断言结果（真实浏览器是下一帧）
        requestAnimationFrame: (fn) => { fn(); return 1; },
        fetch: opts.fetch, // undefined 时脚本会走「没有可用请求方式」分支
        // 默认吞掉失败诊断的 warn，保持测试输出干净；quiet 时连 log/error 也静默。
        // onWarn / onLog：把脚本的 console 输出抓出来断言（性能自诊断就靠它）
        console: {
            log: opts.onLog || (opts.quiet ? function () {} : console.log),
            warn: opts.onWarn || function () {},
            error: opts.quiet ? function () {} : console.error,
        },
    };
    sandbox.document.documentElement = doc.documentElement;
    vm.createContext(sandbox);

    const code = fs.readFileSync(DIST, 'utf8');
    vm.runInContext(code, sandbox, { filename: 'm-team-actress-height.user.js' });

    return {
        a1, a2, a3, a4, a5, div, titleLink, thumb, lazyThumb, clipped, favRows, viewRows, viewTbody, dedupRows, dedupTbody, aiLink, anLink, doc, store,
        siteXhr: opts.siteXhr,
        pageWindow,
        drainTimers,
    };
}

/* ============================ 断言 ============================ */
let pass = 0, fail = 0;
function t(name, fn) {
    try {
        fn();
        pass++;
        console.log(`  ok  ${name}`);
    } catch (e) {
        fail++;
        console.error(`FAIL  ${name}\n      ${e.message}`);
    }
}

/** 把元素序列化成可读字符串，如 `SSIS-001 三上悠亜[159cm] 激しい...` */
function render(el) {
    return el.childNodes
        .map((c) => (c.nodeType === 3 ? c.nodeValue : `[${c.textContent}]`))
        .join('');
}

function badgeTexts(el) {
    return Array.prototype.slice.call(el.querySelectorAll('.mt-height-badge'))
        .map((b) => b.textContent);
}

console.log('--- DOM 集成测试（真实执行构建产物）---');
const { a1, a2, a3, a4, a5, div, titleLink, thumb, lazyThumb, aiLink, anLink, doc } = run();

t('标题 1：三上悠亜 后面插入 159cm', () => {
    console.log(`      ${render(a1)}`);
    assert.deepStrictEqual(badgeTexts(a1), [' 159cm']);
    assert.ok(render(a1).includes('三上悠亜'));
    assert.ok(render(a1).indexOf('[ 159cm]') > render(a1).indexOf('三上悠亜'));
});

t('标题 2：葵つかさ 后面插入 163cm（旧版 details.php 锚点）', () => {
    console.log(`      ${render(a2)}`);
    assert.deepStrictEqual(badgeTexts(a2), [' 163cm']);
});

t('标题 3：橋本ありな 后面插入 166cm', () => {
    console.log(`      ${render(a3)}`);
    assert.deepStrictEqual(badgeTexts(a3), [' 166cm']);
});

t('标签文本顺序正确（在原名字之后，不打断原文字）', () => {
    const text = a1.textContent;
    assert.strictEqual(text, 'SSIS-001 三上悠亜 159cm 激しい中出し 1080p');
});

t('非目标元素（div）不被标注', () => {
    assert.strictEqual(div.querySelectorAll('.mt-height-badge').length, 0);
});

t('无命中的标题不插入标签', () => {
    console.log(`      ${render(a4)}`);
    assert.strictEqual(a4.querySelectorAll('.mt-height-badge').length, 0);
});

t('匹配：AI 已排除，「AI 破解」不再标注身高（否则会污染排序）', () => {
    assert.deepStrictEqual(badgeTexts(aiLink), [],
        '「AI 破解」是标签词，不该被当成女优 AI 标注；实际=' + JSON.stringify(badgeTexts(aiLink))
        + ' 文本=' + JSON.stringify(aiLink.textContent));
});

t('匹配：AN 也已排除，不会被当成女优标注', () => {
    assert.deepStrictEqual(badgeTexts(anLink), []);
});

t('一条标题内多个名字：逐个插入且互不干扰', () => {
    console.log(`      ${render(a5)}`);
    assert.deepStrictEqual(badgeTexts(a5), [' 159cm', ' 163cm']);
    assert.strictEqual(a5.textContent, 'SSIS-002 【三上悠亜 159cm】と葵つかさ 163cm 夢の共演');
});

/* ---------------- 合并进来的「列表大图」功能 ---------------- */
t('合并：被截断的列表标题被标记 .mt-full-title（放开省略号）', () => {
    assert.ok(titleLink.classList.contains('mt-full-title'));
});

t('合并：注入了放开截断的样式 <style id="mt-full-title-style">', () => {
    const styleEl = doc.getElementById('mt-full-title-style');
    assert.ok(styleEl, '未找到 mt-full-title-style');
    assert.ok(/-webkit-line-clamp:\s*unset/.test(styleEl.textContent));
    assert.ok(/white-space:\s*normal/.test(styleEl.textContent));
});

t('性能：放开截断的 CSS 不得用 overflow-wrap: anywhere（会让表格列宽计算爆炸）', () => {
    const styleEl = doc.getElementById('mt-full-title-style');
    assert.ok(!/overflow-wrap:\s*anywhere/.test(styleEl.textContent),
        'anywhere 会把最小内容宽度算成一个字符；table-layout:auto 的几千行表格每次算列宽都要重算，'
        + '实测把主线程堵 1 秒以上。应改用 break-word');
    assert.ok(/overflow-wrap:\s*break-word/.test(styleEl.textContent), '应使用 break-word');
});

t('性能：截断放开绝不能把类打在 tr/td 上（`.mt-full-title *` 会波及整行甚至整个 tbody）', () => {
    const cell = titleLink.parentElement;      // td
    const row = cell && cell.parentElement;    // tr
    assert.ok(cell && row, '夹具结构不对：标题应在 tr > td 里');
    assert.ok(titleLink.classList.contains('mt-full-title'), '标题本身应被标记');
    assert.ok(!cell.classList.contains('mt-full-title'), 'td 不该被标记（会让整格的元素都被 !important 覆盖）');
    assert.ok(!row.classList.contains('mt-full-title'), 'tr 不该被标记（会让整行的元素都被 !important 覆盖）');
});

{
    // 排障开关：卡顿时用 localStorage.mt_off 逐个关功能来定位
    const offTitle = run({ storage: { mt_off: 'title' }, quiet: true });
    t('排障开关：mt_off=title 时完全不放开标题（定位卡顿来源用）', () => {
        assert.ok(!offTitle.doc.getElementById('mt-full-title-style'), '不该注入放开截断的样式');
        assert.ok(!offTitle.titleLink.classList.contains('mt-full-title'), '不该加标记类');
        assert.deepStrictEqual(badgeTexts(offTitle.a1), [' 159cm'], '身高标签不该受影响');
    });

    const offThumb = run({ storage: { mt_off: 'thumb' }, quiet: true });
    t('排障开关：mt_off=thumb 时不动缩略图尺寸', () => {
        assert.strictEqual(offThumb.thumb.style.getPropertyValue('width'), '');
        assert.strictEqual(offThumb.thumb.style.getPropertyValue('height'), '');
        assert.strictEqual(offThumb.thumb.dataset.mtFitSize, undefined);
    });

    const offBadge = run({ storage: { mt_off: 'badge' }, quiet: true });
    t('排障开关：mt_off=badge 时不插身高标签', () => {
        assert.deepStrictEqual(badgeTexts(offBadge.a1), []);
        // 其它功能仍在：截断放开照旧
        assert.ok(offBadge.titleLink.classList.contains('mt-full-title'));
    });

    const offAll = run({ storage: { mt_off: 'all' }, quiet: true });
    t('排障开关：mt_off=all 一次关掉三个功能（判断是否我们引起的关键对照）', () => {
        assert.deepStrictEqual(badgeTexts(offAll.a1), [], '身高标签没关掉');
        assert.ok(!offAll.doc.getElementById('mt-full-title-style'), '标题放开没关掉');
        assert.strictEqual(offAll.thumb.style.getPropertyValue('width'), '', '缩略图缩放没关掉');
    });
}

t('合并：缩略图按短边 240px 等比缩放（竖图取宽）', () => {
    // 300×400 竖图 → 短边是宽：宽 240，高按比例 240*400/300 = 320（写死像素，不用 auto）
    assert.strictEqual(thumb.style.getPropertyValue('width'), '240px');
    assert.strictEqual(thumb.style.getPropertyValue('height'), '320px');
    assert.strictEqual(thumb.dataset.mtFitSize, '240');
});

t('性能：懒加载缩略图不会被重复注册 load 监听器（累积会导致图片加载时卡死）', () => {
    const countLoad = () => (lazyThumb._listeners.load || []).length;
    assert.strictEqual(countLoad(), 1, 'boot 后应恰好注册 1 个 load 监听器');
    // 反复切换尺寸会反复调用 applyListThumbSize；未加载的图不应被重复注册
    for (const size of ['360', '480', '240']) {
        const btn = doc.querySelector('#mt-height-panel .mt-big-size-btn[data-size="' + size + '"]')
            || Array.prototype.slice.call(doc.querySelectorAll('.mt-big-size-btn'))
                .find((b) => b.dataset.size === size);
        if (btn) btn.dispatch('click');
    }
    assert.strictEqual(
        countLoad(), 1,
        '多次重绘后 load 监听器应仍为 1 个，实际 ' + countLoad() + ' 个（每次扫描累积一个 → 图片加载时批量回调卡死）',
    );
});

{
    // 懒加载图加载完成后，load 回调把图入队并批量缩放（rAF）；验证最终尺寸正确
    const sub = run({ quiet: true });
    const lazy = sub.lazyThumb;
    lazy.complete = true;
    lazy.naturalWidth = 400;
    lazy.naturalHeight = 300;
    (lazy._listeners.load || []).forEach((fn) => fn());
    // 测试沙箱的 requestAnimationFrame 同步执行，入队即 flush，无需等待

    t('性能：懒加载图加载完成后能正确缩放（入队批量处理）', () => {
        // 400×300 横图 → 短边是高：高 240，宽 240*400/300 = 320
        assert.strictEqual(lazy.style.getPropertyValue('height'), '240px');
        assert.strictEqual(lazy.style.getPropertyValue('width'), '320px');
        assert.strictEqual(lazy.dataset.mtFitSize, '240');
    });
}

t('合并：右下角为统一面板（含身高开关 + 大图尺寸按钮）', () => {
    const panel = doc.getElementById('mt-height-panel');
    assert.ok(panel, '未找到统一面板');
    assert.ok(panel.textContent.includes('女优身高'), '缺少身高开关');
    assert.ok(panel.textContent.includes('大图'), '缺少大图尺寸标签');
    const btns = Array.prototype.slice.call(panel.querySelectorAll('.mt-big-size-btn'));
    assert.strictEqual(btns.length, 3);
    assert.ok(btns.some((b) => b.classList.contains('mt-active')), '默认尺寸按钮未高亮');
});

t('合并：身高标签不会被误标记为 mt-full-title', () => {
    titleLink.querySelectorAll('.mt-height-badge').forEach((b) => {
        assert.ok(!b.classList.contains('mt-full-title'));
    });
});

/* ---------------- 订阅：本地缓存 + 点按钮才读，零网络请求 ---------------- */
const tick = (ms) => new Promise((res) => setTimeout(res, ms));

// 一个「一定不会被调用」的 fetch：脚本若发任何网络请求就记录并保持静默
function noNetworkFetch(calls = []) {
    return (url, init) => {
        calls.push({ url, init });
        return Promise.resolve({ ok: false, status: 503, text: async () => '' });
    };
}

const CACHED_NAMES = ['三上悠亜', '葵つかさ'];
const CACHED_SUB = JSON.stringify({
    ts: Date.now(), names: CACHED_NAMES, total: 2, source: 'dom',
});

{
    // 有缓存：启动时秒开，名单与标签都恢复，且全程零网络请求
    const calls = [];
    const sub = run({ fetch: noNetworkFetch(calls), storage: { mt_subscribed_actresses: CACHED_SUB } });
    await tick(50);

    t('订阅：启动只读缓存恢复名单，不发任何网络请求', () => {
        assert.strictEqual(calls.length, 0, '脚本发了网络请求：' + JSON.stringify(calls.map((c) => c.url)));
    });

    t('订阅：命中订阅女优的标题末尾追加「已订阅」', () => {
        console.log(`      ${render(sub.a1)}`);
        const badges = sub.a1.querySelectorAll('.mt-sub-badge');
        assert.strictEqual(badges.length, 1);
        assert.strictEqual(badges[0].textContent, '已订阅');
        assert.strictEqual(sub.a1.childNodes[sub.a1.childNodes.length - 1], badges[0]);
        assert.deepStrictEqual(badgeTexts(sub.a1), [' 159cm']);
    });

    t('订阅：另一位订阅女优同样命中（葵つかさ）', () => {
        assert.strictEqual(sub.a2.querySelectorAll('.mt-sub-badge').length, 1);
    });

    t('订阅：无命中的标题不加「已订阅」标签', () => {
        assert.strictEqual(sub.a4.querySelectorAll('.mt-sub-badge').length, 0);
    });

    t('订阅：一条标题命中多个女优时只加一个「已订阅」，且在最后', () => {
        const badges = sub.a5.querySelectorAll('.mt-sub-badge');
        assert.strictEqual(badges.length, 1);
        assert.strictEqual(sub.a5.childNodes[sub.a5.childNodes.length - 1], badges[0]);
    });

    t('订阅：面板按钮显示缓存里的数量（已订阅 2）', () => {
        const btn = sub.doc.querySelector('#mt-height-panel .mt-sub-btn');
        assert.ok(btn, '缺少订阅按钮');
        assert.strictEqual(btn.textContent, '已订阅 2');
        assert.ok(btn.classList.contains('mt-sub-on'));
    });
}

{
    // 无缓存：启动按钮为 0，不发请求；点一次按钮 → 弹提示引导去订阅页
    const calls = [];
    const sub = run({ fetch: noNetworkFetch(calls) });
    await tick(50);

    t('订阅：无缓存时启动显示「已订阅 0」，不发请求', () => {
        const btn = sub.doc.querySelector('#mt-height-panel .mt-sub-btn');
        assert.strictEqual(btn.textContent, '已订阅 0');
        assert.strictEqual(calls.length, 0, '启动时发了网络请求');
    });

    sub.doc.querySelector('#mt-height-panel .mt-sub-btn').dispatch('click');
    await tick(30);

    t('订阅：名单为 0 时点按钮提示去订阅页，且仍不发请求', () => {
        assert.strictEqual(calls.length, 0, '点按钮发了网络请求');
        const toast = sub.doc.querySelector('#mt-sub-toast');
        assert.ok(toast, '没有弹出提示');
        assert.ok(/女优订阅页|showcase/.test(toast.textContent), '提示里应指向订阅页：' + toast.textContent);
        const link = toast.querySelector('a');
        assert.ok(link, '提示里应有跳转链接');
        assert.ok(/showcase\?action=fav/.test(link.getAttribute('href')));
    });
}

/* ---------------- 订阅页 DOM（/showcase?action=fav）：点按钮才读 ---------------- */
const clickSub = (sub) => sub.doc.querySelector('#mt-height-panel .mt-sub-btn').dispatch('click');

{
    // 收藏页：启动不自动读（按钮仍为 0），点一次按钮才从 DOM 读出名单
    const calls = [];
    const sub = run({ href: 'https://kp.m-team.cc/showcase?action=fav', fetch: noNetworkFetch(calls) });
    await tick(50);

    t('订阅页：启动不自动读 DOM，按钮仍为「已订阅 0」', () => {
        const btn = sub.doc.querySelector('#mt-height-panel .mt-sub-btn');
        assert.strictEqual(btn.textContent, '已订阅 0');
        assert.strictEqual(calls.length, 0, '启动发了网络请求');
    });

    clickSub(sub);
    await tick(30);

    t('订阅页：点一次按钮后从页面 DOM 读出名单并标记', () => {
        const btn = sub.doc.querySelector('#mt-height-panel .mt-sub-btn');
        assert.strictEqual(btn.textContent, '已订阅 2');
        assert.strictEqual(sub.a1.querySelectorAll('.mt-sub-badge').length, 1, 'a1 应标记「已订阅」');
        assert.strictEqual(sub.a2.querySelectorAll('.mt-sub-badge').length, 1, 'a2 应标记「已订阅」');
    });

    t('订阅页：读到的名单写入缓存，图片 alt 与名字链接去重', () => {
        const raw = sub.store.get('mt_subscribed_actresses');
        assert.ok(raw, '没有写入缓存');
        const obj = JSON.parse(raw);
        assert.strictEqual(obj.source, 'dom');
        assert.deepStrictEqual([...obj.names].sort(), ['三上悠亜', '葵つかさ'].sort());
        assert.strictEqual(calls.length, 0, '点按钮发了网络请求');
    });
}

{
    // 不在收藏页：页面上虽然有卡片夹具，点按钮也不把它当成订阅名单
    const sub = run({ href: 'https://kp.m-team.cc/browse' });
    await tick(50);
    clickSub(sub);
    await tick(30);

    t('DOM：不在收藏页时点按钮也不从页面取名字（不误把当前页当订阅）', () => {
        assert.strictEqual(sub.a1.querySelectorAll('.mt-sub-badge').length, 0);
        const btn = sub.doc.querySelector('#mt-height-panel .mt-sub-btn');
        assert.strictEqual(btn.textContent, '已订阅 0');
    });
}

/* ---------------- Tab 区分：首页 / 我的 / 收藏 ---------------- */
{
    // 首页 tab 激活，但 URL 还残留 action=fav（SPA 切 tab 时常见）
    const sub = run({ href: 'https://kp.m-team.cc/showcase?action=fav', activeTab: 'all' });
    await tick(50);
    clickSub(sub);
    await tick(30);

    t('TAB：首页（all）激活时不把整页女优当订阅，即使 URL 带 action=fav', () => {
        assert.strictEqual(sub.a1.querySelectorAll('.mt-sub-badge').length, 0);
        const btn = sub.doc.querySelector('#mt-height-panel .mt-sub-btn');
        assert.strictEqual(btn.textContent, '已订阅 0');
        assert.ok(!sub.store.get('mt_subscribed_actresses'), '不该写入订阅缓存');
    });
}

{
    // 收藏 tab 激活、URL 却没有 action=fav（切 tab 后 URL 未更新）
    const sub = run({ href: 'https://kp.m-team.cc/showcase', activeTab: 'fav' });
    await tick(50);
    clickSub(sub);
    await tick(30);

    t('TAB：收藏（fav）激活时即使 URL 没有 action=fav 也能读取', () => {
        assert.strictEqual(sub.a1.querySelectorAll('.mt-sub-badge').length, 1);
        const btn = sub.doc.querySelector('#mt-height-panel .mt-sub-btn');
        assert.strictEqual(btn.textContent, '已订阅 2');
    });
}

{
    // 实测结构第一步：卡片渲染在激活 pane 之外（pane 里一张没有），要能退回整页
    const sub = run({
        href: 'https://kp.m-team.cc/showcase?action=fav',
        activeTab: 'fav',
        cardOutsidePane: true,
        quiet: true,
    });
    await tick(50);
    clickSub(sub);
    await tick(30);

    t('DOM：卡片渲染在激活 pane 之外时，退回整页抓取', () => {
        const btn = sub.doc.querySelector('#mt-height-panel .mt-sub-btn');
        assert.strictEqual(btn.textContent, '已订阅 2');
    });
}

{
    // 实测结构完整复刻：pane 里没卡片 + 卡片不是链接（hrefs 全是导航），只剩 img alt 可用
    const sub = run({
        href: 'https://kp.m-team.cc/showcase?action=fav',
        activeTab: 'fav',
        cardOutsidePane: true,
        cardNoLink: true,
        quiet: true,
    });
    await tick(50);
    clickSub(sub);
    await tick(30);

    t('DOM：复刻实测结构（pane 空 + 卡片非链接）仍能读到', () => {
        const btn = sub.doc.querySelector('#mt-height-panel .mt-sub-btn');
        assert.strictEqual(btn.textContent, '已订阅 2');
    });
}

{
    // 站点把详情页路径改成 /showcase/xxx
    const sub = run({
        href: 'https://kp.m-team.cc/showcase?action=fav',
        cardHref: '/showcase/person',
        quiet: true,
    });
    await tick(50);
    clickSub(sub);
    await tick(30);

    t('DOM：卡片路径改成 /showcase/... 后仍能读取', () => {
        const btn = sub.doc.querySelector('#mt-height-panel .mt-sub-btn');
        assert.strictEqual(btn.textContent, '已订阅 2');
    });
}

{
    // 路径完全不认识，但只要卡片图片 alt 在，也要能兜住
    const sub = run({
        href: 'https://kp.m-team.cc/showcase?action=fav',
        cardHref: '/person',
        quiet: true,
    });
    await tick(50);
    clickSub(sub);
    await tick(30);

    t('DOM：链接路径完全不认识时，用卡片图片 alt 兜底', () => {
        const btn = sub.doc.querySelector('#mt-height-panel .mt-sub-btn');
        assert.strictEqual(btn.textContent, '已订阅 2');
    });
}

{
    // 卡片还没渲染出来（订阅页无卡片夹具）：点按钮给提示，不写缓存、不发请求
    const calls = [];
    const sub = run({
        href: 'https://kp.m-team.cc/showcase?action=fav',
        noCards: true,
        fetch: noNetworkFetch(calls),
        quiet: true,
    });
    await tick(50);
    clickSub(sub);
    await tick(30);

    t('订阅页：卡片还没出来时点按钮提示稍后再点，不发请求也不写缓存', () => {
        assert.strictEqual(calls.length, 0, '发了网络请求');
        const toast = sub.doc.querySelector('#mt-sub-toast');
        assert.ok(toast, '没有弹出提示');
        assert.ok(/再点一次/.test(toast.textContent), '提示应引导稍后再点：' + toast.textContent);
        assert.ok(!sub.store.get('mt_subscribed_actresses'), '不该写入空缓存');
    });
}

/* ---------------- 一键收藏已订阅：只点站点的 star，跳过已收藏 ---------------- */
{
    const r = run({
        favStates: [
            { sub: true, gold: false },  // 待收藏
            { sub: true, gold: true },   // 已收藏，必须跳过
            { sub: false, gold: false }, // 没订阅标记，不能碰
            { sub: true, gold: false },  // 待收藏
        ],
        quiet: true,
    });
    const btn = r.doc.querySelector('#mt-height-panel .mt-site-fav-btn');

    t('站点收藏：按钮显示「已收藏/可收藏」，只统计带已订阅标记的行', () => {
        assert.ok(btn, '面板缺少一键收藏按钮');
        // 4 行里带已订阅标记的有 3 行，其中 1 行已收藏（gold）
        assert.strictEqual(btn.textContent, '收藏已订阅 (1/3)',
            '应显示 已收藏/可收藏，实际：' + btn.textContent);
        assert.ok(/已收藏 1 \/ 可收藏 3/.test(btn.title), 'title 应说明已收藏与总数：' + btn.title);
    });

    t('站点收藏：gold 星标被识别为已收藏', () => {
        assert.strictEqual(r.favRows[1].btn._clicks, 0);
        assert.ok(r.favRows[1].icon.getAttribute('style').indexOf('gold') >= 0);
    });

    // 点按钮 → 串行点击 → 排空定时器
    btn.dispatch('click');
    r.drainTimers();

    t('站点收藏：只点了待收藏的两条，已收藏与无订阅标记的都不动', () => {
        assert.strictEqual(r.favRows[0].btn._clicks, 1, '第 1 条应被点击');
        assert.strictEqual(r.favRows[1].btn._clicks, 0, '已收藏（gold）不该被点击');
        assert.strictEqual(r.favRows[2].btn._clicks, 0, '无「已订阅」标记不该被点击');
        assert.strictEqual(r.favRows[3].btn._clicks, 1, '第 4 条应被点击');
    });

    t('站点收藏：完成后变成「已收藏=可收藏」', () => {
        assert.strictEqual(btn.textContent, '收藏已订阅 (3/3)', '实际：' + btn.textContent);
        assert.ok(!btn.classList.contains('mt-fav-busy'));
    });
}

{
    // 已下载完成（100% + 对勾）的种子不该再收藏，避免重复订阅
    const r = run({
        favStates: [
            { sub: true, gold: false, done: true },   // 已完成 → 跳过
            { sub: true, gold: false, done: false },  // 未完成 → 待收藏
            { sub: true, gold: false },               // 无进度条 → 待收藏
            { sub: true, gold: false, done: true },   // 已完成 → 跳过
        ],
        quiet: true,
    });
    const btn = r.doc.querySelector('#mt-height-panel .mt-site-fav-btn');

    t('站点收藏：已下载完成（100% 对勾）的行不计入可收藏数', () => {
        assert.strictEqual(btn.textContent, '收藏已订阅 (0/2)',
            '两条已完成应被排除，实际：' + btn.textContent);
        assert.ok(/已收藏 0 \/ 可收藏 2/.test(btn.title), 'title 实际：' + btn.title);
    });

    t('站点收藏：已完成的行一个都不点，只点未完成的两条', () => {
        btn.dispatch('click');
        r.drainTimers();
        assert.strictEqual(r.favRows[0].btn._clicks, 0, '已完成不该被点击');
        assert.strictEqual(r.favRows[1].btn._clicks, 1, '未完成应被点击');
        assert.strictEqual(r.favRows[2].btn._clicks, 1, '无进度条应被点击');
        assert.strictEqual(r.favRows[3].btn._clicks, 0, '已完成不该被点击');
    });
}

{
    // 没有待收藏项时，按钮点击不能误点任何站点按钮
    const r = run({
        favStates: [
            { sub: true, gold: true },
            { sub: false, gold: false },
        ],
        quiet: true,
    });
    const btn = r.doc.querySelector('#mt-height-panel .mt-site-fav-btn');

    t('站点收藏：没有待收藏项时显示 n/n，且不点击任何按钮', () => {
        assert.strictEqual(btn.textContent, '收藏已订阅 (1/1)');
        btn.dispatch('click');
        r.drainTimers();
        assert.strictEqual(r.favRows[0].btn._clicks, 0);
        assert.strictEqual(r.favRows[1].btn._clicks, 0);
    });
}

/* ---------------- 面板拖动：浮窗不能再挡住翻页按钮 ---------------- */
{
    const r = run({ quiet: true });
    const panel = r.doc.getElementById('mt-height-panel');
    // 迷你 DOM 没有布局：给面板一个可测量的盒子，拖动才好断言
    panel.getBoundingClientRect = () => ({ left: 700, top: 500, width: 200, height: 40 });
    panel.offsetWidth = 200;
    panel.offsetHeight = 40;

    t('面板拖动：按下 + 移动后位置改变，并写入 localStorage', () => {
        panel.dispatch('pointerdown', { button: 0, clientX: 720, clientY: 510 });
        assert.ok(panel.classList.contains('mt-dragging'), '拖动中应有 mt-dragging 类');
        r.doc.dispatch('pointermove', { clientX: 520, clientY: 310 });
        r.doc.dispatch('pointerup', {});
        assert.strictEqual(panel.style.getPropertyValue('left'), '500px', '应向左移动 200px');
        assert.strictEqual(panel.style.getPropertyValue('top'), '300px', '应向上移动 200px');
        assert.strictEqual(panel.style.getPropertyValue('right'), 'auto', '必须让开 right');
        assert.strictEqual(panel.style.getPropertyValue('bottom'), 'auto', '必须让开 bottom');
        const saved = JSON.parse(r.store.get('mt_panel_pos'));
        assert.strictEqual(saved.left, 500);
        assert.strictEqual(saved.top, 300);
        assert.ok(!panel.classList.contains('mt-dragging'), '松开后应移除拖动类');
    });

    t('面板拖动：位移小于阈值算点击，不改位置', () => {
        const before = panel.style.getPropertyValue('left');
        panel.dispatch('pointerdown', { button: 0, clientX: 720, clientY: 510 });
        r.doc.dispatch('pointermove', { clientX: 721, clientY: 511 });
        r.doc.dispatch('pointerup', {});
        assert.strictEqual(panel.style.getPropertyValue('left'), before, '轻微抖动不该移动面板');
    });

    t('面板拖动：位置刷新后自动恢复', () => {
        const again = run({ storage: { mt_panel_pos: '{"left":120,"top":80}' }, quiet: true });
        const p2 = again.doc.getElementById('mt-height-panel');
        assert.strictEqual(p2.style.getPropertyValue('left'), '120px');
        assert.strictEqual(p2.style.getPropertyValue('top'), '80px');
    });

    t('面板拖动：存档位置超出视口时，创建时就夹回可视区（不用按 F12）', () => {
        // 用户换小窗口后存档 left=3000/top=2000 落到屏幕外，必须初始化就夹紧
        const again = run({
            storage: { mt_panel_pos: '{"left":3000,"top":2000}' },
            innerWidth: 1000, innerHeight: 800,
            quiet: true,
        });
        const p2 = again.doc.getElementById('mt-height-panel');
        // 迷你 DOM 里 offsetWidth/Height 为 0，夹紧上限就是视口尺寸
        assert.strictEqual(p2.style.getPropertyValue('left'), '1000px',
            '初始化就该夹紧，不应等 resize 才把面板拉回来');
        assert.strictEqual(p2.style.getPropertyValue('top'), '800px');
    });
}

/* ---------------- 列表视图：隐藏已订阅 / 按身高从高到低排序 ---------------- */
{
    // 原始顺序 0..4：身高分别 无 / 159 / [160,166] / 无(已订阅) / 153
    const r = run({
        viewRows: [
            { heights: [] },
            { heights: [159], sub: true },
            { heights: [160, 166] },
            { heights: [], sub: true },
            { heights: [153] },
        ],
        quiet: true,
    });
    const hideBtn = r.doc.querySelector('#mt-height-panel .mt-hide-sub-btn');
    const sortBtn = r.doc.querySelector('#mt-height-panel .mt-height-sort-btn');
    const order = () => r.viewTbody.childNodes.filter((n) => n.nodeType === 1).map((n) => r.viewRows.indexOf(n));

    t('列表视图：两个按钮存在，默认关闭且文案正确', () => {
        assert.ok(hideBtn && sortBtn, '面板缺少隐藏/排序按钮');
        assert.strictEqual(hideBtn.textContent, '隐藏已订阅');
        assert.strictEqual(sortBtn.textContent, '身高排序');
        assert.deepStrictEqual(order(), [0, 1, 2, 3, 4]);
    });

    t('列表视图：按身高从高到低，多身高取最大值，无身高沉底且保持相对顺序', () => {
        sortBtn.dispatch('click');
        assert.deepStrictEqual(order(), [2, 1, 4, 0, 3],
            '应为 166 > 159 > 153 > 无身高(0,3 保持原序)');
        assert.strictEqual(sortBtn.textContent, '恢复原序');
    });

    t('列表视图：关掉排序后恢复原始顺序', () => {
        sortBtn.dispatch('click');
        assert.deepStrictEqual(order(), [0, 1, 2, 3, 4]);
        assert.strictEqual(sortBtn.textContent, '身高排序');
    });

    t('列表视图：隐藏已订阅只加类不删节点，再点恢复', () => {
        hideBtn.dispatch('click');
        assert.ok(r.viewRows[1].classList.contains('mt-hide-row'), '已订阅行应被隐藏');
        assert.ok(r.viewRows[3].classList.contains('mt-hide-row'), '已订阅行应被隐藏');
        assert.ok(!r.viewRows[0].classList.contains('mt-hide-row'), '未订阅行不该被隐藏');
        assert.deepStrictEqual(order(), [0, 1, 2, 3, 4], '隐藏不能删节点');
        assert.strictEqual(hideBtn.textContent, '显示全部');
        hideBtn.dispatch('click');
        assert.ok(!r.viewRows[1].classList.contains('mt-hide-row'));
    });

    t('列表视图：状态写入 localStorage，刷新后自动恢复', () => {
        assert.strictEqual(r.store.get('mt_height_sort'), '0');
        assert.strictEqual(r.store.get('mt_hide_subscribed'), '0');
        sortBtn.dispatch('click');
        hideBtn.dispatch('click');
        assert.strictEqual(r.store.get('mt_height_sort'), '1');
        assert.strictEqual(r.store.get('mt_hide_subscribed'), '1');
    });
}

{
    // 刷新后从缓存恢复状态：排序与隐藏都要自动生效
    const r = run({
        viewRows: [
            { heights: [158] },
            { heights: [170], sub: true },
            { heights: [] },
        ],
        storage: { mt_height_sort: '1', mt_hide_subscribed: '1' },
        quiet: true,
    });
    const order = () => r.viewTbody.childNodes.filter((n) => n.nodeType === 1).map((n) => r.viewRows.indexOf(n));

    t('列表视图：刷新后自动按身高排序并隐藏已订阅', () => {
        assert.deepStrictEqual(order(), [1, 0, 2]);
        assert.ok(r.viewRows[1].classList.contains('mt-hide-row'));
        assert.strictEqual(r.doc.querySelector('#mt-height-panel .mt-height-sort-btn').textContent, '恢复原序');
        assert.strictEqual(r.doc.querySelector('#mt-height-panel .mt-hide-sub-btn').textContent, '显示全部');
    });
}

/* ---------------- 番号排重：同番号只留最优版本 ---------------- */
{
    // 同一番号 SSIS-001 五条：中字 / 破解 / LTX / 4k / 4k+LTX
    // 另有 JUR-478 两条（平局留最前）、一条无番号
    const r = run({
        dedupRows: [
            { title: 'SSIS-001 三上悠亜 中文字幕' },
            { title: 'SSIS-001 三上悠亜 破解版' },
            { title: 'SSIS-001 三上悠亜 LTX' },
            { title: 'SSIS-001 三上悠亜 4K' },
            { title: 'SSIS-001 三上悠亜 4K LTX', subtitle: '4k+ltx' },
            { title: 'JUR-478 葵つかさ 4K' },
            { title: 'JUR-478 葵つかさ 中字' },
            // 4k 与 LTX 直接对比：验证 4k 档位高于 LTX
            { title: 'MIDE-999 4K' },
            { title: 'MIDE-999 LTX' },
            { title: '无番号的一条 4K' },
        ],
        quiet: true,
    });
    const btn = r.doc.querySelector('#mt-height-panel .mt-dedup-btn');
    const hidden = () => r.dedupRows.map((row, i) => row.classList.contains('mt-dup-row') ? i : -1).filter((i) => i >= 0);

    t('番号排重：按钮存在，默认关闭', () => {
        assert.ok(btn, '面板缺少番号排重按钮');
        assert.strictEqual(btn.textContent, '番号排重');
        assert.deepStrictEqual(hidden(), []);
    });

    t('番号排重：同番号按 4k+LTX > 4k > LTX > 破解 > 中字 保留最优', () => {
        btn.dispatch('click');
        // 0 中字 / 1 破解 / 2 LTX / 3 4k 被隐藏；4（4k+LTX）保留
        assert.deepStrictEqual(hidden(), [0, 1, 2, 3, 6, 8],
            '应只保留 4(4k+LTX) / 5(JUR 4k) / 7(MIDE 4k) / 9(无番号)');
        assert.strictEqual(btn.textContent, '恢复重复');
    });

    t('番号排重：平局留最前，JUR-478 中字那条被隐藏', () => {
        assert.ok(r.dedupRows[6].classList.contains('mt-dup-row'), '第 6 行 JUR 中字应被隐藏');
        assert.ok(!r.dedupRows[5].classList.contains('mt-dup-row'), '第 5 行 JUR 4K 应保留');
    });

    t('番号排重：无番号的行不参与，保留显示', () => {
        assert.ok(!r.dedupRows[9].classList.contains('mt-dup-row'));
    });

    t('番号排重：4K 档位高于 LTX（MIDE-999 保留 4K 那条）', () => {
        assert.ok(!r.dedupRows[7].classList.contains('mt-dup-row'), '4K 应保留');
        assert.ok(r.dedupRows[8].classList.contains('mt-dup-row'), 'LTX 应隐藏');
    });

    t('番号排重：只加隐藏类不删节点，关掉后恢复全部', () => {
        assert.strictEqual(r.dedupTbody.childNodes.length, 10, '排重不能删 DOM 节点');
        btn.dispatch('click');
        assert.deepStrictEqual(hidden(), []);
        assert.strictEqual(btn.textContent, '番号排重');
    });

    t('番号排重：状态写入 localStorage，刷新后自动重放', () => {
        btn.dispatch('click');
        assert.strictEqual(r.store.get('mt_dedup'), '1');
        btn.dispatch('click');
        assert.strictEqual(r.store.get('mt_dedup'), '0');
    });
}

{
    // 番号只在副标题里、标题没番号：副标兜底
    const r = run({
        dedupRows: [
            { title: '三上悠亜 作品合集', subtitle: 'ABP-123 4K' },
            { title: '三上悠亜 另一版本', subtitle: 'ABP-123 中字' },
        ],
        storage: { mt_dedup: '1' },
        quiet: true,
    });

    t('番号排重：标题无番号时从副标取，刷新后自动生效', () => {
        assert.ok(r.dedupRows[1].classList.contains('mt-dup-row'), '副标 ABP-123 的第二条应被隐藏');
        assert.ok(!r.dedupRows[0].classList.contains('mt-dup-row'));
        assert.strictEqual(r.doc.querySelector('#mt-height-panel .mt-dedup-btn').textContent, '恢复重复');
    });
}

{
    // 标题与副标各有不同番号：必须以标题为准，不能按副标误合并
    const r = run({
        dedupRows: [
            { title: 'SSIS-001 三上悠亜', subtitle: 'ABP-123' },
            { title: 'SSIS-001 三上悠亜 另一版本', subtitle: 'JUR-478' },
        ],
        storage: { mt_dedup: '1' },
        quiet: true,
    });

    t('番号排重：标题与副标番号不同时只认标题', () => {
        assert.ok(!r.dedupRows[0].classList.contains('mt-dup-row'), '标题同为 SSIS-001，4K 那条应保留');
        assert.ok(r.dedupRows[1].classList.contains('mt-dup-row'), 'SSIS-001 中字那条应隐藏');
    });
}

{
    // 折叠（隐藏已订阅）时，已下载完成的行也要被折叠
    const r = run({
        viewRows: [
            { heights: [] },
            { heights: [], done: true },              // 已下载，无订阅标记
            { heights: [], sub: true },               // 已订阅，未下载
            { heights: [], sub: true, done: true },   // 已订阅且已下载
        ],
        quiet: true,
    });
    const hideBtn = r.doc.querySelector('#mt-height-panel .mt-hide-sub-btn');

    t('折叠：已下载的行也被隐藏，含无订阅标记的', () => {
        hideBtn.dispatch('click');
        assert.ok(r.viewRows[0].classList.contains('mt-hide-row') === false, '普通行不该隐藏');
        assert.ok(r.viewRows[1].classList.contains('mt-hide-row'), '已下载行应被折叠');
        assert.ok(r.viewRows[2].classList.contains('mt-hide-row'), '已订阅行应被折叠');
        assert.ok(r.viewRows[3].classList.contains('mt-hide-row'), '已订阅且已下载应被折叠');
        assert.strictEqual(r.viewTbody.childNodes.length, 4, '折叠不能删节点');
    });

    t('折叠：关掉后已下载的行恢复显示', () => {
        hideBtn.dispatch('click');
        for (const row of r.viewRows) {
            assert.ok(!row.classList.contains('mt-hide-row'));
        }
    });
}

{
    // 排重：已下载优先，但 4k 仍压过已下载的非4k
    const r = run({
        dedupRows: [
            { title: 'SSIS-001 中文字幕', done: true },   // 已下载中字（非4k）
            { title: 'SSIS-001 破解版' },                 // 未下载破解
            { title: 'SSIS-001 4K' },                     // 未下载4k → 应胜出
            { title: 'JUR-478 中字', done: true },        // 已下载中字
            { title: 'JUR-478 LTX' },                     // 未下载LTX → 已下载胜出
            { title: 'MIDE-999 4K' },                     // 未下载4k在前
            { title: 'MIDE-999 4K', done: true },         // 已下载4k在后 → 靠加分胜出
        ],
        storage: { mt_dedup: '1' },
        quiet: true,
    });
    const hidden = () => r.dedupRows.map((row, i) => row.classList.contains('mt-dup-row') ? i : -1).filter((i) => i >= 0);

    t('排重：4k 压过已下载的非4k（SSIS-001 保留 4k 那条）', () => {
        assert.deepStrictEqual(hidden(), [0, 1, 4, 5],
            '0/1 是已下载中字与破解（输给4k），4 是 JUR 未下载LTX（输给已下载中字），5 是 MIDE 未下载4k（输给已下载4k），实际：' + hidden());
    });

    t('排重：已下载的非4k 压过未下载的 LTX（JUR-478 保留已下载那条）', () => {
        assert.ok(!r.dedupRows[3].classList.contains('mt-dup-row'), '已下载中字应保留');
        assert.ok(r.dedupRows[4].classList.contains('mt-dup-row'), '未下载 LTX 应被排掉');
    });

    t('排重：同档位下已下载的 4k 压过未下载的 4k（虽然后出现）', () => {
        assert.ok(r.dedupRows[5].classList.contains('mt-dup-row'), '排在前面的未下载4k应被排掉');
        assert.ok(!r.dedupRows[6].classList.contains('mt-dup-row'), '后出现的已下载4k应胜出');
    });
}

/* ---------------- 性能回归：缩略图缩放必须批量、读写分离、滚动期间不落地 ---------------- */
{
    // 滚动中加载完的图：只入队，不在滚动帧里改尺寸（改尺寸会让整张表格重新布局）
    const r = run({ quiet: true });
    r.pageWindow.fire('scroll'); // 模拟用户正在滚
    r.lazyThumb.complete = true;
    r.lazyThumb.naturalWidth = 300;
    r.lazyThumb.naturalHeight = 200;
    r.lazyThumb.dispatch('load');

    t('性能：滚动期间不立即改缩略图尺寸（避免滚动中反复全表重排）', () => {
        assert.strictEqual(r.lazyThumb.style._props.height, undefined,
            '滚动进行中就把高度写上去了，会导致每张图一次全表重排');
    });

    await tick(200); // 等过 FIT_IDLE_MS
    r.drainTimers();

    t('性能：滚动停止后一次性补做缩放', () => {
        assert.strictEqual(r.lazyThumb.style._props.height, '240px');
        assert.strictEqual(r.lazyThumb.style._props.width, '360px');
    });
}

{
    // 无限滚动一次加载进来多行被截断的标题：检测必须全部做完才加类。
    // 边检测边加类时，每次加类都会让样式失效，下一次 getComputedStyle 又触发全量重算，
    // 几百行就是幾百次全页样式重算 —— 这正是"滚多一点就卡"的元凶。
    const reads = [];
    const r = run({
        manyClipped: 4,
        quiet: true,
        onStyleRead: (el, d) => {
            reads.push(d.querySelectorAll('.mt-full-title').length);
        },
    });

    t('性能：applyFullTitles 先集中检测再集中加类（读写不交错）', () => {
        assert.ok(reads.length >= 4, '样式读取次数太少，用例没覆盖到检测过程：' + reads.length);
        assert.strictEqual(Math.max.apply(null, reads), 0,
            '检测阶段就有元素被加了 .mt-full-title，说明读和写交错了：' + JSON.stringify(reads));
        // 功能不能退化：多行截断标题仍要全部放开
        const marked = r.clipped.filter((a) => a.classList.contains('mt-full-title'));
        assert.strictEqual(marked.length, r.clipped.length, '被截断的标题没有全部放开');
    });
}

t('性能：缩略图缩放入队 + 滚动门控，flush 先读后写（结构断言）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'userscript.template.js'), 'utf8');
    const start = src.indexOf('function applyListThumbSize()');
    assert.ok(start >= 0, '找不到 applyListThumbSize');
    const block = src.slice(start, src.indexOf('\n}', start));
    // load 回调必须入队，不能在回调里直接 setProperty（会造成每张图一次强制布局）
    assert.ok(/addEventListener\('load',\s*\(\)\s*=>\s*enqueueFit\(img\)/.test(block),
        'load 回调必须调用 enqueueFit 入队，而不是直接读写样式');
    assert.ok(!/addEventListener\('load'[\s\S]{0,200}setProperty/.test(block),
        'load 回调里不得直接 setProperty');

    // 滚动门控：记录滚动时间，滚动没停就先不落地
    assert.ok(/addEventListener\('scroll'[\s\S]{0,140}_lastScrollAt\s*=\s*Date\.now\(\)/.test(src),
        '必须监听 scroll 记录滚动时间，才能在滚动期间推迟缩放');
    const runStart = src.indexOf('function runFitFlush()');
    assert.ok(runStart >= 0, '找不到 runFitFlush');
    const runBody = src.slice(runStart, src.indexOf('\n}', runStart));
    const idleIdx = runBody.indexOf('FIT_IDLE_MS');
    const flushIdx = runBody.indexOf('flushFitQueue()');
    assert.ok(idleIdx >= 0 && flushIdx > idleIdx,
        '必须先判断滚动是否已停止，再执行 flushFitQueue');

    // flush 必须先集中读 naturalWidth 再集中写（两段式，避免 layout thrashing）
    const flushStart = src.indexOf('function flushFitQueue()');
    assert.ok(flushStart >= 0, '找不到 flushFitQueue');
    const flushBody = src.slice(flushStart, src.indexOf('\n}\n', flushStart));
    const readIdx = flushBody.indexOf('naturalWidth');
    const writeIdx = flushBody.indexOf('setProperty');
    assert.ok(readIdx >= 0 && writeIdx >= 0 && readIdx < writeIdx,
        'flush 必须先读完所有尺寸，再统一写样式');
});

{
    // 首屏还在加载（React 正在 hydration）时不能动手改 DOM，否则打断站点首次渲染。
    // 用 interactive 模拟真实时序：boot 在 DOMContentLoaded 就跑了，但首屏还没渲染完。
    const r = run({ readyState: 'interactive', quiet: true });

    t('首屏：页面还在加载时不插身高标签（避免打断站点首次渲染）', () => {
        assert.deepStrictEqual(badgeTexts(r.a1), [], '加载阶段不该插标签');
        assert.ok(!r.doc.getElementById('mt-full-title-style'), '加载阶段不该注入放开截断的样式');
    });

    r.doc.readyState = 'complete';
    r.pageWindow.fire('load');
    r.drainTimers();

    t('首屏：页面加载完成后立即补上标签', () => {
        assert.deepStrictEqual(badgeTexts(r.a1), [' 159cm']);
        assert.ok(r.doc.getElementById('mt-full-title-style'), '加载完成后应注入放开截断的样式');
    });
}

t('性能：applyFullTitles 是「登记 → 集中读 → 集中写」三段式（结构断言）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'userscript.template.js'), 'utf8');
    const start = src.indexOf('function applyFullTitles()');
    assert.ok(start >= 0, '找不到 applyFullTitles');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    const probe = body.indexOf('isClippedElement(fresh[i])');
    const write = body.indexOf('classList.add(FULL_TITLE_CLASS)');
    assert.ok(probe >= 0 && write > probe, '必须先完成全部检测，再统一加类');
    const loop = body.slice(body.indexOf('const clipped = [];'), write);
    assert.ok(!/classList\.add/.test(loop), '检测阶段不得同时加类');
});

/* ---------------- 性能回归：processElement 不得逐字符分配对象 ---------------- */
t('性能：processElement 的签名早退在惰性映射之前，不逐字符建对象', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'userscript.template.js'), 'utf8');
    const start = src.indexOf('function processElement(el)');
    assert.ok(start >= 0, '找不到 processElement');
    const body = src.slice(start, src.indexOf('\n}', start));
    const earlyReturn = body.indexOf("=== sig) return");
    const spansDecl = body.indexOf('const spans = []');
    assert.ok(earlyReturn >= 0, '找不到签名早退');
    assert.ok(spansDecl >= 0, '找不到惰性的 spans 映射');
    assert.ok(
        earlyReturn < spansDecl,
        '签名早退必须在构建字符映射之前，否则每个已处理标题仍会逐字符分配对象（GC 抖动/假死）',
    );
    // 不能再出现 per-character 的 {node, off} 分配
    assert.ok(
        !/for\s*\([^)]*\)\s*anchors\.push\(/.test(body),
        '不得为每个字符 push 一个对象',
    );
});

/* ---------------- 误装模板的防护 ---------------- */
t('误装模板（未构建）时给出可读提示并安全退出，不抛 ReferenceError', () => {
    const errors = [];
    const sandbox = {
        console: { error: (m) => errors.push(String(m)), log() {}, warn() {} },
        window: {},
        document: {},
        localStorage: { getItem: () => null, setItem() {} },
        setTimeout: () => 0,
        clearTimeout: () => {},
    };
    vm.createContext(sandbox);
    const tpl = fs.readFileSync(path.join(ROOT, 'src', 'userscript.template.js'), 'utf8');
    assert.doesNotThrow(() => vm.runInContext(tpl, sandbox));
    assert.ok(
        errors.some((m) => m.includes('未构建的模板')),
        '没有输出「未构建的模板」提示',
    );
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);