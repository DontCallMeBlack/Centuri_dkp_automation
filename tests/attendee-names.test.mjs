import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAttendeeRoster, matchAttendeeNames, toonNameSimilarity } from '../lib/attendeeNames.ts';

const toon = (account, rowIndex = 3, owner = 'Member') => ({ rowIndex, owner, account, subClass: 'Support Druid' });
const copiedNames = 'Druidprov8 khuno bulajing rxm note3 crizvia healsbeast incin nitroranger rasberries icymagic montage pogba ftw salhorgordon draculaX oogway74 Vexana';

test('the supplied space-separated attendance list selects every named toon', () => {
  const roster = copiedNames.split(' ').map((name, index) => toon(name, index + 3));
  const matches = matchAttendeeNames(copiedNames, [...roster, toon('Unrelated', 99)]);
  assert.deepEqual(matches.rows, roster.map(record => record.rowIndex));
  assert.equal(matches.matchedCount, 18);
  assert.deepEqual(matches.fuzzy, []);
  assert.deepEqual(matches.unmatched, []);
  assert.deepEqual(matches.ambiguous, []);
});

test('pasted names tolerate case, repeated whitespace and duplicate names without duplicate selections', () => {
  const matches = matchAttendeeNames('  HEALSBEAST\tKhuno\r\nhealsbeast  ', [toon('Healsbeast'), toon('khuno', 4)]);
  assert.deepEqual(matches.rows, [3, 4]);
  assert.equal(matches.matchedCount, 2);
  assert.deepEqual(matchAttendeeNames(' \t\n', [toon('Khuno')]).rows, []);
});

test('cosine matching uses ordered bigrams and the requested 80 percent threshold', () => {
  assert.equal(toonNameSimilarity('ABCDEF', 'abcdex'), 0.8);
  assert.deepEqual(matchAttendeeNames('abcdex', [toon('abcdef')]).rows, [3]);
  const close = matchAttendeeNames('healsbeas', [toon('healsbeast')]);
  assert.deepEqual(close.rows, [3]);
  assert.ok(close.fuzzy[0].similarity >= 0.8);
  assert.equal(close.fuzzy[0].name, 'healsbeast');
  assert.deepEqual(matchAttendeeNames('oogway75', [toon('oogway74')]).rows, [3]);
  assert.deepEqual(matchAttendeeNames('oogwayXX', [toon('oogway74')]).unmatched, ['oogwayXX']);
  assert.ok(toonNameSimilarity('abc', 'cba') < 0.8);
  assert.equal(toonNameSimilarity('', ''), 0);
  assert.equal(toonNameSimilarity('a', 'b'), 0);
});

test('exact names win over fuzzy alternatives and unknown names stay unselected', () => {
  const matches = matchAttendeeNames('healsbeas missing', [toon('healsbeast'), toon('healsbeas', 4)]);
  assert.deepEqual(matches.rows, [4]);
  assert.deepEqual(matches.fuzzy, []);
  assert.deepEqual(matches.unmatched, ['missing']);
});

test('multiple fuzzy candidates or duplicate exact toon names require manual selection', () => {
  const fuzzy = matchAttendeeNames('healsbeas', [toon('healsbeast'), toon('healsbeastz', 4)]);
  assert.deepEqual(fuzzy.rows, []);
  assert.deepEqual(fuzzy.ambiguous, ['healsbeas']);
  const exact = matchAttendeeNames('Khuno', [toon('Khuno'), toon('khuno', 4, 'Another member')]);
  assert.deepEqual(exact.rows, []);
  assert.deepEqual(exact.ambiguous, ['Khuno']);
});

test('owner names never select all of their alts; only blank toon names fall back to owner', () => {
  const roster = [toon('Main', 3, 'Khuno'), toon('Alt', 4, 'Khuno'), toon('', 5, 'Legacy')];
  const matches = matchAttendeeNames('Khuno Legacy', roster);
  assert.deepEqual(matches.rows, [5]);
  assert.deepEqual(matches.unmatched, ['Khuno']);
});

test('an exact multiword toon pasted alone remains one identity', () => {
  assert.deepEqual(matchAttendeeNames(' Moon Blade ', [toon('Moon Blade'), toon('Moon', 4)]).rows, [3]);
});

test('compact pasted names match sheet names containing spaces as exact matches', () => {
  const roster = [toon('icy magic'), toon('heals beast', 4), toon('Vexana', 5)];
  const matches = matchAttendeeNames('icymagic healsbeast vexana', roster);
  assert.deepEqual(matches.rows, [3, 4, 5]);
  assert.deepEqual(matches.fuzzy, []);
  assert.equal(toonNameSimilarity(' ICY MAGIC ', 'icymagic'), 1);
  assert.deepEqual(filterAttendeeRoster(roster, 'icymagic'), [roster[0]]);
});

test('names identical after removing spaces require manual selection', () => {
  const matches = matchAttendeeNames('icymagic', [toon('icy magic'), toon('IcyMagic', 4)]);
  assert.deepEqual(matches.rows, []);
  assert.deepEqual(matches.ambiguous, ['icymagic']);
});

test('manual search keeps owner, toon, and role filters and includes fuzzy toon matches', () => {
  const roster = [toon('healsbeast'), { ...toon('khuno', 4, 'Other'), subClass: 'Tank' }];
  assert.deepEqual(filterAttendeeRoster(roster, 'healsbeas'), [roster[0]]);
  assert.deepEqual(filterAttendeeRoster(roster, 'tank'), [roster[1]]);
  assert.deepEqual(filterAttendeeRoster(roster, 'other'), [roster[1]]);
  assert.deepEqual(filterAttendeeRoster(roster, '  '), roster);
});
