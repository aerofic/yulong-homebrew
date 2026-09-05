import fs from 'node:fs';
import vm from 'node:vm';
import * as statistics from '../../scripts/statistics.js';
import * as safety from '../../scripts/runtime-safety.js';

const source = fs.readFileSync(new URL('../../scripts/compat.js', import.meta.url), 'utf8')
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*"[^"]+";\s*/gm, '');
const getProperty = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
export function environment() {
    let sequence = 0;
    const wrappers = new Map(), hooks = new Map(), documents = new Map(), settings = new Map();
    const gm = { id: 'gm', isGM: true, active: true };
    const player = { id: 'player', isGM: false, active: false };
    const socket = { sent: [], on() {}, emit(...args) { this.sent.push(args); } };
    const game = {
        user: gm, users: { activeGM: gm, contents: [gm, player], get: id => [gm, player].find(u => u.id === id) },
        actors: { get: () => null }, scenes: { get: () => null },
        modules: { get: id => ({ active: ['lib-wrapper', 'patreon-v3'].includes(id) }) },
        settings: { get: (namespace, key) => settings.get(`${namespace}.${key}`) ?? (key === 'incapacitation' ? 'bloodied' : key === 'lowHpIncapacitationPercent' ? 25 : true), register() {} },
        i18n: { localize: key => key }, system: { id: 'pf2e' }, combat: null,
        pf2e: { Check: { roll() {} } }, socket,
    };
    const c = vm.createContext({
        ...statistics, ...safety, console, game, Set, Map, WeakMap, Proxy, Reflect, Promise, Date, Number, Array,
        window: { yulongHomebrew: {} }, canvas: { scene: null },
        Hooks: { once: (name, fn) => hooks.set(name, fn), on: () => ++sequence, events: {} },
        libWrapper: { register: (id, path, fn, type) => wrappers.set(path, { fn, type }) },
        CONFIG: { Actor: { documentClass: class { applyDamage() {} calculateHealthDelta() {} } } },
        foundry: { utils: { getProperty, randomID: () => `id${++sequence}`, deepClone: structuredClone,
            mergeObject: (a, b) => ({ ...a, ...b }) } },
        document: { body: { addEventListener() {} }, createElement: () => ({ classList: { add() {} }, textContent: '' }) },
        ui: { notifications: { warn() {}, info() {} } },
        fromUuidSync: uuid => documents.get(uuid) ?? null,
        fromUuid: async uuid => documents.get(uuid) ?? null,
    });
    vm.runInContext(source, c, { filename: 'compat.js' });
    return { c, wrappers, documents, settings, hooks, player, gm };
}

export function creditActor({ uuid = 'Actor.pc', ownership = { player: 3 }, flags = {}, write = async () => {} } = {}) {
    return {
        id: uuid.split('.').at(-1), uuid, name: 'PC', type: 'character', ownership, isOwner: true, flags,
        canUserModify: user => user.isGM,
        testUserPermission: user => user.isGM || Number(ownership[user.id] ?? ownership.default ?? 0) >= 3,
        getFlag: (namespace, key) => flags[key],
        async setFlag(namespace, key, value) { await write(key, value); flags[key] = value; },
    };
}

export function parser(c) {
    const p = {};
    c.installToolbeltCompatOn(p);
    return p;
}
