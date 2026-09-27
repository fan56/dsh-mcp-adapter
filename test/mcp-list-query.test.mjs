// Seam B (mcp_list { query }): the model-explicit relevance shortlist.
//
// The load-bearing assertion in this file is the FIRST one — the no-argument
// catalog must be byte-identical to the pre-seam answer, because that is the
// path every existing session takes. Everything after it exercises the query
// path: lexical prefilter, jev rerank merge, the self-describing result shape,
// and every fail-open route back to the lexical order.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMcpListResult,
  listQueryRanking,
  createMcpListTool,
  normalizeMcpListArgs,
  MCP_LIST_TOOL_NAME,
} from '../lib/index.js'
import { mergeNameOrder, rankByQuery, tokenize, LIST_RESULT_LIMIT, RANK_CANDIDATE_LIMIT } from '../lib/rank.js'

function schema(name, description = '', parameters = { type: 'object', properties: {} }) {
  return { name, description, parameters }
}

function catalogSchemas() {
  return [
    schema('read', 'native tool'),
    schema('mcp__fs__read_file', 'Read a file from disk'),
    schema('mcp__fs__write_file', 'Write a file to disk'),
    schema('mcp__fs__list_dir', 'List a directory'),
    schema('mcp__gh__create_issue', 'Create an issue on GitHub'),
    schema('mcp__gh__list_issues', 'List issues in a repository'),
    schema('mcp__gh__close_issue', 'Close an issue on GitHub'),
  ]
}

const OPTIONS = { prefix: 'mcp__', descriptionLimit: 200, servers: [] }

function execLike() {
  return { agent: undefined, signal: new AbortController().signal }
}

/** A reranker that records what it was asked and answers with a fixed order. */
function rankerSpy(order) {
  const seen = []
  return {
    seen,
    rankQuery: async (query, candidates) => {
      seen.push({ query, candidates: candidates.map(c => c.name) })
      return order
    },
  }
}

// ---- regression anchor: the unqueried catalog ----

test('seam B: the no-argument catalog is byte-identical to the pre-seam answer', async () => {
  const schemas = catalogSchemas()
  const result = buildMcpListResult({}, schemas, OPTIONS)
  assert.equal(
    JSON.stringify(result),
    '{"servers":[{"server":"fs","tools":[{"name":"mcp__fs__read_file","description":"Read a file from disk"},{"name":"mcp__fs__write_file","description":"Write a file to disk"},{"name":"mcp__fs__list_dir","description":"List a directory"}]},{"server":"gh","tools":[{"name":"mcp__gh__create_issue","description":"Create an issue on GitHub"},{"name":"mcp__gh__list_issues","description":"List issues in a repository"},{"name":"mcp__gh__close_issue","description":"Close an issue on GitHub"}]}]}',
  )
  assert.deepEqual(Object.keys(result), ['servers'], 'the ranked-subset keys never appear unqueried')
})

test('seam B: the tool renders the no-argument catalog through the same JSON as before', async () => {
  const schemas = catalogSchemas()
  const tool = createMcpListTool({ ...OPTIONS, rankQuery: rankerSpy([]).rankQuery }, () => schemas)
  const value = await tool.execute({}, execLike())
  assert.deepEqual(Object.keys(value), ['servers'])
  const rendered = tool.output.render({}, value)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].text, JSON.stringify(value, null, 2))
  assert.ok(!rendered[0].text.includes('ranked'), 'no ranked bookkeeping leaks into the plain answer')
})

test('seam B: the unqueried execute never consults the reranker', async () => {
  const spy = rankerSpy(['mcp__gh__create_issue'])
  const tool = createMcpListTool({ ...OPTIONS, rankQuery: spy.rankQuery }, () => catalogSchemas())
  const exec = execLike()
  await tool.execute({}, exec)
  await tool.execute({ server: 'gh' }, exec)
  await tool.execute({ verbose: true }, exec)
  await tool.execute({ tool: 'mcp__gh__create_issue' }, exec)
  await tool.execute({ query: '   ' }, exec)
  assert.deepEqual(spy.seen, [], 'red line ①: the hot path makes no remote call')
})

