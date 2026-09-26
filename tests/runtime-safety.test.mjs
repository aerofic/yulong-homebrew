import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { environment, creditActor, parser } from './helpers/compat-environment.mjs';
import { createDocumentQueue, matchesActorReference, isPrimaryItemUseMessage } from '../scripts/runtime-safety.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const counter = { id: 'achievement', flag: 'progress', target: 100, progressable: true, automationHookId: 'monster_killed_any' };
const flagActor = options => creditActor({ flags: { achievement: false, progress: 0 }, ...options });

test('removed presentation features have no runtime entry points or assets', () => {
    const root = new URL('../', import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(new URL('module.json', root)));
    assert.equal(manifest.styles, undefined);
    assert.equal(manifest.languages, undefined);
    assert.equal(manifest.relationships.recommends.some(m => m.id === 'pf2e-hud'), false);
    const code = fs.readFileSync(new URL('scripts/compat.js', root), 'utf8');
    assert.doesNotMatch(code, /obfuscat|hideEnemyCheckTotals|DiscreteHealth|yulongOriginalHue|patreonIncapacitationSuppressionDepth|game.settings.get\s*=/i);
    for (const path of ['scripts/enemy-check-obfuscation.js', 'styles/enemy-check-obfuscation.css', 'lang/en.json', 'lang/zh-CN.json']) assert.equal(fs.existsSync(new URL(path, root)), false);
});

test('queue serializes UUID copies, runs other actors independently, recovers from rejection', async () => {
    const queue = createDocumentQueue(), gate = Promise.withResolvers(), seen = [];
    const a = queue({ uuid: 'Actor.a' }, async () => { seen.push('a'); await gate.promise; throw Error('test'); });
    const rejection = assert.rejects(a, /test/);
    const b = queue({ uuid: 'Actor.a' }, () => seen.push('b'));
    await queue({ uuid: 'Actor.b' }, () => seen.push('other'));
    assert.deepEqual(seen, ['a', 'other']);
    gate.resolve(); await Promise.all([rejection, b]);
    assert.deepEqual(seen, ['a', 'other', 'b']);
    await queue({ uuid: 'Actor.a' }, () => seen.push('c'));
    assert.equal(seen.at(-1), 'c');
});

function troopEnvironment() {
    const env = environment(), { c, wrappers } = env;
    c.getTroopAreaWeaknessAdvisorContext = () => null;
    c.installTroopDamageHouseRules();
    const delta = wrappers.get('CONFIG.Actor.documentClass.prototype.calculateHealthDelta').fn;
    const apply = wrappers.get('CONFIG.Actor.documentClass.prototype.applyDamage').fn;
    const original = function(args) { return { totalApplied: args.delta }; };
    const actor = Object.assign(Object.create({ calculateHealthDelta: original }), {
        uuid: 'Actor.troop', system: { attributes: { hp: { value: 200, max: 200 } }, traits: { value: ['troop'] } }
    });
    const run = (params, gate = Promise.resolve(), error = false) => apply.call(actor, async p => {
        await gate;
        if (error) throw Error('application failed');
        const result = delta.call(actor, args => original.call(actor, args), { delta: p.damage });
        return { ...result, breakdown: p.breakdown };
    }, params);
    return { ...env, actor, original, delta, run };
}

test('configurable troop cap defaults to 1/20 and preserves rounding and minimum damage', () => {
    const { c, settings } = environment();
    const actor = { hitPoints: { max: 201 } };
    assert.equal(c.getTroopSingleTargetDamageCap(actor), 11);
    for (const [denominator, expected] of [[10, 21], [5, 41], [2.5, 81], [1, 201], [1000, 1]]) {
        settings.set('yulong-homebrew.troopSingleTargetDamageCapDenominator', denominator);
        assert.equal(c.getTroopSingleTargetDamageCap(actor), expected);
    }
    for (const value of [0, -1, 0.5, NaN, Infinity, true, '10']) {
        settings.set('yulong-homebrew.troopSingleTargetDamageCapDenominator', value);
        assert.equal(c.getTroopSingleTargetDamageCap(actor), 11);
    }
    c.game.settings.get = () => { throw Error('missing setting'); };
    assert.equal(c.getTroopSingleTargetDamageCap(actor), 11);
    assert.equal(c.getTroopSingleTargetDamageCap({ hitPoints: { max: 0 } }), null);
});

