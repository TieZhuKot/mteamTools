#!/usr/bin/env node
/**
 * test-fav-sync.mjs — 多标签页收藏同步回归测试。
 *
 * 复现场景：A、B 两个页面同时打开，A 页收藏 -> B 页再收藏 -> 两条都要在。
 * 做法：复用 test-dom.mjs 的迷你 DOM，真实执行 dist 里的脚本两次（两个独立沙箱 /
 *       两个「标签页」），共享一份 localStorage 与一份跨页面事件总线（模拟 storage 事件）。
 *
 * 用法：node tools/test-fav-sync.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'm-team-actress-height.user.js');

const FAV_KEY = 'mt_fav_list';
const HOST = 'next.m-team.cc';

/* ============================ 共享后端 ============================ */

// 模拟浏览器存储：一份数据 + 跨页面广播（storage 事件语义：不通知写入者自己）
class SharedStore {
    constructor() {
        this.data = new Map();
        this.listeners = [];
    }
    getItem(k) {
        return this.data.has(k) ? this.data.get(k) : null;
    }
    setItem(k, v, fromPage) {
        const old = this.getItem(k);
        this.data.set(k, String(v));
        this.listeners.forEach((l) => {
            if (l.page !== fromPage) l.fn({ key: k, oldValue: old, newValue: String(v) });
        });
    }
    readList() {
        const raw = this.getItem(FAV_KEY);
        if (!raw) return [];
        try { return JSON.parse(raw); } catch (e) { return []; }
    }
}

/* ============================ 迷你 DOM（与 test-dom.mjs 同款，按选择器需要做了扩展） ============================ */

let DOC = null;

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
        if (this.nodeType === 3) { this.nodeValue = String(v); return; }
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
        if (ref == null) { this.childNodes.push(child); return child; }
        const i = this.childNodes.indexOf(ref);
        if (i < 0) throw new Error('insertBefore: 参考节点不是子节点');
        this.childNodes.splice(i, 0, child);
        return child;
    }
    removeChild(child) {
        const i = this.childNodes.indexOf(child);
        if (i >= 0) { this.childNodes.splice(i, 1); child.parentNode = null; }
        return child;
    }
    get nextSibling() {
        if (!this.parentNode) return null;
        const i = this.parentNode.childNodes.indexOf(this);
        return i >= 0 && i + 1 < this.parentNode.childNodes.length
            ? this.parentNode.childNodes[i + 1] : null;
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

/** 单个「复合选择器」匹配（不含后代关系）：支持 tag、#id、.class、[attr*=v] 的任意组合 */
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

/** 选择器：支持后代组合（"a b"）、同层复合（"tag.cls[attr*=v]"）、多选（","） */
function matchesSelector(el, sel) {
    for (const selPart of sel.split(',')) {
        const chain = selPart.trim().split(/\s+/).filter(Boolean);
        if (!chain.length) continue;
        // 从右往左逐级匹配祖先，支持 "a b" 这种后代组合
        if (!matchCompound(el, chain[chain.length - 1])) continue;
        let node = el.parentElement;
        let ok = true;
        for (let i = chain.length - 2; i >= 0; i--) {
            let found = false;
            while (node) {
                if (matchCompound(node, chain[i])) { found = true; node = node.parentElement; break; }
                node = node.parentElement;
            }
            if (!found) { ok = false; break; }
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
            add(c) { this._s.add(c); },
            contains(c) { return this._s.has(c); },
            remove(c) { this._s.delete(c); },
            toggle(c, force) {
                const want = force === undefined ? !this._s.has(c) : !!force;
                if (want) this._s.add(c); else this._s.delete(c);
                return want;
            },
            toString() { return [...this._s].join(' '); },
        };
        this.style = {
            _props: Object.create(null),
            setProperty(k, v) { this._props[k] = String(v); },
            getPropertyValue(k) { return this._props[k] || ''; },
            removeProperty(k) { delete this._props[k]; },
        };
        this.dataset = {};
        this.id = '';
        this._listeners = Object.create(null);
    }
    setAttribute(k, v) {
        this.attributes[k] = String(v);
        if (k === 'class') String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
        if (k === 'id') this.id = String(v);
        if (k.indexOf('data-') === 0) {
            const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            this.dataset[camel] = String(v);
        }
    }
    getAttribute(k) {
        return k in this.attributes ? this.attributes[k] : null;
    }
    removeAttribute(k) { delete this.attributes[k]; }
    get className() { return this.classList.toString(); }
    set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); }
    addEventListener(type, fn) {
        (this._listeners[type] || (this._listeners[type] = [])).push(fn);
    }
    dispatch(type, ev) {
        (this._listeners[type] || []).forEach((fn) => fn(ev || {}));
    }
    descendants() {
        const out = [];
        const walk = (n) => { for (const c of n.childNodes) { out.push(c); walk(c); } };
        walk(this);
        return out;
    }
    querySelectorAll(sel) {
        return this.descendants().filter((n) => n.nodeType === 1 && matchesSelector(n, sel));
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    closest(sel) {
        let n = this;
        while (n && n.nodeType === 1) {
            if (matchesSelector(n, sel)) return n;
            n = n.parentNode;
        }
        return null;
    }
}