test('seam B: a blank query is dropped by the arg normalizer, not treated as a search', () => {
  assert.deepEqual(normalizeMcpListArgs({ query: '   ' }), {})
  assert.deepEqual(normalizeMcpListArgs({ query: 42 }), {})
  assert.deepEqual(normalizeMcpListArgs({ query: 'issue' }), { query: 'issue' })
  assert.deepEqual(normalizeMcpListArgs({ query: 'issue', server: 'gh', verbose: true }), { query: 'issue', server: 'gh', verbose: true })
})

// ---- the lexical prefilter (pure) ----

test('seam B: the query tokenizes across naming conventions', () => {
  assert.deepEqual(tokenize('mcp__gh__create_issue'), ['mcp', 'gh', 'create', 'issue'])
  assert.deepEqual(tokenize('createIssue'), ['create', 'issue'])
  assert.deepEqual(tokenize('HTTP/2 fetch'), ['http', '2', 'fetch'])
  assert.deepEqual(tokenize('   '), [])
})

test('seam B: the lexical prefilter prefers name hits, then description hits', () => {
  const entries = catalogSchemas().filter(entry => entry.name.startsWith('mcp__'))
  const ranked = rankByQuery('issue', entries).map(entry => entry.name)
  assert.deepEqual(ranked, ['mcp__gh__close_issue', 'mcp__gh__create_issue', 'mcp__gh__list_issues'])
  // A description-only match still qualifies, at a lower weight.
  assert.deepEqual(rankByQuery('directory', entries).map(entry => entry.name), ['mcp__fs__list_dir'])
})

test('seam B: the prefilter drops non-matches entirely and caps the pool', () => {
  const entries = [
    ...catalogSchemas().filter(entry => entry.name.startsWith('mcp__')),
    ...Array.from({ length: 60 }, (_unused, i) => schema(`mcp__s__issue_${i}`, 'issue tool')),
  ]
  const ranked = rankByQuery('issue', entries)
  assert.equal(ranked.length, 63, 'the three fs tools match neither name nor description')
  assert.equal(rankByQuery('issue', entries, 40).length, RANK_CANDIDATE_LIMIT)
  assert.deepEqual(rankByQuery('kubernetes', entries), [], 'no match is not a weak match')
  assert.deepEqual(rankByQuery('   ', entries), [], 'an empty query matches nothing (the builder never asks)')
})

// ---- the CJK fallback (a Chinese query is the common case, not an edge) ----

/** A catalog the way a Chinese-language dsh deployment actually looks. */
function chineseCatalogSchemas() {
  return [
    schema('mcp__fs__read_file', '从磁盘读取一个文件的内容'),
    schema('mcp__fs__write_file', '把内容写入磁盘上的文件'),
    schema('mcp__fs__list_dir', '列出目录下的文件和子目录'),
    schema('mcp__gh__create_issue', '在 GitHub 上创建一个 issue'),
    schema('mcp__notion__搜索页面', '在 Notion 里搜索页面'),
    schema('mcp__web__search', '在网络上搜索网页内容'),
  ]
}

/**
 * A catalog the way MCP VENDORS actually ship it: every name and every blurb in
 * English, whatever language the dsh model thinks in. The CJK bigram fallback
 * can only hit a description that itself contains CJK, so this pool is the one
 * a Chinese query has always found nothing in — while being full of tools.
 */
function englishCatalogSchemas() {
  return [
    schema('mcp__context7__resolve-library-id', 'Resolve a library id to a documentation index'),
    schema('mcp__context7__query-docs', 'Query the documentation of a library by topic'),
    schema('mcp__deepwiki__read_wiki_structure', 'Read the documentation structure of a repository'),
    schema('mcp__deepwiki__ask_question', 'Ask a question about the code of a repository'),
    schema('mcp__github__search_code', 'Search code across GitHub repositories'),
  ]
}

