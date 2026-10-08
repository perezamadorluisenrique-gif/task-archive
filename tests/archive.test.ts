import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyChanges, dedent, findCompleted, planInNote, splitLines, taskAround } from '../src/archive.ts';
import type { ArchiveOptions } from '../src/archive.ts';

const O: ArchiveOptions = { doneMarkers: 'xX', heading: 'Archive', level: 2, dateHeading: '', includeNested: true };
const run = (text: string, o: Partial<ArchiveOptions> = {}) => {
  const plan = planInNote(text, { ...O, ...o });
  return plan ? applyChanges(text, plan.changes) : null;
};

test('moves finished tasks under a new heading at the end', () => {
  assert.equal(run('# Plan\n- [ ] open\n- [x] done\n- [ ] open 2\n'), '# Plan\n- [ ] open\n- [ ] open 2\n\n## Archive\n\n- [x] done\n');
});

test('takes the nested lines along and leaves unfinished siblings', () => {
  const text = '- [x] parent\n  - child\n  - [ ] open child\n- [ ] stay\n';
  assert.equal(run(text), '- [ ] stay\n\n## Archive\n\n- [x] parent\n  - child\n  - [ ] open child\n');
});

test('a finished child of an open task moves alone, dedented', () => {
  const text = '- [ ] parent\n  - [x] child\n    - note\n  - [ ] other\n';
  assert.equal(run(text), '- [ ] parent\n  - [ ] other\n\n## Archive\n\n- [x] child\n  - note\n');
  assert.equal(run(text, { includeNested: false }), null);
});

test('appends to an existing archive section, before the next heading', () => {
  const text = '- [x] a\n\n## Archive\n\n- [x] old\n\n## Notes\ntext\n';
  assert.equal(run(text), '\n## Archive\n\n- [x] old\n- [x] a\n\n## Notes\ntext\n');
});

test('tasks already archived are not archived again', () => {
  assert.equal(run('## Archive\n- [x] old\n'), null);
});

test('groups by date, reusing today\'s group', () => {
  const o = { dateHeading: '2026-10-08' };
  const first = run('- [x] a\n', o) ?? '';
  assert.equal(first, '\n## Archive\n\n### 2026-10-08\n\n- [x] a\n');
  const again = run(`- [x] b\n${first}`, o);
  assert.equal(again, "\n## Archive\n\n### 2026-10-08\n\n- [x] a\n- [x] b\n");
  const other = run('- [x] new\n\n## Archive\n\n### 2026-10-07\n\n- [x] old\n', o);
  assert.equal(other, '\n## Archive\n\n### 2026-10-07\n\n- [x] old\n\n### 2026-10-08\n\n- [x] new\n');
});

test('ignores code fences and front matter', () => {
  const text = '---\nx: "- [x] no"\n---\n```\n- [x] code\n```\n- [x] real\n';
  const plan = planInNote(text, O);
  assert.equal(plan?.count, 1);
  assert.deepEqual(plan?.blocks, [['- [x] real']]);
});

test('custom done markers and numbered or starred lists', () => {
  assert.equal(findCompleted(splitLines('1. [x] a\n* [-] b\n+ [X] c\n'), { ...O, doneMarkers: 'x-' }).length, 2);
});

test('last line without a newline', () => {
  assert.equal(run('- [ ] a\n- [x] b'), '- [ ] a\n\n## Archive\n\n- [x] b\n');
});

test('only inside the given line range', () => {
  const text = '- [x] a\n- [x] b\n- [x] c\n';
  const plan = planInNote(text, O, 1, 2);
  assert.deepEqual(plan?.blocks, [['- [x] b']]);
});

test('task at cursor: the line itself or the one that holds it', () => {
  const lines = splitLines('- [ ] top\n  - child text\n    deep\n- [ ] next\n');
  assert.equal(taskAround(lines, 0)?.end, 3);
  assert.equal(taskAround(lines, 2)?.start, 0);
  assert.equal(taskAround(splitLines('plain\n- [ ] t\n'), 0), null);
});

test('dedent', () => {
  assert.deepEqual(dedent(['\t- [x] a', '\t\t- b']), ['- [x] a', '\t- b']);
});
