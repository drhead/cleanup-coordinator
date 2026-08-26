// @ts-check

import { showToast } from './toasts.js';
import { openImageModal } from './image_modal.js';
import { WarningsManager } from './warnings.js';
import { getE621User } from './auth.js';

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

        warnings: new WarningsManager(),

        initWarnings() {
            this.warnings.registerRules([
                {
                    id: 'login-required-info',
                    type: 'info',
                    icon: '🧪',
                    title: 'Testing Mode',
                    message: "You can test the interface (and please provide feedback!), but you'll have to log in to apply changes.",
                    check: () => !getE621User()
                }
            ]);
        },

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
        /** @type {ClusterPost | null} */
        hoveredPost: null,
        cursorX: 0,
        cursorY: 0,
        relX: 0.5,
        relY: 0.5,
        loupeSize: 180,
        containerWidth: 0,
        containerHeight: 0,

        // Single View States
        swipePos: 50,
        diffMultiplier: 1.0,
        blinkShowB: false,
        /** @type {ReturnType<typeof setInterval> | null} */
        blinkInterval: null,
        blinkRate: 3, // in Hz (1 - 6 Hz)
        blinkSpeed: 333,

        /**
         * Checks if the aspect ratio between pair items differs by more than 5%.
         * @returns {boolean}
         */
        hasMismatchedAspectRatio() {
            if (!this.currentPair?.a || !this.currentPair?.b) return false;
            const { imageWidth: wA, imageHeight: hA } = this.currentPair.a;
            const { imageWidth: wB, imageHeight: hB } = this.currentPair.b;
            if (!wA || !hA || !wB || !hB) return false;
            const arA = wA / hA;
            const arB = wB / hB;
            return Math.abs(arA - arB) / Math.min(arA, arB) > 0.05;
        },

        /**
         * Gets sorted artist tags for a post item.
         * @param {ClusterPost | null} item
         * @returns {string[]}
         */
        getArtistTags(item) {
            if (!item) return [];
            /** @type {import('./tags.js').TagManager} */
            const tagStore = /** @type {import('./tags.js').TagManager} */ (Alpine.store('tags'));
            if (!tagStore) return [];
            return tagStore.getArtistTags(item);
        },

        /**
         * Checks if the artist tags between currentPair.a and currentPair.b differ.
         * @returns {boolean}
         */
        hasArtistMismatch() {
            if (!this.currentPair?.a || !this.currentPair?.b) return false;
            const artistsA = this.getArtistTags(this.currentPair.a);
            const artistsB = this.getArtistTags(this.currentPair.b);
            if (artistsA.length !== artistsB.length) return true;
            const setB = new Set(artistsB);
            return artistsA.some(tag => !setB.has(tag));
        },

        /**
         * Gets the number of collapsibles (description and/or sources) for a post item.
         * @param {ClusterPost | null} item
         * @returns {number}
         */
        getItemCollapsibleCount(item) {
            if (!item) return 0;
            let count = 0;
            if (item.description && item.description.trim().length > 0) count++;
            if (item.sources && item.sources.length > 0) count++;
            return count;
        },

        /**
         * Gets max collapsible count between pair items in SBS mode.
         * @returns {number}
         */
        getMaxPairCollapsibleCount() {
            if (!this.currentPair) return 0;
            const countA = this.getItemCollapsibleCount(this.currentPair.a);
            const countB = this.getItemCollapsibleCount(this.currentPair.b);
            return Math.max(countA, countB);
        },

        /**
         * Gets dynamic height style for an SBS card item so any whitespace from differing
         * collapsible counts is cleanly outside the card rather than inside.
         * @param {ClusterPost | null} item
         * @returns {string} CSS height value, e.g. "100%" or "calc(100% - 26px)"
         */
        getSbsCardHeight(item) {
            if (!this.currentPair || !item) return '100%';
            const maxCount = this.getMaxPairCollapsibleCount();
            const ownCount = this.getItemCollapsibleCount(item);
            const diff = maxCount - ownCount;
            if (diff <= 0) return '100%';
            return `calc(100% - ${diff * 26}px)`;
        },

        /**
         * Gets height style for Card Image Wrapper scaled down by card's own collapsible count,
         * guaranteeing both SBS images have the exact same relative viewport size and vertical alignment.
         * @param {ClusterPost | null} item
         * @returns {string} CSS height value, e.g. "100%", "calc(100% - 26px)", or "calc(100% - 52px)"
         */
        getSbsImageWrapperHeight(item) {
            if (!item) return '100%';
            const ownCount = this.getItemCollapsibleCount(item);
            if (ownCount <= 0) return '100%';
            return `calc(100% - ${ownCount * 26}px)`;
        },

        /**
         * @param {'side-by-side' | 'swipe' | 'diff' | 'blink'} newMode
         */
        setMode(newMode) {
            if (newMode !== 'side-by-side' && this.hasMismatchedAspectRatio()) {
                return;
            }
            this.isHovering = false;
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
            const intervalMs = Math.max(50, Math.round(1000 / (this.blinkRate || 3)));
            this.blinkInterval = setInterval(() => {
                this.blinkShowB = !this.blinkShowB;
            }, intervalMs);
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
            this.isHovering = false;

            if (this.resolutionManager && this.resolutionManager.activeComparison === this) {
                this.resolutionManager.activeComparison = null;
            }

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
         * @param {ClusterPost | null} [post=null]
         */
        handleMouseMove(e, imgEl, post = null) {
            if (!imgEl) return;
            const rect = imgEl.getBoundingClientRect();
            this.containerWidth = rect.width;
            this.containerHeight = rect.height;

            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            this.cursorX = mouseX;
            this.cursorY = mouseY;

            const targetPost = post || this.currentPair?.a || null;
            const nw = targetPost?.imageWidth || 0;
            const nh = targetPost?.imageHeight || 0;

            if (nw > 0 && nh > 0 && rect.width > 0 && rect.height > 0) {
                const scale = Math.min(rect.width / nw, rect.height / nh);
                const rw = nw * scale;
                const rh = nh * scale;
                const padX = (rect.width - rw) / 2;
                const padY = (rect.height - rh) / 2;

                const x = (mouseX - padX) / rw;
                const y = (mouseY - padY) / rh;

                if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
                    this.relX = x;
                    this.relY = y;
                    this.hoveredPost = targetPost;
                    this.isHovering = true;
                } else {
                    this.isHovering = false;
                }
            } else {
                const x = mouseX / rect.width;
                const y = mouseY / rect.height;
                if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
                    this.relX = x;
                    this.relY = y;
                    this.hoveredPost = targetPost;
                    this.isHovering = true;
                } else {
                    this.isHovering = false;
                }
            }
        },

        handleMouseLeave() {
            this.isHovering = false;
            this.hoveredPost = null;
        },

        /**
         * Computes reference base dimensions for native 1:1 scaling.
         * In SBS mode, uses the active hovered post's native resolution so both sides scale to it.
         * In overlay modes (Swipe, Diff, Blink), uses the smaller image's native resolution so layers align.
         * @param {ClusterPost | null} [post=null]
         * @returns {{ w: number, h: number }}
         */
        getBaseDimensions(post = null) {
            const pairA = this.currentPair?.a;
            const pairB = this.currentPair?.b;

            if (this.mode === 'side-by-side') {
                if (this.hasMismatchedAspectRatio()) {
                    if (post?.imageWidth && post?.imageHeight) {
                        return { w: post.imageWidth, h: post.imageHeight };
                    }
                } else {
                    const refPost = this.hoveredPost || post || pairA || pairB;
                    if (refPost?.imageWidth && refPost?.imageHeight) {
                        return { w: refPost.imageWidth, h: refPost.imageHeight };
                    }
                }
            } else if (pairA && pairB && !this.hasMismatchedAspectRatio()) {
                const wA = pairA.imageWidth || 0;
                const hA = pairA.imageHeight || 0;
                const wB = pairB.imageWidth || 0;
                const hB = pairB.imageHeight || 0;
                const areaA = (wA && hA) ? (wA * hA) : 0;
                const areaB = (wB && hB) ? (wB * hB) : 0;

                if (areaA > 0 && areaB > 0) {
                    return areaB < areaA ? { w: wB, h: hB } : { w: wA, h: hA };
                }
                if (wA && hA) return { w: wA, h: hA };
                if (wB && hB) return { w: wB, h: hB };
            }

            if (post?.imageWidth && post?.imageHeight) {
                return { w: post.imageWidth, h: post.imageHeight };
            }

            return {
                w: post?.imageWidth || this.containerWidth || 1000,
                h: post?.imageHeight || this.containerHeight || 1000
            };
        },

        /**
         * Standard Single Post Loupe Style
         * @param {ClusterPost | null} post
         * @returns {Record<string, string>}
         */
        getLoupeStyle(post) {
            if (!this.enableLoupe || !post || !post.fileUrl) return { display: 'none' };

            const { w: baseW, h: baseH } = this.getBaseDimensions(post);
            const bgW = baseW * this.zoomLevel;
            const bgH = baseH * this.zoomLevel;

            const bgLeft = (this.loupeSize / 2) - (this.relX * bgW);
            const bgTop = (this.loupeSize / 2) - (this.relY * bgH);

            return {
                width: `${this.loupeSize}px`,
                height: `${this.loupeSize}px`,
                backgroundImage: `url(${post.fileUrl})`,
                backgroundColor: '#1f2937',
                backgroundSize: `${bgW}px ${bgH}px`,
                backgroundPosition: `${bgLeft}px ${bgTop}px`,
                imageRendering: (bgW > (post.imageWidth || 0) || this.zoomLevel > 1) ? 'pixelated' : 'auto'
            };
        },

        /**
         * Diff Loupe Style: Black background prevents color inversion
         * @param {ClusterPost | null} postA
         * @param {ClusterPost | null} postB
         * @returns {Record<string, string>}
         */
        getDiffLoupeStyle(postA, postB) {
            if (!this.enableLoupe || !postA?.fileUrl || !postB?.fileUrl) return { display: 'none' };

            const { w: baseW, h: baseH } = this.getBaseDimensions(postA);
            const bgW = baseW * this.zoomLevel;
            const bgH = baseH * this.zoomLevel;

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
                imageRendering: this.zoomLevel > 1 ? 'pixelated' : 'auto',
                filter: `brightness(${this.diffMultiplier})`
            };
        },

        /**
         * Calculates dynamic clip path for Image B layer inside the Swipe Loupe
         * @returns {Record<string, string>}
         */
        getSwipeLoupeClipStyle() {
            const { w: baseW } = this.getBaseDimensions(this.currentPair?.a || null);
            const bgW = baseW * this.zoomLevel;

            const targetPost = this.currentPair?.a || null;
            const nw = targetPost?.imageWidth || 0;
            const nh = targetPost?.imageHeight || 0;
            let imageSwipeX = this.swipePos / 100;

            if (nw > 0 && nh > 0 && this.containerWidth > 0 && this.containerHeight > 0) {
                const scale = Math.min(this.containerWidth / nw, this.containerHeight / nh);
                const rw = nw * scale;
                const padX = (this.containerWidth - rw) / 2;
                const swipePx = (this.swipePos / 100) * this.containerWidth;
                imageSwipeX = (swipePx - padX) / rw;
            }

            const loupeLineX = (this.loupeSize / 2) + (imageSwipeX - this.relX) * bgW;
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
                    title: `Post #${singlePost.postId}`,
                    dimensions: `${singlePost.imageWidth || '?'}×${singlePost.imageHeight || '?'}`
                });
                return;
            }

            // TODO: Redesign during pair resolution refactor
            if (!this.currentPair?.a?.fileUrl || !this.currentPair?.b?.fileUrl) return;

            openImageModal({
                src: this.currentPair.a.fileUrl,
                srcB: this.currentPair.b.fileUrl,
                mode: /** @type {'swipe' | 'diff' | 'blink'} */ (this.mode),
                title: `#${this.currentPair.a.postId}`,
                titleB: `#${this.currentPair.b.postId}`,
                dimensions: `${this.currentPair.a.imageWidth || '?'}×${this.currentPair.a.imageHeight || '?'}`,
                blinkSpeed: Math.max(50, Math.round(1000 / (this.blinkRate || 3)))
            });
        },

        /**
         * Updates currentPair from post IDs.
         * @private
         * @param {number} idA
         * @param {number} idB
         */
        setPairFromIds(idA, idB) {
            this.isHovering = false;
            const resPostA = this.resolutionManager.getPost(idA);
            const resPostB = this.resolutionManager.getPost(idB);

            if (!resPostA || !resPostB) {
                throw new Error(`Failed to retrieve post objects for pair [${idA}, ${idB}]`);
            }

            this.currentPair = {
                a: resPostA.original,
                b: resPostB.original
            };

            if (this.hasMismatchedAspectRatio() && this.mode !== 'side-by-side') {
                this.setMode('side-by-side');
            }
        },

        /**
         * Initiates comparison session
         * @param {RootData | null} [rootData]
         * @param {HTMLElement | null} [containerEl]
         */
        startComparison(rootData, containerEl = null) {
            this.isLoading = false;
            this.isHovering = false;

            try {
                this.resolutionManager.initializePosts();

                if (!this.resolutionManager.cluster || !Array.isArray(this.resolutionManager.cluster.posts) || this.resolutionManager.cluster.posts.length < 2) {
                    showToast('Cluster must have at least 2 posts to compare.', 'error');
                    if (rootData && rootData.activeView) rootData.activeView = 'none';
                    return;
                }

                if (globalActiveComparison && globalActiveComparison !== this) {
                    globalActiveComparison.stopBlink();
                    globalActiveComparison.isHovering = false;
                }
                globalActiveComparison = this;
                if (this.resolutionManager) {
                    this.resolutionManager.activeComparison = this;
                }

                // 1. Filter valid posts with IDs
                const validPosts = [];
                for (const post of this.resolutionManager.cluster.posts) {
                    if (!post.postId) {
                        this.resolutionManager.markUnknown(post.postId);
                    } else {
                        validPosts.push(post);
                    }
                }

                // 2. Validate posts
                if (validPosts.length === 0) {
                    throw new Error('No valid posts available in this cluster.');
                }

                const activePosts = validPosts.filter(p => !p.isDeleted && !p.isFlagged);

                if (activePosts.length === 1) {
                    const superiorPost = activePosts[0];
                    for (const post of validPosts) {
                        if (post.postId !== superiorPost.postId) {
                            this.resolutionManager.addGraphEdge('duplicate', superiorPost.postId, post.postId, superiorPost.postId);
                        }
                    }

                    showToast(`Single active post (#${superiorPost.postId}) auto-selected as superior. Skipping comparison stage.`, 'info');
                    this.proceedToReconciliation(rootData);
                    return;
                }

                if (validPosts.length === 1) {
                    showToast('Only one valid post available. Skipping comparison step.', 'info');
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

                this.initWarnings();
                this.setPairFromIds(pairIds[0], pairIds[1]);
                this.isActive = true;

                // Smoothly scroll to position bottom of sticky header at midpoint of gap above cluster card
                setTimeout(() => {
                    const cardEl = containerEl?.closest('.border.rounded-lg') || containerEl;
                    if (cardEl) {
                        const header = document.querySelector('header');
                        const headerHeight = header ? header.getBoundingClientRect().height : 56;
                        const gapMidpoint = 8; // Midpoint of space-y-4 gap between cluster cards
                        const cardTop = cardEl.getBoundingClientRect().top + window.scrollY;
                        const targetY = Math.max(0, cardTop - headerHeight - gapMidpoint);

                        window.scrollTo({
                            top: targetY,
                            behavior: 'smooth'
                        });
                    }
                }, 60);

            } catch (err) {
                console.error('[ComparisonManager] Initiation error:', err);
                const message = err instanceof Error ? err.message : 'Unknown error';
                showToast(`Comparison error: ${message}`, 'error');
                this.closeComparison();
                if (rootData && rootData.activeView) rootData.activeView = 'none';
            }
        },

        /**
         * @param {RootData | null} [rootData]
         */
        proceedToReconciliation(rootData) {
            this.closeComparison();
            if (rootData) {
                setTimeout(() => {
                    const hasVariants = this.resolutionManager?.graphs?.some(g => g.type === 'variant');
                    if (hasVariants) {
                        rootData.activeView = 'associate';
                    } else {
                        rootData.activeView = 'reconcile';
                    }
                }, 0);
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

            const idA = this.currentPair.a.postId;
            const idB = this.currentPair.b.postId;

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