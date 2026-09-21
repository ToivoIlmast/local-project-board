#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(
    `local-project-board requires Node.js >= 22.12.0 (current: ${process.versions.node}).`,
  );
  process.exit(1);
}
await import('../dist/node/server/cli/main.js');
