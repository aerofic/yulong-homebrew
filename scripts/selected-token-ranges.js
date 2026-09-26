import { collectTokenRanges } from "./range-data.js";
import { squareRangeOutline } from "./range-geometry.js";
import { groupRangeFeatures, coloredRangeSegments, gridlessRangeSegments } from "./range-colors.js";

const MODULE_ID = "yulong-homebrew";
export const SELECTED_TOKEN_RANGES = "selectedTokenRanges";
const chinese = game => /^(cn|zh)(?:-|$)/i.test(game.i18n.lang);
const labels = game => chinese(game)
    ? { reach: "触及", self: "自身范围", increment: "射程增量", range: "射程", base: "基础触及" }
    : { reach: "Reach", self: "Self area", increment: "Range increment", range: "Range", base: "Base reach" };

// Foundry V14.367: canvas.interface.grid.highlight is a PIXI Container.
// PF2e 8.5.1: Token.distanceTo(Point, {reach}) measures from mechanicalBounds
// to the nearest target square, including the PF2e 10-foot reach exception.
// No templates, flags, sockets, or world documents are created by this feature.
export function createSelectedTokenRangeController({ game, canvas, Hooks, PIXI, requestAnimationFrame, cancelAnimationFrame }) {
    let layer = null, frame = null, listening = false, enabled = false, cache = null;
    const subscriptions = [];
    function clear() {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        if (layer && !layer.destroyed) {
            layer.parent?.removeChild(layer);
            layer.destroy({ children: true });
        }
        layer = null;
    }
    function selected() {
        const tokens = canvas.tokens?.controlled ?? [];
        return tokens.length === 1 ? tokens[0] : null;
    }
    function render() {
        frame = null;
        clear();
        if (!enabled || !game.user?.isGM || !canvas.ready || game.system.id !== "pf2e") return;
        const original = selected();
        if (!original?.actor || original.destroyed || original.visible === false) return;
        const preview = canvas.tokens.preview?.children?.find(token => token.document?.id === original.document.id);
        const token = preview && !preview.destroyed ? preview : original;
        const parent = canvas.interface?.grid?.highlight;
        if (!parent || parent.destroyed) return;
        const grid = canvas.grid;
        // Only square and gridless geometry are supported; do not imply an
        // inaccurate hex-grid rules boundary. PF2e uses square grids normally.
        if (![0, 1].includes(grid.type) || !(grid.distance > 0) || !(grid.sizeX > 0)) return;
        const bounds = token.mechanicalBounds;
        if (!bounds) return;
        if (!cache || cache.actor !== original.actor) cache = {
            actor: original.actor,
            ranges: collectTokenRanges(original.actor, { localize: key => game.i18n.localize(key), baseLabel: labels(game).base })
        };
        if (!cache.ranges.length) return;
        layer = parent.addChild(new PIXI.Container());
        layer.name = "yulong-homebrew-selected-token-ranges";
        layer.eventMode = "none";
        layer.interactiveChildren = false;
        const unit = Math.max(1, Math.min(2, grid.sizeX / 100));
        let previousLabelY = -Infinity;
        // Largest first: smaller outlines stay legible where boundaries meet.
        for (const range of groupRangeFeatures(cache.ranges, grid.type)) {
            const graphics = new PIXI.Graphics();
            graphics.eventMode = "none";
            let position, segments;
            if (grid.type === 1 && typeof token.distanceTo === "function") {
                const outline = squareRangeOutline({ grid, bounds, distance: range.distance,
                    measure: point => token.distanceTo(point, { reach: range.reach }) });
                if (!outline) { graphics.destroy(); continue; }
                segments = outline.segments;
                position = outline.label;
            } else if (grid.type === 0) {
                // Gridless is a geometric planar reference from the occupied
                // rectangle's edge, not a claim about grid-square eligibility.
                const radius = range.distance / grid.distance * grid.sizeX;
                segments = gridlessRangeSegments(bounds, radius);
                position = { x: bounds.x + bounds.width / 2, y: bounds.y - radius };
            } else { graphics.destroy(); continue; }
            const colors = [...new Set(range.features.map(feature => feature.color))];
            for (const { a, b, color } of coloredRangeSegments(segments, colors, grid.sizeX / 4)) {
                graphics.lineStyle(unit, color, 0.25);
                graphics.moveTo(a.x, a.y).lineTo(b.x, b.y);
            }
            layer.addChild(graphics);
            for (const feature of range.features) {
                const compactName = feature.name.length > 48 ? `${feature.name.slice(0, 45)}…` : feature.name;
                const text = new PIXI.Text(`${range.distance} ft · ${labels(game)[feature.kind]} · ${compactName}`, {
                    fontFamily: "sans-serif", fontSize: 11 * unit, fill: feature.color, stroke: 0x111111,
                    strokeThickness: 2, align: "center"
                });
                text.eventMode = "none";
                text.alpha = 0.55;
                text.anchor.set(0.5, 1);
                const y = Math.max(position.y - 3 * unit, previousLabelY + 14 * unit);
                text.position.set(position.x, y);
                previousLabelY = y;
                layer.addChild(text);
            }
        }
    }
    function schedule() {
        if (!enabled || !game.user?.isGM || frame !== null) return;
        frame = requestAnimationFrame(() => {
            try { render(); }
            catch (error) { clear(); console.warn("Yulong Homebrew | Could not render selected token ranges.", error); }
        });
    }
    function invalidate() { cache = null; schedule(); }
    function relevantActor(actor) {
        const current = selected()?.actor;
        return current && (actor === current || (actor?.uuid && actor.uuid === current.uuid)
            || (current.isToken && actor?.uuid === current.token?.baseActor?.uuid));
    }
    function on(event, callback) { subscriptions.push([event, Hooks.on(event, callback)]); }
    function start() {
        if (listening) return;
        listening = true;
        on("controlToken", invalidate);
        on("refreshToken", (token, flags = {}) => {
            const current = selected();
            if (current && token.document?.id === current.document?.id
                && (flags.refreshPosition || flags.refreshSize || flags.refreshVisibility || flags.refreshState)) schedule();
        });
        on("drawToken", token => { if (token.document?.id === selected()?.document?.id) schedule(); });
        on("destroyToken", () => { clear(); invalidate(); });
        on("updateActor", actor => { if (relevantActor(actor)) invalidate(); });
        for (const event of ["createItem", "updateItem", "deleteItem"]) on(event, item => { if (relevantActor(item.parent)) invalidate(); });
        on("updateToken", doc => { if (doc.id === selected()?.document?.id) invalidate(); });
        on("updateScene", scene => { if (scene.id === canvas.scene?.id) invalidate(); });
        on("canvasReady", invalidate);
        on("canvasTearDown", () => { clear(); cache = null; });
        on("updateUser", user => { if (user.id === game.user?.id && !user.isGM) setEnabled(false); });
    }
    function setEnabled(value) {
        enabled = Boolean(value && game.user?.isGM && game.system.id === "pf2e");
        if (enabled) { start(); invalidate(); }
        else {
            for (const [event, id] of subscriptions.splice(0)) Hooks.off(event, id);
            listening = false; cache = null; clear();
        }
    }
    return { setEnabled, destroy: () => setEnabled(false) };
}

let controller;
Hooks.once("init", () => {
    const zh = chinese(game);
    game.settings.register(MODULE_ID, SELECTED_TOKEN_RANGES, {
        name: zh ? "选中生物时显示范围线（仅 GM）" : "Selected creature range outlines (GM only)",
        hint: zh ? "仅本机 GM：单选生物时，以淡色轮廓显示触及、自身范围和远程武器射程。5 尺及以下触及不显示；轮廓不判断墙壁、掩护或高差，且不影响原生灵光。"
            : "Local GM only: faint outlines for one selected creature's reach, self areas and ranged weapons. Reach of 5 ft or less is omitted. Outlines do not test walls, cover or elevation, and do not alter native auras.",
        scope: "client", config: true, type: Boolean, default: false,
        onChange: value => controller?.setEnabled(value)
    });
});
Hooks.once("ready", () => {
    if (!game.user?.isGM || game.system.id !== "pf2e") return;
    controller = createSelectedTokenRangeController({ game, canvas, Hooks, PIXI, requestAnimationFrame, cancelAnimationFrame });
    controller.setEnabled(game.settings.get(MODULE_ID, SELECTED_TOKEN_RANGES));
});
