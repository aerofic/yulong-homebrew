import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, parser } from './helpers/compat-environment.mjs';

const NS = 'yulong-homebrew';
const HP = 'system.attributes.hp.value';
const TEMP = 'system.attributes.hp.temp';
const SP = 'system.attributes.hp.sp.value';

function troopCard() {
    const env = environment(), { c } = env;
    c.escapeYulongHTML = value => String(value ?? '');
    const applications = [], writes = [];
    const actor = { uuid: 'Actor.troop', canUserModify: () => true,
        system: { traits: { value: ['troop'] }, attributes: { weaknesses: [{ type: 'area-damage', value: 10 }] } },
        async applyDamage(params) { applications.push(params); } };
    let card = { cardId: 'card', actorUuid: actor.uuid, rawDamage: 100, weakness: { value: 10 }, suggestedMultiplier: 4 };
    const message = { id: 'card', uuid: 'ChatMessage.card', canUserModify: () => true,
        getFlag: () => card,
        async update(data) { writes.push(data); card = structuredClone(data[`flags.${NS}.troopAreaWeakness`]); } };
    c.getTroopAreaWeaknessTarget = () => ({ actor, token: { uuid: 'Scene.s.Token.t' } });
    c.game.messages = new Map([['card', message]]);
    const request = (overrides = {}) => ({ kind: 'troop-area-action', messageId: 'card', action: 'apply', multiplier: 4,
        revision: Number(card.revision) || 0, weaknessValue: card.weakness.value, ...overrides });
    return { ...env, actor, message, applications, writes, request, card: () => card };
}

test('F01 concurrent card requests persist a lock before damage and execute once', async () => {
    const { c, actor, applications, writes, request, card } = troopCard();
    actor.applyDamage = async params => {
        assert.equal(card().processing, true);
        assert.equal(writes.length, 1);
        applications.push(params);
        await Promise.resolve();
    };
    await Promise.all([c.handleTroopAreaActionRequest(request(), 'gm'), c.handleTroopAreaActionRequest(request(), 'gm')]);
    assert.equal(applications.length, 1);
    assert.equal(card().executed, true);
    assert.equal(card().processing, false);
    assert.match(writes[0].content, /处理中/);
});

test('F01 stale apply cannot override ignore', async () => {
    const { c, applications, request, card } = troopCard();
    await Promise.all([c.handleTroopAreaActionRequest(request({ action: 'ignore' }), 'gm'), c.handleTroopAreaActionRequest(request(), 'gm')]);
    assert.equal(card().ignored, true);
    assert.equal(applications.length, 0);
});

test('F01 primary GM accepts authenticated second GM, rejects players and spoofed sender', async () => {
    const { c, request, applications } = troopCard();
    const get = c.game.users.get;
    c.game.users.get = id => id === 'gm2' ? { id, active: true, isGM: true } : get(id);
    await c.handleTroopAreaActionRequest(request({ senderId: 'gm' }), 'player');
    await c.handleTroopAreaActionRequest(request({ senderId: 'gm' }), 'missing');
    assert.equal(applications.length, 0);
    c.game.user = c.game.users.get('gm2');
    await c.handleTroopAreaActionRequest(request(), 'gm');
    assert.equal(applications.length, 0);
    c.game.user = get('gm');
    await c.handleTroopAreaActionRequest(request(), 'gm2');
    assert.equal(applications.length, 1);
});

test('F01 denied document permissions prevent writes', async () => {
    const { c, actor, message, applications, writes, request } = troopCard();
    actor.canUserModify = () => false;
    await c.handleTroopAreaActionRequest(request(), 'gm');
    actor.canUserModify = () => true;
    message.canUserModify = () => false;
    await c.handleTroopAreaActionRequest(request(), 'gm');
    assert.equal(applications.length + writes.length, 0);
});

for (const failure of ['lock', 'damage', 'completion']) test(`F01 ${failure} failure never permits ambiguous repeated damage`, async () => {
    const { c, actor, message, applications, request, card } = troopCard();
    const update = message.update;
    message.update = async data => {
        const next = data[`flags.${NS}.troopAreaWeakness`];
        if (failure === 'lock' || (failure === 'completion' && next.executed)) throw Error(failure);
        return update(data);
    };
    if (failure === 'damage') actor.applyDamage = async params => { applications.push(params); throw Error('damage'); };
    await assert.rejects(c.handleTroopAreaActionRequest(request(), 'gm'), new RegExp(failure));
    if (failure === 'lock') assert.equal(applications.length, 0);
    else {
        assert.equal(card().processing, true);
        await c.handleTroopAreaActionRequest(request(), 'gm');
        assert.equal(applications.length, 1);
    }
});

