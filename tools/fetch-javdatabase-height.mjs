#!/usr/bin/env node
/**
 * fetch-javdatabase-height.mjs
 * ---------------------------------------------------------------
 * 从 javdatabase.com 增量抓取女优身高（离线构建工具，不影响用户浏览器）。
 *
 * 策略（增量）：
 *   身高段 133–190 → 筛选页收 idol slug（含分页）→ 详情页抓 JP 日文名 + 身高
 *   已知名字（当前 actress-height.json）跳过详情页，不发起请求。
 *
 * 用法：
 *   node tools/fetch-javdatabase-height.mjs --proxy http://127.0.0.1:21578 --delay 400
 *   node tools/fetch-javdatabase-height.mjs --merge-only   # 只用已有缓存产出
 *
 * 产物：
 *   build/cache/javdatabase-links.json   所有 slug
 *   build/cache/javdatabase-raw.jsonl    明细 {slug, jpName, height, url}
 *   build/javdatabase-cache.json         { 日文名: 身高 }
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
    parseHeightFilterPage,
    parseIdolDetail,
    heightRange,
    buildCacheFromRawText,
} from './lib-javdatabase.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'build', 'cache');
const LINKS_PATH = path.join(CACHE_DIR, 'javdatabase-links.json');
const RAW_PATH = path.join(CACHE_DIR, 'javdatabase-raw.jsonl');
const OUT_PATH = path.join(ROOT, 'build', 'javdatabase-cache.json');
const EXISTING_PATH = path.join(ROOT, 'build', 'actress-height.json');
const BASE = 'https://www.javdatabase.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const opts = { proxy: '', delay: 400, resume: true, mergeOnly: false, maxHeights: 0 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--proxy') opts.proxy = argv[++i] || '';
        else if (a === '--delay') opts.delay = parseInt(argv[++i], 10) || 400;
        else if (a === '--no-resume') opts.resume = false;
        else if (a === '--merge-only') opts.mergeOnly = true;
        else if (a === '--max-heights') opts.maxHeights = parseInt(argv[++i], 10) || 0;
    }
    return opts;
}

/** 用 curl 抓页面（走代理则加 --proxy），避免引入新依赖 */
async function fetchText(url, opts, attempt = 0) {
    const args = ['-sS', '-L', '--max-time', '30', '--ssl-no-revoke', '--http1.1'];
    if (opts.proxy) args.push('--proxy', opts.proxy);
    args.push(url);
    try {
        const { stdout } = await execFileAsync('curl', args, { maxBuffer: 8 * 1024 * 1024 });
        return stdout;
    } catch (err) {
        if (attempt >= 3) throw new Error(`抓取失败 ${url}: ${err.message}`);
        const backoff = 1000 * Math.pow(2, attempt);
        console.warn(`  ! 重试 ${url} (${err.message}) ${backoff}ms`);
        await sleep(backoff);
        return fetchText(url, opts, attempt + 1);
    }
}

/** 归一化名字，用于判断已知（去空格/括号、全角→半角） */
function normalizeName(name) {
    return String(name || '')
        .replace(/[（(][^）)]*[）)]/g, '')
        .replace(/[\s\u3000]/g, '')
        .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .trim();
}

function loadKnownNames() {
    if (!fs.existsSync(EXISTING_PATH)) return new Set();
    try {
        const data = JSON.parse(fs.readFileSync(EXISTING_PATH, 'utf8'));
        return new Set(Object.keys(data).map(normalizeName));
    } catch (e) {
        console.warn('  ! 读取已有数据集失败：' + e.message);
        return new Set();
    }
}

function loadDoneSlugs() {
    if (!fs.existsSync(RAW_PATH)) return new Set();
    const done = new Set();
    for (const line of fs.readFileSync(RAW_PATH, 'utf8').split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
            const rec = JSON.parse(s);
            if (rec.slug) done.add(rec.slug);
        } catch { /* 跳过坏行 */ }
    }
    return done;
}

