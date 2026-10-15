import type { BankTransaction } from './bank-csv.mts';
export const categories = ['Uncategorized','Revenue','Other income','Cost of revenue','Marketing','Software','Professional fees','Bank fees','Meals','Payroll','Other expense','Transfer','Owner contribution','Owner distribution'];
export function suggestedCategory(t: BankTransaction): string {
  if(/transfer/i.test(t.type))return 'Transfer';
  if(/capital repayment|capital return/i.test(t.reference))return 'Owner distribution';
  if(/interest/i.test(t.reference) && t.cents>0)return 'Other income';
  if(t.cents<0){
    if(/twilio|batchleads/i.test(t.payee))return 'Marketing';
    if(/netlify|openai|make|google|ionos|slack|highlevel|perplexity/i.test(t.payee))return 'Software';
    if(/attorney/i.test(t.payee))return 'Professional fees';
    if(/banking fees/i.test(t.reference))return 'Bank fees';
    if(/ranchito/i.test(t.payee))return 'Meals';
  }
  return 'Uncategorized';
}
export function metrics(rows: (BankTransaction & {category: string})[]) {
 let income=0,otherIncome=0,cost=0,expenses=0,inflow=0,outflow=0,unclassified=0,excluded=0;
 const expenseCategories=new Set(['Marketing','Software','Professional fees','Bank fees','Meals','Payroll','Other expense']);
 for(const t of rows){if(t.status!=='SETTLED')continue;if(t.cents>0)inflow+=t.cents;else outflow-=t.cents;
 if(t.category==='Revenue')income+=t.cents;
 else if(t.category==='Other income')otherIncome+=t.cents;
 else if(t.category==='Cost of revenue')cost-=t.cents;
 else if(expenseCategories.has(t.category))expenses-=t.cents;
 else if(t.category==='Uncategorized')unclassified++;else excluded++;
 }
 return {income,otherIncome,cost,expenses,grossProfit:income-cost,netProfit:income+otherIncome-cost-expenses,inflow,outflow,netMovement:inflow-outflow,unclassified,excluded,count:rows.length};
}
