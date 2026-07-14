export const HOLODECK_KILL_MARKER = "\u{1F480}";

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
        .replace(/\s*(?:\u{1F480}|馃拃)/gu, "")
        .replace(/\s{2,}/g, " ")
        .trimEnd();
    return enabled ? `${cleaned} ${HOLODECK_KILL_MARKER}`.trim() : cleaned;
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