test('seam B: a Chinese query reaches the prefilter instead of matching nothing', () => {
  // Before the fallback, tokenize('搜索文件') returned [] and every Chinese
  // query was answered "no MCP tool matches the query" — for a search that
  // never happened.
  assert.deepEqual(tokenize('搜索文件'), [], 'the ASCII tokenizer still sees nothing (that is why the fallback exists)')
  const entries = chineseCatalogSchemas()
  assert.deepEqual(
    rankByQuery('搜索文件', entries).map(entry => entry.name),
    ['mcp__notion__搜索页面', 'mcp__fs__list_dir', 'mcp__fs__read_file', 'mcp__fs__write_file', 'mcp__web__search'],
    'a name hit outranks description hits; the rest are matched or not on their own bigrams',
  )
  // A name hit outranks a description hit, exactly as in the ASCII path.
  assert.deepEqual(rankByQuery('搜索', entries).map(entry => entry.name), ['mcp__notion__搜索页面', 'mcp__web__search'])
  // Latin bytes of a name are not CJK evidence: an ASCII-only tool cannot
  // answer a Chinese query.
  assert.deepEqual(rankByQuery('文件', entries).map(entry => entry.name), [
    'mcp__fs__list_dir',
    'mcp__fs__read_file',
    'mcp__fs__write_file',
  ])
})

test('seam B: a Chinese query that matches nothing is handed over, never denied', () => {
  const entries = chineseCatalogSchemas()
  // The pure prefilter still refuses to invent a hit…
  assert.deepEqual(rankByQuery('量子计算', entries), [], 'a bigram miss is a miss, not a weak match')
  assert.deepEqual(rankByQuery('　', entries), [], 'a query with neither script matches nothing')
  // …but the BUILDER no longer turns that miss into a claim about the catalog.
  // Nothing was ever searched, so "no MCP tool matches the query" was a lie
  // the model acted on; the honest answer is the directory itself.
  const pre = listQueryRanking({ query: '量子计算' }, entries, OPTIONS)
  assert.equal(pre.error, undefined, 'a lexical miss is not a catalog error')
  assert.equal(pre.semantic, true)
  assert.equal(pre.total, 6, 'the denominator is the visible catalog, not a match count')
  assert.deepEqual(
    pre.pool.map(candidate => candidate.name),
    ['mcp__fs__read_file', 'mcp__fs__write_file', 'mcp__fs__list_dir', 'mcp__gh__create_issue', 'mcp__notion__搜索页面', 'mcp__web__search'],
    'the whole visible catalog, in registry order, is what a reranker gets to judge',
  )
})

test('seam B: a Chinese query over an ALL-ENGLISH catalog is the case that fell through', () => {
  // The gap this file's fallback exists for: the CJK bigrams only hit a
  // description that itself contains CJK. A real vendor catalog
  // (context7/deepwiki/github) is English top to bottom, so a Chinese query
  // matched nothing — in a pool that was full of tools.
  const entries = englishCatalogSchemas()
  assert.ok(entries.every(entry => !/[㐀-鿿]/u.test(entry.description)), 'the catalog really is English-only')
  for (const query of ['搜索文件', '查文档', '怎么读文件']) {
    assert.deepEqual(rankByQuery(query, entries), [], `${query} has no lexical purchase on an English catalog`)
  }
  const pre = listQueryRanking({ query: '搜索文件' }, entries, OPTIONS)
  assert.equal(pre.error, undefined)
  assert.equal(pre.semantic, true)
  assert.equal(pre.total, entries.length)
})

test('seam B: with no reranker the semantic fallback is the catalog, not an error', async () => {
  const schemas = englishCatalogSchemas()
  const tool = createMcpListTool(OPTIONS, () => schemas) // jev switched off entirely
  const value = await tool.execute({ query: '搜索文件' }, execLike())
  assert.equal(value.error, undefined, 'the model is never told a search that never ran found nothing')
  assert.equal(value.ranked, false, 'and the answer does not claim to be a ranking')
  assert.equal(value.query, '搜索文件')
  assert.equal(value.total, 5)
  assert.deepEqual(
    value.servers.flatMap(group => group.tools).map(tool => tool.name),
    ['mcp__context7__resolve-library-id', 'mcp__context7__query-docs', 'mcp__deepwiki__read_wiki_structure', 'mcp__deepwiki__ask_question', 'mcp__github__search_code'],
    'the directory itself, in registry order (server groups flattened — the fixture is already grouped)',
  )
  assert.match(value.note, /^semantic fallback for query "搜索文件": 5 of 5 visible tool\(s\) — /)
  assert.match(value.note, /no lexical match and no semantic rerank, so the order is the catalog registry order/)
  assert.match(value.note, /mcp_list with no arguments for the full catalog/, 'both shapes point at the full catalog')
})

