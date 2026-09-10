#!/usr/bin/env node
/**
 * MD Publisher entry point.
 */

import { main } from "./cli";

main(process.argv.slice(2))
  .then((code: number) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
