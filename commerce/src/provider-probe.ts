import { providerFromEnvironment } from "./provider";

const run = async () => {
  try {
    const result = await providerFromEnvironment().probe();
    console.log(`Tochka provider probe: OK (${result.environment})`);
  } catch {
    // Do not echo provider responses: they can contain operational details and
    // are not needed to prove that the read-only probe failed.
    console.error("Tochka provider probe: FAILED");
    process.exitCode = 1;
  }
};

void run();
