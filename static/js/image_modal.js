// @ts-check

/**
 * @typedef {Object} ModalOpenOptions
 * @property {string} src - Primary Image URL
 * @property {string} [srcB] - Secondary Image URL (for diff/blink/swipe)
 * @property {'single'|'diff'|'blink'|'swipe'} [mode] - View mode inside modal
 * @property {string} [title] - Primary post title/label
 * @property {string} [titleB] - Secondary post title/label
 * @property {string} [dimensions] - Dimensions label
 * @property {number} [blinkSpeed] - Blink interval ms
 */

/**
 * Interface representing the Alpine modal instance.
 * @typedef {Object} ImageModalInstance
 * @property {boolean} isOpen
 * @property {string} src
 * @property {string} srcB
 * @property {'single'|'diff'|'blink'|'swipe'} mode
 * @property {string} title
 * @property {string} titleB
 * @property {string} dimensions
 * @property {boolean} blinkShowB
 * @property {ReturnType<typeof setInterval> | null} blinkTimer
 * @property {number} blinkSpeed
 * @property {number} swipePos
 * @property {number} zoomLevel
 * @property {number} minZoom
 * @property {number} maxZoom
 * @property {number} zoomStep
 * @property {number} panX
 * @property {number} panY
 * @property {boolean} isDragging
 * @property {number} dragStartX
 * @property {number} dragStartY
 * @property {() => void} init
 * @property {(options: ModalOpenOptions) => void} open
 * @property {() => void} close
 * @property {() => void} startBlink
 * @property {() => void} stopBlink
 * @property {(e: MouseEvent, containerEl: HTMLElement | null) => void} handleModalSwipeMove
 * @property {() => void} resetZoom
 * @property {(level: number) => void} setZoom
 * @property {() => void} zoomIn
 * @property {() => void} zoomOut
 * @property {(e: WheelEvent) => void} handleWheel
 * @property {(e: MouseEvent) => void} startDrag
 * @property {(e: MouseEvent) => void} onDrag
 * @property {() => void} stopDrag
 * @property {Record<string, string>} transformStyle
 */

/** @type {ImageModalInstance | null} */
let globalModalInstance = null;

/**
 * Opens the global image modal programmatically.
 * @param {ModalOpenOptions} options
 */
export function openImageModal({ 
    src, 
    srcB = '', 
    mode = 'single', 
    title = '', 
    titleB = '', 
    dimensions = '',
    blinkSpeed = 350 
}) {
    if (globalModalInstance) {
        globalModalInstance.open({ src, srcB, mode, title, titleB, dimensions, blinkSpeed });
    } else {
        console.warn('[ImageModal] Modal instance not initialized.');
    }
}

/**
 * Alpine component factory for the Image Modal.
 * @returns {ImageModalInstance}
 */
export function ImageModalComponent() {
    return {
        isOpen: false,
        src: '',
        srcB: '',
        mode: 'single', // 'single' | 'diff' | 'blink' | 'swipe'
        title: '',
        titleB: '',
        dimensions: '',

        // Blink state
        blinkShowB: false,
        /** @type {ReturnType<typeof setInterval> | null} */
        blinkTimer: null,
        blinkSpeed: 350,

        // Modal Swipe position
        swipePos: 50,

        // Viewport & Pan/Zoom State
        zoomLevel: 1,
        minZoom: 0.5,
        maxZoom: 8,
        zoomStep: 0.25,
        panX: 0,
        panY: 0,
        isDragging: false,
        dragStartX: 0,
        dragStartY: 0,

        init() {
            globalModalInstance = this;
            
            window.addEventListener('keydown', (e) => {
                if (!this.isOpen) return;
                if (e.key === 'Escape') this.close();
                if (e.key === '+' || e.key === '=') this.zoomIn();
                if (e.key === '-' || e.key === '_') this.zoomOut();
                if (e.key === '0') this.resetZoom();
            });
        },

        /**
         * @param {ModalOpenOptions} options
         */
        open({ src, srcB = '', mode = 'single', title = '', titleB = '', dimensions = '', blinkSpeed = 350 }) {
            this.src = src;
            this.srcB = srcB;
            this.mode = mode;
            this.title = title;
            this.titleB = titleB;
            this.dimensions = dimensions;
            this.blinkSpeed = blinkSpeed;
            
            this.resetZoom();
            this.isOpen = true;

            if (this.mode === 'blink') {
                this.startBlink();
            }
        },

        close() {
            this.stopBlink();
            this.isOpen = false;
        },

        startBlink() {
            this.stopBlink();
            this.blinkShowB = false;
            this.blinkTimer = setInterval(() => {
                this.blinkShowB = !this.blinkShowB;
            }, this.blinkSpeed);
        },

        stopBlink() {
            if (this.blinkTimer) {
                clearInterval(this.blinkTimer);
                this.blinkTimer = null;
            }
        },

        /**
         * @param {MouseEvent} e
         * @param {HTMLElement | null} containerEl
         */
        handleModalSwipeMove(e, containerEl) {
            if (!containerEl) return;
            const rect = containerEl.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            this.swipePos = Math.max(0, Math.min(100, x));
        },

        resetZoom() {
            this.zoomLevel = 1;
            this.panX = 0;
            this.panY = 0;
        },

        /**
         * @param {number} level
         */
        setZoom(level) {
            this.zoomLevel = Math.max(this.minZoom, Math.min(this.maxZoom, level));
            if (this.zoomLevel === 1) {
                this.panX = 0;
                this.panY = 0;
            }
        },

        zoomIn() {
            this.setZoom(this.zoomLevel + this.zoomStep);
        },

        zoomOut() {
            this.setZoom(this.zoomLevel - this.zoomStep);
        },

        /**
         * @param {WheelEvent} e
         */
        handleWheel(e) {
            e.preventDefault();
            const delta = e.deltaY < 0 ? this.zoomStep : -this.zoomStep;
            this.setZoom(this.zoomLevel + delta);
        },

        /**
         * @param {MouseEvent} e
         */
        startDrag(e) {
            if (e.button !== 0) return;
            this.isDragging = true;
            this.dragStartX = e.clientX - this.panX;
            this.dragStartY = e.clientY - this.panY;
        },

        /**
         * @param {MouseEvent} e
         */
        onDrag(e) {
            if (!this.isDragging) return;
            this.panX = e.clientX - this.dragStartX;
            this.panY = e.clientY - this.dragStartY;
        },

        stopDrag() {
            this.isDragging = false;
        },

        /**
         * @returns {Record<string, string>}
         */
        get transformStyle() {
            return {
                transform: `translate(${this.panX}px, ${this.panY}px) scale(${this.zoomLevel})`,
                cursor: this.zoomLevel > 1 ? (this.isDragging ? 'grabbing' : 'grab') : 'default',
                transition: this.isDragging ? 'none' : 'transform 0.1s ease-out'
            };
        }
    };
}