/* ============================ 构建一个「标签页」 ============================ */

/**
 * @param {SharedStore} store 共享存储
 * @param {string} pageUrl    该页面的地址
 * @param {string} title      该页面的 document.title
 */
function makePage(store, pageUrl, title) {
    DOC = null;
    const page = { page: null };

    const doc = {
        nodeType: 9,
        childNodes: [],
        readyState: 'complete',
        title,
        hidden: false,
        _listeners: Object.create(null),
        addEventListener(type, fn) {
            (this._listeners[type] || (this._listeners[type] = [])).push(fn);
        },
        dispatch(type, ev) {
            (this._listeners[type] || []).forEach((fn) => fn(ev || {}));
        },
        createElement: (tag) => new Element(tag),
        createTextNode: (v) => new TextNode(v),
        createRange: () => ({ setStart() { return this; }, collapse() { return this; }, insertNode() { return null; } }),
        createTreeWalker: () => ({ currentNode: null, nextNode: () => null }),
        getElementById(id) {
            return doc.documentElement.descendants().find((n) => n.nodeType === 1 && n.id === id) || null;
        },
        querySelectorAll(sel) { return doc.documentElement.querySelectorAll(sel); },
        querySelector(sel) { return doc.documentElement.querySelector(sel); },
    };

    const html = new Element('html');
    const head = new Element('head');
    const body = new Element('body');
    doc.documentElement = html;
    doc.head = head;
    doc.body = body;
    doc.appendChild = (c) => { c.parentNode = doc; doc.childNodes.push(c); return c; };
    doc.appendChild(html);
    html.appendChild(head);
    html.appendChild(body);

    DOC = doc;

    const win = {
        location: { href: pageUrl, hostname: HOST, pathname: new URL(pageUrl).pathname },
        _l: {},
        addEventListener(type, fn) { win._l[type] = (win._l[type] || []).concat(fn); },
        dispatch(type, ev) { (win._l[type] || []).forEach((fn) => fn(ev || {})); },
    };
    win.window = win;

    const sandbox = {
        document: doc,
        window: win,
        location: win.location,
        URL,
        localStorage: {
            getItem: (k) => store.getItem(k),
            setItem: (k, v) => store.setItem(k, v, page.page),
        },
        MutationObserver: class { observe() {} disconnect() {} },
        NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
        getComputedStyle: () => ({
            whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip',
            maskImage: 'none', getPropertyValue: () => 'none',
        }),
        setTimeout: (fn) => {
            try { if (fn) fn(); } catch (e) { console.error('    [page] 定时回调抛错:', e.message); }
            return 0;
        },
        clearTimeout: () => {},
        console,
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(DIST, 'utf8'), sandbox, { filename: 'user.js' });

    // 注册跨页面监听：storage 事件在 window 上派发，脚本在 window/document 上都能收到
    store.listeners.push({
        page,
        fn: (ev) => { win.dispatch('storage', ev); doc.dispatch('storage', ev); },
    });

    const starEl = () => doc.querySelector('#mt-height-panel .mt-fav-star');
    const listBtnEl = () => doc.querySelector('#mt-height-panel .mt-fav-list-btn');
    const panelEl = () => doc.getElementById('mt-fav-panel');

    return {
        doc,
        clickStar() {
            const s = starEl();
            assert.ok(s, '找不到收藏星星按钮');
            s.dispatch('click');
        },
        openList() {
            const b = listBtnEl();
            assert.ok(b, '找不到收藏列表按钮');
            b.dispatch('click');
        },
        closeList() {
            const b = listBtnEl();
            if (b) b.dispatch('click');
        },
        panel() { return panelEl(); },
        listItems() {
            const p = panelEl();
            if (!p) return [];
            return p.querySelectorAll('.mt-fav-link')
                .map((a) => ({ text: a.textContent, href: a.getAttribute('href') }));
        },
        delButtons() {
            const p = panelEl();
            return p ? p.querySelectorAll('.mt-fav-del') : [];
        },
        delFirst() {
            const btns = this.delButtons();
            assert.ok(btns.length, '找不到删除按钮');
            btns[0].dispatch('click', { preventDefault() {}, stopPropagation() {} });
        },
        countText() {
            const b = listBtnEl();
            return b ? b.textContent : '';
        },
        starOn() {
            const s = starEl();
            return s ? s.dataset.mtFavOn === '1' : null;
        },
        visibilityChange(hidden) {
            doc.hidden = hidden;
            doc.dispatch('visibilitychange');
        },
        focus() { win.dispatch('focus'); },
    };
}

