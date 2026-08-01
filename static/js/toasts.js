export const ToastManager = {
    showToast(message, type = 'error', duration = 4000) {
        const id = Date.now() + Math.random();
        this.toasts.push({ id, message, type });

        if (duration > 0) {
            setTimeout(() => {
                this.removeToast(id);
            }, duration);
        }
    },

    removeToast(id) {
        this.toasts = this.toasts.filter(t => t.id !== id);
    }
};