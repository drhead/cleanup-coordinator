import { ensureClusterPostsInfo } from './e621_api.js';

import './summary.js'

/**
 * @typedef {'duplicate' | 'variant' | 'unrelated' | 'unknown'} GraphType
 */

/**
 * @typedef {Object} ResolutionGraph
 * @property {GraphType} type
 * @property {Set<number>} posts
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

        /** @type {PostRating} */
        this.rating = original.rating;

        /** @type {number|null} */
        this.parent_id = original.parent_id ?? null;

        /** @type {number[]} */
        this.pool_ids = Array.isArray(original.pool_ids) ? [...original.pool_ids] : [];

        /** @type {string[]} */
        this.sources = Array.isArray(original.sources) ? [...original.sources] : [];

        /** @type {string} */
        this.description = original.description ?? "";

        /** @type {boolean} */
        this.flag = false;

        /** @type {string} */
        this.flag_note = "";
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

        async initializePosts() {
            if (!this.cluster || !Array.isArray(this.cluster.posts)) {
                return;
            }

            await ensureClusterPostsInfo(this.cluster.posts);

            for (const post of this.cluster.posts) {
                this.posts.set(post.post_id, new ResolutionPost(post));
            }
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
         * @param {number} id
         * @returns {void}
         */
        resolveDuplicateGraph(graph, id) {
            if (graph.type !== 'duplicate') {
                throw new Error(`Cannot resolve graph: Expected type 'duplicate', got '${graph.type}'`);
            }

            if (!graph.posts.has(id)) {
                throw new Error(`Cannot resolve duplicate graph: Post ID ${id} is not present in graph.`);
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
                        vGraph.posts.add(id);
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
         * @returns {void}
         */
        addGraphEdge(type, a, b) {
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
                // 1. Remove 'unrelated' graphs containing A or B
                this.graphs = this.graphs.filter(g => {
                    if (g.type === 'unrelated') {
                        return !g.posts.has(a) && !g.posts.has(b);
                    }
                    return true;
                });

                // Find existing graphs of target $type containing A or B
                const graphA = this.graphs.find(g => g.type === type && g.posts.has(a));
                const graphB = this.graphs.find(g => g.type === type && g.posts.has(b));

                // Case 1: Neither A nor B exist in a $type graph -> Create new graph with both
                if (!graphA && !graphB) {
                    this.graphs.push({ type, posts: new Set([a, b]) });
                }
                // Case 2: Exactly one exists -> Add missing node to it
                else if (graphA && !graphB) {
                    graphA.posts.add(b);
                }
                else if (!graphA && graphB) {
                    graphB.posts.add(a);
                }
                // Case 3: Both exist in separate $type graphs -> Merge graphB into graphA
                else if (graphA && graphB && graphA !== graphB) {
                    for (const postId of graphB.posts) {
                        graphA.posts.add(postId);
                    }
                    // Remove the merged graphB from graphs list
                    this.graphs = this.graphs.filter(g => g !== graphB);
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
                        return [a, b];
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
                        return [a, b];
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
        }
    }));
});