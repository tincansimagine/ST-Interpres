/**
 * 코드블록 — 상태창·폰 화면처럼 코드블록에 담긴 글을 번역하되, 틀은 한 글자도 건드리지 않는다.
 *
 * 롤플 답변의 코드블록은 대개 코드가 아니라 화면이다: HTML 상태창, 메신저 화면, 표 모양의 글.
 * 통째로 봉인하면 그 안의 대사·설명이 번역되지 않고, 통째로 넘기면 모델이 태그·속성·CSS를 고쳐 화면이 깨진다.
 * 그래서 블록마다 성격을 가려,
 *   - code   (js·python처럼 진짜 코드): 통째로 봉인
 *   - markup (HTML이 든 화면): 태그·<style>·<script>·주석을 봉인하고 글자만 넘긴다
 *   - plain  (그냥 글): 펜스 줄만 봉인하고 안쪽은 넘긴다
 * 이웃한 태그는 한 봉인으로 묶어, 모델이 지켜야 할 표식 수를 줄인다.
 */

/** 줄 단위로 펜스를 찾는다. 닫히지 않은 블록(답변이 잘린 경우)은 끝까지로 본다. */
export function fencedBlocks(value) {
    const text = String(value ?? '');
    const blocks = [];
    let open = null;
    let pos = 0;
    while (pos <= text.length) {
        const nl = text.indexOf('\n', pos);
        const end = nl < 0 ? text.length : nl;
        const line = text.slice(pos, end).replace(/\r$/, '');
        if (open) {
            const close = line.match(/^[\t ]*(`{3,}|~{3,})[\t ]*$/);
            if (close && close[1][0] === open.mark[0] && close[1].length >= open.mark.length) {
                blocks.push({ start: open.start, end: pos + line.length, open: open.line, close: line, info: open.info,
                    bodyStart: open.bodyStart, bodyEnd: pos, text: text.slice(open.start, pos + line.length) });
                open = null;
            }
        } else {
            const m = line.match(/^[\t ]*(`{3,}|~{3,})(.*)$/);
            // 백틱 펜스의 정보 문자열에 백틱이 있으면 펜스가 아니다 (```인라인``` 같은 것)
            if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
                open = { start: pos, mark: m[1], line, info: m[2].trim().split(/\s+/)[0].toLowerCase(), bodyStart: nl < 0 ? text.length : nl + 1 };
            }
        }
        if (nl < 0) break;
        pos = nl + 1;
    }
    if (open) blocks.push({ start: open.start, end: text.length, open: open.line, close: null, info: open.info,
        bodyStart: open.bodyStart, bodyEnd: text.length, text: text.slice(open.start) });
    return blocks;
}

const CODE_LANGS = new Set(['js', 'javascript', 'mjs', 'ts', 'typescript', 'jsx', 'tsx', 'py', 'python', 'json', 'jsonc',
    'css', 'scss', 'sass', 'less', 'sh', 'bash', 'zsh', 'shell', 'powershell', 'ps1', 'bat', 'cmd', 'c', 'h', 'cpp', 'c++', 'cs',
    'csharp', 'java', 'kotlin', 'kt', 'go', 'rust', 'rs', 'rb', 'ruby', 'php', 'swift', 'lua', 'sql', 'yaml', 'yml', 'toml',
    'ini', 'dockerfile', 'makefile', 'diff', 'regex', 'stscript', 'slash', 'r', 'perl', 'pl', 'scala', 'dart', 'vue', 'svelte']);

const TAG_RX = /<\/?[A-Za-z][\w:-]*(?:\s+(?:"[^"]*"|'[^']*'|[^'">\s])+)*\s*\/?>/;

/** 블록의 성격: code | markup | plain */
export function classifyBlock(block) {
    if (CODE_LANGS.has(block.info)) return 'code';
    const body = String(block.text).slice(block.bodyStart - block.start, block.bodyEnd - block.start);
    if (/<(?:style|script)\b|<\/?(?:div|span|table|tr|td|p|br|img|section|body|html|head|ul|li|b|i|font|details|summary)\b/i.test(body) || TAG_RX.test(body)) return 'markup';
    // 정보 문자열이 없는데 코드처럼 생긴 것 (중괄호·세미콜론으로 끝나는 줄이 많다) — 건드리지 않는다
    const lines = body.split('\n').filter(l => l.trim());
    const codey = lines.filter(l => /[;{}]\s*$|^\s*(?:function|const|let|var|import|export|return|if|for|def|class)\b|=>/.test(l)).length;
    if (lines.length >= 3 && codey / lines.length > 0.5) return 'code';
    return 'plain';
}

// 화면 틀: 스크립트·스타일 통째, 주석, 태그. 사이에 공백만 있으면 한 덩어리로 묶는다.
const FRAME_UNIT = String.raw`(?:<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?[A-Za-z][\w:-]*(?:\s+(?:"[^"]*"|'[^']*'|[^'">\s])+)*\s*\/?>)`;

/** HTML 화면에서 틀을 봉인하고 글자만 남긴다 */
function sealMarkup(body, seal) {
    // 정규식 역참조 번호가 반복 안에서 꼬이지 않게, 틀 조각을 하나씩 찾아 이웃끼리 합친다
    const unit = new RegExp(FRAME_UNIT, 'gi');
    const spans = [];
    for (const m of body.matchAll(unit)) {
        const last = spans[spans.length - 1];
        if (last && /^\s*$/.test(body.slice(last.end, m.index))) last.end = m.index + m[0].length;
        else spans.push({ start: m.index, end: m.index + m[0].length });
    }
    let out = '';
    let cursor = 0;
    for (const s of spans) {
        out += body.slice(cursor, s.start) + seal(body.slice(s.start, s.end));
        cursor = s.end;
    }
    return out + body.slice(cursor);
}