test('seam B: jev is asked about the whole catalog, and its answer orders it', async () => {
  const schemas = englishCatalogSchemas()
  const spy = rankerSpy(['mcp__deepwiki__read_wiki_structure'])
  const tool = createMcpListTool({ ...OPTIONS, rankQuery: spy.rankQuery }, () => schemas)
  const value = await tool.execute({ query: '查文档' }, execLike())
  assert.equal(spy.seen.length, 1)
  assert.equal(spy.seen[0].query, '查文档')
  assert.deepEqual(
    spy.seen[0].candidates,
    ['mcp__context7__resolve-library-id', 'mcp__context7__query-docs', 'mcp__deepwiki__read_wiki_structure', 'mcp__deepwiki__ask_question', 'mcp__github__search_code'],
    'the pool is the catalog — the reranker, not the prefilter, is what understands 查文档 against an English blurb',
  )
  assert.equal(value.ranked, false, 'a semantic order is not a lexical ranking, and says so')
  assert.equal(value.total, 5)
  assert.match(value.note, /^semantic fallback for query "查文档": 5 of 5 visible tool\(s\) — no lexical match, so the order is semantic relevance/)
  assert.deepEqual(
    value.servers.flatMap(group => group.tools).map(tool => tool.name),
    ['mcp__deepwiki__read_wiki_structure', 'mcp__deepwiki__ask_question', 'mcp__context7__resolve-library-id', 'mcp__context7__query-docs', 'mcp__github__search_code'],
    "jev's pick leads its server group, the rest of it behind, the other groups in registry order",
  )
})

test('seam B: a reranker that declines on the fallback still leaves a catalog', async () => {
  for (const declining of [
    async () => undefined,
    async () => [],
    async () => { throw new Error('jev exploded') },
  ]) {
    const tool = createMcpListTool({ ...OPTIONS, rankQuery: declining }, () => englishCatalogSchemas())
    const value = await tool.execute({ query: '怎么读文件' }, execLike())
    assert.equal(value.error, undefined, 'a failed rerank is not a failed search')
    assert.equal(value.ranked, false)
    assert.equal(value.total, 5)
    assert.match(value.note, /no semantic rerank/, 'and the note does not pretend an order arrived')
    assert.equal(value.servers.flatMap(group => group.tools).length, 5)
  }
})

test('seam B: the fallback pool is capped at the reranker batch size', () => {
  const schemas = Array.from({ length: 60 }, (_unused, i) => schema(`mcp__ctx__doc_${i}`, 'Query library documentation'))
  const pre = listQueryRanking({ query: '搜索文件' }, schemas, OPTIONS)
  assert.equal(pre.semantic, true)
  assert.equal(pre.pool.length, RANK_CANDIDATE_LIMIT, 'jev is not handed a whole 60-tool batch')
  assert.equal(pre.total, 60, 'but the model is told how much of the catalog it is not seeing')
  const result = buildMcpListResult({ query: '搜索文件' }, schemas, OPTIONS)
  assert.equal(result.ranked, false)
  assert.equal(result.total, 60)
  assert.equal(result.servers.flatMap(group => group.tools).length, LIST_RESULT_LIMIT)
  assert.match(result.note, /10 of 60 visible tool\(s\)/)
})

test('seam B: an empty or fully gated catalog is still an error (the fallback cannot fire)', () => {
  const nothing = listQueryRanking({ query: '搜索文件' }, [], OPTIONS)
  assert.match(nothing.error, /no MCP tools are registered under the "mcp__" prefix/)
  const schemas = catalogSchemas()
  const allOff = listQueryRanking({ query: '搜索文件' }, schemas, OPTIONS, { serverIds: { fs: 1, gh: 2 }, disabled: [1, 2] })
  assert.match(allOff.error, /every MCP tool under the "mcp__" prefix belongs to a disabled server/)
  assert.equal(allOff.semantic, undefined, 'a catalog with nothing in it is an error, not a fallback')
  const serverOff = listQueryRanking({ query: '搜索文件', server: 'gh' }, schemas, OPTIONS, { serverIds: { fs: 1, gh: 2 }, disabled: [2] })
  assert.match(serverOff.error, /server "gh" is disabled and hidden from the catalog/)
})

