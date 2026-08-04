// @ts-check

/**
 * @param {AppState} state
 * @param {string} message
 * @param {'error' | 'success' | 'info' | 'warning'} [type='error']
 * @param {number} [duration=4000]
 */
export function showToast(state, message, type = 'error', duration = 4000) {
    const id = Date.now() + Math.random();
    state.toasts.push({ id, message, type });

    if (duration > 0) {
        setTimeout(() => {
            removeToast(state, id);
        }, duration);
    }
}

/**
 * @param {AppState} state
 * @param {number} id
 */
export function removeToast(state, id) {
    state.toasts = state.toasts.filter(t => t.id !== id);
}