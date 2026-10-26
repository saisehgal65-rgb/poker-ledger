(function(){
'use strict';
var app=document.getElementById('app');
var S={players:[],games:[],tab:'ledger',gid:null,addFor:null,confirmDel:null,ro:true,demo:false,user:null,isAdmin:false,loaded:false,err:'',login:{busy:false,msg:''},gate:{need:false,busy:false,msg:''}};
var cfg=window.LEDGER_CONFIG||{};
var sb=null;

/* ---------- helpers ---------- */
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function num(v){var n=parseFloat(v);return isFinite(n)?n:null}
function r2(n){return Math.round(n*100)/100}
function money(n){var a=Math.abs(n);var s='$'+a.toLocaleString('en-AU',{minimumFractionDigits:(a%1?2:0),maximumFractionDigits:2});return n<0?'−'+s:s}
function signed(n){return n>0?'+'+money(n):money(n)}
function cls(n){return n>0?'pos':(n<0?'neg':'zero')}
function today(){var d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function fmtDate(iso,short){
  var p=String(iso||'').split('-').map(Number);
  if(p.length<3||!p[0])return 'No date';
  var d=new Date(p[0],p[1]-1,p[2]);
  return short?d.toLocaleDateString('en-AU',{day:'numeric',month:'short'}):d.toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,7)}
function pm(id){return S.players.find(function(p){return p.id===id})}
function pci(id){var i=S.players.findIndex(function(p){return p.id===id});return (i<0?0:i)%10}
function openG(){return S.games.find(function(g){return g.id===S.gid})}
function sortGames(){S.games.sort(function(a,b){return (b.date||'').localeCompare(a.date||'')||(b.createdAt||0)-(a.createdAt||0)})}
function sortPlayers(){S.players.sort(function(a,b){return (a.createdAt||0)-(b.createdAt||0)||a.name.localeCompare(b.name)})}

function inOf(e){return (e.buyIns||[]).reduce(function(a,b){return a+Number(b)},0)}
function settled(e){return e.cashOut!=null}
function netOf(e){return settled(e)?r2(e.cashOut-inOf(e)):null}
function gameStats(g){
  var pot=0,out=0,n=0,done=0,k;
  for(k in (g.entries||{})){var e=g.entries[k];n++;pot+=inOf(e);if(settled(e)){done++;out+=e.cashOut}}
  pot=r2(pot);out=r2(out);
  return {pot:pot,out:out,n:n,done:done,diff:r2(out-pot),balanced:n>0&&done===n&&Math.abs(out-pot)<0.005};
}

/* ---------- persistence (Supabase) ---------- */
// Writes for the same row run in order; a failure shows a banner and reloads from the database.
var q={};
function run(p){return p.then(function(r){if(r&&r.error)throw r.error;return r})}
function enqueue(key,fn){
  if(!sb)return;
  q[key]=(q[key]||Promise.resolve()).then(function(){return run(fn())}).catch(onErr);
}
function onErr(e){
  var code=e&&(e.code||e.status);
  if(code==='42501'||code===401||code===403)S.err='Only the admin account can change the ledger. Your change was not saved.';
  else S.err='That change did not save. Check your connection and try again.';
  render();
  load();
}
function rowFromPlayer(p){return {id:p.id,name:p.name,created_at:p.createdAt}}
function rowFromGame(g){return {id:g.id,date:g.date,title:g.title||'',buy_in:g.buyIn,created_at:g.createdAt,entries:g.entries||{}}}
function savePlayer(p){enqueue('p'+p.id,function(){return sb.from('players').upsert(rowFromPlayer(p))})}
function saveGame(g){enqueue('g'+g.id,function(){return sb.from('games').upsert(rowFromGame(g))})}
function deleteRow(table,id){enqueue((table==='games'?'g':'p')+id,function(){return sb.from(table).delete().eq('id',id)})}

function load(){
  if(!sb)return Promise.resolve();
  return Promise.all([run(sb.from('players').select('*')),run(sb.from('games').select('*'))]).then(function(r){
    S.players=r[0].data.map(function(x){return {id:x.id,name:x.name,createdAt:Number(x.created_at)}});
    S.games=r[1].data.map(function(x){return {id:x.id,date:x.date,title:x.title||'',buyIn:Number(x.buy_in),createdAt:Number(x.created_at),entries:x.entries||{}}});
    sortPlayers();sortGames();S.loaded=true;render();
  }).catch(function(){
    S.loaded=true;S.err='Could not load the ledger. Refresh the page to try again.';render();
  });
}

/* ---------- auth ---------- */
function setUser(u){
  S.user=u||null;
  if(!u){S.isAdmin=false;S.ro=true;render();return}
  run(sb.from('admins').select('user_id').eq('user_id',u.id).maybeSingle()).then(function(r){
    S.isAdmin=!!r.data;
  }).catch(function(){S.isAdmin=false}).then(function(){
    S.ro=!S.isAdmin;
    if(S.tab==='login')S.tab='nights';
    render();
  });
}
function signIn(){
  var em=app.querySelector('#le'),pw=app.querySelector('#lp');
  var email=em?em.value.trim():'',password=pw?pw.value:'';
  if(!email||!password){S.login.msg='Enter your email and password.';render();return}
  S.login={busy:true,msg:''};render();
  sb.auth.signInWithPassword({email:email,password:password}).then(function(r){
    S.login.busy=false;
    if(r.error)S.login.msg='That email and password did not match.';
    render();
  });
}

/* ---------- actions ---------- */
function addPlayer(name){
  var p={id:uid(),name:name,createdAt:Date.now()};
  S.players.push(p);sortPlayers();savePlayer(p);return p;
}
function seat(g,pid){g.entries[pid]={buyIns:[g.buyIn||20],cashOut:null};saveGame(g)}
function newGame(){
  var last=S.games[0];
  var g={id:uid(),date:today(),title:'',buyIn:(last&&last.buyIn)||20,createdAt:Date.now(),entries:{}};
  S.games.push(g);sortGames();saveGame(g);S.tab='nights';S.gid=g.id;
}
function csvCell(v){v=String(v==null?'':v);return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v}
function exportCsv(){
  var rows=[['Date','Night','Player','Buy-ins','Total in','Cash-out','Net']];
  S.games.slice().reverse().forEach(function(g){
    Object.keys(g.entries||{}).forEach(function(pid){
      var e=g.entries[pid],p=pm(pid);
      rows.push([g.date,g.title||'',p?p.name:'Unknown',(e.buyIns||[]).length,inOf(e),settled(e)?e.cashOut:'',settled(e)?netOf(e):'']);
    });
  });
  var csv=rows.map(function(r){return r.map(csvCell).join(',')}).join('\n');
  var a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download='poker-ledger.csv';
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(a.href)},1000);
}

