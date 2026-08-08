// @ts-check

import { showToast } from './toasts.js';
import { openImageModal } from './image_modal.js';

/**
 * @typedef {Object} RootData
 * @property {string} activeView
 */

/** @type {any} */
let globalActiveComparison = null;

/**
 * Alpine component data factory for pairwise image comparison.
 * @param {ResolutionManagerComponent} resMgr
 */
export function ComparisonManager(resMgr) {
    return {
        isActive: false,
        isLoading: false,
        activePairIndex: 0,
        
        /** @type {ResolutionManagerComponent} */
        resolutionManager: resMgr,

        /** @type {Map<number, string>} */
        fetchedPostsMap: new Map(),

        /** @type {'side-by-side' | 'swipe' | 'diff' | 'blink'} */
        mode: 'side-by-side',

        // Loupe Controls & State
        enableLoupe: true,
        zoomLevel: 2,
        isHovering: false,
        relX: 0.5,
        relY: 0.5,
        loupeSize: 180,
        containerWidth: 0,
        containerHeight: 0,

        // Single View States
        swipePos: 50,
        blinkShowB: false,
        /** @type {ReturnType<typeof setInterval> | null} */
        blinkInterval: null,
        blinkSpeed: 350,

        /** @type {{a: ClusterPost, b: ClusterPost} | null} */
        currentPair: null,

        /**
         * @param {'side-by-side' | 'swipe' | 'diff' | 'blink'} newMode
         */
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
            this.isLoading = false;

            if (globalActiveComparison === this) {
                globalActiveComparison = null;
            }
        },

        /**
         * @param {MouseEvent} e
         * @param {HTMLElement | null} containerEl
         */
        handleSwipeMove(e, containerEl) {
            if (!containerEl) return;
            const rect = containerEl.getBoundingClientRect();
            this.containerWidth = rect.width;
            this.containerHeight = rect.height;
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            this.swipePos = Math.max(0, Math.min(100, x));
        },

        /**
         * @param {MouseEvent} e
         * @param {HTMLElement | null} imgEl
         */
        handleMouseMove(e, imgEl) {
            if (!imgEl) return;
            const rect = imgEl.getBoundingClientRect();
            this.containerWidth = rect.width;
            this.containerHeight = rect.height;

            const x = (e.clientX - rect.left) / rect.width;
            const y = (e.clientY - rect.top) / rect.height;

            this.relX = Math.max(0, Math.min(1, x));
            this.relY = Math.max(0, Math.min(1, y));
            this.isHovering = true;
        },

        handleMouseLeave() {
            this.isHovering = false;
        },

        /**
         * Standard Single Post Loupe Style
         * @param {ClusterPost | null} post
         * @returns {Record<string, string>}
         */
        getLoupeStyle(post) {
            if (!this.enableLoupe || !post || !post.fileUrl) return { display: 'none' };

            const nativeW = post.image_width || 1000;
            const nativeH = post.image_height || 1000; 
            const dpr = window.devicePixelRatio || 1;

            const bgW = nativeW * this.zoomLevel * dpr;
            const bgH = nativeH * this.zoomLevel * dpr;

            const bgLeft = (this.loupeSize / 2) - (this.relX * bgW);
            const bgTop = (this.loupeSize / 2) - (this.relY * bgH);

            return {
                width: `${this.loupeSize}px`,
                height: `${this.loupeSize}px`,
                backgroundImage: `url(${post.fileUrl})`,
                backgroundSize: `${bgW}px ${bgH}px`,
                backgroundPosition: `${bgLeft}px ${bgTop}px`,
                imageRendering: this.zoomLevel > 1 ? 'pixelated' : 'auto'
            };
        },

        /**
         * FIXED Diff Loupe Style: Black background prevents color inversion!
         * @param {ClusterPost | null} postA
         * @param {ClusterPost | null} postB
         * @returns {Record<string, string>}
         */
        getDiffLoupeStyle(postA, postB) {
            if (!this.enableLoupe || !postA?.fileUrl || !postB?.fileUrl) return { display: 'none' };

            const nativeW = Math.max(postA.image_width || 1000, postB.image_width || 1000);
            const nativeH = Math.max(postA.image_height || 1000, postB.image_height || 1000);
            const dpr = window.devicePixelRatio || 1;

            const bgW = nativeW * this.zoomLevel * dpr;
            const bgH = nativeH * this.zoomLevel * dpr;

            const bgLeft = (this.loupeSize / 2) - (this.relX * bgW);
            const bgTop = (this.loupeSize / 2) - (this.relY * bgH);

            return {
                width: `${this.loupeSize}px`,
                height: `${this.loupeSize}px`,
                backgroundImage: `url(${postB.fileUrl}), url(${postA.fileUrl})`,
                backgroundBlendMode: 'difference',
                backgroundColor: '#000000',
                backgroundSize: `${bgW}px ${bgH}px, ${bgW}px ${bgH}px`,
                backgroundPosition: `${bgLeft}px ${bgTop}px, ${bgLeft}px ${bgTop}px`,
                imageRendering: this.zoomLevel > 1 ? 'pixelated' : 'auto'
            };
        },

        /**
         * Calculates dynamic clip path for Image B layer inside the Swipe Loupe
         * @returns {Record<string, string>}
         */
        getSwipeLoupeClipStyle() {
            if (!this.containerWidth) return {};
            const swipeX = (this.swipePos / 100) * this.containerWidth;
            const cursorX = this.relX * this.containerWidth;
            const diffX = swipeX - cursorX;
            const loupeLineX = (this.loupeSize / 2) + (diffX * this.zoomLevel);

            const rightClip = Math.max(0, Math.min(this.loupeSize, this.loupeSize - loupeLineX));
            return {
                clipPath: `inset(0 ${rightClip}px 0 0)`
            };
        },

        /**
         * Opens current mode in expanded modal
         * @param {ClusterPost | null} [singlePost=null]
         */
        openModal(singlePost = null) {
            if (singlePost) {
                openImageModal({
                    src: /** @type {string} */ (singlePost.fileUrl),
                    mode: 'single',
                    title: `Post #${singlePost.post_id}`,
                    dimensions: `${singlePost.image_width || '?'}×${singlePost.image_height || '?'}`
                });
                return;
            }

            // TODO: Redesign during pair resolution refactor
            if (!this.currentPair?.a?.fileUrl || !this.currentPair?.b?.fileUrl) return;

            openImageModal({
                src: this.currentPair.a.fileUrl,
                srcB: this.currentPair.b.fileUrl,
                mode: /** @type {'swipe' | 'diff' | 'blink'} */ (this.mode),
                title: `#${this.currentPair.a.post_id}`,
                titleB: `#${this.currentPair.b.post_id}`,
                dimensions: `${this.currentPair.a.image_width || '?'}×${this.currentPair.a.image_height || '?'}`,
                blinkSpeed: this.blinkSpeed
            });
        },

        /**
         * Updates currentPair from post IDs.
         * @private
         * @param {number} idA
         * @param {number} idB
         */
        setPairFromIds(idA, idB) {
            const resPostA = this.resolutionManager.getPost(idA);
            const resPostB = this.resolutionManager.getPost(idB);

            if (!resPostA || !resPostB) {
                throw new Error(`Failed to retrieve post objects for pair [${idA}, ${idB}]`);
            }

            this.currentPair = {
                a: resPostA.original,
                b: resPostB.original
            };
        },

        /**
         * Initiates comparison session.
         * @param {RootData | null} [rootData]
         */
        async startComparison(rootData) {
            await this.resolutionManager.initializePosts()
            if (!this.resolutionManager.cluster || !Array.isArray(this.resolutionManager.cluster.posts) || this.resolutionManager.cluster.posts.length < 2) {
                showToast('Cluster must have at least 2 posts to compare.', 'error');
                return;
            }

            if (globalActiveComparison && globalActiveComparison !== this) {
                globalActiveComparison.closeComparison();
            }
            globalActiveComparison = this;

            this.isLoading = true;

            try {
                // 1. Mark all posts missing a fileUrl as 'unknown' in graph state
                const validPosts = [];
                for (const post of resMgr.cluster.posts) {
                    if (!post.fileUrl) {
                        this.resolutionManager.markUnknown(post.post_id);
                    } else {
                        validPosts.push(post);
                    }
                }

                // 2. Validate posts with images
                if (validPosts.length === 0) {
                    throw new Error('No posts in this cluster have valid image URLs.');
                }

                if (validPosts.length === 1) {
                    showToast('Only one post with image available. Skipping comparison step.', 'info');
                    this.proceedToReconciliation(rootData);
                    return;
                }

                // 3. Obtain initial pair
                const pairIds = this.resolutionManager.getNextPair();
                if (!pairIds) {
                    showToast('No pairs require comparison. Proceeding to reconciliation.', 'info');
                    this.proceedToReconciliation(rootData);
                    return;
                }

                this.setPairFromIds(pairIds[0], pairIds[1]);
                this.isActive = true;

            } catch (err) {
                console.error('[ComparisonManager] Initiation error:', err);
                const message = err instanceof Error ? err.message : 'Unknown error';
                showToast(`Comparison error: ${message}`, 'error');
                this.closeComparison();
            } finally {
                this.isLoading = false;
            }
        },

        /**
         * @param {RootData | null} [rootData]
         */
        proceedToReconciliation(rootData) {
            this.closeComparison();
            if (rootData) {
                rootData.activeView = 'reconcile';
            }
        },

        /**
         * Applies chosen relationship type to current pair and advances.
         * @param {'duplicate' | 'variant' | 'unrelated'} type
         * @param {RootData | null} [rootData]
         * @param {number | null} [superiorId]
         */
        setRelationship(type, rootData, superiorId = null) {
            if (!this.currentPair) return;

            const idA = this.currentPair.a.post_id;
            const idB = this.currentPair.b.post_id;

            // 1. Record relationship and head in ResolutionManager graph
            this.resolutionManager.addGraphEdge(type, idA, idB, superiorId);

            // 2. Obtain next pair needed to map relationships
            const nextPairIds = this.resolutionManager.getNextPair();

            if (nextPairIds) {
                this.setPairFromIds(nextPairIds[0], nextPairIds[1]);
            } else {
                showToast('All image relationships resolved!', 'success');
                this.proceedToReconciliation(rootData);
            }
        }
    };
}