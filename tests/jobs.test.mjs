import test from 'node:test';
import assert from 'node:assert/strict';
import { Limiter, Job, runAll, isCancel, withTimeout, raceAbort } from '../jobs.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('the limiter never runs more than its share at once, across jobs', async () => {
    const lim = new Limiter(2);
    let live = 0, peak = 0;
    await Promise.all(Array.from({ length: 7 }, () => lim.run(async () => { live++; peak = Math.max(peak, live); await sleep(10); live--; })));
    assert.equal(peak, 2);
});

test('a job keeps finished parts, so a retry only redoes what failed', async () => {
    const checkpoint = {};
    let calls = 0;
    const flaky = new Set(['b']);
    const run = async () => {
        const job = new Job({ checkpoint });
        job.plan(3);
        try {
            await runAll(['a', 'b', 'c'], k => job.part(k, async () => { calls++; if (flaky.has(k)) throw new Error('boom'); return k.toUpperCase(); }));
            job.finish();
        } catch (e) { job.finish(e); }
        return job;
    };
    const first = await run();
    assert.equal(first.status, 'failed');
    assert.deepEqual(Object.keys(checkpoint).sort(), ['a', 'c'], 'the parts that worked are kept even though one failed');
    flaky.clear();
    calls = 0;
    const second = await run();
    assert.equal(second.status, 'done');
    assert.equal(calls, 1, 'only the failed part is asked again');
    assert.equal(second.reused, 2);
});

test('cancelling aborts queued and running requests and reports cancel, not failure', async () => {
    const lim = new Limiter(1);
    const job = new Job();
    let sawAbort = false;
    const running = job.part('x', (signal) => lim.run(() => new Promise((_, reject) => signal.addEventListener('abort', () => { sawAbort = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); })), signal));
    const queued = job.part('y', (signal) => lim.run(async () => 'never', signal));
    await sleep(5);
    job.cancel();
    const results = await Promise.allSettled([running, queued]);
    assert.ok(results.every(r => r.status === 'rejected' && isCancel(r.reason)));
    assert.equal(sawAbort, true, 'the in-flight request itself was told to stop');
    assert.equal(job.status, 'cancelled');
    assert.equal(job.failed, 0);
    assert.equal(lim.active, 0);
});

test('a job that stops being current cancels itself at the next step', async () => {
    let current = true;
    const job = new Job({ isCurrent: () => current });
    await job.part('a', async () => 1);
    current = false;
    await assert.rejects(job.part('b', async () => 2), isCancel);
    assert.equal(job.status, 'cancelled');
});

test('timeouts and external aborts are told apart; unabortable work is raced', async () => {
    const outer = new AbortController();
    const t = withTimeout(outer.signal, 10);
    await sleep(20);
    assert.equal(t.timedOut(), true);
    t.done();
    const u = withTimeout(outer.signal, 1000);
    outer.abort();
    assert.equal(u.signal.aborted, true);
    assert.equal(u.timedOut(), false);
    u.done();
    const c = new AbortController();
    const p = raceAbort(new Promise(() => {}), c.signal);
    c.abort();
    await assert.rejects(p, isCancel);
});
