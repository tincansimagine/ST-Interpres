// index.js를 실리태번 없이 불러 번역 흐름 전체를 돌려 보는 실행기. 모델 호출은 가짜다.
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as seal from '../seal.mjs';
import * as codeblocks from '../codeblocks.mjs';
import * as jobs from '../jobs.mjs';
import * as refresh from '../render-refresh.mjs';
import * as book from '../book-transfer.mjs';
import * as proxy from '../reverse-proxy.mjs';

export async function runtime({ translate } = {}) {
    const raw = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const source = raw.replace(/^import\b[\s\S]*?;\r?\n/gm, '').replace(/import\.meta\.url/g, '"file:///x/index.js"');
    const calls = [];
    const events = {};
    const eventSource = {
        events,
        on(type, fn) { (events[type] ||= []).push(fn); },
        makeFirst(type, fn) { (events[type] ||= []).unshift(fn); },
        async emit(type, ...args) { for (const fn of events[type] || []) await fn(...args); },
    };
    const fake = new Proxy(function () {}, { get: (t, k) => (k === 'length' ? 0 : k === Symbol.iterator ? [][Symbol.iterator] : () => fake), apply: () => fake });
    const redrawn = [];
    const context = vm.createContext({
        ...seal, ...codeblocks, ...jobs, ...refresh, ...book, ...proxy,
        console, structuredClone, setTimeout, clearTimeout, AbortController, Promise, Map, Set, URL, Event: class {},
        chat: [], chat_metadata: {}, extension_settings: {},
        eventSource, event_types: new Proxy({}, { get: (_, k) => String(k) }),
        getStringHash: (str, seed = 0) => [...String(str)].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, seed),
        uuidv4: randomUUID, substituteParams: (x) => x, getRequestHeaders: () => ({}), oai_settings: {},
        saveSettingsDebounced() {}, saveMetadataDebounced() {}, reloadCurrentChat: async () => {}, updateReasoningUI() {},
        updateMessageBlock: (id) => redrawn.push(id),
        getContext: () => ({ chatId: 'chat-1', saveChat: async () => {}, characters: [], characterId: 0 }),
        callGenericPopup: async () => false, POPUP_TYPE: { CONFIRM: 1, TEXT: 2, INPUT: 3 },
        SlashCommandParser: { addCommandObject() {} }, SlashCommand: { fromProps: (x) => x }, SlashCommandArgument: { fromProps: (x) => x }, ARGUMENT_TYPE: {},
        generateRaw: async ({ prompt, systemPrompt }) => {
            const user = prompt[0].content;
            calls.push(user);
            return translate ? translate(user, systemPrompt) : '';
        },
        $: () => fake, jQuery: () => {}, toastr: { success() {}, info() {}, warning() {}, error() {} },
    });
    vm.runInContext(source, context, { filename: 'index.js' });
    const api = vm.runInContext('({ getSettings, getStore, translateText, translateIncoming, toggleCodeBlock, learnEdits, sealText, attachTranslation, plainDisplay, jobs, requests })', context);
    return { ...api, context, calls, redrawn, chat: context.chat, run: (code) => vm.runInContext(code, context) };
}

/** 가짜 번역기: PASSAGE 사이의 글에서 영어 낱말을 [ko:낱말]로 바꾼다. 봉인 표식은 그대로 돌려준다. */
export function fakeTranslator(user) {
    const m = user.match(/=== PASSAGE START ===\n?([\s\S]*?)\n?=== PASSAGE END ===/);
    const body = m ? m[1] : user;
    return body.replace(/(<seal-\d+\/>)|([A-Za-z][A-Za-z']*)/g, (all, sealTag, word) => sealTag || `한${word.length}`);
}
