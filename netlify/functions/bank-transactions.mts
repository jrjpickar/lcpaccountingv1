import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { requireAuth } from './lib/auth-guard.mts';
import { transactBlobJSON, json } from './lib/shared.mts';
import { parseBankCSV, type BankTransaction } from './lib/bank-csv.mts';
import { seed } from './lib/bank-seed.mts';
import { categories, classify } from './lib/bank-metrics.mts';
const STORE='ledger-bank-transactions', KEY='ledger';
type State={rows:BankTransaction[];categories:Record<string,string>;owners?:Record<string,string>;sources?:Record<string,string>};
const fallback:State={rows:[],categories:{}};
const dupKey=(t:BankTransaction)=>JSON.stringify([t.account,t.date,t.cents,t.payee.trim().toLowerCase(),t.counterpartyAccount||'']);
export default async(req:Request)=>{
 const denied=await requireAuth(req);if(denied)return denied;
 const merge=(state:State)=>[...new Map([...seed,...state.rows].map(t=>[t.id,t])).values()];
 try{
 if(req.method==='GET'){
 const state=await getStore(STORE).get(KEY,{type:'json',consistency:'strong'}) as State|null || fallback;
 return json({rows:merge(state).map(t=>{const rule=classify(t,state.sources);return {...t,...rule,owner:state.owners?.[t.id]??rule.owner,category:state.categories[t.id]||rule.category,reviewed:!!state.categories[t.id]||!rule.needsReview,classificationSource:state.categories[t.id]?'Manual':'CSV rule'};}),sources:state.sources||{},categories,accounts:[...new Set(['2910','2911','7503','7510','8661','8662',...merge(state).map(t=>t.account)])].sort()});
 }
 if(req.method!=='POST')return json({error:'Method not allowed'},405);
 const raw=await req.text();if(raw.length>3_000_000)return json({error:'Import is too large; upload fewer files (3 MB maximum)'},413);
 const body=JSON.parse(raw);
 if(body.action==='source-owner'){
 if(!['TOTAL CHECKING','Adv Plus Banking'].includes(body.source)||!['Art','Bryce','Jesse',''].includes(body.owner))throw new Error('Invalid bank-source owner');
 await transactBlobJSON<State>(STORE,KEY,fallback,s=>({...s,sources:{...s.sources,[body.source]:body.owner}}));return json({ok:true});
 }
 if(body.action==='owner'){
 if(!['Art','Bryce','Jesse',''].includes(body.owner)||typeof body.id!=='string')throw new Error('Invalid owner');
 await transactBlobJSON<State>(STORE,KEY,fallback,s=>{if(!merge(s).some(t=>t.id===body.id))throw new Error('Unknown transaction');return {...s,owners:{...s.owners,[body.id]:body.owner}}});return json({ok:true});
 }
 if(body.action==='categorize'){
 if(!Array.isArray(body.ids)||body.ids.length>5000||!categories.includes(body.category))throw new Error('Invalid category selection');
 await transactBlobJSON<State>(STORE,KEY,fallback,s=>{const ids=new Set(merge(s).map(t=>t.id));for(const id of body.ids){if(!ids.has(id))throw new Error('Unknown transaction');}return {...s,categories:{...s.categories,...Object.fromEntries(body.ids.map((id:string)=>[id,body.category]))}}});return json({ok:true});
 }
 if(!['preview','import'].includes(body.action)||!Array.isArray(body.files)||body.files.length>50)throw new Error('Choose up to 50 Relay CSV files');
 const perFile:BankTransaction[][]=[];
 for(const f of body.files){if(typeof f.name!=='string'||typeof f.text!=='string'||f.name.length>200)throw new Error('Invalid file');perFile.push(parseBankCSV(f.text,f.name,String(body.account||'')));}
 const total=perFile.reduce((n,r)=>n+r.length,0);
 if(total>10000)throw new Error('Import at most 10,000 rows at once');
 // A row is a duplicate only when an earlier import already holds a charge on the
 // SAME date with the same account, payee, amount and counterparty. Recurring
 // charges (same payee/amount on a different date) are always new. Matching is by
 // count, so two identical same-day charges in one file both import, and the same
 // charge showing up in two overlapping CSVs in this batch only counts once.
 const groups=new Map<string,BankTransaction[]>();
 for(const fileRows of perFile){const local=new Map<string,BankTransaction[]>();for(const t of fileRows){const k=dupKey(t);(local.get(k)||local.set(k,[]).get(k)!).push(t);}
  for(const [k,list] of local){if(list.length>(groups.get(k)?.length||0))groups.set(k,list);}}
 let added=0,duplicates=0,sample:BankTransaction[]=[];
 const combine=(s:State)=>{const all=merge(s);const have=new Map<string,number>();for(const t of all){const k=dupKey(t);have.set(k,(have.get(k)||0)+1);}
  const ids=new Set(all.map(t=>t.id));const fresh:BankTransaction[]=[];
  for(const [k,list] of groups){for(const t of list.slice(have.get(k)||0)){let id=t.id,n=1;while(ids.has(id))id=createHash('sha256').update(t.id+'|'+(n++)).digest('hex');ids.add(id);fresh.push({...t,id});}}
  added=fresh.length;duplicates=total-added;sample=fresh.slice(0,10);return {...s,rows:[...s.rows,...fresh]};};
 if(body.action==='import')await transactBlobJSON<State>(STORE,KEY,fallback,combine);
 else combine(await getStore(STORE).get(KEY,{type:'json',consistency:'strong'}) as State|null || fallback);
 return json({added,duplicates,total,sample});
 }catch(e:any){return json({error:e.message||'Bank import failed'},400);}
};
export const config={path:'/.netlify/functions/bank-transactions'};
