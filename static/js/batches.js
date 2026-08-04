// @ts-check

import { decode } from '@msgpack/msgpack';
import { E621BlacklistEvaluator, applyBlacklistToCluster } from './blacklist.js';
import { showToast } from './toasts.js';

/**
 * Initial reactive state for batch management
 */
export const initialBatchState = {
    activeProject: null,
    batches: [],
    activeBatch: null,
    activeLease: null,
    pollInterval: null
};

/**
 * Prepares cluster posts for blacklisting, sorting, and state flags.
 * @param {Cluster} c
 * @param {E621BlacklistEvaluator} evaluator
 * @param {boolean} [forceReset=false]
 */
export function processCluster(c, evaluator, forceReset = false) {
    applyBlacklistToCluster(c, evaluator);

    if (forceReset || c.collapsed === undefined) {
        c.collapsed = c.is_resolved || c.is_blacklisted;
    }
}

/**
 * Selects an active project and reloads its associated batches.
 * @param {AppState} state
 * @param {number|string} projectId
 */
export function selectProject(state, projectId) {
    state.activeProject = (state.projects || []).find(p => p.project_id === projectId) || null;
    reloadBatches(state);
}

/**
 * Fetches batches and active leases, updating state and reconciling cluster data in-place.
 * @param {AppState} state
 * @param {boolean} [silent=false]
 * @param {number|string|null} [refreshedClusterId=null]
 * @param {boolean} [forceCollapseReset=false]
 */
