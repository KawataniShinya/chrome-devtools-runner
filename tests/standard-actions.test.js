const test = require('node:test');
const assert = require('node:assert/strict');
const {ChromeMcpCli} = require('../scripts/chrome-devtools-runner');

test('scoped file and field arguments preserve spaces and instruction separators', () => {
    const cli = new ChromeMcpCli({tools:[]});
    const actions = cli.parseInstruction('upload "row=A >> input[type=file]" "a and b.csv" then expect count ".line" 2');
    assert.deepEqual(actions[0], {type:'upload', target:'row=A >> input[type=file]', value:'a and b.csv'});
    assert.equal(actions[1].type, 'expect-count');
    assert.throws(() => cli.parseInstruction('expect count ".line" -1'));
    assert.throws(() => cli.parseInstruction('expect state button unknown'));
});
