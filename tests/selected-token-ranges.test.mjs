import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { collectTokenRanges, explicitDescriptionRanges } from '../scripts/range-data.js';
import { squareRangeOutline } from '../scripts/range-geometry.js';

const actor = (extra = {}) => ({ type: 'npc', uuid: 'Actor.a', system: { attributes: { reach: { base: 5 } }, actions: [] }, items: [], auras: new Map(), ...extra });
const melee = (name, reach) => ({ type: 'melee', name, reach, isMelee: true });
const ranged = (name, increment, max) => ({ type: 'weapon', name, isRanged: true, range: { increment, max } });

test('prepared strikes retain individual reach, hide 5 ft and combine identical distances', () => {
    const a = actor(); a.system.attributes.reach.base = 15;
    a.system.actions = [melee('Jaws', 15), melee('Paddle', 10), melee('Fist', 5)].map(item => ({ item, ready: true }));
    a.getReach = ({ action, weapon }) => { assert.equal(action, 'attack'); return weapon.reach; };
    assert.deepEqual(collectTokenRanges(a), [
        { kind: 'reach', distance: 10, names: ['Paddle'] },
        { kind: 'reach', distance: 15, names: ['基础触及', 'Jaws'] }
    ]);
});

test('ranged increments and prepared thrown alternates show without six-increment maxima', () => {
    const a = actor();
    a.system.actions = [
        { item: ranged('Bow', 100, 600), ready: true },
        { item: melee('Dagger', 5), altUsages: [{ item: ranged('Thrown dagger', 10, 60) }] },
        { item: ranged('Stowed bow', 30, 180), ready: false },
        { item: ranged('Fixed beam', null, 25) },
        { item: ranged('Short throw', 5, 30) }
    ];
    a.getReach = ({ weapon }) => weapon.reach;
    assert.deepEqual(collectTokenRanges(a).map(r => [r.kind, r.distance]), [
        ['increment', 5], ['increment', 10], ['range', 25], ['increment', 100]
    ]);
});

test('active prepared auras are authoritative and 5 ft self areas remain visible', () => {
    const a = actor();
    a.items = [
        { type: 'action', slug: 'fear', name: 'Fear Aura', system: { rules: [{ key: 'Aura' }], description: { value: '@Template[emanation|distance:30]' } } },
        { type: 'action', name: 'Inactive aura', system: { rules: [{ key: 'Aura' }], description: { value: '@Template[emanation|distance:60]' } } },
        { type: 'action', name: 'Pulse', system: { description: { value: '@Template[type:emanation|distance:5]' } } }
    ];
    a.auras.set('fear', { slug: 'fear', radius: 20 });
    assert.deepEqual(collectTokenRanges(a), [
        { kind: 'self', distance: 5, names: ['Pulse'] }, { kind: 'self', distance: 20, names: ['Fear Aura'] }
    ]);
});

test('description fallback accepts declared bilingual fields and localizations, not relative reach or bursts', () => {
    const text = '<p><strong>触及</strong> 15尺</p><p>Aura: 10 feet</p>@Localize[feature]';
    assert.deepEqual(explicitDescriptionRanges(text, () => '@Template[emanation|distance:20]'), [
        { kind: 'self', distance: 20 }, { kind: 'reach', distance: 15 }, { kind: 'self', distance: 10 }
    ]);
    assert.deepEqual(explicitDescriptionRanges('Increase reach by 10 feet. Targets within your reach 20 feet. @Template[burst|distance:30]'), []);
    assert.deepEqual(collectTokenRanges(actor({ type: 'hazard' })), []);
});

