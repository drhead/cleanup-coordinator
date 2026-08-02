import { TagManager } from './tags.js';

let globalActiveReconciliation = null;

export function ReconciliationManager(cluster) {
    return {
        isActive: false,
        isLoading: false,

        fetchedPostsMap: new Map(),
        graphs: [],
        activeGraphIndex: 0,

        selectedSuperiorId: null,
        selectedParentId: null,
        customParentId: '',
        lhsPostId: null,

        activeRating: null,
        originalRating: null,
        
        lhsTagsCategorized: {},
        originalLhsTagNames: new Set(),
        newTags: new Set(),
        removedLhsTags: [],
        tagInput: '',

        get currentGraph() {
            return this.graphs[this.activeGraphIndex] || null;
        },

        getLocalClusterPost(postId) {
            if (!cluster.posts || !postId) return null;
            return cluster.posts.find(p => p.post_id === postId || p.id === postId) || null;
        },

        getEffectiveLhsRating() {
            if (this.activeRating) return this.activeRating;
            return this.lhsPost?.rating || this.lhsPost?.rating_letter || null;
        },

        getPostById(postId) {
            if (!postId) return null;
            return this.fetchedPostsMap.get(postId) || this.getLocalClusterPost(postId);
        },

        // Keeps selected post on the left (index 0); unselected graph uses default order
        get orderedPostIds() {
            if (!this.currentGraph) return [];
            if (!this.lhsPostId) return this.currentGraph.postIds;
            const remaining = this.currentGraph.postIds.filter(id => id !== this.lhsPostId);
            return [this.lhsPostId, ...remaining];
        },

        get lhsPost() {
            if (!this.currentGraph || !this.lhsPostId) return null;
            return this.getPostById(this.lhsPostId);
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
            if (!this.currentGraph || this.currentGraph.type !== 'duplicate') return false;
            
            const graphPosts = this.currentGraph.postIds
                .map(id => this.getPostById(id))
                .filter(Boolean);
            
            const initialRatings = graphPosts.map(p => p.rating || p.rating_letter);
            return new Set(initialRatings).size > 1 && !this.isRatingChanged;
        },

        getSortedTags(target) {
            if (target && typeof target === 'object' && (target.post_id || target.id) && !target.GENERAL && !target.ARTIST && !target.COPYRIGHT && !target.SPECIES && !target.META) {
                const postId = target.post_id || target.id;
                const localPost = this.getLocalClusterPost(postId);
                return TagManager.getSortedTags(localPost?.tags_categorized || {});
            }
            return TagManager.getSortedTags(target || {});
        },

        getTagStyle(category) {
            return TagManager.getTagStyle(category);
        },

        isImpliedTag(tagName, target) {
            if (target && typeof target === 'object' && (target.post_id || target.id) && !target.GENERAL && !target.ARTIST && !target.COPYRIGHT && !target.SPECIES && !target.META) {
                const postId = target.post_id || target.id;
                const localPost = this.getLocalClusterPost(postId);
                return TagManager.isImpliedTag(tagName, localPost?.tags_categorized || {});
            }
            return TagManager.isImpliedTag(tagName, target || {});
        },

        getImplicationChain(postId, tagName, target) {
            const targetId = postId || (target && typeof target === 'object' && (target.post_id || target.id) ? (target.post_id || target.id) : null);
            
            let tags;
            if (targetId && targetId === this.lhsPostId) {
                // Force dynamic LHS tags state (includes added & removed tags)
                tags = this.lhsTagsCategorized;
            } else if (target && typeof target === 'object' && (target.GENERAL || target.ARTIST || target.COPYRIGHT || target.SPECIES || target.META)) {
                tags = target;
            } else {
                const localPost = targetId ? this.getLocalClusterPost(targetId) : null;
                tags = localPost?.tags_categorized || {};
            }

            return TagManager.getImplicationChain(targetId, tagName, tags);
        },

        getPostImageUrl(post) {
            if (!post) return '';
            return post.file?.url || post.sample?.url || post.preview?.url || 
                   post.file_url || post.sample_url || post.preview_url || '';
        },

        getPostDimensions(post) {
            if (!post) return 'N/A';
            const w = post.file?.width || post.image_width || post.width;
            const h = post.file?.height || post.image_height || post.height;
            return (w && h) ? `${w}×${h}` : 'N/A';
        },

        isTagOnLhs(tagName) {
            for (const catList of Object.values(this.lhsTagsCategorized)) {
                if (Array.isArray(catList) && catList.includes(tagName)) return true;
            }
            return false;
        },

        getAllImpliedTags(initialTag) {
            const result = new Set();
            const queue = [initialTag];

            while (queue.length > 0) {
                const current = queue.shift();
                const directImplied = TagManager.implications[current]?.implies || [];
                
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
                if (!TagManager.hasImplications) {
                    await TagManager.initTags();
                }

                if (cluster._fetchedPosts && cluster._fetchedPosts.size > 0) {
                    this.fetchedPostsMap = new Map(cluster._fetchedPosts);
                } else {
                    await this.fetchClusterPosts();
                }

                this.buildGraphsFromCluster();

                if (this.graphs.length === 0) {
                    throw new Error('No classified graphs found to reconcile.');
                }

                this.activeGraphIndex = 0;
                this.setupCurrentGraph();
                this.isActive = true;
            } catch (err) {
                console.error('Reconciliation error:', err);
                this.closeReconciliation();
            } finally {
                this.isLoading = false;
            }
        },

        async fetchClusterPosts() {
            if (!cluster.posts || cluster.posts.length === 0) return;

            const postIds = cluster.posts.map(p => p.post_id).join(',');
            const appAuthor = import.meta.env.VITE_E621_APP_AUTHOR || 'anonymous';
            const headers = {
                'User-Agent': `E621CleanupCoordinator/1.0 (by ${appAuthor})`
            };

            if (this.e621User) {
                const authString = btoa(`${this.e621User.username}:${this.e621User.apiKey}`);
                headers['Authorization'] = `Basic ${authString}`;
            }

            const res = await fetch(`https://e621.net/posts.json?tags=id:${postIds}`, { headers });
            if (!res.ok) throw new Error(`e621 API returned HTTP ${res.status}`);

            const data = await res.json();
            this.fetchedPostsMap.clear();
            (data.posts || []).forEach(p => this.fetchedPostsMap.set(p.id, p));
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
                postIds: [pair.a.id || pair.a.post_id, pair.b.id || pair.b.post_id]
            }));
        },

        selectGraph(idx) {
            if (idx < 0 || idx >= this.graphs.length) return;
            this.activeGraphIndex = idx;
            this.setupCurrentGraph();
        },

        setupCurrentGraph() {
            const graph = this.currentGraph;
            if (!graph) return;

            this.selectedSuperiorId = null;
            this.selectedParentId = null;
            this.customParentId = '';
            this.lhsPostId = null;
            this.syncLhsState();
        },

        selectSuperior(postId) {
            if (!postId) return;
            this.selectedSuperiorId = postId;
            this.lhsPostId = postId;
            this.syncLhsState();
        },

        setLhsPost(postId) {
            this.selectSuperior(postId);
        },

        syncLhsState() {
            if (!this.lhsPostId) {
                this.activeRating = null;
                this.originalRating = null;
                this.lhsTagsCategorized = {};
                this.originalLhsTagNames = new Set();
                this.newTags = new Set();
                this.removedLhsTags = [];
                return;
            }

            const localPost = this.getLocalClusterPost(this.lhsPostId);
            const rawPost = this.lhsPost;

            if (rawPost) {
                this.activeRating = null;
                this.originalRating = null;
            }

            const baseDict = localPost?.tags_categorized || {};
            this.lhsTagsCategorized = {};
            this.originalLhsTagNames = new Set();

            for (const [cat, tagList] of Object.entries(baseDict)) {
                const catKey = cat.toUpperCase();
                const list = Array.isArray(tagList) ? [...tagList] : [];
                this.lhsTagsCategorized[catKey] = list;
                list.forEach(t => this.originalLhsTagNames.add(t));
            }

            this.newTags = new Set();
            this.removedLhsTags = [];
        },

        setRating(r) {
            this.activeRating = r;
        },

        addTagWithImplications(tagName, category = 'GENERAL') {
            const catKey = category.toUpperCase();
            const fullImpliedChain = this.getAllImpliedTags(tagName);
            const tagsToAdd = [tagName, ...fullImpliedChain];

            tagsToAdd.forEach(t => {
                const targetCat = (TagManager.implications[t]?.category || catKey).toUpperCase();
                if (!this.lhsTagsCategorized[targetCat]) {
                    this.lhsTagsCategorized[targetCat] = [];
                }
                
                if (!this.lhsTagsCategorized[targetCat].includes(t)) {
                    this.lhsTagsCategorized[targetCat].push(t);
                    
                    if (!this.originalLhsTagNames.has(t)) {
                        this.newTags.add(t);
                    }
                }

                const remIdx = this.removedLhsTags.findIndex(rt => rt.name === t);
                if (remIdx !== -1) {
                    this.removedLhsTags.splice(remIdx, 1);
                }
            });
        },

        copyTagToLhsWithImplications(tagObj) {
            this.addTagWithImplications(tagObj.name, tagObj.category);
        },

        removeTagWithImplications(tagObj) {
            const tagName = tagObj.name;
            const chain = TagManager.getImplicationChain(this.lhsPostId, tagName, this.lhsTagsCategorized);

            const toRemove = new Set([tagName]);
            if (chain) {
                chain.directImplicators.forEach(t => toRemove.add(t));
                chain.indirectImplicators.forEach(t => toRemove.add(t));
            }

            for (const [cat, tagList] of Object.entries(this.lhsTagsCategorized)) {
                this.lhsTagsCategorized[cat] = tagList.filter(t => {
                    if (toRemove.has(t)) {
                        if (this.originalLhsTagNames.has(t) && !this.removedLhsTags.some(rt => rt.name === t)) {
                            this.removedLhsTags.push({ name: t, category: cat });
                        }
                        this.newTags.delete(t);
                        return false;
                    }
                    return true;
                });
            }
        },

        restoreTag(tagObj) {
            this.addTagWithImplications(tagObj.name, tagObj.category);
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

if (window.Alpine) {
    window.Alpine.data('ReconciliationManager', ReconciliationManager);
} else {
    document.addEventListener('alpine:init', () => {
        window.Alpine.data('ReconciliationManager', ReconciliationManager);
    });
}