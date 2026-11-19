#!/usr/bin/env node
/**
 * test-mteam-big.mjs — 在最小 DOM 环境里真实执行 m-team-big.js，
 * 验证「列表种子名完整显示」逻辑：被截断的标题（Tailwind truncate /
 * line-clamp / 手动 nowrap+hidden）会被打上 .mt-full-title 并注入放开样式，
 * 而正常的标题不会被误改。
 *
 * 没有 jsdom 依赖，这里实现了一个够用的迷你 DOM。
 * 用法：node tools/test-mteam-big.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'm-team-big.js');

let passed = 0;
let failed = 0;
function check(name, cond) {
    if (cond) {
        passed++;
        console.log(`  ok   ${name}`);
    } else {
        failed++;
        console.log(`  FAIL ${name}`);
    }
}

/* ============================ 迷你 DOM ============================ */
function makeClassList(el) {
    const set = new Set();
    const sync = () => {
        el._className = [...set].join(' ');
    };
    return {
        add: (...n) => {
            n.forEach((x) => set.add(x));
            sync();
        },
        remove: (...n) => {
            n.forEach((x) => set.delete(x));
            sync();
        },
        contains: (n) => set.has(n),
        toggle: (n, force) => {
            const want = force === undefined ? !set.has(n) : !!force;
            if (want) set.add(n);
            else set.delete(n);
            sync();
            return want;
        },
        _set: (str) => {
            set.clear();
            String(str || '')
                .split(/\s+/)
                .filter(Boolean)
                .forEach((x) => set.add(x));
            sync();
        },
    };
}

class Element {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.nodeType = 1;
        this.childNodes = [];
        this.parentNode = null;
        this.attributes = {};
        this.id = '';
        this.dataset = {};
        this.style = { setProperty() {} };
        this._className = '';
        this.classList = makeClassList(this);
        this._computed = null;
        this._listeners = [];
    }
    get className() {
        return this._className;
    }
    set className(v) {
        this.classList._set(v);
    }
    get firstChild() {
        return this.childNodes[0] || null;
    }
    get parentElement() {
        return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }
    setAttribute(k, v) {
        this.attributes[k] = String(v);
    }
    getAttribute(k) {
        if (k === 'class') return this._className;
        if (k === 'id') return this.id;
        return k in this.attributes ? this.attributes[k] : null;
    }
    appendChild(c) {
        if (c.parentNode) c.parentNode.removeChild(c);
        c.parentNode = this;
        this.childNodes.push(c);
        return c;
    }
    removeChild(c) {
        const i = this.childNodes.indexOf(c);
        if (i >= 0) {
            this.childNodes.splice(i, 1);
            c.parentNode = null;
        }
        return c;
    }
    addEventListener() {}
    get textContent() {
        return this.childNodes.map((c) => c.textContent || '').join('');
    }
    set textContent(v) {
        this.childNodes = [];
        if (v !== '' && v != null) this.appendChild(new TextNode(String(v)));
    }
    descendants(out = []) {
        for (const c of this.childNodes) {
            if (c.nodeType === 1) {
                out.push(c);
                c.descendants(out);
            }
        }
        return out;
    }
    querySelectorAll(sel) {
        return this.descendants().filter((el) => matchesAny(el, sel));
    }
    querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
    }
    closest(sel) {
        let n = this;
        while (n) {
            if (n.nodeType === 1 && matchesAny(n, sel)) return n;
            n = n.parentNode;
        }
        return null;
    }
}

class TextNode {
    constructor(value) {
        this.nodeType = 3;
        this.nodeValue = String(value);
        this.parentNode = null;
        this.childNodes = [];
    }
    get textContent() {
        return this.nodeValue;
    }
    set textContent(v) {
        this.nodeValue = String(v);
    }
    get parentElement() {
        return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }
    getAttribute() {
        return null;
    }
}

const ATTR_RE = /\[([\w-]+)\s*(?:([*^$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*(i?)\]/g;

function matchPart(el, part) {
    part = part.trim();
    if (!part) return false;
    if (part === '*') return true;

    let rest = part;
    const tagM = part.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
    if (tagM) {
        if (el.tagName.toLowerCase() !== tagM[0].toLowerCase()) return false;
        rest = part.slice(tagM[0].length);
    }

    let matched = false;
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(rest))) {
        matched = true;
        const attr = m[1];
        const op = m[2];
        const val = m[3] ?? m[4] ?? m[5] ?? '';
        const ci = !!m[6];
        const have = el.getAttribute(attr);
        if (have == null) return false;
        let a = have;
        let b = val;
        if (ci) {
            a = a.toLowerCase();
            b = b.toLowerCase();
        }
        if (op === '*=') {
            if (!a.includes(b)) return false;
        } else if (op === '^=') {
            if (!a.startsWith(b)) return false;
        } else if (op === '$=') {
            if (!a.endsWith(b)) return false;
        } else if (op === '=' || op === undefined) {
            if (op === '=' && a !== b) return false;
        }
    }
    // 处理 .class / #id（去掉 attr 片段后剩下的）
    const plain = rest.replace(ATTR_RE, '');
    const re2 = /(?:^|\.)([\w-]+)|#([\w-]+)/g;
    let m2;
    while ((m2 = re2.exec(plain))) {
        matched = true;
        if (m2[1] && !el.classList.contains(m2[1])) return false;
        if (m2[2] && el.id !== m2[2]) return false;
    }
    return matched || !!tagM;
}

function matchesAny(el, sel) {
    return String(sel)
        .split(',')
        .some((s) => s.trim() && matchPart(el, s));
}

/* ============================ 组装页面 ============================ */
function el(tag, { cls, attrs } = {}) {
    const e = new Element(tag);
    if (cls) e.className = cls;
    if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
    return e;
}

const html = el('html');
const head = el('head');
const body = el('body');
html.appendChild(head);
html.appendChild(body);

const DOC = {
    nodeType: 9,
    documentElement: html,
    head,
    body,
    createElement: (t) => new Element(t),
    getElementById(id) {
        return html.descendants().find((e) => e.id === id) || null;
    },
    querySelectorAll(sel) {
        return html.descendants().filter((e) => matchesAny(e, sel));
    },
    querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
    },
};