test('F05 changed weakness refreshes preview; stale concurrent requests cannot confirm it', async () => {
    const { c, actor, request, card, applications } = troopCard();
    actor.system.attributes.weaknesses[0].value = 20;
    const stale = request();
    await Promise.all([c.handleTroopAreaActionRequest(stale, 'gm'), c.handleTroopAreaActionRequest(stale, 'gm')]);
    assert.equal(applications.length, 0);
    assert.equal(card().weakness.value, 20);
    assert.equal(card().revision, 1);
    assert.equal(card().suggestedMultiplier, 4);
    await c.handleTroopAreaActionRequest(request(), 'gm');
    assert.equal(applications[0].damage, 60);
});

test('F05 removed weakness and raw damage not exceeding weakness never apply', async () => {
    for (const weakness of [null, 100, 101]) {
        const { c, actor, request, applications } = troopCard();
        actor.system.attributes.weaknesses = weakness === null ? [] : [{ type: 'area-damage', value: weakness }];
        await c.handleTroopAreaActionRequest(request(), 'gm');
        await c.handleTroopAreaActionRequest(request(), 'gm');
        assert.equal(applications.length, 0);
    }
});

test('F06 advisor works while single-target cap is disabled; its own toggle still disables it', () => {
    const { c, actor, settings } = troopCard();
    const params = { damage: 100, item: { system: { area: { type: 'burst', value: 120 } } } };
    settings.set(`${NS}.troopHouseRulesEnabled`, false);
    assert.equal(c.getTroopAreaWeaknessAdvisorContext(actor, params).suggestedMultiplier, 4);
    settings.set(`${NS}.troopAreaWeaknessAdvisorEnabled`, false);
    assert.equal(c.getTroopAreaWeaknessAdvisorContext(actor, params), null);
});

function damageEnvironment() {
    const env = environment(), { c, wrappers } = env;
    c.installTroopDamageHouseRules();
    const p = parser(c);
    const actor = { uuid: 'Actor.target', id: 'target', system: { attributes: { hp: { value: 100, max: 100, temp: 0 } } } };
    const apply = wrappers.get('CONFIG.Actor.documentClass.prototype.applyDamage').fn;
    const calculate = wrappers.get('CONFIG.Actor.documentClass.prototype.calculateHealthDelta').fn;
    const run = async ({ damage = 30, hp = 100, temp = 0, sp = 0, nextHp = 70, nextTemp = temp, nextSp = sp, beforeMessage } = {}) => {
        actor.system.attributes.hp = { value: hp, max: 100, temp, sp: { value: sp } };
        let message;
        await apply.call(actor, async () => {
            const updates = { [HP]: nextHp, [TEMP]: nextTemp, [SP]: nextSp };
            calculate.call(actor, () => ({ updates, totalApplied: damage }), { hp: actor.system.attributes.hp, sp: { value: sp }, delta: damage });
            p.recordRecentHpChange(actor, updates, { damageTaken: damage });
            actor.system.attributes.hp = { value: nextHp, max: 100, temp: nextTemp, sp: { value: nextSp } };
            await beforeMessage?.();
            const deltas = [[HP, hp - nextHp], [TEMP, temp - nextTemp], [SP, sp - nextSp]].filter(([, value]) => value !== 0).map(([path, value]) => ({ path, value }));
            message = { id: 'native', flags: { pf2e: { appliedDamage: { uuid: actor.uuid, updates: deltas, isHealing: damage < 0 } } },
                updateSource(data) { this.flags[NS] = { damageApplication: data[`flags.${NS}.damageApplication`] }; } };
            c.stampDamageApplication(message);
        }, { damage, final: true });
        return message;
    };
    return { ...env, p, actor, run };
}

test('F02 delayed Toolbelt apply is counted by native card only, regardless of click timeout', async () => {
    const { c, p, actor, run } = damageEnvironment();
    c.window.yulongHomebrew.pendingHolodeckDamageSource = { timestamp: Date.now() - 60000 };
    const message = await run();
    const summary = p.getAppliedDamageSummary(message.flags.pf2e.appliedDamage, message.flags[NS].damageApplication);
    assert.equal(summary.amount, 30);
    assert.equal(summary.trusted, true);
    assert.equal(p.peekRecentHpChange(actor).nativeMessageCreated, true);
    assert.equal(p.consumeRecentHpChange(actor, 30, false, { requireRecent: true }), null);
    p.getToolbeltTargetDocument = () => actor;
    assert.equal(p.buildToolbeltApplicationMessage({ id: 'roll', rolls: [{ total: 30 }] }, { targets: [] }, { targetId: actor.id, rollIndex: 0 }), null);
});

test('F03 manual HP edit and undo do not become damage application candidates', async () => {
    const { p, actor, run } = damageEnvironment();
    p.recordRecentHpChange(actor, { [HP]: 95 });
    assert.equal(p.peekRecentHpChange(actor), null);
    await run({ hp: 95, nextHp: 65 });
    p.recordRecentHpChange(actor, { [HP]: 95 });
    assert.equal(p.peekRecentHpChange(actor).amount, 30);
    assert.equal(p.consumeRecentHpChange(actor, 30, false, { requireRecent: true }), null);
});

