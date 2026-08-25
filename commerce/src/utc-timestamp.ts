const sqliteUtcPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** SQLite datetime('now') is UTC but deliberately omits its timezone suffix. */
export const parseUtcTimestamp = (value: string): number => Date.parse(sqliteUtcPattern.test(value) ? `${value.replace(" ", "T")}Z` : value);
