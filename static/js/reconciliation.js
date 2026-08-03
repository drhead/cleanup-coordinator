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
        
        lhsTags: [],
        originalLhsTagNames: new Set(),
        newTags: new Set(),
        removedLhsTags: [],
        tagInput: '',

        get currentGraph() {
            return this.graphs[this.activeGraphIndex] || null;
        },

        getLocalClusterPost(postId) {
            if (!cluster?.posts || !postId) return null;
            const post = cluster.posts.find(p => p.post_id === postId || p.id === postId);
            if (!post) return null;

            const fileUrl = this.fetchedPostsMap.get(postId);
            if (fileUrl) {
                return {
                    ...post,
                    file_url: fileUrl,
                    file: { ...(post.file || {}), url: fileUrl }
                };
            }
            return post;
        },

        getEffectiveLhsRating() {
            return this.activeRating || this.lhsPost?.rating || this.lhsPost?.rating_letter || null;
        },

        getPostById(postId) {
            return postId ? this.getLocalClusterPost(postId) : null;
        },

        // Keeps selected post on the left (index 0); unselected graph uses default order
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
            
            const initialRatings = graphPosts.map(p => p.rating || p.rating_letter);
            return new Set(initialRatings).size > 1 && !this.isRatingChanged;
        },

        getSortedTags(target) {
            if (!target) return TagManager.getSortedTags([]);

            if (target === this.lhsTags || Array.isArray(target)) {
                return TagManager.getSortedTags(target);
            }

            if (target.GENERAL || target.ARTIST || target.COPYRIGHT || target.SPECIES || target.META) {
                return TagManager.getSortedTags(target);
            }

            const postId = target.post_id || target.id;
            const localPost = this.getLocalClusterPost(postId);
            return TagManager.getSortedTags(localPost?.tags || []);
        },

        getTagStyle(category) {
            return TagManager.getTagStyle(category);
        },

        isImpliedTag(tagName, target) {
            if (!target) return TagManager.isImpliedTag(tagName, []);

            if (target === this.lhsTags || Array.isArray(target)) {
                return TagManager.isImpliedTag(tagName, target);
            }

            if (target.GENERAL || target.ARTIST || target.COPYRIGHT || target.SPECIES || target.META) {
                return TagManager.isImpliedTag(tagName, target);
            }

            const postId = target.post_id || target.id;
            const localPost = this.getLocalClusterPost(postId);
            return TagManager.isImpliedTag(tagName, localPost?.tags || []);
        },

        getImplicationChain(postId, tagName, target) {
            const targetId = postId || target?.post_id || target?.id || null;
            
            let tags = [];
            if (targetId && targetId === this.lhsPostId) {
                tags = this.lhsTags;
            } else if (Array.isArray(target)) {
                tags = target;
            } else if (targetId) {
                const localPost = this.getLocalClusterPost(targetId);
                tags = localPost?.tags || [];
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
            return this.lhsTags.includes(tagName);
        },

        getAllImpliedTags(initialTag) {
            const result = new Set();
            const queue = [initialTag];

            while (queue.length > 0) {
                const current = queue.shift();
                const directImplied = TagManager.implications?.[current]?.implies || [];
                
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

                await this.fetchClusterPosts();
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

            const postIds = cluster.posts.map(p => p.post_id || p.id).join(',');
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
            (data.posts || []).forEach(p => {
                const fileUrl = p.file?.url || p.file_url || '';
                if (fileUrl) {
                    this.fetchedPostsMap.set(p.id, fileUrl);
                }
            });
        },

        buildGraphsFromCluster() {
            if (!cluster.pairs || cluster.pairs.length === 0) {
                this.graphs = [{
                    id: 1,
                    type: cluster.default_type || 'duplicate',
                    postIds: cluster.posts.map(p => p.post_id || p.id)
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
            if (!this.currentGraph) return;

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
            const rawTags = post?.tags || [];

            this.lhsTags = [...rawTags];
            this.originalLhsTagNames = new Set(rawTags);
        },

        setRating(r) {
            this.activeRating = r;
        },

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

        copyTagToLhsWithImplications(tagObj) {
            this.addTagWithImplications(tagObj.name, tagObj.category);
        },

        removeTagWithImplications(tagObj) {
            const tagName = typeof tagObj === 'string' ? tagObj : tagObj.name;
            const chain = TagManager.getImplicationChain(this.lhsPostId, tagName, this.lhsTags);

            const toRemove = new Set([tagName]);
            if (chain) {
                chain.directImplicators?.forEach(t => toRemove.add(t));
                chain.indirectImplicators?.forEach(t => toRemove.add(t));
            }

            this.lhsTags = this.lhsTags.filter(t => {
                if (toRemove.has(t)) {
                    if (this.originalLhsTagNames.has(t) && !this.removedLhsTags.includes(t)) {
                        this.removedLhsTags.push(t);
                    }
                    this.newTags.delete(t);
                    return false;
                }
                return true;
            });
        },

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

const registerAlpineData = () => {
    if (window.Alpine) {
        window.Alpine.data('ReconciliationManager', ReconciliationManager);
    }
};

if (window.Alpine) {
    registerAlpineData();
} else {
    document.addEventListener('alpine:init', registerAlpineData);
}