export const AuthManager = {
    showLoginModal: false,
    isLoggingIn: false,
    loginError: null,
    loginForm: {
        username: '',
        apiKey: ''
    },
    
    // Auth State
    e621User: JSON.parse(localStorage.getItem('e621_credentials') || 'null'),

    openLoginModal() {
        this.loginError = null;
        if (this.e621User) {
            this.loginForm.username = this.e621User.username || '';
            this.loginForm.apiKey = this.e621User.apiKey || '';
        }
        this.showLoginModal = true;
    },

    async submitLogin() {
        if (!this.loginForm.username.trim() || !this.loginForm.apiKey.trim()) {
            this.loginError = 'Both username and API key are required.';
            return;
        }

        this.isLoggingIn = true;
        this.loginError = null;

        try {
            const authString = btoa(`${this.loginForm.username.trim()}:${this.loginForm.apiKey.trim()}`);
            const appAuthor = import.meta.env.VITE_E621_APP_AUTHOR;
            
            // Test verification against e621 endpoint
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

            // Save credentials locally
            const credentials = {
                username: userData.name,
                apiKey: this.loginForm.apiKey.trim(),
                id: userData.id
            };

            localStorage.setItem('e621_credentials', JSON.stringify(credentials));
            this.e621User = credentials;
            this.showLoginModal = false;

            if (this.showToast) {
                this.showToast(`Logged in as ${userData.name}`, 'success');
            }
        } catch (err) {
            this.loginError = err.message || 'Failed to authenticate with e621.';
        } finally {
            this.isLoggingIn = false;
        }
    },

    logout() {
        localStorage.removeItem('e621_credentials');
        this.e621User = null;
        this.loginForm.username = '';
        this.loginForm.apiKey = '';
        if (this.showToast) {
            this.showToast('Logged out of e621', 'info');
        }
    }
};