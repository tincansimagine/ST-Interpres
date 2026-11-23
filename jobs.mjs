/**
 * 번역 작업 — 진행률, 취소, 이어서 하기, 동시 요청 제한.
 *
 * - 취소하면 기다리기만 멈추는 게 아니라 진행 중인 요청 자체를 끊는다 (끊을 수 있는 연결이면).
 *   한 번에 하나만 받는 프록시에서 취소한 번역이 자리를 붙잡고 있지 않게.
 * - 끝난 조각은 checkpoint에 남는다. 실패하거나 취소한 뒤 다시 하면 끝난 조각은 다시 부르지 않는다.
 * - 모든 작업이 하나의 요청 한도(limiter)를 나눠 쓴다. 긴 메시지 여러 개를 한꺼번에 번역해도
 *   동시에 나가는 요청은 정해 둔 수를 넘지 않는다.
 */

export function cancelled() {
    const e = new Error('번역을 취소했습니다.');
    e.name = 'AbortError';
    return e;
}

export function isCancel(e) {
    return e?.name === 'AbortError';
}

/** 동시 요청 한도. 기다리는 쪽이 취소되면 줄에서 빠진다. */
export class Limiter {
    constructor(max = () => 2) {
        this.max = typeof max === 'function' ? max : () => max;
        this.active = 0;
        this.queue = [];
    }
    pump() {
        while (this.queue.length && this.active < Math.max(1, this.max())) {
            const next = this.queue.shift();
            if (next.signal?.aborted) { next.reject(cancelled()); continue; }
            this.active++;
            next.resolve();
        }
    }
    async run(task, signal) {
        if (signal?.aborted) throw cancelled();
        await new Promise((resolve, reject) => {
            const entry = { resolve, reject, signal };
            this.queue.push(entry);
            signal?.addEventListener('abort', () => {
                const i = this.queue.indexOf(entry);
                if (i >= 0) { this.queue.splice(i, 1); reject(cancelled()); }
            }, { once: true });
            this.pump();
        });
        try { return await task(); } finally { this.active--; this.pump(); }
    }
}

export class Job {
    /**
     * key: 작업 이름 (메시지마다 하나), label: 화면에 보일 이름
     * checkpoint: 끝난 조각을 담아 둘 객체 (저장소에 두면 새로고침해도 이어서 한다)
     * onChange: 진행이 바뀔 때마다 (화면 갱신용)
     */
    constructor({ key = '', label = '번역', checkpoint = {}, onChange = () => {}, isCurrent = () => true } = {}) {
        Object.assign(this, { key, label, checkpoint, onChange, isCurrent });
        this.controller = new AbortController();
        this.status = 'running';
        this.total = 0;
        this.done = 0;
        this.failed = 0;
        this.reused = 0;
        this.started = Date.now();
        this.ended = 0;
    }
    get signal() { return this.controller.signal; }
    get seconds() { return Math.round(((this.ended || Date.now()) - this.started) / 1000); }
    check() {
        if (!this.signal.aborted && !this.isCurrent()) this.cancel();
        if (this.signal.aborted) throw cancelled();
    }
    cancel() {
        if (this.status !== 'running') return;
        this.status = 'cancelled';
        this.ended = Date.now();
        this.controller.abort();
        this.onChange(this);
    }
    plan(n) { this.total += n; this.onChange(this); }
    /** 조각 하나. 이미 끝난 조각이면 저장해 둔 결과를 돌려준다. */
    async part(key, task) {
        this.check();
        if (Object.hasOwn(this.checkpoint, key)) {
            this.reused++; this.done++;
            this.onChange(this);
            return this.checkpoint[key];
        }
        try {
            const out = await task(this.signal);
            this.check();
            this.checkpoint[key] = out;
            this.done++;
            this.onChange(this);
            return out;
        } catch (e) {
            if (!isCancel(e)) { this.failed++; this.onChange(this); }
            throw e;
        }
    }
    finish(error) {
        if (this.status === 'running') this.status = error ? (isCancel(error) ? 'cancelled' : 'failed') : 'done';
        this.ended = Date.now();
        this.onChange(this);
    }
}

/**
 * 조각들을 한꺼번에 돌린다 (한도는 limiter가 지킨다).
 * 하나가 실패해도 나머지는 끝까지 돌려 checkpoint에 남긴다 — 다시 할 때 실패한 것만 부르게.
 */
export async function runAll(items, fn) {
    const results = await Promise.allSettled(items.map((item, i) => fn(item, i)));
    const cancel = results.find(r => r.status === 'rejected' && isCancel(r.reason));
    if (cancel) throw cancel.reason;
    const fail = results.find(r => r.status === 'rejected');
    if (fail) throw fail.reason;
    return results.map(r => r.value);
}

/** 외부 신호와 시간 제한을 묶은 신호 */
export function withTimeout(signal, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
    const relay = () => controller.abort(signal.reason);
    if (signal) {
        if (signal.aborted) relay();
        else signal.addEventListener('abort', relay, { once: true });
    }
    return {
        signal: controller.signal,
        timedOut: () => controller.signal.aborted && !signal?.aborted,
        done: () => { clearTimeout(timer); signal?.removeEventListener('abort', relay); },
    };
}

/** 끊을 수 없는 요청(실리태번 내장 생성 등)은 기다리기만 멈춘다 */
export function raceAbort(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
        const stop = () => reject(cancelled());
        signal.addEventListener('abort', stop, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    });
}
