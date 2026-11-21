// Makes score.cloadm-state: a Dragon 64 on the built-in firmware running a small program of ours that adds up a
// score of 91 ($5B) in $3100 and shows SCORE KEPT on the screen. Run: node setup.js <media dir>
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'cli', 'mcp.js')), T = require(path.join(ROOT, 'js', 'mcp', 'tools.js')), { framePng } = require(path.join(ROOT, 'cli', 'cloadm.js'));
const SRC = ['        ORG     $3000', 'START   CLR     $3100', '        LDB     #13', 'ADD     LDA     $3100', '        ADDA    #7', '        STA     $3100',
  '        DECB', '        BNE     ADD', '        LDX     #MSG', '        LDY     #$0500', 'PR      LDA     ,X+', '        BEQ     DONE', '        STA     ,Y+',
  '        BRA     PR', 'DONE    BRA     DONE', 'MSG     FCC     /SCORE KEPT/', '        FCB     0', '        END     START'].join('\n');
(async () => {
  const tb = T.createToolbox(M.nodeHost({ mediaRoot: path.resolve(process.argv[2] || '.'), roms: [], png: framePng }), {});
  const call = async (name, args) => { const r = await tb.call(name, args); if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`); return r.data; };
  await call('boot', { model: 'dragon64' });
  await call('run_frames', { machine_id: 'm1', until: { text: 'BUILT-IN STUB' } });
  await call('assemble_and_load', { machine_id: 'm1', source: SRC });
  await call('run', { machine_id: 'm1', target: '$3000' });
  await call('run_frames', { machine_id: 'm1', until: { text: 'SCORE KEPT' } });
  await call('save_snapshot', { machine_id: 'm1', path: 'score.cloadm-state' });
  // nothing else in the snapshot says the score: the screen shows no number
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
