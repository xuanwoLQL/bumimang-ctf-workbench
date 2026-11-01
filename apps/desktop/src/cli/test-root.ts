import { fileURLToPath } from "node:url";

/** Repository root for CLI acceptance scripts in both local and CI checkouts. */
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