/* ---------- derived ---------- */
function standings(){
  var m={};
  S.players.forEach(function(p){m[p.id]={id:p.id,name:p.name,net:0,nights:0,inn:0,best:null,worst:null,wins:0}});
  S.games.forEach(function(g){
    Object.keys(g.entries||{}).forEach(function(pid){
      var e=g.entries[pid],r=m[pid];
      if(!r||!settled(e))return;
      var n=netOf(e);
      r.net=r2(r.net+n);r.nights++;r.inn+=inOf(e);
      if(r.best==null||n>r.best)r.best=n;
      if(r.worst==null||n<r.worst)r.worst=n;
      if(n>0)r.wins++;
    });
  });
  return Object.keys(m).map(function(k){return m[k]}).filter(function(r){return r.nights>0}).sort(function(a,b){return b.net-a.net||a.name.localeCompare(b.name)});
}
function settle(g){
  var bal=[];
  Object.keys(g.entries||{}).forEach(function(pid){
    var e=g.entries[pid];
    if(settled(e)){var c=Math.round(netOf(e)*100);if(c)bal.push({pid:pid,c:c})}
  });
  var cr=bal.filter(function(b){return b.c>0}).sort(function(a,b){return b.c-a.c});
  var dr=bal.filter(function(b){return b.c<0}).map(function(b){return {pid:b.pid,c:-b.c}}).sort(function(a,b){return b.c-a.c});
  var out=[],i=0,j=0;
  while(i<dr.length&&j<cr.length){
    var m=Math.min(dr[i].c,cr[j].c);
    out.push({from:dr[i].pid,to:cr[j].pid,amt:m/100});
    dr[i].c-=m;cr[j].c-=m;
    if(!dr[i].c)i++;
    if(!cr[j].c)j++;
  }
  return out;
}