test('configured cap changes next application without capping area, final or healing; toggle still disables', async () => {
    const { run, settings } = troopEnvironment();
    settings.set('yulong-homebrew.troopSingleTargetDamageCapDenominator', 5);
    assert.equal((await run({ damage: 100 })).totalApplied, 40);
    settings.set('yulong-homebrew.troopSingleTargetDamageCapDenominator', 10);
    assert.equal((await run({ damage: 100 })).totalApplied, 20);
    assert.equal((await run({ damage: 7 })).totalApplied, 7);
    assert.equal((await run({ damage: 100, rollOptions: new Set(['area-damage']) })).totalApplied, 100);
    assert.equal((await run({ damage: 100, final: true })).totalApplied, 100);
    assert.equal((await run({ damage: -100 })).totalApplied, -100);
    settings.set('yulong-homebrew.troopHouseRulesEnabled', false);
    assert.equal((await run({ damage: 100 })).totalApplied, 100);
});

test('denominator is registered as a world-scoped validated number with default 20', () => {
    const { c } = environment(); const registered = new Map();
    c.game.settings.register = (namespace, key, config) => registered.set(key, config);
    c.foundry.data = { fields: { NumberField: class { constructor(options) { this.options = options; } } } };
    c.registerHomebrewSettings();
    const config = registered.get('troopSingleTargetDamageCapDenominator');
    assert.equal(config.scope, 'world'); assert.equal(config.default, 20);
    assert.equal(config.type.options.min, 1); assert.equal(config.type.options.nullable, false);
    assert.equal(config.type.options.required, true);
    assert.doesNotMatch(registered.get('troopHouseRulesEnabled').hint, /1\/20/);
});

test('F03 simultaneous single-target, area, final and healing applications stay separate', async () => {
    const { run, actor, original } = troopEnvironment(), gate = Promise.withResolvers();
    const a = run({ damage: 100 }, gate.promise);
    const b = run({ damage: 100, rollOptions: new Set(['area-damage']) });
    const f = run({ damage: 100, final: true });
    const h = run({ damage: -100 });
    gate.resolve();
    const results = await Promise.all([a, b, f, h]);
    assert.deepEqual(results.map(r => r.totalApplied), [10, 100, 100, -100]);
    assert.equal(results[0].breakdown.length, 1);
    assert.equal(results[1].breakdown.length, 0);
    assert.equal(actor.calculateHealthDelta, original);
    assert.equal(Object.hasOwn(actor, 'calculateHealthDelta'), false);
});

test('F03 throwing applyDamage leaves no cap or poisoned queue', async () => {
    const { run, actor, delta, original } = troopEnvironment();
    await assert.rejects(run({ damage: 100 }, Promise.resolve(), true), /application failed/);
    assert.equal(delta.call(actor, original, { delta: 100 }).totalApplied, 100);
    assert.equal((await run({ damage: 100, final: true })).totalApplied, 100);
});

test('F03 successful area advisory captures only its own application', async () => {
    const { c, run } = troopEnvironment(), cards = [];
    c.getTroopAreaWeaknessAdvisorContext = () => ({ actorName: 'Troop' });
    c.createTroopAreaWeaknessAdvisorMessage = async card => cards.push(card);
    await Promise.all([run({ damage: 100 }), run({ damage: 80, rollOptions: new Set(['area-damage']) })]);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].damage, 80);
});

