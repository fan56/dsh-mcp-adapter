# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Changed

- **迁移 dsh 0.1.7 settings 体系**（`SettingsScope` import 硬破坏）。`SettingsScope`/`register(ns, schema)` 用法删除：插件配置改按 0.1.7 模板以模块级 `Config` schema 声明（声明即注册，ns = profile entry id `dsh-mcp-adapter`），`prefix`/`keep`/`servers`/`descriptionLimit`/新增 `storageDir` 五键全部 `.volatile()`——设置页可编辑且**免重启热生效**（volatile-only 写入不重挂插件）；`apply` 相应改为经 volatile 引用每次使用时现读（waterfall / 两个元工具 / `/mcp` 命令均不再 apply 期捕获旧值），`createMcpCallTool` 的 `prefix`/`servers` 参数放宽为接受 thunk。
- **门闩状态（serverIds/disabled）迁出 settings，改插件自有文件存储**：机器态按迁移模板不得标 volatile（会进设置页且高频写抖动 revision），改为 `<dsh home>/storages/mcp-adapter/gate.json`（`DSH_HOME` 或 `~/.dsh`，与 dsh-cron/dsh-vault 同一 home 口径）——apply 期同步读一次建内存镜像，写穿（tmp+rename 原子落盘，写成功后才推进镜像，失败保持原状）。读取永不再抛错；损坏文档启动时告警一次并退化为全启（fail-open 契约不变），下一次分配写会自动重写修复。配置键 `storageDir` 可覆盖存储目录（apply 期读一次，改后需重启插件生效）。
- **旧值承接**：entry id 保持 `dsh-mcp-adapter` 不变——旧 profile patch 里该 entry `config:` 段的 prefix/keep/servers 配置继续生效；但旧 settings.yaml 的 `mcp-adapter:` 段（旧 settings 门闩状态）在 0.1.7 一次性导入时因段名 ≠ entry id 被宿主静默丢弃（原文保留在 `settings.yaml.imported`；自动承接见下条）。
- **旧 settings 门闩状态一次性自动承接（0.1.5→0.1.7 升级无感知）**：`createFileGateStore` 在 fresh gate（无 gate.json）时一次性读取 `<home>/settings.yaml.imported`（兜底 `settings.yaml`）的 `mcp-adapter:` 段（纯函数提取器 `legacyGateSection`/`legacyGateCandidate`：块状 map/序列与单行引号流式 JSON 两形态都收，折叠/残缺值保守跳过），过既有 `normalizeServerGate` 消毒后作为初始状态**立即原子写 gate.json**（tmp+rename 同步姿势，id 与 disabled 从升级首刻可见），并落一次性审计档 `<home>/storages/mcp-adapter/legacy-import.json`（`{at, outcome, source, …}`，outcome 含 imported/no-op/no-legacy/no-section）——marker 已在则整个承接跳过（幂等防复活）；承接不到东西不落 gate.json；gate.json 已在则完全不介入（既有用户启动零变化）；吸收失败只 warn 不写 marker 下次 boot 重试。`createFileGateStore` 加可选第三参 `{info, home}`（`home` 由 apply 传 `resolveDshHome()`；不传则不读 dir 之外任何文件——既有两参调用与测试零影响）。apply 期 info 行如 `mcp-adapter: legacy settings import (settings.yaml.imported → mcp-adapter/gate.json): serverIds=2, disabled=1`。测试 +15（`legacy-gate-import.test.mjs`：解析器纯函数 8 例 + scratch-home 承接 7 例）；apply 相关测试文件以 scratch `DSH_HOME` 隔离。
- **依赖钉点**：新增 peerDependencies（宿主兼容预检据此拦截旧宿主装载）——`dsh-commands`/`dsh-llm`/`dsh-scope`/`dsh-system-prompt`/`dsh-tools`/`dsh-util-values` 地板 `>=0.1.7-rc.1`；`@deepseek-ai/cordis` `4.0.4`、`@deepseek-ai/schemastery` `3.18.4`（volatile 支持随此线，4.0.2/3.18.2 已被其他仓实证不可用，标记 optional）。devDeps 同步钉 exact，新增 `postinstall` 闭包重挂（防止 npm 把 @deepseek-ai/* 装成第二份本地副本破坏 cordis declare-module 合并）。
- **BREAKING 导出面**：删 `SERVER_ID_REGISTRY_SCHEMA`（settings 注册校验随体系消失，文件读取由 `normalizeServerGate` 全权消毒）、`MCP_ADAPTER_SETTINGS_NAMESPACE` 改名 `MCP_ADAPTER_STORAGE_DIRNAME`、`AdapterConfig` 字段类型从裸值改为 volatile 引用（`VolatileRef<T>`）；新增导出 `VolatileRef`、`GateStore`、`GateWarn`、`createFileGateStore`、`resolveDshHome`、`resolveGateDir`。
- 其余面核对零改动：dsh-tools `ToolDefinition` 仅新增可选 `projectContent`（加法）；连接层复用官方 dsh-mcp-client（SDK v2 上游消化）；`mcp__` 折叠与 `mcp_list`/`mcp_call` 元工具机制不变；未触碰 dsh-llm ContentBlock/ToolSchema（`ToolSchema` 仅加可选 `deferLoading`）、消息源 kind（本插件不创建消息）、dsh-scope/dsh-system-prompt 面。
- Plugin Manager 展示元数据：新增 icon.svg 与 locale/{en,zh}.json（`meta.title`/`meta.description`，官方 readPluginMeta 约定），package.json 声明 `icon` 并将两者入包。

## [0.4.2] - 2026-09-11

### Changed
- README (en/zh) declares the dsh support floor as `>= 0.1.5-rc.2` (docs-only — the package declares no `@deepseek-ai/*` dependencies, so the manifest and the shipped artifact are unchanged)
- Release policy: prerelease tags publish on side dist-tags and never move `latest`

## [0.4.1] - 2026-09-05

### Changed
- Clean-uninstall documentation + an uninstall leg in the boot smoke asserting removal reconciles the profile tree back to stock: a README (en/zh) Uninstall section (`dsh plugin --profile <name> remove @aiwayds/dsh-mcp-adapter` — the host splices the bundles entry and drops the patch layer; the `mcp-adapter:` section in `~/.dsh/settings.yaml` deliberately stays so stable server ids survive a reinstall, delete it to purge and let ids re-allocate)

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
