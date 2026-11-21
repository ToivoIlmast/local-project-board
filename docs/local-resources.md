# Local checks and the resources of the machine

`npm run check` and `npm test` run on whatever machine the developer or a Board Runner task
has: 4 GB or 64 GB, idle or busy. They use as much of it as the machine can safely give right
now, and no more. CI is not affected: under `CI` nothing here applies, and CI runs exactly the
commands it always ran.

## What costs resources, and what does not

Measured and read from the code (November 2026), not guessed:

| Step                       | Processes                          | Cost                                                                                                                                       |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Prettier on changed files  | 1, short                           | small                                                                                                                                      |
| ESLint on changed files    | 1 per call                         | **each call builds the TypeScript program** (typed rules, `projectService`): seconds and hundreds of MB, so the number of calls matters    |
| Smart test selection       | in the runner process              | Jest's haste map, cached on disk                                                                                                           |
| Jest                       | 1 parent + **`cores − 1` workers** | the main cost: ts-jest type-checks every test file and its imports in every worker (no `isolatedModules`); `web` tests add jsdom and React |
| `claude --wait` (Runner)   | 1, waiting on one HTTP stream      | none while waiting; one Claude Code session at a time                                                                                      |

The steps run one after another, never side by side. Before this change Jest's worker count
depended only on the number of cores: a 4-core machine with 300 MB free still started three
workers, each building its own TypeScript program, and the machine swapped.

## The profile

`scripts/resources.mjs` reads, only when Jest is about to start:

- **available memory** — not the installed memory: a 16 GB machine with 500 MB free is not a
  powerful machine;
- **installed memory** — only to size the reserve;
- **CPU cores** this process may use (`os.availableParallelism`);
- **load average**, where the OS has one.

Then:

```
reserve      = max(1 GiB, 10 % of installed memory)
memory slots = floor((available − reserve) / 1 GiB)
idle cores   = cores − round(1-minute load)          (no load average: all cores)
```

| Profile          | When                                                              | Jest                                                                                                           |
| ---------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Conservative** | memory slots < 2, or idle cores < 2, or anything cannot be read  | in band: `--maxWorkers=1`, one process, no workers                                                             |
| **Balanced**     | otherwise                                                         | `min(memory slots, idle cores / 2)` workers, `--workerIdleMemoryLimit=768MB` (not for ≤ 20 named tests)                                |
| **Performance**  | memory slots ≥ 6 and idle cores ≥ 6                               | `min(memory slots, idle cores − 1)` workers, `--workerIdleMemoryLimit=768MB` (not for ≤ 20 named tests)                                |

Why these numbers:

- **1 GiB per worker** is the planned peak of one ts-jest worker (its TypeScript program, plus
  jsdom and React for `web` tests). `--workerIdleMemoryLimit=768MB` makes Jest restart a worker
  that kept more than that after a test file, so the plan holds over a long run. Jest disables
  its in-band fast path (≤ 20 tests with fast earlier timings) whenever this limit is set, so a
  Smart run that names 20 tests or fewer goes without it.
- **The reserve** (1 GiB, or 10 % on large machines) stays for the OS, the editor, Claude Code,
  the board, and the Jest parent process, which holds the haste map and runs tests itself in band.
- **Two** is the smallest number of workers worth starting: with one, Jest in band does the same
  work without the cost of a worker process.
- **Balanced takes half of the idle cores**, so that the person — and Claude Code — keep the rest.
- **Performance needs six** of each: room for real parallel work while still leaving a reserve
  and one core free.
- **Nothing readable means Conservative**: in band is always safe, if not always the fastest.

Examples (no load):

| Installed | Available | Cores | Profile      | Jest workers |
| --------- | --------- | ----- | ------------ | ------------ |
| 4 GB      | 0.3 GB    | 4     | Conservative | in band      |
| 8 GB      | 4 GB      | 4     | Balanced     | 2            |
| 16 GB     | 0.5 GB    | 8     | Conservative | in band      |
| 16 GB     | 10 GB     | 8     | Performance  | 7            |
| 32 GB     | 8 GB      | 16    | Balanced     | 4            |
| 32 GB     | 20 GB     | 16, load 12 | Balanced | 2          |

The run prints one line with what it saw and what it chose, e.g.
`Resources: CONSERVATIVE (not enough free memory for parallel workers) — 0.3 of 3.9 GiB available, 4 CPU cores. Jest: in band (one process).`

### Each operating system

- **Linux**: `process.availableMemory()` — `MemAvailable`, capped by a cgroup (container) limit.
- **Windows**: the same call — available physical memory, standby cache included. Windows has no
  load average (Node reports zeros), so the load is unknown and not counted.
- **macOS**: free memory alone leaves out the cache macOS reclaims at once; the free, inactive and
  speculative pages of `vm_stat` are used instead (one short call, only on macOS, only when Jest
  starts). If `vm_stat` fails, the free memory is used.

## Choosing it by hand

Automatic is the default. To choose:

```sh
BOARD_RESOURCE_PROFILE=conservative npm run check     # or balanced, performance, auto
```

For a whole project, set it where Claude Code and the Board Runner pass it to every command —
`.claude/settings.json` (or `.claude/settings.local.json` for this machine only):

```json
{ "env": { "BOARD_RESOURCE_PROFILE": "conservative" } }
```

A chosen profile is not second-guessed by the free memory; the cores still bound it. An unknown
value is said and ignored. An exact count stays a Jest option of your own and always wins:
`npm test -- --maxWorkers=2` (or `-i`, `--runInBand`).

## Stopping

Every tool of `npm run check` and `npm test` is started through `scripts/run-child.mjs`, which
waits for it and passes on the signals it receives. A stopped check ends only after its child
has ended, with exit code 128 + the signal, and starts no further step.

- **Linux and macOS**: SIGINT, SIGTERM and SIGHUP are handled.
- **Windows**: Ctrl+C (and the console signals Node emulates) is handled. A process ended from
  outside with TerminateProcess (`taskkill /F`, most tools that "kill" a process) runs no handler,
  so nothing can be guaranteed there: the child may be left running until it finishes.
 Earlier, `spawnSync`
could not react while it waited: a SIGTERM to `npm run check` left Prettier, ESLint or Jest
running on their own.

`claude --wait` stops when its terminal closes (SIGHUP). During a session the session hears it
too and its end is still recorded; before, the runner stayed behind without a terminal and kept
taking tasks from the board.
