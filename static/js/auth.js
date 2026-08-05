// @ts-check
import Alpine from 'alpinejs';
import { showToast } from './toasts.js';

/**
 * @typedef {Object} E621User
 * @property {string} username
 * @property {string} apiKey
 * @property {number} id
 */

export class AuthManager {
    constructor() {
        this.showLoginModal = false;
        this.isLoggingIn = false;
        /** @type {string|null} */
        this.loginError = null;
        
        this.loginForm = {
            username: '',
            apiKey: ''
        };

        /** @type {E621User|null} */
        this.e621User = JSON.parse(localStorage.getItem('e621_credentials') || 'null');
    }

    openLoginModal() {
        this.loginError = null;
        this.showLoginModal = true;
    }

    closeLoginModal() {
        this.showLoginModal = false;
    }

    async login() {
        const username = this.loginForm.username.trim();
        const apiKey = this.loginForm.apiKey.trim();

        if (!username || !apiKey) {
            this.loginError = 'Both username and API key are required.';
            return;
        }

        this.isLoggingIn = true;
        this.loginError = null;

        try {
            const authString = btoa(`${username}:${apiKey}`);
            const appAuthor = import.meta.env.VITE_E621_APP_AUTHOR || 'Unknown';

            const res = await fetch(`https://e621.net/users/me.json`, {
                headers: {
                    'Authorization': `Basic ${authString}`,
                    'User-Agent': `E621CleanupCoordinator/1.0 (by ${appAuthor})`
                }
            });

            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    throw new Error('Invalid username or API key.');
                }
                throw new Error(`e621 returned status ${res.status}`);
            }

            const userData = await res.json();

            /** @type {E621User} */
            const credentials = {
                username: userData.name,
                apiKey: apiKey,
                id: userData.id
            };

            localStorage.setItem('e621_credentials', JSON.stringify(credentials));
            this.e621User = credentials;
            this.showLoginModal = false;

            // Clear input fields on success
            this.loginForm.username = '';
            this.loginForm.apiKey = '';

            showToast(`Logged in as ${userData.name}`, 'success');

        } catch (err) {
            this.loginError = err instanceof Error ? err.message : 'Failed to authenticate with e621.';
        } finally {
            this.isLoggingIn = false;
        }
    }

    logout() {
        localStorage.removeItem('e621_credentials');
        this.e621User = null;
        this.loginForm.username = '';
        this.loginForm.apiKey = '';

        showToast('Logged out of e621', 'info');
    }
}

// Singleton instance
export const authManager = new AuthManager();

/**
 * Helper to get active user credentials anywhere in plain JS modules
 * @returns {E621User|null}
 */
export function getE621User() {
    if (window.Alpine?.store('auth')) {
        // @ts-expect-error
        return /** @type {E621User|null} */ (window.Alpine.store('auth').e621User);
    }
    return authManager.e621User;
}

// Register as Alpine Store
document.addEventListener('alpine:init', () => {
    Alpine.store('auth', authManager);
});