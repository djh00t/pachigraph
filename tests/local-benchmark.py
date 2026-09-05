import json, urllib.request, uuid, hashlib, time, statistics, sqlite3
from pathlib import Path
thread=str(uuid.uuid4())
headers={'content-type':'application/json','oai-authenticated-user-id':'synthetic-benchmark','oai-authenticated-user-email':'benchmark@example.invalid'}
def call(path,method='GET',body=None):
 req=urllib.request.Request('http://127.0.0.1:8787'+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
 with urllib.request.urlopen(req,timeout=60) as r:return json.load(r)
def db_bytes():
 paths=[p for p in Path('dist/server/.wrangler/state/v3/d1').rglob('*.sqlite') if p.name!='metadata.sqlite']
 assert len(paths)==1
 with sqlite3.connect('file:'+str(paths[0].resolve())+'?mode=ro',uri=True) as c:
  return c.execute('PRAGMA page_count').fetchone()[0]*c.execute('PRAGMA page_size').fetchone()[0]
before=db_bytes();source_bytes=0;text_bytes=0
try:
 for batch in range(3):
  records=[]
  for j in range(100):
   n=batch*100+j
   text=('Synthetic engineering context, retry design, migrations, decisions. '*15)+f' uniqueevidence{n}'
   item={'id':hashlib.sha256(str(n).encode()).hexdigest(),'timestamp':'2026-09-05T00:00:00Z','text':text,'record':{'type':'response_item','payload':{'text':text}}}
   records.append(item);source_bytes+=len(json.dumps(item['record']).encode());text_bytes+=len(text.encode())
  result=call('/api/ingest','POST',{'thread_id':thread,'records':records});assert result['stored']==100,result
 after=db_bytes();durations=[]
 for n in range(20):
  start=time.perf_counter();result=call('/api/search?q=uniqueevidence149');durations.append((time.perf_counter()-start)*1000)
  assert len(result['results'])==1
 result={'kind':'synthetic local Workers sample, not production capacity proof','records':300,'source_bytes':source_bytes,'text_bytes':text_bytes,'d1_before_bytes':before,'d1_after_bytes':after,'d1_growth_bytes':after-before,'p50_search_ms':round(statistics.median(durations),2),'p95_search_ms':round(sorted(durations)[18],2),'queries':20}
 Path('docs/local-benchmark.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
finally:
 assert call('/api/thread?id='+thread,'DELETE')=={'deleted':True}