// ---- 构造列表：新版界面 div.app-content__inner table.w-full > tbody > tr ----
const appInner = el('div', { cls: 'app-content__inner' });
const table = el('table', { cls: 'w-full' });
const tbody = el('tbody');
appInner.appendChild(table);
table.appendChild(tbody);
body.appendChild(appInner);

function addRow(detailId, { linkClipped, cellClipped, strongClipped }) {
    const tr = el('tr');
    const td = el('td');
    const a = el('a', { attrs: { href: `/detail/${detailId}` } });
    const strong = el('strong');
    a.appendChild(strong);
    td.appendChild(a);
    tr.appendChild(td);
    tbody.appendChild(tr);

    const CLIPPED = {
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maskImage: 'none',
        getPropertyValue: (n) => (n === '-webkit-line-clamp' ? 'none' : (n === '-webkit-mask-image' ? 'none' : '')),
    };
    const NORMAL = {
        whiteSpace: 'normal',
        overflow: 'visible',
        textOverflow: 'clip',
        maskImage: 'none',
        getPropertyValue: (n) => (n === '-webkit-line-clamp' ? 'none' : (n === '-webkit-mask-image' ? 'none' : '')),
    };
    a._computed = linkClipped ? CLIPPED : NORMAL;
    td._computed = cellClipped ? CLIPPED : NORMAL;
    strong._computed = strongClipped ? CLIPPED : NORMAL;
    return { tr, td, a, strong };
}

const row1 = addRow(111, { linkClipped: true, cellClipped: false, strongClipped: true }); // 标题自身被截断
const row2 = addRow(222, { linkClipped: false, cellClipped: false, strongClipped: false }); // 正常，不应被改
const row3 = addRow(333, { linkClipped: false, cellClipped: true, strongClipped: false }); // 外层单元格被截断

// 详情页链接（不在列表行内），不应被处理
const outsideLink = el('a', { attrs: { href: '/detail/999' } });
outsideLink._computed = {
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maskImage: 'none',
    getPropertyValue: () => 'none',
};
const main = el('main');
main.appendChild(outsideLink);
body.appendChild(main);

/* ============================ 执行脚本 ============================ */
const ctx = {
    document: DOC,
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    parseInt,
    localStorage: { getItem: () => null, setItem: () => {} },
    MutationObserver: class {
        observe() {}
        disconnect() {}
    },
    getComputedStyle: (e) =>
        e._computed || {
            whiteSpace: 'normal',
            overflow: 'visible',
            textOverflow: 'clip',
            maskImage: 'none',
            getPropertyValue: () => 'none',
        },
};
ctx.window = { location: { hostname: 'next.m-team.cc' } };
ctx.globalThis = ctx;

vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), ctx, { filename: 'm-team-big.js' });

/* ============================ 断言 ============================ */
console.log('m-team-big.js 种子名完整显示：');

const styleEl = DOC.getElementById('mt-full-title-style');
check('注入了放开截断的样式 <style id="mt-full-title-style">', !!styleEl);
const css = styleEl ? styleEl.textContent : '';
check('样式中包含 -webkit-line-clamp: unset', /-webkit-line-clamp:\s*unset/.test(css));
check('样式中包含 white-space: normal', /white-space:\s*normal/.test(css));
check('样式中包含 text-overflow: clip', /text-overflow:\s*clip/.test(css));
check('样式中覆盖新版界面结构选择器', /app-content__inner table\.w-full/.test(css));

check('被截断的标题链接被标记 .mt-full-title', row1.a.classList.contains('mt-full-title'));
check('被截断标题的 <strong> 也被放开', row1.strong.classList.contains('mt-full-title'));
check('正常显示的标题未被改动', !row2.a.classList.contains('mt-full-title'));
check('被截断的外层单元格被标记（覆盖外层裁切）', row3.td.classList.contains('mt-full-title'));
check('行外的详情链接不受影响', !outsideLink.classList.contains('mt-full-title'));

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);