export function installOverlay(config) {
    /**
     * Pure calculation utilities for the design overlay content script.
     * Extracted here so they can be unit-tested independently of the DOM / Chrome APIs.
     */
    // ─── Page key ─────────────────────────────────────────────────────────────────
    /** Stable storage key: origin + pathname (strips query string and hash). */
    function getPageKey(url) {
        try {
            const u = new URL(url);
            return u.origin + u.pathname;
        }
        catch {
            return url;
        }
    }
    // ─── Clip-path ─────────────────────────────────────────────────────────────────
    /**
     * Build the CSS `clip-path: inset(...)` value for the current crop + scale.
     * Crop values are in natural (scale=1) pixels; multiply by scale to get viewport px.
     */
    function buildClipPath(cropTop, cropRight, cropBottom, cropLeft, scale) {
        return `inset(${cropTop * scale}px ${cropRight * scale}px ${cropBottom * scale}px ${cropLeft * scale}px)`;
    }
    // ─── Visible size ──────────────────────────────────────────────────────────────
    /**
     * Compute the visible dimensions of the image after applying crop + scale.
     *
     * @param w        Full rendered width  (px, already scaled)
     * @param h        Full rendered height (px, already scaled)
     * @param cropLeft Natural-pixel crop from the left
     * @param cropRight Natural-pixel crop from the right
     * @param cropTop  Natural-pixel crop from the top
     * @param cropBottom Natural-pixel crop from the bottom
     * @param scale    Current scale factor
     */
    function getVisibleSize(w, h, cropLeft, cropRight, cropTop, cropBottom, scale) {
        return {
            visW: Math.max(0, w - (cropLeft + cropRight) * scale),
            visH: Math.max(0, h - (cropTop + cropBottom) * scale),
        };
    }
    // ─── Scale-change position compensation ───────────────────────────────────────
    /**
     * When the scale changes while a crop is active, the clip-path inset shifts the
     * visible (cropped) top-left corner in screen space:
     *
     *   visibleLeft = currentX + cropLeft * scale
     *
     * To keep the visible corner anchored at the same screen position, compensate:
     *
     *   newCurrentX = currentX - cropLeft * (newScale - oldScale)
     *
     * Returns the adjusted { x, y }.
     */
    function compensatePositionForScaleChange(currentX, currentY, cropLeft, cropTop, oldScale, newScale) {
        const delta = newScale - oldScale;
        return {
            x: currentX - cropLeft * delta,
            y: currentY - cropTop * delta,
        };
    }
    /**
     * Compute the new crop value after dragging an edge handle.
     *
     * For 'right' and 'bottom' handles the pointer moving *inward* (toward the
     * opposite edge) should *increase* the crop, so the delta is inverted.
     *
     * Drag deltas are in viewport pixels; divide by scale to store in natural pixels.
     */
    function computeEdgeCropValue(startValue, startClient, currentClient, dir, scale) {
        const invert = dir === 'right' || dir === 'bottom';
        const delta = invert
            ? startClient - currentClient
            : currentClient - startClient;
        return Math.max(0, startValue + delta / scale);
    }
    /**
     * Map a corner direction to the two crop-key names it controls.
     * top-left  → [cropLeft, cropTop]
     * top-right → [cropRight, cropTop]
     * ...
     */
    function cornerKeys(dir) {
        const xKey = (dir === 'top-left' || dir === 'bottom-left') ? 'cropLeft' : 'cropRight';
        const yKey = (dir === 'top-left' || dir === 'top-right') ? 'cropTop' : 'cropBottom';
        return [xKey, yKey];
    }
    /**
     * Compute the new (x, y) crop values after dragging a corner handle.
     *
     * Right/bottom corners: moving *inward* (left/up) increases crop → invert that axis.
     */
    function computeCornerCropValues(startValueX, startValueY, dX, dY, dir, scale) {
        const xInvert = dir === 'top-right' || dir === 'bottom-right';
        const yInvert = dir === 'bottom-left' || dir === 'bottom-right';
        return {
            valX: Math.max(0, startValueX + (xInvert ? -dX : dX) / scale),
            valY: Math.max(0, startValueY + (yInvert ? -dY : dY) / scale),
        };
    }
    class DesignLayerOverlay {
        svgWrapper = null;
        isDragging = false;
        dragStartX = 0;
        dragStartY = 0;
        currentX = 0;
        currentY = 0;
        targetElement = null;
        scrollListener = null;
        resizeObserver = null;
        currentSettings = null;
        settingsRevision = 0;
        isPickingMode = false;
        pickAbortController = null;
        pickHintEl = null;
        // Crop handle state
        cropOverlay = null;
        cropHandles = null;
        cropCorners = null;
        cropDragging = null;
        cropDragStartClient = 0; // X for edges; X for corners
        cropDragStartClientY = 0; // Y for corners
        cropDragStartValue = 0; // primary crop value
        cropDragStartValue2 = 0; // secondary crop value (corners only)
        cropAbortController = null;
        touchScrollStyle = null;
        eventTimer = null;
        lastEventState = null;
        destroyed = false;
        constructor() {
            try { this.init(); }
            catch (error) { this.destroy(); throw error; }
        }
        init() {
            // svgWrapper is a direct child of body with position:fixed so mix-blend-mode
            // composites against page content without being blocked by a parent stacking context
            this.svgWrapper = document.createElement('div');
            this.svgWrapper.id = 'mearl-design-overlay-svg-wrapper';
            this.svgWrapper.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      pointer-events: auto;
      cursor: move;
      touch-action: none;
      z-index: 999999;
    `;
            document.body.appendChild(this.svgWrapper);
            // Setup drag handlers
            this.setupDragHandlers();
            // Setup crop handles
            this.setupCropHandles();
            this.loadSettings();
        }
        /**
         * Returns the precise rendered size of the overlay image/svg.
         * Reads from the inner child element (which has no clip-path) via getBoundingClientRect
         * to get accurate sub-pixel dimensions, falling back to svgWrapper offsetWidth/Height.
         */
        getContentSize() {
            if (!this.svgWrapper)
                return { w: 0, h: 0 };
            const child = this.svgWrapper.querySelector('svg, img');
            if (child) {
                const r = child.getBoundingClientRect();
                if (r.width > 0 && r.height > 0)
                    return { w: r.width, h: r.height };
            }
            return { w: this.svgWrapper.offsetWidth, h: this.svgWrapper.offsetHeight };
        }
        /**
         * Size and position cropOverlay to exactly match the visible (post-crop) area.
         * The overlay is offset by (cropLeft, cropTop) from the svgWrapper origin so its
         * border rectangle aligns with the clipped image edge.
         */
        syncCropOverlay() {
            if (!this.cropOverlay || !this.svgWrapper || !this.currentSettings)
                return;
            const { w, h } = this.getContentSize();
            const { cropTop = 0, cropRight = 0, cropBottom = 0, cropLeft = 0 } = this.currentSettings;
            const scale = this.currentSettings.scale ?? 1;
            const { visW, visH } = getVisibleSize(w, h, cropLeft, cropRight, cropTop, cropBottom, scale);
            this.cropOverlay.style.width = `${visW}px`;
            this.cropOverlay.style.height = `${visH}px`;
            // Shift the overlay by the scaled crop insets so it starts at the visible edge
            const base = this.svgWrapper.style.transform;
            const m = base.match(/translate\(([^,]+)px,\s*([^)]+)px\)/);
            const tx = m ? parseFloat(m[1]) : 0;
            const ty = m ? parseFloat(m[2]) : 0;
            this.cropOverlay.style.transform = `translate(${tx + cropLeft * scale}px, ${ty + cropTop * scale}px)`;
        }
        setupCropHandles() {
            // Single container that mirrors svgWrapper's transform; handles are absolute children.
            this.cropOverlay = document.createElement('div');
            this.cropOverlay.style.cssText = [
                'position: fixed',
                'top: 0',
                'left: 0',
                'pointer-events: none',
                'overflow: visible',
                'z-index: 1000000',
                'display: none',
            ].join(';');
            document.documentElement.appendChild(this.cropOverlay);
            const stripe = 'rgba(59,130,246,0.85)';
            const mkHandle = (dir) => {
                const h = document.createElement('div');
                h.dataset.cropHandle = dir;
                const isHoriz = dir === 'top' || dir === 'bottom';
                // 8px hit area; 2px colored stripe sits at the center (px 3–5) via gradient,
                // so the visual line is half inside / half outside the visible boundary.
                const gradient = isHoriz
                    ? `linear-gradient(to bottom, transparent 3px, ${stripe} 3px, ${stripe} 5px, transparent 5px)`
                    : `linear-gradient(to right,  transparent 3px, ${stripe} 3px, ${stripe} 5px, transparent 5px)`;
                h.style.cssText = [
                    'position: absolute',
                    'pointer-events: auto',
                    'box-sizing: border-box',
                    `background: ${gradient}`,
                    isHoriz ? 'cursor: ns-resize' : 'cursor: ew-resize',
                    isHoriz ? 'height: 8px' : 'width: 8px',
                ].join(';');
                this.cropOverlay.appendChild(h);
                return h;
            };
            const mkCorner = (dir) => {
                const h = document.createElement('div');
                h.dataset.cropHandle = dir;
                const cursor = (dir === 'top-left' || dir === 'bottom-right') ? 'nwse-resize' : 'nesw-resize';
                // 16×16 transparent hit area; 8×8 visual dot centered inside.
                h.style.cssText = [
                    'position: absolute',
                    'pointer-events: auto',
                    'width: 16px',
                    'height: 16px',
                    `cursor: ${cursor}`,
                ].join(';');
                const dot = document.createElement('div');
                dot.style.cssText = [
                    'position: absolute',
                    'top: 4px',
                    'left: 4px',
                    'width: 8px',
                    'height: 8px',
                    `border: 2px solid ${stripe}`,
                    'border-radius: 2px',
                    'background: white',
                    'pointer-events: none',
                    'box-sizing: border-box',
                ].join(';');
                h.appendChild(dot);
                this.cropOverlay.appendChild(h);
                return h;
            };
            this.cropHandles = {
                top: mkHandle('top'),
                right: mkHandle('right'),
                bottom: mkHandle('bottom'),
                left: mkHandle('left'),
            };
            this.cropCorners = {
                tl: mkCorner('top-left'),
                tr: mkCorner('top-right'),
                bl: mkCorner('bottom-left'),
                br: mkCorner('bottom-right'),
            };
            const ac = new AbortController();
            this.cropAbortController = ac;
            const isCorner = (d) => d.includes('-');
            const startDrag = (dir, clientX, clientY) => {
                if (!this.currentSettings || this.currentSettings.locked)
                    return false;
                this.cropDragging = dir;
                if (isCorner(dir)) {
                    const [xKey, yKey] = cornerKeys(dir);
                    this.cropDragStartClient = clientX;
                    this.cropDragStartClientY = clientY;
                    this.cropDragStartValue = this.currentSettings[xKey] ?? 0;
                    this.cropDragStartValue2 = this.currentSettings[yKey] ?? 0;
                }
                else {
                    this.cropDragStartClient = (dir === 'top' || dir === 'bottom') ? clientY : clientX;
                    this.cropDragStartValue = this.currentSettings[`crop${dir.charAt(0).toUpperCase()}${dir.slice(1)}`] ?? 0;
                }
                return true;
            };
            const onHandleMouseDown = (e) => {
                const el = e.target;
                const dir = el.dataset.cropHandle;
                if (!dir || !this.cropOverlay?.contains(el) || !this.currentSettings || this.currentSettings.locked)
                    return;
                e.preventDefault();
                e.stopPropagation();
                startDrag(dir, e.clientX, e.clientY);
            };
            const onHandleTouchStart = (e) => {
                const el = e.target;
                const dir = el.dataset.cropHandle;
                if (!dir || !this.cropOverlay?.contains(el) || !this.currentSettings || this.currentSettings.locked)
                    return;
                e.preventDefault();
                e.stopPropagation();
                const t = e.touches[0];
                startDrag(dir, t.clientX, t.clientY);
            };
            const computeNewSettings = (clientX, clientY) => {
                if (!this.cropDragging || !this.currentSettings)
                    return null;
                const dir = this.cropDragging;
                // Drag deltas are in viewport pixels; divide by scale to store in natural pixels.
                const scale = this.currentSettings.scale ?? 1;
                if (isCorner(dir)) {
                    const [xKey, yKey] = cornerKeys(dir);
                    const dX = clientX - this.cropDragStartClient;
                    const dY = clientY - this.cropDragStartClientY;
                    const { valX, valY } = computeCornerCropValues(this.cropDragStartValue, this.cropDragStartValue2, dX, dY, dir, scale);
                    return { ...this.currentSettings, [xKey]: valX, [yKey]: valY };
                }
                else {
                    const clientPos = (dir === 'top' || dir === 'bottom') ? clientY : clientX;
                    const val = computeEdgeCropValue(this.cropDragStartValue, this.cropDragStartClient, clientPos, dir, scale);
                    const key = `crop${dir.charAt(0).toUpperCase()}${dir.slice(1)}`;
                    return { ...this.currentSettings, [key]: val };
                }
            };
            const applyCurrentCropDrag = (clientX, clientY) => {
                const newSettings = computeNewSettings(clientX, clientY);
                if (!newSettings)
                    return;
                this.currentSettings = newSettings;
                this.applyCropClip();
                this.updateCropHandles();
            };
            const endCropDrag = (clientX, clientY) => {
                const newSettings = computeNewSettings(clientX, clientY);
                if (!newSettings)
                    return;
                this.currentSettings = newSettings;
                this.applyCropClip();
                this.updateCropHandles();
                this.cropDragging = null;
                this.persistSettings();
            };
            document.addEventListener('mousedown', onHandleMouseDown, { capture: true, signal: ac.signal });
            document.addEventListener('touchstart', onHandleTouchStart, { capture: true, passive: false, signal: ac.signal });
            document.addEventListener('mousemove', (e) => {
                if (!this.cropDragging)
                    return;
                applyCurrentCropDrag(e.clientX, e.clientY);
            }, { signal: ac.signal });
            document.addEventListener('touchmove', (e) => {
                if (!this.cropDragging)
                    return;
                e.preventDefault();
                const t = e.touches[0];
                applyCurrentCropDrag(t.clientX, t.clientY);
            }, { passive: false, signal: ac.signal });
            document.addEventListener('mouseup', (e) => {
                if (!this.cropDragging)
                    return;
                endCropDrag(e.clientX, e.clientY);
            }, { signal: ac.signal });
            document.addEventListener('touchend', (e) => {
                if (!this.cropDragging)
                    return;
                const t = e.changedTouches[0];
                endCropDrag(t.clientX, t.clientY);
            }, { signal: ac.signal });
        }
        applyCropClip() {
            if (!this.svgWrapper || !this.currentSettings)
                return;
            const { cropTop = 0, cropRight = 0, cropBottom = 0, cropLeft = 0 } = this.currentSettings;
            const scale = this.currentSettings.scale ?? 1;
            this.svgWrapper.style.clipPath = buildClipPath(cropTop, cropRight, cropBottom, cropLeft, scale);
        }
        updateCropHandles() {
            if (!this.cropOverlay || !this.cropHandles || !this.svgWrapper || !this.currentSettings)
                return;
            const show = !this.isPickingMode && !this.currentSettings.locked && !!this.currentSettings.svgContent && this.currentSettings.visible;
            if (!show) {
                this.cropOverlay.style.display = 'none';
                return;
            }
            this.syncCropOverlay();
            this.cropOverlay.style.display = 'block';
            const { w, h } = this.getContentSize();
            const { cropTop = 0, cropRight = 0, cropBottom = 0, cropLeft = 0 } = this.currentSettings;
            const scale = this.currentSettings.scale ?? 1;
            const { visW, visH } = getVisibleSize(w, h, cropLeft, cropRight, cropTop, cropBottom, scale);
            // Handles are centered on the overlay boundary: each 8px handle is offset −4px
            // so 4px sits outside and 4px inside. The background gradient stripe is at
            // px 3–5 (center), which lands exactly on the crop boundary.
            const { top: th, right: rh, bottom: bh, left: lh } = this.cropHandles;
            // Edge handles: centered on boundary, flush in the perpendicular axis.
            // The gradient stripe sits at px 3–5, so the visible line straddles the boundary.
            th.style.top = '-4px';
            th.style.left = '0';
            th.style.width = `${visW}px`;
            bh.style.top = `${visH - 4}px`;
            bh.style.left = '0';
            bh.style.width = `${visW}px`;
            lh.style.left = '-4px';
            lh.style.top = '0';
            lh.style.height = `${visH}px`;
            rh.style.left = `${visW - 4}px`;
            rh.style.top = '0';
            rh.style.height = `${visH}px`;
            // Corner handles: 16×16 hit area centered on the corner, 8×8 visual dot inside.
            if (this.cropCorners) {
                const { tl, tr, bl, br } = this.cropCorners;
                tl.style.top = '-8px';
                tl.style.left = '-8px';
                tr.style.top = '-8px';
                tr.style.left = `${visW - 8}px`;
                bl.style.top = `${visH - 8}px`;
                bl.style.left = '-8px';
                br.style.top = `${visH - 8}px`;
                br.style.left = `${visW - 8}px`;
            }
        }
        dragAbortController = new AbortController();
        setupDragHandlers() {
            const signal = this.dragAbortController.signal;
            if (!this.svgWrapper)
                return;
            // Mouse events
            this.svgWrapper.addEventListener('mousedown', (e) => {
                // Ignore if this click originated on a crop handle
                if (e.target.dataset.cropHandle)
                    return;
                if (this.currentSettings && !this.currentSettings.locked && this.currentSettings.visible) {
                    this.isDragging = true;
                    this.dragStartX = e.clientX - this.currentX;
                    this.dragStartY = e.clientY - this.currentY;
                    e.preventDefault();
                }
            }, { signal });
            // Touch events for mobile
            this.svgWrapper.addEventListener('touchstart', (e) => {
                // Ignore if this touch originated on a crop handle
                if (e.target.dataset.cropHandle)
                    return;
                if (this.currentSettings && !this.currentSettings.locked && this.currentSettings.visible) {
                    this.isDragging = true;
                    const touch = e.touches[0];
                    this.dragStartX = touch.clientX - this.currentX;
                    this.dragStartY = touch.clientY - this.currentY;
                    e.preventDefault();
                    // Prevent page scroll during drag
                    if (!this.touchScrollStyle) this.touchScrollStyle = {
                        value: document.body.style.getPropertyValue('overflow'),
                        priority: document.body.style.getPropertyPriority('overflow'),
                    };
                    document.body.style.setProperty('overflow', 'hidden', 'important');
                }
            }, { signal });
            document.addEventListener('mousemove', (e) => {
                if (this.isDragging && this.svgWrapper) {
                    this.currentX = e.clientX - this.dragStartX;
                    this.currentY = e.clientY - this.dragStartY;
                    if (this.currentSettings?.followScroll && this.targetElement) {
                        const r = this.targetElement.getBoundingClientRect();
                        this.svgWrapper.style.transform = `translate(${r.left + this.currentX}px, ${r.top + this.currentY}px)`;
                    }
                    else {
                        this.svgWrapper.style.transform = `translate(${this.currentX}px, ${this.currentY}px)`;
                    }
                    this.updateCropHandles();
                }
            }, { signal });
            document.addEventListener('touchmove', (e) => {
                if (this.isDragging && this.svgWrapper) {
                    const touch = e.touches[0];
                    this.currentX = touch.clientX - this.dragStartX;
                    this.currentY = touch.clientY - this.dragStartY;
                    if (this.currentSettings?.followScroll && this.targetElement) {
                        const r = this.targetElement.getBoundingClientRect();
                        this.svgWrapper.style.transform = `translate(${r.left + this.currentX}px, ${r.top + this.currentY}px)`;
                    }
                    else {
                        this.svgWrapper.style.transform = `translate(${this.currentX}px, ${this.currentY}px)`;
                    }
                    this.updateCropHandles();
                    e.preventDefault(); // Prevent page scroll
                }
            }, { passive: false, signal });
            const endDrag = () => {
                if (this.isDragging) {
                    this.isDragging = false;
                    // Restore page scroll
                    this.restoreTouchScroll();
                    this.persistCurrentPosition();
                }
            };
            document.addEventListener('mouseup', endDrag, { signal });
            document.addEventListener('touchend', endDrag, { signal });
            document.addEventListener('touchcancel', endDrag, { signal });
            // Arrow-key nudge (Shift = 10px). Only when visible and unlocked.
            document.addEventListener('keydown', (e) => {
                if (!this.currentSettings?.visible || this.currentSettings.locked)
                    return;
                if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key))
                    return;
                const tag = e.target?.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable)
                    return;
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                switch (e.key) {
                    case 'ArrowUp':
                        this.currentY -= step;
                        break;
                    case 'ArrowDown':
                        this.currentY += step;
                        break;
                    case 'ArrowLeft':
                        this.currentX -= step;
                        break;
                    case 'ArrowRight':
                        this.currentX += step;
                        break;
                }
                if (this.currentSettings.followScroll) {
                    this.updatePositionRelativeToElement();
                }
                else {
                    this.updatePosition();
                }
                this.persistCurrentPosition();
            }, { signal });
        }
        persistCurrentPosition() {
            if (!this.currentSettings)
                return;
            this.currentSettings = { ...this.currentSettings, offsetX: this.currentX, offsetY: this.currentY };
            this.persistSettings();
        }
        persistSettings() {
            if (!this.currentSettings)
                return;
            this.settingsRevision++;
            this.currentSettings = { ...this.currentSettings, offsetX: this.currentX, offsetY: this.currentY };
            const { svgContent, ...settings } = this.currentSettings;
            try {
                sessionStorage.setItem('__mearl_design_overlay:' + getPageKey(location.href), JSON.stringify({ browserSessionId: config.browserSessionId, pageKey: getPageKey(location.href), settings }));
            }
            catch { }
            this.scheduleStateEvent();
        }
        scheduleStateEvent() {
            if (this.destroyed || this.eventTimer !== null) return;
            this.eventTimer = setTimeout(() => {
                this.eventTimer = null;
                this.emitStateEvent();
            }, 80);
        }
        emitStateEvent() {
            if (this.destroyed || typeof config.emit !== 'function') return;
            const state = this.getState();
            const serialized = JSON.stringify(state);
            if (serialized === this.lastEventState) return;
            this.lastEventState = serialized;
            config.emit(state);
        }
        loadSettings() {
            let settings = { ...config.settings };
            try {
                const saved = JSON.parse(sessionStorage.getItem('__mearl_design_overlay:' + getPageKey(location.href)) || 'null');
                if (saved?.browserSessionId === config.browserSessionId && saved?.pageKey === getPageKey(location.href) && saved.settings?.assetId === settings.assetId) {
                    for (const key of Object.keys(settings)) {
                        if (key !== 'svgContent' && Object.hasOwn(saved.settings, key)) settings[key] = saved.settings[key];
                    }
                }
            }
            catch { }
            this.updateLayer(settings, true);
        }
        getState() {
            const { svgContent, ...settings } = this.currentSettings || config.settings;
            return { settingsRevision: this.settingsRevision, settings: { ...settings, offsetX: this.currentX, offsetY: this.currentY }, hasContent: Boolean(svgContent), picking: this.isPickingMode, url: location.href, runtimeVersion: config.runtimeVersion, naturalSize: this.getNaturalSize(), devicePixelRatio: window.devicePixelRatio || 1 };
        }
        handle(message) {
            let response = null;
            const sendResponse = (value) => { response = value; };
            if (message.type === 'UPDATE_LAYER') {
                // Position controls carry explicit offsets; other updates retain the latest drag position.
                this.updateLayer({ ...this.currentSettings, ...message.settings }, message.forceOffset === true);
                this.persistSettings();
            }
            else if (message.type === 'START_PICKING') {
                this.startPickingMode();
            }
            else if (message.type === 'CANCEL_PICKING') {
                this.stopPickingMode();
            }
            else if (message.type === 'HIDE_FOR_CAPTURE') {
                // Temporarily hide the overlay so the screenshot shows only the page.
                if (this.svgWrapper)
                    this.svgWrapper.style.visibility = 'hidden';
                if (this.cropOverlay)
                    this.cropOverlay.style.visibility = 'hidden';
                sendResponse({ ok: true });
                return response;
            }
            else if (message.type === 'SHOW_AFTER_CAPTURE') {
                if (this.svgWrapper)
                    this.svgWrapper.style.visibility = '';
                if (this.cropOverlay)
                    this.cropOverlay.style.visibility = '';
                sendResponse({ ok: true });
                return response;
            }
            else if (message.type === 'GET_VIEWPORT_INFO') {
                // Return DPR, the exact visible rect in viewport CSS px, and a pre-cropped
                // data URL of the design image (drawn via canvas for pixel-perfect accuracy).
                const dpr = window.devicePixelRatio;
                let overlayRect = null;
                let croppedDesign = null;
                if (this.svgWrapper && this.currentSettings) {
                    const child = this.svgWrapper.querySelector('svg, img');
                    if (child) {
                        const r = child.getBoundingClientRect();
                        const { cropTop = 0, cropRight = 0, cropBottom = 0, cropLeft = 0 } = this.currentSettings;
                        const scale = this.currentSettings.scale ?? 1;
                        overlayRect = {
                            x: r.left + cropLeft * scale,
                            y: r.top + cropTop * scale,
                            w: r.width - (cropLeft + cropRight) * scale,
                            h: r.height - (cropTop + cropBottom) * scale,
                        };
                        // Draw the visible portion of the design image onto a canvas.
                        // Using naturalWidth/renderedWidth avoids any assumption about crop units.
                        if (child.tagName === 'IMG') {
                            const imgEl = child;
                            if (imgEl.naturalWidth > 0 && overlayRect.w > 0 && overlayRect.h > 0) {
                                try {
                                    const scaleX = imgEl.naturalWidth / r.width;
                                    const scaleY = imgEl.naturalHeight / r.height;
                                    const srcX = (overlayRect.x - r.left) * scaleX;
                                    const srcY = (overlayRect.y - r.top) * scaleY;
                                    const srcW = overlayRect.w * scaleX;
                                    const srcH = overlayRect.h * scaleY;
                                    // Use DPR-scaled dimensions so croppedDesign and the screenshot crop
                                    // are exactly the same pixel size — no aspect-ratio mismatch.
                                    const width = Math.max(1, Math.round(overlayRect.w * dpr));
                                    const height = Math.max(1, Math.round(overlayRect.h * dpr));
                                    if (width * height > 16_000_000) throw new Error('Crop exceeds canvas limit');
                                    const canvas = document.createElement('canvas');
                                    canvas.width = width;
                                    canvas.height = height;
                                    const ctx = canvas.getContext('2d');
                                    if (ctx) {
                                        ctx.drawImage(imgEl, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);
                                        croppedDesign = canvas.toDataURL('image/png');
                                    }
                                }
                                catch {
                                    // canvas taint or other error – fall back to null
                                }
                            }
                        }
                    }
                }
                sendResponse({ devicePixelRatio: dpr, innerWidth: window.innerWidth, innerHeight: window.innerHeight, overlayRect, croppedDesign });
                return response;
            }
            return response || this.getState();
        }
        parseDesign(source) {
                const content = source.trim();
                if (content.startsWith('data:image/')) {
                    const image = document.createElement('img');
                    image.src = content;
                    return image;
                }
                else {
                    const parsed = new DOMParser().parseFromString(content, 'image/svg+xml');
                    if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg')
                        throw new Error('Invalid SVG');
                    parsed.querySelectorAll('script, foreignObject, iframe, object, embed, style, animate, set, animateTransform, animateMotion').forEach(node => node.remove());
                    for (const node of [parsed.documentElement, ...parsed.querySelectorAll('*')]) {
                        for (const attribute of [...node.attributes]) {
                            const name = attribute.name.toLowerCase();
                            const value = attribute.value.trim();
                            const unsafeUrl = [...value.matchAll(/url\(([^)]*)\)/gi)].some(([, url]) => !url.trim().replace(/^['"]|['"]$/g, '').startsWith('#'));
                            if (name.startsWith('on') || name === 'xml:base' ||
                                ((name === 'href' || name === 'xlink:href') && !value.startsWith('#') && !/^data:image\/(png|jpeg);base64,/.test(value)) ||
                                unsafeUrl) {
                                node.removeAttribute(attribute.name);
                            }
                        }
                    }
                    return document.importNode(parsed.documentElement, true);
                }
        }
        updateLayer(settings, forceOffset = false) {
            if (!this.svgWrapper)
                return;
            const prevSettings = this.currentSettings;
            const contentChanged = !prevSettings || prevSettings.svgContent !== settings.svgContent;
            const designNode = contentChanged && settings.svgContent ? this.parseDesign(settings.svgContent) : null;
            if (settings.selector) document.querySelector(settings.selector);
            this.currentSettings = settings;
            // Update visibility
            this.svgWrapper.style.display = settings.visible ? 'block' : 'none';
            // mix-blend-mode on svgWrapper blends with page content.
            // opacity goes on the leaf element to avoid browser inconsistencies
            // when both opacity and mix-blend-mode are set on the same element.
            this.svgWrapper.style.opacity = '1';
            this.svgWrapper.style.mixBlendMode = settings.blendMode;
            if (contentChanged) {
                this.svgWrapper.replaceChildren();
                if (designNode) this.svgWrapper.appendChild(designNode);
            }
            const targetElement = this.svgWrapper.querySelector('svg, img');
            if (targetElement) {
                targetElement.style.cssText = `display:block;width:100%;height:100%;opacity:${settings.opacity}`;
                const image = this.svgWrapper.querySelector('img');
                if (image && !image.complete) image.addEventListener('load', () => {
                    if (this.currentSettings?.followScroll) this.updatePositionRelativeToElement();
                    else this.updatePosition();
                }, { once: true });
            }
            // Explicit position controls override the latest drag position; other controls retain it.
            if (forceOffset || !prevSettings) {
                this.currentX = settings.offsetX;
                this.currentY = settings.offsetY;
            }
            else if (prevSettings && prevSettings.scale !== settings.scale) {
                // When scale changes while crop is active, the clip-path inset changes proportionally,
                // which causes the visible (cropped) area to drift. Compensate currentX/Y so that
                // the visible top-left corner stays anchored at the same screen position.
                const { x, y } = compensatePositionForScaleChange(this.currentX, this.currentY, settings.cropLeft ?? 0, settings.cropTop ?? 0, prevSettings.scale ?? 1, settings.scale ?? 1);
                this.currentX = x;
                this.currentY = y;
            }
            // Update cursor
            this.svgWrapper.style.cursor = settings.locked ? 'default' : 'move';
            this.svgWrapper.style.pointerEvents = settings.locked || this.isPickingMode ? 'none' : 'auto';
            // Apply non-destructive crop via clip-path
            this.applyCropClip();
            this.updateCropHandles();
            // Only rebuild scroll listeners when selector or followScroll actually changes
            const scrollSettingsChanged = !prevSettings
                || settings.selector !== prevSettings.selector
                || settings.followScroll !== prevSettings.followScroll;
            if (scrollSettingsChanged) {
                this.setupScrollFollowing(settings);
            }
            else {
                // Position may have changed (offset or element moved), just re-apply
                if (settings.followScroll) {
                    this.updatePositionRelativeToElement();
                }
                else {
                    this.updatePosition();
                }
            }
        }
        setupScrollFollowing(settings) {
            // Clean up previous listeners
            this.cleanupScrollListeners();
            try {
                this.targetElement = settings.selector
                    ? document.querySelector(settings.selector)
                    : null;
                if (!this.targetElement) {
                    if (settings.selector) {
                        console.warn(`Element not found: ${settings.selector}, falling back to body`);
                    }
                    this.targetElement = document.body;
                }
                if (settings.followScroll) {
                    // Follow scroll mode: update position based on element's position
                    this.updatePositionRelativeToElement();
                    // Listen to scroll events on window and the element's scroll containers
                    this.scrollListener = () => {
                        if (this.currentSettings?.followScroll) {
                            this.updatePositionRelativeToElement();
                        }
                    };
                    window.addEventListener('scroll', this.scrollListener, true);
                    window.addEventListener('resize', this.scrollListener);
                    // Use ResizeObserver to track element position changes
                    this.resizeObserver = new ResizeObserver(() => {
                        if (this.currentSettings?.followScroll) {
                            this.updatePositionRelativeToElement();
                        }
                    });
                    this.resizeObserver.observe(this.targetElement);
                }
                else {
                    // Fixed mode: stay in place regardless of scroll
                    this.updatePosition();
                }
            }
            catch (error) {
                console.error('Invalid selector:', settings.selector, error);
                this.targetElement = document.body;
                this.updatePosition();
            }
        }
        getNaturalSize() {
            const child = this.svgWrapper?.querySelector('svg, img');
            if (!child) return { width: 0, height: 0 };
            if (child.tagName === 'IMG') return { width: child.naturalWidth, height: child.naturalHeight };
            const absolute = value => /^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/.test(value || '') ? parseFloat(value) : 0;
            const width = absolute(child.getAttribute('width'));
            const height = absolute(child.getAttribute('height'));
            const viewBox = (child.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
            const viewWidth = viewBox.length === 4 && viewBox[2] > 0 ? viewBox[2] : 300;
            const viewHeight = viewBox.length === 4 && viewBox[3] > 0 ? viewBox[3] : 150;
            return {
                width: width || (height ? height * viewWidth / viewHeight : viewWidth),
                height: height || (width ? width * viewHeight / viewWidth : viewHeight),
            };
        }
        applyNaturalSize() {
            const { width, height } = this.getNaturalSize();
            const scale = (this.currentSettings?.scale ?? 1) / (this.currentSettings?.pixelRatio ?? 1);
            this.svgWrapper.style.width = `${width * scale}px`;
            this.svgWrapper.style.height = `${height * scale}px`;
        }
        updatePositionRelativeToElement() {
            if (!this.svgWrapper || !this.targetElement)
                return;
            const rect = this.targetElement.getBoundingClientRect();
            this.applyNaturalSize();
            const x = rect.left + this.currentX;
            const y = rect.top + this.currentY;
            this.svgWrapper.style.transform = `translate(${x}px, ${y}px)`;
            this.updateCropHandles();
        }
        updatePosition() {
            if (!this.svgWrapper)
                return;
            this.applyNaturalSize();
            this.svgWrapper.style.transform = `translate(${this.currentX}px, ${this.currentY}px)`;
            this.updateCropHandles();
        }
        cleanupScrollListeners() {
            if (this.scrollListener) {
                window.removeEventListener('scroll', this.scrollListener, true);
                window.removeEventListener('resize', this.scrollListener);
                this.scrollListener = null;
            }
            if (this.resizeObserver) {
                this.resizeObserver.disconnect();
                this.resizeObserver = null;
            }
        }
        restoreTouchScroll() {
            if (!this.touchScrollStyle) return;
            const { value, priority } = this.touchScrollStyle;
            if (value) document.body.style.setProperty('overflow', value, priority);
            else document.body.style.removeProperty('overflow');
            this.touchScrollStyle = null;
        }
        destroy() {
            this.destroyed = true;
            if (this.eventTimer !== null) clearTimeout(this.eventTimer);
            this.eventTimer = null;
            this.restoreTouchScroll();
            this.isDragging = false;
            this.dragAbortController.abort();
            this.cleanupScrollListeners();
            this.stopPickingMode();
            this.cropAbortController?.abort();
            this.cropAbortController = null;
            this.cropOverlay?.remove();
            this.cropOverlay = null;
            this.cropHandles = null;
            this.svgWrapper?.remove();
            this.svgWrapper = null;
        }
        /** Returns true when the primary pointer is coarse (touch / mobile emulation). */
        isTouchPrimary() {
            return window.matchMedia('(pointer: coarse)').matches;
        }
        startPickingMode() {
            if (this.isPickingMode)
                return;
            this.isPickingMode = true;
            this.svgWrapper.style.pointerEvents = 'none';
            this.updateCropHandles();
            this.scheduleStateEvent();
            const ac = new AbortController();
            this.pickAbortController = ac;
            // Inject cursor + scroll-lock style
            const style = document.createElement('style');
            style.id = 'mearl-design-layer-pick-style';
            style.textContent = [
                '* { cursor: crosshair !important; }',
                'html, body { touch-action: none !important; }',
            ].join('\n');
            document.head.appendChild(style);
            // Show a hint toast when running in touch / mobile-emulation mode
            if (this.isTouchPrimary()) {
                const hint = document.createElement('div');
                hint.id = 'mearl-design-layer-pick-hint';
                const msg = config.pickHint;
                hint.textContent = msg || 'Press & drag to highlight · lift to select';
                hint.style.cssText = [
                    'position: fixed',
                    'top: 24px',
                    'left: 50%',
                    'transform: translateX(-50%)',
                    'z-index: 2147483647',
                    'pointer-events: none',
                    'background: rgba(0,0,0,0.72)',
                    'color: #fff',
                    'font-size: 13px',
                    'font-family: system-ui, sans-serif',
                    'line-height: 1.4',
                    'padding: 8px 16px',
                    'border-radius: 20px',
                    'white-space: nowrap',
                    'box-shadow: 0 2px 12px rgba(0,0,0,0.3)',
                    'opacity: 0',
                    'transition: opacity 0.25s ease',
                ].join(';');
                document.documentElement.appendChild(hint);
                this.pickHintEl = hint;
                // Trigger fade-in after paint
                requestAnimationFrame(() => { hint.style.opacity = '1'; });
            }
            // Fixed-position highlight overlay — immune to parent overflow:hidden
            const highlight = document.createElement('div');
            highlight.id = 'mearl-design-layer-pick-highlight';
            highlight.style.cssText = [
                'position: fixed',
                'pointer-events: none',
                'z-index: 2147483647',
                'box-sizing: border-box',
                'border: 2px solid #3b82f6',
                'border-radius: 2px',
                'background: rgba(59,130,246,0.08)',
                'transition: top 120ms, left 120ms, width 120ms, height 120ms',
                'display: none',
            ].join(';');
            document.documentElement.appendChild(highlight);
            const isOwn = (el) => el === this.svgWrapper || !!this.svgWrapper?.contains(el) || !!this.cropOverlay?.contains(el) || el === highlight;
            // Track the currently highlighted element so touchend can confirm it
            let hoveredElement = null;
            let rafPending = false;
            let pendingTarget = null;
            const flushHighlight = () => {
                rafPending = false;
                const el = pendingTarget;
                if (!el)
                    return;
                hoveredElement = el;
                const r = el.getBoundingClientRect();
                highlight.style.top = `${r.top}px`;
                highlight.style.left = `${r.left}px`;
                highlight.style.width = `${r.width}px`;
                highlight.style.height = `${r.height}px`;
                highlight.style.display = 'block';
            };
            const updateHighlight = (el) => {
                pendingTarget = el;
                if (!rafPending) {
                    rafPending = true;
                    requestAnimationFrame(flushHighlight);
                }
            };
            const selectElement = (target) => {
                const selector = this.generateSelector(target);
                this.stopPickingMode();
                this.updateLayer({ ...this.currentSettings, selector });
                this.persistSettings();
            };
            // pointermove: desktop hover + mobile initial drag
            document.addEventListener('pointermove', (e) => {
                const target = document.elementFromPoint(e.clientX, e.clientY);
                if (target && !isOwn(target))
                    updateHighlight(target);
            }, { capture: true, signal: ac.signal });
            // touchmove: mobile — preventDefault here is the only reliable way to stop
            // the browser from cutting off pointer events once it decides to scroll
            document.addEventListener('touchmove', (e) => {
                e.preventDefault();
                const touch = e.touches[0];
                if (!touch)
                    return;
                const target = document.elementFromPoint(touch.clientX, touch.clientY);
                if (target && !isOwn(target))
                    updateHighlight(target);
            }, { capture: true, passive: false, signal: ac.signal });
            // touchend: mobile — lift finger confirms the currently highlighted element
            document.addEventListener('touchend', (e) => {
                if (!e.cancelable || !hoveredElement)
                    return;
                e.preventDefault();
                e.stopPropagation();
                selectElement(hoveredElement);
            }, { capture: true, passive: false, signal: ac.signal });
            // contextmenu: suppress long-press menu in mobile emulation
            document.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
            }, { capture: true, signal: ac.signal });
            // click: desktop confirmation
            document.addEventListener('click', (e) => {
                const target = document.elementFromPoint(e.clientX, e.clientY);
                if (!target || isOwn(target))
                    return;
                e.preventDefault();
                e.stopPropagation();
                selectElement(target);
            }, { capture: true, signal: ac.signal });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape')
                    this.stopPickingMode();
            }, { capture: true, signal: ac.signal });
        }
        stopPickingMode() {
            if (!this.isPickingMode)
                return;
            this.isPickingMode = false;
            if (this.svgWrapper) this.svgWrapper.style.pointerEvents = this.currentSettings?.locked ? 'none' : 'auto';
            this.updateCropHandles();
            this.scheduleStateEvent();
            this.pickAbortController?.abort();
            this.pickAbortController = null;
            document.getElementById('mearl-design-layer-pick-highlight')?.remove();
            document.getElementById('mearl-design-layer-pick-style')?.remove();
            document.getElementById('mearl-design-layer-pick-hint')?.remove();
            this.pickHintEl = null;
        }
        generateSelector(el) {
            if (el === document.body)
                return 'body';
            const parts = [];
            let current = el;
            while (current && current !== document.documentElement) {
                if (current === document.body) {
                    parts.unshift('body');
                    break;
                }
                // Unique ID → short-circuit
                if (current.id && !/^\d/.test(current.id)) {
                    parts.unshift(`#${CSS.escape(current.id)}`);
                    break;
                }
                let part = current.tagName.toLowerCase();
                // Add stable class names (skip hash-like generated names)
                const classes = Array.from(current.classList)
                    .filter((c) => c && !c.startsWith('mearl-design-layer-') && !/^[a-z0-9]{6,}$/i.test(c))
                    .slice(0, 2);
                if (classes.length)
                    part += '.' + classes.map((c) => CSS.escape(c)).join('.');
                // nth-of-type to disambiguate siblings
                const parent = current.parentElement;
                if (parent) {
                    const same = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
                    if (same.length > 1)
                        part += `:nth-of-type(${same.indexOf(current) + 1})`;
                }
                parts.unshift(part);
                current = current.parentElement;
            }
            return parts.join(' > ') || 'body';
        }
    }
    if (window.__mearlDesignOverlay)
        return window.__mearlDesignOverlay;
    const instance = new DesignLayerOverlay();
    const api = { handle: message => instance.handle(message), state: () => {
        instance.emitStateEvent();
        return instance.getState();
    }, destroy: () => {
        instance.destroy();
        if (window.__mearlDesignOverlay === api) delete window.__mearlDesignOverlay;
    } };
    window.__mearlDesignOverlay = api;
    window.addEventListener('resize', () => instance.scheduleStateEvent(), { signal: instance.dragAbortController.signal });
    window.addEventListener('beforeunload', () => api.destroy(), { once: true, signal: instance.dragAbortController.signal });
    return api;
}
