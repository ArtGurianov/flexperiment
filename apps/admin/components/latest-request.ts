export function createLatestRequestGate() {
  let latest = 0;
  return {
    begin: () => ++latest,
    isLatest: (version: number) => version === latest,
    invalidate: () => { latest += 1; },
  };
}