export async function reloadBatches(state, silent = false, refreshedClusterId = null, forceCollapseReset = false) {
    if (!state.activeProject) return;

    try {
        const [batchesRes, leasesRes] = await Promise.all([
            fetch(`/api/v1/projects/${state.activeProject.project_id}/batches`, {
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

        const evaluator = new E621BlacklistEvaluator(state.blacklistText || '');

        if (state.batches.length === 0) {
            incomingBatches.forEach((/** @type {Batch} */ b) => {
                if (b.clusters) {
                    b.clusters.forEach(c => {
                        processCluster(c, evaluator);
                        c.isRefreshing = false;
                    });
                } else {
                    b.clusters = [];
                }
            });
            state.batches = incomingBatches;
        } else {
            for (const newBatch of incomingBatches) {
                let existingBatch = state.batches.find(b => b.batch_id === newBatch.batch_id);
                if (!existingBatch) {
                    if (newBatch.clusters) {
                        newBatch.clusters.forEach((/** @type {Cluster} */ c) => {
                            processCluster(c, evaluator);
                            c.isRefreshing = false;
                        });
                    } else {
                        newBatch.clusters = [];
                    }
                    state.batches.push(newBatch);
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

                const isCurrentlyInspecting = state.activeBatch && (state.activeBatch.batch_id === newBatch.batch_id);

                if (isCurrentlyInspecting && newBatch.clusters) {
                    for (let i = 0; i < newBatch.clusters.length; i++) {
                        const newCluster = newBatch.clusters[i];
                        let existingCluster = existingBatch.clusters.find(c => c.cluster_id === newCluster.cluster_id);

                        if (existingCluster) {
                            existingCluster.note = newCluster.note;
                            existingCluster.is_resolved = newCluster.is_resolved;
                            existingCluster.manual_resolution = newCluster.manual_resolution;

                            // Reconcile posts in-place to retain object identity & tag cache where possible
                            if (refreshedClusterId === existingCluster.cluster_id) {
                                existingCluster.posts = newCluster.posts || [];
                            } else if (newCluster.posts && Array.isArray(newCluster.posts)) {
                                const existingPostsMap = new Map((existingCluster.posts || []).map(p => [p.post_id, p]));

                                existingCluster.posts = newCluster.posts.map((/** @type {ClusterPost} */ newPost) => {
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

                            processCluster(existingCluster, evaluator, forceCollapseReset);

                            if (refreshedClusterId && existingCluster.cluster_id === refreshedClusterId) {
                                existingCluster.isRefreshing = false;
                            }
                        } else {
                            processCluster(newCluster, evaluator);
                            newCluster.isRefreshing = false;
                            existingBatch.clusters.push(newCluster);
                        }
                    }
                }
            }
        }

        if (state.activeBatch) {
            const found = state.batches.find(b => b.batch_id === state.activeBatch?.batch_id);
            if (found) state.activeBatch = found;
        }

        const myLease = activeLeases.find((/** @type {any} */ l) => l.project_id === state.activeProject?.project_id && l.is_leased_by_you);
        if (myLease) {
            const expiry = new Date(myLease.leased_until).getTime();
            state.activeLease = expiry > (state.nowTimestamp || Date.now()) ? {
                batch_id: myLease.batch_id,
                batch_number: myLease.batch_number,
                project_id: myLease.project_id,
                leased_until: myLease.leased_until
            } : null;
        } else {
            state.activeLease = null;
        }

        if (!silent && state.currentScreen === 'projects') {
            state.currentScreen = 'batches';
        }
    } catch (err) {
        if (silent) console.debug("[Polling] Sync failed:", err);
        else console.error("[Reload] Error loading batches:", err);
    }
}

/**
 * Periodically polls for batch updates when document is active.
 * @param {AppState} state
 */
export function startBackgroundPolling(state) {
    if (state.pollInterval) clearInterval(state.pollInterval);

    state.pollInterval = setInterval(() => {
        if (!document.hidden && state.activeProject) {
            reloadBatches(state, true);
        }
    }, 15000);
}

/**
 * Sets active batch and switches view to batch detail screen.
 * @param {AppState} state
 * @param {Batch} batch
 */
export function viewBatchDetail(state, batch) {
    state.activeBatch = batch;
    state.currentScreen = 'batch_detail';
}

/**
 * Navigates directly to a leased batch, fetching batches if not already in state.
 * @param {AppState} state
 * @param {Lease} lease
 */
export async function jumpToLeasedBatch(state, lease) {
    const batch = state.batches.find(b => b.batch_id === lease.batch_id);
    if (batch) {
        viewBatchDetail(state, batch);
    } else {
        try {
            const res = await fetch(`/api/v1/projects/${lease.project_id}/batches`, {
                headers: { 'Accept': 'application/msgpack' }
            });
            if (!res.ok) return;
            const buf = await res.arrayBuffer();
            /** @type {any} */
            const data = decode(buf);
            state.batches = data.batches || [];
            const found = state.batches.find(b => b.batch_id === lease.batch_id);
            if (found) viewBatchDetail(state, found);
        } catch (err) {
            console.error("[Batches] Error jumping to leased batch:", err);
        }
    }
}

/**
 * Pure display helper for batch status labels.
 * @param {Batch|null} batch
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
 * @param {Batch|null} batch
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
 * Triggers a batch refresh request on the backend.
 * @param {AppState} state
 * @param {Batch} batch
 */
export async function refreshBatch(state, batch) {
    if (!batch || batch.isRefreshing) return;

    batch.isRefreshing = true;

    try {
        const res = await fetch(`/api/v1/batches/${batch.batch_id}/refresh`, { method: 'POST' });
        const data = await res.json();

        if (!res.ok) {
            showToast(state, data.detail || 'Failed to refresh batch.', 'warning');
            return;
        }

        await reloadBatches(state, true);
        showToast(state, `Refreshed Batch #${batch.batch_number}`, 'success', 2500);
    } catch (err) {
        console.error("[BatchRefresh] Error refreshing batch:", err);
        showToast(state, 'Network error while refreshing batch.', 'error');
    } finally {
        batch.isRefreshing = false;
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
 * @param {Project|null} project
 * @returns {number}
 */
export function getProjectResolvedCount(project) {
    return project?.resolved_clusters || 0;
}

/**
 * Safely reads total cluster count from a project.
 * @param {Project|null} project
 * @returns {number}
 */
export function getProjectTotalCount(project) {
    return project?.total_clusters || 0;
}