test('seam B: the CJK fallback leaves every ASCII ranking exactly where it was', () => {
  const ascii = catalogSchemas().filter(entry => entry.name.startsWith('mcp__'))
  // The pre-existing ASCII expectations, re-asserted next to the fallback.
  assert.deepEqual(rankByQuery('issue', ascii).map(entry => entry.name), ['mcp__gh__close_issue', 'mcp__gh__create_issue', 'mcp__gh__list_issues'])
  assert.deepEqual(rankByQuery('directory', ascii).map(entry => entry.name), ['mcp__fs__list_dir'])
  assert.deepEqual(rankByQuery('kubernetes', ascii), [])
  // A mixed catalog: an ASCII query keeps the ASCII ranking, and the Chinese
  // descriptions do not leak into it (one shared name, to keep it a set).
  const mixed = [...ascii, ...chineseCatalogSchemas().filter(entry => entry.name !== 'mcp__gh__create_issue')]
  assert.deepEqual(rankByQuery('issue', mixed).map(entry => entry.name), ['mcp__gh__close_issue', 'mcp__gh__create_issue', 'mcp__gh__list_issues'])
  // A mixed-script query has ASCII tokens, so it takes the ASCII path exactly
  // as before (the fallback only fires when the tokenizer sees nothing).
  assert.deepEqual(rankByQuery('搜索 issue', mixed).map(entry => entry.name), ['mcp__gh__close_issue', 'mcp__gh__create_issue', 'mcp__gh__list_issues'])
})

test('seam B: the ranking merge keeps the lexical remainder and ignores unknown names', () => {
  const names = ['a', 'b', 'c', 'd']
  assert.deepEqual(mergeNameOrder(names, ['d', 'a']), ['d', 'a', 'b', 'c'])
  assert.deepEqual(mergeNameOrder(names, ['c']), ['c', 'a', 'b', 'd'], 'a partial answer is a prefix, not a filter')
  assert.deepEqual(mergeNameOrder(names, ['zzz']), names, 'names outside the pool are ignored')
  assert.deepEqual(mergeNameOrder(names, ['b', 'b']), ['b', 'a', 'c', 'd'], 'repeats are collapsed')
  assert.deepEqual(mergeNameOrder(names, []), names)
  assert.deepEqual(names, ['a', 'b', 'c', 'd'], 'the input is never mutated')
})

// ---- listQueryRanking (pure) ----

test('seam B: the prefilter exposes the shortlist and the uncapped total', () => {
  const schemas = [
    ...catalogSchemas(),
    ...Array.from({ length: 50 }, (_unused, i) => schema(`mcp__s__issue_${i}`, 'an issue tool')),
  ]
  const pre = listQueryRanking({ query: 'issue' }, schemas, OPTIONS)
  assert.equal(pre.error, undefined)
  assert.equal(pre.pool.length, RANK_CANDIDATE_LIMIT, 'the pool is capped at the jev batch size')
  assert.equal(pre.total, 53, 'the total counts every match, not just the pool')
  assert.equal(pre.pool[0].name, 'mcp__gh__close_issue', 'name hits outrank the generic ones')
  assert.equal(pre.pool[0].description, 'Close an issue on GitHub', 'the pool carries the blurb a reranker needs')
})

test('seam B: a query that matches nothing lexically falls back to the catalog, never a throw', () => {
  const schemas = catalogSchemas()
  const pre = listQueryRanking({ query: 'kubernetes' }, schemas, OPTIONS)
  assert.equal(pre.error, undefined, 'nothing was searched; nothing can be reported')
  assert.equal(pre.semantic, true)
  assert.equal(pre.total, 6, 'the denominator is the visible catalog, not a match count')
  assert.deepEqual(
    pre.pool.map(candidate => candidate.name),
    ['mcp__fs__read_file', 'mcp__fs__write_file', 'mcp__fs__list_dir', 'mcp__gh__create_issue', 'mcp__gh__list_issues', 'mcp__gh__close_issue'],
  )
  // The builder agrees with the prefilter about what the fallback set is,
  // whether or not a ranking was handed in.
  const result = buildMcpListResult({ query: 'kubernetes' }, schemas, OPTIONS)
  assert.equal(result.ranked, false)
  assert.equal(result.total, 6)
  assert.match(result.note, /^semantic fallback for query "kubernetes": 6 of 6 visible tool\(s\)/)
  assert.match(result.note, /mcp_list with no arguments for the full catalog/)
  assert.deepEqual(
    result.servers.flatMap(group => group.tools).map(tool => tool.name),
    ['mcp__fs__read_file', 'mcp__fs__write_file', 'mcp__fs__list_dir', 'mcp__gh__create_issue', 'mcp__gh__list_issues', 'mcp__gh__close_issue'],
  )
})

