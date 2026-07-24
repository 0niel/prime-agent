---
name: prime-agent-release
description: Update or publish a Prime Agent release version. Use when Codex is asked to bump Prime Agent versions, prepare a release branch, update release changelogs, tag or publish a Prime Agent release, verify the R2 tarball release workflow, or explain the Prime Agent release process.
---

# Prime Agent Release

## Guardrails

- Use this with the `prime-agent-worktree` skill when working in `<prime-agent-repo>`.
- Do release work only in a dedicated clean worktree. The release script stages every changed/untracked/deleted file it sees.
- Do not commit, tag, push, publish, or run `npm run release:*` unless the user explicitly asks for a release, because that script commits, tags, publishes, and pushes.
- Never merge a release PR yourself. Prepare the release PR and stop; a human will review and merge it.
- Do not run `npm run build`, `npm test`, or broad tests unless the user explicitly overrides the repo rules.
- For normal code-change releases, run `npm run check` before any release commit and fix all output.
- Versioning is lockstep only for the root package and published packages: `packages/agent`, `packages/ai`, `packages/coding-agent`, `packages/tui`, and `packages/web-ui`.
- Do not bump example or private workspace versions such as `packages/web-ui/example` or `packages/coding-agent/examples/extensions/*`.
- Prime Agent uses no major releases by policy: use patch for fixes and new features, minor for breaking changes.

## Release Model

Prime Agent currently has two release layers:

- `scripts/release.mjs`: bumps versions, finalizes changelogs, creates release commits/tags, runs `npm run publish`, adds fresh `[Unreleased]` sections, and pushes `main` plus `vX.Y.Z`.
- `.github/workflows/build-binaries.yml`: on `main` or `v*`, builds, checks, packs private npm tarballs with `npm run release:pack`, creates/updates the GitHub Release, uploads tarballs to R2, and updates `stable`, `latest.json`, and `install.sh`.

The installer reads the R2 `stable` file and installs `prime-agent-<version>.tgz`.

## Preparation

1. Inspect state:

```bash
git status --short --branch
git worktree list
node -p "require('./package.json').version"
```

2. Create or reuse a release worktree:

```bash
git worktree add -b release/<version-or-purpose> <prime-agent-repo>/.worktrees/release-<version-or-purpose> main
```

3. Work from that release worktree, not `<prime-agent-repo>`.

4. Read the relevant `[Unreleased]` sections before editing changelogs. Keep entries under the allowed subsections:

- `### Breaking Changes`
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

Use issue attribution when available:

```markdown
- Fixed foo ([#123](https://github.com/PrimeIntellect-ai/prime-agent/issues/123))
```

## Slack Release Announcement

Always include a channel-ready Slack draft in the final response after preparing or updating a
Prime Agent release, version bump, or release changelog. Do this even when the user does not ask
for Slack copy explicitly.

Keep the Slack draft out of repository files. Do not add it to changelogs, release notes markdown,
PR bodies, GitHub release descriptions, `.md` files, `.mmd`/`.mnd` files, or generated artifacts
unless the user explicitly asks to store it there. Treat it as response-only copy by default.

Keep the draft concise, informal, and shaped like prior Prime Agent release posts:

- Start with a Slack emoji and version, usually `:pikachu:` or `:pikachu-spinnyhat: vX.Y.Z`.
- Prefer short plain lines or bullets over a formal changelog structure.
- Group related low-level changes into one theme instead of listing every implementation detail.
- Preserve user-provided acknowledgements and tone.
- Mention the biggest user-facing behavior changes first, then reliability/debuggability notes.
- Do not include PR links unless the user asks for a more formal announcement.

Examples of the user's Slack style:

```text
:pikachu: v0.2.4

claude fable 5 support :rockets-fire:
mostly under-the-hood plumbing this release, primarily to improve long-running eval + large subagent fanout performance:
- python forkserver on linux for faster subagent kernel spawns
- bounded concurrent kernel boots so a big fan-out doesn't starve the box
- kernel venv now rebuilds when the bundled runtime changes
- fixes in provider stream errors instead of failing the turn, and other bugs
agents view shows only live sessions instead of every old one
```

```text
:pikachu-spinnyhat: v0.2.5

/fullscreen opt-in mode with a scrollable transcript, pinned prompt bar, mouse selection/copy, and follow controls
orchestration push
agent-to-agent messages and read-only active-session observation
orchestration heartbeat for compact progress/blocker/action summaries
/refine can now run automatically after turn intervals or compaction checkpoints
better subagent guidance, plus asyncio pre-imported so parallel/background rlm examples work out of the box
fixes for herdr extension pane env scoping; also added claude fable 5 in prime inference
provider failures should be much more debuggable
```

