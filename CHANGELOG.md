# Changelog

All notable changes to this project will be documented in this file.

## [0.4.0] - 2026-09-03

### Changed
- **BREAKING — dsh host floor `>= 0.1.2-alpha.3`, rc-line support dropped**
  - dsh-settings removed the `settingsNamespace()` runtime helper: the `mcp-adapter` gate-state namespace is a plain literal now (type-level brand check via `SettingsNamespaceInput` + host-side runtime validation); only the `SettingsScope` type is imported
  - `JsonValue` no longer re-exports from the `@deepseek-ai/dsh-tools` root — it is imported from the alpha split package `@deepseek-ai/dsh-util-values` (type-only; the shipped artifact is unchanged)
- CI/publish rides the dsh RC/stable line: the host closure resolves at runtime to the newest of the `latest`/`next` dist-tags — the retired `@alpha` dist-tag is no longer followed (policy 2026-09-03)
- dsh host floor re-declared as `>= 0.1.2-rc.1`; the alpha line is no longer a supported target
- README (en/zh) declares RC/stable-only support (CI and releases resolve the newest `latest`/`next` dist-tag at runtime; the alpha line is no longer supported)

### Added
- Boot smoke (`npm run smoke`, `scripts/smoke-boot.mjs`): mounts the packed plugin into a scratch dsh profile and boots it with the real dsh CLI (runtime proof that the plain-literal settings namespace registers); CI installs the host from the rolling rc/stable line (see Changed) and gains a daily schedule

## [0.2.2] - 2026-08-29

### Changed
- npm metadata-only release: add keywords (dsh, dsh-plugin, deepseek-harness, mcp, meta-tools, token-saving) for registry discoverability; no code changes