test('seam B: the query path reuses the catalog filter contract (gate, prefix, whitelist)', () => {
  const schemas = catalogSchemas()
  // fs disabled, gh alive: the gh issue tools stay candidates, the fs ones
  // are not offered even though they would have matched.
  const fsOff = listQueryRanking({ query: 'issue' }, schemas, OPTIONS, { serverIds: { fs: 1, gh: 2 }, disabled: [1] })
  assert.deepEqual(fsOff.pool.map(entry => entry.name), ['mcp__gh__close_issue', 'mcp__gh__create_issue', 'mcp__gh__list_issues'])
  // gh disabled: the only server that matched is hidden, so the lexical pool
  // is empty — but the catalog is NOT, and saying "no MCP tool matches the
  // query" would have been a claim about three fs tools nobody looked at.
  const ghOff = listQueryRanking({ query: 'issue' }, schemas, OPTIONS, { serverIds: { fs: 1, gh: 2 }, disabled: [2] })
  assert.equal(ghOff.error, undefined)
  assert.equal(ghOff.semantic, true)
  assert.deepEqual(
    ghOff.pool.map(entry => entry.name),
    ['mcp__fs__read_file', 'mcp__fs__write_file', 'mcp__fs__list_dir'],
    'the fallback shows what is still visible, and nothing from the gate',
  )
  // Every matching server gone: the fully-gated wording, as on the plain path.
  const allOff = listQueryRanking({ query: 'mcp' }, schemas, OPTIONS, { serverIds: { fs: 1, gh: 2 }, disabled: [1, 2] })
  assert.match(allOff.error, /every MCP tool under the "mcp__" prefix belongs to a disabled server/)
  assert.equal(allOff.semantic, undefined, 'an empty catalog is still an error, not a fallback')
  const whitelisted = listQueryRanking({ query: 'issue' }, schemas, { ...OPTIONS, servers: ['fs'] })
  assert.deepEqual(
    whitelisted.pool.map(entry => entry.name),
    ['mcp__fs__read_file', 'mcp__fs__write_file', 'mcp__fs__list_dir'],
    'a server-filtered query cannot escape the whitelist — its fallback is the whitelisted catalog',
  )
})

// ---- buildMcpListResult, query path ----

test('seam B: a query answer is a self-describing ranked subset', () => {
  const result = buildMcpListResult({ query: 'issue' }, catalogSchemas(), OPTIONS)
  assert.equal(result.ranked, true)
  assert.equal(result.query, 'issue')
  assert.equal(result.total, 3, 'every match is counted, not just the shown ones')
  assert.match(result.note, /ranked view for query "issue": 3 of 3 matching tool\(s\)/)
  assert.match(result.note, /mcp_list with no arguments for the full catalog/, 'the model is told the full catalog exists')
  assert.deepEqual(result.servers.map(group => group.server), ['gh'])
  assert.deepEqual(result.servers[0].tools.map(tool => tool.name), ['mcp__gh__close_issue', 'mcp__gh__create_issue', 'mcp__gh__list_issues'])
})

test('seam B: a supplied ranking reorders the answer without changing the membership', () => {
  const schemas = catalogSchemas()
  const ranking = { query: 'issue', pool: listQueryRanking({ query: 'issue' }, schemas, OPTIONS).pool.map(c => c.name), total: 3, order: ['mcp__gh__list_issues', 'mcp__gh__create_issue'] }
  const result = buildMcpListResult({ query: 'issue' }, schemas, OPTIONS, undefined, ranking)
  assert.deepEqual(
    result.servers[0].tools.map(tool => tool.name),
    ['mcp__gh__list_issues', 'mcp__gh__create_issue', 'mcp__gh__close_issue'],
    'jev\'s prefix first, the lexical tail behind it',
  )
  assert.equal(result.total, 3)
})