/* ---------- chart ---------- */
function niceStep(x){var p=Math.pow(10,Math.floor(Math.log10(x)));var f=x/p;return (f<=1?1:f<=2?2:f<=5?5:10)*p}
function chart(rows){
  var games=S.games.slice().sort(function(a,b){return (a.date||'').localeCompare(b.date||'')||(a.createdAt||0)-(b.createdAt||0)});
  games=games.filter(function(g){return Object.keys(g.entries||{}).some(function(k){return settled(g.entries[k])})});
  var N=games.length;
  if(N<2)return '<p class="hint">The running-total chart appears after your second finished night.</p>';
  var series=rows.map(function(r){
    var cum=0,pts=[0];
    games.forEach(function(g){var e=(g.entries||{})[r.id];if(e&&settled(e))cum=r2(cum+netOf(e));pts.push(cum)});
    return {id:r.id,name:r.name,pts:pts};
  });
  var mn=0,mx=0;
  series.forEach(function(s){s.pts.forEach(function(v){if(v<mn)mn=v;if(v>mx)mx=v})});
  if(mx===mn)mx=mn+10;
  var step=niceStep((mx-mn)/4);
  var lo=Math.floor(mn/step)*step,hi=Math.ceil(mx/step)*step;
  var W=640,H=300,L=56,R=104,T=14,B=30;
  function X(i){return L+(W-L-R)*i/N}
  function Y(v){return T+(H-T-B)*(1-(v-lo)/(hi-lo))}
  var s='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Running total winnings by night for each player">';
  for(var t=lo;t<=hi+step/2;t+=step){
    var y=Y(t);
    s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'" stroke="var(--line)" stroke-width="'+(Math.abs(t)<1e-9?1.6:1)+'"/>';
    s+='<text x="'+(L-8)+'" y="'+(y+4)+'" text-anchor="end" font-size="11" fill="var(--muted)">'+esc(money(Math.round(t*100)/100))+'</text>';
  }
  var every=Math.ceil(N/7);
  games.forEach(function(g,i){
    if(i%every===0||i===N-1)s+='<text x="'+X(i+1)+'" y="'+(H-8)+'" text-anchor="middle" font-size="11" fill="var(--muted)">'+esc(fmtDate(g.date,true))+'</text>';
  });
  var labels=[];
  series.forEach(function(sr){
    var ci=pci(sr.id);
    var d=sr.pts.map(function(v,i){return (i?'L':'M')+X(i).toFixed(1)+' '+Y(v).toFixed(1)}).join(' ');
    s+='<path d="'+d+'" fill="none" stroke="var(--c'+ci+')" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>';
    var last=sr.pts[sr.pts.length-1];
    s+='<circle cx="'+X(N)+'" cy="'+Y(last)+'" r="3.6" fill="var(--c'+ci+')"/>';
    labels.push({y:Y(last),name:sr.name,ci:ci});
  });
  labels.sort(function(a,b){return a.y-b.y});
  for(var k=1;k<labels.length;k++){if(labels[k].y<labels[k-1].y+13)labels[k].y=labels[k-1].y+13}
  labels.forEach(function(l){
    var nm=l.name.length>11?l.name.slice(0,10)+'…':l.name;
    s+='<text x="'+(W-R+10)+'" y="'+(l.y+4)+'" font-size="12" fill="var(--fg)">'+esc(nm)+'</text>';
  });
  return s+'</svg>';
}

