// @ts-check

import { showToast } from './toasts.js';

/**
 * Initial reactive state for authentication
 */
export const initialAuthState = {
    showLoginModal: false,
    isLoggingIn: false,
    loginError: null,
    loginForm: {
        username: '',
        apiKey: ''
    },
    e621User: JSON.parse(localStorage.getItem('e621_credentials') || 'null')
};

/**
 * @param {AppState} state
 */
export async function login(state) {
    if (!state.loginForm.username.trim() || !state.loginForm.apiKey.trim()) {
        state.loginError = 'Both username and API key are required.';
        return;
    }

    state.isLoggingIn = true;
    state.loginError = null;

    try {
        const authString = btoa(`${state.loginForm.username.trim()}:${state.loginForm.apiKey.trim()}`);
        const appAuthor = import.meta.env.VITE_E621_APP_AUTHOR;
        
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
            apiKey: state.loginForm.apiKey.trim(),
            id: userData.id
        };

        localStorage.setItem('e621_credentials', JSON.stringify(credentials));
        state.e621User = credentials;
        state.showLoginModal = false;

        showToast(state, `Logged in as ${userData.name}`, 'success');

    } catch (err) {
        state.loginError = err instanceof Error ? err.message : 'Failed to authenticate with e621.';
    } finally {
        state.isLoggingIn = false;
    }
}

/**
 * @param {AppState} state
 */
export function logout(state) {
    localStorage.removeItem('e621_credentials');
    state.e621User = null;
    state.loginForm.username = '';
    state.loginForm.apiKey = '';
    
    showToast(state, 'Logged out of e621', 'info');
}