async function phaseLinks(opts) {
    if (opts.resume && fs.existsSync(LINKS_PATH)) {
        const links = JSON.parse(fs.readFileSync(LINKS_PATH, 'utf8'));
        console.log(`链接缓存已有 ${links.length} 个 slug，跳过列表抓取`);
        return links;
    }
    console.log('=== Phase 1: 身高筛选页收集 slug ===');
    const heights = heightRange();
    const limit = opts.maxHeights || heights.length;
    const all = new Set();
    for (let i = 0; i < limit; i++) {
        const h = heights[i];
        // 站点 next 链接会丢掉 _height 参数，必须自己拼回去，否则翻页变成全站列表
        let url = `${BASE}/idols/?_height=${h}.00%2C${h}.00`;
        let page = 0;
        const visited = new Set();
            while (url && page < 5 && !visited.has(url)) {
            visited.add(url);
            const html = await fetchText(url, opts);
            const { slugs, nextPage } = parseHeightFilterPage(html);
                slugs.forEach((s) => all.add(s));
            process.stdout.write(`\r  身高 ${h}cm 第 ${++page} 页  累计 ${all.size} 个 slug  `);
            if (!nextPage) { url = null; break; }
            // 强制把身高筛选参数带上
            const sep = nextPage.indexOf('?') >= 0 ? '&' : '?';
            url = (nextPage.startsWith('http') ? nextPage : BASE + nextPage) +
                sep + '_height=' + h + '.00%2C' + h + '.00';
            if (opts.delay) await sleep(opts.delay);
        }
    }
    console.log('');
    const links = [...all].sort();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(LINKS_PATH, JSON.stringify(links, null, 0), 'utf8');
    console.log(`已缓存 ${links.length} 个 slug → ${path.relative(ROOT, LINKS_PATH)}`);
    return links;
}

async function phaseDetails(slugs, opts) {
    console.log('=== Phase 2: 详情页抓日文名与身高（增量） ===');
    const known = loadKnownNames();
    const done = loadDoneSlugs();
    let processed = 0, skippedKnown = 0, skippedDone = 0, added = 0;

    // 追加模式写 JSONL，断点续传不覆盖
    for (const slug of slugs) {
        if (done.has(slug)) { skippedDone++; continue; }
        const url = `${BASE}/idols/${slug}/`;
        const html = await fetchText(url, opts);
        const info = parseIdolDetail(html);
        processed++;

        if (!info.jpName || !info.height) {
            // 无日文名或无身高：也记一条，避免下次重复抓
            fs.appendFileSync(RAW_PATH, JSON.stringify({ slug, ...info, url }) + '\n', 'utf8');
            done.add(slug);
        } else if (known.has(normalizeName(info.jpName))) {
            skippedKnown++;
            fs.appendFileSync(RAW_PATH, JSON.stringify({ slug, ...info, url, known: true }) + '\n', 'utf8');
            done.add(slug);
        } else {
            added++;
            fs.appendFileSync(RAW_PATH, JSON.stringify({ slug, ...info, url }) + '\n', 'utf8');
            done.add(slug);
            known.add(normalizeName(info.jpName));
        }
        if (processed % 20 === 0) {
            process.stdout.write(`\r  已抓 ${processed}  新增 ${added}  已知跳过 ${skippedKnown}  `);
        }
        if (opts.delay) await sleep(opts.delay);
    }
    console.log('');
    console.log(`详情页：抓取 ${processed}，新增 ${added}，已知跳过 ${skippedKnown}，缓存跳过 ${skippedDone}`);
}

function writeCache() {
    if (!fs.existsSync(RAW_PATH)) {
        console.warn('  ! 没有明细缓存，无法产出');
        return;
    }
    const cache = buildCacheFromRawText(fs.readFileSync(RAW_PATH, 'utf8'));
    const out = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b, 'ja')));
    fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 0), 'utf8');
    console.log(`已产出 ${Object.keys(out).length} 条 → ${path.relative(ROOT, OUT_PATH)}`);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.proxy) console.log(`代理：${opts.proxy}`);
    if (opts.mergeOnly) {
        console.log('=== --merge-only：只用已有缓存产出 ===');
        writeCache();
        return;
    }
    const slugs = await phaseLinks(opts);
    await phaseDetails(slugs, opts);
    writeCache();
}

main().catch((err) => {
    console.error('抓取失败：' + err.message);
    console.error('若站点不可达，请确认代理已启动并传 --proxy http://127.0.0.1:21578');
    process.exit(1);
});