/* ============================ 测试 ============================ */
let pass = 0, fail = 0;
function t(name, fn) {
    try {
        fn();
        pass++;
        console.log(`  ok  ${name}`);
    } catch (e) {
        fail++;
        console.log(`  FAIL ${name}\n       ${e.message}`);
    }
}

console.log('--- 多标签页收藏同步测试（真实执行构建产物）---');

// 场景 1：核心 bug —— A 收藏、B 收藏，两条都要在
t('A 页收藏后 B 页再收藏，两条收藏都保留（不互相覆盖）', () => {
    const store = new SharedStore();
    const A = makePage(store, `https://${HOST}/detail/aaa`, 'AAA-001 三上悠亜 - M-Team');
    const B = makePage(store, `https://${HOST}/detail/bbb`, 'BBB-002 葵つかさ - M-Team');

    A.clickStar();
    assert.strictEqual(store.readList().length, 1, 'A 页收藏后应有 1 条');

    B.clickStar();
    const list = store.readList();
    assert.strictEqual(list.length, 2, `B 页收藏后应有 2 条，实际 ${list.length} 条`);
    assert.deepStrictEqual(
        list.map((f) => f.name).sort(),
        ['AAA-001 三上悠亜', 'BBB-002 葵つかさ'],
    );
});

// 场景 2：A 页收藏后，B 页数量与列表应即时同步（无需刷新）
t('A 页收藏后 B 页数量与列表自动同步', () => {
    const store = new SharedStore();
    const A = makePage(store, `https://${HOST}/detail/aaa`, 'AAA-001 三上悠亜 - M-Team');
    const B = makePage(store, `https://${HOST}/detail/bbb`, 'BBB-002 葵つかさ - M-Team');

    assert.strictEqual(B.countText(), '收藏列表 (0)');
    A.clickStar();
    assert.strictEqual(B.countText(), '收藏列表 (1)', 'B 页应通过 storage 事件即时同步');

    B.openList();
    const items = B.listItems();
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].text, 'AAA-001 三上悠亜');
});

