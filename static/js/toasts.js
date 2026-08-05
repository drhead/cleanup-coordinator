// @ts-check
import Alpine from 'alpinejs';

export class ToastManager {
    constructor() {
        /** @type {Array<{id: number, message: string, type: string}>} */
        this.toasts = [];
    }

    /**
     * @param {string} message
     * @param {'error' | 'success' | 'info' | 'warning'} [type='error']
     * @param {number} [duration=4000]
     */
    show(message, type = 'error', duration = 4000) {
        const id = Date.now() + Math.random();
        this.toasts.push({ id, message, type });

        if (duration > 0) {
            setTimeout(() => this.remove(id), duration);
        }
    }

    /**
     * @param {number} id
     */
    remove(id) {
        this.toasts = this.toasts.filter(t => t.id !== id);
    }
}

// Global helper so you can just call showToast("msg") anywhere in plain JS
/**
 * @param {string} message
 * @param {'error' | 'success' | 'info' | 'warning'} [type='error']
 * @param {number} [duration=4000]
 */
export function showToast(message, type = 'error', duration = 4000) {
    if (window.Alpine?.store('toasts')) {
        // @ts-expect-error
        window.Alpine.store('toasts').show(message, type, duration);
    }
}

// Attach directly to Alpine store on init
document.addEventListener('alpine:init', () => {
    Alpine.store('toasts', new ToastManager());
});