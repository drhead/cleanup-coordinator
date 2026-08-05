// @ts-check
import Alpine from 'alpinejs';
/** @type {any} */ (window).Alpine = Alpine;

import { fetchPostFileUrls } from './e621_api.js';
import { showToast } from './toasts.js';
import { tagManager } from './tags.js';

/** @type {any} */
let globalActiveReconciliation = null;

/**
 * Alpine component factory for tag reconciliation and classification graphs.
 * @param {Cluster} cluster
 */
export function ReconciliationManager(cluster) {
    return {
        isActive: false,
        isLoading: false,

        /** @type {AppState} */
        // @ts-expect-error
        appStateRef: null,

        /** @type {Map<number, string>} */
        fetchedPostsMap: new Map(),

        /** @type {Array<{ id: number, type: string, postIds: number[] }>} */
        graphs: [],
        activeGraphIndex: 0,

        /** @type {number|null} */
        selectedSuperiorId: null,
        /** @type {number|null} */
        selectedParentId: null,
        customParentId: '',
        /** @type {number|null} */
        lhsPostId: null,

        /** @type {string|null} */
        activeRating: null,
        /** @type {string|null} */
        originalRating: null,

        /** @type {string[]} */
        lhsTags: [],
        /** @type {Set<string>} */
        originalLhsTagNames: new Set(),
        /** @type {Set<string>} */
        newTags: new Set(),
        /** @type {Array<string | { name: string }>} */
        removedLhsTags: [],
        tagInput: '',

        get currentGraph() {
            return this.graphs[this.activeGraphIndex] || null;
        },

        /**
         * @param {number} postId
         * @returns {ClusterPost | null}
         */
        getLocalClusterPost(postId) {
            if (!cluster?.posts || !postId) return null;
            const post = cluster.posts.find(p => p.post_id === postId);
            if (!post) return null;

            const fetchedUrl = this.fetchedPostsMap.get(postId);
            if (fetchedUrl) {
                return {
                    ...post,
                    fileUrl: fetchedUrl
                };
            }
            return post;
        },

        getEffectiveLhsRating() {
            return this.activeRating || this.lhsPost?.rating || null;
        },

        /**
         * @param {number} postId
         */
        getPostById(postId) {
            return postId ? this.getLocalClusterPost(postId) : null;
        },

        get orderedPostIds() {
            if (!this.currentGraph) return [];
            if (!this.lhsPostId) return this.currentGraph.postIds;
            const remaining = this.currentGraph.postIds.filter(id => id !== this.lhsPostId);
            return [this.lhsPostId, ...remaining];
        },

        get lhsPost() {
            return (this.currentGraph && this.lhsPostId) ? this.getPostById(this.lhsPostId) : null;
        },

        get rhsPosts() {
            if (!this.currentGraph || !this.lhsPostId) return [];
            return this.currentGraph.postIds
                .filter(id => id !== this.lhsPostId)
                .map(id => this.getPostById(id))
                .filter(Boolean);
        },

        get isRatingChanged() {
            return this.activeRating !== this.originalRating;
        },

        get hasRatingConflict() {
            if (this.currentGraph?.type !== 'duplicate') return false;

            const graphPosts = this.currentGraph.postIds
                .map(id => this.getPostById(id))
                .filter(Boolean);

            const initialRatings = graphPosts.map(p => p?.rating);
            return new Set(initialRatings).size > 1 && !this.isRatingChanged;
        },

        /**
         * Helper to safely extract a flat array of tag strings from a target (array, post, or object).
         * @param {any} target
         * @returns {{ flatTags: string[], post: ClusterPost | null }}
         */
        extractFlatTagsAndPost(target) {
            if (!target) return { flatTags: [], post: null };

            if (Array.isArray(target)) {
                return { flatTags: target, post: null };
            }

            if (target === this.lhsTags) {
                return { flatTags: this.lhsTags, post: null };
            }

            const postId = target.post_id;
            const localPost = postId ? this.getLocalClusterPost(postId) : null;
            const rawTags = localPost?.tags || target.tags || [];

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
         * Delegate tag styling to TagManager singleton.
         * @param {string} category
         */
        getTagStyle(category) {
            return tagManager.getTagStyle(category);
        },

        /**
         * Delegate rating badges to TagManager singleton.
         * @param {string} rating
         */
        getRatingBadgeClass(rating) {
            return tagManager.getRatingBadgeClass(rating);
        },

        /**
         * Delegate rating labels to TagManager singleton.
         * @param {string} rating
         */
        getRatingLabel(rating) {
            return tagManager.getRatingLabel(rating);
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
            const targetId = postId || target?.post_id || null;
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
        getPostImageUrl(post) {
            if (!post) return '';
            return (post.post_id ? this.fetchedPostsMap.get(post.post_id) : null) || post.fileUrl || '';
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
                const directImplied = tagManager.implications[current]?.implies || [];

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

            try {
                // Ensure tag data is loaded before starting
                if (!tagManager.isLoaded) {
                    await tagManager.init();
                }

                await this.fetchClusterPosts();
                this.buildGraphsFromCluster();

                if (this.graphs.length === 0) {
                    throw new Error('No classified graphs found to reconcile.');
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

        async fetchClusterPosts() {
            if (!cluster.posts || cluster.posts.length === 0) return;

            if (cluster._fetchedPosts && cluster._fetchedPosts.size > 0) {
                this.fetchedPostsMap = new Map(cluster._fetchedPosts);
                return;
            }

            const postIds = cluster.posts.map(p => p.post_id);
            try {
                this.fetchedPostsMap = await fetchPostFileUrls(postIds);
            } catch (err) {
                console.error('[ReconciliationManager] Failed to fetch post file URLs:', err);
            }
        },

        buildGraphsFromCluster() {
            if (!cluster.pairs || cluster.pairs.length === 0) {
                this.graphs = [{
                    id: 1,
                    type: cluster.default_type || 'duplicate',
                    postIds: cluster.posts.map(p => p.post_id)
                }];
                return;
            }

            this.graphs = cluster.pairs.map((pair, idx) => ({
                id: idx + 1,
                type: pair.relationship || 'duplicate',
                postIds: [pair.a.post_id, pair.b.post_id]
            }));
        },

        /**
         * @param {number} idx
         */
        selectGraph(idx) {
            if (idx < 0 || idx >= this.graphs.length) return;
            this.activeGraphIndex = idx;
            this.setupCurrentGraph();
        },

        setupCurrentGraph() {
            if (!this.currentGraph) return;

            this.selectedSuperiorId = null;
            this.selectedParentId = null;
            this.customParentId = '';
            this.lhsPostId = null;
            this.syncLhsState();
        },

        /**
         * @param {number} postId
         */
        selectSuperior(postId) {
            if (!postId) return;
            this.selectedSuperiorId = postId;
            this.lhsPostId = postId;
            this.syncLhsState();
        },

        /**
         * @param {number} postId
         */
        setLhsPost(postId) {
            this.selectSuperior(postId);
        },

        syncLhsState() {
            this.activeRating = null;
            this.originalRating = null;
            this.newTags = new Set();
            this.removedLhsTags = [];

            if (!this.lhsPostId) {
                this.lhsTags = [];
                this.originalLhsTagNames = new Set();
                return;
            }

            const post = this.getLocalClusterPost(this.lhsPostId);
            const { flatTags } = this.extractFlatTagsAndPost(post);

            this.lhsTags = [...flatTags];
            this.originalLhsTagNames = new Set(flatTags);
            this.originalRating = post?.rating || null;
        },

        /**
         * @param {string} r
         */
        setRating(r) {
            this.activeRating = r;
        },

        /**
         * @param {string} tagName
         * @param {string} [category='GENERAL']
         */
        addTagWithImplications(tagName, category = 'GENERAL') {
            const fullImpliedChain = this.getAllImpliedTags(tagName);
            const tagsToAdd = [tagName, ...fullImpliedChain];

            tagsToAdd.forEach(t => {
                if (!this.lhsTags.includes(t)) {
                    this.lhsTags.push(t);

                    if (!this.originalLhsTagNames.has(t)) {
                        this.newTags.add(t);
                    }
                }

                const remIdx = this.removedLhsTags.findIndex(rt => (typeof rt === 'string' ? rt === t : rt.name === t));
                if (remIdx !== -1) {
                    this.removedLhsTags.splice(remIdx, 1);
                }
            });
        },

        /**
         * @param {{ name: string, category: string }} tagObj
         */
        copyTagToLhsWithImplications(tagObj) {
            this.addTagWithImplications(tagObj.name, tagObj.category);
        },

        /**
         * @param {string | { name: string }} tagObj
         */
        removeTagWithImplications(tagObj) {
            const tagName = typeof tagObj === 'string' ? tagObj : tagObj.name;
            const chain = this.getImplicationChain(this.lhsPostId, tagName, this.lhsTags);

            const toRemove = new Set([tagName]);
            if (chain) {
                chain.directImplicators?.forEach(t => toRemove.add(t));
                chain.indirectImplicators?.forEach(t => toRemove.add(t));
            }

            this.lhsTags = this.lhsTags.filter(t => {
                if (toRemove.has(t)) {
                    if (this.originalLhsTagNames.has(t) && !this.removedLhsTags.some(rt => (typeof rt === 'string' ? rt === t : rt.name === t))) {
                        this.removedLhsTags.push(t);
                    }
                    this.newTags.delete(t);
                    return false;
                }
                return true;
            });
        },

        /**
         * @param {string | { name: string }} tagObj
         */
        restoreTag(tagObj) {
            const tagName = typeof tagObj === 'string' ? tagObj : tagObj.name;
            this.addTagWithImplications(tagName);
        },

        addCustomTag() {
            const cleaned = this.tagInput.trim().toLowerCase().replace(/\s+/g, '_');
            if (cleaned) {
                this.addTagWithImplications(cleaned, 'GENERAL');
            }
            this.tagInput = '';
        },

        nextGraph() {
            if (this.activeGraphIndex < this.graphs.length - 1) {
                this.selectGraph(this.activeGraphIndex + 1);
            }
        },

        closeReconciliation() {
            this.isActive = false;
            this.isLoading = false;
            this.graphs = [];
            this.fetchedPostsMap.clear();

            if (globalActiveReconciliation === this) {
                globalActiveReconciliation = null;
            }
        }
    };
}

// Alpine Component Registration
document.addEventListener('alpine:init', () => {
    if (window.Alpine) {
        window.Alpine.data('ReconciliationManager', ReconciliationManager);
    }
});