## Version-Only Bump

Use this when the user asks to update package versions but not publish a release.

Do not use workspace-wide `npm version -ws` commands for Prime Agent release prep; they also bump examples and private workspaces.

Set the release version only in the root package and published package manifests, then sync internal dependency ranges:

```bash
node -e '
const fs = require("node:fs");
const version = process.argv[1];
const files = [
  "package.json",
  "packages/agent/package.json",
  "packages/ai/package.json",
  "packages/coding-agent/package.json",
  "packages/tui/package.json",
  "packages/web-ui/package.json",
];
for (const file of files) {
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.version = version;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, "\t")}\n`);
}
' <x.y.z>
node scripts/sync-versions.js
```

Then update the root dependency range and lockfile without lifecycle scripts:

```bash
npm pkg set dependencies.@earendil-works/pi-coding-agent='^<x.y.z>'
npm install --package-lock-only --ignore-scripts
```

Then verify:

```bash
node scripts/sync-versions.js
git diff -- package.json package-lock.json packages/*/package.json
git diff --exit-code -- packages/web-ui/example 'packages/coding-agent/examples/extensions/*' || {
  echo "example/private workspace versions changed; restore them before continuing" >&2
  exit 1
}
npm run check
```

Stage only files changed for this release work. Do not use `git add .` or `git add -A`.

## Full Release

Use only when the user explicitly asks to release.

1. Confirm the release type:

- `patch`: bug fixes and non-breaking features.
- `minor`: breaking changes.
- explicit `x.y.z`: only if it is greater than the current version.

2. Ensure the release worktree is clean before invoking the release script:

```bash
git status --porcelain
```

3. Until `scripts/release.mjs` excludes example/private workspaces, do not use it for Prime Agent releases. Prepare the release with the version-only flow above, run `npm run check`, commit the explicit release files on a release branch, push that branch, and open a PR. Never merge the PR yourself; a human will merge it.

Legacy release commands below are unsafe for current Prime Agent release prep because they call workspace-wide version scripts:

```bash
npm run release:patch
npm run release:minor
node scripts/release.mjs <x.y.z>
```

The script will:

- refuse to run with uncommitted changes,
- bump all workspace versions,
- convert `## [Unreleased]` changelog sections to `## [x.y.z] - YYYY-MM-DD`,
- commit `Release vX.Y.Z`,
- tag `vX.Y.Z`,
- run `npm run publish`,
- add new `[Unreleased]` changelog sections,
- commit `Add [Unreleased] section for next cycle`,
- push `main` and the tag.

4. Watch the `Release Prime Agent` GitHub Action after push. The workflow should:

- run `npm ci`,
- run `npm run build`,
- run `npm run check`,
- run `npm run release:pack -- --version X.Y.Z --base-url "$R2_PUBLIC_BASE_URL"`,
- publish GitHub Release artifacts,
- upload `prime-agent-X.Y.Z.tgz`, internal tarballs, `SHA256SUMS`, `stable`, `latest.json`, and rendered `install.sh` to R2.

Use `gh run view` or the GitHub UI to verify. If a workflow fails, fix on a new branch/worktree unless the release script already created commits that need a targeted follow-up.

## Manual Pack Verification

Do not use this as the default local verification path because `release:pack` needs built `dist` directories and the repo rules forbid `npm run build` unless explicitly requested.

If the user explicitly asks to test packing and `dist` already exists:

```bash
npm run release:pack -- --version <x.y.z> --base-url <r2-base-url>
ls packages/coding-agent/release/artifacts
cat packages/coding-agent/release/artifacts/stable
cat packages/coding-agent/release/artifacts/latest.json
```

Expected artifacts include:

- `prime-agent-<version>.tgz`
- `earendil-works-pi-ai-<version>.tgz`
- `earendil-works-pi-agent-core-<version>.tgz`
- `earendil-works-pi-tui-<version>.tgz`
- `SHA256SUMS`
- `stable`
- `latest.json`

## Failure Handling

- If `npm install` or release commands fail due to network or sandbox restrictions, rerun with escalation and a narrow justification.
- If the release script refuses dirty state, stop and inspect. Do not stash or reset. Move unrelated work out of the release worktree or create a clean one.
- If a tag already exists, do not force-push. Inspect the tag and workflow state, then ask the user before replacing anything.
- If changelogs are missing or malformed, fix changelog structure before rerunning release automation.
