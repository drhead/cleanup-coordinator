import { ensureClusterPostsInfo } from './e621_api.js';

import './association.js';
import './summary.js';

/**
 * @typedef {'duplicate' | 'variant' | 'unrelated' | 'unknown'} GraphType
 */

/**
 * @typedef {Object} ResolutionGraph
 * @property {GraphType} type
 * @property {Set<number>} posts
 * @property {number} [head]
 */

/**
 * @typedef {Object} GraphRelation
 * @property {number} a
 * @property {number} b
 * @property {GraphType} type
 */

/**
 * Encapsulates editable working state for a single post during resolution.
 */
export class ResolutionPost {
    /**
     * @param {ClusterPost} original
     */
    constructor(original) {
        /** @type {ClusterPost} */
        this.original = original;

        /** @type {string[]} */
        this.tags = Array.isArray(original.tags) ? [...original.tags] : [];

        /** @type {PostRating|null} */
        this.rating = null;

        /** @type {number|null} */
        this.parentId = original.parentId ?? null;

        /** @type {number[]} */
        this.poolIds = Array.isArray(original.poolIds) ? [...original.poolIds] : [];

        /** @type {string[]|null} */
        this._sources = null;

        /** @type {string|null} */
        this._description = null;

        /** @type {string[]|null} */
        this._removedSources = null;

        /** @type {number[]|null} */
        this._removedPools = null;

        /** @type {Array<{origId: number, newId: number, poolId: number}>|null} */
        this._poolSubstitutions = null;

        /** @type {boolean} */
        this.flag = false;

        /** @type {string} */
        this.flagNote = "";

        /** @type {boolean} */
        this.isApplied = false;

        /** @type {boolean} */
        this.isFlagged = Boolean(original.isFlagged);
    }

    /**
     * Marks the post as flagged permanently in local state.
     */
    markFlagged() {
        this.isFlagged = true;
        this.flag = true;
        if (this.original) {
            this.original.isFlagged = true;
        }
    }

    /**
     * @returns {string[]}
     */
    get sources() {
        if (this._sources !== null) {
            return this._sources;
        }
        return Array.isArray(this.original.sources) ? [...this.original.sources] : [];
    }

    /**
     * @param {string[]|null} val
     */
    set sources(val) {
        this._sources = Array.isArray(val) ? [...val] : null;
    }

    /**
     * @returns {string}
     */
    get description() {
        if (this._description !== null) {
            return this._description;
        }
        return this.original.description ?? "";
    }

    /**
     * @param {string|null} val
     */
    set description(val) {
        this._description = val;
    }

    /**
     * Updates post.original with current values (or API response) and marks the post as applied,
     * clearing diff overrides so green highlights disappear and UI reflects applied state.
     * @param {Object} [updatedApiPost]
     */
    markApplied(updatedApiPost) {
        let finalTags = Array.isArray(this.tags) ? [...this.tags] : [];
        let finalSources = Array.isArray(this.sources) ? [...this.sources] : [];
        let finalDesc = this.description;
        let finalRating = this.getEffectiveRating();
        let finalParent = this.parentId;

        if (updatedApiPost && typeof updatedApiPost === 'object') {
            const apiObj = updatedApiPost.post || updatedApiPost;
            if (apiObj.post_id || apiObj.id || apiObj.postId) {
                if (Array.isArray(apiObj.tags)) finalTags = [...apiObj.tags];
                else if (typeof apiObj.tag_string === 'string') finalTags = apiObj.tag_string.split(' ').filter(Boolean);
                if (Array.isArray(apiObj.sources)) finalSources = [...apiObj.sources];
                if (typeof apiObj.description === 'string') finalDesc = apiObj.description;
                if (apiObj.rating) finalRating = apiObj.rating;
                if (apiObj.parent_id !== undefined) finalParent = apiObj.parent_id;
                else if (apiObj.parentId !== undefined) finalParent = apiObj.parentId;
            }
        }

        const pAny = /** @type {any} */ (this);

        // Deep copy final state into both working properties and original snapshot
        this.tags = [...finalTags];
        if (!this.original) this.original = /** @type {any} */ ({});
        this.original.tags = [...finalTags];

        this.sources = [...finalSources];
        this.original.sources = [...finalSources];

        this.description = finalDesc;
        this.original.description = finalDesc;

        this.rating = null;
        this.original.rating = finalRating;

        this.parentId = null;
        this.original.parentId = finalParent;

        this._sources = null;
        this._description = null;
        pAny._removedSources = [];
        pAny._poolSubstitutions = [];

        this.isApplied = true;
    }

