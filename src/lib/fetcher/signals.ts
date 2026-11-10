/**
 * 组合多个 AbortSignal，替代 Node 18.17 上不存在的 AbortSignal.any()。
 * dispose() 会移除所有监听，必须在请求的 finally 里调用，避免外部长生命周期 signal 上泄漏监听器。
 */
export function composeSignals(...signals: (AbortSignal | undefined)[]): {
    signal: AbortSignal;
    dispose(): void;
} {
    const controller = new AbortController();
    const listeners: { signal: AbortSignal; onAbort: () => void }[] = [];

    for (const source of signals) {
        if (!source) continue;
        if (source.aborted) {
            controller.abort(source.reason);
            continue;
        }
        const onAbort = () => controller.abort(source.reason);
        source.addEventListener('abort', onAbort, { once: true });
        listeners.push({ signal: source, onAbort });
    }

    let disposed = false;
    return {
        signal: controller.signal,
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const { signal, onAbort } of listeners) {
                signal.removeEventListener('abort', onAbort);
            }
        },
    };
}
