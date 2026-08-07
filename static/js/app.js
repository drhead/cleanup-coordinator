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
import { tagManager } from './tags.js';

import { ImageModalComponent } from './image_modal.js';
import { ComparisonManager } from './comparison.js';
import { ReconciliationManager } from './reconciliation.js';

document.addEventListener('alpine:init', () => {
    Alpine.store('batches', batchManager);

    Alpine.data('app', () => ({
        isLoading: true,
        currentScreen: 'projects',
        projects: [],
        loadingText: 'Initializing...',
        loadingPercent: 0,
        showInstructionsModal: false,
        isAgeVerified: !!localStorage.getItem('e621_age_verified'),

        // Expose pure display helpers to template if accessed as methods
        getBatchStatusLabel,
        getBatchStatusClass,
        getProgressPercent,
        getProjectResolvedCount,
        getProjectTotalCount,

        async init() {
            if (!this.isAgeVerified) {
                this.isLoading = false;
                return;
            }
            await this.loadAppData();
        },

        async confirmAge() {
            localStorage.setItem('e621_age_verified', 'true');
            this.isAgeVerified = true;
            await this.loadAppData();
        },

        /**
         * Helper to set loading UI text and percentage
         * @param {string} text 
         * @param {number} [percent=0] 
         */
        updateLoading(text, percent = 0) {
            this.loadingText = text;
            this.loadingPercent = percent;
        },

        async loadAppData() {
            this.isLoading = true;
            try {
                // 1. Fetch Projects (0% - 15%)
                this.updateLoading('Fetching project list...', 5);
                const res = await fetch('/api/v1/projects');
                if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                const data = await res.json();
                this.projects = data.projects || [];
                this.updateLoading('Project list loaded.', 15);

                // 2. Init Tag Manager (15% - 85%)
                // Maps TagManager's 0-100% internally to 15-85% on the global loading bar
                await tagManager.init((status, percent) => {
                    const scaledPercent = Math.round(15 + (percent * 0.7)); 
                    this.updateLoading(status, scaledPercent);
                });

                // 3. Init Batch Manager (85% - 100%)
                this.updateLoading('Loading project batch data...', 85);

                await /** @type {import('./batches.js').BatchManager} */ (Alpine.store('batches')).init();

                this.updateLoading('Ready!', 100);

                await new Promise(resolve => setTimeout(resolve, 150));
                const hasSeenInstructions = localStorage.getItem('hasSeenInstructions');
                if (!hasSeenInstructions) {
                    this.showInstructionsModal = true;
                    localStorage.setItem('hasSeenInstructions', 'true');
                }
            } catch (err) {
                console.error('[App] Failed to load initial data:', err);
            } finally {
                this.isLoading = false;
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



});

// Register Alpine components explicitly
Alpine.data('ImageModalComponent', ImageModalComponent);
Alpine.data('ComparisonManager', ComparisonManager);
Alpine.data('ReconciliationManager', ReconciliationManager);

// Attach to window if expressions are evaluated directly in x-data strings
window.ComparisonManager = ComparisonManager;
window.ReconciliationManager = ReconciliationManager;

Alpine.start();