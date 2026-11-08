// Saves are serialized so edits made during an in-flight save retain the returned revision.
globalThis.notesEditor = function createEditor(note, write, notify) {
  let draft = structuredClone(note);
  let generation = 0, saved = 0, pending = null, error = null;
  const state = () => ({ note: draft, dirty: generation !== saved, saving: Boolean(pending), error });
  const emit = () => notify(state());
  return {
    state,
    edit(patch) { draft = { ...draft, ...patch }; generation++; emit(); },
    async save() {
      if (pending) return pending;
      if (generation === saved) return true;
      if (error) return false;
      pending = (async () => {
        try {
          while (generation !== saved) {
            const snapshot = structuredClone(draft), version = generation;
            const { note: result } = await write(snapshot);
            draft = { ...draft, id: result.id ?? draft.id, title: result.title ?? draft.title, revision: result.revision, createdAt: result.createdAt ?? draft.createdAt, updatedAt: result.updatedAt, updatedBy: result.updatedBy };
            saved = version;
          }
          return true;
        } catch (failure) { error = failure; return false; }
        finally { pending = null; emit(); }
      })();
      emit();
      return pending;
    },
    retry() { error = null; emit(); return this.save(); },
  };
};
