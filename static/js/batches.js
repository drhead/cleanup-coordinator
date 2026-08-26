// @ts-check

import { decode } from '@msgpack/msgpack';
import { getBlacklistEvaluator, applyBlacklistToCluster } from './blacklist.js';
import { showToast } from './toasts.js';

/**
 * Pure formatting function for ISO lease expiration string -> "MM:SS"
 * @param {number|string} nowTimestamp
 * @param {string|null|undefined} [isoDateStr]
 * @returns {string}
 */
export function getRemainingTimeString(nowTimestamp, isoDateStr) {
    let now = typeof nowTimestamp === 'number' ? nowTimestamp : Date.now();
    let iso = typeof nowTimestamp === 'string' && !isoDateStr ? nowTimestamp : isoDateStr;
    if (!iso) return '';

    const expiry = new Date(iso).getTime();
    const diff = Math.max(0, Math.floor((expiry - now) / 1000));

    if (diff <= 0) return '';

    const minutes = Math.floor(diff / 60);
    const seconds = diff % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Calculates connected subgraphs and duplicate clusters for visual topology rendering.
 * @param {Cluster} c
 * @returns {ClusterTopology}
 */
export function computeClusterTopology(c) {
    const posts = c.posts || [];
    if (posts.length === 0) {
        return {
            variantSubgraphs: [],
            duplicateSubgraphs: [],
            standalonePosts: [],
            totalPosts: 0,
            isBlacklisted: Boolean(c.isBlacklisted),
            isResolved: Boolean(c.isResolved)
        };
    }

    const postMap = new Map();
    const clusterPostIds = new Set();
    for (const p of posts) {
        postMap.set(p.postId, p);
        clusterPostIds.add(p.postId);
    }

    /**
     * @param {ClusterPost} p
     * @param {boolean} isDuplicate
     * @returns {TopologyPost}
     */
    const toTopologyPost = (p, isDuplicate) => ({
        postId: p.postId,
        isDuplicate: Boolean(isDuplicate),
        isFlagged: Boolean(p.isFlagged),
        isDeleted: Boolean(p.isDeleted),
        parentId: p.parentId ?? null,
        poolIds: Array.isArray(p.poolIds) ? p.poolIds : [],
        rating: p.rating || 's'
    });

    // 1. Identify Duplicate Subgraphs (>= 2 items)
    const duplicatesByParent = new Map();
    const duplicatePostIds = new Set();

    for (const p of posts) {
        if ((p.isFlagged || p.isDeleted) && p.parentId != null) {
            const parentId = Number(p.parentId);
            if (clusterPostIds.has(parentId)) {
                if (!duplicatesByParent.has(parentId)) {
                    duplicatesByParent.set(parentId, []);
                }
                duplicatesByParent.get(parentId).push(p);
                duplicatePostIds.add(p.postId);
            }
        }
    }

    /** @type {Map<number, DuplicateSubgraph>} */
    const duplicateSubgraphByParent = new Map();
    for (const [parentId, dupList] of duplicatesByParent.entries()) {
        const parentPost = postMap.get(parentId);
        if (parentPost) {
            duplicateSubgraphByParent.set(parentId, {
                canonicalPostId: parentId,
                posts: [
                    toTopologyPost(parentPost, false),
                    ...dupList.map(dp => toTopologyPost(dp, true))
                ]
            });
        }
    }

    // 2. Disjoint Set / Union-Find for Variant Connected Components
    const parent = new Map();
    for (const p of posts) parent.set(p.postId, p.postId);

    function find(i) {
        let root = i;
        while (root !== parent.get(root)) root = parent.get(root);
        let curr = i;
        while (curr !== root) {
            let next = parent.get(curr);
            parent.set(curr, root);
            curr = next;
        }
        return root;
    }

    function union(i, j) {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) parent.set(rootI, rootJ);
    }

    // Union on parenting
    const sharedParentMap = new Map();
    for (const p of posts) {
        if (p.parentId != null) {
            const pid = Number(p.parentId);
            if (clusterPostIds.has(pid)) {
                union(p.postId, pid);
            }
            let list = sharedParentMap.get(pid);
            if (!list) {
                list = [];
                sharedParentMap.set(pid, list);
            }
            list.push(p.postId);
        }
    }
    for (const list of sharedParentMap.values()) {
        for (let i = 1; i < list.length; i++) {
            union(list[0], list[i]);
        }
    }

    // Union on pools
    const poolMap = new Map();
    for (const p of posts) {
        for (const poolId of (p.poolIds || [])) {
            const poolNum = Number(poolId);
            let list = poolMap.get(poolNum);
            if (!list) {
                list = [];
                poolMap.set(poolNum, list);
            }
            list.push(p.postId);
        }
    }
    for (const list of poolMap.values()) {
        for (let i = 1; i < list.length; i++) {
            union(list[0], list[i]);
        }
    }

    // Group posts into connected components
    const components = new Map();
    for (const p of posts) {
        const root = find(p.postId);
        let list = components.get(root);
        if (!list) {
            list = [];
            components.set(root, list);
        }
        list.push(p);
    }

    /** @type {VariantSubgraph[]} */
    const variantSubgraphs = [];
    /** @type {DuplicateSubgraph[]} */
    const duplicateSubgraphs = [];
    /** @type {TopologyPost[]} */
    const standalonePosts = [];

    const placedDuplicateParents = new Set();

    for (const compPosts of components.values()) {
        if (compPosts.length === 1) {
            const single = compPosts[0];
            if (!duplicatePostIds.has(single.postId) && !duplicateSubgraphByParent.has(single.postId)) {
                standalonePosts.push(toTopologyPost(single, false));
            }
        } else {
            // Component has >= 2 posts -> Variant or Duplicate
            const parentIdsInComp = compPosts.map(p => p.postId).filter(id => duplicateSubgraphByParent.has(id));
            const isPureDuplicatePair = (
                parentIdsInComp.length === 1 &&
                duplicateSubgraphByParent.get(parentIdsInComp[0])?.posts.length === compPosts.length
            );

            if (isPureDuplicatePair) {
                const pId = parentIdsInComp[0];
                const dupSubgraph = duplicateSubgraphByParent.get(pId);
                if (dupSubgraph) {
                    duplicateSubgraphs.push(dupSubgraph);
                    placedDuplicateParents.add(pId);
                }
            } else {
                /** @type {DuplicateSubgraph[]} */
                const nestedDupSubgraphs = [];
                /** @type {TopologyPost[]} */
                const directVariantPosts = [];

                const postsHandledInNestedDups = new Set();
                for (const p of compPosts) {
                    if (duplicateSubgraphByParent.has(p.postId)) {
                        const dupSub = duplicateSubgraphByParent.get(p.postId);
                        if (dupSub) {
                            nestedDupSubgraphs.push(dupSub);
                            placedDuplicateParents.add(p.postId);
                            for (const dp of dupSub.posts) {
                                postsHandledInNestedDups.add(dp.postId);
                            }
                        }
                    }
                }

                for (const p of compPosts) {
                    if (!postsHandledInNestedDups.has(p.postId)) {
                        directVariantPosts.push(toTopologyPost(p, false));
                    }
                }

                variantSubgraphs.push({
                    posts: directVariantPosts,
                    duplicateSubgraphs: nestedDupSubgraphs
                });
            }
        }
    }

    for (const [pId, dupSub] of duplicateSubgraphByParent.entries()) {
        if (!placedDuplicateParents.has(pId)) {
            duplicateSubgraphs.push(dupSub);
        }
    }

    return {
        variantSubgraphs,
        duplicateSubgraphs,
        standalonePosts,
        totalPosts: posts.length,
        isBlacklisted: Boolean(c.isBlacklisted),
        isResolved: Boolean(c.isResolved)
    };
}

