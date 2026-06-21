import { describe, it, expect } from 'vitest'
import { KV, STREAM, generateId, charBigramSimilarity, nearDuplicateTitle } from '../src/state/schema.js'

describe('KV', () => {
  it('has correct session scope', () => {
    expect(KV.sessions).toBe('mem:sessions')
  })

  it('generates observation scope with session ID', () => {
    expect(KV.observations('ses_123')).toBe('mem:obs:ses_123')
  })

  it('has correct summaries scope', () => {
    expect(KV.summaries).toBe('mem:summaries')
  })
})

describe('STREAM', () => {
  it('has correct name', () => {
    expect(STREAM.name).toBe('mem-live')
  })

  it('group returns session ID', () => {
    expect(STREAM.group('ses_123')).toBe('ses_123')
  })
})

describe('generateId', () => {
  it('includes prefix', () => {
    expect(generateId('obs')).toMatch(/^obs_/)
  })

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId('test')))
    expect(ids.size).toBe(100)
  })

  it('has sufficient length', () => {
    const id = generateId('obs')
    expect(id.length).toBeGreaterThan(15)
  })
})

describe('charBigramSimilarity', () => {
  it('treats identical and empty strings as fully similar', () => {
    expect(charBigramSimilarity('克隆上游项目到子目录', '克隆上游项目到子目录')).toBe(1)
    expect(charBigramSimilarity('', '')).toBe(1)
  })

  it('scores CJK rewordings high where whitespace jaccard cannot', () => {
    // insertion and word-order drift of the same task
    expect(charBigramSimilarity('克隆上游项目到子目录', '克隆上游项目到子目录中')).toBeGreaterThanOrEqual(0.7)
    expect(charBigramSimilarity('克隆上游项目到子目录', '把上游项目克隆到子目录')).toBeGreaterThanOrEqual(0.7)
  })

  it('keeps unrelated CJK titles well below the dedup bar', () => {
    expect(charBigramSimilarity('修复登录态失效后摘要不显示', '克隆上游项目到子目录')).toBeLessThan(0.3)
    expect(charBigramSimilarity('修复摘要按钮', '克隆上游项目到子目录')).toBeLessThan(0.3)
  })

  it('ignores punctuation, whitespace, and case', () => {
    expect(charBigramSimilarity('Fix the CI failure', 'fix  the   ci, failure!')).toBe(1)
  })
})

describe('nearDuplicateTitle', () => {
  it('collapses CJK rewordings of the same task (insertion, word-order)', () => {
    expect(nearDuplicateTitle('克隆上游项目到子目录', '克隆上游项目到子目录中')).toBe(true)
    expect(nearDuplicateTitle('克隆上游项目到子目录', '克隆上游项目到子目录下')).toBe(true)
    expect(nearDuplicateTitle('克隆上游项目到子目录', '把上游项目克隆到子目录')).toBe(true)
  })

  it('keeps two-char CJK substitutions apart (possibly distinct tasks)', () => {
    // identical surface shape, but 项目/仓库 and 失效/超时 may be different work —
    // both sit at/below ~0.667, under the 0.70 bar, so neither is collapsed.
    expect(nearDuplicateTitle('克隆上游项目到子目录', '克隆上游仓库到子目录')).toBe(false)
    expect(nearDuplicateTitle('修复登录态失效问题', '修复登录态超时问题')).toBe(false)
  })

  it('never collapses a polarity flip even at very high surface similarity', () => {
    // sim 0.77–0.93 but the negation makes them opposite tasks
    expect(charBigramSimilarity('支持离线缓存模式', '不支持离线缓存模式')).toBeGreaterThanOrEqual(0.7)
    expect(nearDuplicateTitle('支持离线缓存模式', '不支持离线缓存模式')).toBe(false)
    expect(nearDuplicateTitle('启用实验性缓存', '禁用实验性缓存')).toBe(false)
    expect(nearDuplicateTitle('登录后显示摘要', '登录后不显示摘要')).toBe(false)
    expect(nearDuplicateTitle('enable offline cache mode', 'disable offline cache mode')).toBe(false)
  })

  it('never collapses differing numbers, versions, or ordinals', () => {
    expect(charBigramSimilarity('升级依赖到 v2', '升级依赖到 v3')).toBeGreaterThanOrEqual(0.7)
    expect(nearDuplicateTitle('升级依赖到 v2', '升级依赖到 v3')).toBe(false)
    expect(nearDuplicateTitle('迁移到 node 18', '迁移到 node 20')).toBe(false)
    expect(nearDuplicateTitle('把超时改成30秒', '把超时改成60秒')).toBe(false)
    expect(nearDuplicateTitle('实现第一阶段迁移', '实现第二阶段迁移')).toBe(false)
  })

  it('never collapses English titles that differ by one content word', () => {
    expect(charBigramSimilarity('fix the login bug', 'fix the logout bug')).toBeGreaterThanOrEqual(0.7)
    expect(nearDuplicateTitle('fix the login bug', 'fix the logout bug')).toBe(false)
    expect(nearDuplicateTitle('update the user docs', 'update the user code')).toBe(false)
    expect(nearDuplicateTitle('refactor the auth module', 'refactor the auth method')).toBe(false)
  })

  it('does not fuzzy-match titles shorter than the 6-char floor', () => {
    // '克隆上游项' (5) vs '克隆上游项目' is bigram-similar but too short to trust
    expect(charBigramSimilarity('克隆上游项', '克隆上游项目')).toBeGreaterThanOrEqual(0.7)
    expect(nearDuplicateTitle('克隆上游项', '克隆上游项目')).toBe(false)
    expect(nearDuplicateTitle('修复CI', '修复CD')).toBe(false)
  })

  it('measures the floor on the same normalization the scorer uses (no whitespace inflation)', () => {
    // raw 'fix ci' is 6 chars but its canonical form 'fixci' is 5 — it must
    // fall below the floor, not collapse with the distinct task 'fix cd'.
    expect(nearDuplicateTitle('fix ci', 'fix cd')).toBe(false)
    expect(nearDuplicateTitle('use ci', 'use cd')).toBe(false)
  })
})
