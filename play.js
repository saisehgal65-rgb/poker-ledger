// Play tab: online No-Limit Hold'em tables run by the "poker" Supabase function.
// The server holds the deck and everyone's cards; this file only draws what it is sent and sends actions back.
(function(){
'use strict';
var P={view:'lobby',tables:[],isHost:false,tid:null,st:null,err:'',busy:false,sit:null,form:false,raise:0,raiseKey:'',offset:0,confirm:null};
var ctx=null,root=null,chan=null,lobbyChan=null,poll=null,clock=null,wake=null,soon=null;
var SUIT={s:'♠',h:'♥',d:'♦',c:'♣'};

/* ---------- helpers ---------- */
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function cash(c){var a=Math.abs(c)/100;var s='$'+a.toLocaleString('en-AU',{minimumFractionDigits:(a%1?2:0),maximumFractionDigits:2});return c<0?'−'+s:s}
function signed(c){return c>0?'+'+cash(c):cash(c)}
function cls(n){return n>0?'pos':(n<0?'neg':'zero')}
function toCents(v){var n=parseFloat(v);return isFinite(n)?Math.round(n*100):NaN}
function today(){var d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function getTok(id){try{return localStorage.getItem('poker-token-'+id)||''}catch(x){return ''}}
function setTok(id,v){try{if(v)localStorage.setItem('poker-token-'+id,v);else localStorage.removeItem('poker-token-'+id)}catch(x){}}
function card(c,size){
  var k='card'+(size?' '+size:'');
  if(!c)return '<span class="'+k+' back"></span>';
  var red=c[1]==='h'||c[1]==='d';
  return '<span class="'+k+(red?' red':'')+'"><b>'+(c[0]==='T'?'10':c[0])+'</b><i>'+SUIT[c[1]]+'</i></span>';
}
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
  P.st=st;
  P.offset=st.serverNow-Date.now();
  if(same)return;
  if(st.token)setTok(st.id,st.token);
  if(getTok(st.id)&&st.me.seat<0&&!st.me.request)setTok(st.id,'');
  // The server only moves on when someone asks, so wake up when the next deal or a turn clock is due.
  clearTimeout(wake);
  var due=st.hand?st.hand.deadline:st.nextHandAt;
  if(due)wake=setTimeout(refresh,Math.max(250,due-now()+300));
  draw();
}
function op(name,args){
  if(P.busy)return Promise.resolve();
  args=args||{};args.table=P.tid;if(!args.token)args.token=getTok(P.tid);
  P.busy=true;P.err='';draw();
  return call(name,args).then(function(st){P.busy=false;apply(st);return st},function(e){P.busy=false;P.err=e.message;draw()});
}
function schedule(){clearTimeout(soon);soon=setTimeout(function(){P.view==='table'?refresh():loadList()},120)}

/* ---------- navigation ---------- */
function openTable(id){
  stopTable();
  P.view='table';P.tid=id;P.st=null;P.sit=null;P.confirm=null;P.err='';
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
function backToLobby(){stopTable();P.view='lobby';P.tid=null;P.st=null;P.sit=null;P.confirm=null;loadList()}

/* ---------- lobby ---------- */
function statusPill(status,sent){
  if(status==='waiting')return '<span class="pill">Not started</span>';
  if(status==='running')return '<span class="pill live">Playing</span>';
  if(status==='paused')return '<span class="pill">Paused</span>';
  return sent?'<span class="pill ok">In the ledger</span>':'<span class="pill">Finished</span>';
}
function lobbyHtml(){
  var h=banner();
  h+='<div class="bar"><h2>Tables</h2>'+(P.isHost?btn('form',P.form?'Cancel':'New table',P.form?'ghost':''):'')+'</div>';
  if(P.form){
    h+='<div class="pform">'+
      '<label class="grow">Table name<input type="text" id="pf-name" data-fk="pf-name" value="Poker night"></label>'+
      '<label>Small blind ($)<input type="number" id="pf-sb" data-fk="pf-sb" min="0" step="any" value="0.25"></label>'+
      '<label>Big blind ($)<input type="number" id="pf-bb" data-fk="pf-bb" min="0" step="any" value="0.50"></label>'+
      '<label>Buy-in ($)<input type="number" id="pf-buy" data-fk="pf-buy" min="0" step="any" value="50"></label>'+
      btn('create','Open table')+'</div>';
  }
  if(!P.tables.length)h+='<p class="hint">No tables yet. '+(P.isHost?'Open one to start a game.':'The host opens one when it’s game time.')+'</p>';
  P.tables.forEach(function(t){
    h+='<button class="nrow" data-p="open" data-id="'+esc(t.id)+'"><span class="d">'+esc(t.name)+'</span>'+
      '<span class="m">'+cash(t.sb)+'/'+cash(t.bb)+' · buy-in '+cash(t.buyIn)+' · '+t.seated+' seated</span>'+
      '<span class="r">'+statusPill(t.status,t.sentToLedger)+'</span></button>';
  });
  if(!P.isHost&&ctx.isAdmin)h+='<p class="hint">Sign in again if you can’t open tables.</p>';
  return h;
}

/* ---------- table ---------- */
function banner(){return P.err?'<div class="banner" style="margin:0 0 16px"><span>'+esc(P.err)+'</span><button data-p="dismiss">Dismiss</button></div>':''}
function seatName(st,i){var s=st.seats[i];return s?s.name:''}
function hostBar(st){
  var b='<div class="phost"><span class="plabel">Host</span>';
  if(st.status==='waiting')b+=btn('start','Start game','sm');
  if(st.status==='running')b+=btn('pause','Pause','ghost sm');
  if(st.status==='paused'){
    b+=btn('start','Resume','sm');
    b+=P.confirm==='end'?'<span class="hint" style="margin:0">Cash everyone out and end?</span>'+btn('endYes','End game','danger sm')+btn('no','Keep playing','ghost sm')
      :btn('end','End game','ghost sm',st.hand?' title="Wait for the hand to finish"':'');
  }
  if(st.status==='ended'){
    b+=st.sentToLedger?'<span class="pill ok">Added to the ledger</span>':btn('send','Send to ledger','sm');
    b+=P.confirm==='delete'?btn('deleteYes','Delete for good','danger sm')+btn('no','Keep','ghost sm'):btn('delete','Delete table','ghost sm');
  }
  if(st.status!=='ended')b+='<span class="pblinds">Blinds $<input type="number" id="pb-sb" data-fk="pb-sb" min="0" step="any" value="'+st.sb/100+'" aria-label="Small blind">/<input type="number" id="pb-bb" data-fk="pb-bb" min="0" step="any" value="'+st.bb/100+'" aria-label="Big blind">'+btn('blinds','Set','ghost sm')+'</span>';
  b+='</div>';
  if(st.requests.length){
    b+='<div class="preqs">'+st.requests.map(function(r){
      return '<div class="preq"><span><b>'+esc(r.name)+'</b> '+(r.kind==='join'?'wants seat '+(r.seat+1):'wants to rebuy')+' for '+cash(r.amount)+'</span>'+
        '<span class="row">'+btn('approve','Let in','sm',' data-id="'+esc(r.id)+'"')+btn('deny','Deny','ghost sm',' data-id="'+esc(r.id)+'"')+'</span></div>';
    }).join('')+'</div>';
  }
  return b;
}
function centerText(st){
  var h=st.hand;
  if(h)return 'Pot <b>'+cash(h.pot)+'</b>';
  if(st.last)return st.last.winners.map(function(w){return '<b>'+esc(w.name)+'</b> wins '+cash(w.amount)+(w.desc?' with '+esc(w.desc.toLowerCase()):'')}).join('<br>');
  if(st.status==='waiting')return st.isHost?'Seat everyone, then press Start game':'Waiting for the host to start';
  if(st.status==='paused')return 'Paused';
  if(st.status==='ended')return 'Game over';
  var ready=st.seats.filter(function(s){return s&&s.status==='active'&&s.stack+s.pendingAdd>0}).length;
  return ready<2?'Waiting for players':'Dealing…';
}
function feltHtml(st){
  var h=st.hand,me=st.me.seat;
  var anchor=me>=0?me:(st.me.request?st.me.request.seat:(P.sit!=null?P.sit:0));
  var narrow=root.clientWidth<560,rx=narrow?36:45,ry=narrow?42:43;
  var board=h?h.board:(st.last?st.last.board:[]);
  var cards='';for(var b=0;b<5;b++)cards+=board[b]?card(board[b]):'<span class="card slot"></span>';
  var dealer=h?h.button:st.button;
  var canSit=me<0&&!st.me.request&&st.status!=='ended';
  var x='<div class="pfelt-wrap"><div class="pfelt"></div>';
  x+='<div class="pcenter"><div class="pboard">'+cards+'</div><div class="ppot">'+centerText(st)+'</div></div>';
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
    var tag=s.allIn?'<span class="ptag allin">All-in</span>':s.leaving?'<span class="ptag">Leaving</span>':s.status==='sitout'?'<span class="ptag">Sitting out</span>':s.pendingAdd?'<span class="ptag">+'+cash(s.pendingAdd)+' next hand</span>':'';
    x+='<div class="'+c.join(' ')+'" style="'+pos+'">'+
      '<div class="pcards">'+(s.cards?s.cards.map(function(cd){return card(cd,'sm')}).join(''):'')+'</div>'+
      '<div class="pbox"><div class="pn">'+esc(s.name)+'</div><div class="ps">'+cash(s.stack)+'</div>'+
      (h&&h.toAct===i?'<div class="ptimer"><i data-dl="'+h.deadline+'"></i></div>':'')+'</div>'+tag+
      (dealer===i?'<span class="pdealer" title="Dealer">D</span>':'')+'</div>';
    if(s.bet>0){
      x+='<span class="pbet" style="left:'+(50+(left-50)*0.6).toFixed(2)+'%;top:'+(50+(top-50)*0.55).toFixed(2)+'%">'+cash(s.bet)+'</span>';
    }
  }
  return x+'</div>';
}
function sitPanel(st){
  var taken={};st.seats.forEach(function(s){if(s)taken[s.pid]=1});
  var names=(ctx.players||[]).filter(function(p){return !taken[p.id]});
  return '<div class="pact"><h3 style="margin:0">Seat '+(P.sit+1)+' · buy-in '+cash(st.buyIn)+'</h3>'+
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
  return list.map(function(p){return '<button class="btn ghost sm" data-p="preset" data-v="'+p[1]+'"'+(P.busy?' disabled':'')+'>'+p[0]+'</button>'}).join('');
}
function raiseLabel(L){return P.raise>=L.maxTo?'All-in '+cash(L.maxTo):(L.isBet?'Bet ':'Raise to ')+cash(P.raise)}
function actionHtml(st){
  var me=st.me.seat,h=st.hand;
  if(P.sit!=null&&me<0)return sitPanel(st);
  if(st.me.request)return '<div class="pact"><div class="pmine"><span class="hint" style="margin:0">Waiting for the host to let you into seat '+(st.me.request.seat+1)+'…</span>'+btn('cancel','Cancel','ghost sm')+'</div></div>';
  if(me<0)return '<div class="pact"><span class="hint" style="margin:0">'+(st.status==='ended'?'This game is over.':'Pick an empty seat to join the game.')+'</span></div>';
  var s=st.seats[me],L=st.me.legal,x='<div class="pact'+(L?' sticky':'')+'">';
  if(L){
    var key=st.handNo+'|'+h.street+'|'+h.currentBet;
    if(P.raiseKey!==key){P.raiseKey=key;P.raise=L.minTo}
    P.raise=Math.max(L.minTo,Math.min(L.maxTo,P.raise));
    // The bar sticks to the bottom of the screen on your turn, so repeat your cards in it.
    x+='<div class="pturn"><span class="pmycards">'+(s.cards||[]).map(function(cd){return card(cd,'sm')}).join('')+'</span><span class="pyour">Your turn</span>'+btn('act','Fold','danger',' data-t="fold"')+
      (L.canCheck?btn('act','Check','ghost',' data-t="check"'):btn('act','Call '+cash(L.toCall),'ghost',' data-t="call"'));
    if(L.canRaise){
      x+='<div class="praise"><input type="range" id="pr-range" min="'+L.minTo+'" max="'+L.maxTo+'" step="1" value="'+P.raise+'" aria-label="Raise amount">'+
        '<input type="number" id="pr-amt" data-fk="pr-amt" min="0" step="any" value="'+(P.raise/100)+'" aria-label="Raise to ($)">'+
        presets(st,L)+btn('raise',raiseLabel(L),'',' id="pr-go"')+'</div>';
    }
    x+='</div>';
  } else if(h&&s.inHand&&!s.folded){
    x+='<span class="hint" style="margin:0">'+(h.toAct>=0?'Waiting for '+esc(seatName(st,h.toAct))+'…':'')+'</span>';
  } else if(h&&s.folded){
    x+='<span class="hint" style="margin:0">You folded this hand.</span>';
  } else if(s.stack+s.pendingAdd===0){
    x+='<span class="hint" style="margin:0">You’re out of chips. Rebuy to keep playing.</span>';
  }
  x+='<div class="pmine">'+
    (s.status==='sitout'?btn('back','I’m back','sm'):btn('sitout','Sit out','ghost sm'))+
    (st.status==='ended'?'':st.me.rebuyPending?'<span class="hint" style="margin:0">Rebuy waiting for the host</span>':btn('rebuy','Rebuy '+cash(st.buyIn),'ghost sm'))+
    (P.confirm==='leave'?'<span class="hint" style="margin:0">Cash out '+cash(s.stack+s.pendingAdd)+' and leave?</span>'+btn('leaveYes','Leave','danger sm')+btn('no','Stay','ghost sm'):btn('leave','Leave table','ghost sm'))+
    '</div>';
  return x+'</div>';
}
function sideHtml(st){
  var rows=st.ledger.slice().sort(function(a,b){return (b.chips-b.boughtIn)-(a.chips-a.boughtIn)});
  var canKick=st.isHost&&st.status!=='ended';
  var led='<table class="pled"><thead><tr><th>Player</th><th>In</th><th>Chips</th><th>Net</th>'+(canKick?'<th></th>':'')+'</tr></thead><tbody>'+
    (rows.length?rows.map(function(r){
      var net=r.chips-r.boughtIn;
      return '<tr><td>'+esc(r.name)+(r.seated?'':' <span class="zero">(left)</span>')+'</td><td class="num">'+cash(r.boughtIn)+'</td><td class="num">'+cash(r.chips)+'</td><td class="num '+cls(net)+'">'+signed(net)+'</td>'+
        (canKick?'<td>'+(r.seated?'<button class="x" data-p="kick" data-seat="'+r.seat+'" title="Remove from the table" aria-label="Remove '+esc(r.name)+'">×</button>':'')+'</td>':'')+'</tr>';
    }).join(''):'<tr><td colspan="4" class="zero">Nobody has bought in yet.</td></tr>')+'</tbody></table>';
  if(st.hand)led+='<p class="hint">Chips in the current pot aren’t counted until the hand ends.</p>';
  var log='<ul class="plog">'+st.log.slice().reverse().map(function(l){return '<li>'+esc(l.m)+'</li>'}).join('')+'</ul>';
  return '<div class="pcols"><div><h3>Ledger</h3>'+led+'</div><div><h3>Table log</h3>'+log+'</div></div>';
}
function tableHtml(){
  var st=P.st;
  if(!st)return '<div class="ptop">'+btn('lobby','← Tables','ghost sm')+'</div>'+banner()+'<p class="hint">Opening the table…</p>';
  var h=st.hand;
  var x='<div class="ptop">'+btn('lobby','← Tables','ghost sm')+
    '<div class="ptitle"><b>'+esc(st.name)+'</b><span>'+cash(st.sb)+'/'+cash(st.bb)+' · buy-in '+cash(st.buyIn)+(h?' · hand #'+h.no+' · '+h.street:'')+'</span></div>'+
    statusPill(st.status,st.sentToLedger)+'</div>';
  x+=banner();
  if(st.isHost)x+=hostBar(st);
  x+=feltHtml(st)+actionHtml(st)+sideHtml(st);
  return x;
}

/* ---------- drawing ---------- */
function draw(){
  if(!root)return;
  var a=document.activeElement,fk=null,val=null;
  if(a&&a.dataset&&a.dataset.fk&&root.contains(a)){fk=a.dataset.fk;val=a.value}
  root.innerHTML=P.view==='table'?tableHtml():lobbyHtml();
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
}
function setRaise(v,from){
  var L=P.st&&P.st.me.legal;if(!L||!isFinite(v))return;
  P.raise=Math.max(L.minTo,Math.min(L.maxTo,Math.round(v)));
  var r=root.querySelector('#pr-range'),n=root.querySelector('#pr-amt'),g=root.querySelector('#pr-go');
  if(r&&from!=='range')r.value=P.raise;
  if(n&&from!=='amt')n.value=P.raise/100;
  if(g)g.textContent=raiseLabel(L);
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
      v={name:root.querySelector('#pf-name').value,sb:toCents(root.querySelector('#pf-sb').value),bb:toCents(root.querySelector('#pf-bb').value),buyIn:toCents(root.querySelector('#pf-buy').value)};
      P.busy=true;draw();
      call('create',v).then(function(d){P.busy=false;P.form=false;openTable(d.id)},function(e){P.busy=false;P.err=e.message;draw()});
      break;
    case 'open':openTable(id);break;
    case 'lobby':backToLobby();draw();break;
    case 'sit':P.sit=Number(t.getAttribute('data-seat'));draw();break;
    case 'unsit':P.sit=null;draw();break;
    case 'join':op('join',{seat:P.sit,pid:id}).then(function(st){if(st)P.sit=null;draw()});break;
    case 'joinNew':
      v=(root.querySelector('#ps-new').value||'').trim();
      if(!v){P.err='Type your name first.';draw();break}
      op('join',{seat:P.sit,newName:v}).then(function(st){if(st){P.sit=null;if(ctx.reload)ctx.reload()}draw()});
      break;
    case 'cancel':case 'sitout':case 'back':case 'rebuy':case 'start':case 'pause':op(p);break;
    case 'act':op('act',{type:t.getAttribute('data-t')});break;
    case 'raise':
      var L=P.st.me.legal;
      op('act',{type:P.raise>=L.maxTo?'allin':'raise',amount:P.raise});
      break;
    case 'preset':setRaise(Number(t.getAttribute('data-v')));break;
    case 'leave':P.confirm='leave';draw();break;
    case 'leaveYes':P.confirm=null;op('leave');break;
    case 'end':P.confirm='end';draw();break;
    case 'endYes':P.confirm=null;op('end');break;
    case 'delete':P.confirm='delete';draw();break;
    case 'deleteYes':P.confirm=null;P.busy=true;call('delete',{table:P.tid}).then(function(){P.busy=false;backToLobby()},function(e){P.busy=false;P.err=e.message;draw()});break;
    case 'no':P.confirm=null;draw();break;
    case 'approve':case 'deny':op(p,{req:id});break;
    case 'kick':op('kick',{seat:Number(t.getAttribute('data-seat'))});break;
    case 'blinds':op('blinds',{sb:toCents(root.querySelector('#pb-sb').value),bb:toCents(root.querySelector('#pb-bb').value)});break;
    case 'send':op('sendLedger',{date:today()}).then(function(st){if(st&&ctx.reload)ctx.reload()});break;
  }
}
function onInput(ev){
  var t=ev.target;
  if(t.id==='pr-range')setRaise(Number(t.value),'range');
  else if(t.id==='pr-amt'){var c=toCents(t.value);if(isFinite(c)){var L=P.st.me.legal;P.raise=c;var g=root.querySelector('#pr-go');if(g&&L)g.textContent=raiseLabel(L)}}
}
function onKey(ev){
  if(ev.key!=='Enter')return;
  var t=ev.target;
  if(t.id==='pr-amt'){ev.preventDefault();setRaise(toCents(t.value));var g=root.querySelector('#pr-go');if(g)g.click()}
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
