/**
 * 봉인(형식 보호)과 그림 지키기 — 화면·설정에 의존하지 않는 순수 함수만 둔다.
 *
 * 그림이 사라지던 이유: `<img src="/user/images/…">` 같은 태그는 봉인 대상이 아니어서
 * 번역 모델에게 그대로 넘어갔다. 모델이 태그를 빼먹거나 속성(title·alt의 영어 프롬프트)을
 * "번역"해 버리면 그림이 깨졌고, 답변을 고쳐 다시 번역할 때마다 그 복불복을 다시 치렀다.
 * 이제 그림·영상 태그는 항상 봉인해서 모델이 손댈 수 없게 한다.
 */

export const SEAL_RX = /<\s*seal[-_ ]?(\d+)\s*\/?\s*>/gi;

/** 항상 봉인하는 미디어 조각 — 앞에서부터 순서대로 적용한다 */
export function mediaSealPatterns() {
    return [
        // 짝이 있는 미디어 요소는 통째로 (안의 <source>·대체 문구 포함)
        /<(video|audio|picture|svg|iframe|object|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
        // 홀로 쓰이는 미디어 태그 — 속성 안의 '>'에도 끊기지 않게 따옴표 구간을 통째로 넘긴다
        /<(?:img|video|audio|source|embed|iframe)\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi,
        // 본문에 맨몸으로 박힌 data URI (base64 그림)
        /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{16,}/gi,
    ];
}

/** 번역하면 안 되는 조각을 <seal-N/>으로 치환하고 금고에 보관 */
export function sealWith(text, patterns) {
    const vault = [];
    let out = String(text ?? '');
    for (const rx of patterns) {
        out = out.replace(rx, (m) => {
            const idx = vault.length;
            vault.push(m);
            return `<seal-${idx}/>`;
        });
    }
    return { sealed: out, vault };
}

/**
 * 봉인 복원. 유실된 인덱스 목록을 함께 반환.
 * 봉인은 겹칠 수 있다(코드 블록 안의 매크로·그림처럼 먼저 봉인된 조각이 나중 봉인에 담긴다).
 * 금고에서 꺼낸 내용물 속의 마커까지 풀어야 하고, 그렇게 풀린 것은 유실로 세면 안 된다.
 */
export function unsealText(text, vault) {
    const used = new Set();
    const expand = (t, depth) => String(t ?? '').replace(SEAL_RX, (m, n) => {
        const idx = Number(n);
        if (idx < 0 || idx >= vault.length) return depth === 0 ? '' : m;
        used.add(idx);
        // 담긴 봉인은 언제나 자기보다 먼저 만들어진 것 — 깊이 제한은 만일을 위한 안전장치
        return depth < 8 ? expand(vault[idx], depth + 1) : vault[idx];
    });
    const restored = expand(text, 0);
    const missing = [];
    for (let i = 0; i < vault.length; i++) if (!used.has(i)) missing.push(i);
    return { restored, missing };
}

/** 금고 내용물 안에 담겨 있는 봉인 번호들 (바깥 봉인이 살아 있으면 함께 살아 있다) */
export function nestedSeals(vault, idx, seen = new Set()) {
    for (const m of String(vault[idx] ?? '').matchAll(SEAL_RX)) {
        const n = Number(m[1]);
        if (n >= 0 && n < vault.length && !seen.has(n)) { seen.add(n); nestedSeals(vault, n, seen); }
    }
    return seen;
}

const MEDIA_TOKEN_RX = new RegExp([
    String.raw`<(video|audio|picture|svg|iframe|object|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>`,
    String.raw`<(?:img|embed)\b(?:"[^"]*"|'[^']*'|[^>"'])*>`,
    String.raw`!\[[^\]\n]*\]\([^)\n]*\)`,
].join('|'), 'gi');

/** 글 안의 그림·영상 조각 목록 (등장 순서, 중복 제거) */
export function mediaTokens(text) {
    const out = [];
    for (const m of String(text ?? '').matchAll(MEDIA_TOKEN_RX)) {
        if (!out.includes(m[0])) out.push(m[0]);
    }
    return out;
}

/**
 * 번역문에만 붙어 있던 그림 — 원문에는 없는데 화면(번역문)에 얹혀 있던 것.
 * 다른 확장이 번역 표시 쪽에 그림을 꽂았거나, 대조 창에서 손으로 넣은 경우다.
 * `sourceMedia`는 그 번역을 만들 때 원문에 있던 그림 목록(mediaStamp)이라, 원문에서 일부러 지운 그림은
 * 여기에 걸려 되살아나지 않는다. 목록이 없는(구버전) 번역은 판단할 수 없으므로 건드리지 않는다.
 */
export function displayOnlyMedia(displayText, sourceMedia, hash = (x) => x) {
    if (!displayText || !Array.isArray(sourceMedia)) return [];
    const known = new Set(sourceMedia);
    return mediaTokens(displayText).filter(tok => !known.has(hash(tok)));
}

/** 원문에 있는 그림 목록의 도장 (긴 base64를 통째로 저장하지 않게 해시로) */
export function mediaStamp(source, hash = (x) => x) {
    return mediaTokens(source).map(hash);
}

/** 새 번역문에 빠진 그림을 끝에 다시 얹는다 */
export function restoreMedia(translated, keep, source = '') {
    const text = String(translated ?? '');
    const lost = (keep || []).filter(tok => tok && !text.includes(tok) && !String(source).includes(tok));
    return lost.length ? `${text.replace(/\s+$/, '')}\n\n${[...new Set(lost)].join('\n')}` : text;
}
