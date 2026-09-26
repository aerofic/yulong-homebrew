import test from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './helpers/compat-environment.mjs';

for (const [upperBound, multiplier] of [[20, 1], [40, 2], [60, 3], [120, 4], [400, 5]]) {
    test(`area radius ${upperBound}: below and exact stay x${multiplier}, above becomes x${multiplier + 1}`, () => {
        const { c } = environment();
        assert.equal(c.getTroopAreaWeaknessMultiplier(upperBound - 0.001), multiplier);
        assert.equal(c.getTroopAreaWeaknessMultiplier(upperBound), multiplier);
        assert.equal(c.getTroopAreaWeaknessMultiplier(upperBound + 0.001), multiplier + 1);
    });
}

test('invalid radius remains x1; arbitrarily large finite radius is x6', () => {
    const { c } = environment();
    for (const value of [undefined, null, NaN, Infinity, -Infinity, '400']) assert.equal(c.getTroopAreaWeaknessMultiplier(value), 1);
    assert.equal(c.getTroopAreaWeaknessMultiplier(0), 1);
    assert.equal(c.getTroopAreaWeaknessMultiplier(Number.MAX_VALUE), 6);
});

test('all existing shape conversions are unchanged', () => {
    const { c } = environment();
    const cases = [
        ['cylinder', 40, 40, 2], ['burst', 60, 60, 3],
        ['emanation', 56, 40, 2], ['cone', 120, 60, 3],
        ['square', 40, Math.sqrt(1600 / Math.PI), 2],
        ['cube', 40, Math.sqrt(1600 / Math.PI), 2],
        ['line', 120, Math.sqrt(600 / Math.PI), 1],
    ];
    for (const [type, value, radius, multiplier] of cases) {
        const area = c.getTroopAreaData({ item: { system: { area: { type, value } } } });
        assert.equal(c.getEquivalentBurstRadius(area), radius, type);
        assert.equal(c.getTroopAreaWeaknessMultiplier(radius), multiplier, type);
    }
});

test('suggestion context applies all six bands', () => {
    const { c } = environment();
    const actor = { id: 'troop', uuid: 'Actor.troop', name: 'Troop', system: {
        traits: { value: ['troop'] }, attributes: { weaknesses: [{ type: 'area-damage', value: 10 }] }
    } };
    for (const [radius, multiplier] of [[20, 1], [40, 2], [60, 3], [120, 4], [400, 5], [401, 6]]) {
        const context = c.getTroopAreaWeaknessAdvisorContext(actor, {
            damage: 100, item: { name: 'Area spell', system: { area: { type: 'burst', value: radius } } }
        });
        assert.equal(context.suggestedMultiplier, multiplier);
        assert.equal(context.equivalentBurstRadius, radius);
    }
});

test('multiplier validation accepts x5 and x6 while bounding arbitrary values', () => {
    const { c } = environment();
    for (let multiplier = 1; multiplier <= 6; multiplier++) {
        assert.equal(c.clampTroopAreaMultiplier(multiplier), multiplier);
        assert.equal(c.clampTroopAreaMultiplier(String(multiplier)), multiplier);
        assert.equal(c.getTroopAreaExtraWeaknessDamage(10, multiplier), 10 * (multiplier - 1));
    }
    assert.equal(c.clampTroopAreaMultiplier(100), 6);
    assert.equal(c.clampTroopAreaMultiplier(5.9), 5);
    for (const value of [0, -3, NaN, Infinity, undefined]) assert.equal(c.clampTroopAreaMultiplier(value), 1);
});

test('card offers six choices and preserves selected x5 / x6 and old choices', () => {
    const { c } = environment();
    c.escapeYulongHTML = value => String(value ?? '');
    for (const selected of [1, 4, 5, 6]) {
        const html = c.buildTroopAreaWeaknessAdvisorContent({ selectedMultiplier: selected, weakness: { value: 10 } });
        assert.deepEqual([...html.matchAll(/<option value="(\d+)"/g)].map(match => Number(match[1])), [1, 2, 3, 4, 5, 6]);
        assert.match(html, new RegExp(`<option value="${selected}" selected>`));
        assert.match(html, new RegExp(`data-yulong-troop-area-extra-preview>${10 * (selected - 1)}</strong>`));
    }
});

test('change preview uses new x5 and x6 values', () => {
    const { c } = environment();
    for (const multiplier of ['5', '6']) {
        const preview = {};
        const select = { value: multiplier, closest: () => ({ dataset: { yulongWeaknessValue: '10' }, querySelector: () => preview }) };
        c.handleTroopAreaWeaknessAdvisorChange({ target: { closest: () => select } });
        assert.equal(preview.innerText, String(10 * (Number(multiplier) - 1)));
    }
});

for (const multiplier of [5, 6]) test(`execute x${multiplier} adds only the extra weakness and records selected multiplier`, async () => {
    const { c } = environment(), applications = [], updates = [];
    const actor = { system: { traits: { value: ['troop'] }, attributes: { weaknesses: [{ type: 'area-damage', value: 10 }] } },
        canUserModify: () => true, async applyDamage(params) { applications.push(params); } };
    c.getTroopAreaWeaknessTarget = () => ({ actor, token: { uuid: 'Scene.test.Token.troop' } });
    c.updateTroopAreaWeaknessAdvisorMessage = async (message, updated) => updates.push(updated);
    await c.executeTroopAreaWeaknessAdvisor({}, { rawDamage: 100, weakness: { value: 10 }, suggestedMultiplier: multiplier }, String(multiplier));
    assert.equal(applications.length, 1);
    assert.equal(applications[0].damage, 10 * (multiplier - 1));
    assert.equal(applications[0].final, true);
    assert.equal(updates[0].selectedMultiplier, multiplier);
    assert.equal(updates[0].processing, true);
    assert.equal(updates.at(-1).executed, true);
});
