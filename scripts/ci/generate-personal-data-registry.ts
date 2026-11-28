import { writeFileSync } from "node:fs";
import { generatedPath, readRegistry, renderRegistry } from "./personal-data-registry";

writeFileSync(generatedPath, renderRegistry(readRegistry()), "utf8");