/**
 * 본문의 코드블록을 봉인한다. seal(raw) → 표식 문자열.
 * translate가 거짓이면 모든 블록을 통째로 봉인한다 (예전 동작, 닫히지 않은 블록까지).
 */
export function sealCodeBlocks(text, seal, { translate = true } = {}) {
    const src = String(text ?? '');
    const blocks = fencedBlocks(src);
    if (!blocks.length) return src;
    let out = '';
    let cursor = 0;
    for (const b of blocks) {
        out += src.slice(cursor, b.start);
        cursor = b.end;
        const kind = translate ? classifyBlock(b) : 'code';
        if (kind === 'code') { out += seal(b.text); continue; }
        const body = src.slice(b.bodyStart, b.bodyEnd);
        // 펜스 줄은 줄바꿈까지 봉인해, 모델이 펜스를 다른 줄에 붙이지 못하게 한다
        out += seal(src.slice(b.start, b.bodyStart));
        out += kind === 'markup' ? sealMarkup(body, seal) : body;
        if (b.close !== null) out += seal(src.slice(b.bodyEnd, b.end));
    }
    return out + src.slice(cursor);
}

/* ------------------------------------------------------------
 * 블록별 원문/번역 고르기
 * ------------------------------------------------------------ */

/** 원문과 번역의 블록을 짝짓는다. 펜스가 어긋나면 짝을 지을 수 없다 (빈 배열). */
export function pairBlocks(original, translated) {
    const a = fencedBlocks(original);
    const b = fencedBlocks(translated);
    if (!a.length || a.length !== b.length) return [];
    if (a.some((x, i) => x.open !== b[i].open || x.close !== b[i].close)) return [];
    return b.map((x, i) => ({ ...x, original: a[i].text, kind: classifyBlock(a[i]) }));
}

/** 화면용 표식을 걷어낸 번역문 (공백은 대략 되돌린다 — 정확한 번역문은 저장해 둔 쪽을 쓴다) */
export function stripMarks(value) {
    return String(value ?? '').replace(/\n*<div class="(?:custom-)?ip-cb (?:custom-)?ip-cb-\d+"><\/div>\n\n/g, '\n');
}

/**
 * 화면에 보일 글: 고른 블록만 원문으로, 나머지는 번역으로.
 * marks가 참이면 번역된 블록 앞에 고르기 단추를 달 표식을 넣는다 (진짜 코드 블록은 고를 것이 없어 빼고).
 */
export function composeDisplay(original, translated, originals = [], { marks = false } = {}) {
    const pairs = pairBlocks(original, translated);
    if (!pairs.length) return String(translated ?? '');
    const pick = new Set(originals);
    let out = '';
    let cursor = 0;
    pairs.forEach((p, i) => {
        let before = translated.slice(cursor, p.start);
        const body = pick.has(i) ? p.original : p.text;
        if (marks && p.original !== p.text) {
            // 마크다운이 표식을 따로 된 HTML 덩어리로 읽도록 앞뒤에 빈 줄을 둔다
            before = before.replace(/\n*$/, '');
            out += `${before}${before ? '\n\n' : ''}<div class="ip-cb ip-cb-${i}"></div>\n\n${body}`;
        } else {
            out += before + body;
        }
        cursor = p.end;
    });
    return out + translated.slice(cursor);
}

export function togglePick(originals, index, count) {
    if (!Number.isInteger(index) || index < 0 || index >= count) return [...(originals || [])];
    const set = new Set((originals || []).filter(n => Number.isInteger(n) && n >= 0 && n < count));
    if (set.has(index)) set.delete(index); else set.add(index);
    return [...set].sort((x, y) => x - y);
}

/** 그린 메시지에서 표식 번호를 읽는다 (실리태번은 메시지 속 class에 custom- 을 붙인다) */
export function markIndex(className) {
    const m = String(className || '').match(/(?:^|\s)(?:custom-)?ip-cb-(\d+)(?:\s|$)/);
    return m ? Number(m[1]) : -1;
}

/** 화면에 렌더러가 따로 그리는 HTML 문서가 들어 있나 (Tavern Helper 같은 렌더러가 iframe으로 그리는 것) */
export function hasFrontendDocument(text) {
    return fencedBlocks(text).some(b => /<!doctype html|<html[\s>]|<body[\s>]|<head[\s>]/i.test(b.text));
}

/* ------------------------------------------------------------
 * 긴 글 나누기
 * ------------------------------------------------------------ */

/**
 * 문단 경계에서 나눈다 (구분자는 조각에 그대로 붙여 이어 붙이면 원래 글이 된다).
 * 한 문단이 한도보다 길면 줄 단위로, 줄도 길면 그대로 둔다.
 */
export function splitChunks(text, maxChars = 6000) {
    const src = String(text ?? '');
    if (src.length <= maxChars) return [src];
    const pieces = src.split(/(?<=\n[ \t]*\n)/);
    const chunks = [];
    let cur = '';
    const push = () => { if (cur) chunks.push(cur); cur = ''; };
    for (const piece of pieces) {
        if (piece.length > maxChars) {
            push();
            for (const line of piece.split(/(?<=\n)/)) {
                if (cur && cur.length + line.length > maxChars) push();
                cur += line;
            }
            continue;
        }
        if (cur && cur.length + piece.length > maxChars) push();
        cur += piece;
    }
    push();
    return chunks;
}