test('F03 snapshots remain tied to their application despite later edits and identical subsequent hits', async () => {
    const { p, actor, run } = damageEnvironment();
    const first = await run({ hp: 100, nextHp: 70 });
    const second = await run({ hp: 70, nextHp: 40 });
    actor.system.attributes.hp.value = 0;
    for (const [message, previousHp, currentHp] of [[first, 100, 70], [second, 70, 40]]) {
        const summary = p.getAppliedDamageSummary(message.flags.pf2e.appliedDamage, message.flags[NS].damageApplication);
        assert.equal(summary.previousHp, previousHp);
        assert.equal(summary.currentHp, currentHp);
        assert.equal(summary.trusted, true);
    }
    p.pushRecentHpChange(actor, { id: 'unrelated', previousHp: 100, currentHp: 0, timestamp: Date.now() });
    const unrelated = p.getAppliedDamageSummary({ uuid: actor.uuid, updates: [{ path: HP, value: 5 }] });
    assert.equal(unrelated.trusted, false);
    assert.equal(unrelated.previousHp, undefined);
});

for (const scenario of [
    { damage: 30, hp: 100, temp: 10, sp: 5, nextHp: 85, nextTemp: 0, nextSp: 0, amount: 30 },
    { damage: 200, hp: 10, nextHp: 0, amount: 10 },
    { damage: -20, hp: 50, nextHp: 70, amount: 20 },
    { damage: 10, hp: 100, temp: 20, nextHp: 100, nextTemp: 10, amount: 10 }
]) test(`F03 exact HP/temp/SP and clamped damage snapshot ${JSON.stringify(scenario)}`, async () => {
    const { p, run } = damageEnvironment();
    const message = await run(scenario);
    const summary = p.getAppliedDamageSummary(message.flags.pf2e.appliedDamage, message.flags[NS].damageApplication);
    assert.equal(summary.amount, scenario.amount);
    assert.equal(summary.previousHp, scenario.hp);
    assert.equal(summary.currentHp, scenario.nextHp);
    assert.equal(summary.trusted, true);
    assert.equal(summary.isHealing, scenario.damage < 0);
});

test('F03 mismatched target/update snapshots are never trusted', async () => {
    const { p, run } = damageEnvironment();
    const message = await run(), applied = message.flags.pf2e.appliedDamage, snapshot = message.flags[NS].damageApplication;
    assert.equal(p.getAppliedDamageSummary({ ...applied, uuid: 'Actor.other' }, snapshot).trusted, false);
    assert.equal(p.getAppliedDamageSummary({ ...applied, updates: [{ path: HP, value: 5 }] }, snapshot).trusted, false);
    assert.equal(p.getAppliedDamageSummary({ ...applied, isReverted: true }, snapshot), null);
});

test('F03 ambiguous fallback records fail closed and legacy uncorrelated edits are ignored', () => {
    const { p, actor } = damageEnvironment();
    p.pushRecentHpChange(actor, { id: 'manual', amount: 5, delta: 5, timestamp: Date.now() });
    assert.equal(p.consumeRecentHpChange(actor, 30, false, { requireRecent: true }), null);
    for (const id of ['one', 'two']) p.pushRecentHpChange(actor, { id, applicationId: id, completed: true, amount: 30, delta: 30, timestamp: Date.now() });
    assert.equal(p.consumeRecentHpChange(actor, 30, false, { requireRecent: true }), null);
});

test('F04 successful undo persists once, only on primary GM; no-op undo does not save', async () => {
    const { c } = environment(), p = parser(c);
    let saves = 0;
    p.saveLiveBackup = async () => { saves++; };
    p.revertHolodeckMessageStats = () => true;
    const message = { flags: { pf2e: { appliedDamage: { isReverted: true } } } };
    assert.equal(p.handleRevertedHolodeckDamageMessage(message, {}), true);
    await Promise.resolve();
    assert.equal(saves, 1);
    c.game.user = { id: 'gm2', isGM: true };
    p.handleRevertedHolodeckDamageMessage(message, {});
    await Promise.resolve();
    assert.equal(saves, 1);
    c.game.user = c.game.users.activeGM;
    p.revertHolodeckMessageStats = () => false;
    p.handleRevertedHolodeckDamageMessage(message, {});
    await Promise.resolve();
    assert.equal(saves, 1);
});

test('F03 failed applyDamage leaves no reusable fallback HP record or active scope', async () => {
    const { c, p, actor, run } = damageEnvironment();
    await assert.rejects(run({ beforeMessage: () => { throw Error('interrupted'); } }), /interrupted/);
    assert.equal(p.peekRecentHpChange(actor).completed, false);
    assert.equal(p.consumeRecentHpChange(actor, 30, false, { requireRecent: true }), null);
    const stray = { flags: { pf2e: { appliedDamage: { uuid: actor.uuid, updates: [{ path: HP, value: 30 }] } } },
        updateSource() { assert.fail('application scope leaked'); } };
    c.stampDamageApplication(stray);
    const next = await run();
    assert.ok(next.flags[NS].damageApplication.applicationId);
    assert.equal(p.consumeRecentHpChange(actor, 30, false, { requireRecent: true }), null);
});
