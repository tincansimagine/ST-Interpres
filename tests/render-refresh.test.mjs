import test from 'node:test';
import assert from 'node:assert/strict';
import { rendererListeners, refreshRendered } from '../render-refresh.mjs';

test('only a frontend renderer is called again, never other listeners of the same event', async () => {
    const hits = [];
    const renderer = function (id) { if (this.settings?.render?.enabled) { /* */ } hits.push(['renderer', id]); const message_id = id; return message_id; };
    // 소스에 렌더러 설정 경로가 보이는 처리기만 렌더러로 친다
    const thRenderer = new Function('hits', 'return function (id) { const s = {}; if (s.settings?.render.enabled !== false) hits.push(["th", id]); const message_id = id; }')(hits);
    const memory = (id) => hits.push(['memory', id]);
    const eventSource = { events: { CHARACTER_MESSAGE_RENDERED: [memory, thRenderer, 'not a function'] } };
    assert.deepEqual(rendererListeners(eventSource, 'CHARACTER_MESSAGE_RENDERED'), [thRenderer]);
    assert.equal(await refreshRendered(eventSource, 'CHARACTER_MESSAGE_RENDERED', 7), 1);
    assert.deepEqual(hits, [['th', 7]]);
    assert.equal(await refreshRendered({}, 'X', 1), 0, 'no renderer installed: nothing happens');
    void renderer;
});