const grid = {
    type: 1, sizeX: 100, sizeY: 100, distance: 5,
    getOffset: ({ x, y }) => ({ i: Math.floor(y / 100), j: Math.floor(x / 100) }),
    getOffsetRange: ({ x, y, width, height }) => [Math.floor(y / 100), Math.floor(x / 100), Math.ceil((y + height) / 100), Math.ceil((x + width) / 100)],
    getCenterPoint: ({ i, j }) => ({ x: j * 100 + 50, y: i * 100 + 50 }),
    getTopLeftPoint: ({ i, j }) => ({ x: j * 100, y: i * 100 })
};
// PF2e square-grid distance from the nearest occupied square, with the
// independently selectable 10-foot melee-reach exception.
function measure(bounds, point, reach = null) {
    const { i, j } = grid.getOffset(point);
    const x = Math.max(bounds.x / 100 - j, j - (bounds.x + bounds.width) / 100 + 1, 0);
    const y = Math.max(bounds.y / 100 - i, i - (bounds.y + bounds.height) / 100 + 1, 0);
    const diagonal = Math.min(x, y);
    return (Math.floor(diagonal * 1.5) + Math.abs(x - y) - (reach === 10 && diagonal > 1 ? 1 : 0)) * 5;
}
const edgeKey = (a, b) => [JSON.stringify(a), JSON.stringify(b)].sort().join('|');
function unitEdges(segments) {
    const result = new Set();
    for (const [a, b] of segments) {
        const count = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / 100;
        for (let k = 0; k < count; k++) {
            const p = n => ({ x: a.x + (b.x - a.x) * n / count, y: a.y + (b.y - a.y) * n / count });
            const key = edgeKey(p(k), p(k + 1));
            assert.equal(result.has(key), false, 'no duplicate boundary segments'); result.add(key);
        }
    }
    return result;
}
function oracle(bounds, distance, reach) {
    const edges = new Set();
    for (let i = -15; i < 15; i++) for (let j = -15; j < 15; j++) {
        if (measure(bounds, grid.getCenterPoint({ i, j }), reach) > distance) continue;
        const corners = [[i, j], [i, j + 1], [i + 1, j + 1], [i + 1, j]].map(([i, j]) => grid.getTopLeftPoint({ i, j }));
        for (let k = 0; k < 4; k++) {
            const key = edgeKey(corners[k], corners[(k + 1) % 4]);
            if (edges.has(key)) edges.delete(key); else edges.add(key);
        }
    }
    return edges;
}

test('perimeters match independent filled-cell oracle for different sizes, offsets and reach modes', () => {
    for (const bounds of [{ x: 0, y: 0, width: 100, height: 100 }, { x: 300, y: -200, width: 200, height: 200 }, { x: -100, y: 200, width: 300, height: 200 }]) {
        for (const distance of [5, 10, 15, 30]) for (const reach of [null, distance]) {
            const outline = squareRangeOutline({ grid, bounds, distance, measure: p => measure(bounds, p, reach) });
            assert.deepEqual(unitEdges(outline.segments), oracle(bounds, distance, reach));
            assert.equal(outline.label.y, bounds.y - distance / 5 * 100);
        }
    }
});

test('2x2 footprint excludes own distance; ordinary diagonals differ from 10 ft melee reach', () => {
    const bounds = { x: 0, y: 0, width: 200, height: 200 };
    assert.equal(measure(bounds, { x: 150, y: 150 }), 0);
    assert.equal(measure(bounds, { x: 250, y: 150 }), 5);
    assert.equal(measure(bounds, { x: 350, y: 350 }), 15);
    assert.equal(measure(bounds, { x: 350, y: 350 }, 10), 10);
    const outline = squareRangeOutline({ grid, bounds, distance: 10, measure: p => measure(bounds, p) });
    assert.equal(Math.max(...outline.segments.flat().map(p => p.x)), 400);
});

test('long ranges use row searches instead of scanning the filled area and cap pathological input', () => {
    const bounds = { x: 0, y: 0, width: 100, height: 100 }; let calls = 0;
    assert.ok(squareRangeOutline({ grid, bounds, distance: 600, measure: p => { calls++; return measure(bounds, p); } }));
    assert.ok(calls < 4500, `measurements: ${calls}`);
    assert.equal(squareRangeOutline({ grid, bounds, distance: Infinity, measure: () => 0 }), null);
    assert.equal(squareRangeOutline({ grid, bounds, distance: 100000, measure: () => 0 }), null);
});

