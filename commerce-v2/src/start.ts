// Normal application behavior is unchanged. Restricted foundation boot does not
// construct Better Auth, email delivery, Kinescope or the F7 payment rail.
export {};
process.umask(0o077);
async function start() {
  if (process.env.COMMERCE_V2_FOUNDATION_MODE === "true") {
    const { startFoundation } = await import("./foundation");
    startFoundation();
  } else if (process.env.COMMERCE_V2_FOUNDATION_MODE && process.env.COMMERCE_V2_FOUNDATION_MODE !== "false") {
    throw new Error("FOUNDATION_MODE_INVALID");
  } else {
    await (await import("./server")).serverStartup;
  }
}
start().catch(() => { console.error("COMMERCE_V2_START_REFUSED"); process.exitCode = 1; });