test('seam B: a ranking for a different query is ignored rather than misapplied', () => {
  const schemas = catalogSchemas()
  const result = buildMcpListResult({ query: 'issue' }, schemas, OPTIONS, undefined, {
    query: 'directory',
    pool: ['mcp__fs__list_dir'],
    total: 1,
    order: ['mcp__fs__list_dir'],
  })
  assert.equal(result.ranked, true)
  assert.equal(result.query, 'issue')
  assert.equal(result.total, 3, 'the answer is still the issue query\'s own match set')
  assert.deepEqual(result.servers[0].tools.map(tool => tool.name), ['mcp__gh__close_issue', 'mcp__gh__create_issue', 'mcp__gh__list_issues'])
})

test('seam B: a ranking naming a tool outside the pool is ignored', () => {
  const schemas = catalogSchemas()
  const result = buildMcpListResult({ query: 'issue' }, schemas, OPTIONS, undefined, {
    query: 'issue',
    pool: ['mcp__gh__create_issue', 'mcp__gh__list_issues', 'mcp__gh__close_issue'],
    total: 3,
    order: ['mcp__gh__list_issues', 'not_a_tool', 'mcp__gh__create_issue'],
  })
  assert.deepEqual(
    result.servers[0].tools.map(tool => tool.name),
    ['mcp__gh__list_issues', 'mcp__gh__create_issue', 'mcp__gh__close_issue'],
  )
})

test('seam B: the ranked answer is capped at ten tools however big the catalog', () => {
  const schemas = Array.from({ length: 40 }, (_unused, i) => schema(`mcp__s__issue_${i}`, 'issue tool'))
  const result = buildMcpListResult({ query: 'issue' }, schemas, OPTIONS)
  const shown = result.servers.flatMap(group => group.tools)
  assert.equal(shown.length, LIST_RESULT_LIMIT)
  assert.equal(result.total, 40)
  assert.match(result.note, /10 of 40 matching tool\(s\)/)
  assert.equal(shown.length, LIST_RESULT_LIMIT, 'the model gets a shortlist, never a wall of text')
})

test('seam B: verbose and server filters compose with the query', () => {
  const schemas = catalogSchemas()
  const verbose = buildMcpListResult({ query: 'issue', verbose: true }, schemas, OPTIONS)
  assert.equal(verbose.servers[0].tools[0].parameters.type, 'object', 'verbose still inlines schemas on the ranked path')
  const scoped = buildMcpListResult({ query: 'issue', server: 'gh' }, schemas, OPTIONS)
  assert.equal(scoped.total, 3)
  const other = buildMcpListResult({ query: 'issue', server: 'fs' }, schemas, OPTIONS)
  assert.equal(other.error, undefined, 'the server filter applies before the query, so the fallback is the fs catalog')
  assert.equal(other.ranked, false)
  assert.equal(other.total, 3)
  assert.deepEqual(other.servers[0].tools.map(tool => tool.name), ['mcp__fs__read_file', 'mcp__fs__write_file', 'mcp__fs__list_dir'])
})

test('seam B: a `tool` expansion still wins over a query', () => {
  const result = buildMcpListResult({ tool: 'mcp__gh__create_issue', query: 'issue' }, catalogSchemas(), OPTIONS)
  assert.equal(result.ranked, undefined)
  assert.equal(result.tool.name, 'mcp__gh__create_issue')
})

// ---- the tool's async execute layer ----

