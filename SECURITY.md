# Security

Keep provider credentials, bearer tokens, databases, backups, and raw research artifacts out of Git and container images. Provider modules are trusted operator code. MCP callers cannot upload modules, change provider URLs, or replace server credentials. Self-hosted HTTP uses one trusted workspace; managed tenant identity and billing belong to the private service.

Report suspected vulnerabilities privately through GitHub private vulnerability reporting when enabled for this repository. Do not put credentials, customer data, or working exploit details into a public issue. Enable GitHub secret scanning/push protection and Dependabot alerts in repository settings when available; the committed workflows do not change those account settings.

## Automated checks

Pull requests, main/tag pushes, manual checks, and a weekly schedule scan the complete fetched Git history with a digest-pinned Gitleaks container. Results are redacted. Default rules are extended with an Exa UUID credential rule. The only allowlist is the exact public `comparison-001` idempotency example line in `docs/provider-plugins.md`; it is not an authentication credential. No test directories or historical findings are broadly excluded.

CI runs `pnpm audit --prod --audit-level high`; high/critical runtime advisories fail the build. Lower-severity advisories stay visible and require assessment. Dependabot checks npm and pinned GitHub Actions weekly. Pull requests receive read-only repository permissions and cannot publish images. Image publication requires all checks and is limited to main/tag pushes or an explicit main/tag manual run.

## Current dependency assessment

Reviewed 2026-10-18:

- `@hono/node-server` is pinned to compatible patched version 1.19.17 using pnpm overrides. This addresses [repeated-slash static middleware bypass](https://github.com/honojs/node-server/security/advisories/GHSA-92pp-h63x-v22m) and [encoded-backslash static path handling on Windows](https://github.com/honojs/node-server/security/advisories/GHSA-frvp-7c67-39w9). Reassess the pin with upstream Mastra/MCP dependency updates.
- [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) remains reported for `sprintf-js@1.0.3`. The dependency chain is Mastra core → gray-matter → js-yaml 3 → argparse → sprintf-js. The vulnerable format-string operation requires attacker-controlled formatting. `js-yaml` imports argparse in its separate `bin/js-yaml.js` CLI, not its library entry point. OpenSenpai uses SDK library APIs and does not expose that CLI or a format-string operation through REST/MCP. A local probe confirmed gray-matter YAML parsing without loading argparse or sprintf-js. No upstream patched sprintf-js version was available at review. This is a reachability assessment, not removal of the vulnerable package; keep it visible in audit output. Re-review when adding CLI execution/formatting features or updating this dependency chain, and at least quarterly.

Source publication and production operation require different checks. Never depend on source secrecy for hosted authentication, workspace isolation, payment verification, or credit accounting.
