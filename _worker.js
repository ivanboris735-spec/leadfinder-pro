const STATUSES = ['nouveau','à contacter','contacté','intéressé','gagné','perdu','ignoré'];
const DEFAULT_SETTINGS = {
  hot_score:'70', telegram_enabled:'0', telegram_bot_token:'', telegram_chat_id:'',
  webhook_enabled:'0', webhook_url:'', email_enabled:'0', resend_api_key:'', email_from:'', email_to:'',
  google_api_key:'', google_cx:'', x_bearer_token:'', telegram_source_bot_token:'', telegram_source_chats:'',
  feeds_text:'# Ajoutez une URL RSS/Atom par ligne.\n# Utilisez uniquement des flux/API autorisés.\n'
};
const SECRET_KEYS = new Set(['telegram_bot_token','webhook_url','resend_api_key','google_api_key','x_bearer_token','telegram_source_bot_token']);
const STOPWORDS = new Set(['de','du','des','le','la','les','un','une','et','ou','pour','avec','sur','dans','the','a','an','to','for','of','and','or','in','on','with','besoin','creation','création']);
const INTENTS = ['i need','we need','looking for','hiring','hire','wanted','seeking','need someone','cherche','je cherche','nous cherchons','besoin',"j'ai besoin",'recherche','à la recherche','freelance'];
const EXPANSIONS = [
  ['site web',['website','wordpress','landing page','web developer','ecommerce']],
  ['application',['mobile app','app developer','android app','ios app','web app']],
  ['affiche',['poster design','flyer design','graphic design','canva','logo']],
  ['assistant virtuel',['virtual assistant','VA','administrative assistant','data entry']],
  ['assistant',['virtual assistant','data entry','admin support']]
];