test('seam B: the tool asks the reranker about the lexical shortlist and applies the answer', async () => {
  const spy = rankerSpy(['mcp__gh__list_issues', 'mcp__gh__create_issue'])
  const tool = createMcpListTool({ ...OPTIONS, rankQuery: spy.rankQuery }, () => catalogSchemas())
  const value = await tool.execute({ query: 'issue' }, execLike())
  assert.equal(spy.seen.length, 1)
  assert.equal(spy.seen[0].query, 'issue')
  assert.deepEqual(spy.seen[0].candidates, ['mcp__gh__close_issue', 'mcp__gh__create_issue', 'mcp__gh__list_issues'])
  assert.equal(value.ranked, true)
  assert.equal(value.total, 3)
  assert.deepEqual(value.servers[0].tools.map(tool => tool.name), ['mcp__gh__list_issues', 'mcp__gh__create_issue', 'mcp__gh__close_issue'])
  // The ranked answer renders as ordinary JSON, keys and all.
  const text = tool.output.render({ query: 'issue' }, value)[0].text
  assert.match(text, /"ranked": true/)
  assert.match(text, /"total": 3/)
})

test('seam B: a Chinese query is ranked by jev exactly like an ASCII one', async () => {
  // The prefilter is the only thing that used to fail on Chinese: with a
  // non-empty pool the query must reach the reranker and its answer must be
  // merged over the lexical order.
  const schemas = chineseCatalogSchemas()
  const pre = listQueryRanking({ query: '搜索文件' }, schemas, OPTIONS)
  assert.equal(pre.error, undefined, 'the misleading "no MCP tool matches" must not be the answer')
  assert.equal(pre.total, 5)

  const spy = rankerSpy(['mcp__web__search', 'mcp__fs__read_file'])
  const tool = createMcpListTool({ ...OPTIONS, rankQuery: spy.rankQuery }, () => schemas)
  const value = await tool.execute({ query: '搜索文件' }, execLike())
  assert.equal(spy.seen.length, 1)
  assert.equal(spy.seen[0].query, '搜索文件')
  assert.deepEqual(spy.seen[0].candidates, [
    'mcp__notion__搜索页面',
    'mcp__fs__list_dir',
    'mcp__fs__read_file',
    'mcp__fs__write_file',
    'mcp__web__search',
  ])
  assert.equal(value.total, 5)
  assert.match(value.note, /ranked view for query "搜索文件": 5 of 5 matching tool\(s\)/)
  assert.deepEqual(
    value.servers.flatMap(group => group.tools).map(tool => tool.name),
    ['mcp__web__search', 'mcp__fs__read_file', 'mcp__fs__list_dir', 'mcp__fs__write_file', 'mcp__notion__搜索页面'],
    "jev's prefix first, the CJK lexical tail behind it (server groups flattened)",
  )
})

test('seam B: a reranker that declines leaves the lexical order untouched', async () => {
  for (const declining of [
    async () => undefined,
    async () => [],
    async () => { throw new Error('jev exploded') },
  ]) {
    const tool = createMcpListTool({ ...OPTIONS, rankQuery: declining }, () => catalogSchemas())
    const value = await tool.execute({ query: 'issue' }, execLike())
    assert.deepEqual(value.servers[0].tools.map(t => t.name), ['mcp__gh__close_issue', 'mcp__gh__create_issue', 'mcp__gh__list_issues'])
  }
})

test('seam B: with no reranker wired at all the query path is purely lexical', async () => {
  const tool = createMcpListTool(OPTIONS, () => catalogSchemas())
  const value = await tool.execute({ query: 'github' }, execLike())
  assert.equal(value.ranked, true)
  // "github" only appears squashed inside two descriptions ("... on GitHub"),
  // which the lexical fallback still finds.
  assert.equal(value.total, 2)
  assert.deepEqual(value.servers.map(group => group.server), ['gh'])
  assert.deepEqual(value.servers[0].tools.map(tool => tool.name), ['mcp__gh__close_issue', 'mcp__gh__create_issue'])
})

test('seam B: the tool advertises `query` in its schema and description', () => {
  const tool = createMcpListTool(OPTIONS, () => [])
  assert.ok(tool.parameters.properties.query, 'query is a first-class argument')
  assert.equal(tool.parameters.properties.query.type, 'string')
  assert.match(tool.description, /"query"/)
  assert.match(tool.description, /relevance-ranked shortlist/)
  assert.match(tool.description, /unfiltered catalog is always one no-argument call away/)
  for (const key of ['query', 'ranked', 'total', 'note']) {
    assert.ok(tool.output.schema.properties[key], `the output schema admits ${key}`)
  }
  assert.equal(tool.name, MCP_LIST_TOOL_NAME)
})
