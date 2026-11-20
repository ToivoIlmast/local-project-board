// @ts-check
import { main } from './cli.mjs';

process.exitCode = await main({ argv: process.argv.slice(2), env: process.env });
