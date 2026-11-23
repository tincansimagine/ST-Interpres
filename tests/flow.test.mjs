import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime, fakeTranslator } from './runtime.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('a status screen in a code block: words are translated, the HTML frame comes back byte for byte', async () => {
    const app = await runtime({ translate: fakeTranslator });
    const src = 'Aria smiled.\n\n```html\n<div class="card" style="color:red"><b>Mood:</b> happy</div>\n```\n\n```js\nconst keep = "me";\n```';
    const out = await app.translateText(src, 'en', 'ko');
    assert.match(out, /^한4 한6\./);
    assert.match(out, /<div class="card" style="color:red"><b>한4:<\/b> 한5<\/div>/, 'frame intact, words translated');
    assert.match(out, /```js\nconst keep = "me";\n```/, 'real code untouched');
    assert.ok(!app.calls.some(c => /color:red|const keep/.test(c)), 'the model never sees the frame or the code');
});

test('long messages are split and sent concurrently, never above the request limit', async () => {
    let live = 0, peak = 0;
    const app = await runtime({ translate: async (u) => { live++; peak = Math.max(peak, live); await sleep(15); live--; return fakeTranslator(u); } });
    app.getSettings().chunkChars = 1500;
    app.getSettings().concurrency = 2;
    const src = Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} goes on and on about the harbor and the lighthouse.`).join('\n\n');
    const out = await app.translateText(src, 'en', 'ko');
    assert.ok(app.calls.length >= 2, `split into ${app.calls.length} requests`);
    assert.equal(peak, 2);
    assert.equal(out.split('\n\n').length, 40, 'paragraph layout survives the split');
});

test('a failed part is kept: retrying only asks again for what failed', async () => {
    let fail = true;
    const app = await runtime({ translate: (u) => { if (fail && /Paragraph 3\b/.test(u)) throw new Error('rate limit'); return fakeTranslator(u); } });
    app.getSettings().chunkChars = 1500;
    const src = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} keeps going about the harbor and the old lighthouse keeper.`).join('\n\n');
    app.chat.push({ is_user: false, mes: src, extra: {} });
    assert.equal(await app.translateIncoming(0, { force: true }), false);
    const job = app.jobs.get('in:0');
    assert.equal(job.status, 'failed');
    const firstCalls = app.calls.length;
    fail = false;
    assert.equal(await app.translateIncoming(0, { force: true }), true);
    assert.equal(app.calls.length - firstCalls, 1, 'only the failed chunk is sent again');
    assert.match(app.chat[0].extra.display_text, /^한9 0/);
    assert.deepEqual(Object.keys(app.getStore().partials), [], 'checkpoint is cleared once the message is done');
});

test('cancelling stops a running translation and leaves no translation behind', async () => {
    const app = await runtime({ translate: async (u) => { await sleep(40); return fakeTranslator(u); } });
    app.chat.push({ is_user: false, mes: 'The harbor was quiet tonight and nobody spoke.', extra: {} });
    const pending = app.translateIncoming(0, { force: true });
    await sleep(5);
    app.jobs.get('in:0').cancel();
    assert.equal(await pending, false);
    assert.equal(app.chat[0].extra.display_text, undefined);
    assert.equal(app.jobs.get('in:0').status, 'cancelled');
});

test('per-block original/translation choice survives and the screen is marked only where it differs', async () => {
    const app = await runtime({ translate: fakeTranslator });
    const src = 'Hello there.\n\n```\nMood: happy\n```\n\n```js\nx()\n```';
    app.chat.push({ is_user: false, mes: src, extra: {} });
    await app.translateIncoming(0, { force: true });
    const m = app.chat[0];
    assert.equal((m.extra.display_text.match(/ip-cb-/g) || []).length, 1);
    await app.toggleCodeBlock(0, 0);
    assert.deepEqual([...m.extra.interpres_code.o], [0]);
    assert.match(m.extra.display_text, /```\nMood: happy\n```/, 'that block shows the original now');
    assert.match(m.extra.display_text, /^한5 한5\./, 'prose stays translated');
    assert.equal(app.plainDisplay(m).includes('ip-cb'), false);
});

test('a hand-edited translation is remembered per paragraph and reused when the source changes', async () => {
    const app = await runtime({ translate: fakeTranslator });
    const s1 = 'First line of the scene.\n\nSecond line of the scene.';
    app.chat.push({ is_user: false, mes: s1, extra: {} });
    await app.translateIncoming(0, { force: true });
    const edited = '내가 고친 첫 줄.\n\n' + app.chat[0].extra.display_text.split('\n\n')[1];
    assert.equal(app.learnEdits(s1, edited, 'en', 'ko'), 1);
    // 원문의 두 번째 문단만 바뀌었다
    app.chat[0].mes = 'First line of the scene.\n\nA brand new second line.';
    const before = app.calls.length;
    await app.translateIncoming(0, { force: true });
    assert.match(app.chat[0].extra.display_text, /^내가 고친 첫 줄\./, 'the hand edit is kept');
    assert.equal(app.calls.length - before, 1, 'only the changed paragraph is translated');
    assert.equal(app.learnEdits(s1, '문단이 하나뿐', 'en', 'ko'), 0, 'mismatched layouts teach nothing');
});

test('code block translation can be turned off: blocks are then sealed whole', async () => {
    const app = await runtime({ translate: fakeTranslator });
    app.getSettings().translateCodeBlocks = false;
    const out = await app.translateText('Hi.\n\n```\nMood: happy\n```', 'en', 'ko');
    assert.match(out, /```\nMood: happy\n```/);
    assert.ok(!app.calls.some(c => c.includes('Mood')));
});
