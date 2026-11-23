/**
 * 화면 렌더러 다시 부르기.
 *
 * Tavern Helper 같은 렌더러는 코드블록 속 HTML 문서를 iframe으로 그린다. 번역을 붙이거나 블록을 원문/번역으로
 * 바꾸면 실리태번이 메시지를 다시 그리는데, 렌더러는 "메시지가 새로 그려졌다" 신호를 받을 때만 iframe을 만들어
 * 화면이 날것의 코드로 남는다. 그 신호를 모두에게 다시 보내면 다른 확장(기억 확장 등)이 같은 메시지를 또
 * 처리하므로, 렌더러의 처리기만 골라서 그 메시지에 대해 부른다.
 * 알아볼 수 없는 처리기는 부르지 않는다 (없으면 아무것도 하지 않는다).
 */

const RENDERER_HINTS = [/\.render\.enabled/, /message_id/];

export function rendererListeners(eventSource, event) {
    const list = eventSource?.events?.[event];
    if (!Array.isArray(list)) return [];
    return list.filter((fn) => {
        if (typeof fn !== 'function') return false;
        let src = '';
        try { src = Function.prototype.toString.call(fn); } catch { return false; }
        return RENDERER_HINTS.every(rx => rx.test(src));
    });
}

/** 메시지 하나를 렌더러에게 다시 그리게 한다. 부른 처리기 수를 돌려준다. */
export async function refreshRendered(eventSource, event, mesId) {
    const listeners = rendererListeners(eventSource, event);
    for (const fn of listeners) {
        try { await fn.call(eventSource, mesId); } catch (e) { console.warn('[interpres] 렌더러 다시 부르기 실패', e); }
    }
    return listeners.length;
}
