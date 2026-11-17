// Injected into the page (main world). Freezes the page's time: timers,
// requestAnimationFrame, performance.now/Date.now and every CSS or Web
// animation only move when the renderer calls __vr.advanceTo(ms), so each
// captured frame sits exactly 1/fps after the previous one, however long the
// capture itself takes.
(() => {
    if (window.__vr) return "already";
    const real = {
        setTimeout: window.setTimeout.bind(window),
        clearTimeout: window.clearTimeout.bind(window),
        clearInterval: window.clearInterval.bind(window),
        now: performance.now.bind(performance),
        dateNow: Date.now,
    };
    const realBase = real.now();
    const dateBase = real.dateNow();
    let vnow = 0;

    // A real macrotask: lets promise chains, React renders and fetch callbacks
    // started by a timer finish before the next timer or the capture.
    const channel = new MessageChannel();
    const waiting = [];
    channel.port1.onmessage = () => waiting.shift()?.();
    const settle = () => new Promise((resolve) => { waiting.push(resolve); channel.port2.postMessage(0); });

    const timers = new Map();
    let nextId = 1e9;
    const schedule = (fn, ms, args, every) => {
        const id = nextId++;
        const delay = Math.max(0, Number(ms) || 0);
        timers.set(id, { at: vnow + delay, fn, args, every: every ? Math.max(1, delay) : 0, id });
        return id;
    };
    window.setTimeout = (fn, ms, ...args) => schedule(fn, ms, args, false);
    window.setInterval = (fn, ms, ...args) => schedule(fn, ms, args, true);
    window.clearTimeout = window.clearInterval = (id) => {
        if (!timers.delete(id)) real.clearTimeout(id);
    };

    let frameCallbacks = new Map();
    let nextFrameId = 1;
    window.requestAnimationFrame = (cb) => { const id = nextFrameId++; frameCallbacks.set(id, cb); return id; };
    window.cancelAnimationFrame = (id) => frameCallbacks.delete(id);

    performance.now = () => realBase + vnow;
    Date.now = () => dateBase + vnow;

    const call = (fn, args) => {
        try {
            if (typeof fn === "function") fn(...args);
            else (0, eval)(String(fn));
        } catch (error) {
            console.error("[video-render] timer callback failed", error);
        }
    };

    // Animation -> virtual time at which its currentTime was 0.
    const origins = new WeakMap();
    const syncAnimations = () => {
        for (const animation of document.getAnimations()) {
            let origin = origins.get(animation);
            if (origin === undefined) {
                origin = vnow - (animation.currentTime ?? 0);
                origins.set(animation, origin);
            }
            if (animation.playState !== "paused") animation.pause();
            animation.currentTime = vnow - origin;
        }
    };

    const state = { done: false, error: null, startedAt: null };
    window.__vr = {
        now: () => vnow,
        state,
        run(source) {
            state.startedAt = vnow;
            const scenario = (0, eval)(`(async () => {\n${source}\n})`);
            scenario().then(
                () => { state.done = true; },
                (error) => { state.error = String(error?.stack ?? error); state.done = true; },
            );
        },
        async advanceTo(target) {
            for (;;) {
                let due = null;
                for (const timer of timers.values()) {
                    if (timer.at <= target && (!due || timer.at < due.at || (timer.at === due.at && timer.id < due.id))) due = timer;
                }
                if (!due) break;
                vnow = Math.max(vnow, due.at);
                if (due.every) due.at += due.every;
                else timers.delete(due.id);
                call(due.fn, due.args);
                await settle();
            }
            vnow = Math.max(vnow, target);
            const callbacks = frameCallbacks;
            frameCallbacks = new Map();
            for (const cb of callbacks.values()) call(cb, [realBase + vnow]);
            await settle();
            syncAnimations();
            return { done: state.done, error: state.error };
        },
    };
    return "ok";
})();