/* ---------- views ---------- */
function header(){
  var np=S.players.length,ng=S.games.length;
  var sub=np+' player'+(np===1?'':'s')+' · '+ng+' night'+(ng===1?'':'s');
  var right;
  if(S.demo)right='<div class="sync off"><i></i><span>Demo mode: not connected to Supabase, changes are not saved</span></div>';
  else if(S.user)right='<div class="sync'+(S.isAdmin?'':' off')+'"><i></i><span>'+(S.isAdmin?'Editing as ':'View only, signed in as ')+esc(S.user.email)+'</span><button class="btn ghost sm" data-act="signOut">Sign out</button></div>';
  else right='<div class="sync"><i></i><span>Live</span>'+(S.tab==='login'?'':'<button class="btn ghost sm" data-act="tab" data-id="login">Admin sign in</button>')+'</div>';
  return '<header class="top"><div><div class="kicker">'+esc(sub)+'</div><h1>Poker Ledger</h1></div>'+right+'</header>';
}
function tabs(){
  var t=[['ledger','Leaderboard'],['nights','Nights'],['players','Players'],['play','Play']];
  return '<nav class="tabs">'+t.map(function(x){return '<button data-act="tab" data-id="'+x[0]+'"'+(S.tab===x[0]?' aria-current="page"':'')+'>'+x[1]+'</button>'}).join('')+'</nav>';
}
function banner(){
  if(!S.err)return '';
  return '<div class="banner"><span>'+esc(S.err)+'</span><button data-act="dismiss">Dismiss</button></div>';
}
function gateView(){
  return '<div style="max-width:380px;margin:12vh auto 0">'+
    '<div class="kicker">Private</div><p class="login-title">Poker Ledger</p>'+
    '<p class="hint" style="margin-top:0;margin-bottom:24px">Enter the keyword to see the standings.</p>'+
    '<div class="login"><label>Keyword<input type="password" id="gk" data-fk="gk" data-enter="unlock" autocomplete="off" autocapitalize="none" spellcheck="false"></label>'+
    (S.gate.msg?'<p class="hint neg" style="margin:0">'+esc(S.gate.msg)+'</p>':'')+
    '<div class="row"><button class="btn" data-act="unlock"'+(S.gate.busy?' disabled':'')+'>'+(S.gate.busy?'Checking…':'Enter')+'</button></div></div></div>';
}
function loginView(){
  return '<p class="login-title">Admin sign in</p><p class="hint" style="margin-top:0;margin-bottom:24px">Only the ledger keeper can sign in. Everyone else can see the results without an account.</p>'+
    '<div class="login"><label>Email<input type="email" id="le" data-fk="le" autocomplete="username"></label>'+
    '<label>Password<input type="password" id="lp" data-fk="lp" data-enter="signIn" autocomplete="current-password"></label>'+
    (S.login.msg?'<p class="hint neg" style="margin:0">'+esc(S.login.msg)+'</p>':'')+
    '<div class="row"><button class="btn" data-act="signIn"'+(S.login.busy?' disabled':'')+'>'+(S.login.busy?'Signing in…':'Sign in')+'</button>'+
    '<button class="btn ghost" data-act="tab" data-id="ledger">Cancel</button></div></div>';
}
function ledgerView(){
  var rows=standings();
  if(!rows.length){
    var hasP=S.players.length>0;
    return '<div class="empty"><h2>No results yet</h2><p class="hint" style="margin-top:0">The leaderboard fills in as soon as one night has everyone cashed out.</p><ol>'+
      '<li>Add your mates on the Players tab.</li><li>Start a night and enter each buy-in and rebuy.</li><li>Enter cash-outs at the end of the night.</li></ol>'+
      '<div class="row"><button class="btn edit" data-act="'+(hasP?'newGame':'tab')+'" data-id="players">'+(hasP?'Start a night':'Add players')+'</button></div></div>';
  }
  var nights=S.games.filter(function(g){return Object.keys(g.entries||{}).some(function(k){return settled(g.entries[k])})}).length;
  var pot=r2(S.games.reduce(function(a,g){return a+gameStats(g).pot},0));
  var bw=null,bl=null;
  S.games.forEach(function(g){Object.keys(g.entries||{}).forEach(function(pid){
    var e=g.entries[pid];if(!settled(e)||!pm(pid))return;var n=netOf(e);
    if(!bw||n>bw.n)bw={n:n,p:pm(pid).name,d:g.date};
    if(!bl||n<bl.n)bl={n:n,p:pm(pid).name,d:g.date};
  })});
  var h='<div class="stats">'+
    '<div class="stat"><div class="v">'+nights+'</div><div class="l">Nights played</div></div>'+
    '<div class="stat"><div class="v">'+esc(money(pot))+'</div><div class="l">Total bought in</div></div>'+
    '<div class="stat"><div class="v pos">'+(bw?esc(signed(bw.n)):'-')+'</div><div class="l">Biggest win</div><div class="s">'+(bw?esc(bw.p)+', '+esc(fmtDate(bw.d,true)):'')+'</div></div>'+
    '<div class="stat"><div class="v neg">'+(bl&&bl.n<0?esc(signed(bl.n)):'-')+'</div><div class="l">Biggest loss</div><div class="s">'+(bl&&bl.n<0?esc(bl.p)+', '+esc(fmtDate(bl.d,true)):'')+'</div></div>'+
    '</div>';
  h+='<div class="section"><h2>Standings</h2><div class="scroll"><table><thead><tr><th>#</th><th>Player</th><th>Net</th><th>Nights</th><th>Bought in</th><th>Avg / night</th><th>Best</th><th>Worst</th><th>Win rate</th></tr></thead><tbody>';
  rows.forEach(function(r,i){
    h+='<tr class="'+(i===0?'first':'')+'"><td class="rank">'+(i+1)+'</td>'+
      '<td class="pl"><span class="dot" style="--pc:var(--c'+pci(r.id)+')"></span>'+esc(r.name)+'</td>'+
      '<td class="big '+cls(r.net)+'">'+esc(signed(r.net))+'</td>'+
      '<td class="num">'+r.nights+'</td><td class="num">'+esc(money(r.inn))+'</td>'+
      '<td class="num '+cls(r.net)+'">'+esc(signed(r2(r.net/r.nights)))+'</td>'+
      '<td class="num '+cls(r.best)+'">'+esc(signed(r.best))+'</td><td class="num '+cls(r.worst)+'">'+esc(signed(r.worst))+'</td>'+
      '<td class="num">'+Math.round(100*r.wins/r.nights)+'%</td></tr>';
  });
  h+='</tbody></table></div></div>';
  h+='<div class="section"><h2>Running total</h2><div class="scroll chartbox">'+chart(rows)+'</div></div>';
  h+='<div class="section"><button class="btn ghost" data-act="export">Export everything as CSV</button></div>';
  return h;
}
function statusPill(g){
  var st=gameStats(g);
  if(!st.n)return '<span class="pill">Empty</span>';
  if(st.done<st.n)return '<span class="pill live">In play, '+st.done+' of '+st.n+' cashed out</span>';
  if(st.balanced)return '<span class="pill ok">Balanced</span>';
  return '<span class="pill warn">Off by '+esc(money(Math.abs(st.diff)))+'</span>';
}
function nightsView(){
  var h='<div class="bar"><h2 style="margin:0">Nights</h2><button class="btn edit" data-act="newGame"'+(S.players.length?'':' disabled')+'>New night</button></div>';
  if(!S.players.length)h+='<p class="hint">No players yet.</p>';
  else if(!S.games.length)h+='<p class="hint">No nights yet.</p>';
  S.games.forEach(function(g){
    var st=gameStats(g);
    h+='<button class="nrow" data-act="open" data-id="'+esc(g.id)+'"><span class="d">'+esc(fmtDate(g.date))+(g.title?' · '+esc(g.title):'')+'</span>'+
      '<span class="m">'+st.n+' player'+(st.n===1?'':'s')+' · pot '+esc(money(st.pot))+'</span><span class="r">'+statusPill(g)+'</span></button>';
  });
  return h;
}
function gameView(g){
  var st=gameStats(g);
  var seated=S.players.filter(function(p){return g.entries[p.id]});
  var out=S.players.filter(function(p){return !g.entries[p.id]});
  var h='<div class="bar"><button class="btn ghost sm" data-act="back">← All nights</button>'+statusPill(g)+'</div>';
  h+='<div class="meta">'+
    '<label>Date<input type="date" id="gd" data-fk="gd" data-ch="gdate" value="'+esc(g.date)+'"'+(S.ro?' disabled':'')+'></label>'+
    '<label class="grow">Night name (optional)<input type="text" id="gt" data-fk="gt" data-ch="gtitle" placeholder="e.g. Dave’s place" value="'+esc(g.title||'')+'"'+(S.ro?' disabled':'')+'></label>'+
    '<label>Buy-in ($)<input type="number" id="gb" data-fk="gb" data-ch="gbuy" min="1" step="any" value="'+esc(g.buyIn)+'"'+(S.ro?' disabled':'')+'></label></div>';
  var tm;
  if(!st.n)tm='Add players below';
  else if(st.done<st.n)tm='Waiting on '+(st.n-st.done)+' cash-out'+(st.n-st.done===1?'':'s');
  else if(st.balanced)tm='Pot and cash-outs match';
  else if(st.diff>0)tm='Cash-outs are '+money(st.diff)+' more than the pot';
  else tm='Cash-outs are '+money(-st.diff)+' less than the pot';
  h+='<div class="tot"><div><div class="v">'+esc(money(st.pot))+'</div><div class="l">In the pot</div></div>'+
     '<div><div class="v">'+esc(money(st.out))+'</div><div class="l">Cashed out</div></div>'+
     '<div><div class="v t '+(st.balanced?'pos':(st.done===st.n&&st.n?'neg':''))+'">'+esc(tm)+'</div><div class="l">Check</div></div></div>';
  seated.forEach(function(p){
    var e=g.entries[p.id];
    var net=netOf(e);
    var chips=(e.buyIns||[]).map(function(a,i){
      return '<span class="chip">'+esc(money(a))+'<button class="x edit" style="padding:0 2px;font-size:16px" data-act="rmbuy" data-id="'+esc(p.id)+'" data-i="'+i+'" aria-label="Remove this buy-in">×</button></span>';
    }).join('');
    var add;
    if(S.addFor===p.id)add='<span class="edit" style="display:inline-flex;gap:6px"><input type="number" id="oa" data-fk="oa" data-enter="commitOther" data-id="'+esc(p.id)+'" min="0" step="any" placeholder="Amount" aria-label="Buy-in amount"><button class="btn sm" data-act="commitOther" data-id="'+esc(p.id)+'">Add</button><button class="btn ghost sm" data-act="otherbuy" data-id="'+esc(p.id)+'">Cancel</button></span>';
    else add='<button class="btn ghost sm edit" data-act="buyin" data-id="'+esc(p.id)+'">+ '+((e.buyIns||[]).length?'Rebuy ':'Buy-in ')+esc(money(g.buyIn))+'</button><button class="btn ghost sm edit" data-act="otherbuy" data-id="'+esc(p.id)+'">Other…</button>';
    h+='<div class="prow" style="--pc:var(--c'+pci(p.id)+')">'+
      '<div class="pname"><span class="dot"></span>'+esc(p.name)+'</div>'+
      '<div class="chips">'+chips+add+'</div>'+
      '<div class="in"><span class="lbl">In</span>'+esc(money(inOf(e)))+'</div>'+
      '<label class="cash"><span class="lbl">Cash-out</span><input type="number" min="0" step="any" id="c-'+esc(p.id)+'" data-fk="c-'+esc(p.id)+'" data-ch="cash" data-id="'+esc(p.id)+'" placeholder="Still in" value="'+(settled(e)?esc(e.cashOut):'')+'" aria-label="Cash-out for '+esc(p.name)+'"'+(S.ro?' disabled':'')+'>'+
      (settled(e)?'':'<button class="btn ghost sm edit" data-act="bust" data-id="'+esc(p.id)+'" title="Cash out at $0">Busted</button>')+'</label>'+
      '<div class="netc '+(net==null?'zero':cls(net))+'">'+(net==null?'–':esc(signed(net)))+'</div>'+
      '<button class="x rm edit" data-act="unseat" data-id="'+esc(p.id)+'" aria-label="Remove '+esc(p.name)+' from this night" title="Remove from this night">×</button></div>';
  });
  h+='<div class="section edit" style="margin-top:22px"><h3>Add to tonight</h3><div class="seat">'+
    out.map(function(p){return '<button class="btn ghost sm" data-act="seat" data-id="'+esc(p.id)+'">+ '+esc(p.name)+'</button>'}).join('')+
    '<span class="add"><input type="text" id="ns" data-fk="ns" data-enter="newSeat" placeholder="New player name" aria-label="New player name"><button class="btn sm" data-act="newSeat">Add new player</button></span></div></div>';
  h+='<div class="section"><h3>Settle up</h3>';
  if(st.balanced){
    var tr=settle(g);
    if(!tr.length)h+='<p class="hint">Everybody broke even. Nobody owes anything.</p>';
    else{h+='<ul class="settle">'+tr.map(function(t){var a=pm(t.from),b=pm(t.to);return '<li><span><b>'+esc(a?a.name:'Unknown')+'</b> pays <b>'+esc(b?b.name:'Unknown')+'</b></span><span class="mono">'+esc(money(t.amt))+'</span></li>'}).join('')+'</ul>'}
  }else if(st.n&&st.done<st.n)h+='<p class="hint">Who pays whom shows up once everyone has cashed out and the numbers match.</p>';
  else if(st.n)h+='<p class="hint">The cash-outs do not match the pot yet. Check the buy-ins and cash-outs above.</p>';
  else h+='<p class="hint">Nobody is seated yet.</p>';
  h+='</div>';
  h+='<div class="section edit">'+(S.confirmDel==='g'?
    '<span class="hint">Delete this night and its results for everyone? </span><button class="btn danger sm" data-act="delGameYes">Yes, delete it</button> <button class="btn ghost sm" data-act="delGameNo">Keep it</button>':
    '<button class="btn danger sm" data-act="delGame">Delete this night</button>')+'</div>';
  return h;
}
function playersView(){
  var used={};
  S.games.forEach(function(g){Object.keys(g.entries||{}).forEach(function(k){used[k]=(used[k]||0)+1})});
  var h='<h2>Players</h2>';
  if(!S.players.length)h+='<p class="hint">No players yet.</p>';
  S.players.forEach(function(p){
    h+='<div class="pr" style="--pc:var(--c'+pci(p.id)+')"><span class="dot" style="margin:0"></span><div class="pn"><input type="text" id="pn-'+esc(p.id)+'" data-fk="pn-'+esc(p.id)+'" data-ch="pname" data-id="'+esc(p.id)+'" value="'+esc(p.name)+'" aria-label="Player name"'+(S.ro?' disabled':'')+'></div>'+
      '<span class="c">'+(used[p.id]||0)+' night'+((used[p.id]||0)===1?'':'s')+'</span>'+
      (used[p.id]?'<span class="hint edit" style="margin:0;font-size:13px">Has history</span>':'<button class="btn danger sm edit" data-act="delPlayer" data-id="'+esc(p.id)+'">Delete</button>')+'</div>';
  });
  h+='<div class="addrow edit"><input type="text" id="np" data-fk="np" data-enter="addPlayer" placeholder="Player name" aria-label="Player name"><button class="btn" data-act="addPlayer">Add player</button></div>';
  return h;
}
function view(){
  if(S.gate.need)return gateView();
  var h=header()+banner();
  if(S.tab==='login')return h+'<div style="margin-top:28px">'+loginView()+'</div>';
  h+=tabs();
  if(!S.loaded)return h+'<p class="hint">Loading the ledger…</p>';
  if(S.tab==='ledger')h+=ledgerView();
  else if(S.tab==='nights'){var g=openG();if(!g)S.gid=null;h+=g?gameView(g):nightsView()}
  else if(S.tab==='play')h+=sb?'<div id="play-root"></div>':'<p class="hint">Online play works on the live site, once it’s connected to Supabase.</p>';
  else h+=playersView();
  return h;
}
function render(){
  var a=document.activeElement,fk=null,val=null,ss=null,se=null;
  if(a&&a.dataset&&a.dataset.fk&&app.contains(a)){fk=a.dataset.fk;val=a.value;try{ss=a.selectionStart;se=a.selectionEnd}catch(x){}}
  app.className=S.ro?'ro':'';
  document.body.classList.toggle('wide',S.tab==='play'&&!S.gate.need);
  app.innerHTML=view();
  var pr=app.querySelector('#play-root');
  if(pr&&window.Play)Play.mount(pr,{sb:sb,pass:S.pass,isAdmin:S.isAdmin,players:S.players,reload:load});
  if(fk){
    var el=app.querySelector('[data-fk="'+fk.replace(/"/g,'\\"')+'"]');
    if(el){if(val!=null&&el.value!==val)el.value=val;el.focus();try{if(ss!=null)el.setSelectionRange(ss,se)}catch(x){}}
  }
}

/* ---------- events ---------- */
app.addEventListener('click',function(ev){
  var t=ev.target.closest('[data-act]');
  if(!t||t.disabled)return;
  var act=t.dataset.act,id=t.dataset.id,i=t.dataset.i,g=openG(),e,inp,v;
  if(S.ro&&['tab','dismiss','open','back','export','signIn','signOut','unlock'].indexOf(act)<0)return;
  switch(act){
    case 'unlock':unlock();return;
    case 'tab':
      if(S.tab==='play'&&id!=='play'&&window.Play)Play.stop();
      S.tab=id;S.gid=null;S.confirmDel=null;S.addFor=null;S.login.msg='';
      break;
    case 'dismiss':S.err='';break;
    case 'signIn':signIn();return;
    case 'signOut':sb.auth.signOut();S.tab='ledger';break;
    case 'newGame':newGame();break;
    case 'open':S.gid=id;S.confirmDel=null;S.addFor=null;break;
    case 'back':S.gid=null;S.confirmDel=null;S.addFor=null;break;
    case 'addPlayer':
      inp=app.querySelector('#np');v=inp?inp.value.trim():'';
      if(v){addPlayer(v);inp.value=''}
      break;
    case 'seat':if(g&&pm(id))seat(g,id);break;
    case 'newSeat':
      inp=app.querySelector('#ns');v=inp?inp.value.trim():'';
      if(v&&g){var p=addPlayer(v);seat(g,p.id);inp.value=''}
      break;
    case 'unseat':if(g){delete g.entries[id];saveGame(g)}break;
    case 'buyin':if(g&&g.entries[id]){g.entries[id].buyIns=(g.entries[id].buyIns||[]).concat([g.buyIn]);saveGame(g)}break;
    case 'otherbuy':S.addFor=(S.addFor===id?null:id);break;
    case 'commitOther':
      inp=app.querySelector('#oa');v=inp?num(inp.value):null;
      if(g&&g.entries[id]&&v&&v>0){g.entries[id].buyIns=(g.entries[id].buyIns||[]).concat([r2(v)]);saveGame(g);S.addFor=null}
      break;
    case 'rmbuy':
      if(g&&g.entries[id]){e=g.entries[id];e.buyIns=e.buyIns.filter(function(_,k){return k!==Number(i)});saveGame(g)}
      break;
    case 'bust':if(g&&g.entries[id]){g.entries[id].cashOut=0;saveGame(g)}break;
    case 'delGame':S.confirmDel='g';break;
    case 'delGameNo':S.confirmDel=null;break;
    case 'delGameYes':
      if(g){var gid=g.id;S.games=S.games.filter(function(x){return x.id!==gid});S.gid=null;S.confirmDel=null;deleteRow('games',gid)}
      break;
    case 'delPlayer':
      S.players=S.players.filter(function(x){return x.id!==id});
      deleteRow('players',id);
      break;
    case 'export':exportCsv();return;
  }
  render();
});
app.addEventListener('change',function(ev){
  var t=ev.target,ch=t.dataset&&t.dataset.ch;
  if(!ch||S.ro)return;
  var g=openG(),id=t.dataset.id,v;
  switch(ch){
    case 'gdate':if(g&&t.value){g.date=t.value;sortGames();saveGame(g)}break;
    case 'gtitle':if(g){g.title=t.value.trim();saveGame(g)}break;
    case 'gbuy':v=num(t.value);if(g&&v&&v>0){g.buyIn=r2(v);saveGame(g)}break;
    case 'cash':
      if(g&&g.entries[id]){
        v=t.value.trim()===''?null:num(t.value);
        if(v!=null&&v<0)v=null;
        g.entries[id].cashOut=(v==null?null:r2(v));
        saveGame(g);
      }
      break;
    case 'pname':v=t.value.trim();var p=pm(id);if(p&&v){p.name=v;savePlayer(p)}break;
  }
  setTimeout(render,0);
});
app.addEventListener('keydown',function(ev){
  var t=ev.target;
  if(ev.key==='Enter'&&t.dataset&&t.dataset.enter){
    ev.preventDefault();
    var b=app.querySelector('button[data-act="'+t.dataset.enter+'"]');
    if(b)b.click();
  }
});

/* ---------- boot ---------- */
var configured=cfg.supabaseUrl&&cfg.supabaseUrl.indexOf('YOUR_')!==0&&cfg.supabaseAnonKey&&cfg.supabaseAnonKey.indexOf('YOUR_')!==0;
if(!configured||!window.supabase){
  // No Supabase keys yet: run on sample data so the page can be tried out locally.
  S.demo=true;S.ro=false;S.loaded=true;
  S.players=[{id:'mvhxiq2rkkmof',name:'Sai',createdAt:1792576088451},{id:'mvhxivhn0tjme',name:'Akashtan',createdAt:1792576095467},{id:'mvhxixxjcg0jd',name:'Vimal',createdAt:1792576098631},{id:'mvhxizyngwmbe',name:'Yug',createdAt:1792576101263},{id:'mvhxj2eap4dq0',name:'Sud',createdAt:1792576104418},{id:'mvhxj4w441x6g',name:'Koch',createdAt:1792576107652},{id:'mvhxj8ul4rm59',name:'Rohan',createdAt:1792576112781}];
  S.games=[{id:'mvhxjjdrbvgcs',buyIn:50,createdAt:1792576126431,date:'2026-10-11',title:'yugs',entries:{mvhxiq2rkkmof:{buyIns:[50],cashOut:93.5},mvhxixxjcg0jd:{buyIns:[50],cashOut:76.5},mvhxizyngwmbe:{buyIns:[50],cashOut:30},mvhxj2eap4dq0:{buyIns:[50],cashOut:0}}},{id:'mvhxob14bpk3w',buyIn:50,createdAt:1792576348888,date:'2026-10-18',title:'Sais',entries:{mvhxiq2rkkmof:{buyIns:[50],cashOut:140.5},mvhxivhn0tjme:{buyIns:[50,50],cashOut:93.5},mvhxixxjcg0jd:{buyIns:[50],cashOut:0},mvhxizyngwmbe:{buyIns:[50,50],cashOut:20},mvhxj4w441x6g:{buyIns:[50],cashOut:89},mvhxj8ul4rm59:{buyIns:[50],cashOut:75}}}];
  sortPlayers();sortGames();render();
  return;
}
// The database only returns rows when a request carries the viewer keyword (x-ledger-pass header).
// It is remembered on this device so friends type it once.
var PASS_KEY='ledger-pass';
function readPass(){try{return localStorage.getItem(PASS_KEY)||''}catch(x){return ''}}
function writePass(v){try{if(v)localStorage.setItem(PASS_KEY,v);else localStorage.removeItem(PASS_KEY)}catch(x){}}
function checkPass(pass){
  return fetch(cfg.supabaseUrl+'/rest/v1/rpc/has_viewer_pass',{
    method:'POST',
    headers:{apikey:cfg.supabaseAnonKey,Authorization:'Bearer '+cfg.supabaseAnonKey,'Content-Type':'application/json','x-ledger-pass':pass},
    body:'{}'
  }).then(function(r){if(!r.ok)throw new Error('check failed');return r.json()}).then(function(v){return v===true});
}
function unlock(){
  var inp=app.querySelector('#gk'),pass=inp?inp.value.trim().toLowerCase():'';
  if(!pass){S.gate.msg='Enter the keyword.';render();return}
  S.gate.busy=true;S.gate.msg='';render();
  checkPass(pass).then(function(ok){
    S.gate.busy=false;
    if(ok){writePass(pass);start(pass)}
    else{S.gate.msg='That keyword is not right.';render()}
  }).catch(function(){S.gate.busy=false;S.gate.msg='Could not check the keyword. Check your connection and try again.';render()});
}
function showGate(){S.gate.need=true;render()}
function start(pass){
  S.gate={need:false,busy:false,msg:''};
  S.pass=pass;
  sb=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseAnonKey,{global:{headers:{'x-ledger-pass':pass}}});
  render();
  load();
  sb.auth.onAuthStateChange(function(_event,session){
    // Supabase recommends not awaiting other calls inside this callback.
    setTimeout(function(){setUser(session&&session.user)},0);
  });
  // Friends' pages refresh every 30 seconds while open, and straight away when they come back to the tab.
  // The admin's own page is already up to date.
  // The Play tab keeps itself up to date, so skip these while it's open.
  setInterval(function(){if(!document.hidden&&!S.isAdmin&&S.tab!=='play')load()},30000);
  document.addEventListener('visibilitychange',function(){if(!document.hidden&&!S.isAdmin&&S.tab!=='play')load()});
}
var saved=readPass();
if(!saved){showGate();return}
checkPass(saved).then(function(ok){
  if(ok)start(saved);
  else{writePass('');showGate()}
}).catch(function(){S.gate.msg='Could not reach the ledger. Check your connection and try again.';showGate()});
})();