/**
 * Evaluates whether a cluster is fully resolved based on flags, parenting, pools, and confirmed edits.
 * @param {Cluster} c
 * @returns {boolean}
 */
export function isClusterResolved(c) {
    if (!c) return false;
    if (c.manualResolution) return true;
    const posts = c.posts || [];
    if (posts.length <= 1) return true;

    const activePosts = posts.filter(p => !p.isDeleted && !p.isFlagged);
    if (activePosts.length <= 1) return true;

    // Helper: checks if two posts share a variant relationship (parent or pool)
    const areVariants = (pA, pB) => {
        if (pA.parentId != null && pB.parentId != null && pA.parentId === pB.parentId) return true;
        if (pA.parentId != null && pA.parentId === pB.postId) return true;
        if (pB.parentId != null && pB.parentId === pA.postId) return true;
        const poolsA = Array.isArray(pA.poolIds) ? pA.poolIds : [];
        const poolsB = Array.isArray(pB.poolIds) ? pB.poolIds : [];
        if (poolsA.length > 0 && poolsB.length > 0) {
            if (poolsA.some(id => poolsB.includes(id))) return true;
        }
        return false;
    };

    // Check if all active posts share a single common pool
    const firstPools = Array.isArray(activePosts[0].poolIds) ? activePosts[0].poolIds : [];
    if (firstPools.length > 0) {
        const commonPool = firstPools.find(poolId => activePosts.every(p => Array.isArray(p.poolIds) && p.poolIds.includes(poolId)));
        if (commonPool !== undefined) return true;
    }

    // Check if all active posts share a common parent or internal tree root
    const parentIds = new Set(activePosts.map(p => p.parentId).filter(id => id != null));
    if (parentIds.size === 1 && activePosts.every(p => p.parentId != null)) return true;

    for (const root of activePosts) {
        const others = activePosts.filter(p => p.postId !== root.postId);
        if (others.length > 0 && others.every(p => p.parentId === root.postId)) return true;
    }

    // Pairwise check: every pair must be either variants (by parent/pool) or confirmed unrelated (both edited)
    for (let i = 0; i < activePosts.length; i++) {
        for (let j = i + 1; j < activePosts.length; j++) {
            const pA = activePosts[i];
            const pB = activePosts[j];
            const isVar = areVariants(pA, pB);
            const bothEdited = Boolean(pA.isEdited && pB.isEdited);
            // If they are not variants and not both confirmed edited, the pair is unresolved
            if (!isVar && !bothEdited) {
                return false;
            }
        }
    }

    return true;
}

