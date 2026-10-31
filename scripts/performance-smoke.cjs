// Production UI smoke test with fixture APIs; never sends financial or account writes.
// Install Playwright separately and set PLAYWRIGHT_MODULE / BROWSER_PATH if needed.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined),
});
try {
const page = await browser.newPage({viewport:{width:1440,height:1000}});


const cdp = await page.context().newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', {offline:false,latency:100,downloadThroughput:2500000,uploadThroughput:2500000});
await cdp.send('Emulation.setCPUThrottlingRate', {rate:4});

const roster = Array.from({length:1000},(_,index)=>({rowIndex:index+3,owner:'Member '+index,account:'Toon '+index,subClass:'ranger',available:200-index,earned:300,spent:100,weeklyEarned:20,weeklySpent:0,dkpIssues:[]}));
const user={id:'000000000000000000000001',nickname:'Perf Chief',role:'chief',sheetRecordRows:[3]};
const member={_id:user.id,nickname:user.nickname,role:'chief',sheetRecordRows:[3]};
const fixtures={
'/api/auth/session':{success:true,user},
'/api/auth':{success:true,user},
  '/api/dkp':{success:true,user,roster,bossActivity:[],clanMembers:roster.map((toon,index)=>({nickname:'Member '+index,role:'clansman',toons:[toon]}))},
'/api/auction':{manager:true,weeklyEarnedTotal:20,weeklyMinimum:10,canBidWeekly:true,roles:['ranger'],toons:[],items:[],auctions:[],rosterSync:{fetchedAt:new Date().toISOString(),stale:false,refreshDelayed:false}},
'/api/auction/items':{items:[],roles:['ranger']},
'/api/admin/boss-history':{canManage:true,awards:[],roster,nextCursor:null},
'/api/role-changes':{canApprove:true,toons:[],nextChangeAt:'2026-11-02T00:00:00.000Z'},
'/api/admin/requests':{managerRole:'chief',managerId:user.id,pendingUsers:[],members:[member],auditEvents:[],roster},
'/api/admin/toons':{toons:[],pending:null}
};
const requests=[]; const errors=[];
page.on('pageerror',error=>errors.push(error.message));
await page.route('**/api/**',async route=>{
 const url=new URL(route.request().url());requests.push(url.pathname+url.search);
 if(url.pathname==='/api/auction/image') {
  await route.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH0cAAAAASUVORK5CYII=','base64')});
  return;
 }
 await new Promise(resolve=>setTimeout(resolve,250));
 const data=url.searchParams.get('section')==='archives'?{archivedAccounts:[],archivedToons:[]}:fixtures[url.pathname];
 await route.fulfill({status:data?200:404,contentType:'application/json',body:JSON.stringify(data??{error:'Missing fixture'})});
});

const origin=process.env.PERF_ORIGIN || 'http://localhost:3101';
const start=Date.now();
await page.goto(origin+'/dashboard');
await page.getByRole('heading',{name:'Welcome back, Perf Chief.'}).waitFor();
await page.locator('tbody tr').first().waitFor();
const initialReadyMs=Date.now()-start;
await page.waitForTimeout(800);
const initialRequests=[...requests];
const initialResourceBytes=await page.evaluate(()=>performance.getEntriesByType('resource').reduce((sum,r)=>sum+r.transferSize,0));
assert.deepEqual([...new Set(initialRequests)].sort(),['/api/auth/session','/api/dkp']);
const timings=[];
const destinations=[
 ['Auction house','/dashboard?view=auction','Auction house'],
 ['Kill history','/dashboard?view=boss-history','Kill history'],
 ['Item catalog','/dashboard?view=items','Item catalog'],
 ['My role changes','/admin/role-changes','Subrole changes'],
 ['Members & access','/admin/requests','Members & access'],
 ['Roster','/dashboard','Clan leaderboard'],
];
for(const [name,path,text] of destinations){
 const nav=page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name,exact:true});
 await nav.hover(); await page.waitForTimeout(450);
 const at=Date.now(); await nav.click();
 await page.waitForURL(origin+path);
 await page.getByRole('heading',{name:text,exact:true}).waitFor();
 await page.waitForFunction(()=>![...document.querySelectorAll('[aria-busy="true"]')].some(element=>element.getClientRects().length));
 assert.equal(await page.locator('[role="alert"]').filter({hasText:/error|unable|could not|requires/i}).count(),0);
 timings.push({destination:name,clickToHeadingMs:Date.now()-at});
}
assert.equal(await page.locator('tbody tr').count(),1000);
const search=page.getByRole('searchbox',{name:'Search clan member, owner, toon, or class'});
const searchStart=Date.now();await search.fill('Toon 199');
await page.locator('tbody tr').first().waitFor();
await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===1);
const searchMs=Date.now()-searchStart;
assert.equal(await page.locator('tbody tr').count(),1);
await page.goBack();await page.goForward();
await page.getByRole('heading',{name:'Clan leaderboard'}).waitFor();
await page.setViewportSize({width:390,height:844});
await page.getByRole('button',{name:'Open navigation'}).click();
await page.getByRole('dialog').getByRole('link',{name:'Auction house',exact:true}).click();
await page.getByRole('heading',{name:'Auction house',exact:true}).waitFor();
assert.equal(await page.getByRole('dialog').count(),0);
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
await page.goto(origin+'/admin/boss-history');
await page.getByRole('heading',{name:'Kill history',exact:true}).waitFor();
fixtures['/api/auction'].auctions=[{
 id:'000000000000000000000002',itemId:'000000000000000000000003',imageCount:0,
 itemName:'Expiry check',bossType:'Bt',requiredRoles:['ranger'],createdBy:user.nickname,
 isPoster:true,isWinner:false,canMarkDelivered:false,canRemove:true,
 createdAt:new Date().toISOString(),endsAt:new Date(Date.now()+5000).toISOString(),
 biddingClosed:false,status:'active',highBid:null,winner:null,deliveryStatus:'not-required',
 deliveredBy:null,deliveredAt:null,settlementError:null,canResolveNoBid:false
}];
await page.goto(origin+'/dashboard?view=auction');
const expiring=page.locator('article').filter({has:page.getByRole('heading',{name:'Expiry check'})});
await expiring.getByText('LIVE',{exact:true}).waitFor();
await expiring.getByText('FINALIZING',{exact:true}).waitFor({timeout:10000});
await page.goto(origin+'/login');
await page.getByRole('textbox',{name:'In-game nickname'}).waitFor();
await page.getByRole('button',{name:'Request access',exact:true}).click();
await page.getByRole('heading',{name:'Make yourself at home.',exact:true}).waitFor();
assert.equal(errors.length,0,errors.join('\n'));
console.log(JSON.stringify({network:{downloadMbps:20,uploadMbps:20,latencyMs:100,cpuSlowdown:4,fixtureApiDelayMs:250,rosterSize:1000},initialReadyMs,initialResourceBytes,initialRequests,timings,searchMs,mobileNavigation:true,browserHistory:true,legacyHistoryRoute:true,signupView:true,auctionExpiry:true,requests,errors},null,2));
} finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
