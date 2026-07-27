import test from "node:test";
import assert from "node:assert/strict";
import {
    hasHolodeckKillMarker,
    holodeckStatsHaveValues,
    selectHolodeckIdentityToken,
    setHolodeckKillMarker
} from "../scripts/statistics.js";

function makeActor(id = "actor") {
    return { id, uuid: `Actor.${id}`, token: null };
}

function makeToken(actor, id, name) {
    return {
        id,
        uuid: `Scene.scene.Token.${id}`,
        name,
        actor,
        baseActor: actor
    };
}

test("Holodeck identity prefers the exact speaker token", () => {
    const actor = makeActor();
    const first = makeToken(actor, "first", "First Token");
    const second = makeToken(actor, "second", "Second Token");

    assert.equal(selectHolodeckIdentityToken(actor, second, [first, second]), second);
});

test("Holodeck identity rejects an unrelated speaker token", () => {
    const actor = makeActor();
    const otherActor = makeActor("other");
    const represented = makeToken(actor, "represented", "Represented Token");
    const unrelated = makeToken(otherActor, "unrelated", "Unrelated Token");

    assert.equal(selectHolodeckIdentityToken(actor, unrelated, [represented]), represented);
});

test("Holodeck identity does not guess between multiple tokens for one actor", () => {
    const actor = makeActor();
    const first = makeToken(actor, "first", "First Token");
    const second = makeToken(actor, "second", "Second Token");

    assert.equal(selectHolodeckIdentityToken(actor, null, [first, second]), null);
    assert.equal(selectHolodeckIdentityToken(actor, null, [first]), first);
});

test("empty actor-name ledger shells can be removed after identity migration", () => {
    const empty = {
        name: "Actor Name",
        type: "npc",
        level: 5,
        isAlly: false,
        damageDealt: 0,
        advanced: { huntedShotDmg: 0, surgeFriendlyDmg: 0 },
        d20Rolls: Array(20).fill(0),
        history: []
    };

    assert.equal(holodeckStatsHaveValues(empty), false);
    assert.equal(holodeckStatsHaveValues({ ...empty, damageDealt: 1 }), true);
});

// Holodeck builds the result string as `<n> DMG APPLIED 💀 <span ...>(<n> BLKD)</span>`.
// Re-normalising an entry has to reproduce that byte for byte, otherwise every parse reports a
// change and triggers another world-setting write.
const BLOCKED_SPAN = '<span style="color:#aaa;">(3 BLKD)</span>';

test("kill marker is appended when there is no mitigation suffix", () => {
    assert.equal(setHolodeckKillMarker("12 DMG APPLIED", true), "12 DMG APPLIED \u{1F480}");
});

test("kill marker keeps Holodeck's position ahead of the mitigation span", () => {
    const holodeckResult = `12 DMG APPLIED \u{1F480} ${BLOCKED_SPAN}`;

    assert.equal(setHolodeckKillMarker(`12 DMG APPLIED ${BLOCKED_SPAN}`, true), holodeckResult);
});

test("re-normalising an already marked entry is a no-op", () => {
    const holodeckResult = `12 DMG APPLIED \u{1F480} ${BLOCKED_SPAN}`;

    assert.equal(setHolodeckKillMarker(holodeckResult, true), holodeckResult);
    assert.equal(setHolodeckKillMarker("12 DMG APPLIED \u{1F480}", true), "12 DMG APPLIED \u{1F480}");
});

test("clearing the marker leaves the rest of the result intact", () => {
    const cleared = setHolodeckKillMarker(`12 DMG APPLIED \u{1F480} ${BLOCKED_SPAN}`, false);

    assert.equal(cleared, `12 DMG APPLIED ${BLOCKED_SPAN}`);
    assert.equal(hasHolodeckKillMarker(cleared), false);
});

test("a mojibake marker from an older ledger is recognised and repaired", () => {
    assert.equal(hasHolodeckKillMarker("12 DMG APPLIED 馃拃"), true);
    assert.equal(setHolodeckKillMarker("12 DMG APPLIED 馃拃", true), "12 DMG APPLIED \u{1F480}");
    assert.equal(setHolodeckKillMarker("12 DMG APPLIED 馃拃", false), "12 DMG APPLIED");
});
