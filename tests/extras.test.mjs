import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime, fakeTranslator } from './runtime.mjs';

test('메시지에만 쓰는 결이 프롬프트에 실리고 메시지에 남는다', async () => {
    const app = await runtime({ translate: fakeTranslator });
    app.chat.push({ name: 'A', mes: 'She walked up the stairs.', extra: {} });
    await app.translateIncoming(0, { force: true, fresh: true, tone: 5 });
    assert.equal(app.chat[0].extra.interpres_tone, 5);
    assert.match(app.calls.at(-1), /Full localization/);
    await app.translateIncoming(0, { force: true, fresh: true, tone: 0 });
    assert.equal(app.chat[0].extra.interpres_tone, undefined);
    assert.match(app.calls.at(-1), /Balance fidelity/);
});

test('비교 번역은 번역 기억을 건드리지 않는다', async () => {
    const app = await runtime({ translate: fakeTranslator });
    const out = await app.translateAlt('Hello there.\n\n<img src="a.png">', 'en', 'ko');
    assert.match(out, /한5 한5\./);
    assert.ok(out.includes('<img src="a.png">'));
    const store = app.getStore();
    assert.equal(Object.keys(store.blocks).length, 0);
    assert.equal(Object.keys(store.wholes).length, 0);
});

test('용어 자동 추가: 답변이 쌓였을 때만 한 번 부르고 없는 용어만 넣는다', async () => {
    let scans = 0;
    const app = await runtime({ translate: (user, sys) => {
        if (/term sheet/.test(sys)) { scans++; assert.match(sys, /do not list these again:\s*Aria/); return '{"terms":[{"src":"Aria","dst":"다른표기"},{"src":"Velmoor","dst":"벨무어"}]}'; }
        return fakeTranslator(user);
    } });
    Object.assign(app.getSettings(), { autoGlossary: true, autoGlossaryEvery: 3 });
    app.getBook().glossary.push({ id: 'x', src: 'Aria', dst: '아리아' });
    for (let i = 0; i < 2; i++) app.chat.push({ name: 'A', mes: `Aria reached Velmoor ${i}.`, extra: {} });
    assert.equal(await app.autoGlossary(1), 0);
    assert.equal(scans, 0);
    app.chat.push({ name: 'A', mes: 'Aria slept.', extra: {} });
    assert.equal(await app.autoGlossary(2), 1);
    assert.equal(app.getBook().glossary.map(g => `${g.src}=${g.dst}`).join(','), 'Aria=아리아,Velmoor=벨무어');
    app.chat.push({ name: 'A', mes: 'More.', extra: {} });
    assert.equal(await app.autoGlossary(3), 0);
    assert.equal(scans, 1);
});

test('현황: 보낸·받은·아낀 글자를 센다', async () => {
    const app = await runtime({ translate: fakeTranslator });
    const text = 'One line here.\n\nTwo line here.\n\nThree line here.\n\nFour line here.';
    await app.translateText(text, 'en', 'ko');
    const st = app.getStore().stats;
    assert.equal(st.calls, 1);
    assert.ok(st.sent > text.length && st.got > 0);
    await app.translateText(text, 'en', 'ko');
    assert.equal(st.calls, 1);
    assert.ok(st.saved >= text.length);
    assert.equal(app.statCells(st).length, 6);
});