export async function onRequest(context){
  const {request, env} = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if(method === 'OPTIONS') return json({ok:true});
  try{
    const path = url.pathname.replace(/^\/api\/?/,'').replace(/\/$/,'');
    const parts = path ? path.split('/') : [];

    if(method === 'GET' && path === 'health') return json({ok:true, app:'LeadFinder Pro Cloudflare V6 Public NoAdmin', db:Boolean(env.DB), public:true});
    await ensureDb(env);

    if(method === 'GET' && path === 'stats') return json({ok:true, ...(await getStats(env))});
    if(method === 'GET' && path === 'leads') return json({ok:true, ...(await listLeads(env, url.searchParams))});
    if(method === 'GET' && path === 'settings') return json({ok:true, settings:await getSettings(env, true)});
    if(method === 'POST' && path === 'settings') { await updateSettings(env, await readJson(request)); return json({ok:true}); }
    if(method === 'GET' && path === 'feeds') { const s = await getSettings(env, false); return json({ok:true, text:s.feeds_text || ''}); }
    if(method === 'POST' && path === 'feeds') { const body = await readJson(request); await saveFeeds(env, String(body.text || '')); return json({ok:true}); }

    if(method === 'POST' && path === 'scan'){
      const body = await readJson(request);
      const query = String(body.query || '').trim();
      if(!query) return json({ok:false, error:'Mot-clé manquant'}, 400);
      let sources = body.sources || ['freelancer','reddit','hn','rss'];
      if(typeof sources === 'string') sources = sources.split(',').map(s=>s.trim()).filter(Boolean);
      let limit = Number(body.limit || 20); if(!Number.isFinite(limit)) limit = 20; limit = Math.max(1, Math.min(limit, 100));
      const settings = await getSettings(env, false);
      const {leads, errors, source_status} = await searchAll(query, sources, limit, settings, env);
      const saved = []; let newCount = 0;
      for(const lead of leads){
        const info = await saveLead(env, lead, query);
        const item = {...lead, id:info.id, is_new:info.is_new, query};
        if(info.is_new) newCount++;
        saved.push(item);
      }
      const scanId = await recordScan(env, query, sources, limit, leads.length, saved.length, newCount, errors);
      const alerts = await sendAlerts(env, saved, true);
      return json({ok:true, scan_id:scanId, query, results:saved, errors, source_status, saved_count:saved.length, new_count:newCount, alerts});
    }

    if(method === 'GET' && path === 'export'){
      const rows = await exportLeads(env, url.searchParams);
      const fields = ['id','score','status','source','title','need','budget','posted_at','client','contact_type','contact','url','tags','query','note','created_at','last_seen'];
      return new Response(toCsv(rows, fields), {headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="leadfinder-export.csv"'}});
    }

    if(method === 'POST' && path === 'test-alert'){
      const fake = {id:null,is_new:true,score:99,source:'Test LeadFinder',title:"Test d'alerte lead chaud",need:'Ceci est un test Telegram/Webhook/Email Resend.',budget:'',client:'Test',url:url.origin,tags:'test'};
      return json({ok:true, results:await sendAlerts(env, [fake], false)});
    }

    if(parts[0] === 'leads' && parts[1]){
      const id = Number(parts[1]);
      if(method === 'GET' && parts[2] === 'message'){
        const lead = await getLead(env, id);
        if(!lead) return json({ok:false, error:'Lead introuvable'}, 404);
        return json({ok:true, message:generatePitch(lead)});
      }
      if(method === 'POST' && parts[2] === 'status'){
        const body = await readJson(request);
        if(!STATUSES.includes(String(body.status || ''))) return json({ok:false, error:'Statut invalide'}, 400);
        await env.DB.prepare('UPDATE leads SET status=? WHERE id=?').bind(String(body.status), id).run();
        return json({ok:true});
      }
      if(method === 'POST' && parts[2] === 'note'){
        const body = await readJson(request);
        await env.DB.prepare('UPDATE leads SET note=? WHERE id=?').bind(cleanText(body.note || '', 2000), id).run();
        return json({ok:true});
      }
      if(method === 'POST' && parts[2] === 'delete'){
        await env.DB.prepare('DELETE FROM leads WHERE id=?').bind(id).run();
        return json({ok:true});
      }
    }
    return json({ok:false, error:'Route introuvable'}, 404);
  }catch(e){
    return json({ok:false, error:e.message || String(e)}, 500);
  }
}

function json(data, status=200){return new Response(JSON.stringify(data,null,2),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'}})}
async function readJson(request){try{return await request.json()}catch{return {}}}
function now(){return new Date().toISOString().slice(0,19).replace('T',' ')+' UTC'}
function cleanText(value,max=0){let text=String(value??'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();return max&&text.length>max?text.slice(0,max-1).trimEnd()+'…':text}
function normalize(text=''){return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')}
function tokenize(q=''){return (normalize(q).match(/[\w-]{3,}/g)||[]).filter(w=>!STOPWORDS.has(w))}
function expandQueries(query,max=4){const out=[query.trim()].filter(Boolean);const n=normalize(query);for(const [k,vals] of EXPANSIONS){if(n.includes(normalize(k))){for(const v of vals){if(!out.includes(v))out.push(v);if(out.length>=max)return out}}}return out}
function fmtTimestamp(v){if(v==null||v==='')return '';const n=Number(v);if(Number.isFinite(n)){const ms=n>10000000000?n:n*1000;return new Date(ms).toISOString().slice(0,16).replace('T',' ')+' UTC'}return cleanText(v,80)}
function fmtDate(v){if(!v)return '';const d=new Date(v);return Number.isNaN(d.getTime())?cleanText(v,80):d.toISOString().slice(0,16).replace('T',' ')+' UTC'}
function ageDays(posted){if(!posted)return null;const d=new Date(posted.replace(' UTC','Z').replace(' ','T'));if(Number.isNaN(d.getTime()))return null;return Math.max(0,(Date.now()-d.getTime())/86400000)}
function scoreLead(lead,query){const text=normalize([lead.title,lead.need,lead.tags,lead.source].join(' '));let score=0;const qn=normalize(query);if(qn&&text.includes(qn))score+=35;for(const w of tokenize(query))if(text.includes(w))score+=8;if(INTENTS.some(p=>text.includes(normalize(p))))score+=20;if(lead.budget)score+=10;if(normalize(lead.source).includes('freelancer'))score+=15;const age=ageDays(lead.posted_at);if(age!==null){if(age<=1)score+=20;else if(age<=7)score+=12;else if(age<=30)score+=5}return Math.max(0,Math.min(100,score))}
function dedupe(leads){const seen=new Set(),out=[];for(const l of leads){const key=l.url||`${l.source}|${normalize(l.title)}`;if(seen.has(key))continue;seen.add(key);out.push(l)}return out}
function stableUrl(lead){if(lead.url)return lead.url.trim();return 'local://lead/'+btoa(unescape(encodeURIComponent(`${lead.source}|${lead.title}|${(lead.need||'').slice(0,80)}`))).replace(/[^a-z0-9]/gi,'').slice(0,40)}
function csv(v){const s=String(v??'');return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}
function toCsv(rows,fields){return '\ufeff'+[fields.join(','),...rows.map(r=>fields.map(f=>csv(r[f])).join(','))].join('\n')}

async function ensureDb(env){
  if(!env.DB) throw new Error('Binding D1 manquant : configure une base D1 avec le binding DB.');
  const sqls=[
    `CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY AUTOINCREMENT,url TEXT NOT NULL UNIQUE,source TEXT NOT NULL,title TEXT NOT NULL,need TEXT,budget TEXT,posted_at TEXT,client TEXT,contact_type TEXT,contact TEXT,tags TEXT,score INTEGER DEFAULT 0,query TEXT,status TEXT DEFAULT 'nouveau',note TEXT DEFAULT '',created_at TEXT NOT NULL,last_seen TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score DESC)`, `CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status)`, `CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source)`,
    `CREATE TABLE IF NOT EXISTS scans(id INTEGER PRIMARY KEY AUTOINCREMENT,query TEXT NOT NULL,sources TEXT,limit_count INTEGER,result_count INTEGER,saved_count INTEGER,new_count INTEGER,errors TEXT,created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT)`,
    `CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT,lead_id INTEGER,channel TEXT NOT NULL,status TEXT NOT NULL,message TEXT,created_at TEXT NOT NULL)`
  ];
  for(const s of sqls) await env.DB.prepare(s).run();
  for(const [k,v] of Object.entries(DEFAULT_SETTINGS)) await env.DB.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').bind(k,v).run();
}
async function getSettings(env, publicView=false){const r=await env.DB.prepare('SELECT key,value FROM settings').all();const s={...DEFAULT_SETTINGS};for(const row of r.results||[])s[row.key]=row.value||'';if(publicView)for(const k of SECRET_KEYS)s[k]=s[k]?'********':'';return s}
async function updateSettings(env, values){const allowed=new Set(Object.keys(DEFAULT_SETTINGS));for(const [k,raw] of Object.entries(values||{})){if(!allowed.has(k))continue;let v=raw==null?'':String(raw);if(SECRET_KEYS.has(k)&&v==='')continue;if(SECRET_KEYS.has(k)&&v==='__CLEAR__')v='';await env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k,v).run()}}
async function saveFeeds(env,text){for(const line of text.split(/\r?\n/)){const s=line.trim();if(s&&!s.startsWith('#')&&!/^https?:\/\//i.test(s))throw new Error(`URL invalide : ${s}`)}await updateSettings(env,{feeds_text:text})}
async function getStats(env){const s=await getSettings(env,false);const hotScore=Number(s.hot_score||70);const total=await env.DB.prepare('SELECT COUNT(*) c FROM leads').first();const hot=await env.DB.prepare('SELECT COUNT(*) c FROM leads WHERE score>=?').bind(hotScore).first();const byStatus=await env.DB.prepare('SELECT status,COUNT(*) count FROM leads GROUP BY status ORDER BY count DESC').all();const bySource=await env.DB.prepare('SELECT source,COUNT(*) count FROM leads GROUP BY source ORDER BY count DESC').all();const scans=await env.DB.prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 8').all();const queries=await env.DB.prepare('SELECT query,COUNT(*) count FROM leads GROUP BY query ORDER BY count DESC LIMIT 10').all();return{total:Number(total.c||0),hot:Number(hot.c||0),hot_score:hotScore,by_status:byStatus.results||[],by_source:bySource.results||[],recent_scans:scans.results||[],top_queries:queries.results||[],statuses:STATUSES}}
function buildWhere(params){const w=[],a=[];const q=(params.get('q')||'').trim();if(q){const like=`%${q}%`;w.push('(title LIKE ? OR need LIKE ? OR client LIKE ? OR tags LIKE ? OR query LIKE ?)');a.push(like,like,like,like,like)}const status=(params.get('status')||'').trim();if(status){w.push('status=?');a.push(status)}const source=(params.get('source')||'').trim();if(source){w.push('source=?');a.push(source)}const ms=params.get('min_score');if(ms){const n=Number(ms);if(Number.isFinite(n)){w.push('score>=?');a.push(n)}}let limit=Number(params.get('limit')||50);if(!Number.isFinite(limit))limit=50;limit=Math.max(1,Math.min(limit,500));let offset=Number(params.get('offset')||0);if(!Number.isFinite(offset))offset=0;const sorts={hot:'score DESC,last_seen DESC',recent:'last_seen DESC,score DESC',created:'created_at DESC,score DESC',status:'status ASC,score DESC',source:'source ASC,score DESC'};return{where:w.length?' WHERE '+w.join(' AND '):'',args:a,limit,offset,order:sorts[params.get('sort')]||sorts.hot}}
async function listLeads(env,params){const b=buildWhere(params);const total=await env.DB.prepare(`SELECT COUNT(*) c FROM leads${b.where}`).bind(...b.args).first();const rows=await env.DB.prepare(`SELECT * FROM leads${b.where} ORDER BY ${b.order} LIMIT ? OFFSET ?`).bind(...b.args,b.limit,b.offset).all();return{total:Number(total.c||0),items:rows.results||[],limit:b.limit,offset:b.offset}}
async function exportLeads(env,params){const b=buildWhere(params);const rows=await env.DB.prepare(`SELECT * FROM leads${b.where} ORDER BY ${b.order} LIMIT ? OFFSET ?`).bind(...b.args,b.limit,b.offset).all();return rows.results||[]}
async function getLead(env,id){return env.DB.prepare('SELECT * FROM leads WHERE id=?').bind(id).first()}
async function saveLead(env,lead,query){const url=stableUrl(lead);const t=now();const existing=await env.DB.prepare('SELECT id FROM leads WHERE url=?').bind(url).first();if(existing){await env.DB.prepare('UPDATE leads SET source=?,title=?,need=?,budget=?,posted_at=?,client=?,contact_type=?,contact=?,tags=?,score=?,query=?,last_seen=? WHERE id=?').bind(lead.source,lead.title,lead.need,lead.budget,lead.posted_at,lead.client,lead.contact_type,lead.contact,lead.tags,Number(lead.score||0),query,t,existing.id).run();return{id:existing.id,is_new:false}}const r=await env.DB.prepare("INSERT INTO leads(url,source,title,need,budget,posted_at,client,contact_type,contact,tags,score,query,status,note,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'nouveau','',?,?)").bind(url,lead.source,lead.title,lead.need,lead.budget,lead.posted_at,lead.client,lead.contact_type,lead.contact,lead.tags,Number(lead.score||0),query,t,t).run();return{id:r.meta.last_row_id,is_new:true}}
async function recordScan(env,query,sources,limit,resultCount,savedCount,newCount,errors){const r=await env.DB.prepare('INSERT INTO scans(query,sources,limit_count,result_count,saved_count,new_count,errors,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(query,sources.join(','),limit,resultCount,savedCount,newCount,(errors||[]).join('\n'),now()).run();return r.meta.last_row_id}

async function fetchJson(url){const r=await fetch(url,{headers:{'Accept':'application/json','User-Agent':'LeadFinderCloudflare/2.0'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json()}
async function fetchText(url){const r=await fetch(url,{headers:{'Accept':'application/rss+xml,application/atom+xml,text/xml,text/plain,*/*','User-Agent':'LeadFinderCloudflare/2.0'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.text()}
function budget(project){const c=project.currency||{},sign=c.sign||c.code||'';const b=project.budget||{};if(b.minimum!=null&&b.maximum!=null)return `${sign}${Number(b.minimum)} - ${sign}${Number(b.maximum)}`;return ''}
async function searchFreelancer(query,limit){const leads=[];for(const q of expandQueries(query,3)){const p=new URLSearchParams({query:q,limit:String(Math.min(limit,50)),full_description:'true',job_details:'true'});const d=await fetchJson(`https://www.freelancer.com/api/projects/0.1/projects/active/?${p}`);for(const pr of d?.result?.projects||[]){const tags=(pr.jobs||[]).map(j=>cleanText(j.name,40)).filter(Boolean).join(', ');const lead={source:'Freelancer.com',title:cleanText(pr.title,160),need:cleanText(pr.description||pr.preview_description,500),url:pr.seo_url?`https://www.freelancer.com/projects/${pr.seo_url}`:`https://www.freelancer.com/projects/${pr.id}`,contact:'Candidater / contacter via la page officielle du projet',contact_type:'Lien plateforme',posted_at:fmtTimestamp(pr.submitdate||pr.time_submitted),budget:budget(pr),client:pr.owner_id?'Client Freelancer.com':'Client masqué par la plateforme',tags};lead.score=scoreLead(lead,query);leads.push(lead)}}return dedupe(leads)}
async function searchReddit(query,limit){const leads=[];const p=new URLSearchParams({q:query,sort:'new',limit:String(Math.min(limit,50))});const d=await fetchJson(`https://www.reddit.com/search.json?${p}`);for(const ch of d?.data?.children||[]){const i=ch.data||{},author=i.author||'',permalink=i.permalink||'';const lead={source:'Reddit public',title:cleanText(i.title,160),need:cleanText(i.selftext||i.body||i.subreddit_name_prefixed,500),url:permalink.startsWith('/')?`https://www.reddit.com${permalink}`:permalink,contact:author?`Répondre dans le thread ou via le profil public u/${author}`:'Répondre dans le thread',contact_type:'Thread/profil public',posted_at:fmtTimestamp(i.created_utc),budget:'',client:author?`u/${author}`:'',tags:cleanText(i.subreddit_name_prefixed,80)};lead.score=scoreLead(lead,query);leads.push(lead)}return dedupe(leads)}
async function searchHn(query,limit){const leads=[];const p=new URLSearchParams({query,tags:'story,comment',hitsPerPage:String(Math.min(limit,50))});const d=await fetchJson(`https://hn.algolia.com/api/v1/search_by_date?${p}`);for(const i of d.hits||[]){const id=i.objectID||i.story_id||'',author=i.author||'';const lead={source:'Hacker News public',title:cleanText(i.title||i.story_title||'Discussion Hacker News',160),need:cleanText(i.comment_text||i.story_text||i.url||'',500),url:id?`https://news.ycombinator.com/item?id=${id}`:(i.url||''),contact:author?`Répondre sur HN / profil public ${author}`:'Répondre sur HN',contact_type:'Thread/profil public',posted_at:fmtDate(i.created_at),budget:'',client:author,tags:'HN'};lead.score=scoreLead(lead,query);leads.push(lead)}return dedupe(leads)}
function tag(block,names){for(const name of names){const re=new RegExp(`<${name.replace(':','\\:')}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name.replace(':','\\:')}>`,'i');const m=block.match(re);if(m)return cleanText(m[1])}return ''}
function link(block){const m=block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);return m?cleanText(m[1],500):tag(block,['link'])}
async function searchRss(query,feedsText,limit){const urls=feedsText.split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith('#')&&/^https?:\/\//i.test(l));const words=tokenize(query);const leads=[];for(const feed of urls){const xml=await fetchText(feed);const blocks=xml.match(/<item[\s\S]*?<\/item>/gi)||xml.match(/<entry[\s\S]*?<\/entry>/gi)||[];for(const block of blocks.slice(0,Math.max(limit,25))){const title=cleanText(tag(block,['title']),160)||'Annonce sans titre',need=cleanText(tag(block,['description','summary','content','content:encoded']),500),hay=normalize(`${title} ${need}`);if(words.length&&!words.some(w=>hay.includes(w)))continue;const lead={source:'Flux RSS/Atom',title,need,url:link(block),contact:"Répondre via la page officielle de l'annonce",contact_type:'Lien officiel',posted_at:fmtDate(tag(block,['pubDate','published','updated','date'])),budget:'',client:new URL(feed).hostname,tags:feed};lead.score=scoreLead(lead,query);leads.push(lead)}}return dedupe(leads).slice(0,limit)}
const SITE_SOURCES={
  upwork:{label:'Upwork',sites:['upwork.com/freelance-jobs','upwork.com/jobs'],scrape:['https://www.upwork.com/nx/search/jobs/?q={q}&sort=recency','https://www.upwork.com/freelance-jobs/?q={q}']},
  fiverr:{label:'Fiverr',sites:['fiverr.com'],scrape:['https://www.fiverr.com/search/gigs?query={q}']},
  malt:{label:'Malt',sites:['malt.fr','malt.com'],scrape:['https://www.malt.fr/s?q={q}','https://www.malt.com/s?q={q}']},
  comeup:{label:'ComeUp',sites:['comeup.com'],scrape:['https://comeup.com/fr/search?query={q}','https://comeup.com/search?query={q}']},
  linkedin:{label:'LinkedIn',sites:['linkedin.com/posts','linkedin.com/jobs','linkedin.com/feed'],scrape:['https://www.linkedin.com/jobs/search/?keywords={q}']},
  facebook:{label:'Facebook Groups',sites:['facebook.com/groups'],scrape:['https://www.facebook.com/search/groups/?q={q}']},
  indeed:{label:'Indeed',sites:['indeed.com','indeed.fr'],scrape:['https://www.indeed.com/jobs?q={q}&sort=date','https://fr.indeed.com/jobs?q={q}&sort=date']},
  peopleperhour:{label:'PeoplePerHour',sites:['peopleperhour.com/freelance-jobs','peopleperhour.com'],scrape:['https://www.peopleperhour.com/freelance-jobs?keyword={q}']},
  guru:{label:'Guru',sites:['guru.com/work','guru.com/jobs'],scrape:['https://www.guru.com/d/jobs/q/{q}/']},
  toptal:{label:'Toptal',sites:['toptal.com/freelance-jobs','toptal.com'],scrape:['https://www.toptal.com/freelance-jobs?search={q}']},
  behance:{label:'Behance',sites:['behance.net/joblist','behance.net/jobs'],scrape:['https://www.behance.net/joblist?search={q}']},
  dribbble:{label:'Dribbble',sites:['dribbble.com/jobs','dribbble.com/freelance-jobs'],scrape:['https://dribbble.com/jobs?search={q}']}
};
const ROBOTS_CACHE=new Map();
function firstSecret(env,settings,envNames,settingKey){for(const k of envNames){if(env[k])return String(env[k]).trim()}return String(settings[settingKey]||'').trim()}
function extractBudget(text){const m=String(text||'').match(/(?:\$|€|£|USD|EUR|GBP)\s?\d[\d\s,.]*(?:\s?[-–]\s?(?:\$|€|£|USD|EUR|GBP)?\s?\d[\d\s,.]*)?/i);return m?cleanText(m[0],60):''}
async function searchGoogleCse(query,limit,settings,env,config=null){
  const key=firstSecret(env,settings,['GOOGLE_API_KEY','GOOGLE_SEARCH_API_KEY'],'google_api_key');
  const cx=firstSecret(env,settings,['GOOGLE_CX','GOOGLE_CSE_ID','GOOGLE_SEARCH_CX'],'google_cx');
  if(!key||!cx)throw new Error('Google Custom Search non configuré : ajoute GOOGLE_API_KEY et GOOGLE_CX ou renseigne-les dans Alertes > Connecteurs');
  const intent='("looking for" OR "I need" OR "we need" OR hiring OR freelance OR besoin OR cherche OR recherche)';
  const sitePart=config?.sites?.length?` (${config.sites.map(s=>`site:${s}`).join(' OR ')})`:'';
  const q=`${query} ${intent}${sitePart}`;
  const p=new URLSearchParams({key,cx,q,num:String(Math.min(10,Math.max(1,limit))),safe:'off'});
  const data=await fetchJson(`https://www.googleapis.com/customsearch/v1?${p}`);
  const label=config?.label||'Google Search';
  const leads=[];
  for(const item of data.items||[]){
    const text=cleanText(item.snippet||'',500);
    const lead={source:label,title:cleanText(item.title,160),need:text,url:item.link||'',contact:'Ouvrir le résultat officiel et répondre sur la plateforme',contact_type:'Résultat Google Custom Search',posted_at:'',budget:extractBudget(`${item.title} ${text}`),client:new URL(item.link||'https://google.com').hostname,tags:(item.displayLink||'Google CSE')};
    lead.score=scoreLead(lead,query);leads.push(lead)
  }
  return dedupe(leads)
}
function hasGoogleConfig(settings,env){return Boolean(firstSecret(env,settings,['GOOGLE_API_KEY','GOOGLE_SEARCH_API_KEY'],'google_api_key')&&firstSecret(env,settings,['GOOGLE_CX','GOOGLE_CSE_ID','GOOGLE_SEARCH_CX'],'google_cx'))}
function escapeRegExp(s){return String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}
function robotsRuleToRegex(rule){let x=escapeRegExp(rule).replace(/\\\*/g,'.*');if(x.endsWith('\\$'))x=x.slice(0,-2)+'$';return new RegExp('^'+x)}
function robotsGroups(text){const groups=[];let group=null;for(const raw of String(text||'').split(/\r?\n/)){const line=raw.split('#')[0].trim();if(!line)continue;const m=line.match(/^([^:]+):\s*(.*)$/);if(!m)continue;const key=m[1].toLowerCase(),value=m[2].trim();if(key==='user-agent'){if(!group||group.rules.length){group={agents:[],rules:[]};groups.push(group)}group.agents.push(value.toLowerCase())}else if((key==='allow'||key==='disallow')&&group){group.rules.push({type:key,path:value})}}return groups}
async function robotsAllowed(targetUrl){
  const u=new URL(targetUrl);const origin=u.origin;let text=ROBOTS_CACHE.get(origin);
  if(text===undefined){const res=await fetch(origin+'/robots.txt',{headers:{'User-Agent':'LeadFinderCloudflare/3.1'}});if(res.ok)text=await res.text();else if(res.status===404)text='';else throw new Error(`robots.txt inaccessible HTTP ${res.status} sur ${u.hostname}`);ROBOTS_CACHE.set(origin,text)}
  if(!text)return true;const path=u.pathname+u.search;const groups=robotsGroups(text);let rules=[];for(const g of groups){if(g.agents.some(a=>a==='*'||a.includes('leadfinder')))rules=rules.concat(g.rules)}if(!rules.length)return true;let best=null;for(const r of rules){if(r.type==='disallow'&&r.path==='')continue;try{if(robotsRuleToRegex(r.path).test(path)){if(!best||r.path.length>best.path.length)best=r}}catch{}}
  return !best||best.type==='allow'
}
function absoluteUrl(href,base){try{const u=new URL(href,base);if(!/^https?:$/.test(u.protocol))return '';u.hash='';return u.toString()}catch{return ''}}
function stripNoise(text){return cleanText(text,700).replace(/\b(cookie|privacy|terms|sign in|log in|connexion|inscription|conditions|confidentialité)\b/ig,' ').replace(/\s+/g,' ').trim()}
function titleFromUrl(url){try{const u=new URL(url);const parts=u.pathname.split('/').filter(Boolean);let slug=decodeURIComponent(parts.pop()||u.hostname).replace(/[-_+]/g,' ');return cleanText(slug||u.hostname,140)}catch{return cleanText(url,140)}}
function extractAnchors(html,pageUrl,query,sourceLabel){
  const words=tokenize(query);const leads=[];let m;const re=/<a\b([^>]*)>([\s\S]*?)<\/a>/gi;let count=0;
  while((m=re.exec(html))&&count<300){count++;const attrs=m[1]||'',inner=m[2]||'';const hrefMatch=attrs.match(/href=["']([^"']+)["']/i);if(!hrefMatch)continue;const url=absoluteUrl(hrefMatch[1],pageUrl);if(!url)continue;const u=new URL(url);const base=new URL(pageUrl);if(u.hostname.replace(/^www\./,'')!==base.hostname.replace(/^www\./,''))continue;const title=stripNoise(inner)||titleFromUrl(url);if(title.length<8||title.length>220)continue;if(/^(next|previous|login|sign|cookie|privacy|terms|help|about|pricing|menu)$/i.test(title))continue;const start=Math.max(0,m.index-300),end=Math.min(html.length,re.lastIndex+420);const snippet=stripNoise(html.slice(start,end));const hay=normalize(`${title} ${snippet} ${url}`);if(words.length&&!words.some(w=>hay.includes(w)))continue;const lead={source:sourceLabel,title:cleanText(title,160),need:cleanText(snippet||title,500),url,contact:'Ouvrir la page officielle et répondre sur la plateforme',contact_type:'Scraping public conforme robots.txt',posted_at:'',budget:extractBudget(`${title} ${snippet}`),client:u.hostname,tags:'Scraping public'};lead.score=scoreLead(lead,query);if(lead.score>=10)leads.push(lead)}return dedupe(leads)
}
async function searchScrapeUrl(query,limit,sourceLabel,urlTemplate){
  const pageUrl=urlTemplate.replaceAll('{q}',encodeURIComponent(query));
  if(!await robotsAllowed(pageUrl))throw new Error(`robots.txt interdit ${new URL(pageUrl).hostname}${new URL(pageUrl).pathname}`);
  const res=await fetch(pageUrl,{headers:{'Accept':'text/html,application/xhtml+xml','User-Agent':'LeadFinderCloudflare/3.1 (+respect robots.txt; no bypass)'}});
  if([401,403,429].includes(res.status))throw new Error(`accès bloqué HTTP ${res.status} sur ${new URL(pageUrl).hostname}`);
  if(!res.ok)throw new Error(`HTTP ${res.status} sur ${new URL(pageUrl).hostname}`);
  const ct=res.headers.get('content-type')||'';if(ct&&!ct.includes('text/html'))throw new Error(`contenu non HTML sur ${new URL(pageUrl).hostname}`);
  const html=(await res.text()).slice(0,900000);return extractAnchors(html,pageUrl,query,sourceLabel).slice(0,limit)
}
async function searchSitemaps(query,limit,config){
  const words=tokenize(query);const hosts=[...new Set((config.sites||[]).map(s=>s.split('/')[0].replace(/^www\./,'')))];const leads=[];const errors=[];
  for(const host of hosts){
    const sitemapUrl=`https://${host}/sitemap.xml`;
    try{
      if(!await robotsAllowed(sitemapUrl)){errors.push(`robots.txt interdit sitemap ${host}`);continue}
      const res=await fetch(sitemapUrl,{headers:{'Accept':'application/xml,text/xml,text/plain','User-Agent':'LeadFinderCloudflare/3.1'}});
      if(!res.ok){errors.push(`sitemap HTTP ${res.status} ${host}`);continue}
      const xml=(await res.text()).slice(0,1200000);let m;const re=/<loc>\s*([^<]+)\s*<\/loc>/gi;let n=0;
      while((m=re.exec(xml))&&n<2500){n++;const loc=cleanText(m[1],600);if(!loc.startsWith('http'))continue;const hay=normalize(loc);if(words.length&&!words.some(w=>hay.includes(w)))continue;if(!/job|mission|freelance|project|work|gig|service|emploi|offre|poste/i.test(loc))continue;const lead={source:config.label,title:titleFromUrl(loc),need:`URL publique trouvée dans le sitemap : ${loc}`,url:loc,contact:'Ouvrir la page officielle et répondre sur la plateforme',contact_type:'Sitemap public',posted_at:'',budget:'',client:new URL(loc).hostname,tags:'Sitemap public'};lead.score=scoreLead(lead,query);leads.push(lead);if(leads.length>=limit)break}
      if(leads.length>=limit)break
    }catch(e){errors.push(`sitemap ${host}: ${e.message}`)}
  }
  const out=dedupe(leads).slice(0,limit);out._method='sitemap_public';out._message=out.length?`Sitemap public OK (${out.length} résultat(s))`:`Sitemap sans résultat. ${errors.join(' | ')}`;return out
}
async function searchPlatform(query,limit,settings,env,config){
  const errors=[];let leads=[];
  for(const tmpl of config.scrape||[]){try{const got=await searchScrapeUrl(query,limit,config.label,tmpl);leads=leads.concat(got);if(leads.length>=limit)break}catch(e){errors.push(e.message)}}
  leads=dedupe(leads);if(leads.length){leads=leads.slice(0,limit);leads._method='scraping_public';leads._message=`Scraping public OK (${leads.length} résultat(s))`;return leads}
  try{const siteLeads=await searchSitemaps(query,limit,config);if(siteLeads.length)return siteLeads; if(siteLeads._message)errors.push(siteLeads._message)}catch(e){errors.push('sitemap: '+e.message)}
  if(hasGoogleConfig(settings,env)){try{const g=await searchGoogleCse(query,limit,settings,env,config);g._method='google_cse_fallback';g._message=`Fallback Google CSE utilisé après scraping/sitemap indisponible. ${g.length} résultat(s)`;return g}catch(e){errors.push('fallback Google CSE: '+e.message)}}
  throw new Error('Source indisponible sans contournement: '+(errors.join(' | ')||'aucun résultat public'))
}
async function searchX(query,limit,settings,env){
  const bearer=firstSecret(env,settings,['X_BEARER_TOKEN','TWITTER_BEARER_TOKEN'],'x_bearer_token');
  if(!bearer)throw new Error('X/Twitter non configuré : ajoute X_BEARER_TOKEN ou renseigne le Bearer Token');
  const q=`${query} ("looking for" OR "I need" OR hiring OR besoin OR cherche) -is:retweet`;
  const p=new URLSearchParams({query:q,max_results:String(Math.max(10,Math.min(100,limit))),'tweet.fields':'created_at,author_id,lang','expansions':'author_id','user.fields':'username,name'});
  const res=await fetch(`https://api.twitter.com/2/tweets/search/recent?${p}`,{headers:{Authorization:`Bearer ${bearer}`}});
  if(!res.ok)throw new Error(`X API HTTP ${res.status}: ${await res.text()}`);
  const data=await res.json();
  const users=new Map((data.includes?.users||[]).map(u=>[u.id,u]));
  const leads=[];
  for(const t of data.data||[]){const u=users.get(t.author_id)||{};const url=u.username?`https://x.com/${u.username}/status/${t.id}`:`https://x.com/i/web/status/${t.id}`;const lead={source:'X/Twitter',title:cleanText(t.text,120),need:cleanText(t.text,500),url,contact:u.username?`Répondre sur X au profil @${u.username}`:'Répondre sur X',contact_type:'Tweet/profil public',posted_at:fmtDate(t.created_at),budget:extractBudget(t.text),client:u.username?`@${u.username}`:t.author_id,tags:t.lang||'X API'};lead.score=scoreLead(lead,query);leads.push(lead)}
  return dedupe(leads).slice(0,limit)
}
async function searchTelegram(query,limit,settings,env){
  const token=firstSecret(env,settings,['TELEGRAM_SOURCE_BOT_TOKEN'],'telegram_source_bot_token')||firstSecret(env,settings,['TELEGRAM_BOT_TOKEN'],'telegram_bot_token');
  if(!token)throw new Error('Telegram Groups non configuré : ajoute TELEGRAM_SOURCE_BOT_TOKEN et ajoute le bot aux groupes à surveiller');
  const allowed=String(env.TELEGRAM_SOURCE_CHATS||settings.telegram_source_chats||'').split(',').map(x=>x.trim()).filter(Boolean);
  const res=await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=100&allowed_updates=%5B%22message%22,%22channel_post%22%5D`);
  if(!res.ok)throw new Error(`Telegram HTTP ${res.status}: ${await res.text()}`);
  const data=await res.json(); if(!data.ok)throw new Error(data.description||'Erreur Telegram');
  const words=tokenize(query); const leads=[];
  for(const upd of data.result||[]){const msg=upd.message||upd.channel_post;if(!msg)continue;const chat=msg.chat||{};if(allowed.length&&!allowed.includes(String(chat.id))&&!allowed.includes(String(chat.username||'')))continue;const text=msg.text||msg.caption||'';if(!text)continue;const hay=normalize(text);if(words.length&&!words.some(w=>hay.includes(w)))continue;const link=chat.username?`https://t.me/${chat.username}/${msg.message_id}`:'';const title=cleanText(text.split('\n')[0],120);const lead={source:'Telegram Groups',title:title||'Message Telegram',need:cleanText(text,500),url:link,contact:link?'Répondre dans le groupe/canal Telegram public':'Répondre dans le groupe Telegram où le bot est présent',contact_type:link?'Lien Telegram public':'Groupe Telegram surveillé',posted_at:fmtTimestamp(msg.date),budget:extractBudget(text),client:chat.title||chat.username||chat.id,tags:chat.username?`@${chat.username}`:`chat:${chat.id}`};lead.score=scoreLead(lead,query);leads.push(lead)}
  return dedupe(leads).slice(0,limit)
}
async function runSource(sourceKey,label,methodName,fn){
  const started=Date.now();
  try{const result=await fn();const items=Array.isArray(result)?result:(result?.leads||[]);return{items,status:{source:sourceKey,label,method:result._method||methodName,status:items.length?'ok':'empty',count:items.length,message:result._message||(items.length?'OK':'Aucun résultat public'),duration_ms:Date.now()-started}}}
  catch(e){return{items:[],error:`${label}: ${e.message}`,status:{source:sourceKey,label,method:methodName,status:'error',count:0,message:e.message,duration_ms:Date.now()-started}}}
}
async function searchAll(query,sources,limit,settings,env){
  const feedsText=settings.feeds_text||'';
  const map={
    freelancer:['Freelancer.com','API publique',()=>searchFreelancer(query,limit)],
    reddit:['Reddit','JSON public',()=>searchReddit(query,limit)],
    hn:['Hacker News','API Algolia',()=>searchHn(query,limit)],
    rss:['Flux RSS','RSS/Atom',()=>searchRss(query,feedsText,limit)],
    google:['Google Search','Google CSE',()=>searchGoogleCse(query,limit,settings,env,null)],
    x:['X/Twitter','X API v2',()=>searchX(query,limit,settings,env)],
    telegram:['Telegram Groups','Telegram Bot API',()=>searchTelegram(query,limit,settings,env)]
  };
  for(const [key,config] of Object.entries(SITE_SOURCES))map[key]=[config.label,'scraping → sitemap → Google CSE',()=>searchPlatform(query,limit,settings,env,config)];
  const leads=[],errors=[],source_status=[];
  for(const s of sources){if(!map[s])continue;const [label,method,fn]=map[s];const r=await runSource(s,label,method,fn);source_status.push(r.status);if(r.error)errors.push(r.error);leads.push(...r.items)}
  const out=dedupe(leads);out.forEach(l=>l.score=scoreLead(l,query));out.sort((a,b)=>(b.score-a.score)||String(b.posted_at).localeCompare(String(a.posted_at)));return{leads:out.slice(0,limit),errors,source_status}
}
function pitchText(lead){return `Bonjour,\n\nJ'ai consulté votre demande publiée sur ${lead.source} : « ${cleanText(lead.title,120)} ».\n\nSi j'ai bien compris, vous recherchez une solution pour : ${cleanText(lead.need,240)}\n\nJe peux vous accompagner de manière structurée :\n• analyse rapide de votre besoin ;\n• proposition d'une approche simple ;\n• réalisation d'une première version ;\n• corrections et livraison finale.\n\n${lead.budget?`J’ai aussi noté votre budget : ${lead.budget}. `:''}Si vous êtes disponible, je peux vous envoyer une proposition claire avec délai, livrables et prix.\n\nBien cordialement.`}
function generatePitch(lead){return pitchText(lead)}
function alertText(lead){return [`🔥 Lead chaud ${lead.score||0}/100`,`Source : ${lead.source||''}`,`Titre : ${lead.title||''}`,lead.budget?`Budget : ${lead.budget}`:'',lead.need?`Besoin : ${cleanText(lead.need,280)}`:'',lead.url?`Répondre : ${lead.url}`:''].filter(Boolean).join('\n')}
async function logAlert(env,leadId,channel,status,message){await env.DB.prepare('INSERT INTO alerts(lead_id,channel,status,message,created_at) VALUES(?,?,?,?,?)').bind(leadId||null,channel,status,cleanText(message,500),now()).run()}
async function sendAlerts(env,leads,onlyNew=true){const s=await getSettings(env,false),hot=Number(s.hot_score||70),res=[];for(const l of leads){if(Number(l.score||0)<hot)continue;if(onlyNew&&!l.is_new)continue;if((s.telegram_enabled==='1'||env.TELEGRAM_BOT_TOKEN)){try{const token=(env.TELEGRAM_BOT_TOKEN||s.telegram_bot_token||'').trim(),chat=(env.TELEGRAM_CHAT_ID||s.telegram_chat_id||'').trim();if(!token||!chat)throw new Error('Telegram non configuré');const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chat,text:alertText(l)})});if(!r.ok)throw new Error(`Telegram HTTP ${r.status}`);await logAlert(env,l.id,'telegram','ok','envoyé');res.push({lead_id:l.id,channel:'telegram',status:'ok'})}catch(e){await logAlert(env,l.id,'telegram','error',e.message);res.push({lead_id:l.id,channel:'telegram',status:'error',message:e.message})}}if((s.webhook_enabled==='1'||env.WEBHOOK_URL)){try{const wh=(env.WEBHOOK_URL||s.webhook_url||'').trim();if(!wh)throw new Error('Webhook non configuré');const r=await fetch(wh,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event:'hot_lead',lead:l,sent_at:new Date().toISOString()})});if(!r.ok)throw new Error(`Webhook HTTP ${r.status}`);await logAlert(env,l.id,'webhook','ok','envoyé');res.push({lead_id:l.id,channel:'webhook',status:'ok'})}catch(e){await logAlert(env,l.id,'webhook','error',e.message);res.push({lead_id:l.id,channel:'webhook',status:'error',message:e.message})}}if((s.email_enabled==='1'||env.RESEND_API_KEY)){try{const key=(env.RESEND_API_KEY||s.resend_api_key||'').trim(),from=(env.EMAIL_FROM||s.email_from||'').trim(),to=(env.EMAIL_TO||s.email_to||'').trim();if(!key||!from||!to)throw new Error('Resend non configuré');const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({from,to:[to],subject:`Lead chaud ${l.score||0}/100 - ${cleanText(l.title,70)}`,text:alertText(l)})});if(!r.ok)throw new Error(`Resend HTTP ${r.status}`);await logAlert(env,l.id,'email','ok','envoyé');res.push({lead_id:l.id,channel:'email',status:'ok'})}catch(e){await logAlert(env,l.id,'email','error',e.message);res.push({lead_id:l.id,channel:'email',status:'error',message:e.message})}}}return res}

// Cloudflare Pages Advanced Mode entrypoint.
// This lets the project work without a /functions folder.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return onRequest({ request, env, params: {}, waitUntil: ctx?.waitUntil?.bind(ctx) });
    }
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }
    return new Response('LeadFinder assets binding missing. Configure as Cloudflare Pages project.', { status: 500 });
  }
};
