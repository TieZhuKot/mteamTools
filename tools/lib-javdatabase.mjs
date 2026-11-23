/**
 * javdatabase.com 页面解析（纯函数，便于单测）。
 * 实测结构（2026-11-20）：
 *   筛选页 https://www.javdatabase.com/idols/?_height=160.00,160.00
 *     - 卡片链接 /idols/<slug>/
 *     - 分页 <link rel="next" href="...">
 *   详情页 https://www.javdatabase.com/idols/<slug>/
 *     - JP: 日文名（M-Team 标题用的形态）
 *     - Height: 160 cm
 */

/** 从筛选页 HTML 提取 idol slug 和下一页链接 */
export function parseHeightFilterPage(html) {
    const slugs = [];
    const seen = new Set();
    const re = /href="https:\/\/www\.javdatabase\.com\/idols\/([a-z0-9][a-z0-9-]*)\/"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const slug = m[1];
        if (seen.has(slug)) continue;
        seen.add(slug);
        slugs.push(slug);
    }

    let nextPage = null;
    const next = /<link[^>]+rel="next"[^>]+href="([^"]+)"/i.exec(html)
        || /<link[^>]+href="([^"]+)"[^>]+rel="next"/i.exec(html);
    if (next) nextPage = next[1];

    return { slugs, nextPage };
}

/** 从详情页 HTML 提取日文名与身高 */
export function parseIdolDetail(html) {
    let jpName = null;
    let height = null;

    // JP: 比留川マイ —— 后面可能跟空白 + 广告链接，取到第一个 < 前并 trim
    const jp = /JP:\s*<\/b>\s*([^<]+)/i.exec(html) || /JP:\s*([^<\n]+)/i.exec(html);
    if (jp) {
        const v = jp[1].replace(/&nbsp;/g, ' ').trim();
        if (v) jpName = v;
    }

    // Height: 160 cm —— 注意列表里 "Measurements:" 那行也含 Height:，取第一个即可
    const h = /Height:\s*<\/b>\s*(?:<[^>]+>)*\s*(\d{2,3})\s*cm/i.exec(html)
        || /Height:\s*(\d{2,3})\s*cm/i.exec(html);
    if (h) {
        const v = parseInt(h[1], 10);
        if (v >= 130 && v <= 200) height = v;
    }

    return { jpName, height };
}

/** 身高段 133–190（含端点） */
export function heightRange() {
    const out = [];
    for (let h = 133; h <= 190; h++) out.push(h);
    return out;
}

/** 从 JSONL 文本构建 { 日文名: 身高 }，跳过缺字段/坏行 */
export function buildCacheFromRawText(text) {
    const out = Object.create(null);
    for (const line of String(text || '').split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
            const rec = JSON.parse(s);
            if (rec.jpName && Number.isInteger(rec.height) && rec.height >= 130 && rec.height <= 200) {
                out[rec.jpName] = rec.height;
            }
        } catch { /* 跳过坏行 */ }
    }
    return out;
}

/**
 * 清洗 javdatabase 详情页取到的名字。
 * 站点会在名字后附带状态标记：
 *   '愛弓りょう  -'        → 尾部占位横杠
 *   '伊東エリ【登録重複】' → 重复登记
 *   '美咲愛【引退】'       → 已引退
 * 清洗后只剩 1 字视为无效，返回 null。
 */
export function cleanJavName(raw) {
    let name = String(raw || '').trim();
    // 去掉【...】标记（登録重複 / 引退 等）
    name = name.replace(/【[^】]*】/g, '');
    // 去掉尾部空白 + 横杠占位（可能有多个空格）
    name = name.replace(/[\s\-—–]+$/g, '');
    name = name.trim();
    if (!name) return null;
    // 单字（含单假名）太容易撞词，不收
    if ([...name].length < 2) return null;
    return name;
}
