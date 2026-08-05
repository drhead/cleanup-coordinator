// @ts-check

import Alpine from 'alpinejs';
import { decode } from '@msgpack/msgpack';
import { getBlacklistEvaluator, applyBlacklistToCluster } from './blacklist.js';
import { showToast } from './toasts.js';

/**
 * @typedef {Object} Lease
 * @property {number|string} batch_id
 * @property {number} batch_number
 * @property {number|string} project_id
 * @property {string} leased_until
 */

/**
 * Pure formatting function for ISO lease expiration string -> "MM:SS"
 * @param {number} nowTimestamp
 * @param {string|null|undefined} isoDateStr
 * @returns {string}
 */
export function getRemainingTimeString(nowTimestamp, isoDateStr) {
    if (!isoDateStr) return '';
    const expiry = new Date(isoDateStr).getTime();
    const diff = Math.max(0, Math.floor((expiry - nowTimestamp) / 1000));

    if (diff <= 0) return '';

    const minutes = Math.floor(diff / 60);
    const seconds = diff % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Prepares cluster posts for blacklisting, sorting, and state flags.
 * @param {any} c
 * @param {boolean} [forceReset=false]
 */
export function processCluster(c, forceReset = false) {
    applyBlacklistToCluster(c, getBlacklistEvaluator());

    if (forceReset || c.collapsed === undefined) {
        c.collapsed = c.is_resolved || c.is_blacklisted;
    }
}

/**
 * Pure display helper for batch status labels.
 * @param {any} batch
 * @returns {string}
 */
export function getBatchStatusLabel(batch) {
    if (!batch) return 'AVAILABLE';
    if (batch.status === 'CLAIMED') {
        return batch.is_leased_by_you ? 'CLAIMED BY YOU' : 'CLAIMED';
    }
    return batch.status;
}

/**
 * Pure display helper for batch status Tailwind CSS classes.
 * @param {any} batch
 * @returns {string}
 */
export function getBatchStatusClass(batch) {
    if (!batch) return 'bg-blue-950 text-blue-400 border border-blue-800/50';
    const st = batch.status || 'AVAILABLE';
    switch (st) {
        case 'COMPLETE':
            return 'bg-green-950 text-green-400 border border-green-800/50';
        case 'CLAIMED':
            return 'bg-amber-950 text-amber-400 border border-amber-800/50';
        case 'AVAILABLE':
        default:
            return 'bg-blue-950 text-blue-400 border border-blue-800/50';
    }
}

/**
 * Calculates completion percentage.
 * @param {number} resolved
 * @param {number} total
 * @returns {number}
 */
export function getProgressPercent(resolved, total) {
    if (!total || total <= 0) return 0;
    return Math.min(100, Math.round((resolved / total) * 100));
}

/**
 * Safely reads resolved cluster count from a project.
 * @param {any} project
 * @returns {number}
 */
export function getProjectResolvedCount(project) {
    return project?.resolved_clusters || 0;
}

/**
 * Safely reads total cluster count from a project.
 * @param {any} project
 * @returns {number}
 */
export function getProjectTotalCount(project) {
    return project?.total_clusters || 0;
}

export class BatchManager {
    constructor() {
        /** @type {any} */
        this.activeProject = null;
        /** @type {any[]} */
        this.batches = [];
        /** @type {any} */
        this.activeBatch = null;
        /** @type {Lease|null} */
        this.activeLease = null;
        /** @type {number} */
        this.nowTimestamp = Date.now();
        /** @type {any} */
        this.pollInterval = null;
        /** @type {any} */
        this.timerInterval = null;
    }

    /**
     * Self-initializes internal tickers for lease expirations and background polling.
     */
    init() {
        this.startTimer();
        this.startBackgroundPolling();
    }

    /**
     * Internal 1-second ticker that keeps nowTimestamp fresh and checks local expirations.
     */
    startTimer() {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.timerInterval = setInterval(() => {
            this.nowTimestamp = Date.now();
            this.checkLocalLeaseExpiration();
        }, 1000);
    }

    /**
     * Checks for expired local leases or batch lease states and refreshes batches if needed.
     */
    checkLocalLeaseExpiration() {
        let needsReload = false;

        if (this.activeLease && this.activeLease.leased_until) {
            const expiry = new Date(this.activeLease.leased_until).getTime();
            if (expiry <= this.nowTimestamp) {
                this.activeLease = null;
                needsReload = true;
            }
        }

        for (const batch of this.batches) {
            if (batch.status === 'CLAIMED' && batch.leased_until) {
                const expiry = new Date(batch.leased_until).getTime();
                if (expiry <= this.nowTimestamp) {
                    batch.status = 'AVAILABLE';
                    batch.is_leased_by_you = false;
                    batch.leased_until = null;
                    needsReload = true;
                }
            }
        }

        if (needsReload) {
            this.reloadBatches(true);
        }
    }

    /**
     * Formats an ISO expiration date string using the store's reactive timestamp.
     * @param {string|null|undefined} isoDateStr
     * @returns {string}
     */
    getRemainingTime(isoDateStr) {
        return getRemainingTimeString(this.nowTimestamp, isoDateStr);
    }

    /**
     * Selects an active project and reloads its associated batches.
     * @param {any[]} projects
     * @param {number|string} projectId
     */
    selectProject(projects, projectId) {
        this.activeProject = (projects || []).find(p => p.project_id === projectId) || null;
        return this.reloadBatches();
    }

    /**
     * Fetches batches and active leases, updating state and reconciling cluster data in-place.
     * @param {boolean} [silent=false]
     * @param {number|string|null} [refreshedClusterId=null]
     * @param {boolean} [forceCollapseReset=false]
     */
    async reloadBatches(silent = false, refreshedClusterId = null, forceCollapseReset = false) {
        if (!this.activeProject) return;

        try {
            const [batchesRes, leasesRes] = await Promise.all([
                fetch(`/api/v1/projects/${this.activeProject.project_id}/batches`, {
                    headers: { 'Accept': 'application/msgpack' }
                }),
                fetch('/api/v1/leases')
            ]);

            if (!batchesRes.ok) return;

            const batchesBuffer = await batchesRes.arrayBuffer();
            /** @type {any} */
            const batchesData = decode(batchesBuffer);

            const activeLeases = leasesRes.ok ? (await leasesRes.json()).leases || [] : [];
            const incomingBatches = batchesData.batches || [];

            if (this.batches.length === 0) {
                incomingBatches.forEach((/** @type {any} */ b) => {
                    if (b.clusters) {
                        b.clusters.forEach((/** @type {any} */ c) => {
                            processCluster(c);
                            c.isRefreshing = false;
                        });
                    } else {
                        b.clusters = [];
                    }
                });
                this.batches = incomingBatches;
            } else {
                for (const newBatch of incomingBatches) {
                    let existingBatch = this.batches.find(b => b.batch_id === newBatch.batch_id);
                    if (!existingBatch) {
                        if (newBatch.clusters) {
                            newBatch.clusters.forEach((/** @type {any} */ c) => {
                                processCluster(c);
                                c.isRefreshing = false;
                            });
                        } else {
                            newBatch.clusters = [];
                        }
                        this.batches.push(newBatch);
                        continue;
                    }

                    existingBatch.status = newBatch.status;
                    existingBatch.is_leased_by_you = newBatch.is_leased_by_you;
                    existingBatch.resolved_count = newBatch.resolved_count;
                    existingBatch.total_clusters = newBatch.total_clusters;
                    existingBatch.leased_until = newBatch.leased_until;

                    if (!existingBatch.clusters) {
                        existingBatch.clusters = [];
                    }

                    const isCurrentlyInspecting = this.activeBatch && (this.activeBatch.batch_id === newBatch.batch_id);

                    if (isCurrentlyInspecting && newBatch.clusters) {
                        for (let i = 0; i < newBatch.clusters.length; i++) {
                            const newCluster = newBatch.clusters[i];
                            let existingCluster = existingBatch.clusters.find((/** @type {any} */ c) => c.cluster_id === newCluster.cluster_id);

                            if (existingCluster) {
                                existingCluster.note = newCluster.note;
                                existingCluster.is_resolved = newCluster.is_resolved;
                                existingCluster.manual_resolution = newCluster.manual_resolution;

                                // Reconcile posts in-place to retain object identity & tag cache where possible
                                if (refreshedClusterId === existingCluster.cluster_id) {
                                    existingCluster.posts = newCluster.posts || [];
                                } else if (newCluster.posts && Array.isArray(newCluster.posts)) {
                                    const existingPostsMap = new Map((existingCluster.posts || []).map((/** @type {any} */ p) => [p.post_id, p]));

                                    existingCluster.posts = newCluster.posts.map((/** @type {any} */ newPost) => {
                                        const existingPost = existingPostsMap.get(newPost.post_id);

                                        if (existingPost) {
                                            // Check if raw tags modified during polling
                                            const tagsChanged = JSON.stringify(existingPost.tags) !== JSON.stringify(newPost.tags);

                                            Object.assign(existingPost, newPost);

                                            // Invalidate TagManager cache if tags actually changed
                                            if (tagsChanged) {
                                                delete existingPost._tagsSignature;
                                                delete existingPost._sortedTags;
                                            }
                                            return existingPost;
                                        }
                                        return newPost;
                                    });
                                }

                                processCluster(existingCluster, forceCollapseReset);

                                if (refreshedClusterId && existingCluster.cluster_id === refreshedClusterId) {
                                    existingCluster.isRefreshing = false;
                                }
                            } else {
                                processCluster(newCluster);
                                newCluster.isRefreshing = false;
                                existingBatch.clusters.push(newCluster);
                            }
                        }
                    }
                }
            }

            if (this.activeBatch) {
                const found = this.batches.find(b => b.batch_id === this.activeBatch?.batch_id);
                if (found) this.activeBatch = found;
            }

            const myLease = activeLeases.find((/** @type {any} */ l) => l.project_id === this.activeProject?.project_id && l.is_leased_by_you);
            if (myLease) {
                const expiry = new Date(myLease.leased_until).getTime();
                this.activeLease = expiry > this.nowTimestamp ? {
                    batch_id: myLease.batch_id,
                    batch_number: myLease.batch_number,
                    project_id: myLease.project_id,
                    leased_until: myLease.leased_until
                } : null;
            } else {
                this.activeLease = null;
            }
        } catch (err) {
            if (silent) console.debug("[Polling] Sync failed:", err);
            else console.error("[Reload] Error loading batches:", err);
        }
    }

    /**
     * Periodically polls for batch updates when document is active.
     */
    startBackgroundPolling() {
        if (this.pollInterval) clearInterval(this.pollInterval);

        this.pollInterval = setInterval(() => {
            if (!document.hidden && this.activeProject) {
                this.reloadBatches(true);
            }
        }, 15000);
    }

    /**
     * Sets active batch for detail viewing.
     * @param {any} batch
     */
    viewBatchDetail(batch) {
        this.activeBatch = batch;
    }

    /**
     * Navigates directly to a leased batch, fetching batches if not already in state.
     * @param {Lease} lease
     */
    async jumpToLeasedBatch(lease) {
        const batch = this.batches.find(b => b.batch_id === lease.batch_id);
        if (batch) {
            this.viewBatchDetail(batch);
        } else {
            try {
                const res = await fetch(`/api/v1/projects/${lease.project_id}/batches`, {
                    headers: { 'Accept': 'application/msgpack' }
                });
                if (!res.ok) return;
                const buf = await res.arrayBuffer();
                /** @type {any} */
                const data = decode(buf);
                this.batches = data.batches || [];
                const found = this.batches.find(b => b.batch_id === lease.batch_id);
                if (found) this.viewBatchDetail(found);
            } catch (err) {
                console.error("[Batches] Error jumping to leased batch:", err);
            }
        }
    }

    /**
     * Checks whether the active batch can be claimed by the user.
     * @returns {boolean}
     */
    canClaimActiveBatch() {
        if (!this.activeBatch) return false;
        if (this.activeBatch.status !== 'AVAILABLE') return false;
        if (this.activeLease) return false;
        return true;
    }

    /**
     * Claims the current active batch for the user.
     */
    async claimCurrentBatch() {
        if (!this.activeBatch || !this.activeProject) return;

        try {
            const res = await fetch(`/api/v1/batches/${this.activeBatch.batch_id}/claim`, { method: 'POST' });
            const data = await res.json();

            if (!res.ok) {
                showToast(data.detail || 'Failed to claim batch.', 'error');
                return;
            }

            this.activeLease = {
                batch_id: data.batch_id,
                batch_number: this.activeBatch.batch_number,
                project_id: this.activeProject.project_id,
                leased_until: data.leased_until
            };

            await this.reloadBatches();
            showToast(`Claimed Batch #${this.activeBatch.batch_number}`, 'success');
        } catch (err) {
            console.error('[Leases] Error claiming batch:', err);
            showToast('Network error while claiming batch.', 'error');
        }
    }

    /**
     * Revokes an existing batch lease.
     * @param {number|string} batchId
     */
    async revokeLease(batchId) {
        try {
            const res = await fetch(`/api/v1/batches/${batchId}/revoke`, { method: 'POST' });
            const data = await res.json();

            if (!res.ok) {
                showToast(data.detail || 'Failed to revoke lease.', 'error');
                return;
            }

            this.activeLease = null;
            await this.reloadBatches();
            showToast('Lease revoked.', 'info');
        } catch (err) {
            console.error('[Leases] Error revoking lease:', err);
            showToast('Network error while revoking lease.', 'error');
        }
    }

    /**
     * Triggers a batch refresh request on the backend.
     * @param {any} batch
     */
    async refreshBatch(batch) {
        if (!batch || batch.isRefreshing) return;

        batch.isRefreshing = true;

        try {
            const res = await fetch(`/api/v1/batches/${batch.batch_id}/refresh`, { method: 'POST' });
            const data = await res.json();

            if (!res.ok) {
                showToast(data.detail || 'Failed to refresh batch.', 'warning');
                return;
            }

            await this.reloadBatches(true);
            showToast(`Refreshed Batch #${batch.batch_number}`, 'success', 2500);
        } catch (err) {
            console.error("[BatchRefresh] Error refreshing batch:", err);
            showToast('Network error while refreshing batch.', 'error');
        } finally {
            batch.isRefreshing = false;
        }
    }
}

// Singleton instance
export const batchManager = new BatchManager();