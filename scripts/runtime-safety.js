// A rejected job must not poison later work. UUID keys also serialize contextual
// copies of the same Actor; unrelated documents remain independent.
export function createDocumentQueue() {
    const tails = new Map();
    return function enqueue(document, task) {
        const key = document?.uuid || document;
        const previous = tails.get(key);
        const result = previous ? previous.then(task) : Promise.resolve().then(task);
        const tail = result.then(() => undefined, () => undefined);
        tails.set(key, tail);
        void tail.then(() => {
            if (tails.get(key) === tail) tails.delete(key);
        });
        return result;
    };
}

// Never fall back to a shared base Actor id after an exact UUID mismatches.
export function matchesActorReference(reference, actor) {
    if (!reference || !actor) return false;
    const uuid = reference.targetActorUuid || reference.targetActor?.uuid;
    if (uuid) return uuid === actor.uuid;
    if (reference.targetUuid) {
        return reference.targetUuid === actor.uuid || reference.targetUuid === actor.token?.uuid;
    }
    return Boolean(reference.targetActorId && reference.targetActorId === actor.id);
}

export function actorHistoryKeys(document) {
    const actor = document?.actor || document;
    const key = actor?.uuid || actor?.id;
    return key ? [key] : [];
}

// PF2e 8.4.1 Item.toMessage, Spell.toMessage and Consumable.consume emit the
// primary use card without a check context. Consumable healing rolls also have
// no context: do not reject them merely because they contain Roll instances.
export function isPrimaryItemUseMessage(message) {
    const flags = message?.flags?.pf2e;
    return !flags?.context?.type && !flags?.appliedDamage;
}
