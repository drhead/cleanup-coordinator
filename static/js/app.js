// @ts-check

import Alpine from 'alpinejs';

import { initialAuthState, login, logout } from './auth.js';
import { 
    initialTagState, 
    initTags, 
    getSortedTags, 
    isImpliedTag, 
    getImplicationChain, 
    getTagStyle, 
    getRatingLabel, 
    getRatingBadgeClass, 
    copyMergedTags, 
    getMergedTagDelta, 
    getMergedHoverData 
} from './tags.js';

import { initialBlacklistState, saveBlacklist, importBlacklist } from './blacklist.js';
import { initialBatchState, selectProject, startBackgroundPolling, viewBatchDetail, jumpToLeasedBatch, getBatchStatusLabel, getBatchStatusClass, refreshBatch, getProgressPercent, getProjectResolvedCount, getProjectTotalCount } from './batches.js';
import { checkLocalLeaseExpiration, canClaimActiveBatch, claimCurrentBatch, revokeLease, getRemainingTimeString } from './leases.js';

import { ComparisonManager } from './comparison.js';
import { ReconciliationManager } from './reconciliation.js';

/**
 * @typedef {Object} HoveredMergedData
 * @property {string|null} clusterId
 * @property {string|null} targetPostId
 * @property {string[]} tags
 */

document.addEventListener('alpine:init', () => {
    Alpine.data('app', () => ({
        currentScreen: 'projects',
        projects: [],
        nowTimestamp: Date.now(),
        toasts: [],
        showInstructionsModal: false,
        hoveredMergedData: { clusterId: null, targetPostId: null, tags: [] },
        isAgeVerified: !!localStorage.getItem('e621_age_verified'),

        ...initialAuthState,
        ...initialTagState,
        ...initialBlacklistState,
        ...initialBatchState,

        // auth.js
        login() { login(this); },
        logout() { logout(this); },

        // tags.js
        getSortedTags(flatTags, post = null) { return getSortedTags(this, flatTags, post); }, // this is used
        isImpliedTag(tagName, flatTags) { return isImpliedTag(this, tagName, flatTags); }, // this is used
        getImplicationChain(postId, tagName, flatTags) { return getImplicationChain(this, postId, tagName, flatTags); }, // this is used
        getTagStyle,
        getRatingLabel,
        getRatingBadgeClass,
        copyMergedTags(targetPost, clusterPosts) { return copyMergedTags(this, targetPost, clusterPosts); },
        getMergedTagDelta(currentPost, clusterPosts) { return getMergedTagDelta(this, currentPost, clusterPosts); },
        getMergedHoverData(targetPost, clusterPosts) { return getMergedHoverData(this, targetPost, clusterPosts); },

        // Blacklist Wrappers
        saveBlacklist(silent = false) { return saveBlacklist(this, silent); },
        importBlacklist() { return importBlacklist(this); },

        // Batch Wrappers
        selectProject(projectId) { selectProject(this, projectId); },
        viewBatchDetail(batch) { viewBatchDetail(this, batch); },
        jumpToLeasedBatch(lease) { jumpToLeasedBatch(this, lease); },
        getBatchStatusLabel,
        getBatchStatusClass,
        refreshBatch(batch) { return refreshBatch(this, batch); },
        getProgressPercent,
        getProjectResolvedCount,
        getProjectTotalCount,

        // Lease Wrappers
        checkLocalLeaseExpiration() { checkLocalLeaseExpiration(this); },
        canClaimActiveBatch() { return canClaimActiveBatch(this); },
        claimCurrentBatch() { return claimCurrentBatch(this); },
        revokeLease(batchId) { return revokeLease(this, batchId); },
        getRemainingTimeString(isoDateStr) { return getRemainingTimeString(this.nowTimestamp, isoDateStr); },

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
                .then(/** @param {{ projects?: Project[] }} data */ data => {
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

            initTags(this);

            startBackgroundPolling(this);
        }
    }));
});

// Register Alpine components explicitly if not relying solely on alpine:init
Alpine.data('ComparisonManager', ComparisonManager);
Alpine.data('ReconciliationManager', ReconciliationManager);

// Also attach to window if expressions are evaluated directly in x-data strings
window.ComparisonManager = ComparisonManager;
window.ReconciliationManager = ReconciliationManager;

Alpine.start();