import Alpine from 'alpinejs';

import { ToastManager } from './toasts.js';
import { LeaseManager } from './leases.js';
import { TagManager } from './tags.js';
import { BatchManager } from './batches.js';
import { BlacklistManager } from './blacklist.js';
import { AuthManager } from './auth.js';
import { ComparisonManager } from './comparison.js';

window.Alpine = Alpine;

document.addEventListener('alpine:init', () => {
    Alpine.data('app', () => ({
// State Properties
        currentScreen: 'projects',
        projects: [],
        batches: [],
        activeProject: null,
        activeBatch: null,
        activeLease: null,
        nowTimestamp: Date.now(),
        toasts: [],
        showBlacklistModal: false,
        showInstructionsModal: false,
        blacklistText: localStorage.getItem('e621_blacklist') || 
            '# Violence\ngore\nsnuff\nrape\n\n# ABDL\nyoung -rating:s\ndiaper -rating:s\n\n# Fetish\nfeces\nurine\nfart_fetish\nrealistic_feral rating:e\n\n# Controversial\npolitics',
        hoveredMergedData: { clusterId: null, targetPostId: null, tags: [] },
        isAgeVerified: !!localStorage.getItem('e621_age_verified'),

        // Module Mixins
        ...ToastManager,
        ...LeaseManager,
        ...TagManager,
        ...BatchManager,
        ...BlacklistManager,
        ...AuthManager,
        ...ComparisonManager,

        init() {
            if (!this.isAgeVerified) {
                return;
            }
            this.loadAppData();
        },

        confirmAge() {
            localStorage.setItem('e621_age_verified', 'true');
            this.isAgeVerified = true;
            this.loadAppData();
        },

        loadAppData() {
            fetch('/api/v1/projects')
                .then(res => res.json())
                .then(data => {
                    this.projects = data.projects || [];
                    if (this.projects.length > 0) {
                        this.selectProject(this.projects[0].project_id);
                    }
                });

            const hasSeenInstructions = localStorage.getItem('hasSeenInstructions');
            if (!hasSeenInstructions) {
                this.showInstructionsModal = true;
                localStorage.setItem('hasSeenInstructions', 'true');
            }

            setInterval(() => {
                this.nowTimestamp = Date.now();
                this.checkLocalLeaseExpiration();
            }, 1000);

            this.startBackgroundPolling();
        }
    }));
});

Alpine.start();