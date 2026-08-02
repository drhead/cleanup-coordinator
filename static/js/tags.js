import { decode } from '@msgpack/msgpack';

export const TagManager = {
    implications: {},
    hoveredImplicationData: {
        postId: null,
        tagName: null,
        directImplicators: [],
        indirectImplicators: [],
        directImplied: [],
        indirectImplied: []
    },
    hoveredMergedData: { clusterId: null, targetPostId: null, tags: [] },

    async initTags() {
        try {
            const res = await fetch('/static/data/tag_implications.msgpack', {
                headers: { 'Accept': 'application/msgpack' }
            });
            if (!res.ok) return;
            const buffer = await res.arrayBuffer();
            this.implications = decode(buffer) || {};
        } catch (err) {
            console.error('[TagManager] Failed to load tag implications:', err);
        }
    },

    getSortedTags(tagsJson, post = null) {
        if (!tagsJson || typeof tagsJson !== 'object') return [];

        // 1. Flatten incoming tags to compute a fast structural signature
        const allTags = Object.values(tagsJson).flat().sort();
        const currentSignature = allTags.join(',');

        // 2. Return cached array if post object exists and tag signature matches
        if (post && post._tagSignature === currentSignature && post._sortedTags) {
            return post._sortedTags;
        }

        // 3. Re-compute sorting logic
        const categoryOrder = ['ARTIST', 'CONTRIBUTOR', 'COPYRIGHT', 'CHARACTER', 'SPECIES', 'GENERAL', 'META', 'LORE', 'INVALID'];
        
        const keys = Object.keys(tagsJson).sort((a, b) => {
            let idxA = categoryOrder.indexOf(a.toUpperCase());
            let idxB = categoryOrder.indexOf(b.toUpperCase());
            if (idxA === -1) idxA = 99;
            if (idxB === -1) idxB = 99;
            return idxA - idxB;
        });

        let result = [];
        for (const key of keys) {
            const tags = tagsJson[key] || [];
            const sortedCategoryTags = this.sortCategoryTags(tags);
            for (const tag of sortedCategoryTags) {
                result.push({
                    name: tag,
                    category: key.toUpperCase()
                });
            }
        }

        // 4. Store cache and signature on the post object if provided
        if (post) {
            post._sortedTags = result;
            post._tagSignature = currentSignature;
        }

        return result;
    },

    /**
     * Sorts tags within a category using DAG topological depth levels.
     * Level 0: Tags that imply others (most specific) or standalone tags.
     * Level N: Tags implied by Level N-1 tags.
     */
    sortCategoryTags(tags) {
        if (!tags || tags.length <= 1) return tags ? tags.slice() : [];
        if (!this.implications || Object.keys(this.implications).length === 0) {
            return tags.slice().sort((a, b) => a.localeCompare(b));
        }

        const tagSet = new Set(tags);

        // 1. Build adjacency list & undirected graph for component decomposition
        const adj = {};        // u -> [v] (u implies v)
        const revAdj = {};     // v -> [u] (implicators)
        const undirAdj = {};   // undirected edges
        const inDegree = {};

        for (const t of tags) {
            adj[t] = [];
            revAdj[t] = [];
            undirAdj[t] = [];
            inDegree[t] = 0;
        }

        for (const u of tags) {
            const directImplied = this.implications[u]?.implies || [];
            for (const v of directImplied) {
                if (tagSet.has(v)) {
                    adj[u].push(v);
                    revAdj[v].push(u);
                    undirAdj[u].push(v);
                    undirAdj[v].push(u);
                    inDegree[v] = (inDegree[v] || 0) + 1;
                }
            }
        }

        // 2. Separate into connected components
        const visitedComp = new Set();
        const components = [];

        for (const t of tags) {
            if (visitedComp.has(t)) continue;
            const comp = [];
            const queue = [t];
            visitedComp.add(t);

            while (queue.length > 0) {
                const curr = queue.shift();
                comp.push(curr);
                for (const neighbor of undirAdj[curr]) {
                    if (!visitedComp.has(neighbor)) {
                        visitedComp.add(neighbor);
                        queue.push(neighbor);
                    }
                }
            }
            components.push(comp);
        }

        // 3. Process each component DAG
        const processedComponents = components.map(comp => {
            // Forward depth calculation via longest path
            const forwardDepth = {};
            const compInDegree = {};
            for (const t of comp) {
                forwardDepth[t] = 0;
                compInDegree[t] = inDegree[t];
            }

            const sources = comp.filter(t => compInDegree[t] === 0);
            const q = [...sources];

            while (q.length > 0) {
                const u = q.shift();
                for (const v of adj[u]) {
                    forwardDepth[v] = Math.max(forwardDepth[v], forwardDepth[u] + 1);
                    compInDegree[v]--;
                    if (compInDegree[v] === 0) {
                        q.push(v);
                    }
                }
            }

            // Assign levels (leaf vs non-leaf)
            const level = {};
            for (const t of comp) {
                if (inDegree[t] > 0) {
                    level[t] = forwardDepth[t];
                } else {
                    const children = adj[t];
                    if (children.length > 0) {
                        const maxChildLevel = Math.max(...children.map(c => forwardDepth[c]));
                        level[t] = Math.max(0, maxChildLevel - 1);
                    } else {
                        level[t] = 0;
                    }
                }
            }

            // Group tags into level buckets
            const maxLevel = Math.max(...comp.map(t => level[t]));
            const levelBuckets = Array.from({ length: maxLevel + 1 }, () => []);
            for (const t of comp) {
                levelBuckets[level[t]].push(t);
            }

            // Sort Level 0 (Leaves sorted alphabetically)
            const level0Leaves = levelBuckets[0].filter(t => inDegree[t] === 0).sort((a, b) => a.localeCompare(b));
            const level0NonLeaves = levelBuckets[0].filter(t => inDegree[t] > 0).sort((a, b) => a.localeCompare(b));

            let orderedComp = [...level0Leaves, ...level0NonLeaves];
            const posMap = new Map();
            orderedComp.forEach((t, idx) => posMap.set(t, idx));

            // Sort Levels 1 through maxLevel
            for (let k = 1; k <= maxLevel; k++) {
                const bucket = levelBuckets[k];
                const regularTags = bucket.filter(t => inDegree[t] > 0);
                const shiftedLeaves = bucket.filter(t => inDegree[t] === 0);

                // Regular tags sort by implicator position first, then alphabetically
                regularTags.sort((a, b) => {
                    const parentsA = revAdj[a] || [];
                    const parentsB = revAdj[b] || [];

                    const minPosA = parentsA.reduce((min, p) => posMap.has(p) ? Math.min(min, posMap.get(p)) : min, Infinity);
                    const minPosB = parentsB.reduce((min, p) => posMap.has(p) ? Math.min(min, posMap.get(p)) : min, Infinity);

                    if (minPosA !== minPosB) {
                        return minPosA - minPosB;
                    }
                    return a.localeCompare(b);
                });

                // Shifted leaf tags placed at the end of the level, sorted alphabetically
                shiftedLeaves.sort((a, b) => a.localeCompare(b));

                const combinedLevel = [...regularTags, ...shiftedLeaves];
                for (const t of combinedLevel) {
                    posMap.set(t, orderedComp.length);
                    orderedComp.push(t);
                }
            }

            // Primary leaf for component sorting
            const compLeaves = sources.length > 0 ? sources : comp;
            const primaryLeaf = compLeaves.slice().sort((a, b) => a.localeCompare(b))[0];

            return {
                primaryLeaf,
                tags: orderedComp
            };
        });

        // Sort graphs/components by primary leaf tag name
        processedComponents.sort((a, b) => a.primaryLeaf.localeCompare(b.primaryLeaf));

        return processedComponents.flatMap(c => c.tags);
    },

    isImpliedTag(tagName, tagsCategorized) {
        if (!this.implications || !tagName || !tagsCategorized) return false;
        const implData = this.implications[tagName];
        if (!implData || !implData.implied_by || implData.implied_by.length === 0) return false;

        const allPostTags = new Set(Object.values(tagsCategorized).flat());
        return implData.implied_by.some(implicator => allPostTags.has(implicator));
    },

    setHoveredTag(postId, tagName, tagsCategorized) {
        if (!this.implications || !tagName || !tagsCategorized) return;

        const allPostTags = new Set(Object.values(tagsCategorized).flat());

        // 1. Direct Implicators & Implied (1 hop)
        const directImplied = (this.implications[tagName]?.implies || []).filter(t => allPostTags.has(t));
        const directImplicators = (this.implications[tagName]?.implied_by || []).filter(t => allPostTags.has(t));

        // 2. Indirect Implied (2+ hops via BFS)
        const indirectImplied = [];
        const visitedImplied = new Set([tagName, ...directImplied]);
        const queueImplied = [...directImplied];

        while (queueImplied.length > 0) {
            const current = queueImplied.shift();
            const children = this.implications[current]?.implies || [];
            for (const child of children) {
                if (allPostTags.has(child) && !visitedImplied.has(child)) {
                    visitedImplied.add(child);
                    indirectImplied.push(child);
                    queueImplied.push(child);
                }
            }
        }

        // 3. Indirect Implicators (2+ hops via BFS)
        const indirectImplicators = [];
        const visitedImplicators = new Set([tagName, ...directImplicators]);
        const queueImplicators = [...directImplicators];

        while (queueImplicators.length > 0) {
            const current = queueImplicators.shift();
            const parents = this.implications[current]?.implied_by || [];
            for (const parent of parents) {
                if (allPostTags.has(parent) && !visitedImplicators.has(parent)) {
                    visitedImplicators.add(parent);
                    indirectImplicators.push(parent);
                    queueImplicators.push(parent);
                }
            }
        }

        this.hoveredImplicationData = {
            postId,
            tagName,
            directImplicators,
            indirectImplicators,
            directImplied,
            indirectImplied
        };
    },

    clearHoveredTag() {
        this.hoveredImplicationData = {
            postId: null,
            tagName: null,
            directImplicators: [],
            indirectImplicators: [],
            directImplied: [],
            indirectImplied: []
        };
    },

    getTagStyle(category) {
        const cat = (category || '').toUpperCase();
        switch (cat) {
            case 'ARTIST':
                return 'color: #f2ac08;';
            case 'COPYRIGHT':
                return 'color: #d0d;';
            case 'CHARACTER':
                return 'color: #0a0;';
            case 'CONTRIBUTOR':
                return 'color: silver';
            case 'SPECIES':
                return 'color: #ed5d1f;';
            case 'GENERAL':
                return 'color: #b4c7d9;';
            case 'META':
                return 'color: #e0e0e0;';
            case 'LORE':
                return 'color: #282';
            default:
                return 'color: #ff3d3d;';
        }
    },

    getRatingLabel(rating) {
        const r = (rating || '').toLowerCase();
        if (r === 's') return 'S';
        if (r === 'q') return 'Q';
        if (r === 'e') return 'E';
        return rating.toUpperCase();
    },

    getRatingBadgeClass(rating) {
        const r = (rating || '').toLowerCase();
        if (r === 's') return 'bg-green-950/80 text-green-400 border border-green-800/60';
        if (r === 'q') return 'bg-amber-950/80 text-amber-400 border border-amber-800/60';
        if (r === 'e') return 'bg-red-950/80 text-red-400 border border-red-800/60';
        return 'bg-gray-800 text-gray-300 border border-gray-700';
    },

    calculateMergedTags(targetPost, clusterPosts) {
        if (!clusterPosts || !targetPost) return new Set();

        const mergedTags = new Set();
        const targetArtistTags = targetPost.tags_categorized?.ARTIST || targetPost.tags_categorized?.artist || [];
        targetArtistTags.forEach(tag => mergedTags.add(tag));

        for (const post of clusterPosts) {
            if (!post.tags_categorized) continue;

            for (const [category, tags] of Object.entries(post.tags_categorized)) {
                if (category.toUpperCase() === 'ARTIST') continue;
                if (!Array.isArray(tags)) continue;

                for (const tag of tags) {
                    if (this.shouldIncludeTag(tag, category, post, targetPost)) {
                        mergedTags.add(tag);
                    }
                }
            }
        }

        return mergedTags;
    },

    async copyMergedTags(targetPost, clusterPosts) {
        try {
            const mergedTags = this.calculateMergedTags(targetPost, clusterPosts);
            const tagString = Array.from(mergedTags).sort().join(' ');
            await navigator.clipboard.writeText(tagString);

            this.showToast(`Copied merged tags (${mergedTags.size} tags)`, 'success', 2500);
        } catch (err) {
            console.error('[CopyMergedTags] Failed to copy tags:', err);
            this.showToast('Failed to copy merged tags to clipboard.', 'error');
        }
    },

    shouldIncludeTag(tag, category, sourcePost, targetPost) {
        return true;
    },

    getMergedTagCount(currentPost, clusterPosts) {
        return this.calculateMergedTags(currentPost, clusterPosts).size;
    },

    getMergedTagDelta(currentPost, clusterPosts) {
        if (!currentPost) return 0;

        const currentCount = Object.values(currentPost.tags_categorized || {}).flat().length;
        const mergedCount = this.getMergedTagCount(currentPost, clusterPosts);

        return mergedCount - currentCount;
    },

    setHoveredMergedTags(clusterId, targetPost, clusterPosts) {
        const targetTags = new Set(
            Object.values(targetPost.tags_categorized || {}).flat()
        );

        const mergedList = Array.from(this.calculateMergedTags(targetPost, clusterPosts) || []);

        this.hoveredMergedData = {
            clusterId: clusterId,
            targetPostId: targetPost.post_id,
            tags: mergedList.filter(tag => !targetTags.has(tag))
        };
    },

    clearHoveredMergedTags() {
        this.hoveredMergedData = { clusterId: null, targetPostId: null, tags: [] };
    }
};