function environment() {
    let id = 0;
    const events = new Map(), frames = new Map(), measured = [];
    const Hooks = {
        once() {},
        on(event, fn) { const key = ++id; if (!events.has(event)) events.set(event, new Map()); events.get(event).set(key, fn); return key; },
        off(event, key) { events.get(event)?.delete(key); },
        call(event, ...args) { for (const fn of events.get(event)?.values() ?? []) fn(...args); }
    };
    class Container {
        children = []; destroyed = false;
        addChild(child) { this.children.push(child); child.parent = this; return child; }
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parent = null; }
        destroy({ children } = {}) { if (children) for (const child of this.children) child.destroy(); this.destroyed = true; }
    }
    class Graphics extends Container {
        segments = []; lineStyle(...args) { this.style = args; return this; }
        moveTo(x, y) { this.start = { x, y }; return this; }
        lineTo(x, y) { this.segments.push([this.start, { x, y }]); return this; }
        drawRoundedRect(...args) { this.rect = args; }
        beginFill() { assert.fail('must never fill range area'); }
    }
    class Text extends Container {
        constructor(text) { super(); this.text = text; }
        anchor = { set() {} }; position = { set() {} };
    }
    const a = actor(); a.system.attributes.reach.base = 10;
    a.auras.set('fear', { slug: 'fear', radius: 10 });
    a.system.actions = [{ item: ranged('Bow', 10, 60) }];
    const token = { document: { id: 't' }, actor: a, visible: true, mechanicalBounds: { x: 0, y: 0, width: 200, height: 200 },
        distanceTo(point, { reach }) { measured.push(reach); return measure(this.mechanicalBounds, point, reach); } };
    const canvas = { ready: true, scene: { id: 's' }, grid, tokens: { controlled: [token], preview: { children: [] } }, interface: { grid: { highlight: new Container() } } };
    const game = { user: { id: 'gm', isGM: true }, system: { id: 'pf2e' }, i18n: { lang: 'cn', localize: key => key } };
    const source = fs.readFileSync(new URL('../scripts/selected-token-ranges.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
    const context = vm.createContext({ collectTokenRanges, squareRangeOutline, Hooks, console });
    vm.runInContext(source, context);
    const controller = context.createSelectedTokenRangeController({ game, canvas, Hooks, PIXI: { Container, Graphics, Text },
        requestAnimationFrame(fn) { const key = ++id; frames.set(key, fn); return key; }, cancelAnimationFrame(key) { frames.delete(key); } });
    const flush = () => { const fns = [...frames.values()]; frames.clear(); fns.forEach(fn => fn()); };
    return { controller, canvas, game, Hooks, frames, events, measured, token, flush, parent: canvas.interface.grid.highlight };
}

test('controller renders noninteractive outline only; only reach requests the 10 ft exception', () => {
    const e = environment(); e.controller.setEnabled(true); e.flush();
    const layer = e.parent.children[0];
    assert.equal(layer.eventMode, 'none'); assert.equal(layer.interactiveChildren, false);
    assert.equal(layer.children.length, 6);
    const outlines = layer.children.filter(c => c.segments);
    assert.ok(outlines.every(g => g.style[2] === 0.25 && g.eventMode === 'none'));
    assert.equal(outlines.filter(g => unitEdges(g.segments).has(edgeKey({ x: 400, y: 300 }, { x: 400, y: 400 }))).length, 1);
    assert.deepEqual(new Set(e.measured), new Set([null, 10]));
    assert.ok(layer.children.some(c => c.text?.includes('触及')));
    assert.ok(layer.children.every(c => !c.text?.includes('最大射程')));
    e.controller.destroy(); assert.equal(layer.destroyed, true); assert.equal(e.parent.children.length, 0);
    assert.equal([...e.events.values()].reduce((n, m) => n + m.size, 0), 0);
});

test('player clients, disabled setting, multi-selection and deselection render nothing', () => {
    const e = environment(); e.flush(); assert.equal(e.parent.children.length, 0);
    e.game.user.isGM = false; e.controller.setEnabled(true); e.flush();
    assert.equal(e.parent.children.length, 0); assert.equal(e.events.size, 0);
    e.game.user.isGM = true; e.controller.setEnabled(true); e.flush();
    e.canvas.tokens.controlled.push({}); e.Hooks.call('controlToken'); e.flush(); assert.equal(e.parent.children.length, 0);
    e.canvas.tokens.controlled = []; e.Hooks.call('controlToken'); e.flush(); assert.equal(e.parent.children.length, 0);
});

test('refreshes coalesce, ignore other tokens, use drag preview and clean up on teardown', () => {
    const e = environment(); e.controller.setEnabled(true); e.flush();
    e.Hooks.call('refreshToken', { document: { id: 'other' } }, { refreshPosition: true }); assert.equal(e.frames.size, 0);
    e.Hooks.call('refreshToken', e.token, { refreshPosition: true });
    e.Hooks.call('refreshToken', e.token, { refreshPosition: true }); assert.equal(e.frames.size, 1);
    e.canvas.tokens.preview.children = [{ ...e.token, mechanicalBounds: { x: 500, y: 0, width: 200, height: 200 } }];
    e.flush(); assert.equal(Math.min(...e.parent.children[0].children[0].segments.flat().map(p => p.x)), 300);
    e.Hooks.call('canvasTearDown'); assert.equal(e.parent.children.length, 0); assert.equal(e.frames.size, 0);
});

test('actor/item updates invalidate cache, while demotion removes hooks and graphics', () => {
    const e = environment(); e.controller.setEnabled(true); e.flush();
    e.token.actor.system.attributes.reach.base = 20;
    e.Hooks.call('updateItem', { parent: e.token.actor }); e.flush();
    assert.ok(e.parent.children[0].children.some(c => c.text?.startsWith('20 ft')));
    e.Hooks.call('updateActor', { uuid: 'Actor.other' }); assert.equal(e.frames.size, 0);
    e.game.user.isGM = false; e.Hooks.call('updateUser', e.game.user);
    assert.equal(e.parent.children.length, 0);
    assert.equal([...e.events.values()].reduce((n, m) => n + m.size, 0), 0);
});
