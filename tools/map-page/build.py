import csv, json, sys
repo = sys.argv[1]
tax = json.load(open(repo + '/packages/db/seed-taxonomy.json'))
pl = json.load(open(repo + '/packages/db/seed-placements.json'))
rows = {(r['kind'], r['id']): r for r in csv.DictReader(open(repo + '/docs/stage1/mapping.csv'))}
types = tax['content_types']; stages = [s['key'] for s in tax['stages']]
subs = {s['key'] for j in tax['jobs'] for s in j['subs']}
items = []; miss = 0; badsub = 0
for p in pl:
    r = rows.get((p['source_kind'], str(p['source_id'])))
    if not r: miss += 1; continue
    if p['primary'] not in subs: badsub += 1; continue
    mask = sum(1 << stages.index(s) for s in p['stages'] if s in stages)
    ct = p['content_type'] if p['content_type'] in types else 'other'
    items.append([r['title'].strip(), r['url'], r['updated'], int(r['views'] or 0), types.index(ct), mask,
                  p['primary'], [s for s in p['secondary'] if s in subs], 1 if p['outdated'] else 0, p['why']])
print('items', len(items), 'no title', miss, 'bad sub', badsub, file=sys.stderr)
D = {'stages': tax['stages'], 'jobs': tax['jobs'], 'types': types, 'items': items}
asof = max(i[2] for i in items)
m = ["January","February","March","April","May","June","July","August","September","October","November","December"]
html = open('template.html').read()
html = html.replace('__DATA__', json.dumps(D, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/'))
html = html.replace('__COUNT__', str(len(items))).replace('__ASOF__', f"{int(asof[8:])} {m[int(asof[5:7])-1]} {asof[:4]}")
open('index.html', 'w').write(html)
