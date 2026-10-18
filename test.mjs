// Local test: runs the Worker in Node with a fake Discord API. No real Discord calls.
import worker from './worker.js';
const SECRET = 'x'.repeat(40);
const calls = [];
const FORUM='1000000000000000001', DISC='1000000000000000002', GUILD='1000000000000000000', OTHER='1111111111111111111', THREAD='1000000000000000003';
const channels = {
  [FORUM]: {id:FORUM, name:'showcase', type:15, guild_id:GUILD, topic:'Showcase', available_tags:[{id:'1000000000000000010',name:'Game',moderated:false}]},
  [DISC]: {id:DISC, name:'ai-discussion', type:0, guild_id:GUILD, topic:'Talk'},
  [THREAD]: {id:THREAD, name:'My Project', type:11, guild_id:GUILD, parent_id:FORUM, owner_id:'1000000000000000009', applied_tags:[]},
  [OTHER]: {id:OTHER, name:'secret-room', type:0, guild_id:GUILD},
};
globalThis.fetch = async (url, init={}) => {
  const u = new URL(url); const p = u.pathname.replace('/api/v10','');
  calls.push({method:init.method, path:p+u.search, auth:init.headers?.Authorization, body:init.body});
  const ok = (d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json'}});
  if (p==='/users/@me') return ok({id:'1000000000000000009',username:'example_bot',discriminator:'0',bot:true});
  if (p==='/users/@me/guilds') return ok([{id:GUILD,name:'Test Server'},{id:'2222222222222222222',name:'Other server'}]);
  if (p===`/guilds/${GUILD}/channels`) return ok(Object.values(channels).filter(c=>c.type!==11));
  if (p===`/guilds/${GUILD}/threads/active`) return ok({threads:[channels[THREAD]]});
  if (p.startsWith(`/channels/${FORUM}/threads/archived`)) return ok({threads:[],has_more:false});
  const m = p.match(/^\/channels\/(\d+)$/);
  if (m && init.method==='GET') return channels[m[1]]?ok(channels[m[1]]):ok({message:'Unknown Channel'},404);
  if (m && init.method==='PATCH') return ok({...channels[m[1]], ...JSON.parse(init.body), name: JSON.parse(init.body).name||channels[m[1]].name});
  if (p===`/channels/${FORUM}/threads` && init.method==='POST') return ok({id:'999999999999999999', name:'T', guild_id:GUILD, applied_tags:[], message:{id:'999999999999999999', attachments:[]}},201);
  if (/^\/channels\/\d+\/messages$/.test(p) && init.method==='POST') return ok({id:'888888888888888888', channel_id:p.split('/')[2], attachments:[]});
  if (/^\/channels\/\d+\/messages\/\d+$/.test(p) && init.method==='PATCH') return ok({id:p.split('/')[4], channel_id:p.split('/')[2], attachments:[]});
  return ok({message:'unmocked '+p},404);
};
const envOpen = {DISCORD_TOKEN:'TESTTOKEN', CONNECTOR_SECRET:SECRET, UPLOAD_SIGNING_KEY:'k'.repeat(40), ALLOWED_IDS:''};
const envLocked = {...envOpen, ALLOWED_IDS:`${FORUM}, ${DISC}`};
const base='https://dc.example.workers.dev';
async function rpc(env, method, params, id=1, path=`/mcp/${SECRET}`){
  const r = await worker.fetch(new Request(base+path,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})}), env);
  const t = await r.text(); let b=null; try{b=t?JSON.parse(t):null}catch{b=t} return {status:r.status, body:b};
}
const tool = async (env,name,args={}) => { const r = await rpc(env,'tools/call',{name,arguments:args}); const res=r.body.result; return {err:res.isError, text:res.content[0].text}; };
const check = (label, cond) => console.log((cond?'PASS ':'FAIL ')+label);

// auth / routing
check('wrong secret -> 404', (await rpc(envOpen,'initialize',{},1,'/mcp/wrong')).status===404);
check('root -> 404', (await worker.fetch(new Request(base+'/'),envOpen)).status===404);
check('GET on mcp -> 405', (await worker.fetch(new Request(base+`/mcp/${SECRET}`),envOpen)).status===405);
const init = await rpc(envOpen,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'t',version:'1'}});
check('initialize echoes version', init.body.result.protocolVersion==='2025-06-18' && init.body.result.capabilities.tools);
const note = await worker.fetch(new Request(base+`/mcp/${SECRET}`,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})}),envOpen);
check('notification -> 202', note.status===202);
const tl = await rpc(envOpen,'tools/list');
const names = tl.body.result.tools.map(t=>t.name);
check('tools/list has 11 tools, none delete/lock', names.length===11 && !names.some(n=>/delete|lock|archive|ban|kick/.test(n)));
console.log('  tools:', names.join(', '));