    /**
     * Gets the effective rating, falling back to original if no override is set.
     * Use this for UI displays, badges, or tag logic that requires a concrete rating.
     * 
     * @returns {PostRating}
     */
    getEffectiveRating() {
        return this.rating ?? this.original.rating;
    }
}

document.addEventListener('alpine:init', () => {
    if (!window.Alpine) return;

    /**
     * Component factory for managing shared state during a cluster resolution session.
     * @param {Cluster} cluster
     */
    window.Alpine.data('resolutionManager', (cluster) => ({
        /** @type {Cluster} */
        // @ts-expect-error
        cluster: cluster,

        /** @type {ResolutionGraph[]} */
        graphs: [],

        /** @type {Map<string, GraphRelation>} Map formatted "minId:maxId" -> GraphRelation */
        relations: new Map(),

        /** @type {Map<number, ResolutionPost>} */
        posts: new Map(),

        /** @type {any} */
        activeComparison: null,
        /** @type {any} */
        activeReconciliation: null,

        initializePosts() {
            if (!this.cluster || !Array.isArray(this.cluster.posts)) {
                return;
            }

            for (const post of this.cluster.posts) {
                if (!this.posts.has(post.postId)) {
                    this.posts.set(post.postId, new ResolutionPost(post));
                }
            }

            if (this.graphs.length === 0) {
                this.preloadKnownRelations();
            }

            // Asynchronously fetch missing e621 metadata in background
            ensureClusterPostsInfo(this.cluster.posts).catch(err => {
                console.warn('[ResolutionManager] Background metadata fetch warning:', err);
            });
        },

        /**
         * Preloads graph relations (duplicates, variants via parenting/pools)
         * based on pre-existing post flags and relationships.
         */
        preloadKnownRelations() {
            if (!this.cluster || !Array.isArray(this.cluster.posts) || this.cluster.posts.length < 2) {
                return;
            }

            const posts = this.cluster.posts;
            const clusterPostIds = new Set(posts.map(p => p.postId));

            // 0. Detect unknown posts (missing postId)
            for (const p of posts) {
                if (!p || !p.postId) {
                    this.markUnknown(p?.postId || 0);
                }
            }

            // 1. Identify Duplicate Subgraphs
            /** @type {Map<number, ClusterPost[]>} */
            const duplicatesByParent = new Map();
            /** @type {Set<number>} */
            const duplicateChildIds = new Set();

            // Case A: Explicit parent-child link where child is flagged or deleted and parent is in cluster
            for (const p of posts) {
                if ((p.isFlagged || p.isDeleted) && p.parentId != null) {
                    const parentId = Number(p.parentId);
                    if (clusterPostIds.has(parentId)) {
                        if (!duplicatesByParent.has(parentId)) {
                            duplicatesByParent.set(parentId, []);
                        }
                        duplicatesByParent.get(parentId)?.push(p);
                        duplicateChildIds.add(p.postId);
                    }
                }
            }

            // Case B: In a cluster with only 1 active post (or 2 posts where 1 is flagged/deleted),
            // inferiors without explicit parenting are duplicates of the active post.
            const activePosts = posts.filter(p => !p.isDeleted && !p.isFlagged);
            const flaggedOrDeletedPosts = posts.filter(p => p.isDeleted || p.isFlagged);

            if (activePosts.length === 1 && flaggedOrDeletedPosts.length > 0) {
                const superior = activePosts[0];
                for (const p of flaggedOrDeletedPosts) {
                    if (!duplicateChildIds.has(p.postId)) {
                        if (!duplicatesByParent.has(superior.postId)) {
                            duplicatesByParent.set(superior.postId, []);
                        }
                        duplicatesByParent.get(superior.postId)?.push(p);
                        duplicateChildIds.add(p.postId);
                    }
                }
            }

            // Ingest duplicate edges and preset resPost flags
            for (const [parentId, dupList] of duplicatesByParent.entries()) {
                for (const dp of dupList) {
                    const resPost = this.posts.get(dp.postId);
                    if (resPost) {
                        resPost.flag = true;
                    }
                    this.addGraphEdge('duplicate', parentId, dp.postId, parentId);
                }
            }

            // 2. Identify Variant Relationships
            // A) Direct non-duplicate parent-child relations within cluster
            for (const p of posts) {
                if (p.parentId != null) {
                    const parentId = Number(p.parentId);
                    if (clusterPostIds.has(parentId) && !duplicateChildIds.has(p.postId)) {
                        this.addGraphEdge('variant', p.postId, parentId);
                    }
                }
            }

            // B) Sibling posts sharing the same parentId (internal or external)
            /** @type {Map<number, number[]>} */
            const sharedParentMap = new Map();
            for (const p of posts) {
                if (p.parentId != null) {
                    const pid = Number(p.parentId);
                    let list = sharedParentMap.get(pid);
                    if (!list) {
                        list = [];
                        sharedParentMap.set(pid, list);
                    }
                    list.push(p.postId);
                }
            }
            for (const siblingIds of sharedParentMap.values()) {
                for (let i = 0; i < siblingIds.length; i++) {
                    for (let j = i + 1; j < siblingIds.length; j++) {
                        const idA = siblingIds[i];
                        const idB = siblingIds[j];
                        if (!this.graphs.some(g => g.type === 'duplicate' && g.posts.has(idA) && g.posts.has(idB))) {
                            this.addGraphEdge('variant', idA, idB);
                        }
                    }
                }
            }

            // C) Shared pool memberships
            /** @type {Map<number, number[]>} */
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
            for (const memberIds of poolMap.values()) {
                for (let i = 0; i < memberIds.length; i++) {
                    for (let j = i + 1; j < memberIds.length; j++) {
                        const idA = memberIds[i];
                        const idB = memberIds[j];
                        if (!this.graphs.some(g => g.type === 'duplicate' && g.posts.has(idA) && g.posts.has(idB))) {
                            this.addGraphEdge('variant', idA, idB);
                        }
                    }
                }
            }

            // 2.5 Identify Confirmed Relations from Edited Posts
            // If two active posts are both confirmed edited (isEdited = true), their relationship is presumed correct.
            // If they are not duplicates and not already variants (by parent/pool), they are marked as 'unrelated'.
            const activePostsForEdits = posts.filter(p => p.isEdited && !p.isDeleted && !p.isFlagged && !duplicateChildIds.has(p.postId));
            if (activePostsForEdits.length >= 2) {
                for (let i = 0; i < activePostsForEdits.length; i++) {
                    for (let j = i + 1; j < activePostsForEdits.length; j++) {
                        const idA = activePostsForEdits[i].postId;
                        const idB = activePostsForEdits[j].postId;

                        const isVariant = this.graphs.some(g => g.type === 'variant' && g.posts.has(idA) && g.posts.has(idB));
                        const isDupe = this.graphs.some(g => g.type === 'duplicate' && g.posts.has(idA) && g.posts.has(idB));

                        if (!isVariant && !isDupe) {
                            this.addGraphEdge('unrelated', idA, idB);
                        }
                    }
                }
            }

            // 3. Resolve Duplicate References in Variant Subgraphs
            for (const g of [...this.graphs]) {
                if (g.type === 'duplicate' && g.head) {
                    this.resolveDuplicateGraph(g);
                }
            }

            // 4. Derive Transitive Relations
            this.recalculateDerivedRelations();
        },

        /**
         * Retrieves a ResolutionPost by ID.
         * @param {number} postId
         * @returns {ResolutionPost|undefined}
         */
        getPost(postId) {
            return this.posts.get(postId);
        },

        /**
         * Collapses a duplicate graph down to a single canonical post ID
         * and updates any variant graphs referencing those duplicate posts.
         * @param {ResolutionGraph} graph
         * @returns {void}
         */
        resolveDuplicateGraph(graph) {
            if (graph.type !== 'duplicate') {
                throw new Error(`Cannot resolve graph: Expected type 'duplicate', got '${graph.type}'`);
            }

            if (!graph.head) {
                throw new Error(`Cannot resolve duplicate graph: No head set.`);
            }

            if (!graph.posts.has(graph.head)) {
                throw new Error(`Cannot resolve duplicate graph: Head '${graph.head}' not present in graph.`);
            }

            // For all 'variant' graphs containing any of graph.posts:
            // Remove graph.posts from them, and add the canonical `id`
            for (const vGraph of this.graphs) {
                if (vGraph.type === 'variant') {
                    let matched = false;

                    for (const postId of graph.posts) {
                        if (vGraph.posts.has(postId)) {
                            vGraph.posts.delete(postId);
                            matched = true;
                        }
                    }

                    if (matched) {
                        vGraph.posts.add(graph.head);
                    }
                }
            }
        },

        /**
         * Helper to get standard key for pairwise relationships.
         * @private
         * @param {number} a
         * @param {number} b
         * @returns {string}
         */
        _getRelationKey(a, b) {
            return a < b ? `${a}:${b}` : `${b}:${a}`;
        },

        /**
         * Marks a post as unknown (e.g., missing fileUrl).
         * @param {number} id
         * @returns {void}
         */
        markUnknown(id) {
            this.graphs.push({
                type: 'unknown',
                posts: new Set([id])
            });
        },

        /**
         * Signals a relation of a specific type between two post IDs.
         * @param {GraphType} type
         * @param {number} a
         * @param {number} b
         * @param {number | null} [superiorId]
         * @returns {void}
         */
        addGraphEdge(type, a, b, superiorId = null) {
            if (type === 'unrelated') {
                // Check if ANY graph contains A or B
                if (!this.graphs.some(g => g.posts.has(a))) {
                    this.graphs.push({ type: 'unrelated', posts: new Set([a]) });
                }
                if (!this.graphs.some(g => g.posts.has(b))) {
                    this.graphs.push({ type: 'unrelated', posts: new Set([b]) });
                }
                const key = this._getRelationKey(a, b);
                const [minId, maxId] = a < b ? [a, b] : [b, a];
                this.relations.set(key, { a: minId, b: maxId, type: 'unrelated' });
                return;
            }

            // Handle 'duplicate' or 'variant'
            if (type === 'duplicate' || type === 'variant') {
                // Cross-pool guard: Do not allow variant links across disjoint non-empty pool sets
                if (type === 'variant') {
                    const postA = this.getPost(a)?.original || this.cluster?.posts?.find(p => p.postId === a);
                    const postB = this.getPost(b)?.original || this.cluster?.posts?.find(p => p.postId === b);
                    if (postA && postB) {
                        const poolsA = Array.isArray(postA.poolIds) ? postA.poolIds : [];
                        const poolsB = Array.isArray(postB.poolIds) ? postB.poolIds : [];
                        if (poolsA.length > 0 && poolsB.length > 0) {
                            const hasCommonPool = poolsA.some(id => poolsB.includes(id));
                            if (!hasCommonPool) {
                                console.warn(`[ResolutionManager] Blocked cross-pool variant link between #${a} and #${b}`);
                                return;
                            }
                        }
                    }
                }

                // 1. Remove 'unrelated' graphs containing A or B
                this.graphs = this.graphs.filter(g => {
                    if (g.type === 'unrelated') {
                        return !g.posts.has(a) && !g.posts.has(b);
                    }
                    return true;
                });

                const graphA = this.graphs.find(g => g.type === type && g.posts.has(a));
                const graphB = this.graphs.find(g => g.type === type && g.posts.has(b));

                // Case 1: Neither A nor B exist in a $type graph -> Create new graph with both
                if (!graphA && !graphB) {
                    /** @type {ResolutionGraph} */
                    const newGraph = { type, posts: new Set([a, b]) };
                    if (type === 'duplicate' && superiorId) {
                        newGraph.head = superiorId;
                    }
                    this.graphs.push(newGraph);
                }
                // Case 2: Exactly one exists -> Add missing node & update head if superior
                else if (graphA && !graphB) {
                    graphA.posts.add(b);
                    if (type === 'duplicate' && superiorId) {
                        graphA.head = superiorId;
                    }
                }
                else if (!graphA && graphB) {
                    graphB.posts.add(a);
                    if (type === 'duplicate' && superiorId) {
                        graphB.head = superiorId;
                    }
                }
                // Case 3: Both exist in separate $type graphs -> Merge graphB into graphA
                else if (graphA && graphB && graphA !== graphB) {
                    for (const postId of graphB.posts) {
                        graphA.posts.add(postId);
                    }
                    if (type === 'duplicate' && superiorId) {
                        graphA.head = superiorId;
                    }
                    // Remove the merged graphB from graphs list
                    this.graphs = this.graphs.filter(g => g !== graphB);
                }
            }
        },

        /**
         * Flattens a variant graph hierarchy so all child posts have parentId set to rootParentId.
         * @param {ResolutionGraph} variantGraph
         * @param {number} rootParentId
         */
        flattenVariantHierarchy(variantGraph, rootParentId) {
            if (!variantGraph || variantGraph.type !== 'variant') return;
            variantGraph.head = rootParentId;

            const clusterPostIds = new Set((this.cluster?.posts || []).map(p => p.postId));
            for (const postId of variantGraph.posts) {
                const resPost = this.getPost(postId);
                if (!resPost) continue;

                if (postId === rootParentId) {
                    if (resPost.parentId && clusterPostIds.has(Number(resPost.parentId))) {
                        resPost.parentId = null;
                    }
                } else {
                    resPost.parentId = rootParentId;
                }
            }
        },

        /**
         * Recalculates transitive connections (duplicates/variants) and replicates
         * unrelated links across connected components into `this.relations`.
         * @returns {void}
         */
        recalculateDerivedRelations() {
            /**
             * Helper to safely record/upgrade a relation
             * @param {number} x
             * @param {number} y
             * @param {GraphType} relType
             */
            const recordRelation = (x, y, relType) => {
                if (x === y) return;
                const key = this._getRelationKey(x, y);
                const [minId, maxId] = x < y ? [x, y] : [y, x];

                const existing = this.relations.get(key);
                if (!existing) {
                    this.relations.set(key, { a: minId, b: maxId, type: relType });
                } else if (existing.type === 'variant' && relType === 'duplicate') {
                    existing.type = 'duplicate';
                }
            };

            // 1. Process explicit duplicate/variant graphs and build connected components
            /** @type {Map<number, Set<number>>} */
            const clusterComponents = new Map();

            /**
             * @param {number} id
             * @returns {Set<number>}
             */
            const getComponent = (id) => {
                let comp = clusterComponents.get(id);
                if (!comp) {
                    comp = new Set([id]);
                    clusterComponents.set(id, comp);
                }
                return comp;
            };

            for (const graph of this.graphs) {
                if (graph.type === 'duplicate' || graph.type === 'variant') {
                    const postsList = Array.from(graph.posts);
                    if (postsList.length === 0) continue;

                    // Derive pairwise relations directly within this graph
                    for (let i = 0; i < postsList.length; i++) {
                        for (let j = i + 1; j < postsList.length; j++) {
                            recordRelation(postsList[i], postsList[j], graph.type);
                        }
                    }

                    // Merge component sets
                    const mergedComponent = new Set();
                    for (const postId of postsList) {
                        const comp = getComponent(postId);
                        for (const id of comp) {
                            mergedComponent.add(id);
                        }
                    }

                    for (const postId of mergedComponent) {
                        clusterComponents.set(postId, mergedComponent);
                    }
                }
            }

            // 2. Pairwise transitive relations within merged components
            /** @type {Set<Set<number>>} */
            const processedComponents = new Set();
            for (const comp of clusterComponents.values()) {
                if (processedComponents.has(comp)) continue;
                processedComponents.add(comp);

                const postsArr = Array.from(comp);
                for (let i = 0; i < postsArr.length; i++) {
                    for (let j = i + 1; j < postsArr.length; j++) {
                        // Default transitive relation within a component is 'variant' unless recorded higher
                        recordRelation(postsArr[i], postsArr[j], 'variant');
                    }
                }
            }

            // 3. Replicate existing 'unrelated' relations across connected components
            const currentUnrelateds = Array.from(this.relations.values()).filter(r => r.type === 'unrelated');
            for (const rel of currentUnrelateds) {
                const compA = getComponent(rel.a);
                const compB = getComponent(rel.b);

                for (const x of compA) {
                    for (const y of compB) {
                        recordRelation(x, y, 'unrelated');
                    }
                }
            }
        },

        /**
         * Finds the next pair of post IDs needing comparison to resolve relationships.
         * @returns {[number, number] | false} Pair of post IDs [a, b] or false if fully mapped.
         */
        getNextPair() {
            this.recalculateDerivedRelations();
            const unknowns = new Set();
            const unrelateds = new Set();

            for (const graph of this.graphs) {
                if (graph.type === 'unknown') {
                    for (const id of graph.posts) unknowns.add(id);
                } else if (graph.type === 'unrelated') {
                    for (const id of graph.posts) unrelateds.add(id);
                }
            }

            const unrelatedOrUnknown = new Set([...unknowns, ...unrelateds]);
            /** @param {number} id */
            const getHeadIfDuplicate = (id) => {
                const dupGraph = this.graphs.find(g => g.type === 'duplicate' && g.posts.has(id));
                return dupGraph?.head ?? id;
            };

            /**
             * Check if pair (a, b) already has an established relation in stored relations
             * @param {number} a
             * @param {number} b
             * @returns {boolean}
             */
            const hasRelation = (a, b) => {
                const key = this._getRelationKey(a, b);
                return this.relations.has(key);
            };

            const allPostIds = Array.from(this.posts.keys());

            // Phase 1: Evaluate posts not in unrelated or unknown
            const phase1Posts = allPostIds.filter(id => !unrelatedOrUnknown.has(id));
            for (let i = 0; i < phase1Posts.length; i++) {
                for (let j = i + 1; j < phase1Posts.length; j++) {
                    const a = phase1Posts[i];
                    const b = phase1Posts[j];
                    if (!hasRelation(a, b)) {
                        return [getHeadIfDuplicate(a), getHeadIfDuplicate(b)];
                    }
                }
            }

            // Phase 2: Evaluate posts not in unknown (attempting leftover unrelated comparisons)
            const phase2Posts = allPostIds.filter(id => !unknowns.has(id));
            for (let i = 0; i < phase2Posts.length; i++) {
                for (let j = i + 1; j < phase2Posts.length; j++) {
                    const a = phase2Posts[i];
                    const b = phase2Posts[j];
                    if (!hasRelation(a, b)) {
                        return [getHeadIfDuplicate(a), getHeadIfDuplicate(b)];
                    }
                }
            }

            return false;
        },

        /**
         * Clears all recorded graphs and relations.
         * @returns {void}
         */
        clearGraphs() {
            this.graphs = [];
            this.relations.clear();
        },

        /**
         * Clears working graph state and resets all post instances back to original values.
         * @returns {void}
         */
        resetClusterWork() {
            this.clearGraphs();
            this.activeComparison = null;
            this.activeReconciliation = null;
            for (const [, resPost] of this.posts.entries()) {
                resPost.tags = Array.isArray(resPost.original.tags) ? [...resPost.original.tags] : [];
                resPost.rating = null;
                resPost.parentId = resPost.original.parentId ?? null;
                resPost.poolIds = Array.isArray(resPost.original.poolIds) ? [...resPost.original.poolIds] : [];
                resPost._sources = null;
                resPost._description = null;
                resPost.flag = false;
                resPost.flagNote = "";
            }
            this.preloadKnownRelations();
        }
    }));
});