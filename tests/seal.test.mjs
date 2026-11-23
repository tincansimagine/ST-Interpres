import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SEAL_RX, mediaSealPatterns, sealWith, unsealText, mediaTokens, displayOnlyMedia, mediaStamp, restoreMedia } from '../seal.mjs';

const IMG = '<img src="/user/images/Aria/pic_01.png" title="1girl, smile > soft light" alt="a girl">';

test('image tags are sealed so the model never sees or rewrites them', () => {
    const { sealed, vault } = sealWith(`She smiled.\n\n${IMG}\n\nHe left.`, mediaSealPatterns());
    assert.ok(!sealed.includes('<img'));
    assert.ok(!sealed.includes('1girl'));
    assert.deepEqual(vault, [IMG]);
    assert.equal(unsealText(sealed, vault).restored, `She smiled.\n\n${IMG}\n\nHe left.`);
});

test('paired media, lone tags and bare data URIs are all sealed', () => {
    const video = '<video controls><source src="/a.mp4" type="video/mp4">no video</video>';
    const data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ';
    const { sealed, vault } = sealWith(`a ${video} b <IMG SRC='x.webp'/> c ${data} d`, mediaSealPatterns());
    assert.equal(sealed, 'a <seal-0/> b <seal-1/> c <seal-2/> d');
    assert.equal(vault.length, 3);
});

test('a translation that drops the image seal reports it missing', () => {
    const { sealed, vault } = sealWith(`Hi.\n\n${IMG}`, mediaSealPatterns());
    const { restored, missing } = unsealText(sealed.replace(/<seal-0\/>/, '').replace('Hi.', '안녕.'), vault);
    assert.deepEqual(missing, [0]);
    assert.ok(!restored.includes('<img'));
});

test('nested seals are restored and not counted as missing', () => {
    const patterns = [/\{\{[^{}\n]*\}\}/g, ...mediaSealPatterns(), /```[\s\S]*?```/g];
    const src = `{{char}} says:\n\`\`\`\n{{user}} ${IMG}\n\`\`\``;
    const { sealed, vault } = sealWith(src, patterns);
    assert.equal(sealed, '<seal-0/> says:\n<seal-3/>');
    const { restored, missing } = unsealText(sealed, vault);
    assert.equal(restored, src);
    assert.deepEqual(missing, []);
});

test('unknown seal numbers from the model are dropped, tolerant spellings accepted', () => {
    const { restored } = unsealText('가 <seal_0> 나 <Seal 9/> 다', ['X']);
    assert.equal(restored, '가 X 나  다');
    assert.ok(SEAL_RX.global);
});

test('media that lived only on the translated side is carried to the new translation', () => {
    const hash = (x) => `h${x.length}:${x.slice(0, 12)}`;
    const oldSource = `Hello.\n\n${IMG}`;
    const added = '<img src="/user/images/Aria/extra.png">';
    const oldDisplay = `안녕.\n\n${IMG}\n\n${added}`;
    const keep = displayOnlyMedia(oldDisplay, mediaStamp(oldSource, hash), hash);
    assert.deepEqual(keep, [added]);
    const out = restoreMedia(`안녕, 다시.\n\n${IMG}`, keep, `Hello again.\n\n${IMG}`);
    assert.ok(out.endsWith(added));
    assert.equal(out.split(added).length, 2);
});

test('an image the user removed from the source is not resurrected', () => {
    const oldSource = `Hello.\n\n${IMG}`;
    const keep = displayOnlyMedia(`안녕.\n\n${IMG}`, mediaStamp(oldSource));
    assert.deepEqual(keep, []);
    assert.equal(restoreMedia('안녕.', keep, 'Hello.'), '안녕.');
});

test('translations without a media stamp (older versions) are left alone', () => {
    assert.deepEqual(displayOnlyMedia(`안녕 ${IMG}`, undefined), []);
});

test('restoreMedia does not duplicate what is already there', () => {
    assert.equal(restoreMedia(`가 ${IMG}`, [IMG, IMG]), `가 ${IMG}`);
    assert.deepEqual(mediaTokens(`![a](b.png) ${IMG} ${IMG}`), ['![a](b.png)', IMG]);
});

test('index.js wires the seal module and never deletes a translation before its replacement exists', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.ok(src.includes('...mediaSealPatterns()'));
    assert.ok(src.includes('restoreMedia(translated, keepMedia, source)'));
    assert.ok(!/delete message\.extra\.display_text;\s*\n\s*await translateIncoming\(mesId, \{ force: true, fresh: true \}\)/.test(src));
});