// read tools
let r = await tool(envOpen,'discord_whoami'); check('whoami', !r.err && r.text.includes('example_bot'));
check('token sent as "Bot <token>"', calls.at(-1).auth==='Bot TESTTOKEN');
r = await tool(envOpen,'discord_list_servers'); check('list servers open: 2', JSON.parse(r.text).length===2);
r = await tool(envLocked,'discord_list_servers'); check('list servers locked: only Test Server', JSON.parse(r.text).length===1);
r = await tool(envLocked,'discord_list_channels',{server_id:GUILD}); const ch=JSON.parse(r.text).map(c=>c.name);
check('locked channels hide secret-room', ch.includes('showcase') && !ch.includes('secret-room'));
r = await tool(envLocked,'discord_get_channel',{channel_id:OTHER}); check('locked: other channel refused', r.err && r.text.includes('allow-list'));
r = await tool(envLocked,'discord_get_channel',{channel_id:THREAD}); check('locked: thread in allowed forum ok', !r.err);
r = await tool(envLocked,'discord_find_forum_posts',{forum_channel_id:FORUM,title_contains:'project'}); check('find posts', JSON.parse(r.text)[0].id===THREAD);
r = await tool(envOpen,'discord_get_channel',{channel_id:'abc'}); check('bad id rejected', r.err);

// write tools
calls.length=0;
r = await tool(envLocked,'discord_create_forum_post',{forum_channel_id:FORUM,title:'T',content:'hello @everyone',tag_ids:['1000000000000000010']});
const post = JSON.parse(calls.find(c=>c.method==='POST').body);
check('forum post sends no-ping + tags', !r.err && JSON.stringify(post.message.allowed_mentions)==='{"parse":[]}' && post.applied_tags[0]==='1000000000000000010');
r = await tool(envLocked,'discord_create_forum_post',{forum_channel_id:FORUM,title:'x'.repeat(101),content:'a'}); check('title >100 rejected', r.err);
r = await tool(envLocked,'discord_send_message',{channel_id:OTHER,content:'hi'}); check('send to non-allowed refused', r.err);
r = await tool(envLocked,'discord_send_message',{channel_id:THREAD,content:'reply',reply_to_message_id:THREAD}); check('reply in thread ok', !r.err);
calls.length=0;
r = await tool(envLocked,'discord_update_forum_post',{post_id:THREAD,title:'New',tag_ids:[]});
const patch = JSON.parse(calls.find(c=>c.method==='PATCH').body);
check('update post only sends name/tags', !r.err && Object.keys(patch).sort().join()==='applied_tags,name');
r = await tool(envLocked,'discord_edit_message',{channel_id:THREAD,message_id:THREAD,content:'edited'}); check('edit message ok', !r.err);

// signed upload
r = await tool(envLocked,'discord_prepare_upload',{kind:'forum_post',channel_id:FORUM,title:'With image',content:'look',tag_ids:['1000000000000000010'],filenames:['a.png','b.gif']});
const up = JSON.parse(r.text); check('prepare upload returns link', !r.err && up.upload_url.startsWith(base+'/upload?d='));
const fd = new FormData(); fd.append('files[0]', new Blob([new Uint8Array([137,80,78,71])],{type:'image/png'}), 'a.png'); fd.append('files[1]', new Blob([new Uint8Array([71,73,70])],{type:'image/gif'}), 'b.gif');
calls.length=0;
let res = await worker.fetch(new Request(up.upload_url,{method:'POST',body:fd}), envLocked);
const sent = calls.find(c=>c.method==='POST'); const pj = JSON.parse(sent.body.get('payload_json'));
check('upload posts to Discord with files + payload', res.status===200 && sent.body.get('files[1]') && pj.name==='With image' && pj.message.attachments.length===2);
const tampered = up.upload_url.replace('&s=','&s=x');
res = await worker.fetch(new Request(tampered,{method:'POST',body:fd}), envLocked); check('tampered link -> 403', res.status===403);
const d = new URL(up.upload_url).searchParams.get('d'); const job = JSON.parse(Buffer.from(d,'base64url')); job.m='changed text';
const forged = base+'/upload?d='+Buffer.from(JSON.stringify(job)).toString('base64url')+'&s='+new URL(up.upload_url).searchParams.get('s');
res = await worker.fetch(new Request(forged,{method:'POST',body:fd}), envLocked); check('changed content with old signature -> 403', res.status===403);
const fd1 = new FormData(); fd1.append('files[0]', new Blob([new Uint8Array([1])]), 'a.png');
res = await worker.fetch(new Request(up.upload_url,{method:'POST',body:fd1}), envLocked); check('missing file -> 400', res.status===400);
const realNow = Date.now; Date.now = () => realNow() + 11*60000;
res = await worker.fetch(new Request(up.upload_url,{method:'POST',body:fd}), envLocked); check('expired link -> 410', res.status===410);
Date.now = realNow;
r = await tool({...envLocked, DISCORD_TOKEN:''},'discord_whoami'); check('missing token -> clear error', r.err && r.text.includes('DISCORD_TOKEN'));
check('short secret refused', (await rpc({...envOpen,CONNECTOR_SECRET:'short'},'ping',{},1,'/mcp/short')).status===404);
check('secret with pasted newline still works', (await rpc({...envOpen,CONNECTOR_SECRET:SECRET+'\r\n'},'tools/list')).status===200);
r = await tool({...envOpen,DISCORD_TOKEN:'Bot TESTTOKEN\n'},'discord_whoami'); check('token pasted with "Bot " and newline still works', !r.err && r.text.includes('example_bot') && calls.at(-1).auth==='Bot TESTTOKEN');
