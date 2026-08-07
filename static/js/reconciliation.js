// @ts-check
import Alpine from 'alpinejs';
/** @type {any} */ (window).Alpine = Alpine;

import { showToast } from './toasts.js';
import { tagManager } from './tags.js';
import { ResolutionPost } from './resolution.js';

/**
 * @typedef {Object} RootData
 * @property {string} activeView
 */

/** @type {any} */
let globalActiveReconciliation = null;

/**
 * Alpine component factory for tag reconciliation and classification graphs.
 * @param {ResolutionManagerComponent} manager
 */
export function ReconciliationManager(manager) {
    return {
        isActive: false,
        isLoading: false,
        isSummary: false,

        /** @type {ResolutionManagerComponent} */
        resolutionManager: manager,

        activeGraphIndex: 0,
        activeRhsIndex: 0,

        /** @type {number|null} */
        selectedSuperiorId: null,
        /** @type {number|null} */
        selectedParentId: null,
        customParentId: '',
        /** @type {number|null} */
        lhsPostId: null,

        tagInput: '',
        hoveredImplicationData: null,

        /**
         * Filter resolution graphs down to duplicate graphs only.
         * @returns {import('./resolution.js').ResolutionGraph[]}
         */
        get duplicateGraphs() {
            if (!this.resolutionManager?.graphs) return [];
            return this.resolutionManager.graphs.filter(g => g.type === 'duplicate');
        },

        /**
         * Get current active duplicate ResolutionGraph.
         * @returns {import('./resolution.js').ResolutionGraph|null}
         */
        get currentGraph() {
            return this.duplicateGraphs[this.activeGraphIndex] || null;
        },

        /**
         * Retrieves the editable working state ResolutionPost for the active LHS post.
         * @returns {ResolutionPost|undefined}
         */
        get lhsResolutionPost() {
            if (!this.currentGraph || !this.lhsPostId) return undefined;
            return this.resolutionManager.getPost(this.lhsPostId);
        },

        /**
         * @param {number} postId
         * @returns {ClusterPost | null}
         */
        getLocalClusterPost(postId) {
            return this.resolutionManager.getPost(postId)?.original || null;
        },

        get lhsPost() {
            return this.lhsResolutionPost?.original || null;
        },

        get lhsTags() {
            return this.lhsResolutionPost?.tags || [];
        },

        get originalLhsTagNames() {
            const resPost = this.lhsResolutionPost;
            if (!resPost) return new Set();
            return new Set(resPost.original.tags || []);
        },

        get newTags() {
            const resPost = this.lhsResolutionPost;
            if (!resPost) return new Set();
            const origSet = this.originalLhsTagNames;
            return new Set(resPost.tags.filter(t => !origSet.has(t)));
        },

        get removedLhsTags() {
            const resPost = this.lhsResolutionPost;
            if (!resPost) return [];
            const currentSet = new Set(resPost.tags);
            const originalTags = resPost.original.tags || [];
            return originalTags.filter(t => !currentSet.has(t));
        },

        get activeRating() {
            return this.lhsResolutionPost?.rating || null;
        },

        set activeRating(val) {
            if (this.lhsResolutionPost && val) {
                this.lhsResolutionPost.rating = val;
            }
        },

        get originalRating() {
            return this.lhsResolutionPost?.original.rating || null;
        },

        getEffectiveLhsRating() {
            return this.activeRating || this.lhsPost?.rating || null;
        },

        get orderedPostIds() {
            if (!this.currentGraph) return [];
            const postIds = Array.from(this.currentGraph.posts);
            if (!this.lhsPostId) return postIds;
            const remaining = postIds.filter(id => id !== this.lhsPostId);
            return [this.lhsPostId, ...remaining];
        },

        /**
         * Get remaining post IDs in current graph excluding the kept post.
         * @returns {number[]}
         */
        get rhsPostIds() {
            if (!this.currentGraph || !this.selectedSuperiorId) return [];
            return Array.from(this.currentGraph.posts).filter(id => id !== this.selectedSuperiorId);
        },

        /**
         * Get currently active RHS comparison post ID.
         * @returns {number|null}
         */
        get currentRhsPostId() {
            return this.rhsPostIds[this.activeRhsIndex] ?? null;
        },

        /**
         * Get active single RHS post for comparison/retagging.
         * @returns {ClusterPost[]}
         */
        get rhsPosts() {
            if (!this.currentRhsPostId) return [];
            const post = this.getLocalClusterPost(this.currentRhsPostId);
            return post ? [post] : [];
        },

        /**
         * Dynamic button label based on retagging and navigation progress.
         * @returns {string}
         */
        get nextButtonLabel() {
            if (!this.selectedSuperiorId) return 'Next Graph';
            if (this.activeRhsIndex < this.rhsPostIds.length - 1) {
                return 'Next Post';
            }
            if (this.activeGraphIndex < this.duplicateGraphs.length - 1) {
                return 'Next Graph';
            }
            return 'Summary';
        },

        get isRatingChanged() {
            return this.activeRating !== this.originalRating;
        },

        get hasRatingConflict() {
            if (!this.currentGraph) return false;

            const graphPosts = Array.from(this.currentGraph.posts)
                .map(id => this.getLocalClusterPost(id))
                .filter(Boolean);

            const initialRatings = graphPosts.map(p => p?.rating);
            return new Set(initialRatings).size > 1 && !this.isRatingChanged;
        },

        /**
         * Helper to safely extract a flat array of tag strings from a target.
         * @param {any} target
         * @returns {{ flatTags: string[], post: ClusterPost | null }}
         */
        extractFlatTagsAndPost(target) {
            if (!target) return { flatTags: [], post: null };

            if (Array.isArray(target)) {
                return { flatTags: target, post: null };
            }

            const postId = target.post_id || target.original?.post_id;
            const localPost = postId ? this.getLocalClusterPost(postId) : null;
            const rawTags = target.tags || localPost?.tags || [];

            let flatTags = [];
            if (Array.isArray(rawTags)) {
                flatTags = rawTags;
            } else if (rawTags && typeof rawTags === 'object') {
                flatTags = Object.values(rawTags).flat();
            }

            return { flatTags, post: localPost || null };
        },

        /**
         * Delegate sorting directly to TagManager singleton.
         * @param {any} target
         */
        getSortedTags(target) {
            const { flatTags, post } = this.extractFlatTagsAndPost(target);
            return tagManager.getSortedTags(flatTags, post);
        },

        /**
         * Check if a tag is implied using TagManager instance.
         * @param {string} tagName
         * @param {any} target
         */
        isImpliedTag(tagName, target) {
            const { flatTags } = this.extractFlatTagsAndPost(target);
            return tagManager.isImpliedTag(tagName, flatTags);
        },

        /**
         * Get implication chain using TagManager instance.
         * @param {number|null} postId
         * @param {string} tagName
         * @param {any} target
         */
        getImplicationChain(postId, tagName, target) {
            const targetId = postId || target?.post_id || target?.original?.post_id || null;
            let flatTags = [];

            if (targetId && targetId === this.lhsPostId) {
                flatTags = this.lhsTags;
            } else {
                flatTags = this.extractFlatTagsAndPost(target).flatTags;
            }

            return tagManager.getImplicationChain(targetId, tagName, flatTags);
        },

        /**
         * @param {ClusterPost|null} post
         */
        getPostDimensions(post) {
            if (!post) return 'N/A';
            const w = post.image_width;
            const h = post.image_height;
            return (w && h) ? `${w}×${h}` : 'N/A';
        },

        /**
         * @param {string} tagName
         */
        isTagOnLhs(tagName) {
            return this.lhsTags.includes(tagName);
        },

        /**
         * Traverses implications graph directly on TagManager instance.
         * @param {string} initialTag
         */
        getAllImpliedTags(initialTag) {
            const result = new Set();
            const queue = [initialTag];

            while (queue.length > 0) {
                const current = queue.shift();
                if (!current) continue;
                const directImplied = tagManager.tagInfoMap[current]?.implies || [];

                for (const imp of directImplied) {
                    if (!result.has(imp)) {
                        result.add(imp);
                        queue.push(imp);
                    }
                }
            }
            return Array.from(result);
        },

        async startReconciliation() {
            if (globalActiveReconciliation && globalActiveReconciliation !== this) {
                globalActiveReconciliation.closeReconciliation();
            }
            globalActiveReconciliation = this;
            this.isLoading = true;
            this.isSummary = false;

            try {
                if (this.duplicateGraphs.length === 0) {
                    throw new Error('No duplicate graphs found in ResolutionManager to reconcile.');
                }

                this.activeGraphIndex = 0;
                this.setupCurrentGraph();
                this.isActive = true;
            } catch (err) {
                console.error('[ReconciliationManager] Initiation error:', err);
                const message = err instanceof Error ? err.message : 'Unknown error';
                showToast(`Reconciliation error: ${message}`, 'error');
                this.closeReconciliation();
            } finally {
                this.isLoading = false;
            }
        },

        /**
         * @param {number} idx
         */
        selectGraph(idx) {
            if (idx < 0 || idx >= this.duplicateGraphs.length) return;
            this.activeGraphIndex = idx;
            this.setupCurrentGraph();
        },

        setupCurrentGraph() {
            if (!this.currentGraph) return;

            this.selectedSuperiorId = null;
            this.selectedParentId = null;
            this.customParentId = '';
            this.lhsPostId = null;
            this.activeRhsIndex = 0;
            this.isSummary = false;
        },

        /**
         * Selects the superior (kept) post for the active duplicate graph.
         * Flags all other posts in the graph (ResolutionPost.flag = true).
         * @param {number} postId
         */
        selectSuperior(postId) {
            if (!postId || !this.currentGraph) return;

            this.selectedSuperiorId = postId;
            this.lhsPostId = postId;
            this.activeRhsIndex = 0;

            // Set ResolutionPost.flag = true on all other posts in the duplicate graph
            for (const pId of this.currentGraph.posts) {
                const resPost = this.resolutionManager.getPost(pId);
                if (resPost) {
                    resPost.flag = (pId !== postId);
                }
            }

            this.resolutionManager.resolveDuplicateGraph(this.currentGraph, postId);
        },

        /**
         * @param {string} tagName
         */
        addTagWithImplications(tagName) {
            const resPost = this.lhsResolutionPost;
            if (!resPost) return;

            const fullImpliedChain = this.getAllImpliedTags(tagName);
            const tagsToAdd = [tagName, ...fullImpliedChain];

            tagsToAdd.forEach(t => {
                if (!resPost.tags.includes(t)) {
                    resPost.tags.push(t);
                }
            });
        },

        /**
         * @param {TagObj|string} tagObj
         */
        removeTagWithImplicators(tagObj) {
            const resPost = this.lhsResolutionPost;
            if (!resPost) return;

            const tagName = typeof tagObj === 'string' ? tagObj : tagObj.name;
            const chain = this.getImplicationChain(this.lhsPostId, tagName, resPost.tags);

            const toRemove = new Set([tagName]);
            if (chain) {
                chain.directImplicators?.forEach(t => toRemove.add(t));
                chain.indirectImplicators?.forEach(t => toRemove.add(t));
            }

            resPost.tags = resPost.tags.filter(t => !toRemove.has(t));
        },

        addCustomTag() {
            const cleaned = this.tagInput.trim().toLowerCase().replace(/\s+/g, '_');
            if (cleaned) {
                this.addTagWithImplications(cleaned);
            }
            this.tagInput = '';
        },

        /**
         * Advances reconciliation through RHS posts, duplicate graphs, or to Summary.
         * @param {RootData} rootData
         */
        advance(rootData) {
            if (this.activeRhsIndex < this.rhsPostIds.length - 1) {
                this.activeRhsIndex++;
            } else if (this.activeGraphIndex < this.duplicateGraphs.length - 1) {
                this.selectGraph(this.activeGraphIndex + 1);
            } else {
                this.proceedToSummary(rootData)
            }
        },

        closeReconciliation() {
            this.isActive = false;
            this.isLoading = false;

            if (globalActiveReconciliation === this) {
                globalActiveReconciliation = null;
            }
        },
        /**
         * @param {RootData | null} [rootData]
         */
        proceedToSummary(rootData) {
            this.closeReconciliation();
            if (rootData) {
                rootData.activeView = 'summary';
            }
        },
    };
}