const adjustment = label => ({ adjustments: { all: { amount: 1, label } } });
test('F05 low-HP check never changes global settings or a concurrent normal check', async () => {
    const { c, wrappers } = environment();
    c.installPF2eCheckRollWrapper();
    const wrapped = wrappers.get('game.pf2e.Check.roll').fn;
    const gate = Promise.withResolvers(), get = c.game.settings.get;
    const make = hp => ({ actor: { system: { attributes: { hp: { value: hp, max: 100 } } } },
        options: new Set(['incapacitation']), dosAdjustments: [adjustment('PF2E.TraitIncapacitation')] });
    const low = make(10), normal = make(80);
    const patreon = (check, context) => {
        if (c.game.settings.get('patreon-v3', 'incapacitation') === 'bloodied') {
            context.rollTwice = 'keep-higher';
            context.dosAdjustments.push(adjustment('PF2E.TraitIncapacitation'));
        }
        return (async () => { const twice = context.rollTwice; await gate.promise; return { twice, adjustments: context.dosAdjustments }; })();
    };
    const a = wrapped(patreon, {}, low), b = wrapped(patreon, {}, normal);
    assert.equal(c.game.settings.get, get);
    assert.equal(get('patreon-v3', 'incapacitation'), 'bloodied');
    gate.resolve();
    const [x, y] = await Promise.all([a, b]);
    assert.equal(x.twice, undefined); assert.equal(x.adjustments.length, 0);
    assert.equal(y.twice, 'keep-higher'); assert.ok(y.adjustments.length > 0);
    assert.ok(low.options.has('incapacitation'));
});

for (const baseline of ['keep-higher', 'keep-lower', false, undefined]) test(`F05 preserves pre-existing fortune/misfortune (${baseline}) and dialog choices`, async () => {
    const { c } = environment();
    const context = { rollTwice: baseline, dosAdjustments: [adjustment('another-feature')] };
    const task = c.rollWithoutPatreonIncapacitation(context, async scoped => {
        scoped.rollTwice = 'keep-higher';
        assert.equal(scoped.rollTwice, baseline);
        await Promise.resolve();
        scoped.rollTwice = 'keep-higher';
    });
    await task;
    assert.equal(context.rollTwice, 'keep-higher');
    assert.equal(context.dosAdjustments[0].adjustments.all.label, 'another-feature');
});

test('F05 synchronous throw does not strand a global override', () => {
    const { c } = environment(), get = c.game.settings.get;
    assert.throws(() => c.rollWithoutPatreonIncapacitation({}, () => { throw Error('failed'); }), /failed/);
    assert.equal(c.game.settings.get, get);
});

test('F08 synthetic Actor identities never fall back to the common base id', () => {
    const a = { id: 'base', uuid: 'Scene.s.Token.a.Actor.base' };
    const b = { id: 'base', uuid: 'Scene.s.Token.b.Actor.base' };
    assert.equal(matchesActorReference({ targetActorId: 'base', targetActorUuid: a.uuid }, b), false);
    assert.equal(matchesActorReference({ targetActorId: 'base', targetUuid: a.uuid }, b), false);
    assert.equal(matchesActorReference({ targetActorUuid: a.uuid }, a), true);
    const { c } = environment(), p = parser(c);
    p.pushRecentHpChange(a, { id: 'hp', applicationId: 'damage', completed: true, amount: 10, delta: 10, previousHp: 10, currentHp: 0, actor: a, timestamp: Date.now() });
    assert.equal(p.peekRecentHpChange(b), null);
    assert.equal(p.consumeRecentHpChange({ actor: b }, 10, false, { requireRecent: true }), null);
    assert.equal(p.consumeRecentHpChange({ actor: a }, 10, false, { requireRecent: true }).currentHp, 0);
    assert.equal(p.peekRecentHpChange(a), null);
});

test('F08 pending damage sources for two targets survive concurrent application', () => {
    const { c } = environment();
    c.game.modules.get = () => ({ active: true });
    const p = parser(c), sourceA = flagActor(), sourceB = flagActor({ uuid: 'Actor.other' });
    const a = { id: 'base', uuid: 'Scene.s.Token.a.Actor.base' }, b = { id: 'base', uuid: 'Scene.s.Token.b.Actor.base' };
    c.recordPendingAwaPF2eDamageSourceContext({ targetActor: a, sourceActor: sourceA });
    c.recordPendingAwaPF2eDamageSourceContext({ targetActor: b, sourceActor: sourceB });
    assert.equal(p.consumePendingAwaPF2eDamageSource(a).sourceActor, sourceA);
    assert.equal(p.consumePendingAwaPF2eDamageSource(b).sourceActor, sourceB);
});