// 场景 3：星星状态跟随「当前页是否被收藏」
t('A 页收藏后自己的星星点亮，别的页面不受影响；新开同页标签页直接点亮', () => {
    const store = new SharedStore();
    const urlA = `https://${HOST}/detail/same`;
    const A = makePage(store, urlA, 'SAME-001 橋本ありな - M-Team');
    const B = makePage(store, `https://${HOST}/detail/other`, 'OTH-002 波多野結衣 - M-Team');

    assert.strictEqual(A.starOn(), false);
    assert.strictEqual(B.starOn(), false);

    A.clickStar();
    assert.strictEqual(A.starOn(), true, 'A 页收藏后自己星星应点亮');
    assert.strictEqual(B.starOn(), false, 'B 页不是同一页，星星不该点亮');

    const C = makePage(store, urlA, 'SAME-001 橋本ありな - M-Team');
    assert.strictEqual(C.starOn(), true, '新开的同页标签页应直接点亮');
});

// 场景 4：B 页删掉 A 页收藏的条目，A 页同步熄灭
t('B 页删掉 A 页收藏的条目后，A 页星星与数量同步更新', () => {
    const store = new SharedStore();
    const A = makePage(store, `https://${HOST}/detail/aaa`, 'AAA-001 三上悠亜 - M-Team');
    const B = makePage(store, `https://${HOST}/detail/bbb`, 'BBB-002 葵つかさ - M-Team');

    A.clickStar();
    assert.strictEqual(A.starOn(), true);
    assert.strictEqual(B.countText(), '收藏列表 (1)');

    B.openList();
    assert.strictEqual(B.listItems().length, 1, 'B 页列表应同步到 A 页的收藏');
    B.delFirst();

    assert.strictEqual(store.readList().length, 0, '存储里应剩 0 条');
    assert.strictEqual(A.starOn(), false, 'A 页星星应同步熄灭');
    assert.strictEqual(A.countText(), '收藏列表 (0)');
});

// 场景 5：删除是最终态，不会被下一次同步复活
t('删除是最终态：取消收藏后再同步不会复活已删条目', () => {
    const store = new SharedStore();
    const A = makePage(store, `https://${HOST}/detail/aaa`, 'AAA-001 三上悠亜 - M-Team');
    const B = makePage(store, `https://${HOST}/detail/bbb`, 'BBB-002 葵つかさ - M-Team');

    A.clickStar();
    A.clickStar(); // 取消收藏
    assert.strictEqual(store.readList().length, 0);
    assert.strictEqual(A.starOn(), false);

    B.clickStar();
    const list = store.readList();
    assert.strictEqual(list.length, 1, '只应有 B 自己那一条');
    assert.strictEqual(list[0].name, 'BBB-002 葵つかさ');
});

// 场景 6：后台标签页错过事件时，切回页面能补齐
t('错过 storage 事件时，切回页面（visibilitychange）可补齐同步', () => {
    const store = new SharedStore();
    const A = makePage(store, `https://${HOST}/detail/aaa`, 'AAA-001 三上悠亜 - M-Team');
    const B = makePage(store, `https://${HOST}/detail/bbb`, 'BBB-002 葵つかさ - M-Team');

    const saved = store.listeners.slice();
    store.listeners = []; // 模拟 B 页在后台收不到事件
    A.clickStar();
    assert.strictEqual(B.countText(), '收藏列表 (0)', '事件丢失时应仍是旧值');
    store.listeners = saved;

    B.visibilityChange(false);
    assert.strictEqual(B.countText(), '收藏列表 (1)', '切回页面后应补齐');
});

// 场景 7：两个页面同时点收藏（极端竞态），两条都不能丢
t('两页几乎同时收藏，两条都不丢', () => {
    const store = new SharedStore();
    const A = makePage(store, `https://${HOST}/detail/aaa`, 'AAA-001 三上悠亜 - M-Team');
    const B = makePage(store, `https://${HOST}/detail/bbb`, 'BBB-002 葵つかさ - M-Team');

    // 关闭事件通道，模拟两次点击之间没有机会收到对方广播
    const saved = store.listeners.slice();
    store.listeners = [];
    A.clickStar();
    B.clickStar();
    store.listeners = saved;

    assert.strictEqual(store.readList().length, 2, `应保留两条，实际 ${store.readList().length} 条`);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