// Alpine Component Registration
document.addEventListener('alpine:init', () => {
    if (window.Alpine) {
        window.Alpine.data('ReconciliationManager', ReconciliationManager);
    }

    Alpine.data('tagAutocomplete', () => ({
        /** @type {TagSearchResult[]} */
        results: [],
        isOpen: false,
        selectedIndex: -1,
        /** @type {ReturnType<setTimeout>|undefined} */
        debounceTimer: undefined,

        /**
         * Debounced input handler (300ms delay)
         */
        onInput() {
            clearTimeout(this.debounceTimer);
            this.selectedIndex = -1;

            /** @type {string} */
            // @ts-expect-error - tagInput is inherited from parent scope in Alpine
            const inputVal = this.tagInput || '';

            if (!inputVal.trim()) {
                this.results = [];
                this.isOpen = false;
                return;
            }

            this.debounceTimer = setTimeout(() => {
                this.fetchResults(inputVal, 20);
            }, 300);
        },

        /**
         * Executes search using TagManager binary index
         * @param {string} query
         * @param {number} k
         */
        fetchResults(query, k = 10) {
            this.results = tagManager.searchTags(query, k);
            this.isOpen = this.results.length > 0;
        },

        /**
         * Keyboard navigation (Up / Down arrows)
         * @param {number} direction
         */
        navigate(direction) {
            if (!this.isOpen || this.results.length === 0) return;
            
            this.selectedIndex += direction;
            if (this.selectedIndex < 0) {
                this.selectedIndex = this.results.length - 1;
            } else if (this.selectedIndex >= this.results.length) {
                this.selectedIndex = 0;
            }
        },

        /**
         * Triggers when pressing Enter in input
         */
        selectCurrentOrAdd() {
            if (this.isOpen && this.selectedIndex >= 0 && this.results[this.selectedIndex]) {
                this.selectResult(this.results[this.selectedIndex]);
            } else {
                this.commitTag();
            }
        },

        /**
         * Selects a result item, updates input, and triggers add
         * @param {TagSearchResult} tagObj
         */
        selectResult(tagObj) {
            // @ts-expect-error - tagInput is inherited from parent scope
            this.tagInput = tagObj.name;
            this.isOpen = false;
            this.results = [];
            
            this.commitTag();
        },

        /**
         * Safe dispatcher to trigger tag addition on parent scope
         */
        commitTag() {
            /** @type {import('alpinejs').AlpineComponent<any>} */
            // @ts-ignore - $dispatch is an Alpine magic property
            const el = this;

            if (typeof el.$dispatch === 'function') {
                el.$dispatch('add-tag');
            } else if (typeof el.addCustomTag === 'function') {
                el.addCustomTag();
            }
        },

        /**
         * Formats large counts cleanly (e.g. 12500 -> 12.5k)
         * @param {number} count
         */
        formatCount(count) {
            if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
            if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
            return count.toString();
        }
    }));
});