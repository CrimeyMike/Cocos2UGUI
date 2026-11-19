// t8-references.mjs — 引用完整性与结构完整性(全树遍历)
import { loadBuild } from './lib.mjs';
import assert from 'node:assert/strict';

const panels = {
  guide: loadBuild('demo-pfb_demo_guide'),
  home: loadBuild('demo-demo_rank_reward'),
  battle: loadBuild('demo-ui-demo_statistic_view'),
};
const expectNodes = { guide: 9, home: 46, battle: 100 };

for (const [k, b] of Object.entries(panels)) {
  const spriteNames = new Set(b.sprites.map(s => s.name));
  const scriptIds = new Set(b.scripts.map(s => s.uuidHash));
  const names = [];
  let nodeCount = 0, markerCount = 0, spriteNull = 0, imageCount = 0;

  (function walk(n) {
    nodeCount++;
    names.push(n.name);
    for (const c of n.components || []) {
      if (c.type === 'Image') {
        imageCount++;
        if (c.props.sprite === null) spriteNull++;
        else assert.ok(spriteNames.has(c.props.sprite), `${k}/${n.name}: Image.sprite "${c.props.sprite}" 未在 sprites[]`);
      }
      if (c.type === 'CustomScript') assert.ok(scriptIds.has(c.props.script), `${k}/${n.name}: CustomScript.script 未在 scripts[]`);
      if (c.type === 'Marker') {
        markerCount++;
        assert.ok(c.props.reason && c.props.source, `${k}/${n.name}: Marker 缺 reason/source`);
      }
    }
    n.children?.forEach(walk);
  })(b.root);

  assert.equal(nodeCount, expectNodes[k], `${k}: 节点数 ${nodeCount} != IR 节点数 ${expectNodes[k]}`);
  // ScrollRect.content 必须指向树内节点
  (function walk2(n) {
    for (const c of n.components || []) if (c.type === 'ScrollRect') {
      assert.ok(names.includes(c.props.content), `${k}: ScrollRect.content "${c.props.content}" 不在树内`);
    }
    n.children?.forEach(walk2);
  })(b.root);
  // scripts[].className 唯一
  const cls = b.scripts.map(s => s.className);
  assert.equal(new Set(cls).size, cls.length, `${k}: className 重复`);
}

// 具体计数(与 IR stats 对账)
assert.equal(panels.guide.sprites.length, 4);
assert.equal(panels.home.sprites.length, 15);
assert.equal(panels.battle.sprites.length, 22);
assert.equal(panels.home.scripts.length, 9);
assert.equal(panels.battle.scripts.length, 7);

// 动态 sprite(运行时赋值, _spriteFrame 未序列化)→ Image.sprite=null, 不产生悬空引用
{
  const home = panels.home;
  let quality = null;
  (function w(n) { if (n.name === '_spr:quality') quality = n; n.children?.forEach(w); })(home.root);
  assert.ok(quality, 'home _spr:quality 节点存在');
  assert.equal(quality.components.find(c => c.type === 'Image').props.sprite, null, '动态 Sprite → null');
}

// battle: Button(SCALE 过渡降级) + Marker 计数 + inactive 节点保留
{
  const battle = panels.battle;
  let btn = null, winTips = null;
  (function w(n) {
    if (n.components?.some(c => c.type === 'Button')) btn = n;
    if (n.name === '_nd:win_num_tips') winTips = n;
    n.children?.forEach(w);
  })(battle.root);
  assert.equal(btn.name, '_btn:close');
  assert.equal(btn.components.find(c => c.type === 'Button').props.transition, 'None', 'SCALE 过渡降级 None');
  assert.ok(battle.unmapped.some(u => u.component === 'cc.Button._transition'), 'SCALE 降级记录 unmapped');
  assert.equal(winTips.active, false, '_nd:win_num_tips inactive 保留');
  let markers = 0;
  (function w(n) { for (const c of n.components || []) if (c.type === 'Marker') markers++; n.children?.forEach(w); })(battle.root);
  assert.equal(markers, 7, 'battle Marker = spine×4 + ProgressBar×2 + BlockInput×1');
}
// home: item_card 嵌套展开节点 active=false 保留
{
  let awaken = null;
  (function w(n) { if (n.name === '_nd:awaken') awaken = n; n.children?.forEach(w); })(panels.home.root);
  assert.equal(awaken.active, false, 'home _nd:awaken inactive 保留');
}
console.log('t8-references: 全部通过');
