import fs from 'node:fs';
for (const f of process.argv.slice(2)) {
  const ir = JSON.parse(fs.readFileSync(f, 'utf8'));
  let total = 0, withUIT = 0, mounts = 0, missingFiles = [];
  const walk = (n) => {
    total++;
    if (n.components.some(c => c.type === 'cc.UITransform')) withUIT++;
    if (n.mountedFrom) mounts++;
    n.children.forEach(walk);
  };
  walk(ir.nodes[0]);
  for (const a of ir.assets) if (a.kind === 'spriteFrame' && !a.exists) missingFiles.push(a.uuid);
  const instRefs = ir.unresolved.filter(u => u.category === 'instance-ref').length;
  const sv = ir.nodes[0] && JSON.stringify(ir).split('"cc.ScrollView"').length - 1;
  console.log(`${f}
  nodes=${total} withUITransform=${withUIT} (${(withUIT/total*100).toFixed(1)}%) mounted=${mounts}
  unresolved=${ir.unresolved.length} instanceRefs=${instRefs}
  assets=${ir.assets.length} spriteMissing=${missingFiles.length} ${missingFiles.join(',')}
  scrollViewOccurrences=${sv}
  unresolvedDetail=${JSON.stringify(ir.unresolved.slice(0,3))}
  warnings=${JSON.stringify((ir.meta.warnings||[]).slice(0,5))}`);
}
