// @ts-check

import Alpine from 'alpinejs';
import { alpineHelpers } from './alpine_helpers.js';

// Import pure formatting/helper functions if needed directly in templates
import {
    batchManager,
    fetchAndHydrateProjectBatches,
    getBatchStatusLabel,
    getBatchStatusClass,
    getProgressPercent,
    getProjectResolvedCount,
    getProjectTotalCount,
    getRemainingTimeString
} from './batches.js';
import { tagManager } from './tags.js';

import { ImageModalComponent } from './image_modal.js';
import { ComparisonManager } from './comparison.js';
import { ReconciliationManager } from './reconciliation.js';
import { ensureClusterPostsInfo } from './e621_api.js';

window.ensureClusterPostsInfo = ensureClusterPostsInfo;

document.addEventListener('alpine:init', () => {
    Alpine.store('batches', batchManager);

    Alpine.data('app', () => ({
        isLoading: true,
        currentScreen: 'projects',
        /** @type {Project[]} */
        projects: [],
        loadingText: 'Initializing...',
        loadingPercent: 0,
        showInstructionsModal: false,
        isAgeVerified: !!(localStorage.getItem('e621AgeVerified') || localStorage.getItem('e621_age_verified')),
        appVersion: import.meta.env.VITE_APP_VERSION || '0.4 Alpha',

        ...alpineHelpers,
        // Expose pure display helpers to template if accessed as methods
        getBatchStatusLabel,
        getBatchStatusClass,
        getProgressPercent,
        getProjectResolvedCount,
        getProjectTotalCount,
        getRemainingTimeString,

        get isScreenLoading() {
            if (this.isLoading) return true;
            const store = /** @type {import('./batches.js').BatchManager} */ (Alpine.store('batches'));
            if (!store) return false;
            if (this.currentScreen === 'batches' && (!store.batches || store.batches.length === 0)) {
                return true;
            }
            if (this.currentScreen === 'batchDetail' && !store.activeBatch) {
                return true;
            }
            return false;
        },

        async jumpToLeasedBatch(lease) {
            if (lease?.projectId && lease?.batchId) {
                this.setRoute(`/projects/${lease.projectId}/batches/${lease.batchId}`);
            } else {
                await /** @type {import('./batches.js').BatchManager} */ (Alpine.store('batches')).jumpToLeasedBatch(lease);
                this.currentScreen = 'batchDetail';
            }
        },

        revokeLease(batchId) {
            return /** @type {import('./batches.js').BatchManager} */ (Alpine.store('batches')).revokeLease(batchId);
        },

        async init() {
            window.addEventListener('hashchange', () => {
                this.handleRoute();
            });

            if (!this.isAgeVerified) {
                this.isLoading = false;
                return;
            }
            await this.loadAppData();
        },

        async confirmAge() {
            localStorage.setItem('e621AgeVerified', 'true');
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
                this.updateLoading('Hydrating project batches & resolutions...', 10);

                const store = /** @type {import('./batches.js').BatchManager} */ (Alpine.store('batches'));
                const hydrationResults = await Promise.all(
                    this.projects.map(p => fetchAndHydrateProjectBatches(p.projectId))
                );
                hydrationResults.forEach((result, idx) => {
                    const project = this.projects[idx];
                    project.resolvedClusters = result.resolvedClusters;
                    project.totalClusters = result.totalClusters;
                    if (store && store.cachedProjectBatches) {
                        store.cachedProjectBatches.set(project.projectId, result.batches);
                    }
                });

                this.updateLoading('Project list and counts ready.', 15);

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
                await this.handleRoute();
            }
        },

        _routeSeq: 0,

        /**
         * Parses window.location.hash and syncs app screen & batch state
         */
        async handleRoute() {
            if (this.isLoading) return;

            const currentSeq = ++this._routeSeq;
            window.scrollTo({ top: 0, behavior: 'instant' });

            const rawHash = window.location.hash || '';
            const cleanHash = rawHash.replace(/^#\/?/, '').trim();

            if (!cleanHash || cleanHash === 'projects') {
                this.currentScreen = 'projects';
                const store = /** @type {import('./batches.js').BatchManager} */ (Alpine.store('batches'));
                store.activeProject = null;
                store.activeBatch = null;
                return;
            }

            if (cleanHash === 'about') {
                this.currentScreen = 'about';
                return;
            }

            const parts = cleanHash.split('/').filter(Boolean);
            if (parts[0] === 'projects' && parts[1]) {
                const projectId = parts[1];
                const projectExists = (this.projects || []).some(p => p.projectId === projectId);
                if (!projectExists && this.projects.length > 0) {
                    // Invalid/unknown project ID, redirect to projects screen
                    this.setRoute('/projects');
                    return;
                }

                const store = /** @type {import('./batches.js').BatchManager} */ (Alpine.store('batches'));

                const isNewProject = !store.activeProject || store.activeProject.projectId !== projectId;
                if (isNewProject) {
                    // selectProject clears batches to [] and begins reloadBatches() in background
                    store.selectProject(this.projects, projectId);
                }

                if (parts[2] === 'batches' && parts[3]) {
                    const batchId = parts[3];
                    this.currentScreen = 'batchDetail';

                    let batch = store.batches.find(b => String(b.batchId) === String(batchId) || String(b.batchNumber) === String(batchId));
                    if (batch) {
                        store.viewBatchDetail(batch);
                    } else {
                        store.activeBatch = null;
                        if (store._reloadPromise) {
                            await store._reloadPromise;
                        } else if (store.batches.length === 0) {
                            await store.reloadBatches();
                        }

                        // Stale route check: if user navigated away while we were awaiting, abort
                        if (currentSeq !== this._routeSeq) return;

                        const found = store.batches.find(b => String(b.batchId) === String(batchId) || String(b.batchNumber) === String(batchId));
                        if (found) {
                            store.viewBatchDetail(found);
                        } else {
                            // Batch not found in project (e.g. invalid batch ID), redirect to batches explorer
                            this.setRoute(`/projects/${projectId}`);
                        }
                    }
                } else {
                    store.activeBatch = null;
                    this.currentScreen = 'batches';
                }
                return;
            }

            // Fallback to projects screen
            this.currentScreen = 'projects';
            const store = /** @type {import('./batches.js').BatchManager} */ (Alpine.store('batches'));
            store.activeProject = null;
            store.activeBatch = null;
        },

        /**
         * Navigates to target route hash
         * @param {string} route
         */
        setRoute(route) {
            const normalized = route.startsWith('/') ? route : '/' + route;
            const targetHash = '#' + normalized;
            if (window.location.hash === targetHash) {
                this.handleRoute();
            } else {
                window.location.hash = targetHash;
            }
        },

        navigateToProjects() {
            this.setRoute('/projects');
        },

        navigateToAbout() {
            this.setRoute('/about');
        },

        /**
         * Helper when a user clicks a project in the UI
         * @param {string} projectId
         */
        selectProject(projectId) {
            this.setRoute(`/projects/${projectId}`);
        },

        /**
         * Views batch detail and updates route
         * @param {Batch} batch
         */
        viewBatch(batch) {
            const store = /** @type {import('./batches.js').BatchManager} */ (Alpine.store('batches'));
            const projId = store.activeProject?.projectId || (this.projects.length > 0 ? this.projects[0].projectId : null);
            if (projId && batch?.batchId) {
                this.setRoute(`/projects/${projId}/batches/${batch.batchId}`);
            } else if (batch) {
                store.viewBatchDetail(batch);
                this.currentScreen = 'batchDetail';
            }
        },

        /**
         * Views batch detail, opens a specific cluster, and scrolls directly to it
         * @param {Batch} batch
         * @param {Cluster} [cluster]
         */
        viewCluster(batch, cluster) {
            this.viewBatch(batch);
            if (cluster) {
                cluster.collapsed = false;
                setTimeout(() => {
                    const el = document.getElementById(`cluster-${cluster.clusterIndex}`);
                    if (el) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                }, 80);
            }
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