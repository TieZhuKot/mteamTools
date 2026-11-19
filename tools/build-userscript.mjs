#!/usr/bin/env node
/**
 * build-userscript.mjs
 * ---------------------------------------------------------------
 * 把 tools/fetch-actress-height.mjs 产出的数据集注入油猴脚本模板，
 * 生成最终可安装的 dist/m-team-actress-height.user.js。
 *
 * 用法：
 *   node tools/build-userscript.mjs
 *
 * 输入：
 *   build/actress-height.json      { "三上悠亜": 159, ... }
 *   src/userscript.template.js     含 `/* @__DATA__ *\/ {}` 占位符的脚本模板
 * 输出：
 *   dist/m-team-actress-height.user.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DATA_FILE = path.join(ROOT, 'build', 'actress-height.json');
const TPL_FILE = path.join(ROOT, 'src', 'userscript.template.js');
const CORE_FILE = path.join(ROOT, 'src', 'core.mjs');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'm-team-actress-height.user.js');
// 上一次成功构建的快照（版本号 + 去版本号后的内容指纹），用于强制「改内容必升版本」
const SNAPSHOT_FILE = path.join(ROOT, 'build', 'build-snapshot.json');

const DATA_PLACEHOLDER = '/* @__DATA__ */ {}';
const CORE_PLACEHOLDER = '/* @__CORE__ */';

function main() {
    if (!fs.existsSync(DATA_FILE)) {
        console.error(`缺少数据集：${DATA_FILE}\n请先运行：node tools/fetch-actress-height.mjs`);
        process.exit(1);
    }
    if (!fs.existsSync(TPL_FILE)) {
        console.error(`缺少模板：${TPL_FILE}`);
        process.exit(1);
    }
    if (!fs.existsSync(CORE_FILE)) {
        console.error(`缺少核心逻辑：${CORE_FILE}`);
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const tpl = fs.readFileSync(TPL_FILE, 'utf8');
    const core = fs.readFileSync(CORE_FILE, 'utf8');

    if (!tpl.includes(DATA_PLACEHOLDER)) {
        console.error(`模板中找不到数据占位符：${DATA_PLACEHOLDER}`);
        process.exit(1);
    }
    if (!tpl.includes(CORE_PLACEHOLDER)) {
        console.error(`模板中找不到核心逻辑占位符：${CORE_PLACEHOLDER}`);
        process.exit(1);
    }

    // 去掉 export 关键字后内联核心逻辑
    const coreInline = core
        .replace(/^\s*export\s+/gm, '')
        .replace(/^#!.*$/m, '');

    let out = tpl
        .replace(CORE_PLACEHOLDER, () => coreInline)
        .replace(DATA_PLACEHOLDER, () => JSON.stringify(data));

    // ---- 校验（必须在落盘之前，否则失败的构建会污染 dist）----

    // 1) @version 必须存在，且模板与产物一致
    const versionOf = (text) => (text.match(/^\/\/\s*@version\s+(\S+)/m) || [])[1] || '';
    const tplVersion = versionOf(tpl);
    const outVersion = versionOf(out);
    if (!tplVersion) {
        console.error('模板中没有 @version，请补上');
        process.exit(1);
    }
    if (tplVersion !== outVersion) {
        console.error(`@version 不一致：模板 ${tplVersion} / 产物 ${outVersion}`);
        process.exit(1);
    }

    // 2) 与上一次成功构建比较：内容变了就必须同时升版本号
    //    （同一版本号覆盖发布，Tampermonkey 不会提示用户更新）
    const stampOf = (t) => t.replace(/^\/\/\s*@version\s+\S+.*$/m, '');
    const snapshot = fs.existsSync(SNAPSHOT_FILE)
        ? JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'))
        : null;

    if (snapshot && snapshot.version) {
        const contentChanged = snapshot.stamp !== stampOf(out);
        if (contentChanged && snapshot.version === tplVersion) {
            console.error('---------------------------------------------');
            console.error(`✗ 脚本内容有改动，但 @version 仍是 ${tplVersion}，没有递增。`);
            console.error(`  请先修改 ${path.relative(ROOT, TPL_FILE)} 顶部的 @version 再构建`);
            console.error('  （否则 Tampermonkey 不会提示用户更新，已装用户拿不到这次修改）');
            process.exit(1);
        }
        if (!contentChanged && snapshot.version !== tplVersion) {
            console.log(`提示：内容未变，但版本已从 ${snapshot.version} 升到 ${tplVersion}`);
        }
    }

    // ---- 校验通过，落盘 ----
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, out, 'utf8');
    fs.writeFileSync(
        SNAPSHOT_FILE,
        JSON.stringify({ version: tplVersion, stamp: stampOf(out) }),
        'utf8',
    );

    const count = Object.keys(data).length;
    const sizeKB = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
    console.log('---------------------------------------------');
    console.log(`内嵌女优数：${count}`);
    console.log(`版本：${tplVersion}`);
    console.log(`输出：${OUT_FILE}  (${sizeKB} KB)`);
}

main();