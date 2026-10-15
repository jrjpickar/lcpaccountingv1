import { getStore } from '@netlify/blobs';
import { requireAuth } from './lib/auth-guard.mts';
import { transactBlobJSON, json } from './lib/shared.mts';
import { parseBankCSV, type BankTransaction } from './lib/bank-csv.mts';
import { seed } from './lib/bank-seed.mts';
import { categories, suggestedCategory } from './lib/bank-metrics.mts';
const STORE='ledger-bank-transactions', KEY='ledger';
type State={rows:BankTransaction[];categories:Record<string,string>};
const fallback:State={rows:[],categories:{}};
export default async(req:Request)=>{
 const denied=await requireAuth(req);if(denied)return denied;
 const merge=(state:State)=>[...new Map([...seed,...state.rows].map(t=>[t.id,t])).values()];
 try{
 if(req.method==='GET'){
 const state=await getStore(STORE).get(KEY,{type:'json',consistency:'strong'}) as State|null || fallback;
 return json({rows:merge(state).map(t=>({...t,category:state.categories[t.id]||suggestedCategory(t),reviewed:!!state.categories[t.id]})),categories,accounts:[...new Set(['2910','2911','7503','7510','8661','8662',...merge(state).map(t=>t.account)])].sort()});
 }
 if(req.method!=='POST')return json({error:'Method not allowed'},405);
 const raw=await req.text();if(raw.length>3_000_000)return json({error:'Import is too large; upload fewer files (3 MB maximum)'},413);
 const body=JSON.parse(raw);
 if(body.action==='categorize'){
 if(!Array.isArray(body.ids)||body.ids.length>5000||!categories.includes(body.category))throw new Error('Invalid category selection');
 await transactBlobJSON<State>(STORE,KEY,fallback,s=>{const ids=new Set(merge(s).map(t=>t.id));for(const id of body.ids){if(!ids.has(id))throw new Error('Unknown transaction');}return {...s,categories:{...s.categories,...Object.fromEntries(body.ids.map((id:string)=>[id,body.category]))}}});return json({ok:true});
 }
 if(!['preview','import'].includes(body.action)||!Array.isArray(body.files)||body.files.length>50)throw new Error('Choose up to 50 Relay CSV files');
 let rows:BankTransaction[]=[];
 for(const f of body.files){if(typeof f.name!=='string'||typeof f.text!=='string'||f.name.length>200)throw new Error('Invalid file');rows.push(...parseBankCSV(f.text,f.name,String(body.account||'')));}
 if(rows.length>10000)throw new Error('Import at most 10,000 rows at once');
 rows=[...new Map(rows.map(t=>[t.id,t])).values()];
 let added=0,duplicates=0;
 const combine=(s:State)=>{const existing=new Set(merge(s).map(t=>t.id));const fresh=rows.filter(t=>!existing.has(t.id));added=fresh.length;duplicates=rows.length-added;return {...s,rows:[...s.rows,...fresh]};};
 if(body.action==='import')await transactBlobJSON<State>(STORE,KEY,fallback,combine);
 else combine(await getStore(STORE).get(KEY,{type:'json',consistency:'strong'}) as State|null || fallback);
 return json({added,duplicates,total:rows.length,sample:rows.slice(0,10)});
 }catch(e:any){return json({error:e.message||'Bank import failed'},400);}
};
export const config={path:'/.netlify/functions/bank-transactions'};