test('F08 missing exact actor reference does not resolve to its base actor', () => {
    const { c } = environment();
    c.game.actors.get = () => ({ id: 'base' });
    assert.equal(c.getTroopAreaWeaknessTarget({ actorId: 'base', actorUuid: 'Scene.deleted.Token.a.Actor.base' }).actor, null);
});

test('F09 use card counts once; derived damage, attack and applied cards do not', async () => {
    const { c } = environment(), p = parser(c), actor = flagActor();
    p.getAchievementsApi = () => ({ getAchievements: () => [{ ...counter, automationHookId: 'item_used_name', itemFilter: 'wand' }] });
    const message = { id: 'use', actor, item: { name: 'Wand', type: 'equipment' }, flags: { pf2e: {} } };
    await p.applyAwaPF2eItemAchievements(message);
    for (const type of ['damage-roll', 'attack-roll', 'spell-attack-roll', 'damage-taken', 'saving-throw']) {
        await p.applyAwaPF2eItemAchievements({ ...message, id: type, flags: { pf2e: { context: { type } } } });
    }
    await p.applyAwaPF2eItemAchievements(message);
    assert.equal(actor.flags.progress, 1);
    await p.applyAwaPF2eItemAchievements({ ...message, id: 'second-use' });
    assert.equal(actor.flags.progress, 2);
});

test('F09 preserves PF2e Consumable.consume healing roll with no context', () => {
    assert.equal(isPrimaryItemUseMessage({ rolls: [{ total: 12 }], flags: { pf2e: { origin: { type: 'consumable' } } } }), true);
    assert.equal(isPrimaryItemUseMessage({ flags: { pf2e: { appliedDamage: { damage: 12 } } } }), false);
});

test('F10 overlapping increments are accumulated; completion is granted once', async () => {
    const { c } = environment(), gate = Promise.withResolvers(), actor = flagActor({ write: () => gate.promise });
    let grants = 0;
    const api = { async grantAchievement() { grants++; actor.flags.achievement = true; } };
    const tasks = Array.from({ length: 5 }, () => c.advanceAwaCounterAchievement(api, actor, { ...counter, target: 3 }));
    gate.resolve(); await Promise.all(tasks);
    assert.equal(actor.flags.progress, 3); assert.equal(grants, 1);
});

test('F10 simultaneous kill and one-time awards serialize read/modify/write', async () => {
    const { c } = environment(), p = parser(c), actor = flagActor();
    let grants = 0;
    const api = { getAchievements: () => [counter], async grantAchievement() { grants++; actor.flags.achievement = true; } };
    await Promise.all(Array.from({ length: 8 }, () => p.applyMonsterKilledAchievementHooks(api, actor, { type: 'npc' })));
    assert.equal(actor.flags.progress, 8);
    api.getAchievements = () => [{ ...counter, automationHookId: 'damage_one_time', target: 10 }];
    await Promise.all([p.applyOneTimeAchievementHooks(api, actor, 'damage_one_time', 20), p.applyOneTimeAchievementHooks(api, actor, 'damage_one_time', 20)]);
    assert.equal(grants, 1);
});

test('F10 AWA API GM-side progress requests share the same Actor queue', async () => {
    const { c, wrappers } = environment(), actor = flagActor();
    c.game.modules.get = () => ({ active: true });
    c.window.AchievementsAPI = { triggerProgressAchievements() {} };
    c.installAchievementWriteQueue();
    const wrapper = wrappers.get('window.AchievementsAPI.triggerProgressAchievements').fn;
    const native = async (hook, target, amount) => { const value = target.flags.progress; await tick(); target.flags.progress = value + amount; };
    await Promise.all([wrapper(native, 'damage_progressable', actor, 4), wrapper(native, 'damage_progressable', actor, 6)]);
    assert.equal(actor.flags.progress, 10);
    c.game.users.activeGM = { id: 'another-gm' };
    await wrapper(native, 'damage_progressable', actor, 5);
    assert.equal(actor.flags.progress, 10);
});

test('F10 player counters are forwarded, never written locally', async () => {
    const { c, player } = environment(), actor = flagActor(); c.game.user = player;
    await c.advanceAwaCounterAchievement({}, actor, counter);
    assert.equal(actor.flags.progress, 0);
    assert.equal(c.game.socket.sent.length, 1);
    assert.equal(c.game.socket.sent[0][0], 'module.yulong-homebrew');
});