/**
 * Prepares cluster posts for blacklisting, sorting, and state flags.
 * @param {Cluster} c
 * @param {boolean} [forceReset=false]
 */
export function processCluster(c, forceReset = false) {
    c.isResolved = isClusterResolved(c);
    applyBlacklistToCluster(c, getBlacklistEvaluator());
    c.topology = computeClusterTopology(c);

    if (forceReset || c.collapsed === undefined) {
        c.collapsed = c.isResolved || c.isBlacklisted;
    }
}

/**
 * Pure display helper for batch status labels.
 * @param {Batch} batch
 * @returns {string}
 */
export function getBatchStatusLabel(batch) {
    if (!batch) return 'AVAILABLE';
    if (batch.status === 'CLAIMED') {
        return batch.isLeasedByYou ? 'CLAIMED BY YOU' : 'CLAIMED';
    }
    return batch.status;
}

/**
 * Pure display helper for batch status Tailwind CSS classes.
 * @param {Batch} batch
 * @returns {string}
 */
export function getBatchStatusClass(batch) {
    if (!batch) return 'bg-blue-950 text-blue-400 border border-blue-800/50';
    const st = batch.status || 'AVAILABLE';
    switch (st) {
        case 'COMPLETE':
            return 'bg-emerald-950 text-emerald-400 border border-emerald-800/50';
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
 * @param {Project} project
 * @returns {number}
 */
export function getProjectResolvedCount(project) {
    return project?.resolvedClusters || 0;
}

/**
 * Safely reads total cluster count from a project.
 * @param {Project} project
 * @returns {number}
 */
export function getProjectTotalCount(project) {
    return project?.totalClusters || 0;
}

/**
 * Fetches batches for a project, processes cluster resolutions, and returns resolution summary counts.
 * @param {string} projectId
 * @returns {Promise<{ batches: Batch[], resolvedClusters: number, totalClusters: number }>}
 */
export async function fetchAndHydrateProjectBatches(projectId) {
    try {
        const res = await fetch(`/api/v1/projects/${projectId}/batches`, {
            headers: { 'Accept': 'application/msgpack' }
        });
        if (!res.ok) return { batches: [], resolvedClusters: 0, totalClusters: 0 };
        const buf = await res.arrayBuffer();
        const data = /** @type {{ batches: Batch[] }} */ (decode(buf));
        const batches = data.batches || [];
        let resolvedClusters = 0;
        let totalClusters = 0;

        for (const b of batches) {
            b.projectId = projectId;
            if (Array.isArray(b.clusters)) {
                for (const c of b.clusters) {
                    processCluster(c);
                    c.isRefreshing = false;
                }
                b.resolvedCount = b.clusters.filter(c => c.isResolved).length;
                b.totalClusters = b.clusters.length;
                resolvedClusters += b.resolvedCount;
                totalClusters += b.totalClusters;
                if (b.resolvedCount === b.totalClusters && b.totalClusters > 0) {
                    b.status = 'COMPLETE';
                }
            }
        }

        return { batches, resolvedClusters, totalClusters };
    } catch (err) {
        console.error(`[Batches] Error hydrating batches for project ${projectId}:`, err);
        return { batches: [], resolvedClusters: 0, totalClusters: 0 };
    }
}

export class BatchManager {
    constructor() {
        /** @type {Project|null} */
        this.activeProject = null;
        /** @type {Batch[]} */
        this.batches = [];
        /** @type {Map<string, Batch[]>} */
        this.cachedProjectBatches = new Map();
        /** @type {Batch|null} */
        this.activeBatch = null;
        /** @type {Lease|null} */
        this.activeLease = null;
        /** @type {number} */
        this.nowTimestamp = Date.now();
        /** @type {ReturnType<typeof setInterval>|null} */
        this.pollInterval = null;
        /** @type {ReturnType<typeof setInterval>|null} */
        this.timerInterval = null;

        /** Centralized style classes for cluster topology rendering */
        this.styles = {
            // Layer 1: Cluster defines --edge-m: 8px (m-2) and --edge-b: 6px
            clusterPending: 'h-7 inline-flex items-center gap-0.5 rounded-md bg-gray-900/80 border border-gray-700/70 hover:border-gray-500 transition shrink-0 [--edge-m:9px] [--edge-b:6px]',
            clusterResolved: 'h-7 inline-flex items-center gap-0.5 rounded-md bg-emerald-950/80 border border-emerald-600/90 hover:border-emerald-600 transition shrink-0 [--edge-m:9px] [--edge-b:6px]',
            clusterBlacklisted: 'h-7 inline-flex items-center gap-0.5 rounded-md bg-gray-900/80 border border-gray-700/70 hover:border-gray-500 transition shrink-0 opacity-45 [--edge-m:9px] [--edge-b:6px]',

            // Layer 2: Variant overrides --edge-m: 6px and --edge-b: 4px
            variantGroup: 'h-5.5 inline-flex items-center gap-0.5 rounded-sm last-of-type:mr-0.5 first-of-type:ml-0.5 bg-none border border-purple-700/90 shrink-0 [--edge-m:6px] [--edge-b:4px]',

            // Layer 3: Duplicate overrides --edge-m: 2px
            duplicateGroup: 'h-4 inline-flex items-center gap-0.5 [&:nth-child(1_of_:not(template):not(.hidden))]:ml-[var(--edge-b)] [&:nth-last-child(1_of_:not(template):not(.hidden))]:mr-[var(--edge-b)] rounded-xs bg-none border border-amber-700/90 shrink-0 [--edge-m:2px]',

            // Post Dots: Distinct colors for Active, Flagged, and Deleted
            dotActive: 'w-2.5 h-2.5 m-0.5 rounded-full [&:nth-child(1_of_:not(template):not(.hidden))]:ml-[var(--edge-m)] [&:nth-last-child(1_of_:not(template):not(.hidden))]:mr-[var(--edge-m)] bg-blue-400 shrink-0',
            dotFlagged: 'w-2.5 h-2.5 m-0.5 rounded-full [&:nth-child(1_of_:not(template):not(.hidden))]:ml-[var(--edge-m)] [&:nth-last-child(1_of_:not(template):not(.hidden))]:mr-[var(--edge-m)] bg-amber-400 shrink-0',
            dotDeleted: 'w-2.5 h-2.5 m-0.5 rounded-full [&:nth-child(1_of_:not(template):not(.hidden))]:ml-[var(--edge-m)] [&:nth-last-child(1_of_:not(template):not(.hidden))]:mr-[var(--edge-m)] bg-rose-500 shrink-0',
        };

        this.filterStatus = 'ALL';
        this.searchQuery = '';
        this.currentPage = 1;
        this.pageSize = 50;
    }

    /**
     * Gets cluster container CSS class based on resolution and blacklist state.
     * @param {Cluster} cluster
     * @returns {string}
     */
    getClusterStyle(cluster) {
        let base = cluster.isResolved ? this.styles.clusterResolved : this.styles.clusterPending;
        if (cluster.isBlacklisted) {
            return `${base} opacity-45 saturate-[0.75]`;
        }
        return base;
    }

    /**
     * Gets post dot CSS class based on post flags and deletion state.
     * @param {TopologyPost|ClusterPost} post
     * @returns {string}
     */
    getPostDotStyle(post) {
        if (post.isDeleted) return this.styles.dotDeleted;
        if (post.isFlagged || ('isDuplicate' in post && post.isDuplicate)) return this.styles.dotFlagged;
        return this.styles.dotActive;
    }

    /**
     * Generates a descriptive tooltip for a cluster box.
     * @param {Cluster} cluster
     * @returns {string}
     */
    getClusterTooltip(cluster) {
        const status = cluster.isResolved ? 'Resolved' : cluster.isBlacklisted ? 'Blacklisted' : 'Pending';
        const postCount = cluster.posts?.length || 0;
        return `Cluster #${cluster.clusterIndex}: ${status} (${postCount} post${postCount === 1 ? '' : 's'})`;
    }

    /**
     * Generates a descriptive tooltip for a post dot.
     * @param {TopologyPost|ClusterPost} post
     * @returns {string}
     */
    getPostTooltip(post) {
        let status = 'Active';
        if (post.isDeleted) status = 'Deleted';
        else if (post.isFlagged) status = 'Flagged';
        else if ('isDuplicate' in post && post.isDuplicate) status = 'Duplicate';
        const parentLabel = post.parentId ? ` | Parent: #${post.parentId}` : '';
        const poolsLabel = (post.poolIds && post.poolIds.length > 0) ? ` | Pools: [${post.poolIds.join(', ')}]` : '';
        return `Post #${post.postId} (${status})${parentLabel}${poolsLabel}`;
    }

    /**
     * Calculates completion percentage.
     * @param {number} resolved
     * @param {number} total
     * @returns {number}
     */
    getProgressPercent(resolved, total) {
        return getProgressPercent(resolved, total);
    }

    /**
     * Gets total post count for a batch across all clusters.
     * @param {Batch} batch
     * @returns {number}
     */
    getBatchTotalPosts(batch) {
        if (!batch || !batch.clusters) return 0;
        return batch.clusters.reduce((acc, c) => acc + (c.posts?.length || 0), 0);
    }

    /**
     * Filtered list of batches according to status and search query.
     * @returns {Batch[]}
     */
    get filteredBatches() {
        let result = this.batches;

        if (this.activeProject) {
            result = result.filter(b => b.projectId === this.activeProject.projectId);
        }

        if (this.filterStatus !== 'ALL') {
            result = result.filter(b => b.status === this.filterStatus);
        }

        const query = (this.searchQuery || '').trim().toLowerCase();
        if (query) {
            const numQuery = parseInt(query.replace('#', ''), 10);
            if (!isNaN(numQuery)) {
                result = result.filter(b => b.batchNumber === numQuery || String(b.batchNumber).includes(query));
            } else {
                result = result.filter(b => String(b.batchNumber).includes(query));
            }
        }

        return result;
    }

    /**
     * Total number of pages for pagination.
     * @returns {number}
     */
    get totalPages() {
        return Math.max(1, Math.ceil(this.filteredBatches.length / this.pageSize));
    }

    /**
     * Paginated slice of filtered batches for current page.
     * @returns {Batch[]}
     */
    get paginatedBatches() {
        const start = (this.currentPage - 1) * this.pageSize;
        return this.filteredBatches.slice(start, start + this.pageSize);
    }

    /**
     * Sets the active status filter and resets page to 1.
     * @param {'ALL'|'AVAILABLE'|'CLAIMED'|'COMPLETE'} status
     */
    setFilter(status) {
        this.filterStatus = status;
        this.currentPage = 1;
    }

    /**
     * Sets search query and resets page to 1.
     * @param {string} query
     */
    setSearch(query) {
        this.searchQuery = query;
        this.currentPage = 1;
    }

    /**
     * Navigates to a specific page.
     * @param {number} page
     */
    setPage(page) {
        this.currentPage = Math.max(1, Math.min(this.totalPages, page));
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

        if (this.activeLease && this.activeLease.leasedUntil) {
            const expiry = new Date(this.activeLease.leasedUntil).getTime();
            if (expiry <= this.nowTimestamp) {
                this.activeLease = null;
                needsReload = true;
            }
        }

        for (const batch of this.batches) {
            if (batch.status === 'CLAIMED' && batch.leasedUntil) {
                const expiry = new Date(batch.leasedUntil).getTime();
                if (expiry <= this.nowTimestamp) {
                    batch.status = 'AVAILABLE';
                    batch.isLeasedByYou = false;
                    batch.leasedUntil = null;
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
     * @param {Project[]} projects
     * @param {string} projectId
     */
    selectProject(projects, projectId) {
        const nextProject = (projects || []).find(p => p.projectId === projectId) || null;
        if (this.activeProject?.projectId !== nextProject?.projectId) {
            this.batches = this.cachedProjectBatches?.get(projectId) || [];
        }
        this.activeBatch = null;
        this.activeProject = nextProject;
        this.filterStatus = 'ALL';
        this.searchQuery = '';
        this.currentPage = 1;
        return this.reloadBatches();
    }

    /**
     * Fetches batches and active leases, updating state and reconciling cluster data in-place.
     * @param {boolean} [silent=false]
     * @param {number|null} [refreshedClusterId=null]
     * @param {boolean} [forceCollapseReset=false]
     */
    async reloadBatches(silent = false, refreshedClusterId = null, forceCollapseReset = false) {
        if (!this.activeProject) return;

        if (this._reloadPromise) {
            return this._reloadPromise;
        }

        this._reloadPromise = (async () => {
            try {
                // 1. Fetch public batch data and dynamic leases in parallel
                const [batchesRes, leasesRes] = await Promise.all([
                    fetch(`/api/v1/projects/${this.activeProject.projectId}/batches`, {
                        headers: { 'Accept': 'application/msgpack' }
                    }),
                    fetch('/api/v1/leases')
                ]);

            if (!batchesRes.ok) return;

            const batchesBuffer = await batchesRes.arrayBuffer();
            const batchesData = /** @type {{ batches: Batch[] }} */ (decode(batchesBuffer));
            const activeLeases = leasesRes.ok ? /** @type {{ leases: Lease[] }} */ (await leasesRes.json()).leases || [] : [];
            const incomingBatches = batchesData.batches || [];
            const currentProjectId = this.activeProject.projectId;

            incomingBatches.forEach((b) => {
                b.projectId = currentProjectId;
            });

            // Purge any stale batches from other projects
            this.batches = this.batches.filter((b) => b.projectId === currentProjectId);

            // 2. Index active leases by batchId for O(1) lookups
            /** @type {Map<number, Lease>} */
            const activeLeasesMap = new Map();
            /** @type {Lease|null} */
            let myActiveLease = null;

            for (const lease of activeLeases) {
                const expiry = new Date(lease.leasedUntil).getTime();
                if (expiry <= this.nowTimestamp) continue; // Skip expired

                activeLeasesMap.set(lease.batchId, lease);

                // Track current user's active lease for top banner
                if (lease.projectId === this.activeProject.projectId && lease.isLeasedByYou) {
                    myActiveLease = {
                        batchId: lease.batchId,
                        batchNumber: lease.batchNumber,
                        projectId: lease.projectId,
                        leasedUntil: lease.leasedUntil,
                        isLeasedByYou: true
                    };
                }
            }
            this.activeLease = myActiveLease;

            /**
             * Syncs dynamic lease state from the activeLeasesMap onto a batch object.
             * @param {Batch} batch
             * @returns {void}
             */
            const syncBatchLeaseState = (batch) => {
                const lease = activeLeasesMap.get(batch.batchId);
                if (lease) {
                    batch.leasedUntil = lease.leasedUntil;
                    batch.isLeasedByYou = Boolean(lease.isLeasedByYou);
                    if (batch.status !== 'COMPLETE') {
                        batch.status = 'CLAIMED';
                    }
                } else if (this.activeLease && this.activeLease.batchId === batch.batchId && this.activeLease.isLeasedByYou) {
                    batch.leasedUntil = this.activeLease.leasedUntil;
                    batch.isLeasedByYou = true;
                    if (batch.status !== 'COMPLETE') {
                        batch.status = 'CLAIMED';
                    }
                } else {
                    batch.leasedUntil = null;
                    batch.isLeasedByYou = false;
                    if (batch.status === 'CLAIMED') {
                        batch.status = 'AVAILABLE';
                    }
                }
            };

            // 3. Reconcile incoming batches into state
            if (this.batches.length === 0) {
                incomingBatches.forEach((b) => {
                    syncBatchLeaseState(b);
                    if (b.clusters) {
                        b.clusters.forEach((c) => {
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
                    let existingBatch = this.batches.find(b => b.batchId === newBatch.batchId);

                    if (!existingBatch) {
                        syncBatchLeaseState(newBatch);
                        if (newBatch.clusters) {
                            newBatch.clusters.forEach((c) => {
                                processCluster(c);
                                c.isRefreshing = false;
                            });
                        } else {
                            newBatch.clusters = [];
                        }
                        this.batches.push(newBatch);
                        continue;
                    }

                    // Update core public fields from /batches
                    existingBatch.status = newBatch.status;
                    existingBatch.resolvedCount = newBatch.resolvedCount;
                    existingBatch.totalClusters = newBatch.totalClusters;

                    // Sync dynamic lease state from /leases
                    syncBatchLeaseState(existingBatch);

                    if (!existingBatch.clusters) {
                        existingBatch.clusters = [];
                    }

                    const isCurrentlyInspecting = this.activeBatch && (this.activeBatch.batchId === newBatch.batchId);

                    if (isCurrentlyInspecting && newBatch.clusters) {
                        for (let i = 0; i < newBatch.clusters.length; i++) {
                            const newCluster = newBatch.clusters[i];
                            let existingCluster = existingBatch.clusters.find((c) => c.clusterId === newCluster.clusterId);

                            if (existingCluster) {
                                existingCluster.note = newCluster.note;
                                existingCluster.isResolved = newCluster.isResolved;
                                existingCluster.manualResolution = newCluster.manualResolution;

                                // Reconcile posts in-place to retain object identity & tag cache
                                if (refreshedClusterId === existingCluster.clusterId) {
                                    existingCluster.posts = newCluster.posts || [];
                                } else if (newCluster.posts && Array.isArray(newCluster.posts)) {
                                    const existingPostsMap = new Map((existingCluster.posts || []).map((p) => [p.postId, p]));

                                    existingCluster.posts = newCluster.posts.map((newPost) => {
                                        const existingPost = existingPostsMap.get(newPost.postId);

                                        if (existingPost) {
                                            const tagsChanged = JSON.stringify(existingPost.tags) !== JSON.stringify(newPost.tags);

                                            Object.assign(existingPost, newPost);

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

                                if (refreshedClusterId && existingCluster.clusterId === refreshedClusterId) {
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

            // 4. Ensure existing batches not returned in incremental updates still have accurate lease state
            for (const b of this.batches) {
                syncBatchLeaseState(b);
                b.resolvedCount = (b.clusters || []).filter(c => c.isResolved).length;
                b.totalClusters = (b.clusters || []).length;
                if (b.resolvedCount === b.totalClusters && b.totalClusters > 0) {
                    b.status = 'COMPLETE';
                }
            }

            if (this.activeProject) {
                this.activeProject.resolvedClusters = this.batches.reduce((acc, b) => acc + (b.resolvedCount || 0), 0);
                this.activeProject.totalClusters = this.batches.reduce((acc, b) => acc + (b.totalClusters || 0), 0);
            }

            // Restore activeBatch reference
            if (this.activeBatch) {
                const found = this.batches.find(b => b.batchId === this.activeBatch?.batchId);
                if (found) this.activeBatch = found;
            }

        } catch (err) {
            if (silent) console.debug("[Polling] Sync failed:", err);
            else console.error("[Reload] Error loading batches:", err);
        } finally {
            this._reloadPromise = null;
        }
    })();

    return this._reloadPromise;
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
     * @param {Batch} batch
     */
    viewBatchDetail(batch) {
        this.activeBatch = batch;
    }

    /**
     * Navigates directly to a leased batch, fetching batches if not already in state.
     * @param {Lease} lease
     */
    async jumpToLeasedBatch(lease) {
        const batch = this.batches.find(b => b.batchId === lease.batchId);
        if (batch) {
            this.viewBatchDetail(batch);
        } else {
            try {
                const res = await fetch(`/api/v1/projects/${lease.projectId}/batches`, {
                    headers: { 'Accept': 'application/msgpack' }
                });
                if (!res.ok) return;
                const buf = await res.arrayBuffer();

                const data = /** @type {{ batches: Batch[] }} */ (decode(buf));
                this.batches = data.batches;
                const found = this.batches.find(b => b.batchId === lease.batchId);
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
        if (this.activeBatch.isClaiming) return false;
        if (this.activeBatch.status !== 'AVAILABLE') return false;
        if (this.activeLease) return false;
        return true;
    }

    /**
     * Claims the current active batch for the user.
     */
    async claimCurrentBatch() {
        if (!this.activeBatch || !this.activeProject) return;

        const batch = this.activeBatch;
        batch.isClaiming = true;

        try {
            const res = await fetch(`/api/v1/batches/${batch.batchId}/claim`, { method: 'POST' });
            /** @type {ClaimBatchResponse} */
            const data = await res.json();

            if (!res.ok) {
                showToast(data.detail || 'Failed to claim batch.', 'error');
                return;
            }

            this.activeLease = {
                batchId: data.batchId,
                batchNumber: batch.batchNumber,
                projectId: this.activeProject.projectId,
                leasedUntil: data.leasedUntil,
                isLeasedByYou: true
            };

            batch.status = 'CLAIMED';
            batch.isLeasedByYou = true;
            batch.leasedUntil = data.leasedUntil;

            await this.reloadBatches();
            showToast(`Claimed Batch #${batch.batchNumber}`, 'success');
        } catch (err) {
            console.error('[Leases] Error claiming batch:', err);
            showToast('Network error while claiming batch.', 'error');
        } finally {
            batch.isClaiming = false;
        }
    }

    /**
     * Revokes an existing batch lease.
     * @param {number} batchId
     */
    async revokeLease(batchId) {
        const batch = this.batches.find(b => b.batchId === batchId) || this.activeBatch;
        if (batch) batch.isRevoking = true;

        try {
            const res = await fetch(`/api/v1/batches/${batchId}/revoke`, { method: 'POST' });
            const data = await res.json();

            if (!res.ok) {
                showToast(data.detail || 'Failed to revoke lease.', 'error');
                return;
            }

            this.activeLease = null;
            if (batch) {
                batch.status = 'AVAILABLE';
                batch.isLeasedByYou = false;
                batch.leasedUntil = null;
            }

            await this.reloadBatches();
            showToast('Lease revoked.', 'info');
        } catch (err) {
            console.error('[Leases] Error revoking lease:', err);
            showToast('Network error while revoking lease.', 'error');
        } finally {
            if (batch) batch.isRevoking = false;
        }
    }

    /**
     * Triggers a batch refresh request on the backend.
     * @param {Batch} batch
     */
    async refreshBatch(batch) {
        if (!batch || batch.isRefreshing) return;

        batch.isRefreshing = true;

        try {
            const res = await fetch(`/api/v1/batches/${batch.batchId}/refresh`, { method: 'POST' });
            const data = await res.json();

            if (!res.ok) {
                showToast(data.detail || 'Failed to refresh batch.', 'warning');
                return;
            }

            await this.reloadBatches(true);
            showToast(`Refreshed Batch #${batch.batchNumber}`, 'success', 2500);
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