import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseBook, exportBook, mergeBook } from '../book-transfer.mjs';

const book = () => ({
    glossary: [{ id: 'g1', src: ' Alice ', dst: '앨리스' }],
    voiceCards: [{ id: 'v1', name: 'Alice', style: '반말' }],
    apiKey: 'must-not-export', blocks: { secret: 'chat text' },
});
const incoming = { glossary: [{ src: 'Alice', dst: '알리스' }, { src: 'Bob', dst: '밥' }], voiceCards: [{ name: 'Alice', style: '존댓말' }] };

test('round trip contains only portable fields, including Unicode', () => {
    const { text, count } = exportBook(book());
    assert.equal(count, 2);
    assert.ok(!text.includes('must-not-export'));
    assert.ok(!text.includes('chat text'));
    assert.ok(!text.includes('g1'));
    assert.equal(parseBook('\uFEFF' + text).glossary[0].src, 'Alice');
});

test('selected exports omit other sections and skip unfinished/duplicate rows', () => {
    const source = book();
    source.glossary.push({ src: 'Alice', dst: 'duplicate' }, { src: 'Bob', dst: '' });
    const result = exportBook(source, 'glossary');
    assert.equal(result.skipped, 2);
    assert.deepEqual(parseBook(result.text).voiceCards, []);
    assert.deepEqual(parseBook(exportBook(source, 'voiceCards').text).glossary, []);
});

test('keep preserves existing values and repeated imports are idempotent', () => {
    const source = book();
    const original = structuredClone(source);
    const merged = mergeBook(source, incoming, 'all', 'keep', () => 'new-id');
    assert.deepEqual(merged.counts, { added: 1, updated: 0, skipped: 2 });
    assert.equal(merged.glossary[0].dst, '앨리스');
    assert.equal(merged.glossary[1].id, 'new-id');
    assert.deepEqual(source, original);
    assert.equal(mergeBook(merged, incoming, 'all', 'keep', () => 'other').counts.added, 0);
});

test('update changes matching content while preserving IDs and unselected sections', () => {
    const merged = mergeBook(book(), incoming, 'voiceCards', 'update', () => 'new');
    assert.equal(merged.voiceCards[0].style, '존댓말');
    assert.equal(merged.voiceCards[0].id, 'v1');
    assert.equal(merged.glossary[0].dst, '앨리스');
    assert.deepEqual(merged.counts, { added: 0, updated: 1, skipped: 0 });
});

test('invalid formats and rows fail atomically', () => {
    for (const data of [null, {}, { format: 'interpres-book', version: 2 },
        ...[null, {}, [null], [{ src: 'Alice', dst: 1 }], [{ src: '', dst: 'x' }],
            [{ src: 'Alice', dst: 'a' }, { src: ' Alice ', dst: 'b' }],
            [{ src: 'a', dst: 'x'.repeat(20001) }]
        ].map(glossary => ({ format: 'interpres-book', version: 1, glossary, voiceCards: [] })),
    ]) assert.throws(() => parseBook(JSON.stringify(data)));
    assert.throws(() => parseBook('{invalid'));
});

// Exercise the actual asynchronous import handler without requiring a SillyTavern server.
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function harness(onConfirm = () => true) {
    const state = { id: 'A', book: book(), errors: [], saved: 0, confirmed: 0 };
    const context = vm.createContext({
        MAX_BOOK_BYTES: 5 * 1024 * 1024, parseBook, mergeBook, uuidv4: () => 'fresh',
        currentChatId: () => state.id, chat_metadata: { interpres: state.book }, MODULE_NAME: 'interpres',
        renderGlossary() {}, renderVoiceCards() {}, persistBook: async () => { state.saved++; },
        toastr: { info() {}, success() {}, error: message => state.errors.push(message) },
        POPUP_TYPE: { CONFIRM: 1 },
        callGenericPopup: async () => { state.confirmed++; return onConfirm(state, context); },
    });
    const guard = source.slice(source.indexOf('function assertCurrentBook('), source.indexOf('function downloadBook('));
    const handlerStart = source.indexOf('async function importBookFile(');
    const handlerEnd = source.indexOf('\n/**', handlerStart);
    vm.runInContext(`let bookImportBusy = false; ${guard}\n${source.slice(handlerStart, handlerEnd)}`, context);
    state.run = (file = { size: 100, text: async () => exportBook({ ...incoming }).text }) =>
        context.importBookFile(file, { id: 'A', book: state.book }, 'all', 'update');
    return state;
}

test('confirmed import persists once', async () => {
    const state = harness();
    await state.run();
    assert.equal(state.saved, 1);
    assert.equal(state.book.glossary[0].dst, '알리스');
    assert.deepEqual(state.errors, []);
});

test('cancel leaves destination unchanged', async () => {
    const state = harness(() => false);
    const before = structuredClone(state.book);
    await state.run();
    assert.deepEqual(state.book, before);
    assert.equal(state.saved, 0);
});

test('chat changes during confirmation cannot modify either book', async () => {
    const state = harness((s, context) => { s.id = 'B'; context.chat_metadata.interpres = book(); return true; });
    const before = structuredClone(state.book);
    await state.run();
    assert.deepEqual(state.book, before);
    assert.equal(state.saved, 0);
    assert.match(state.errors[0], /채팅방이 바뀌어/);
});

test('concurrent edits are retained and stale import is rejected', async () => {
    const state = harness(s => { s.book.glossary[0].dst = 'manual edit'; return true; });
    await state.run();
    assert.equal(state.book.glossary[0].dst, 'manual edit');
    assert.equal(state.saved, 0);
    assert.match(state.errors[0], /목록이 수정/);
});

test('oversized and malformed files never reach confirmation', async () => {
    const state = harness();
    await state.run({ size: 6 * 1024 * 1024, text: () => { throw new Error('must not read'); } });
    await state.run({ size: 10, text: async () => '{}' });
    assert.equal(state.confirmed, 0);
    assert.equal(state.saved, 0);
    assert.equal(state.errors.length, 2);
});

test('chat changes during file reading cancel before confirmation', async () => {
    const state = harness();
    await state.run({ size: 100, text: async () => {
        state.id = 'B';
        return exportBook(incoming).text;
    } });
    assert.equal(state.confirmed, 0);
    assert.equal(state.saved, 0);
    assert.match(state.errors[0], /채팅방이 바뀌어/);
});

for (const scan of ['scanVoiceCards', 'scanGlossary']) {
    test(`${scan} does not save API results in a different chat`, async () => {
        let currentId = 'A';
        let saved = 0;
        const errors = [];
        const original = book();
        const context = vm.createContext({
            currentChatId: () => currentId, getBook: () => original,
            MODULE_NAME: 'interpres', chat_metadata: { interpres: original },
            collectScanMaterial: () => 'material', getSettings: () => ({ viewLang: 'ko' }),
            langName: () => 'Korean', VOICE_SCAN_PROMPT: '', TERM_SCAN_PROMPT: '',
            callTranslator: async () => { currentId = 'B'; return '{}'; },
            persistBook: async () => { saved++; },
            toastr: { info() {}, warning() {}, error: message => errors.push(message) },
        });
        const guards = source.slice(source.indexOf('function captureBook('), source.indexOf('function downloadBook('));
        const start = source.indexOf('async function scanVoiceCards(');
        const end = source.indexOf('\n/* ===', start);
        vm.runInContext(guards + source.slice(start, end), context);
        await context[scan]();
        assert.equal(saved, 0);
        assert.match(errors[0], /채팅방이 바뀌어/);
    });
}
