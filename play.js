// Play tab: online No-Limit Hold'em tables run by the "poker" Supabase function.
// The server holds the deck and everyone's cards; this file only draws what it is sent and sends actions back.
(function(){
'use strict';
var P={view:'lobby',tables:[],isHost:false,tid:null,st:null,err:'',busy:false,sit:null,form:false,raise:0,raiseKey:'',raiseOpen:false,offset:0,confirm:null,verify:{}};
var ctx=null,root=null,chan=null,lobbyChan=null,poll=null,clock=null,wake=null,soon=null;
var SUIT={s:'♠',h:'♥',d:'♦',c:'♣'};
// When each face-up card first appeared ({t: time, d: delay}). A card keeps its flip running across redraws
// (with a negative animation-delay) until the flip has finished, so a quick redraw doesn't cut it off.
var seen={},flipIndex=0;
var FLIP_MS=600;
P.myCards={};

/* ---------- helpers ---------- */
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function dollars(c){var a=Math.abs(c)/100;var s='$'+a.toLocaleString('en-AU',{minimumFractionDigits:(a%1?2:0),maximumFractionDigits:2});return c<0?'−'+s:s}
function chipsOn(units){return (units||(P.st&&P.st.units))==='chips'}
// Every amount is whole cents. A chips table shows 1¢ as 1 chip, so $1 reads as 100.
function fmt(c,units){if(!chipsOn(units))return dollars(c);var s=Math.abs(c).toLocaleString('en-AU');return c<0?'−'+s:s}
function signed(c){return c>0?'+'+fmt(c):fmt(c)}
function fmtText(s){return esc(s).replace(/\{\{(-?\d+)\}\}/g,function(m,n){return fmt(Number(n))})}
function cls(n){return n>0?'pos':(n<0?'neg':'zero')}
function toCents(v){var n=parseFloat(v);return isFinite(n)?Math.round(n*100):NaN}
function parseAmt(v){var n=parseFloat(v);return !isFinite(n)?NaN:chipsOn()?Math.round(n):Math.round(n*100)}
function showAmt(c){return chipsOn()?c:c/100}
function today(){var d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function getTok(id){try{return localStorage.getItem('poker-token-'+id)||''}catch(x){return ''}}
function setTok(id,v){try{if(v)localStorage.setItem('poker-token-'+id,v);else localStorage.removeItem('poker-token-'+id)}catch(x){}}
// key: a stable name for this card slot, so it flips once when it first turns face up.
function card(c,size,key){
  var k='card'+(size?' '+size:'');
  if(!c)return '<span class="'+k+' down"><span class="cb"></span></span>';
  var style='',flip=false;
  if(key){
    var info=seen[key],t=Date.now();
    if(!info){info=seen[key]={t:t,d:flipIndex*120};flipIndex++}
    var age=t-info.t;
    if(age<info.d+FLIP_MS){flip=true;style=' style="animation-delay:'+(info.d-age)+'ms"'}
  }
  return '<span class="'+k+' su-'+c[1]+(flip?' flip':'')+'"'+style+'><span class="cf"><b>'+(c[0]==='T'?'10':c[0])+'</b><i>'+SUIT[c[1]]+'</i></span><span class="cb"></span></span>';
}

/* ---------- naming hands (same ranking as the server) ---------- */
var RV='23456789TJQKA';
var PLURAL={2:'Twos',3:'Threes',4:'Fours',5:'Fives',6:'Sixes',7:'Sevens',8:'Eights',9:'Nines',10:'Tens',11:'Jacks',12:'Queens',13:'Kings',14:'Aces'};
var SINGLE={2:'Two',3:'Three',4:'Four',5:'Five',6:'Six',7:'Seven',8:'Eight',9:'Nine',10:'Ten',11:'Jack',12:'Queen',13:'King',14:'Ace'};
function rv(c){return RV.indexOf(c[0])+2}
function groupsOf(v){
  var cnt={};v.forEach(function(x){cnt[x]=(cnt[x]||0)+1});
  return Object.keys(cnt).map(function(x){return [Number(x),cnt[x]]}).sort(function(a,b){return b[1]-a[1]||b[0]-a[0]});
}
// Scores 2–5 cards; with fewer than 5 there's no straight or flush yet, only pairs and high cards.
function score(cs){
  var v=cs.map(rv).sort(function(a,b){return b-a}),g=groupsOf(v),r=g.map(function(x){return x[0]});
  if(cs.length===5){
    var flush=cs.every(function(c){return c[1]===cs[0][1]}),st=0;
    if(g.length===5){if(v[0]-v[4]===4)st=v[0];else if(v[0]===14&&v[1]===5)st=5}
    if(st&&flush)return [8,st];
    if(g[0][1]===4)return [7].concat(r);
    if(g[0][1]===3&&g[1][1]===2)return [6].concat(r);
    if(flush)return [5].concat(v);
    if(st)return [4,st];
  }
  if(g[0][1]===4)return [7].concat(r);
  if(g[0][1]===3)return [3].concat(r);
  if(g[0][1]===2&&g[1]&&g[1][1]===2)return [2].concat(r);
  if(g[0][1]===2)return [1].concat(r);
  return [0].concat(v);
}
function cmpScore(a,b){for(var i=0;i<Math.max(a.length,b.length);i++){var d=(a[i]||0)-(b[i]||0);if(d)return d}return 0}
function bestScore(cards){
  if(cards.length<=5)return score(cards);
  var best=null,n=cards.length;
  (function pick(start,chosen){
    if(chosen.length===5){var s=score(chosen);if(!best||cmpScore(s,best)>0)best=s;return}
    for(var i=start;i<=n-(5-chosen.length);i++)pick(i+1,chosen.concat([cards[i]]));
  })(0,[]);
  return best;
}
function describeHand(cards){
  var s=bestScore(cards.filter(Boolean));
  switch(s[0]){
    case 8:return s[1]===14?'Royal flush':SINGLE[s[1]]+'-high straight flush';
    case 7:return 'Four '+PLURAL[s[1]];
    case 6:return PLURAL[s[1]]+' full of '+PLURAL[s[2]];
    case 5:return SINGLE[s[1]]+'-high flush';
    case 4:return SINGLE[s[1]]+'-high straight';
    case 3:return 'Three '+PLURAL[s[1]];
    case 2:return 'Two pair, '+PLURAL[s[1]]+' and '+PLURAL[s[2]];
    case 1:return 'Pair of '+PLURAL[s[1]];
    default:return SINGLE[s[1]]+' high';
  }
}
/* ---------- provably fair checks ---------- */
// Rebuilds a hand's deck exactly as the server's fairDeck() does (see supabase/functions/poker/index.ts):
// Fisher–Yates over 2s,2h,2d,2c…Ac, using HMAC-SHA256(serverSeed, clientSeeds:handNo:counter) as the random stream.
function enc(s){return new TextEncoder().encode(s)}
function hex(buf){return Array.prototype.map.call(new Uint8Array(buf),function(b){return b.toString(16).padStart(2,'0')}).join('')}
function sha256hex(s){return crypto.subtle.digest('SHA-256',enc(s)).then(hex)}
function myCseed(fresh){
  var v='';try{v=localStorage.getItem('poker-cseed')||''}catch(x){}
  if(!v||fresh){var b=new Uint8Array(16);crypto.getRandomValues(b);v=hex(b);try{localStorage.setItem('poker-cseed',v)}catch(x){}}
  return v;
}
async function rebuildDeck(seed,client,no){
  var key=await crypto.subtle.importKey('raw',enc(seed),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  var counter=0,buf=new Uint8Array(0),pos=0;
  async function next32(){
    if(pos+4>buf.length){buf=new Uint8Array(await crypto.subtle.sign('HMAC',key,enc(client+':'+no+':'+(counter++))));pos=0}
    var v=((buf[pos]<<24)|(buf[pos+1]<<16)|(buf[pos+2]<<8)|buf[pos+3])>>>0;pos+=4;return v;
  }
  var d=[],R='23456789TJQKA',S='shdc';
  for(var r=0;r<R.length;r++)for(var s=0;s<S.length;s++)d.push(R[r]+S[s]);
  for(var i=d.length-1;i>0;i--){
    var n=i+1,lim=Math.floor(4294967296/n)*n,v=await next32();
    while(v>=lim)v=await next32();
    var j=v%n,t=d[i];d[i]=d[j];d[j]=t;
  }
  return d;
}
// Checks a finished hand: the revealed seed must match the hash shown before the deal, and the rebuilt
// deck must reproduce the board and every hand that was shown (plus your own cards, if you were dealt in).
async function verifyHand(f){
  if(await sha256hex(f.seed)!==f.hash)return {ok:false,msg:'The revealed seed does not match the hash shown before the hand.'};
  var d=await rebuildDeck(f.seed,f.client,f.no),holes={};
  f.order.forEach(function(s){holes[s]=[d.pop(),d.pop()]});
  var board=[d.pop(),d.pop(),d.pop(),d.pop(),d.pop()],bad=[];
  f.board.forEach(function(c,i){if(board[i]!==c)bad.push('board card '+(i+1))});
  Object.keys(f.shown||{}).forEach(function(s){if(!holes[s]||holes[s].join()!==f.shown[s].join())bad.push('seat '+(Number(s)+1)+'’s shown cards')});
  var mine=P.myCards[f.no];
  if(mine&&holes[mine.seat]&&holes[mine.seat].join()!==mine.cards.join())bad.push('your own cards');
  if(bad.length)return {ok:false,msg:'Mismatch: '+bad.join(', ')+'.'};
  return {ok:true,holes:holes,board:f.board,mine:!!mine};
}
function short(h){return h?h.slice(0,10)+'…'+h.slice(-6):'—'}
function cardTxt(c){return (c[0]==='T'?'10':c[0])+SUIT[c[1]]}

function btn(p,label,kind,extra){return '<button class="btn'+(kind?' '+kind:'')+'" data-p="'+p+'"'+(extra||'')+(P.busy?' disabled':'')+'>'+label+'</button>'}
function now(){return Date.now()+P.offset}

/* ---------- server ---------- */
function call(op,args){
  args=args||{};args.op=op;
  return ctx.sb.functions.invoke('poker',{body:args,headers:{'x-ledger-pass':ctx.pass}}).then(function(r){
    if(r.error){
      var res=r.error.context;
      if(res&&typeof res.json==='function')return res.json().then(function(j){throw new Error((j&&j.error)||'The table server had a problem.')},function(){throw new Error('The table server had a problem.')});
      throw new Error('Could not reach the table. Check your connection.');
    }
    if(r.data&&r.data.error)throw new Error(r.data.error);
    return r.data;
  });
}
function loadList(){
  call('list').then(function(d){P.tables=d.tables;P.isHost=d.isHost;if(P.view==='lobby')draw()}).catch(function(e){P.err=e.message;draw()});
}
function refresh(){
  if(P.view!=='table'||!P.tid)return;
  var id=P.tid;
  call('state',{table:id,token:getTok(id)}).then(apply).catch(function(e){
    if(/no longer exists/.test(e.message)){backToLobby();P.err=e.message;draw();return}
    P.err=e.message;draw();
  });
}
function apply(st){
  if(!st||st.id!==P.tid)return;
  if(P.st&&st.version<P.st.version)return;
  // Nothing changed since the last poll: don't redraw, so a half-dragged bet slider stays put.
  var same=P.st&&st.version===P.st.version&&st.isHost===P.st.isHost&&!st.token;
  if(!P.st||st.handNo!==P.st.handNo)P.raiseOpen=false;
  P.st=st;
  P.offset=st.serverNow-Date.now();
  // Remember your own cards so Verify can confirm the shuffle dealt you exactly these.
  if(st.hand&&st.me.seat>=0){var mc=st.seats[st.me.seat].cards;if(mc&&mc[0])P.myCards[st.hand.no]={seat:st.me.seat,cards:mc.slice()}}
  if(st.token)setTok(st.id,st.token);
  if(getTok(st.id)&&st.me.seat<0&&!st.me.request)setTok(st.id,'');
  // The server only moves on when someone asks, so wake up when the next deal or a turn clock is due.
  clearTimeout(wake);
  var due=st.hand?st.hand.deadline:st.nextHandAt;
  if(due)wake=setTimeout(refresh,Math.max(250,due-now()+300));
  if(!same)draw();
}
function op(name,args){
  if(P.busy)return Promise.resolve();
  args=args||{};args.table=P.tid;if(!args.token)args.token=getTok(P.tid);
  P.busy=true;P.err='';draw();
  return call(name,args).then(function(st){P.busy=false;apply(st);draw();return st},function(e){P.busy=false;P.err=e.message;draw()});
}
function schedule(){clearTimeout(soon);soon=setTimeout(function(){P.view==='table'?refresh():loadList()},120)}

/* ---------- navigation ---------- */
function openTable(id){
  stopTable();
  P.view='table';P.tid=id;P.st=null;P.sit=null;P.confirm=null;P.err='';P.raiseOpen=false;
  chan=ctx.sb.channel('poker-'+id).on('broadcast',{event:'update'},schedule).subscribe();
  poll=setInterval(function(){if(!document.hidden)refresh()},3000);
  clock=setInterval(tickTimers,250);
  draw();refresh();
}
function stopTable(){
  if(chan){ctx.sb.removeChannel(chan);chan=null}
  clearInterval(poll);clearInterval(clock);clearTimeout(wake);
  poll=clock=wake=null;
}
function backToLobby(){stopTable();P.view='lobby';P.tid=null;P.st=null;P.sit=null;P.confirm=null;seen={};loadList()}

/* ---------- lobby ---------- */
function statusPill(status,sent){
  if(status==='waiting')return '<span class="pill">Not started</span>';
  if(status==='running')return '<span class="pill live">Playing</span>';
  if(status==='paused')return '<span class="pill">Paused</span>';
  return sent?'<span class="pill ok">In the ledger</span>':'<span class="pill">Finished</span>';
}
function formNote(buy,sb,bb){
  if(!(buy>0)||!(sb>0)||!(bb>0))return 'Enter a buy-in in dollars and the blinds in chips.';
  var chips=Math.round(buy*100);
  return 'Each buy-in of '+dollars(chips)+' is '+chips.toLocaleString('en-AU')+' chips (100 chips = $1). Blinds '+
    Math.round(sb).toLocaleString('en-AU')+'/'+Math.round(bb).toLocaleString('en-AU')+' chips = '+dollars(Math.round(sb))+'/'+dollars(Math.round(bb))+'.';
}
function lobbyHtml(){
  var h=banner();
  h+='<div class="bar"><h2>Tables</h2>'+(P.isHost?btn('form',P.form?'Cancel':'New table',P.form?'ghost':''):'')+'</div>';
  if(P.form){
    // Buy-in is real money; play is in chips, where 1 chip = 1¢ (so $50 buys 5,000 chips).
    h+='<div class="pform">'+
      '<label class="grow">Table name<input type="text" id="pf-name" data-fk="pf-name" value="Poker night"></label>'+
      '<label>Buy-in ($)<input type="number" id="pf-buy" data-fk="pf-buy" min="1" step="1" inputmode="numeric" value="50"></label>'+
      '<label>Small blind (chips)<input type="number" id="pf-sb" data-fk="pf-sb" min="1" step="1" inputmode="numeric" value="25"></label>'+
      '<label>Big blind (chips)<input type="number" id="pf-bb" data-fk="pf-bb" min="1" step="1" inputmode="numeric" value="50"></label>'+
      btn('create','Open table')+
      '<p class="hint pfnote" id="pf-note">'+formNote(50,25,50)+'</p></div>';
  }
  if(!P.tables.length)h+='<p class="hint">No tables yet. '+(P.isHost?'Open one to start a game.':'The host opens one when it’s game time.')+'</p>';
  P.tables.forEach(function(t){
    h+='<button class="nrow" data-p="open" data-id="'+esc(t.id)+'"><span class="d">'+esc(t.name)+'</span>'+
      '<span class="m">'+fmt(t.sb,t.units)+'/'+fmt(t.bb,t.units)+' · buy-in '+fmt(t.buyIn,t.units)+' · '+t.seated+' seated</span>'+
      '<span class="r">'+statusPill(t.status,t.sentToLedger)+'</span></button>';
  });
  return h;
}

/* ---------- table ---------- */
function banner(){return P.err?'<div class="banner" style="margin:0 0 16px"><span>'+fmtText(P.err)+'</span><button data-p="dismiss">Dismiss</button></div>':''}
function seatName(st,i){var s=st.seats[i];return s?s.name:''}
function hostBar(st){
  var b='<div class="phost"><span class="plabel">Host</span>';
  if(st.status==='waiting')b+=btn('start','Start game','sm');
  if(st.status==='running')b+=btn('pause','Pause','ghost sm');
  if(st.status==='paused'){
    b+=btn('start','Resume','sm');
    b+=P.confirm==='end'?'<span class="hint" style="margin:0">Cash everyone out and end?</span>'+btn('endYes','End game','danger sm')+btn('no','Keep playing','ghost sm')
      :btn('end','End game','ghost sm');
  }
  if(st.status==='ended'){
    b+=st.sentToLedger?'<span class="pill ok">Added to the ledger</span>':btn('send','Send to ledger','sm');
    b+=P.confirm==='delete'?btn('deleteYes','Delete for good','danger sm')+btn('no','Keep','ghost sm'):btn('delete','Delete table','ghost sm');
  }
  if(st.status!=='ended'){
    b+='<span class="pblinds">Blinds <input type="number" id="pb-sb" data-fk="pb-sb" min="1" step="1" value="'+st.sb+'" aria-label="Small blind in chips">/<input type="number" id="pb-bb" data-fk="pb-bb" min="1" step="1" value="'+st.bb+'" aria-label="Big blind in chips"> chips'+btn('blinds','Set','ghost sm')+'</span>';
  }
  b+='</div>';
  if(st.requests.length){
    b+='<div class="preqs">'+st.requests.map(function(r){
      return '<div class="preq"><span><b>'+esc(r.name)+'</b> '+(r.kind==='join'?'wants seat '+(r.seat+1):'wants to rebuy')+' for '+fmt(r.amount)+'</span>'+
        '<span class="row">'+btn('approve','Let in','sm',' data-id="'+esc(r.id)+'"')+btn('deny','Deny','ghost sm',' data-id="'+esc(r.id)+'"')+'</span></div>';
    }).join('')+'</div>';
  }
  return b;
}
function centerText(st){
  var h=st.hand;
  if(h)return '';
  if(st.last)return st.last.winners.map(function(w){return '<b>'+esc(w.name)+'</b> wins '+fmt(w.amount)+(w.desc?' with '+esc(w.desc.toLowerCase()):'')}).join('<br>');
  if(st.status==='waiting')return st.isHost?'Seat everyone, then press Start game':'Waiting for the host to start';
  if(st.status==='paused')return 'Paused';
  if(st.status==='ended')return 'Game over';
  var ready=st.seats.filter(function(s){return s&&s.status==='active'&&s.stack+s.pendingAdd>0}).length;
  return ready<2?'Waiting for players':'Dealing…';
}
function feltHtml(st){
  var h=st.hand,me=st.me.seat;
  var anchor=me>=0?me:(st.me.request?st.me.request.seat:(P.sit!=null?P.sit:0));
  var narrow=root.clientWidth<560,rx=narrow?40:45,ry=narrow?46:44;
  var no=h?h.no:(st.last?st.last.no:0);
  var board=h?h.board:(st.last?st.last.board:[]);
  var cards='';
  flipIndex=0;
  for(var b=0;b<5;b++)cards+=board[b]?card(board[b],'',no+'b'+b):'<span class="card slot"></span>';
  var dealer=h?h.button:st.button;
  var canSit=me<0&&!st.me.request&&st.status!=='ended';
  var x='<div class="pfelt-wrap"><div class="pfelt"></div>';
  var hash=h?h.hash:st.nextHash,msg=centerText(st);
  x+='<div class="pcenter">'+(h?'<div class="ppill">'+fmt(h.pot)+'</div>':'')+'<div class="pboard">'+cards+'</div>'+(msg?'<div class="ppot">'+msg+'</div>':'')+
    (hash?'<button class="phash" data-p="fairJump" title="'+esc(hash)+'">'+(h?'Hand #'+h.no:'Next hand')+' · hash '+esc(short(hash))+'</button>':'')+'</div>';
  for(var i=0;i<9;i++){
    var slot=(i-anchor+9)%9,ang=(90+slot*40)*Math.PI/180;
    var left=(50+rx*Math.cos(ang)).toFixed(2),top=(50+ry*Math.sin(ang)).toFixed(2);
    var pos='left:'+left+'%;top:'+top+'%';
    var s=st.seats[i];
    if(!s){
      x+=canSit?'<button class="pseat-empty" data-p="sit" data-seat="'+i+'" style="'+pos+'">Sit here</button>':'<span class="pseat-empty dim" style="'+pos+'"></span>';
      continue;
    }
    var c=['pseat'];
    if(h&&h.toAct===i)c.push('turn');
    if(s.folded)c.push('folded');
    if(i===me)c.push('me');
    if((h&&!s.inHand)||s.status==='sitout')c.push('out');
    if(!h&&st.last&&st.last.winners.some(function(w){return w.seat===i}))c.push('win');
    var tag=s.allIn?'<span class="ptag allin">All-in</span>':s.leaving?'<span class="ptag">Leaving</span>':s.status==='sitout'?'<span class="ptag">Sitting out</span>':s.pendingAdd?'<span class="ptag">+'+fmt(s.pendingAdd)+' next hand</span>':'';
    var mine=s.cards?s.cards.map(function(cd,k){return card(cd,'sm',cd?no+'s'+i+'c'+k:null)}).join(''):'';
    // Name the hand for anyone whose cards are face up: you during a hand, everyone shown at showdown.
    var faceUp=s.cards&&s.cards[0]&&!s.folded;
    var handName=faceUp?describeHand(s.cards.concat(board)):'';
    var won=!h&&st.last&&st.last.winners.some(function(w){return w.seat===i});
    x+='<div class="'+c.join(' ')+'" style="'+pos+'">'+
      '<div class="pcards">'+mine+'</div>'+
      '<div class="pboxw"><div class="pbox"><div class="pn">'+esc(s.name)+'</div><div class="ps">'+fmt(s.stack)+'</div>'+
      (h&&h.toAct===i?'<div class="ptimer"><i data-dl="'+h.deadline+'"></i></div>':'')+'</div>'+
      (dealer===i?'<span class="pdealer" title="Dealer">D</span>':'')+'</div>'+
      (handName?'<span class="phand'+(won?' won':'')+'">'+esc(handName)+'</span>':'')+tag+'</div>';
    if(s.bet>0){
      x+='<span class="pbet" style="left:'+(50+(left-50)*0.6).toFixed(2)+'%;top:'+(50+(top-50)*0.56).toFixed(2)+'%">'+fmt(s.bet)+'</span>';
    }
  }
  return x+'</div>';
}
function sitPanel(st){
  var taken={};st.seats.forEach(function(s){if(s)taken[s.pid]=1});
  var names=(ctx.players||[]).filter(function(p){return !taken[p.id]});
  return '<div class="pact"><h3 style="margin:0">Seat '+(P.sit+1)+' · buy-in '+fmt(st.buyIn)+'</h3>'+
    '<div><p class="hint" style="margin:0 0 8px">Who are you?</p><div class="pnames">'+
    names.map(function(p){return btn('join',esc(p.name),'ghost sm',' data-id="'+esc(p.id)+'"')}).join('')+'</div></div>'+
    '<div class="addrow" style="margin:0"><input type="text" id="ps-new" data-fk="ps-new" placeholder="Not listed? Type your name" aria-label="Your name">'+
    btn('joinNew','Sit down')+btn('unsit','Cancel','ghost')+'</div>'+
    (st.isHost?'':'<p class="hint" style="margin:0">The host lets you in.</p>')+'</div>';
}
function presets(st,L){
  var h=st.hand,potAfter=h.pot+L.toCall;
  var clamp=function(v){return Math.max(L.minTo,Math.min(L.maxTo,Math.round(v)))};
  var list=[['Min',L.minTo],['½ pot',clamp(h.currentBet+potAfter/2)],['Pot',clamp(h.currentBet+potAfter)],['All-in',L.maxTo]];
  return list.map(function(p){return '<button class="pchip'+(P.raise===p[1]?' on':'')+'" data-p="preset" data-v="'+p[1]+'"'+(P.busy?' disabled':'')+'>'+p[0]+'</button>'}).join('');
}
function raiseLabel(L){return P.raise>=L.maxTo?'All-in '+fmt(L.maxTo):(L.isBet?'Bet ':'Raise to ')+fmt(P.raise)}
// Your turn: three big buttons. Raise opens one extra row for sizing, then a single confirm button.
function turnHtml(st,s,L){
  var h=st.hand,key=st.handNo+'|'+h.street+'|'+h.currentBet;
  if(P.raiseKey!==key){P.raiseKey=key;P.raise=L.minTo;P.raiseOpen=false}
  P.raise=Math.max(L.minTo,Math.min(L.maxTo,P.raise));
  var x='<div class="pturnhead"><span class="pmycards">'+(s.cards||[]).map(function(cd){return card(cd,'sm')}).join('')+'</span>'+
    '<span class="pturnwho"><span class="pyour">Your turn</span>'+(s.cards&&s.cards[0]?'<span class="pturnhand">'+esc(describeHand(s.cards.concat(h.board)))+'</span>':'')+'</span>'+
    '<span class="pclock ptimer-txt" data-dl="'+h.deadline+'"></span></div>';
  x+='<div class="pbtns">'+
    btn('act','Fold','pfold',' data-t="fold"')+
    (L.canCheck?btn('act','Check','pcall',' data-t="check"'):btn('act','Call '+fmt(L.toCall),'pcall',' data-t="call"'))+
    (L.canRaise?btn('raiseOpen',P.raiseOpen?'Cancel':(L.isBet?'Bet':'Raise'),'praisebtn'+(P.raiseOpen?' open':'')):'<span></span>')+
    '</div>';
  if(L.canRaise&&P.raiseOpen){
    x+='<div class="psize">'+
      '<div class="pchips">'+presets(st,L)+'</div>'+
      '<div class="pslide"><input type="range" id="pr-range" min="'+L.minTo+'" max="'+L.maxTo+'" step="1" value="'+P.raise+'" aria-label="Raise amount">'+
      '<input type="number" id="pr-amt" data-fk="pr-amt" min="0" step="any" value="'+showAmt(P.raise)+'" aria-label="Raise to"></div>'+
      btn('raise',raiseLabel(L),'pconfirm',' id="pr-go"')+'</div>';
  }
  return x;
}
function actionHtml(st){
  var me=st.me.seat,h=st.hand;
  if(P.sit!=null&&me<0)return sitPanel(st);
  if(st.me.request)return '<div class="pact"><div class="pstatus"><span>Waiting for the host to let you into seat '+(st.me.request.seat+1)+'…</span>'+btn('cancel','Cancel','ghost sm')+'</div></div>';
  if(me<0)return '<div class="pact"><div class="pstatus"><span>'+(st.status==='ended'?'This game is over.':'Pick an empty seat to join the game.')+'</span></div></div>';
  var s=st.seats[me],L=st.me.legal;
  if(L)return '<div class="pact sticky">'+turnHtml(st,s,L)+'</div>';
  var msg='';
  if(h&&s.inHand&&!s.folded)msg=h.toAct>=0?'Waiting for '+esc(seatName(st,h.toAct))+'…':'';
  else if(h&&s.folded)msg='You folded this hand.';
  else if(s.stack+s.pendingAdd===0)msg='You’re out of chips. Rebuy to keep playing.';
  else if(s.status==='sitout')msg='You’re sitting out.';
  else msg=st.status==='running'?'Next hand coming up…':'';
  // After folding, or between hands, you can turn your cards face up for the table.
  var show=st.me.canShow?btn('show',h?'Show my cards at the end':'Show my cards','ghost sm'):
    st.me.showQueued?'<span class="pshowing">Your cards will be shown when the hand ends</span>':'';
  return msg||show?'<div class="pact"><div class="pstatus"><span>'+msg+'</span>'+show+'</div></div>':'';
}
// Seat controls live in a quiet row under the table, away from the betting buttons.
function mineHtml(st){
  var me=st.me.seat;if(me<0)return '';
  var s=st.seats[me];
  return '<div class="pmine">'+
    (s.status==='sitout'?btn('back','I’m back','sm'):btn('sitout','Sit out','ghost sm'))+
    (st.status==='ended'?'':st.me.rebuyPending?'<span class="hint" style="margin:0">Rebuy waiting for the host</span>':btn('rebuy','Rebuy '+fmt(st.buyIn),'ghost sm'))+
    (P.confirm==='leave'?'<span class="hint" style="margin:0">Cash out '+fmt(s.stack+s.pendingAdd)+' and leave?</span>'+btn('leaveYes','Leave','danger sm')+btn('no','Stay','ghost sm'):btn('leave','Leave table','ghost sm'))+
    '</div>';
}
function sideHtml(st){
  var rows=st.ledger.slice().sort(function(a,b){return (b.chips-b.boughtIn)-(a.chips-a.boughtIn)});
  var canKick=st.isHost&&st.status!=='ended';
  var led='<table class="pled"><thead><tr><th>Player</th><th>In</th><th>Chips</th><th>Net</th>'+(canKick?'<th></th>':'')+'</tr></thead><tbody>'+
    (rows.length?rows.map(function(r){
      var net=r.chips-r.boughtIn;
      return '<tr><td>'+esc(r.name)+(r.seated?'':' <span class="zero">(left)</span>')+'</td><td class="num">'+fmt(r.boughtIn)+'</td><td class="num">'+fmt(r.chips)+'</td><td class="num '+cls(net)+'">'+signed(net)+'</td>'+
        (canKick?'<td>'+(r.seated?'<button class="x" data-p="kick" data-seat="'+r.seat+'" title="Remove from the table" aria-label="Remove '+esc(r.name)+'">×</button>':'')+'</td>':'')+'</tr>';
    }).join(''):'<tr><td colspan="4" class="zero">Nobody has bought in yet.</td></tr>')+'</tbody></table>';
  if(st.hand)led+='<p class="hint">Chips in the current pot aren’t counted until the hand ends.</p>';
  if(chipsOn())led+='<p class="hint">Shown as chips. The leaderboard records dollars (100 chips = $1).</p>';
  var log='<ul class="plog">'+st.log.slice().reverse().map(function(l){return '<li>'+fmtText(l.m)+'</li>'}).join('')+'</ul>';
  return '<div class="pcols"><div><h3>Ledger</h3>'+led+'</div><div><h3>Table log</h3>'+log+'</div></div>'+fairHtml(st);
}
function fairHtml(st){
  var h=st.hand,me=st.me.seat;
  var x='<div class="pfair" id="pfair"><h3>Fair deal</h3>'+
    '<p class="hint">Before each hand the server locks in a secret seed and shows its SHA-256 hash. Every player’s browser adds its own seed, so nobody, not even the host, can choose the cards. After the hand the seed is revealed, and <b>Verify</b> rebuilds the shuffle on your own device to prove the hand was dealt from it.</p>'+
    '<div class="pfgrid">';
  if(h)x+='<span>Hand #'+h.no+' hash</span><code>'+esc(h.hash||'—')+'</code><span>Player seeds</span><code>'+esc((h.client||'').split('|').map(function(c,i){return (h.names&&h.names[i]?h.names[i]+' ':'')+c.slice(0,8)}).join(' · '))+'</code>';
  x+='<span>Next hand hash</span><code>'+esc(st.nextHash||'—')+'</code>';
  if(me>=0)x+='<span>Your seed</span><span class="pfseed"><code>'+esc(st.me.cseed)+'</code>'+btn('newSeed','New seed','ghost sm',' title="Pick a new random seed for your next hands"')+'</span>';
  x+='</div>';
  if(st.fair.length){
    x+='<table class="pled pfhist"><thead><tr><th>Hand</th><th>Hash shown before</th><th>Seed revealed after</th><th></th></tr></thead><tbody>'+
      st.fair.map(function(f){
        var v=P.verify[f.no],res='';
        if(v==='busy')res='<span class="zero">Checking…</span>';
        else if(v&&v.ok)res='<span class="pos">✓ Verified</span>';
        else if(v)res='<span class="neg">✗ '+esc(v.msg)+'</span>';
        var row='<tr><td>#'+f.no+'</td><td><code title="'+esc(f.hash)+'">'+esc(short(f.hash))+'</code></td><td><code title="'+esc(f.seed)+'">'+esc(short(f.seed))+'</code></td><td>'+(v&&v!=='busy'?res:btn('verify','Verify','ghost sm',' data-id="'+f.no+'"'))+(v==='busy'?res:'')+'</td></tr>';
        if(v&&v.ok){
          var parts=[];
          if(v.board.length)parts.push('the board');
          if(Object.keys(f.shown||{}).length)parts.push('every shown hand');
          if(v.mine)parts.push('your own cards');
          var what=parts.length>1?parts.slice(0,-1).join(', ')+' and '+parts[parts.length-1]:(parts[0]||'the deal');
          row+='<tr class="pfdetail"><td></td><td colspan="3">Hash matches the seed, and the rebuilt deck reproduces '+what+'.<br>'+
            (v.board.length?'Board: '+v.board.map(cardTxt).join(' ')+'<br>':'Ended before the flop.<br>')+'Dealt: '+
            f.order.map(function(s,i){return esc(f.names[i]||'Seat '+(s+1))+' '+v.holes[s].map(cardTxt).join(' ')}).join(' · ')+'</td></tr>';
        }
        return row;
      }).join('')+'</tbody></table>';
  } else x+='<p class="hint">Finished hands appear here with their revealed seeds.</p>';
  return x+'</div>';
}
function tableHtml(){
  var st=P.st;
  if(!st)return '<div class="ptop">'+btn('lobby','← Tables','ghost sm')+'</div>'+banner()+'<p class="hint">Opening the table…</p>';
  var h=st.hand;
  var x='<div class="ptop">'+btn('lobby','← Tables','ghost sm')+
    '<div class="ptitle"><b>'+esc(st.name)+'</b><span>'+fmt(st.sb)+'/'+fmt(st.bb)+' · buy-in '+fmt(st.buyIn)+(h?' · hand #'+h.no+' · '+h.street:'')+'</span></div>'+
    statusPill(st.status,st.sentToLedger)+'</div>';
  x+=banner();
  if(st.isHost)x+=hostBar(st);
  x+=feltHtml(st)+actionHtml(st)+mineHtml(st)+sideHtml(st);
  return x;
}

/* ---------- drawing ---------- */
function draw(){
  if(!root)return;
  var a=document.activeElement,fk=null,val=null;
  if(a&&a.dataset&&a.dataset.fk&&root.contains(a)){fk=a.dataset.fk;val=a.value}
  root.innerHTML=P.view==='table'?tableHtml():lobbyHtml();
  // Forget cards from older hands so this stays small.
  if(P.view==='table'&&P.st){
    var keep=P.st.handNo;
    for(var k in seen)if(parseInt(k,10)<keep-1)delete seen[k];
  }
  if(fk){var el=root.querySelector('[data-fk="'+fk+'"]');if(el){el.value=val;el.focus()}}
  tickTimers();
}
function tickTimers(){
  if(!root)return;
  var els=root.querySelectorAll('.ptimer i');
  for(var i=0;i<els.length;i++){
    var left=Number(els[i].getAttribute('data-dl'))-now();
    els[i].style.width=Math.max(0,Math.min(100,left/300))+'%';
    els[i].className=left<8000?'low':'';
  }
  var t=root.querySelector('.ptimer-txt');
  if(t){var sec=Math.max(0,Math.ceil((Number(t.getAttribute('data-dl'))-now())/1000));t.textContent=sec+'s';t.classList.toggle('low',sec<=8)}
}
function setRaise(v,from){
  var L=P.st&&P.st.me.legal;if(!L||!isFinite(v))return;
  P.raise=Math.max(L.minTo,Math.min(L.maxTo,Math.round(v)));
  var r=root.querySelector('#pr-range'),n=root.querySelector('#pr-amt'),g=root.querySelector('#pr-go');
  if(r&&from!=='range')r.value=P.raise;
  if(n&&from!=='amt')n.value=showAmt(P.raise);
  if(g)g.textContent=raiseLabel(L);
  var chips=root.querySelectorAll('.pchip');
  for(var i=0;i<chips.length;i++)chips[i].classList.toggle('on',Number(chips[i].getAttribute('data-v'))===P.raise);
}

/* ---------- events ---------- */
function onClick(ev){
  var t=ev.target.closest('[data-p]');
  if(!t||t.disabled||!root.contains(t))return;
  var p=t.getAttribute('data-p'),id=t.getAttribute('data-id'),v;
  switch(p){
    case 'dismiss':P.err='';draw();break;
    case 'form':P.form=!P.form;draw();break;
    case 'create':
      var buy=parseFloat(root.querySelector('#pf-buy').value),sb=Math.round(parseFloat(root.querySelector('#pf-sb').value)),bb=Math.round(parseFloat(root.querySelector('#pf-bb').value));
      if(!(buy>0)){P.err='Enter the buy-in in dollars, for example 50.';draw();break}
      if(!(sb>0)||!(bb>0)){P.err='Enter the blinds in chips, for example 25 and 50.';draw();break}
      if(bb<sb){P.err='The big blind has to be at least the small blind.';draw();break}
      if(Math.round(buy*100)<bb){P.err='The buy-in has to cover at least one big blind.';draw();break}
      v={name:root.querySelector('#pf-name').value,sb:sb,bb:bb,buyIn:Math.round(buy*100),units:'chips'};
      P.busy=true;P.err='';draw();
      call('create',v).then(function(d){P.busy=false;P.form=false;openTable(d.id)},function(e){P.busy=false;P.err=e.message;draw()});
      break;
    case 'open':openTable(id);break;
    case 'lobby':backToLobby();draw();break;
    case 'sit':P.sit=Number(t.getAttribute('data-seat'));draw();break;
    case 'unsit':P.sit=null;draw();break;
    case 'join':op('join',{seat:P.sit,pid:id,cseed:myCseed()}).then(function(st){if(st)P.sit=null;draw()});break;
    case 'joinNew':
      v=(root.querySelector('#ps-new').value||'').trim();
      if(!v){P.err='Type your name first.';draw();break}
      op('join',{seat:P.sit,newName:v,cseed:myCseed()}).then(function(st){if(st){P.sit=null;if(ctx.reload)ctx.reload()}draw()});
      break;
    case 'cancel':case 'sitout':case 'back':case 'rebuy':case 'start':case 'pause':case 'show':op(p);break;
    case 'act':P.raiseOpen=false;op('act',{type:t.getAttribute('data-t')});break;
    case 'raiseOpen':P.raiseOpen=!P.raiseOpen;draw();break;
    case 'raise':
      var L=P.st.me.legal;P.raiseOpen=false;
      op('act',{type:P.raise>=L.maxTo?'allin':'raise',amount:P.raise});
      break;
    case 'preset':setRaise(Number(t.getAttribute('data-v')));break;
    case 'fairJump':var fj=root.querySelector('#pfair');if(fj)fj.scrollIntoView({behavior:'smooth',block:'start'});break;
    case 'newSeed':op('cseed',{cseed:myCseed(true)});break;
    case 'verify':
      var no=Number(id),f=P.st.fair.filter(function(x){return x.no===no})[0];
      if(!f)break;
      P.verify[no]='busy';draw();
      verifyHand(f).then(function(r){P.verify[no]=r;draw()},function(){P.verify[no]={ok:false,msg:'This browser could not run the check.'};draw()});
      break;
    case 'units':op('units',{units:chipsOn()?'dollars':'chips'});break;
    case 'leave':P.confirm='leave';draw();break;
    case 'leaveYes':P.confirm=null;op('leave');break;
    case 'end':P.confirm='end';draw();break;
    case 'endYes':P.confirm=null;op('end');break;
    case 'delete':P.confirm='delete';draw();break;
    case 'deleteYes':P.confirm=null;P.busy=true;call('delete',{table:P.tid}).then(function(){P.busy=false;backToLobby()},function(e){P.busy=false;P.err=e.message;draw()});break;
    case 'no':P.confirm=null;draw();break;
    case 'approve':case 'deny':op(p,{req:id});break;
    case 'kick':op('kick',{seat:Number(t.getAttribute('data-seat'))});break;
    case 'blinds':op('blinds',{sb:Math.round(parseFloat(root.querySelector('#pb-sb').value)),bb:Math.round(parseFloat(root.querySelector('#pb-bb').value))});break;
    case 'send':op('sendLedger',{date:today()}).then(function(st){if(st&&ctx.reload)ctx.reload()});break;
  }
}
function onInput(ev){
  var t=ev.target;
  if(t.id==='pf-buy'||t.id==='pf-sb'||t.id==='pf-bb'){
    var n=root.querySelector('#pf-note');
    if(n)n.textContent=formNote(parseFloat(root.querySelector('#pf-buy').value),parseFloat(root.querySelector('#pf-sb').value),parseFloat(root.querySelector('#pf-bb').value));
    return;
  }
  if(t.id==='pr-range')setRaise(Number(t.value),'range');
  else if(t.id==='pr-amt'){var c=parseAmt(t.value);var L=P.st.me.legal;if(isFinite(c)&&L){P.raise=c;var g=root.querySelector('#pr-go');if(g)g.textContent=raiseLabel(L)}}
}
function onKey(ev){
  if(ev.key!=='Enter')return;
  var t=ev.target;
  if(t.id==='pr-amt'){ev.preventDefault();setRaise(parseAmt(t.value));var g=root.querySelector('#pr-go');if(g)g.click()}
  else if(t.id==='ps-new'){ev.preventDefault();var j=root.querySelector('[data-p="joinNew"]');if(j)j.click()}
}

/* ---------- mounting ---------- */
window.Play={
  // Called by app.js every time it draws the Play tab into a fresh element.
  mount:function(el,c){
    ctx=c;root=el;
    el.addEventListener('click',onClick);
    el.addEventListener('input',onInput);
    el.addEventListener('keydown',onKey);
    if(!lobbyChan){lobbyChan=ctx.sb.channel('poker-lobby').on('broadcast',{event:'update'},function(){if(P.view==='lobby')schedule()}).subscribe()}
    if(!window.__playResize){window.__playResize=true;var rt;window.addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(function(){if(root&&P.view==='table')draw()},150)})}
    if(P.view==='table'&&P.tid){if(!poll)openTable(P.tid);else{draw();refresh()}}
    else{draw();loadList()}
  },
  stop:function(){
    stopTable();
    if(lobbyChan&&ctx){ctx.sb.removeChannel(lobbyChan);lobbyChan=null}
    root=null;
  }
};
})();
