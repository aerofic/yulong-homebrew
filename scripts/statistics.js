export const HOLODECK_KILL_MARKER = "\u{1F480}";

// Holodeck writes the kill marker straight into the log result string, and older ledgers
// can contain a mojibake copy of it, so both spellings have to be recognised.
const HOLODECK_KILL_MARKER_PATTERN = /\s*(?:\u{1F480}|馃拃)/gu;

// Holodeck appends `<span ...>(N BLKD)</span>` after the marker; matching it lets us put a
// re-applied marker back in the same place instead of shuffling it to the end every parse.
const HOLODECK_BLOCKED_SUFFIX_PATTERN = /\s*<span[^>]*>\(\s*\d+\s*BLKD\s*\)<\/span>\s*$/i;

export function isHpDefeatTransition({ previousHp, currentHp, amount, isHealing = false } = {}) {
    const previous = Number(previousHp);
    const current = Number(currentHp);
    const applied = Number(amount);
    return !isHealing
        && Number.isFinite(previous)
        && Number.isFinite(current)
        && Number.isFinite(applied)
        && applied > 0
        && previous > 0
        && current <= 0;
}

export function hasHolodeckKillMarker(result) {
    return /(?:\u{1F480}|馃拃)/u.test(String(result || ""));
}

export function setHolodeckKillMarker(result, enabled) {
    const cleaned = String(result || "")
        .replace(HOLODECK_KILL_MARKER_PATTERN, "")
        .replace(/\s{2,}/g, " ")
        .trimEnd();
    if (!enabled) return cleaned;

    const blocked = cleaned.match(HOLODECK_BLOCKED_SUFFIX_PATTERN);
    if (!blocked) return `${cleaned} ${HOLODECK_KILL_MARKER}`.trim();

    const head = cleaned.slice(0, blocked.index).trimEnd();
    return `${head} ${HOLODECK_KILL_MARKER} ${blocked[0].trim()}`.trim();
}

function areSameDocument(first, second) {
    if (!first || !second) return false;
    if (first === second) return true;
    if (first.uuid && second.uuid) return first.uuid === second.uuid;
    return Boolean(!first.uuid && !second.uuid && first.id && second.id && first.id === second.id);
}

function tokenRepresentsActor(token, actor) {
    if (!token || !actor) return false;
    return areSameDocument(token.actor, actor) || areSameDocument(token.baseActor, actor);
}

export function selectHolodeckIdentityToken(actor, speakerToken = null, activeTokens = []) {
    if (!actor) return null;
    if (speakerToken && tokenRepresentsActor(speakerToken, actor)) return speakerToken;
    if (actor.token && tokenRepresentsActor(actor.token, actor)) return actor.token;

    const represented = [...activeTokens].filter(token => tokenRepresentsActor(token, actor));
    return represented.length === 1 ? represented[0] : null;
}

export function holodeckStatsHaveValues(stats) {
    if (!stats || typeof stats !== "object") return false;
    const metadata = new Set(["name", "type", "level", "isAlly", "master"]);
    const hasValue = value => {
        if (typeof value === "number") return Number.isFinite(value) && value !== 0;
        if (typeof value === "boolean") return value;
        if (typeof value === "string") return value.length > 0;
        if (Array.isArray(value)) return value.some(hasValue);
        if (value && typeof value === "object") return Object.values(value).some(hasValue);
        return false;
    };

    return Object.entries(stats).some(([key, value]) => !metadata.has(key) && hasValue(value));
}

export function summarizeHolodeckDamageRolls(rolls = []) {
    let actualDamageRoll = 0;
    let expectedDamage = 0;
    const damageTypes = {};
    const details = [];

    for (const roll of rolls || []) {
        const total = Number(roll?.total);
        if (!Number.isFinite(total)) continue;
        actualDamageRoll += total;

        let actualDice = 0;
        let expectedDice = 0;
        const seen = new Set();
        const visit = value => {
            if (!value || typeof value !== "object" || seen.has(value)) return;
            seen.add(value);
            if (value.faces !== undefined && value.number !== undefined && Array.isArray(value.results)) {
                const active = value.results.filter(result => result.active !== false && !result.discarded);
                expectedDice += ((Number(value.faces) + 1) / 2) * active.length;
                for (const result of active) actualDice += Number(result.result) || 0;
                return;
            }
            for (const child of Object.values(value)) visit(child);
        };
        visit(roll);
        expectedDamage += total - actualDice + expectedDice;

        for (const instance of roll.instances || []) {
            const instanceTotal = Number(instance?.total);
            if (!Number.isFinite(instanceTotal)) continue;
            const type = instance.type || "untyped";
            damageTypes[type] ??= { instances: 0, total: 0 };
            damageTypes[type].instances += 1;
            damageTypes[type].total += instanceTotal;
            details.push(`${instanceTotal} ${type}`);
        }
    }

    return { actualDamageRoll, expectedDamage, damageTypes, details };
}
