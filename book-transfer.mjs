// Portable book format: deliberately excludes chat history, API settings and cache.
export const BOOK_FORMAT = 'interpres-book';
export const MAX_BOOK_BYTES = 5 * 1024 * 1024;
const FIELDS = { glossary: ['src', 'dst'], voiceCards: ['name', 'style'] };

export function parseBook(text) {
    const data = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!data || data.format !== BOOK_FORMAT || data.version !== 1) {
        throw new Error('지원하는 Interpres 용어·말투 파일(v1)이 아닙니다.');
    }
    const result = {};
    for (const [section, fields] of Object.entries(FIELDS)) {
        if (!Array.isArray(data[section]) || data[section].length > 10000) {
            throw new Error('목록 형식이 잘못되었거나 항목이 너무 많습니다.');
        }
        const seen = new Set();
        result[section] = data[section].map(item => {
            const clean = {};
            for (const field of fields) {
                if (typeof item?.[field] !== 'string' || !item[field].trim() || item[field].length > 20000) {
                    throw new Error('빈 항목이나 잘못된 값이 있습니다. 파일을 확인해 주세요.');
                }
                clean[field] = item[field].trim();
            }
            if (seen.has(clean[fields[0]])) throw new Error('파일 안에 같은 원문 또는 이름이 중복되어 있습니다.');
            seen.add(clean[fields[0]]);
            return clean;
        });
    }
    return result;
}

export function exportBook(book, scope = 'all') {
    const data = { format: BOOK_FORMAT, version: 1, exportedAt: new Date().toISOString() };
    let skipped = 0;
    for (const [section, fields] of Object.entries(FIELDS)) {
        const seen = new Set();
        data[section] = [];
        if (scope !== 'all' && scope !== section) continue;
        for (const item of book[section]) {
            const clean = Object.fromEntries(fields.map(field => [field, String(item[field] ?? '').trim()]));
            if (fields.some(field => !clean[field]) || seen.has(clean[fields[0]])) { skipped++; continue; }
            seen.add(clean[fields[0]]);
            data[section].push(clean);
        }
    }
    const text = JSON.stringify(data, null, 2);
    // Every export must be accepted by the importer.
    parseBook(text);
    if (new TextEncoder().encode(text).length > MAX_BOOK_BYTES) throw new Error('파일은 5MB까지 지원합니다.');
    return { text, skipped, count: data.glossary.length + data.voiceCards.length };
}

export function mergeBook(book, incoming, scope, policy, makeId) {
    const result = {};
    const counts = { added: 0, updated: 0, skipped: 0 };
    for (const [section, [key, value]] of Object.entries(FIELDS)) {
        result[section] = book[section].map(item => ({ ...item }));
        if (scope !== 'all' && scope !== section) continue;
        for (const item of incoming[section]) {
            const matches = result[section].filter(existing => existing[key]?.trim() === item[key]);
            if (!matches.length) {
                result[section].push({ ...item, id: makeId() });
                counts.added++;
            } else if (policy === 'update' && matches.some(existing => existing[value] !== item[value])) {
                for (const match of matches) match[value] = item[value];
                counts.updated++;
            } else counts.skipped++;
        }
    }
    return { ...result, counts };
}
