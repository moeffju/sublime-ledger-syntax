const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const textmate = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const root = path.join(__dirname, '..');
const grammars = ['Ledger.JSON-tmLanguage', 'Ledger.tmLanguage'].map(file => ({
  file,
  raw: textmate.parseRawGrammar(
    fs.readFileSync(path.join(root, file), 'utf8'),
    file === 'Ledger.JSON-tmLanguage' ? 'ledger.json' : file
  )
}));
const onigLib = oniguruma.loadWASM(
  fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'))
).then(() => ({
  createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
  createOnigString: text => new oniguruma.OnigString(text)
}));

const comment = 'comment.line';
const account = 'markup.bold.account';
const amount = 'variable.other.amount';
const desc = 'markup.italic.desc';
const keyword = 'keyword.control';
const note = 'constant.other';

// Each fixture starts with a fresh rule stack; lines within a fixture share it.
const fixtures = [
  {
    name: 'transaction and posting notes',
    lines: [
      ['; global comment', [['; global comment', comment]]],
      ['2016/01/05 * Grocery store  ; transaction note', [
        ['2016/01/05', 'string.other.date'], ['* Grocery store', desc],
        ['; transaction note', comment]
      ]],
      ['    ; indented note', [['; indented note', comment]]],
      ['    Expenses:Food:Groceries      $ 25.50  ; posting note', [
        ['Expenses:Food:Groceries', account], ['$ 25.50', amount], ['; posting note', comment]
      ]],
      ['    Assets:Checking  ; inferred amount', [
        ['Assets:Checking', account], ['; inferred amount', comment]
      ]]
    ]
  },
  {
    name: 'tabs and mixed hard separators',
    lines: [
      ['2016-01-05 Store\t; tab note', [['Store', desc], ['; tab note', comment]]],
      ['2016/01/05 Store \t; mixed note', [['Store', desc], ['; mixed note', comment]]],
      ['2016/01/05 Store\t ; mixed note', [['Store', desc], ['; mixed note', comment]]],
      ['\tAssets:Checking\t; no amount', [['Assets:Checking', account], ['; no amount', comment]]],
      ['    Expenses:Food\t$25.50; adjacent note', [['$25.50', amount], ['; adjacent note', comment]]]
    ]
  },
  {
    name: 'literal semicolons and quoted commodities',
    lines: [
      ['2016/01/05 * Grocery store ; note', [['* Grocery store ; note', desc]]],
      ['2016/01/05 Shop;name', [['Shop;name', desc]]],
      ['2016/01/05 Shop ; literal  ; actual note', [
        ['Shop ; literal', desc], ['; actual note', comment]
      ]],
      ['    Assets:Checking ; literal', [['; literal', null]]],
      ['    Assets:Stock  2 "A; B"  ; real note', [
        ['"A; B"', amount], ['; real note', comment]
      ]],
      ['    Assets:Stock  2 "A\\\"; B"  ; real note', [
        ['"A\\\"; B"', amount], ['; real note', comment]
      ]]
    ]
  },
  {
    name: 'account directive context',
    lines: [
      ['account Assets:Checking', [['account', keyword], ['Assets:Checking', account]]],
      ['    note main', [['note', keyword], ['main', note]]],
      ['    ; account comment', [['; account comment', comment]]],
      ['\tnote second note', [['note', keyword], ['second note', note]]],
      ['account Expenses:Food', [['account', keyword], ['Expenses:Food', account]]],
      ['    note groceries', [['note', keyword], ['groceries', note]]],
      ['2016/01/05 Store  ; note', [['Store', desc], ['; note', comment]]],
      ['    note main', [['note main', account]]],
      ['    note main  $2  ; posting', [['note main', account], ['$2', amount], ['; posting', comment]]]
    ]
  },
  {
    name: 'directive context ends at blank lines and other directives',
    lines: [
      ['account Assets:Checking', [['account', keyword]]],
      ['    note main', [['note', keyword]]],
      ['', []],
      ['    note ordinary account', [['note ordinary account', account]]],
      ['account Assets:Checking', [['account', keyword]]],
      [' \t ', []],
      ['    note after whitespace', [['note after whitespace', account]]],
      ['account Assets:Checking', [['account', keyword]]],
      ['!include other.ledger', [['!include', keyword]]],
      ['    note ordinary account', [['note ordinary account', account]]]
    ]
  },
  {
    name: 'existing syntax',
    lines: [
      ['2016/01/05=2016/01/06 * Grocery store', [
        ['2016/01/05', 'string.other.date'], ['=', 'punctuation.separator'],
        ['2016/01/06', 'string.other.edate'], ['* Grocery store', desc]
      ]],
      ['    Expenses:Food:Groceries      $ 25.50', [['Expenses:Food:Groceries', account], ['$ 25.50', amount]]],
      ['    Assets:Credit Union:Checking', [['Assets:Credit Union:Checking', account]]],
      ['    Equity:Opening-Balances      -$25.50', [['Equity:Opening-Balances', account], ['-$25.50', amount]]],
      ['~ monthly', [['~', 'punctuation.section.period'], ['monthly', 'constant.other.expression']]],
      ['= /Expenses/', [['=', 'punctuation.section.automated'], ['/Expenses/', 'string.regexp.expression']]]
    ]
  }
];

test('JSON and plist encode the same grammar', () => {
  assert.deepEqual(grammars[0].raw, grammars[1].raw);
});

for (const { file, raw } of grammars) {
  for (const fixture of fixtures) {
    test(`${file}: ${fixture.name}`, async () => {
      const registry = new textmate.Registry({ onigLib, loadGrammar: async () => raw });
      try {
        const grammar = await registry.loadGrammar('source.ledger');
        let stack = textmate.INITIAL;
        for (const [line, checks] of fixture.lines) {
          const result = grammar.tokenizeLine(line, stack);
          stack = result.ruleStack;
          for (const [text, scope] of checks) {
            const start = line.indexOf(text);
            assert.notEqual(start, -1, `missing fixture text: ${text}`);
            for (let position = start; position < start + text.length; position++) {
              const token = result.tokens.find(t => t.startIndex <= position && t.endIndex > position);
              assert.deepEqual(token?.scopes, ['source.ledger', ...(scope ? [scope] : [])],
                `${JSON.stringify(line)} at ${position}: ${JSON.stringify(text)}`);
            }
          }
        }
      } finally {
        registry.dispose();
      }
    });
  }
}
