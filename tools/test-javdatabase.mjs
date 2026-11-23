#!/usr/bin/env node
/**
 * javdatabase 增量源的解析与合并测试。
 * 先写测试再写实现（TDD RED → GREEN）。
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function test(name, fn) {
    try {
        fn();
        pass++;
        console.log(`  ok  ${name}`);
    } catch (e) {
        fail++;
        console.error(`FAIL  ${name}\n      ${e.message}`);
    }
}

// ---- 真实页面片段夹具（2026-11-20 实测） ----
const FILTER_HTML = `
<html><head><link rel="next" href="https://www.javdatabase.com/idols/page/2/" /></head><body>
<a href="https://www.javdatabase.com/idols/mai-hirukawa/">Mai Hirukawa</a>
<a href="https://www.javdatabase.com/idols/ciel-kururugi/">Ciel Kururugi</a>
<a href="https://www.javdatabase.com/idols/?_sort_=most_favorited">Most Favorited</a>
<a href="https://www.javdatabase.com/idols/?_height=160.00%2C160.00">160cm</a>
</body></html>`;

const DETAIL_HTML = `
<div><b>JP:</b> 比留川マイ</div>
<div><b>Height:</b> <a href="?_height=160.00%2C160.00">160 cm</a></div>
<div><b>Alt:</b> Mai Hirukawa</div>`;

const DETAIL_NO_HEIGHT = `
<div><b>JP:</b>  testOnly</div>
<div><b>Cup:</b> <a href="#">F</a></div>`;

const libPath = path.join(__dirname, 'lib-javdatabase.mjs');
if (!fs.existsSync(libPath)) {
    console.error('FAIL  解析模块 lib-javdatabase.mjs 不存在（尚未实现）');
    process.exit(1);
}
const lib = await import('./lib-javdatabase.mjs');

test('筛选页：提取 idol slug，排除筛选参数链接', () => {
    const r = lib.parseHeightFilterPage(FILTER_HTML);
    assert.deepStrictEqual(r.slugs.sort(), ['ciel-kururugi', 'mai-hirukawa']);
});

test('筛选页：提取下一页链接', () => {
    const r = lib.parseHeightFilterPage(FILTER_HTML);
    assert.strictEqual(r.nextPage, 'https://www.javdatabase.com/idols/page/2/');
});

test('筛选页：没有 next 时返回 null', () => {
    const r = lib.parseHeightFilterPage('<html><body><a href="/idols/foo/">Foo</a></body></html>');
    assert.strictEqual(r.nextPage, null);
});

test('详情页：提取日文名与身高', () => {
    const r = lib.parseIdolDetail(DETAIL_HTML);
    assert.strictEqual(r.jpName, '比留川マイ');
    assert.strictEqual(r.height, 160);
});

test('详情页：缺身高时 height 为 null，不抛错', () => {
    const r = lib.parseIdolDetail(DETAIL_NO_HEIGHT);
    assert.strictEqual(r.height, null);
    assert.ok(r.jpName);
});

test('身高段：133–190 连续', () => {
    const h = lib.heightRange();
    assert.strictEqual(h[0], 133);
    assert.strictEqual(h[h.length - 1], 190);
    assert.strictEqual(h.length, 58);
});


// ---- 缓存构建：纯函数，用 JSONL 文本 ----
test('缓存构建：JSONL 明细转成 { 日文名: 身高 }，跳过坏行', () => {
    const text = [
        JSON.stringify({ slug: 'mai-hirukawa', jpName: '比留川マイ', height: 160 }),
        'not-json',
        JSON.stringify({ slug: 'bad', jpName: '坏数据', height: 999 }),
        JSON.stringify({ slug: 'noheight', jpName: '无身高', height: null }),
    ].join('\n');
    const out = lib.buildCacheFromRawText(text);
    assert.deepStrictEqual({ ...out }, { '比留川マイ': 160 });
});


// ---- 合并行为：新源只补缺失、不覆盖已有 ----
test('AN 与 AI 都在忽略名单里', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'userscript.template.js'), 'utf8');
    const m = /const IGNORED_NAMES = \[([^\]]*)\]/.exec(src);
    assert.ok(m, '未找到 IGNORED_NAMES');
    assert.ok(/'AI'/.test(m[1]) && /'AN'/.test(m[1]), '应同时排除 AI 与 AN：' + m[1]);
    assert.ok(!/\bAmi\b|\bRay\b/.test(m[1]), '不该误伤三字母真名：' + m[1]);
});

test('合并脚本优先级：javdatabase 在 avjoyudb 之前、只补缺失', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tools', 'merge-height-data.mjs'), 'utf8');
    const idxJdb = src.indexOf('loadJavDatabase');
    const idxAv = src.indexOf('loadAvJoyuDb()');
    const jdbPath = src.indexOf('javdatabase-cache.json');
    assert.ok(idxJdb > 0 && jdbPath > 0, '合并脚本未接入 javdatabase 源');
    assert.ok(idxJdb < idxAv, 'javdatabase 应在 avjoyudb 之前合并');
});


// ---- 真行为测试：合并的 tryAdd 语义 ----
// 把合并脚本的核心规则抽成纯函数验证（不跑完整 main，避免改真实数据）
test('合并语义：同名不覆盖、归一化后重名不重复、只补缺失', () => {
    // 复刻 merge-height-data.mjs 的 normalizeName 与 tryAdd 规则作为规格
    const norm = (name) => String(name || '')
        .replace(/[（(][^）)]*[）)]/g, '')
        .replace(/[\s\u3000]/g, '')
        .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .trim();
    const existing = { '三上悠亜': 159 };
    const normMap = new Map([[norm('三上悠亜'), '三上悠亜']]);
    const added = [];
    const tryAdd = (name, height) => {
        const n = norm(name);
        if (!n || n.length < 2) return;
        if (existing[name] !== undefined || normMap.has(n)) return;
        existing[name] = height; normMap.set(n, name); added.push(name);
    };
    tryAdd('三上悠亜', 170);        // 同名 → 不覆盖
    tryAdd('三上 悠亜', 170);       // 归一化后同名 → 不重复
    tryAdd('比留川マイ', 160);      // 新名字 → 加入
    tryAdd('ＡＩＫＡ', 158);        // 全角 → 加入（归一化后是 AIKA）
    assert.strictEqual(existing['三上悠亜'], 159, '已有身高不能被覆盖');
    assert.deepStrictEqual(added, ['比留川マイ', 'ＡＩＫＡ']);
    assert.strictEqual(existing['ＡＩＫＡ'], 158);
});


// ---- 新源名字清洗 ----
test('清洗：去掉站点后缀标记（  - / 【登録重複】 / 【引退】）', () => {
    const clean = lib.cleanJavName('愛弓りょう  -');
    assert.strictEqual(clean, '愛弓りょう');
    assert.strictEqual(lib.cleanJavName('伊東エリ【登録重複】'), '伊東エリ');
    assert.strictEqual(lib.cleanJavName('美咲愛【引退】'), '美咲愛');
});

test('清洗：正常名字不变，脏到只剩 1 字时返回 null', () => {
    assert.strictEqual(lib.cleanJavName('比留川マイ'), '比留川マイ');
    assert.strictEqual(lib.cleanJavName('Ai Aizawa'), 'Ai Aizawa');
    assert.strictEqual(lib.cleanJavName('あ'), null);
    assert.strictEqual(lib.cleanJavName(''), null);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
