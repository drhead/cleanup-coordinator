// @ts-check

import Alpine from 'alpinejs';

// Import pure formatting/helper functions if needed directly in templates
import {
    batchManager,
    getBatchStatusLabel,
    getBatchStatusClass,
    getProgressPercent,
    getProjectResolvedCount,
    getProjectTotalCount
} from './batches.js';

import { ImageModalComponent } from './image_modal.js';
import { ComparisonManager } from './comparison.js';
import { ReconciliationManager } from './reconciliation.js';

document.addEventListener('alpine:init', () => {

    Alpine.data('app', () => ({
        currentScreen: 'projects',
        projects: [],
        showInstructionsModal: false,
        isAgeVerified: !!localStorage.getItem('e621_age_verified'),

        // Expose pure display helpers to template if accessed as methods (e.g. getBatchStatusLabel(batch))
        getBatchStatusLabel,
        getBatchStatusClass,
        getProgressPercent,
        getProjectResolvedCount,
        getProjectTotalCount,

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
                });

            const hasSeenInstructions = localStorage.getItem('hasSeenInstructions');
            if (!hasSeenInstructions) {
                this.showInstructionsModal = true;
                localStorage.setItem('hasSeenInstructions', 'true');
            }
        },

        /**
         * Helper when a user clicks a project in the UI
         * @param {string} projectId
         */
        selectProject(projectId) {
            /** @type {import('./batches.js').BatchManager} */ (Alpine.store('batches')).selectProject(this.projects, projectId);
            this.currentScreen = 'batches';
        },
        /**
         * Views batch detail and switches screen
         * @param {Batch} batch
         */
        viewBatch(batch) {
            /** @type {import('./batches.js').BatchManager} */ (Alpine.store('batches')).viewBatchDetail(batch);
            this.currentScreen = 'batch_detail';
        },
    }));
    Alpine.store('batches', batchManager);
    /** @type {import('./batches.js').BatchManager} */ (Alpine.store('batches')).init();
});

// Register Alpine components explicitly
Alpine.data('ImageModalComponent', ImageModalComponent);
Alpine.data('ComparisonManager', ComparisonManager);
Alpine.data('ReconciliationManager', ReconciliationManager);

// Attach to window if expressions are evaluated directly in x-data strings
window.ComparisonManager = ComparisonManager;
window.ReconciliationManager = ReconciliationManager;

Alpine.start();