test('F10 a failed write does not block subsequent increments', async () => {
    const { c } = environment(); let fail = true;
    const actor = flagActor({ write: async () => { if (fail) { fail = false; throw Error('write rejected'); } } });
    const rejected = assert.rejects(c.advanceAwaCounterAchievement({}, actor, counter), /write rejected/);
    const next = c.advanceAwaCounterAchievement({}, actor, counter);
    await Promise.all([rejected, next]);
    assert.equal(actor.flags.progress, 1);
});

test('F10 authenticated socket validation, idempotency and GM serialization', async () => {
    const { c, documents } = environment(), actor = flagActor();
    c.game.modules.get = () => ({ active: true });
    c.window.AchievementsAPI = { getAchievements: () => [counter] };
    documents.set(actor.uuid, actor);
    const request = { kind: 'counter', requestId: 'r', actorUuid: actor.uuid, achievementId: counter.id, amount: 1 };
    await Promise.all([c.handleAchievementRequest(request, 'player'), c.handleAchievementRequest(request, 'player'), c.handleAchievementRequest({ ...request, requestId: 's' }, 'player')]);
    assert.equal(actor.flags.progress, 2);
    await c.handleAchievementRequest({ ...request, requestId: 'spoofed', userId: 'gm' }, 'missing-user');
    await c.handleAchievementRequest({ ...request, requestId: 'arbitrary', amount: 999 }, 'player');
    actor.ownership.player = 2;
    await c.handleAchievementRequest({ ...request, requestId: 'not-owner' }, 'player');
    assert.equal(actor.flags.progress, 2);
});

for (const [ownership, eligible] of [[{ player: 0 }, false], [{ player: 1 }, false], [{ player: 2 }, false], [{ player: 3 }, true], [{ default: 3 }, true], [{ default: 3, player: 0 }, false]]) {
    test(`F11 actual OWNER permission ${JSON.stringify(ownership)} => ${eligible}`, () => {
        const { c } = environment(); assert.equal(c.canReceiveAwaCredit(creditActor({ ownership })), eligible);
    });
}

test('F12 earlier same-name same-round same-outcome save does not suppress a new roll', () => {
    const { c } = environment(), p = parser(c);
    const actor = { id: 'enemy', name: 'Enemy', uuid: 'Actor.enemy', system: {} };
    const token = { id: 't', uuid: 'Scene.s.Token.t', actor, name: 'Enemy' };
    p.getToolbeltTargetDocument = () => token;
    p.getHolodeckLedger = () => ({ ledger: { masterLog: [{ type: 'Save', source: 'Enemy', result: 'success', round: 1 }] } });
    const entry = { variantId: 'null', targetId: 't', outcome: 'success', save: { value: 25, die: 10 }, variant: { dc: 20 } };
    const one = p.buildToolbeltSaveMessage({ id: 'spell-a' }, { targets: [token] }, entry);
    const two = p.buildToolbeltSaveMessage({ id: 'spell-b' }, { targets: [token] }, entry);
    assert.ok(one); assert.ok(two);
    assert.notEqual(one.toolbeltCompat.saveKey, two.toolbeltCompat.saveKey);
    assert.equal(one.toolbeltCompat.saveKey, p.buildToolbeltSaveMessage({ id: 'spell-a' }, { targets: [token] }, entry).toolbeltCompat.saveKey);
    const data = { targets: [token], saveVariants: { null: {} } }, parsed = [];
    p.getToolbeltData = () => data;
    p.getToolbeltSaveEntries = () => [entry];
    p.parseMessage = message => parsed.push(message);
    assert.equal(p.parseToolbeltSaveVariants({ id: 'spell-a' }), true);
    assert.equal(p.parseToolbeltSaveVariants({ id: 'spell-a' }), false);
    assert.equal(p.parseToolbeltSaveVariants({ id: 'spell-b' }), true);
    assert.equal(parsed.length, 2);
    entry.save = { ...entry.save, die: 15, value: 30, rerolled: 'hero' };
    assert.equal(p.parseToolbeltSaveVariants({ id: 'spell-a' }), true);
    assert.equal(parsed.length, 3);
});
