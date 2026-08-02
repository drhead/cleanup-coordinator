// Global tracker to ensure only one cluster comparison is open at a time
let globalActiveComparison = null;

export function ComparisonManager(cluster) {
    return {
        isActive: false,
        isLoading: false,
        activePairIndex: 0,
        pairs: [],

        // Modes: 'side-by-side', 'swipe', 'diff', 'blink'
        mode: 'side-by-side',

        // Loupe Zoom State
        zoomLevel: 2,
        isHovering: false,
        relX: 0.5,
        relY: 0.5,
        loupeSize: 180,

        // Single View States
        swipePos: 50,
        blinkShowB: false,
        blinkInterval: null,
        blinkSpeed: 350,

        get currentPair() {
            return this.pairs[this.activePairIndex] || null;
        },

        setMode(newMode) {
            this.mode = newMode;
            if (newMode === 'blink') {
                this.startBlink();
            } else {
                this.stopBlink();
            }
        },

        startBlink() {
            this.stopBlink();
            this.blinkShowB = false;
            this.blinkInterval = setInterval(() => {
                this.blinkShowB = !this.blinkShowB;
            }, this.blinkSpeed);
        },

        stopBlink() {
            if (this.blinkInterval) {
                clearInterval(this.blinkInterval);
                this.blinkInterval = null;
            }
        },

        closeComparison() {
            this.stopBlink();
            this.isActive = false;
        },

        handleSwipeMove(e, containerEl) {
            if (!containerEl) return;
            const rect = containerEl.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            this.swipePos = Math.max(0, Math.min(100, x));
        },

        handleMouseMove(e, imgEl) {
            if (!imgEl) return;
            const rect = imgEl.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            const y = (e.clientY - rect.top) / rect.height;

            this.relX = Math.max(0, Math.min(1, x));
            this.relY = Math.max(0, Math.min(1, y));
            this.isHovering = true;
        },

        handleMouseLeave() {
            this.isHovering = false;
        },

        getLoupeStyle(post) {
            if (!post || !post.file) return {};

            const nativeW = post.file.width;
            const nativeH = post.file.height;
            const dpr = window.devicePixelRatio || 1;

            const bgW = nativeW * this.zoomLevel * dpr;
            const bgH = nativeH * this.zoomLevel * dpr;

            const bgLeft = (this.loupeSize / 2) - (this.relX * bgW);
            const bgTop = (this.loupeSize / 2) - (this.relY * bgH);

            return {
                width: `${this.loupeSize}px`,
                height: `${this.loupeSize}px`,
                backgroundImage: `url(${post.file.url || post.sample.url})`,
                backgroundSize: `${bgW}px ${bgH}px`,
                backgroundPosition: `${bgLeft}px ${bgTop}px`,
                imageRendering: this.zoomLevel > 1 ? 'pixelated' : 'auto'
            };
        },

        async startComparison() {
            if (!cluster.posts || cluster.posts.length < 2) {
                if (this.showToast) this.showToast('Cluster must have at least 2 posts to compare.', 'error');
                return;
            }

            // Close any existing open comparison session elsewhere
            if (globalActiveComparison && globalActiveComparison !== this) {
                globalActiveComparison.closeComparison();
            }
            globalActiveComparison = this;

            this.isLoading = true;

            try {
                // 1. Extract IDs and construct multi-post query
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
                const retrievedPosts = data.posts || [];

                // 2. Validate retrieved count
                if (retrievedPosts.length <= 1) {
                    throw new Error(`Only ${retrievedPosts.length} post(s) could be retrieved from e621.`);
                }

                // Map fetched API objects back to cluster order
                const fetchedMap = new Map(retrievedPosts.map(p => [p.id, p]));
                const availableClusterPosts = cluster.posts
                    .map(p => fetchedMap.get(p.post_id))
                    .filter(p => p && (p.file?.url || p.sample?.url || p.preview?.url));

                if (availableClusterPosts.length <= 1) {
                    throw new Error('Failed to load metadata for comparison.');
                }

                // 3. Construct pairwise edges
                this.pairs = [];
                for (let i = 0; i < availableClusterPosts.length - 1; i++) {
                    this.pairs.push({
                        a: availableClusterPosts[i],
                        b: availableClusterPosts[i + 1],
                        relationship: null
                    });
                }

                this.activePairIndex = 0;
                this.isActive = true;

            } catch (err) {
                console.error('Comparison initiation error:', err);
                if (this.showToast) {
                    this.showToast(`Comparison error: ${err.message}`, 'error');
                }
                this.closeComparison();
            } finally {
                this.isLoading = false;
            }
        },

        closeComparison() {
            this.isActive = false;
            this.isLoading = false;
            this.pairs = [];

            if (globalActiveComparison === this) {
                globalActiveComparison = null;
            }
        },

        setRelationship(type) {
            if (!this.currentPair) return;
            this.currentPair.relationship = type;

            if (this.activePairIndex < this.pairs.length - 1) {
                this.activePairIndex++;
            }
        }
    };
}

if (window.Alpine) {
    window.Alpine.data('ComparisonManager', ComparisonManager);
} else {
    document.addEventListener('alpine:init', () => {
        window.Alpine.data('ComparisonManager', ComparisonManager);
    });
}