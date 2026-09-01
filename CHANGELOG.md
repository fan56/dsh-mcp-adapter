# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- **BREAKING — dsh host floor `>= 0.1.2-alpha.3`, rc-line support dropped**
  - dsh-settings removed the `settingsNamespace()` runtime helper: the `mcp-adapter` gate-state namespace is a plain literal now (type-level brand check via `SettingsNamespaceInput` + host-side runtime validation); only the `SettingsScope` type is imported
  - `JsonValue` no longer re-exports from the `@deepseek-ai/dsh-tools` root — it is imported from the alpha split package `@deepseek-ai/dsh-util-values` (type-only; the shipped artifact is unchanged)

### Added
- Boot smoke (`npm run smoke`, `scripts/smoke-boot.mjs`): mounts the packed plugin into a scratch dsh profile and boots it with the real dsh CLI (runtime proof that the plain-literal settings namespace registers); CI installs the host from the rolling `@alpha` dist-tag (latest still points at the dropped rc line) and gains a daily schedule

## [0.2.2] - 2026-08-29

### Changed
- npm metadata-only release: add keywords (dsh, dsh-plugin, deepseek-harness, mcp, meta-tools, token-saving) for registry discoverability; no code changes
