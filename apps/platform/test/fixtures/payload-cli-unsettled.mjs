// Deliberately never settles, with no active handles. Old CLI reports success.
await new Promise(() => {});
